import type { NormalizedRect } from '../domain/types.js';
import type { PlateBox } from '../clients/LpdClient.js';
import type { BuiltSlot } from './RoiBuilder.js';
import { center, containsPoint, intersectionArea } from '../domain/geometry.js';

/**
 * LPD 번호판 bbox 를 VPD 차량 슬롯(ROI)에 귀속시킨다.
 * 규칙: 번호판 중심이 차량 ROI 안에 있으면 후보, 그중 겹침(교집합) 최대 ROI 에 귀속.
 * (한 차량에 번호판 1개) 반환: positionIdx → 번호판 ROI.
 *
 * 셋업에서 "차량 검지(VPD) 후 그 차량의 번호판 위치(LPD)"를 저장하기 위한 매칭(설계 반영).
 */
export function matchPlatesToSlots(slots: BuiltSlot[], plates: PlateBox[]): Map<number, NormalizedRect> {
  const result = new Map<number, NormalizedRect>();
  // 슬롯별 최적 번호판(겹침 최대)을 1개만 저장.
  const bestArea = new Map<number, number>();

  for (const plate of plates) {
    const c = center(plate.rect);
    let bestSlot = -1;
    let bestOverlap = 0;
    for (const s of slots) {
      // 1차: 번호판 중심이 차량 ROI 내부.
      if (!containsPoint(s.roi, c.cx, c.cy)) continue;
      const overlap = intersectionArea(s.roi, plate.rect);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSlot = s.positionIdx;
      }
    }
    if (bestSlot < 0) continue;
    // 같은 슬롯에 번호판이 여럿이면 겹침 큰 것 유지.
    if (bestOverlap > (bestArea.get(bestSlot) ?? 0)) {
      bestArea.set(bestSlot, bestOverlap);
      result.set(bestSlot, plate.rect);
    }
  }
  return result;
}
