// ★ 18회차 신규 — **채점 3분리**(순수 · IO 0). 재현율 / 정밀도 / 매칭 면 IoU.
//
// 왜 필요한가: 17회차까지의 모든 수치는 "면이 몇 개인지 알려준 상태"에서, 그리고 "수동 정본에 있는 면만"
// 채점한 값이다. 마스터 목표 ①("개수를 모른 채 보이는 주차면을 **모두**")은 그 지표로는 **잴 수 없다**.
// 분모를 씬 진값으로 바꾸면 세 질문이 분리된다:
//
//   재현율   = 씬에 실제로 보이는 면 중 몇 개를 찾았나      ← 목표 ①
//   정밀도   = 찾아낸 것 중 몇 개가 진짜 면인가             ← 다중 행의 대가
//   매칭 IoU = 찾은 면이 얼마나 정확한가                    ← 목표 ②
//
// 세 값은 서로 다른 축이며 하나로 뭉개면 안 된다. IoU 는 `quadIoU` 재사용(R4) — 신규 IoU 0줄.

import { quadIoU } from './autoRoiPlan.js';
import type { TruthFace } from './sceneTruth.js';
import type { PixelQuad } from './types.js';

/** 정답 면 1건 + 그 면이 **원리적으로 검출 가능한가**. */
export interface TruthEntry {
  face: TruthFace;
  quad: PixelQuad;
  /**
   * 근변 도색 지지가 실제로 존재하는가.
   *
   * ★ 이 구분이 없으면 "차량이 도색을 덮어 원리적으로 못 찾은 면"과 "알고리즘이 못 찾은 면"이
   *   한 숫자에 뭉개진다. 산출법은 정답 quad 에 기존 `quadPaintSupport` 를 적용하는 것이다
   *   (정답지를 쓰지만 **채점 모듈 안**이므로 R1 위반이 아니다).
   */
  detectable: boolean;
}

export interface DetectionScore {
  /** 기하 가시 정답 면 수(재현율 분모). */
  truthTotal: number;
  /** 그 중 근변 도색 지지가 실제로 존재하는 면 수(가림 보정 분모). */
  truthDetectable: number;
  /** 산출 quad 수(정밀도 분모). */
  detected: number;
  matched: number;
  recall: number;
  recallDetectable: number;
  precision: number;
  /** 매칭된 면만의 평균 IoU. 매칭 0건 → null. */
  meanIoU: number | null;
  minIoU: number | null;
  /** IoU ≥ 0.95 인 매칭 면 수 — 마스터 목표 ②. */
  pass95: number;
  /** IoU ≥ 0.98 인 매칭 면 수(기존 기준 병기). */
  pass98: number;
  /** 미검출 면 — 무엇을 놓쳤는지 목록으로 남긴다. */
  missed: Array<{ rowIdx: number; faceIdx: number; detectable: boolean }>;
  /** 어떤 정답과도 매칭되지 않은 산출 quad 의 인덱스(오검출). */
  spurious: number[];
  /** 매칭 쌍 상세(진단). */
  pairs: Array<{ rowIdx: number; faceIdx: number; detIdx: number; iou: number }>;
}

/**
 * 산출 quad ↔ 정답 면 채점.
 *
 * 매칭은 **IoU 내림차순 그리디 1:1** 이다 — 한 정답에 한 검출, 한 검출에 한 정답.
 * 임계 미만 쌍은 아예 후보에 넣지 않으므로 "억지로 맞춘 매칭"이 생기지 않는다.
 */
export function scoreDetection(
  detected: readonly PixelQuad[],
  truth: readonly TruthEntry[],
  matchMinIoU: number,
): DetectionScore {
  const cands: Array<{ t: number; d: number; iou: number }> = [];
  for (let ti = 0; ti < truth.length; ti++) {
    for (let di = 0; di < detected.length; di++) {
      const iou = quadIoU(truth[ti].quad, detected[di]);
      if (iou >= matchMinIoU) cands.push({ t: ti, d: di, iou });
    }
  }
  // 동점은 (정답 인덱스, 검출 인덱스) 오름차순으로 고정한다 — 난수 0, 순회 순서 의존 0(R2).
  cands.sort((a, b) => b.iou - a.iou || a.t - b.t || a.d - b.d);
  const usedT = new Set<number>();
  const usedD = new Set<number>();
  const pairs: DetectionScore['pairs'] = [];
  for (const c of cands) {
    if (usedT.has(c.t) || usedD.has(c.d)) continue;
    usedT.add(c.t);
    usedD.add(c.d);
    pairs.push({ rowIdx: truth[c.t].face.rowIdx, faceIdx: truth[c.t].face.faceIdx, detIdx: c.d, iou: c.iou });
  }
  pairs.sort((a, b) => a.rowIdx - b.rowIdx || a.faceIdx - b.faceIdx);

  const ious = pairs.map((p) => p.iou);
  const truthDetectable = truth.filter((t) => t.detectable).length;
  const missed: DetectionScore['missed'] = [];
  for (let ti = 0; ti < truth.length; ti++) {
    if (!usedT.has(ti)) missed.push({ rowIdx: truth[ti].face.rowIdx, faceIdx: truth[ti].face.faceIdx, detectable: truth[ti].detectable });
  }
  const spurious: number[] = [];
  for (let di = 0; di < detected.length; di++) if (!usedD.has(di)) spurious.push(di);
  let matchedDetectable = 0;
  for (const ti of usedT) if (truth[ti].detectable) matchedDetectable++;

  return {
    truthTotal: truth.length,
    truthDetectable,
    detected: detected.length,
    matched: pairs.length,
    recall: truth.length ? pairs.length / truth.length : 0,
    recallDetectable: truthDetectable ? matchedDetectable / truthDetectable : 0,
    precision: detected.length ? pairs.length / detected.length : 0,
    meanIoU: ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : null,
    minIoU: ious.length ? Math.min(...ious) : null,
    pass95: ious.filter((v) => v >= 0.95).length,
    pass98: ious.filter((v) => v >= 0.98).length,
    missed,
    spurious,
    pairs,
  };
}

/** 여러 프리셋 점수의 합산(면 단위 — 프리셋 평균이 아니라 **면 수 기준**). */
export function sumScores(scores: readonly DetectionScore[]): DetectionScore {
  const acc = scores.reduce(
    (s, x) => {
      s.truthTotal += x.truthTotal;
      s.truthDetectable += x.truthDetectable;
      s.detected += x.detected;
      s.matched += x.matched;
      s.pass95 += x.pass95;
      s.pass98 += x.pass98;
      s.missed.push(...x.missed);
      s.pairs.push(...x.pairs);
      return s;
    },
    { truthTotal: 0, truthDetectable: 0, detected: 0, matched: 0, pass95: 0, pass98: 0, missed: [] as DetectionScore['missed'], pairs: [] as DetectionScore['pairs'] },
  );
  const ious = acc.pairs.map((p) => p.iou);
  const detMatched = scores.reduce((s, x) => s + Math.round(x.recallDetectable * x.truthDetectable), 0);
  return {
    ...acc,
    recall: acc.truthTotal ? acc.matched / acc.truthTotal : 0,
    recallDetectable: acc.truthDetectable ? detMatched / acc.truthDetectable : 0,
    precision: acc.detected ? acc.matched / acc.detected : 0,
    meanIoU: ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : null,
    minIoU: ious.length ? Math.min(...ious) : null,
    spurious: [],
  };
}
