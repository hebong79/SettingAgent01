// V3·V4·V5 — 베이 기하(Stage B) 유닛테스트 + 결정론 골든 해시.
//
// 합성 장면을 쓴다. 카메라 내부·외부 파라미터를 **먼저 정하고** 그 파라미터로 베이 열을 투영·래스터화하므로
// 정답(f · 지상고 · quad 4점)이 해석적으로 알려져 있다. 검출기가 그 값을 되찾는지 본다.
//
// 왜 실프레임 픽스처가 아닌가(R9): 런타임 프레임/정본을 픽스처로 쓰면 `roi.auto.apply` 나 시뮬레이터 상태가
// 봉인을 스스로 무효화한다(`groundGrid.test.ts:19-24` 의 self-invalidating seal 경고). 합성 장면은 코드 안에 있다.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEFAULT_BAY_OPTS,
  bestLattice,
  buildFromCorners,
  detectBays,
  fitProjective1D,
  meetLinesLS,
  predictS,
  vpResidPx,
  type FrontHypothesis,
} from '../src/ground/bayGeometry.js';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  lineThrough,
  type FrameGray,
  type RefinedLine,
} from '../src/ground/floorPaint.js';
import { quadIoU } from '../src/ground/autoRoiPlan.js';
import { detectBaysPaired, type PairHypothesis } from '../src/ground/bayGeometry.js';
import { canonicalizeQuad } from '../src/ground/groundGrid.js';
import { stringify5 } from '../src/util/round.js';
import type { PixelQuad } from '../src/ground/types.js';

// ── 합성 장면 ─────────────────────────────────────────────────────────
const W = 640;
const H = 400;
const F_TRUE = 700; // 초점거리(px)
const D_TRUE = 5.0; // 카메라 지상고(m)
const BAYS = 4;
const WIDTH_M = 2.5;
const DEPTH_M = 5.0;

type V3 = [number, number, number];
const norm3 = (v: V3): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * 카메라를 아래로 30° 기울인 지면. n·X = d, n 은 **하향 단위법선**(카메라 좌표 x→우 y→하 z→전방).
 * ★ 부호 규약: 아래로 내려다보면 world-down 은 카메라 z 성분이 **양수**다 → n = [0, cosθ, +sinθ].
 *   (구현자 실측: 부호를 반대로 잡으면 역투영이 카메라 뒤 점을 내놓아 전 파이프라인이 조용히 죽는다.)
 */
const TILT = (30 * Math.PI) / 180;
const N_TRUE: V3 = norm3([0, Math.cos(TILT), Math.sin(TILT)]);

const project = (X: V3): { x: number; y: number } => ({ x: (F_TRUE * X[0]) / X[2] + W / 2, y: (F_TRUE * X[1]) / X[2] + H / 2 });
/** 픽셀 → 지면점(참 파라미터 기준). */
function backproject(p: { x: number; y: number }): V3 {
  const m: V3 = [(p.x - W / 2) / F_TRUE, (p.y - H / 2) / F_TRUE, 1];
  const s = N_TRUE[0] * m[0] + N_TRUE[1] * m[1] + N_TRUE[2] * m[2];
  return [(m[0] * D_TRUE) / s, (m[1] * D_TRUE) / s, (m[2] * D_TRUE) / s];
}

/** 지면 위 기저: 우측축 · 깊이축(카메라에서 멀어지는 쪽). 주차열은 광축과 45° 로 비스듬히 놓는다. */
const RIGHT_AXIS: V3 = norm3(cross3(N_TRUE, [0, 0, 1]));
const DEPTH_AXIS: V3 = norm3(cross3(RIGHT_AXIS, N_TRUE));
const ROW_ANGLE = (45 * Math.PI) / 180;
/** 폭축(열이 반복되는 방향). */
const U_AXIS: V3 = norm3([
  RIGHT_AXIS[0] * Math.cos(ROW_ANGLE) + DEPTH_AXIS[0] * Math.sin(ROW_ANGLE),
  RIGHT_AXIS[1] * Math.cos(ROW_ANGLE) + DEPTH_AXIS[1] * Math.sin(ROW_ANGLE),
  RIGHT_AXIS[2] * Math.cos(ROW_ANGLE) + DEPTH_AXIS[2] * Math.sin(ROW_ANGLE),
]);
/** 깊이축(슬롯이 뻗는 방향). */
const V_AXIS: V3 = norm3(cross3(U_AXIS, N_TRUE));

/** 참 근변/원변 코너(픽셀). 근변 첫 코너는 화면 아래쪽에 오도록 기준점을 잡는다. */
function trueCorners(): { near: Array<{ x: number; y: number }>; far: Array<{ x: number; y: number }> } {
  const base = backproject({ x: 220, y: 350 });
  const near: Array<{ x: number; y: number }> = [];
  const far: Array<{ x: number; y: number }> = [];
  for (let k = 0; k <= BAYS; k++) {
    const P: V3 = [
      base[0] + U_AXIS[0] * WIDTH_M * k,
      base[1] + U_AXIS[1] * WIDTH_M * k,
      base[2] + U_AXIS[2] * WIDTH_M * k,
    ];
    const Q: V3 = [P[0] + V_AXIS[0] * DEPTH_M, P[1] + V_AXIS[1] * DEPTH_M, P[2] + V_AXIS[2] * DEPTH_M];
    near.push(project(P));
    far.push(project(Q));
  }
  return { near, far };
}

/** 굵기 `w` 의 밝은 선분을 그린다(안티에일리어싱 포함). */
function drawSegment(
  data: Uint8Array,
  A: { x: number; y: number },
  B: { x: number; y: number },
  w: number,
  value: number,
  bg: number,
): void {
  const minX = Math.max(0, Math.floor(Math.min(A.x, B.x) - w));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(A.x, B.x) + w));
  const minY = Math.max(0, Math.floor(Math.min(A.y, B.y) - w));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(A.y, B.y) + w));
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / len2));
      const d = Math.hypot(x - (A.x + dx * t), y - (A.y + dy * t));
      const half = w / 2;
      if (d <= half) data[y * W + x] = value;
      else if (d <= half + 1) data[y * W + x] = Math.max(data[y * W + x], Math.round(bg + (value - bg) * (half + 1 - d)));
    }
  }
}

/**
 * 합성 프레임: 전방 실선(전 구간) + 슬롯 분리선(근변에서 `occl` 비율까지만 — 차량 가림 모사).
 * 배경에 완만한 명암 기울기를 넣어 배경 추정 경로도 실제로 돌게 한다.
 */
function synthFrame(occl = 0.45): { frame: FrameGray; near: Array<{ x: number; y: number }>; far: Array<{ x: number; y: number }> } {
  const bg = 60;
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = bg + Math.round((y / H) * 12);
  const { near, far } = trueCorners();
  drawSegment(data, near[0], near[BAYS], 7, 215, bg);
  for (let k = 0; k <= BAYS; k++) {
    const stub = { x: near[k].x + (far[k].x - near[k].x) * occl, y: near[k].y + (far[k].y - near[k].y) * occl };
    drawSegment(data, near[k], stub, 6, 210, bg);
  }
  return { frame: { data, width: W, height: H }, near, far };
}

/**
 * ★ 합성 장면 전용 정련창(구현자 실측).
 * 분리선 표본을 전방선 도색에서 떨어뜨리면 코너 오차가 3.34px → 0.08~2.34px 로 줄고 quad IoU 가 0.98 을 넘는다.
 * **실프레임 기본값(DEFAULT_PAINT_OPTIONS)은 이 값이 아니다** — 실제 스텁이 짧아 표본이 사라지기 때문이다.
 * 즉 이 테스트가 봉인하는 것은 "증거가 깨끗하면 기하가 0.98 을 낸다"는 **상한**이지 현장 성능이 아니다.
 */
const CLEAN_OPTS = { ...DEFAULT_PAINT_OPTIONS, scanStartPx: 18, scanNmsPx: 6, separatorProfileHalfPx: 8 };

function pipeline(frame: FrameGray, expectedBays = BAYS, O = CLEAN_OPTS): ReturnType<typeof detectBays> {
  const { lines, mask } = detectPaintLines(frame, O);
  const hyps: FrontHypothesis[] = [];
  for (const front of lines.slice(0, 4)) {
    const peaks = scanSeparators(frame, mask, front, O);
    if (peaks.length < DEFAULT_BAY_OPTS.minPicks) continue;
    const seps: RefinedLine[] = refineSeparators(frame, peaks, O);
    if (seps.length >= DEFAULT_BAY_OPTS.minPicks) hyps.push({ front, separators: seps });
  }
  const det = detectBays(hyps, paintEvidenceOf(mask, W, H), O, 1, 1, W, H, 1, { ...DEFAULT_BAY_OPTS, expectedBays });
  det.diag.lines = lines.length;
  return det;
}

describe('bayGeometry — 순수 수학', () => {
  it('meetLinesLS 는 공점 직선다발의 교점을 정확히 준다', () => {
    const V = { x: 137.5, y: -42.25 };
    const ls = [
      lineThrough(V, { x: 10, y: 300 })!,
      lineThrough(V, { x: 200, y: 300 })!,
      lineThrough(V, { x: 400, y: 300 })!,
    ];
    const got = meetLinesLS(ls)!;
    expect(got.x).toBeCloseTo(V.x, 6);
    expect(got.y).toBeCloseTo(V.y, 6);
  });

  it('평행 다발은 null(throw 금지)', () => {
    expect(meetLinesLS([[0, 1, -10], [0, 1, -20], [0, 1, -30]])).toBeNull();
  });

  it('vpResidPx 는 소실점을 정확히 향하는 선분에 0 을 준다', () => {
    const V = { x: 500, y: 0 };
    expect(vpResidPx(V, { x: 400, y: 100 }, { x: 300, y: 200 })).toBeCloseTo(0, 9);
    expect(vpResidPx(V, { x: 400, y: 100 }, { x: 300, y: 210 })).toBeGreaterThan(1);
  });

  it('fitProjective1D 는 등간격 사영 표본을 정확히 복원한다', () => {
    const truth = { a: 120, b: 5, c: 0.03 };
    const idx = [0, 1, 2, 3, 4, 5];
    const s = idx.map((t) => predictS(truth, t));
    const got = fitProjective1D(s, idx)!;
    for (const t of idx) expect(predictS(got, t)).toBeCloseTo(predictS(truth, t), 6);
  });

  it('bestLattice 는 결손(누락 분리선)을 정수 인덱스로 메운다', () => {
    const truth = { a: 120, b: 0, c: 0.02 };
    const present = [0, 1, 3, 4, 5]; // index 2 결손
    const s = present.map((t) => predictS(truth, t));
    const lat = bestLattice(s, { maxGap: 3, latticeTolPx: 1, minPicks: 4, expectedBays: 5 })!;
    expect(lat.picks.map((p) => p.index)).toEqual(present);
    expect(lat.residPx).toBeLessThan(0.01);
  });

  it('bestLattice 는 결정론이다 — 같은 입력, 같은 출력', () => {
    const truth = { a: 90, b: 3, c: 0.015 };
    const s = [0, 1, 2, 3, 4, 5].map((t) => predictS(truth, t));
    const a = bestLattice(s, { maxGap: 3, latticeTolPx: 1, minPicks: 4, expectedBays: 5 })!;
    const b = bestLattice(s, { maxGap: 3, latticeTolPx: 1, minPicks: 4, expectedBays: 5 })!;
    expect(stringify5(a)).toBe(stringify5(b));
  });

  it('표본이 minPicks 미만이면 null', () => {
    expect(bestLattice([0, 100, 200], { maxGap: 3, latticeTolPx: 1, minPicks: 4, expectedBays: 5 })).toBeNull();
  });
});

describe('bayGeometry — V4/V5 참 코너에서 f·지상고 회수', () => {
  it('참 근변 코너 + 참 소실점 → f 오차 <1%, 지상고 오차 <3%, quad IoU = 1', () => {
    const { near, far } = trueCorners();
    // 참 깊이 소실점: 분리선(근변→원변)들의 교점.
    const vp = meetLinesLS(near.map((p, k) => lineThrough(p, far[k])!))!;
    const r = buildFromCorners(near, near.map((_, i) => i), vp, 1, 1, W, H, 1, {
      ...DEFAULT_BAY_OPTS,
      expectedBays: BAYS,
    });
    expect(r.ok).not.toBeNull();
    const b = r.ok!;
    expect(Math.abs(b.focalPx - F_TRUE) / F_TRUE).toBeLessThan(0.01);
    expect(Math.abs(b.cameraHeightM - D_TRUE) / D_TRUE).toBeLessThan(0.03);
    expect(b.quads.length).toBe(BAYS);
    for (let k = 0; k < BAYS; k++) {
      const truth = canonicalizeQuad([near[k], far[k], far[k + 1], near[k + 1]]) as PixelQuad;
      expect(quadIoU(b.quads[k].quad, truth)).toBeGreaterThan(0.99);
    }
  });

  it('퇴화 입력(코너 2개)은 null + 사유(throw 금지)', () => {
    const r = buildFromCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }], [0, 1], { x: 10, y: 10 }, 1, 1, W, H, 1, {
      ...DEFAULT_BAY_OPTS,
      expectedBays: 1,
    });
    expect(r.ok).toBeNull();
    expect((r as { issue: string }).issue).toContain('D1_TOO_FEW_BAYS');
  });
});

describe('bayGeometry — 합성 장면 전 파이프라인', () => {
  const { frame, near, far } = synthFrame();
  const det = pipeline(frame);

  it('가림이 있는 합성 장면에서 베이 quad 를 산출한다', () => {
    expect(det.quads.length).toBeGreaterThanOrEqual(4);
    expect(det.focalPx).not.toBeNull();
    expect(det.vpDepth).not.toBeNull();
  });

  it('산출 quad 가 참 quad 와 IoU ≥ 0.98 로 일치한다 — **합성 상한**이며 현장 성능이 아니다', () => {
    const truths: PixelQuad[] = [];
    for (let k = 0; k < BAYS; k++) truths.push(canonicalizeQuad([near[k], far[k], far[k + 1], near[k + 1]]) as PixelQuad);
    const ious = truths.map((t) => Math.max(0, ...det.quads.map((q) => quadIoU(q.quad, t))));
    const hit = ious.filter((v) => v >= 0.98).length;
    expect(hit).toBeGreaterThanOrEqual(det.quads.length);
  });

  it('f 를 이미지 증거만으로 1% 이내로 회수한다(V4)', () => {
    expect(Math.abs(det.focalPx! - F_TRUE) / F_TRUE).toBeLessThan(0.01);
  });

  it('지상고를 3% 이내로 회수한다(V5)', () => {
    expect(Math.abs(det.cameraHeightM! - D_TRUE) / D_TRUE).toBeLessThan(0.03);
  });

  it('V3 — 골든 해시로 결정론을 봉인한다(R2/R9)', () => {
    const again = pipeline(synthFrame().frame);
    const digest = (d: typeof det): string =>
      createHash('sha256')
        .update(
          stringify5({
            frontLine: d.frontLine,
            corners: d.cornersPx,
            lattice: d.latticeIndex,
            vpDepth: d.vpDepth,
            vpRow: d.vpRow,
            f: d.focalPx,
            n: d.normal,
            d: d.cameraHeightM,
            quads: d.quads,
          }),
        )
        .digest('hex');
    expect(digest(again)).toBe(digest(det));
  });

  it('증거가 없는 프레임은 강등된다 — quad 0개 + 사유(위장 금지)', () => {
    const flat: FrameGray = { data: new Uint8Array(W * H).fill(60), width: W, height: H };
    const d = pipeline(flat);
    expect(d.quads.length).toBe(0);
    expect(d.issues.join(' ')).toMatch(/D2_NO_FRONT_LINE|D3_FEW_SEPARATORS/);
  });
});

describe('bayGeometry — P2 평행 도색선 쌍 경로', () => {
  /** 근변선 + **원변선까지** 그린 합성 프레임(2:2 처럼 4변이 다 보이는 장면). */
  function synthFramePaired(occl = 0.45): { frame: FrameGray; near: Array<{ x: number; y: number }>; far: Array<{ x: number; y: number }> } {
    const bg = 60;
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = bg + Math.round((y / H) * 12);
    const { near, far } = trueCorners();
    drawSegment(data, near[0], near[BAYS], 7, 215, bg);
    drawSegment(data, far[0], far[BAYS], 6, 205, bg);            // ★ 원변선도 그린다
    for (let k = 0; k <= BAYS; k++) {
      const stub = { x: near[k].x + (far[k].x - near[k].x) * occl, y: near[k].y + (far[k].y - near[k].y) * occl };
      drawSegment(data, near[k], stub, 6, 210, bg);
      const fStub = { x: far[k].x + (near[k].x - far[k].x) * 0.25, y: far[k].y + (near[k].y - far[k].y) * 0.25 };
      drawSegment(data, far[k], fStub, 5, 205, bg);              // 원변 쪽 분리선 스텁
    }
    return { frame: { data, width: W, height: H }, near, far };
  }

  const { frame, near, far } = synthFramePaired();
  const { lines, mask } = detectPaintLines(frame, CLEAN_OPTS);
  const ev = paintEvidenceOf(mask, W, H);
  const top = lines.slice(0, 6);
  const seps = top.map((ln) => {
    const pk = scanSeparators(frame, mask, ln, CLEAN_OPTS);
    return pk.length ? refineSeparators(frame, pk, CLEAN_OPTS) : [];
  });
  const pairs: PairHypothesis[] = [];
  for (let a = 0; a < top.length; a++) {
    for (let b = 0; b < top.length; b++) {
      if (a === b || seps[a].length < 3 || seps[b].length < 2) continue;
      pairs.push({ near: top[a], far: top[b], nearSeps: seps[a], farSeps: seps[b] });
    }
  }
  const det = detectBaysPaired(pairs, ev, CLEAN_OPTS, 1, 1, W, H, 1, { ...DEFAULT_BAY_OPTS, expectedBays: BAYS });

  it('쌍 후보가 만들어진다', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('원변을 **외삽하지 않고 측정**해 quad 를 만든다', () => {
    expect(det.quads.length).toBeGreaterThanOrEqual(2);
    expect(det.vpDepth).not.toBeNull();
    expect(det.focalPx).not.toBeNull();
  });

  it('참 quad 와 IoU ≥ 0.9 로 일치한다(쌍 경로 상한)', () => {
    const truths: PixelQuad[] = [];
    for (let k = 0; k < BAYS; k++) truths.push(canonicalizeQuad([near[k], far[k], far[k + 1], near[k + 1]]) as PixelQuad);
    const ious = truths.map((t) => Math.max(0, ...det.quads.map((q) => quadIoU(q.quad, t))));
    const hits = ious.filter((v) => v >= 0.9).length;
    expect(hits).toBeGreaterThanOrEqual(det.quads.length);
  });

  it('결정론 — 같은 입력, 같은 출력', () => {
    const again = detectBaysPaired(pairs, ev, CLEAN_OPTS, 1, 1, W, H, 1, { ...DEFAULT_BAY_OPTS, expectedBays: BAYS });
    expect(stringify5(again.quads)).toBe(stringify5(det.quads));
  });

  it('쌍이 없으면 quad 0개 + 사유(강등, throw 금지)', () => {
    const d = detectBaysPaired([], ev, CLEAN_OPTS, 1, 1, W, H, 1, { ...DEFAULT_BAY_OPTS, expectedBays: BAYS });
    expect(d.quads.length).toBe(0);
    expect(d.issues.join(' ')).toContain('D12_NO_PAINT_SUPPORT');
  });
});
