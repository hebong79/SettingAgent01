// ★ det ↔ seg 정합 — 이번 작업의 **유일한 신규 알고리즘**(설계 §1). 순수 · IO 0 · LLM 0.
//
// 왜 필요한가: `vpd_det_v2_yolov11l.pt` 와 `vpd_seg_v2_yolov11l.pt` 는 **다른 모델**이다.
//   · 검출 개수가 다르다(det 5대 / seg 4대)  · 같은 차의 bbox 가 다르다(다른 NMS·다른 헤드)
//   · **순서가 다르다** — `bboxes[i]` ↔ `masks[i]` 짝은 **seg 응답 내부에서만** 유효하다.
// det 가 권위(점유 판정이 쓰는 배열)이므로, seg 마스크를 det 검출에 **붙이는 단계**가 반드시 필요하다.
//
// ⚠️ **IoU 는 이 알고리즘 자신의 점수 함수다** — "IoU 가 높으니 정합이 맞다"는 자기참조다.
//    정합 품질의 판정자는 IoU 가 아니라 독립 3종이다(육안 / 셔플 음성대조 / cls 일치율).
//    `_qa_assoc_iou.ts` 하네스가 그 셋을 잰다. 이 파일의 임계는 **그 실측에서만** 나온다(아래 참조).

import { iou } from '../domain/geometry.js';
import type { NormalizedRect } from '../domain/types.js';

/** 정합 파라미터. 임계는 실측(§5)에서 나온다 — 임의 상수 금지. */
export interface AssocOptions {
  minIou: number;
}

/** 정합된 쌍. `detIdx` = 권위(det) 인덱스 / `segIdx` = seg 응답 인덱스(마스크 되짚기 키). */
export interface AssocPair {
  detIdx: number;
  segIdx: number;
  iou: number;
}

export interface AssocResult {
  /** 1:1 보장. iou >= minIou. IoU 내림차순 그리디. */
  pairs: AssocPair[];
  /** 짝 못 찾은 det — **육면체 없이 통과**(점유 무영향). 조용히 사라지지 않는다. */
  unmatchedDet: number[];
  /** det 에 없는 seg — 육면체 생산에서는 무시(det 권위). 단 **occluder 로는 쓴다**(§1-5, 리더 승인). */
  unmatchedSeg: number[];
  /** ★ 진단: det 별 최고 IoU(임계 미만도 그대로 싣는다). 미정합 **사유**의 근거이자 실측의 원자료. */
  bestIouByDet: number[];
  /** ★ 진단: det 별 2위 IoU. `best − second` 가 작으면 모호 → 그리디 ≠ 최적 위험 신호(§1-3). */
  secondIouByDet: number[];
}

/**
 * det bbox(권위) ↔ seg rect 를 IoU 그리디로 **1:1** 정합한다.
 *
 * 1. 모든 (i,j) 의 `iou()` 계산 — **기존 `domain/geometry.ts:iou` 재사용. 신규 기하 0줄.**
 * 2. `iou > 0` 인 쌍만 IoU **내림차순** 정렬. 동점은 `(detIdx, segIdx)` 사전순 → **랜덤 시드 0, flaky 0**.
 * 3. 위에서부터 순회하며 det·seg 둘 다 미사용 && `iou >= minIou` → 채택.
 *    **1:1 은 "사용됨" 집합으로 구조적으로 보장**된다(임계와 무관).
 *
 * ★ 왜 헝가리안이 아닌가(CLAUDE.md §2): 그리디와 전역최적이 갈리는 것은 **한 seg 를 두 det 이
 *   비슷한 IoU 로 다투는 경우**뿐이다.
 *   ⚠️ 실측(§5-④, 3프레임 · det 30)에서 모호 쌍(best−second < 0.10)은 **0건이 아니라 2건**이었다
 *      (p2 det#7 갭 0.074 / p3 det#14 갭 0.070). 설계가 걸어둔 "0건이면 자명" 조건은 **성립하지 않았다.**
 *   → 그래서 자명성 논증에 기대지 않고 **직접 실측했다**: 하네스가 완전탐색 전역최적 배정을 계산해
 *      그리디와 대조 → **3/3 프레임 배정 완전 동일**. 즉 이 데이터에서 헝가리안은 **아무것도 바꾸지 않는다.**
 *   → 헝가리안을 **넣지 않는다**(측정 없는 복잡도 금지 — 리더 승인 2026-07-15).
 *   ★ **근거의 성격이 바뀌었다는 것을 정확히 기록한다**: 이것은 더 이상 "수학적으로 자명해서"가 **아니다**
 *      (그 조건은 실데이터에서 **거짓으로 반증됐다**). 근거는 **"이 데이터에서 실측했더니 같더라"** 뿐이다.
 *      ∴ 배정이 갈리는 프레임이 관측되면 근거가 즉시 사라진다 → **재검토**(임의 도입 금지, 리더에게 올린다).
 *
 * 복잡도 O(n·m log(nm)). n,m ≤ ~30 → 무시 가능.
 */
export function associateDetSeg(
  det: readonly NormalizedRect[],
  seg: readonly NormalizedRect[],
  opts: AssocOptions,
): AssocResult {
  const bestIouByDet = new Array<number>(det.length).fill(0);
  const secondIouByDet = new Array<number>(det.length).fill(0);
  const cand: AssocPair[] = [];

  for (let i = 0; i < det.length; i++) {
    for (let j = 0; j < seg.length; j++) {
      const v = iou(det[i], seg[j]);
      if (v <= 0) continue;
      cand.push({ detIdx: i, segIdx: j, iou: v });
      if (v > bestIouByDet[i]) {
        secondIouByDet[i] = bestIouByDet[i];
        bestIouByDet[i] = v;
      } else if (v > secondIouByDet[i]) {
        secondIouByDet[i] = v;
      }
    }
  }

  // 동점 결정성: IoU 내림차순 → detIdx → segIdx 사전순(같은 입력이면 항상 같은 출력).
  cand.sort((a, b) => b.iou - a.iou || a.detIdx - b.detIdx || a.segIdx - b.segIdx);

  const usedDet = new Set<number>();
  const usedSeg = new Set<number>();
  const pairs: AssocPair[] = [];
  for (const c of cand) {
    if (c.iou < opts.minIou) continue;
    if (usedDet.has(c.detIdx) || usedSeg.has(c.segIdx)) continue;
    usedDet.add(c.detIdx);
    usedSeg.add(c.segIdx);
    pairs.push(c);
  }

  const unmatchedDet: number[] = [];
  for (let i = 0; i < det.length; i++) if (!usedDet.has(i)) unmatchedDet.push(i);
  const unmatchedSeg: number[] = [];
  for (let j = 0; j < seg.length; j++) if (!usedSeg.has(j)) unmatchedSeg.push(j);

  return { pairs, unmatchedDet, unmatchedSeg, bestIouByDet, secondIouByDet };
}

/**
 * ★ 정합 임계 — **실측에서 나온 값이다**(임의 상수 아님. 임계는 이 한 곳에만 둔다).
 *
 * 실측(`_qa_assoc_iou.ts` · 실프레임 3장 `data/refframes/cam1_p{1,2,3}.jpg` · 라이브 VPD det+seg · det 30 / seg 28):
 *
 *   **결정 불변 구간에서 골랐다.** τ=0 그리디가 채택한 27쌍의 IoU 최솟값 = **0.471**,
 *   미정합 det 의 bestIoU 최댓값 = **0.428**(그나마 1:1 경합 패배라 어떤 τ 로도 안 붙는다).
 *   → τ ∈ **[0.308, 0.471)** 구간에서 산출이 **완전히 동일**하다(임계 스윕 실측: τ=0.1~0.4 에서 matched 27 고정,
 *      τ=0.5 부터 26 으로 떨어진다). **0.4** 는 그 구간 안쪽이다.
 *
 *   ⚠️ **정직한 한계 — 알려진 취약성(리더 승인 시 명시 조건)**: 설계가 기대한 "넓은 이중분포 밸리"는
 *      **나오지 않았다.** 위 구간의 폭은 0.16 이고 **위쪽 마진(0.471까지)은 0.07 뿐**이다.
 *      참 매칭인데 IoU 0.45 근처인 차가 나오면 τ=0.4 가 그것을 떨군다
 *      (떨궈도 **육면체만 안 그려질 뿐 점유는 무영향** — 강등이지 오염이 아니다).
 *      ★ **0.35 로 낮춰도 이 데이터에서는 산출이 완전히 동일하다**(하단 마진만 깎을 뿐) → 낮출 이유가 없다.
 *
 *   ★ **중간대 5건은 "우연 매칭"이 아니다** — 전부 **식별 가능한 병리**다:
 *      마스크 파편화·병합, 그리고 **V-1 저신뢰 거대 병합 박스**(실측 conf 0.39, 프레임 절반 크기).
 *      즉 밸리가 안 파인 원인은 IoU 의 변별력 부족이 아니라 **seg 마스크 자체의 병리**다.
 *      이들은 전부 **미정합으로 강등**되어 육면체만 안 그려진다(점유 판정 경로 무접촉).
 *
 *   🔴 **후속 과제(F-4)**: 이 임계는 **Unity 시뮬 · cam1 · preset1~3** 에서만 측정됐다.
 *      **실카메라 / 다른 주차장에서는 반드시 재측정**하라(마스크 병리 분포가 달라지면 밸리도 달라진다).
 *      재측정 절차는 `_qa_assoc_iou.ts` 를 그대로 돌리면 된다(히스토그램 · 결정 불변 구간 · J2a/J2b/J3 자동 산출).
 *
 *   대신 임계의 정당성은 **변별력 실측**이 받친다(아래 J2b).
 *
 *   변별력(IoU 자기참조가 아닌 독립 대조):
 *     · J2b 강제 오배정: 참 쌍 IoU 평균 **0.906** vs 오배정 IoU 평균 **0.040**(τ 초과 1/27) → 변별력 있음.
 *     · J2a 교차프레임: 동일프레임 matched 27 → 다른 프레임 seg 로 정합 시 **3** 으로 붕괴.
 *     · J3 cls 일치율 **27/27 = 100%**(기하와 독립 신호).
 * 측정표 전문은 `_workspace/02_developer_changes.md` §5.
 */
export const DEFAULT_ASSOC_OPTIONS: AssocOptions = { minIou: 0.4 };
