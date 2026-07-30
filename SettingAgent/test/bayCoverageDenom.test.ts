// ★ 21회차 ①② — **커버리지 척도**의 두 갈래를 못 박는다.
//
//  H2(갯수 무관): `coverageDenom:'phaseInvariant'` 에서 `expectedBays ∈ {1,2,4,7,8,12,16}` 전 구간
//                 산출 quad 좌표가 **비트 동일**해야 한다. 이것이 통과하면 뷰어에서 「예상 주차면 수」를
//                 비워도 **원리적으로** 조용히 틀릴 수 없다(17회차 `max(1,0)` 함정의 전제가 사라진다).
//  ①(분리):      `rows` 진입 판정이 `effectiveScore` 를 읽지 않는다(소스 봉인 — `roiAutoHoldout` 과 같은 패턴).
//                 20c 실측: 이 결합 때문에 커버리지 1줄 수정이 목록 전체를 재편해 정밀도 0.8571→0.6250 이 됐다.
//
// 합성 장면으로 돈다(정본·Unity·씬 정답 무참조). 프레임은 도색 띠를 그려 만든다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_BAY_OPTS, type BayDetectOpts } from '../src/ground/bayGeometry.js';
import { detectBaysWithModel, rowFrameFromLine, type RowCandidate } from '../src/ground/bayGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../src/ground/cameraIntrinsics.js';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, meetLines, paintEvidenceOf, refineSeparators, scanSeparators, type FrameGray } from '../src/ground/floorPaint.js';
import { projectToPixel } from '../src/ground/project.js';

const BAYS_SWEEP = [1, 2, 4, 7, 8, 12, 16];

/** 합성 프레임 — 지면에 근변선 1개 + 분리선 스텁 7개를 그린다(밝은 띠 = 도색). */
function syntheticFrame(): { frame: FrameGray; model: NonNullable<ReturnType<typeof groundModelFromIntrinsics>> } {
  const W = 960;
  const H = 540;
  const intr: PresetIntrinsics = {
    camIdx: 1,
    presetIdx: 1,
    fovDeg: 58,
    fovAxis: 'horizontal',
    tiltDeg: 22,
    heightM: 4.95,
    imgW: W,
    imgH: H,
    source: 'test',
  };
  const model = groundModelFromIntrinsics(intr, 1)!;
  const data = new Uint8Array(W * H).fill(40);
  const fr = rowFrameFromLine(model, [0, 1, -430])!;
  const at = (a: number, b: number) =>
    projectToPixel(
      [fr.origin[0] + fr.u[0] * a + fr.v[0] * b, fr.origin[1] + fr.u[1] * a + fr.v[1] * b, fr.origin[2] + fr.u[2] * a + fr.v[2] * b],
      model,
    );
  const dot = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const xi = Math.round(x) + dx;
        const yi = Math.round(y) + dy;
        if (xi >= 0 && yi >= 0 && xi < W && yi < H) data[yi * W + xi] = 235;
      }
    }
  };
  const stroke = (p0: { x: number; y: number }, p1: { x: number; y: number }) => {
    const n = Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y)) * 2 + 1;
    for (let i = 0; i <= n; i++) dot(p0.x + ((p1.x - p0.x) * i) / n, p0.y + ((p1.y - p0.y) * i) / n);
  };
  // 근변선(행 전체) + 6칸 분리선(깊이 1.6m 스텁 — 실제 장면처럼 짧게).
  const A0 = at(-1, 0);
  const A1 = at(16, 0);
  if (A0 && A1) stroke(A0, A1);
  for (let k = 0; k <= 6; k++) {
    const s0 = at(k * 2.5, 0);
    const s1 = at(k * 2.5, 1.6);
    if (s0 && s1) stroke(s0, s1);
  }
  return { frame: { data, width: W, height: H }, model };
}

function detectWith(opts: Partial<BayDetectOpts>): ReturnType<typeof detectBaysWithModel> {
  const { frame, model } = syntheticFrame();
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, frame.width, frame.height);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const pk = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sp of seps) {
      const q = meetLines(sp.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  return detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: 1, ...opts }, frame);
}

/** 산출 좌표를 비교 가능한 문자열로 — 비트 동일 판정용(toFixed 금지 규약: 값을 그대로 직렬화한다). */
const fingerprint = (g: ReturnType<typeof detectBaysWithModel>): string =>
  JSON.stringify({
    best: (g.best?.quads ?? []).map((q) => [q.latticeIndex, q.quad.map((p) => [p.x, p.y])]),
    phaseM: g.best?.phaseM,
    rows: g.rows.map((r) => [r.phaseM, r.quads.map((q) => [q.latticeIndex, q.quad.map((p) => [p.x, p.y])])]),
  });

describe('커버리지 척도 — 갯수 무관(H2)', () => {
  it("phaseInvariant 는 expectedBays 7값 전 구간에서 산출 좌표가 비트 동일하다", () => {
    const fps = BAYS_SWEEP.map((bays) => fingerprint(detectWith({ coverageDenom: 'phaseInvariant', expectedBays: bays })));
    // 검출이 실제로 뭔가를 냈는지 먼저 확인한다(전부 빈 결과가 "동일"로 통과하는 것을 막는다).
    expect(JSON.parse(fps[0]).best.length).toBeGreaterThan(0);
    for (let i = 1; i < fps.length; i++) {
      expect(fps[i], `expectedBays=${BAYS_SWEEP[i]} 가 ${BAYS_SWEEP[0]} 과 다르다 — 갯수가 산출에 개입한다`).toBe(fps[0]);
    }
  });

  it('phaseInvariant 는 커버리지 분모를 위상 불변량으로 노출한다(진단이 값으로 남는다)', () => {
    const g = detectWith({ coverageDenom: 'phaseInvariant', expectedBays: 4 });
    expect(g.best?.denomCells).toBeGreaterThan(0);
    expect(g.best?.effCells).toBeGreaterThan(0);
    expect(g.best?.coverage).toBeLessThanOrEqual(1);
    // 분모는 그 행의 도색 지지 구간에서 오므로 `expectedBays` 를 바꿔도 같다.
    expect(detectWith({ coverageDenom: 'phaseInvariant', expectedBays: 16 }).best?.denomCells).toBe(g.best?.denomCells);
  });

  it('기본값은 종전 식이다 — 무회귀 규약(골든·프리셋 응답이 이 갈래에서 나온다)', () => {
    expect(DEFAULT_BAY_OPTS.coverageDenom).toBe('expectedBays');
  });

  it('effectiveScore = baseScore × coverage^exponent 가 성립한다(①에서 이름만 분리했다)', () => {
    const g = detectWith({ coverageDenom: 'phaseInvariant', expectedBays: 4 });
    const b = g.best!;
    expect(b.effectiveScore).toBeCloseTo((b.baseScore ?? 0) * Math.pow(b.coverage ?? 0, DEFAULT_BAY_OPTS.coverageExponent), 12);
  });
});

describe('① rows 진입 판정과 best 점수식의 분리(소스 봉인)', () => {
  it('rows 필터·기준선 산출이 effectiveScore 를 읽지 않는다', () => {
    const src = readFileSync('src/ground/bayGrid.ts', 'utf8');
    // 기준선 산출 블록(refScore) ~ rows 필터까지를 잘라 검사한다.
    const from = src.indexOf('let refScore');
    const to = src.indexOf('const rowIssues');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = src.slice(from, to);
    expect(block.includes('effectiveScore'), 'rows 진입 판정이 effectiveScore 에 다시 결합됐다(20c 가 부딪힌 그 결합)').toBe(false);
    expect(block).toContain('baseScore');
  });
});
