// 자동 ROI 채점(Stage C) — **이 파일이 수동 정본을 읽는 유일한 모듈이다**(설계 §3 hold-out 구조 ②).
//
// `floorPaint.ts` · `bayGeometry.ts` 는 `placeRoi` 를 어떤 경로로도 참조하지 않는다.
// `test/roiAutoHoldout.test.ts` 가 그 사실을 정적으로 봉인한다.
//
// IoU 는 `autoRoiPlan.ts:quadIoU` 를 재사용한다 — **신규 IoU 구현 금지(R4)**.
//
// 채점 기준 2종(리더 D-1):
//   · `iouVsManual` — 현재 수동 정본 대비(마스터가 말한 98% 의 문자 그대로의 기준)
//   · `iouVsPaint`  — 검출된 도색선 대비(물리적 정답). 수동 앵커 결함(D10)을 드러내기 위해 병기한다.
// 두 값을 모두 산출해 어느 쪽이 틀렸는지 **숫자로 보이게** 한다. 한쪽만 내면 F6 같은 수동 결함을 영영 못 본다.

import { quadIoU, MATCH_MIN_IOU } from './autoRoiPlan.js';
import { canonicalizeQuad } from './groundGrid.js';
import { DEGRADE, fitProjective1D, meetLinesLS, predictS, vpResidPx, type BayQuad } from './bayGeometry.js';
import { lineThrough } from './floorPaint.js';
import type { PlaceRoiSpace } from '../capture/placeRoi.js';
import type { PixelQuad } from './types.js';

/** 주차면 1건의 채점 결과. */
export interface SlotScore {
  slotIdx: number;
  /** 수동 정본 대비 IoU. 매칭 실패 시 0. */
  iouVsManual: number;
  /** 검출 도색선(자동 근변) 대비 — 수동 변이 도색선에서 얼마나 벗어났는가(px). 산출 불가 시 null. */
  paintDevPx: number | null;
  matched: boolean;
  /** 강등 코드(있으면 통과 집계에서 제외). */
  degrade: string | null;
}

export interface PresetScore {
  key: string;
  camId: number;
  presetIdx: number;
  /** 자동 산출 quad 수. */
  autoQuads: number;
  /** 정본이 이 프리셋에 가진 4점 주차면 수. */
  manualSlots: number;
  slots: SlotScore[];
  meanIoU: number | null;
  minIoU: number | null;
  pass98: number;
  /** 유효 채점 대상인가. false 면 통과·평균 집계에서 **제외**한다("제외 = 통과" 아님). */
  graded: boolean;
  gradeReason: string | null;
  /** 방향 1비트를 무엇으로 정했는가(설계 §3 선언 누출 2). */
  directionResolvedBy: 'convention' | 'score(1bit-leak)';
  issues: string[];
}

/** 이 프리셋의 슬롯 배정 규약(이면군 탐색 결과). */
export interface ManualAssignment {
  /** 정점 회전량(0..3). */
  rot: number;
  /** 순회 방향(+1 = 파일 순서, −1 = 역순). */
  dir: 1 | -1;
  /** 근변 코너 등간격 잔차(px). */
  rowResidPx: number;
  /** 분리변 소실점 잔차(px). */
  sideResidPx: number;
}

/**
 * 슬롯 24 — 파일↔DB 소속 불일치로 채점·적용에서 제외하던 항목.
 *
 * ★ 2026-07-29 마스터 복귀 후 리더가 정본에서 **제거 완료**(`place.space.delete{mode:'remove'}`).
 *   24 가 최대 인덱스였으므로 1~23 재번호는 없었고, 총 23면이 됐다.
 *   → 이 목록은 이제 **도달 불가(dead)** 다. 정본에 idx 24 가 없으므로 아래 가드는 절대 발화하지 않는다.
 *   회귀 위험 때문에 제거하지 않고 남긴다(같은 사고가 재발하면 다시 발화하는 안전망 역할).
 *   잔여 과제: DB `slot_setup` 에 고아 행 `slot_id 24` 가 남아 있다(삭제 경로 미노출 — 다음 세션).
 */
export const EXCLUDED_SLOT_IDX: readonly number[] = [24];

/** 정규화 4점 → 픽셀 quad. 4점이 아니거나 비유한 → null. */
export function toPixelQuad(sp: PlaceRoiSpace, imgW: number, imgH: number): PixelQuad | null {
  if (!Array.isArray(sp.points) || sp.points.length !== 4) return null;
  const px = sp.points.map((p) => ({ x: p.x * imgW, y: p.y * imgH }));
  if (px.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  return [px[0], px[1], px[2], px[3]];
}

/**
 * ★ 정점 배정을 **정답지 없이** 판별한다(R3 + R1 양립).
 *
 * 선택 기준은 IoU 가 **아니다** — IoU 로 고르면 정답지가 입력이 된다.
 * 이면군(4회전 × 방향 2 = 8후보)을 고정 순서로 전수 순회하며,
 * "근변 코너가 사영 등간격인가" + "분리변이 한 점에 수렴하는가" 라는 **이미지측 일관성**만 본다.
 *
 * 실측 근거(설계자 F5): 이 기준으로 2:1 → rot=1 dir=−, 2:2 → rot=2 dir=− 를 정답지 없이 회수했다.
 */
export function resolveManualAssignment(
  manual: readonly PlaceRoiSpace[],
  imgW: number,
  imgH: number,
): ManualAssignment | null {
  const quads: PixelQuad[] = [];
  for (const sp of manual) {
    const q = toPixelQuad(sp, imgW, imgH);
    if (q) quads.push(q);
  }
  if (quads.length < 3) return null;
  let best: ManualAssignment | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let rot = 0; rot < 4; rot++) {
    for (const dir of [1, -1] as const) {
      const ordered = dir > 0 ? quads : [...quads].reverse();
      const Q = ordered.map((q) => [0, 1, 2, 3].map((i) => q[(i + rot) % 4]));
      const near = Q.map((q) => q[0]);
      near.push(Q[Q.length - 1][3]);
      const sides: Array<[number, number, number]> = [];
      for (const q of Q) {
        const l = lineThrough(q[0], q[1]);
        if (l) sides.push(l);
      }
      const lastSide = lineThrough(Q[Q.length - 1][3], Q[Q.length - 1][2]);
      if (lastSide) sides.push(lastSide);
      if (sides.length < 2) continue;
      const V = meetLinesLS(sides);
      if (!V) continue;
      const L = Math.hypot(near[near.length - 1].x - near[0].x, near[near.length - 1].y - near[0].y);
      if (!(L > 1)) continue;
      const ux = (near[near.length - 1].x - near[0].x) / L;
      const uy = (near[near.length - 1].y - near[0].y) / L;
      const s = near.map((p) => (p.x - near[0].x) * ux + (p.y - near[0].y) * uy);
      const idx = near.map((_, i) => i);
      const fit = fitProjective1D(s, idx);
      if (!fit) continue;
      let rowResidPx = 0;
      for (let i = 0; i < s.length; i++) rowResidPx = Math.max(rowResidPx, Math.abs(predictS(fit, idx[i]) - s[i]));
      let sideResidPx = 0;
      for (const q of Q) sideResidPx = Math.max(sideResidPx, vpResidPx(V, q[0], q[1]));
      const score = rowResidPx + 0.05 * sideResidPx;
      if (score < bestScore - 1e-12) {
        bestScore = score;
        best = { rot, dir, rowResidPx, sideResidPx };
      }
    }
  }
  return best;
}

/** 수동 변과 자동 근변 코너의 이탈(px) — D10 판정 근거. 자동 코너가 없으면 null. */
function paintDeviationPx(manualQuad: PixelQuad, autoCorners: ReadonlyArray<{ x: number; y: number }>): number | null {
  if (!autoCorners.length) return null;
  let worst = 0;
  for (const c of autoCorners) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const m of manualQuad) nearest = Math.min(nearest, Math.hypot(m.x - c.x, m.y - c.y));
    if (nearest < 60) worst = Math.max(worst, nearest); // 대응이 성립하는 코너만 본다
  }
  return worst > 0 ? worst : null;
}

/**
 * 프리셋 1개 채점. 자동 quad ↔ 수동 슬롯 매칭은 기존 `MATCH_MIN_IOU` 규약을 재사용한다.
 *
 * ★ 매칭에 IoU 를 쓰는 것은 정답지 사용이다. 기하는 오염되지 않고 **귀속만** 정하므로 허용하되
 *   응답에 명시한다(설계 §3 말미). 산출된 quad 좌표는 이 단계에서 한 픽셀도 바뀌지 않는다.
 */
export function scorePreset(
  autoQuads: readonly BayQuad[],
  autoCorners: ReadonlyArray<{ x: number; y: number }>,
  manual: readonly PlaceRoiSpace[],
  imgW: number,
  imgH: number,
  key: string,
  camId: number,
  presetIdx: number,
  opts?: { minGradableBays?: number },
): PresetScore {
  const issues: string[] = [];
  const minGradable = opts?.minGradableBays ?? 3;
  const slots: SlotScore[] = [];
  let manualSlots = 0;

  for (const sp of manual) {
    if (EXCLUDED_SLOT_IDX.includes(sp.idx)) {
      slots.push({ slotIdx: sp.idx, iouVsManual: 0, paintDevPx: null, matched: false, degrade: DEGRADE.SLOT24 });
      issues.push(`slot${sp.idx}: 파일↔DB 소속 불일치 미해소 — 채점·적용 범위에서 제외(R8)`);
      continue;
    }
    const mq = toPixelQuad(sp, imgW, imgH);
    if (!mq) {
      slots.push({ slotIdx: sp.idx, iouVsManual: 0, paintDevPx: null, matched: false, degrade: DEGRADE.NON_QUAD });
      continue;
    }
    manualSlots++;
    const canon = canonicalizeQuad(mq) ?? mq;
    let iou = 0;
    for (const aq of autoQuads) {
      const v = quadIoU(aq.quad, canon);
      if (v > iou) iou = v;
    }
    const dev = paintDeviationPx(canon, autoCorners);
    const matched = iou >= MATCH_MIN_IOU;
    let degrade: string | null = null;
    if (matched && iou < 0.98 && dev != null && dev > 3) degrade = DEGRADE.ANCHOR_DEFECT;
    slots.push({ slotIdx: sp.idx, iouVsManual: iou, paintDevPx: dev, matched, degrade });
  }

  const scored = slots.filter((s) => s.degrade !== DEGRADE.SLOT24 && s.degrade !== DEGRADE.NON_QUAD);
  const ious = scored.map((s) => s.iouVsManual);
  const graded = manualSlots >= minGradable && autoQuads.length > 0;
  let gradeReason: string | null = null;
  if (manualSlots < minGradable) {
    gradeReason = `${DEGRADE.TOO_FEW_BAYS}(주차면 ${manualSlots}면 < ${minGradable} — 사영 1D 적합 자유도 0, 검증 불가)`;
  } else if (!autoQuads.length) {
    gradeReason = `${DEGRADE.NO_FRONT_LINE}(자동 quad 0개)`;
  }

  return {
    key,
    camId,
    presetIdx,
    autoQuads: autoQuads.length,
    manualSlots,
    slots,
    meanIoU: ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : null,
    minIoU: ious.length ? Math.min(...ious) : null,
    pass98: ious.filter((v) => v >= 0.98).length,
    graded,
    gradeReason,
    directionResolvedBy: 'convention',
    issues,
  };
}

/**
 * 전 프리셋 요약. `graded:false` 프리셋은 통과·평균 어디에도 넣지 않는다.
 *
 * ★ 집계에서 빼는 것은 **구조적 제외**(D8 4점 아님 · D9 슬롯24 소속 불일치)뿐이다.
 * `D10_ANCHOR_DEFECT` 는 **라벨이지 제외가 아니다** — 자동이 도색 위에 있고 수동이 벗어났다는
 * 진단일 뿐, 그 면의 IoU 는 여전히 유효한 측정값이다.
 * (구현자 실측 버그: D10 까지 빼자 1:1 평균 0.94021 인데 요약이 meanIoU 0 을 찍었다. 숫자를 숨기는 집계였다.)
 */
export function summarize(presets: readonly PresetScore[]): {
  gradedPresets: number;
  gradedSlots: number;
  pass98: number;
  meanIoU: number | null;
  minIoU: number | null;
} {
  const g = presets.filter((p) => p.graded);
  const all: number[] = [];
  const STRUCTURAL = new Set<string>([DEGRADE.NON_QUAD, DEGRADE.SLOT24]);
  for (const p of g) for (const s of p.slots) if (!s.degrade || !STRUCTURAL.has(s.degrade)) all.push(s.iouVsManual);
  return {
    gradedPresets: g.length,
    gradedSlots: all.length,
    pass98: all.filter((v) => v >= 0.98).length,
    meanIoU: all.length ? all.reduce((s, v) => s + v, 0) / all.length : null,
    minIoU: all.length ? Math.min(...all) : null,
  };
}
