// V7 — 채점(Stage C) 유닛테스트. 정점 배정을 **정답지 없이** 판별하는지, 강등이 통과로 새지 않는지.

import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_SLOT_IDX,
  resolveManualAssignment,
  scorePreset,
  summarize,
  toPixelQuad,
} from '../src/ground/roiAutoScore.js';
import { canonicalizeQuad } from '../src/ground/groundGrid.js';
import type { BayQuad } from '../src/ground/bayGeometry.js';
import type { PlaceRoiSpace } from '../src/capture/placeRoi.js';
import type { PixelQuad } from '../src/ground/types.js';

const W = 1920;
const H = 1080;

/** 근변/원변 픽셀 코너에서 정규화 space 를 만든다. `rot`/`reverse` 로 정점 규약을 뒤튼다. */
function spacesFrom(
  near: Array<{ x: number; y: number }>,
  far: Array<{ x: number; y: number }>,
  rot: number,
  reverse: boolean,
  startIdx = 1,
): PlaceRoiSpace[] {
  const out: PlaceRoiSpace[] = [];
  for (let k = 0; k + 1 < near.length; k++) {
    const ring = [near[k], far[k], far[k + 1], near[k + 1]];
    const rotated = [0, 1, 2, 3].map((i) => ring[(i + rot) % 4]);
    out.push({ idx: startIdx + k, points: rotated.map((p) => ({ x: p.x / W, y: p.y / H })) });
  }
  return reverse ? out.reverse().map((s, i) => ({ ...s, idx: startIdx + i })) : out;
}

/** 사영 등간격 근변 + 소실점으로 수렴하는 분리변을 가진 합성 베이 열. */
function syntheticRow(bays: number): { near: Array<{ x: number; y: number }>; far: Array<{ x: number; y: number }> } {
  const near: Array<{ x: number; y: number }> = [];
  const far: Array<{ x: number; y: number }> = [];
  const VP = { x: 400, y: 120 }; // 깊이 소실점
  const model = { a: 1400, b: 0, c: 0.09 }; // 근변 위 사영 1D
  const A = { x: 200, y: 900 };
  const dirx = 0.94;
  const diry = -0.34;
  for (let k = 0; k <= bays; k++) {
    const s = (model.a * k + model.b) / (model.c * k + 1);
    const p = { x: A.x + dirx * s, y: A.y + diry * s };
    near.push(p);
    // 원변 = 근변에서 소실점 쪽으로 일정 비율 이동(사영적으로 일관)
    far.push({ x: p.x + (VP.x - p.x) * 0.42, y: p.y + (VP.y - p.y) * 0.42 });
  }
  return { near, far };
}

/** 근변/원변에서 자동 quad 를 만든다(정답과 동일 = IoU 1 기준선). */
function autoQuadsFrom(near: Array<{ x: number; y: number }>, far: Array<{ x: number; y: number }>): BayQuad[] {
  const out: BayQuad[] = [];
  for (let k = 0; k + 1 < near.length; k++) {
    const q = canonicalizeQuad([near[k], far[k], far[k + 1], near[k + 1]]);
    if (q) out.push({ latticeIndex: k, quad: q });
  }
  return out;
}

describe('roiAutoScore — 정규화 변환', () => {
  it('toPixelQuad 는 4점이 아니면 null', () => {
    expect(toPixelQuad({ idx: 1, points: [] }, W, H)).toBeNull();
    expect(toPixelQuad({ idx: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, W, H)).toBeNull();
  });

  it('toPixelQuad 는 정규화 좌표를 픽셀로 되돌린다', () => {
    const q = toPixelQuad({ idx: 1, points: [{ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, W, H)!;
    expect(q[0]).toEqual({ x: 960, y: 540 });
    expect(q[3]).toEqual({ x: 1920, y: 1080 });
  });
});

describe('roiAutoScore — V7 정점 배정을 정답지 없이 판별한다(R3)', () => {
  const { near, far } = syntheticRow(6);

  it('rot=0 dir=+ 로 저작된 정본을 그대로 회수한다', () => {
    const asg = resolveManualAssignment(spacesFrom(near, far, 0, false), W, H)!;
    expect(asg.rot).toBe(0);
    expect(asg.dir).toBe(1);
    expect(asg.rowResidPx).toBeLessThan(0.5);
  });

  it('정점을 1칸 회전시켜 저작해도 일관된 파싱을 찾아낸다', () => {
    // ★ 실측으로 드러난 규약 모호성(정직 기록): 이미지측 일관성만으로는 **근변 행과 원변 행을 구분할 수 없다**.
    //   두 행 모두 사영 등간격이고, 두 행을 잇는 분리변은 같은 소실점으로 수렴한다.
    //   저작 rot=1 에 대해 복원 rot=3(근변 파싱)과 rot=1(원변 파싱)이 **둘 다 정답**이며,
    //   선택은 잔차 동점에서 순회 순서로 갈린다. 어느 쪽이든 기하는 오염되지 않으므로 채점에는 영향이 없다.
    //   근/원 구분은 이미지가 아니라 "카메라에 가까운 쪽"이라는 외부 규약이 정한다(설계 §3 누출과 같은 성격).
    const asg = resolveManualAssignment(spacesFrom(near, far, 1, false), W, H)!;
    expect([1, 3]).toContain(asg.rot);
    expect(asg.rowResidPx).toBeLessThan(0.5);
    expect(asg.sideResidPx).toBeLessThan(1.0);
  });

  it('슬롯 순서를 뒤집어 저작해도 dir 을 되찾는다', () => {
    const asg = resolveManualAssignment(spacesFrom(near, far, 0, true), W, H)!;
    expect(asg.dir).toBe(-1);
    expect(asg.rowResidPx).toBeLessThan(0.5);
  });

  it('선택 기준은 IoU 가 아니다 — 자동 quad 없이도 판별된다(R1)', () => {
    // resolveManualAssignment 의 인자에 자동 결과가 아예 없다. 이미지측 일관성만으로 결정된다.
    expect(resolveManualAssignment.length).toBe(3);
    const asg = resolveManualAssignment(spacesFrom(near, far, 2, false), W, H);
    expect(asg).not.toBeNull();
  });

  it('주차면 3면 미만이면 판별 불가(null)', () => {
    expect(resolveManualAssignment(spacesFrom(near, far, 0, false).slice(0, 2), W, H)).toBeNull();
  });
});

describe('roiAutoScore — 채점·강등', () => {
  const { near, far } = syntheticRow(5);
  const manual = spacesFrom(near, far, 0, false);
  const auto = autoQuadsFrom(near, far);

  it('자동이 정답과 같으면 전 면 IoU 1', () => {
    const s = scorePreset(auto, near, manual, W, H, '1:1', 1, 1);
    expect(s.manualSlots).toBe(5);
    expect(s.pass98).toBe(5);
    expect(s.minIoU).toBeGreaterThan(0.999);
    expect(s.graded).toBe(true);
    expect(s.gradeReason).toBeNull();
  });

  it('자동 quad 가 없으면 graded:false — 통과로 세지 않는다', () => {
    const s = scorePreset([], [], manual, W, H, '1:1', 1, 1);
    expect(s.graded).toBe(false);
    expect(s.gradeReason).toContain('D2_NO_FRONT_LINE');
    expect(s.pass98).toBe(0);
  });

  it('주차면 2면 프리셋은 D1_TOO_FEW_BAYS 로 검증 불가 표기(D-2)', () => {
    const two = manual.slice(0, 2);
    const s = scorePreset(auto, near, two, W, H, '1:3', 1, 3);
    expect(s.graded).toBe(false);
    expect(s.gradeReason).toContain('D1_TOO_FEW_BAYS');
  });

  it('슬롯 24 는 채점 범위에서 제외되고 사유가 남는다(R8·D-3)', () => {
    expect(EXCLUDED_SLOT_IDX).toContain(24);
    const withS24: PlaceRoiSpace[] = [...manual, { idx: 24, points: manual[0].points }];
    const s = scorePreset(auto, near, withS24, W, H, '1:1', 1, 1);
    const row = s.slots.find((x) => x.slotIdx === 24)!;
    expect(row.degrade).toBe('D9_SLOT24');
    expect(row.matched).toBe(false);
    expect(s.manualSlots).toBe(5); // 집계에서 빠진다
    expect(s.issues.join(' ')).toContain('slot24');
  });

  it('4점이 아닌 주차면은 D8_NON_QUAD 로 빠진다', () => {
    const broken: PlaceRoiSpace[] = [...manual, { idx: 99, points: [] }];
    const s = scorePreset(auto, near, broken, W, H, '1:1', 1, 1);
    expect(s.slots.find((x) => x.slotIdx === 99)!.degrade).toBe('D8_NON_QUAD');
  });

  it('수동이 도색선에서 벗어나 IoU 가 깎이면 D10_ANCHOR_DEFECT 근거를 남긴다(D-1)', () => {
    // 첫 슬롯만 통째로 12px 밀어 저작 — 자동은 도색선(=참 코너) 위에 있다.
    const shifted = manual.map((sp, i) =>
      i === 0 ? { idx: sp.idx, points: sp.points.map((p) => ({ x: p.x + 12 / W, y: p.y + 12 / H })) } : sp,
    );
    const s = scorePreset(auto, near, shifted, W, H, '1:1', 1, 1);
    const first = s.slots.find((x) => x.slotIdx === shifted[0].idx)!;
    expect(first.iouVsManual).toBeLessThan(0.98);
    expect(first.paintDevPx).not.toBeNull();
    expect(first.paintDevPx!).toBeGreaterThan(3);
    expect(first.degrade).toBe('D10_ANCHOR_DEFECT');
  });

  it('summarize 는 graded:false 프리셋을 평균·통과에서 뺀다', () => {
    const ok = scorePreset(auto, near, manual, W, H, '1:1', 1, 1);
    const bad = scorePreset([], [], manual.slice(0, 2), W, H, '1:3', 1, 3);
    const sum = summarize([ok, bad]);
    expect(sum.gradedPresets).toBe(1);
    expect(sum.gradedSlots).toBe(5);
    expect(sum.pass98).toBe(5);
  });

  it('IoU 는 quadIoU 를 통해 계산되며 볼록 quad 순서에 무관하다(R4)', () => {
    const rotated = autoQuadsFrom(near, far).map((q) => ({
      latticeIndex: q.latticeIndex,
      quad: [q.quad[2], q.quad[3], q.quad[0], q.quad[1]] as PixelQuad,
    }));
    const a = scorePreset(auto, near, manual, W, H, '1:1', 1, 1);
    const b = scorePreset(rotated, near, manual, W, H, '1:1', 1, 1);
    expect(b.minIoU).toBeCloseTo(a.minIoU!, 9);
  });
});
