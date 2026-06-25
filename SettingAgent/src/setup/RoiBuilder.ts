import type { NormalizedRect, VehicleBox } from '../domain/types.js';
import { pad } from '../domain/geometry.js';
import { orderByPosition } from './ordering.js';

export interface RoiBuildOptions {
  minConfidence: number;
  roiPadding: number;
  yBandTolerance: number;
}

/** 프리셋 1개에서 산출된 슬롯 ROI(위치 순서대로). */
export interface BuiltSlot {
  /** 프리셋 내 위치 인덱스(1-based, 상→하/좌→우). */
  positionIdx: number;
  roi: NormalizedRect;
  confidence: number;
}

/**
 * VPD 차량 검출 bbox 목록으로부터 프리셋 내 슬롯 ROI 를 산출한다.
 * 시뮬레이터는 강체 배치이므로 검출 bbox 자체를 슬롯 ROI 기준으로 삼는다(설계서 §8-1).
 * - minConfidence 미만 검출은 제외.
 * - roiPadding 만큼 bbox 를 확장해 ROI 로 사용(차량보다 약간 넓게).
 * - 위치 정렬(상→하/좌→우)로 positionIdx(1-based) 부여.
 */
export function buildSlots(vehicles: VehicleBox[], opts: RoiBuildOptions): BuiltSlot[] {
  const filtered = vehicles.filter((v) => v.confidence >= opts.minConfidence);
  if (filtered.length === 0) return [];

  const order = orderByPosition(filtered.map((v) => v.rect), opts.yBandTolerance);
  return order.map((srcIdx, pos) => {
    const v = filtered[srcIdx];
    return {
      positionIdx: pos + 1,
      roi: pad(v.rect, opts.roiPadding),
      confidence: v.confidence,
    };
  });
}
