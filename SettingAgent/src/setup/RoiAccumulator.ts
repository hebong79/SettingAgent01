import type { NormalizedRect, VehicleBox } from '../domain/types.js';
import { center, pad } from '../domain/geometry.js';
import { orderByPosition } from './ordering.js';
import type { BuiltSlot } from './RoiBuilder.js';

export interface AccumOptions {
  minConfidence: number;
  roiPadding: number;
  yBandTolerance: number;
  /** 클러스터 병합 거리 임계(중심 간 유클리드 거리, 정규화). */
  clusterDist: number;
  /** 슬롯으로 인정할 최소 관측 횟수. */
  minSupport: number;
}

interface Cluster {
  rects: NormalizedRect[];
  sumConf: number;
}

/** 두 중심점 간 유클리드 거리. */
function dist(a: NormalizedRect, b: NormalizedRect): number {
  const ca = center(a);
  const cb = center(b);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
}

/** 멤버 사각형들의 평균 사각형. */
function meanRect(rects: NormalizedRect[]): NormalizedRect {
  const n = rects.length;
  const s = rects.reduce(
    (acc, r) => ({ x: acc.x + r.x, y: acc.y + r.y, w: acc.w + r.w, h: acc.h + r.h }),
    { x: 0, y: 0, w: 0, h: 0 },
  );
  return { x: s.x / n, y: s.y / n, w: s.w / n, h: s.h / n };
}

/**
 * 여러 프레임의 VPD 검출을 누적·클러스터링하여 안정적 슬롯 ROI 를 산출한다.
 * (실 PTZ 자동 ROI: 검출 누적 + 클러스터링. 설계서 §8-1-1)
 *
 * - 모든 프레임의 bbox 를 중심 거리 기준 그리디 클러스터링(clusterDist 이내면 같은 슬롯).
 * - minSupport 미만(전이성/오검지) 클러스터는 제외.
 * - 대표 ROI = 멤버 평균 사각형 + 패딩. 위치 순서(상→하/좌→우)로 positionIdx 부여.
 */
export function buildSlotsAccumulated(frames: VehicleBox[][], opts: AccumOptions): BuiltSlot[] {
  const clusters: Cluster[] = [];

  for (const frame of frames) {
    for (const v of frame) {
      if (v.confidence < opts.minConfidence) continue;
      // 가장 가까운 클러스터 탐색(임계 이내).
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        const d = dist(meanRect(clusters[i].rects), v.rect);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0 && bestD <= opts.clusterDist) {
        clusters[best].rects.push(v.rect);
        clusters[best].sumConf += v.confidence;
      } else {
        clusters.push({ rects: [v.rect], sumConf: v.confidence });
      }
    }
  }

  const stable = clusters.filter((c) => c.rects.length >= opts.minSupport);
  if (stable.length === 0) return [];

  const reps = stable.map((c) => ({ roi: meanRect(c.rects), conf: c.sumConf / c.rects.length }));
  const order = orderByPosition(reps.map((r) => r.roi), opts.yBandTolerance);
  return order.map((srcIdx, pos) => ({
    positionIdx: pos + 1,
    roi: pad(reps[srcIdx].roi, opts.roiPadding),
    confidence: reps[srcIdx].conf,
  }));
}
