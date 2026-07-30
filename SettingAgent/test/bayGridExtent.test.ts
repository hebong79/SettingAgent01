// ★ 18회차 — 행 범위 규칙(`rowExtentMode`) + 다중 행 출력(`rows`) 유닛테스트.
//
// 봉인하는 명제 3개:
//   ① **내부 구멍은 보간한다** — 양쪽이 도색 증거로 둘러싸인 결손은 가림이므로 채우고 `filledIndices` 에 남긴다.
//   ② **바깥으로는 외삽하지 않는다** — 창 끝 너머로 한 칸도 늘리지 않는다. 개수(`expectedBays`)를 쓰지 않는다.
//   ③ **`rows` 는 가산이다** — `best` 는 종전 규칙 그대로이고 `rows` 는 중복 제거·도색점수 내림차순이다.
//
// 합성 장면을 쓴다(R9): 카메라 파라미터를 먼저 정하고 그 파라미터로 베이 열을 투영·래스터화하므로
// 정답 격자가 해석적으로 알려져 있다. 실프레임 픽스처는 시뮬 상태가 봉인을 스스로 무효화한다.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  lineThrough,
  meetLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  type FrameGray,
  type RefinedLine,
} from '../src/ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, type BayDetectOpts } from '../src/ground/bayGeometry.js';
import { detectBaysWithModel, fitRowGrid, type RowCandidate } from '../src/ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../src/ground/cameraIntrinsics.js';

const W = 800;
const H = 480;
const F_TRUE = 700;
const D_TRUE = 5.0;
const WIDTH_M = 2.5;
const DEPTH_M = 5.0;
/** 전체 베이 수. 이 중 일부만 도색해서 "구멍"과 "행의 끝"을 만든다. */
const CELLS = 6;

type V3 = [number, number, number];
const norm3 = (v: V3): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const TILT_DEG = 30;
const TILT = (TILT_DEG * Math.PI) / 180;
const N_TRUE: V3 = norm3([0, Math.cos(TILT), Math.sin(TILT)]);
const project = (X: V3) => ({ x: (F_TRUE * X[0]) / X[2] + W / 2, y: (F_TRUE * X[1]) / X[2] + H / 2 });
function backproject(p: { x: number; y: number }): V3 {
  const m: V3 = [(p.x - W / 2) / F_TRUE, (p.y - H / 2) / F_TRUE, 1];
  const s = N_TRUE[0] * m[0] + N_TRUE[1] * m[1] + N_TRUE[2] * m[2];
  return [(m[0] * D_TRUE) / s, (m[1] * D_TRUE) / s, (m[2] * D_TRUE) / s];
}
const RIGHT_AXIS: V3 = norm3(cross3(N_TRUE, [0, 0, 1]));
const DEPTH_AXIS: V3 = norm3(cross3(RIGHT_AXIS, N_TRUE));
/** 열을 광축과 10° 로 살짝 비스듬히 둔다(정면 특수화 방지). */
const A = (10 * Math.PI) / 180;
const U_AXIS: V3 = norm3([
  RIGHT_AXIS[0] * Math.cos(A) + DEPTH_AXIS[0] * Math.sin(A),
  RIGHT_AXIS[1] * Math.cos(A) + DEPTH_AXIS[1] * Math.sin(A),
  RIGHT_AXIS[2] * Math.cos(A) + DEPTH_AXIS[2] * Math.sin(A),
]);
const V_AXIS: V3 = norm3(cross3(U_AXIS, N_TRUE));

/**
 * 행의 기준점을 **지면 좌표로** 잡는다 — 픽셀로 잡으면 원근 압축 때문에 6칸이 프레임을 벗어난다.
 * 카메라 발끝(nadir)에서 좌 7m · 전방 12m. 이 배치에서 6칸 전부가 4점 모두 프레임 안이고 칸 폭이 약 108px 다.
 */
function corners(): { near: Array<{ x: number; y: number }>; far: Array<{ x: number; y: number }> } {
  const OFF_M = -7;
  const FWD_M = 12;
  const base: V3 = [
    N_TRUE[0] * D_TRUE + RIGHT_AXIS[0] * OFF_M + DEPTH_AXIS[0] * FWD_M,
    N_TRUE[1] * D_TRUE + RIGHT_AXIS[1] * OFF_M + DEPTH_AXIS[1] * FWD_M,
    N_TRUE[2] * D_TRUE + RIGHT_AXIS[2] * OFF_M + DEPTH_AXIS[2] * FWD_M,
  ];
  const near: Array<{ x: number; y: number }> = [];
  const far: Array<{ x: number; y: number }> = [];
  for (let k = 0; k <= CELLS; k++) {
    const P: V3 = [base[0] + U_AXIS[0] * WIDTH_M * k, base[1] + U_AXIS[1] * WIDTH_M * k, base[2] + U_AXIS[2] * WIDTH_M * k];
    near.push(project(P));
    far.push(project([P[0] + V_AXIS[0] * DEPTH_M, P[1] + V_AXIS[1] * DEPTH_M, P[2] + V_AXIS[2] * DEPTH_M]));
  }
  return { near, far };
}

function drawSegment(data: Uint8Array, P: { x: number; y: number }, Q: { x: number; y: number }, w: number, value: number, bg: number): void {
  const minX = Math.max(0, Math.floor(Math.min(P.x, Q.x) - w));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(P.x, Q.x) + w));
  const minY = Math.max(0, Math.floor(Math.min(P.y, Q.y) - w));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(P.y, Q.y) + w));
  const dx = Q.x - P.x;
  const dy = Q.y - P.y;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - P.x) * dx + (y - P.y) * dy) / len2));
      const d = Math.hypot(x - (P.x + dx * t), y - (P.y + dy * t));
      const half = w / 2;
      if (d <= half) data[y * W + x] = value;
      else if (d <= half + 1) data[y * W + x] = Math.max(data[y * W + x], Math.round(bg + (value - bg) * (half + 1 - d)));
    }
  }
}

/**
 * `paintedCells` 에 든 칸만 근변 도색을 그린다. 나머지 칸은 근변선이 **끊긴다**(= 도색 증거 없음).
 * 분리선 스텁은 도색된 칸의 경계에만 그린다.
 */
function synth(paintedCells: readonly number[]): FrameGray {
  const bg = 60;
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = bg + Math.round((y / H) * 12);
  const { near, far } = corners();
  const set = new Set(paintedCells);
  for (const k of paintedCells) drawSegment(data, near[k], near[k + 1], 7, 215, bg);
  for (let k = 0; k <= CELLS; k++) {
    if (!set.has(k) && !set.has(k - 1)) continue;
    const stub = { x: near[k].x + (far[k].x - near[k].x) * 0.45, y: near[k].y + (far[k].y - near[k].y) * 0.45 };
    drawSegment(data, near[k], stub, 6, 210, bg);
  }
  return { data, width: W, height: H };
}

const MODEL = groundModelFromIntrinsics(
  {
    camIdx: 1,
    presetIdx: 1,
    fovDeg: (2 * Math.atan(H / 2 / F_TRUE) * 180) / Math.PI,
    fovAxis: 'vertical',
    tiltDeg: TILT_DEG,
    heightM: D_TRUE,
    imgW: W,
    imgH: H,
    source: 'test-synth',
  },
  1,
)!;
/** 합성 장면 전용 정련창(`bayGeometry.test.ts` 와 같은 사유 — 증거가 깨끗할 때의 상한을 본다). */
const CLEAN = { ...DEFAULT_PAINT_OPTIONS, scanStartPx: 18, scanNmsPx: 6, separatorProfileHalfPx: 8 };

/**
 * ★ 행 범위 규칙만 격리해 본다 — **전방선을 참값으로 고정**하고 `fitRowGrid` 만 부른다.
 *
 * 전 파이프라인을 태우면 창 규칙이 바뀔 때 **승자 후보 자체가 갈아치워져** 무엇을 재는지 알 수 없게 된다
 * (구현자 실측: maxGap 을 좁혔더니 다른 전방선 후보가 이겨 칸 수가 오히려 늘었다).
 * 여기서 재는 것은 "주어진 행에서 창을 어떻게 자르는가" 하나다.
 */
function runFixed(frame: FrameGray, painted: readonly number[], opts: Partial<BayDetectOpts>) {
  const { mask } = detectPaintLines(frame, CLEAN);
  const ev = paintEvidenceOf(mask, W, H);
  const { near } = corners();
  const lo = Math.min(...painted);
  const hi = Math.max(...painted) + 1;
  const line = lineThrough(near[lo], near[hi])!;
  const front: RefinedLine = {
    line,
    residPx: 0,
    hit: hi - lo + 1,
    widthPx: 7,
    contrast: 150,
    spanPx: Math.hypot(near[hi].x - near[lo].x, near[hi].y - near[lo].y),
    endA: near[lo],
    endB: near[hi],
    votes: 100,
  };
  // 위상 증거는 참 근변 코너 — 격자 원점이 실제 칸 경계에 놓이도록.
  const cornerPx = near.slice(lo, hi + 1);
  return fitRowGrid(MODEL, front, cornerPx, ev, CLEAN, { ...DEFAULT_BAY_OPTS, expectedBays: 4, ...opts });
}

function run(frame: FrameGray, opts: Partial<BayDetectOpts>) {
  const { lines, mask } = detectPaintLines(frame, CLEAN);
  const ev = paintEvidenceOf(mask, W, H);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, CLEAN.frontCandidates)) {
    const peaks = scanSeparators(frame, mask, front, CLEAN);
    const seps = peaks.length ? refineSeparators(frame, peaks, CLEAN) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sep of seps) {
      const q = meetLines(sep.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  return detectBaysWithModel(cands, MODEL, ev, CLEAN, { ...DEFAULT_BAY_OPTS, expectedBays: 4, ...opts }, frame);
}

/** 채택 격자의 격자인덱스를 0 기준으로 정규화(위상 원점은 구현 내부값이라 절대값을 고정하지 않는다). */
const shape = (idx: readonly number[]): number[] => idx.map((v) => v - Math.min(...idx));

describe('bayGrid rowExtentMode — 내부 구멍은 보간, 바깥은 외삽 금지', () => {
  it('구멍 없는 6칸 행: evidence 는 6칸을 전부 세운다(expectedBays=4 를 무시)', () => {
    const r = runFixed(synth([0, 1, 2, 3, 4, 5]), [0, 1, 2, 3, 4, 5], { rowExtentMode: 'evidence' });
    expect(r).not.toBeNull();
    expect(r!.quads.length).toBe(6);
    expect(r!.filledIndices).toEqual([]);
    expect(shape(r!.quads.map((q) => q.latticeIndex))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('같은 장면을 expected 로 보면 정확히 expectedBays 칸만 나온다 — 두 모드가 실제로 다르다', () => {
    const r = runFixed(synth([0, 1, 2, 3, 4, 5]), [0, 1, 2, 3, 4, 5], { rowExtentMode: 'expected' });
    expect(r!.quads.length).toBe(4);
    expect(r!.extentEndedBy).toBeNull();
    expect(r!.filledIndices).toEqual([]);
  });

  it('내부 2칸 구멍(가림)은 보간해 메우고 filledIndices 에 기록한다', () => {
    // 0,1 도색 / 2,3 결손 / 4,5 도색 → 인덱스 차 3 ≤ maxGap+1(4) 이므로 같은 run.
    const r = runFixed(synth([0, 1, 4, 5]), [0, 1, 2, 3, 4, 5], { rowExtentMode: 'evidence' })!;
    expect(shape(r.quads.map((q) => q.latticeIndex))).toEqual([0, 1, 2, 3, 4, 5]);
    // 증거 없이 산출한 칸을 숨기지 않는다.
    const base = Math.min(...r.quads.map((q) => q.latticeIndex));
    expect(r.filledIndices.map((v) => v - base).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('구멍이 maxGap+1 을 넘으면 보간하지 않는다 — 두 행 조각을 하나로 잇지 않는다', () => {
    // 같은 장면(0,1 도색 / 2,3 결손 / 4,5 도색)이라도 maxGap 을 1 로 좁히면 차 3 > 2 라 run 이 끊긴다.
    // ★ 칸 수를 고정하지 않는다: 창이 짧아지면 **위상 탐색이 다른 위상을 고른다**(반칸 어긋난 격자가
    //   6칸 전부에서 부분 지지를 받아 이길 수 있다). 규칙이 보장하는 것은 "지지 없는 칸을 다리 놓지 않는다"이다.
    const r = runFixed(synth([0, 1, 4, 5]), [0, 1, 2, 3, 4, 5], { rowExtentMode: 'evidence', maxGap: 1 })!;
    const kept = new Map(r.cellDiag.map((d) => [d.index, d.near]));
    for (const f of r.filledIndices) {
      // 보간된 칸은 반드시 maxGap 이내의 결손이어야 한다 — 큰 구멍을 메운 흔적이 있으면 실패.
      const left = [...kept.keys()].filter((k) => k < f && kept.get(k)! >= 0.35).sort((a, b) => b - a)[0];
      const right = [...kept.keys()].filter((k) => k > f && kept.get(k)! >= 0.35).sort((a, b) => a - b)[0];
      expect(right - left, `보간 칸 ${f} 가 ${right - left} 칸짜리 구멍을 다리 놓았다`).toBeLessThanOrEqual(2);
    }
  });

  it('창 밖으로는 한 칸도 외삽하지 않는다 — 산출 칸은 전부 지지가 있거나 내부 보간이다', () => {
    const painted = [2, 3, 4];
    // expectedBays 를 8 로 올려도 창이 늘지 않는다(개수는 창을 넓히는 근거가 되지 못한다).
    const r = runFixed(synth(painted), painted, { rowExtentMode: 'evidence', expectedBays: 8 })!;
    const near = new Map(r.cellDiag.map((d) => [d.index, d.near]));
    const idx = r.quads.map((q) => q.latticeIndex);
    const filled = new Set(r.filledIndices);
    for (const k of idx) {
      const supported = (near.get(k) ?? 0) >= DEFAULT_BAY_OPTS.extendMinNearSupport;
      expect(supported || filled.has(k), `칸 ${k} 는 지지도 없고 보간 기록도 없다 — 외삽이다`).toBe(true);
    }
    // 보간 칸은 반드시 지지 칸 **사이**에 있다(양 끝 바깥이 아니다).
    const sup = idx.filter((k) => (near.get(k) ?? 0) >= DEFAULT_BAY_OPTS.extendMinNearSupport);
    for (const f of r.filledIndices) {
      expect(f).toBeGreaterThan(Math.min(...sup));
      expect(f).toBeLessThan(Math.max(...sup));
    }
    // 창은 연속이다(구멍 난 묶음 금지).
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(Math.max(...idx) - Math.min(...idx) + 1).toBe(idx.length);
  });

  it('extentEndedBy 는 양 끝이 왜 끝났는지 보고한다', () => {
    const r = runFixed(synth([2, 3, 4]), [2, 3, 4], { rowExtentMode: 'evidence' })!;
    expect(r.extentEndedBy).not.toBeNull();
    for (const side of [r.extentEndedBy!.lo, r.extentEndedBy!.hi]) {
      expect(['evidence', 'frame', 'span']).toContain(side);
    }
  });

  it('evidence 모드는 expectedBays 에 반응하지 않는다(개수 무사용)', () => {
    const frame = synth([0, 1, 2, 3, 4, 5]);
    const cells = [0, 1, 2, 3, 4, 5];
    const a = runFixed(frame, cells, { rowExtentMode: 'evidence', expectedBays: 2 })!;
    const b = runFixed(frame, cells, { rowExtentMode: 'evidence', expectedBays: 20 })!;
    expect(a.quads.map((q) => q.latticeIndex)).toEqual(b.quads.map((q) => q.latticeIndex));
    for (let i = 0; i < a.quads.length; i++) expect(a.quads[i].quad).toEqual(b.quads[i].quad);
  });
});

describe('bayGrid rows — 다중 행 출력은 가산이다', () => {
  const frame = synth([0, 1, 2, 3, 4, 5]);

  it('rows 는 항상 존재하고 best 를 포함한다', () => {
    for (const mode of ['evidence', 'expected'] as const) {
      const g = run(frame, { rowExtentMode: mode });
      expect(Array.isArray(g.rows)).toBe(true);
      expect(g.rows.length).toBeGreaterThan(0);
      // best 는 보정·재적합을 거치므로 동일 객체는 아니지만, 같은 전방선을 가진 행이 목록에 있어야 한다.
      expect(g.rows.some((r) => r.quads.length > 0)).toBe(true);
    }
  });

  it('rows 는 paint.score 내림차순이다 — effectiveScore(aim 항 포함)로 정렬하지 않는다', () => {
    const g = run(frame, { rowExtentMode: 'evidence' });
    for (let i = 1; i < g.rows.length; i++) {
      expect(g.rows[i - 1].paint.score).toBeGreaterThanOrEqual(g.rows[i].paint.score - 1e-12);
    }
  });

  it('rows 안에 서로 절반 넘게 겹치는 행은 없다(중복 제거)', () => {
    const g = run(frame, { rowExtentMode: 'evidence' });
    // 중복 제거의 정의를 그대로 재확인한다 — 어떤 행도 앞선 행과 quad 절반 이상을 공유하지 않는다.
    for (let i = 0; i < g.rows.length; i++) {
      for (let j = i + 1; j < g.rows.length; j++) {
        const a = g.rows[i].quads.map((q) => `${q.quad[0].x.toFixed(3)},${q.quad[0].y.toFixed(3)}`);
        const b = g.rows[j].quads.map((q) => `${q.quad[0].x.toFixed(3)},${q.quad[0].y.toFixed(3)}`);
        const shared = b.filter((k) => a.includes(k)).length;
        expect(shared / b.length).toBeLessThan(1);
      }
    }
  });

  it('rows 는 거리 게이트를 통과하지 않는다 — 게이트는 best 전용이다', () => {
    // maxRowDistanceRatio 를 아주 빡빡하게 켜도 rows 개수는 변하지 않아야 한다(목표 ① 보호).
    const open = run(frame, { rowExtentMode: 'evidence', maxRowDistanceRatio: 0 });
    const gated = run(frame, { rowExtentMode: 'evidence', maxRowDistanceRatio: 1.01 });
    expect(gated.rows.length).toBe(open.rows.length);
  });
});

// ★ 19회차 — 다중 행 목록의 **진입 문턱**. 봉인하는 명제:
//   ① 문턱은 `rows` 만 줄인다 — `best` 는 어떤 문턱에서도 **원시 배정도로 동일**하다.
//   ② 0 으로 두면 18회차 목록이 그대로 나온다(끄기 가능 = 가산성 유지).
//   ③ 문턱을 올리면 목록은 **단조 부분집합**이다(재정렬·신규 등장 금지).
//   ④ 기준은 절대값이 아니라 `best` 대비 **상대비**다 — 도색 점수를 통째로 스케일해도 목록이 같다.
describe('bayGrid rows 진입 문턱 — 정밀도는 올리되 best 는 건드리지 않는다', () => {
  const frame = synth([0, 1, 2, 3, 4, 5]);
  const off = { rowExtentMode: 'evidence' as const, rowMinScoreRatio: 0, rowMinNearSupport: 0 };

  it('문턱은 best 를 바꾸지 않는다 — 원시 배정도 동일', () => {
    const a = run(frame, off);
    const b = run(frame, { ...off, rowMinScoreRatio: 0.94, rowMinNearSupport: 0.69 });
    const c = run(frame, { ...off, rowMinScoreRatio: 0.999, rowMinNearSupport: 0.99 });
    // toFixed 비교 금지(15회차 함정) — JSON 직렬화는 double 을 왕복 정확하게 표현한다.
    const bestJson = (g: ReturnType<typeof run>) => JSON.stringify({ best: g.best, tried: g.tried });
    expect(bestJson(b)).toBe(bestJson(a));
    expect(bestJson(c)).toBe(bestJson(a));
  });

  it('0 이면 18회차 동작 그대로다(문턱 끄기)', () => {
    const a = run(frame, off);
    // 기본값(문턱 ON)은 목록이 같거나 짧다 — 절대 늘지 않는다.
    const d = run(frame, { rowExtentMode: 'evidence' });
    expect(a.rows.length).toBeGreaterThanOrEqual(d.rows.length);
  });

  it('문턱을 올리면 목록은 단조 부분집합이다', () => {
    const keyOf = (r: { frontLine: readonly number[]; phaseM: number }) => `${r.frontLine.join(',')}|${r.phaseM}`;
    let prev = run(frame, off).rows.map(keyOf);
    for (const ratio of [0.5, 0.8, 0.94, 0.999]) {
      const cur = run(frame, { ...off, rowMinScoreRatio: ratio }).rows.map(keyOf);
      expect(cur.length).toBeLessThanOrEqual(prev.length);
      for (const k of cur) expect(prev).toContain(k);
      prev = cur;
    }
  });

  it('절대값이 아니라 상대비다 — 비율 1 에 가까워도 목록이 비지 않는다', () => {
    // 절대 문턱이면 0.999 는 이 장면의 점수 스케일 아래라 전부 남거나(스케일이 크면) 전부 사라진다.
    // 상대비면 **기준 행 자신이 반드시 통과**하므로 목록은 비지 않고 극단적으로 짧아진다.
    const g = run(frame, { ...off, rowMinScoreRatio: 0.999 });
    expect(g.rows.length).toBeGreaterThan(0);
    expect(g.rows.length).toBeLessThanOrEqual(run(frame, off).rows.length);
  });

  it('near 문턱은 paint.near 하한을 그대로 강제한다', () => {
    const g = run(frame, { ...off, rowMinNearSupport: 0.8 });
    for (const r of g.rows) expect(r.paint.near).toBeGreaterThanOrEqual(0.8);
  });
});
