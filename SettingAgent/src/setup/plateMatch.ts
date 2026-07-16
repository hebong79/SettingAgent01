import type { NormalizedQuad } from '../domain/types.js';
import type { PlateBox } from '../clients/LpdClient.js';
import type { BuiltSlot } from './RoiBuilder.js';
import { center, containsPoint, intersectionArea, quadBoundingRect } from '../domain/geometry.js';

/**
 * 앞쪽(번호판) 기대 위치 비율(>0.5=하단=앞). `detectPipeline.ts:113`·`detectMath.ts:113` 과 **동일 상수** —
 * 줌 재시도가 "이 차량의 번호판이 있을 자리"로 이미 쓰는 기대치다(번호판은 bbox 상단이 아니라 전면 하부에 맺힌다).
 * 값 복제인 이유: detectPipeline 이 이 모듈을 import 하므로 역방향 import 는 순환이 된다(신규 튜닝 파라미터 0).
 */
const FRONT_BIAS = 0.62;

/**
 * LPD 번호판 OBB 를 VPD 차량 슬롯(ROI)에 귀속시킨다.
 * 규칙: 번호판 중심(quad boundingRect)이 차량 ROI 안이면 후보쌍, 전체 후보쌍을
 *   **(겹침 내림차순 → frontAnchor 거리 오름차순 → 번호판 인덱스 → 슬롯 인덱스)** 로 정렬해
 *   **양쪽(번호판·슬롯) 모두 미배정일 때만** 확정하는 **전역 그리디 배정**.
 * (번호판당 슬롯 ≤1 · 슬롯당 번호판 ≤1) 반환: positionIdx → 번호판 OBB quad(방향 보존).
 *
 * ★ 전역 그리디인 이유(진단 08 §4-2): 번호판 bbox 가 두 차량 rect 에 **완전 포함**되면 교집합이 포화해
 *   **완전 동률**(판별력 0)이 된다. 구 구현("번호판별 argmax + 슬롯당 1개 캡")은 이때 인덱스 순으로 승자를
 *   정한 뒤, 그 승자가 이미 더 큰 번호판을 보유하면 **차선 차량으로 넘기지 않고 번호판을 통째로 폐기**했다.
 *   → 피해 차량이 미귀속이 되어 줌 재시도에 들어가 **이웃 차량의 번호판을 회수**하는 오귀속을 낳았다.
 *   그리디는 maximal matching 이라 양쪽 미배정인 후보쌍을 남기지 않는다(= 차선 폴백).
 * ★ tie-break 가 frontAnchor 거리인 이유: 포화 동률에서 겹침은 판별력이 0 이므로 기하 근거가 필요하다.
 *   판이 전면 하부에 맺힌다는 물리 사실이 rect 중심 대칭 가정을 이긴다(설계 09 §1 후보 5종 실측 비교).
 *   정렬 키는 전순서 — (pi,si) 최후 폴백이 결정성을 보장한다(실데이터에서 인덱스까지 가는 케이스 0).
 *
 * 셋업에서 "차량 검지(VPD) 후 그 차량의 번호판 위치(LPD OBB)"를 저장하기 위한 매칭(설계 반영).
 * 매칭 math 는 축정렬 boundingRect 로 수행하되 저장은 실 quad(방향 보존).
 */
export function matchPlatesToSlots(slots: BuiltSlot[], plates: PlateBox[]): Map<number, NormalizedQuad> {
  // 후보쌍 수집: 번호판 중심이 차량 ROI 내부인 (번호판, 슬롯) 전부.
  const pairs: { pi: number; si: number; slot: number; quad: NormalizedQuad; overlap: number; anchor: number }[] = [];
  plates.forEach((plate, pi) => {
    const pr = quadBoundingRect(plate.quad);
    const c = center(pr);
    slots.forEach((s, si) => {
      if (!containsPoint(s.roi, c.cx, c.cy)) return;
      // frontAnchor = 차량 rect 의 전면 하부 기대점. 거리 비교만 하므로 제곱거리(sqrt 불요).
      const ax = s.roi.x + s.roi.w / 2;
      const ay = s.roi.y + s.roi.h * FRONT_BIAS;
      pairs.push({
        pi,
        si,
        slot: s.positionIdx,
        quad: plate.quad,
        overlap: intersectionArea(s.roi, pr),
        anchor: (c.cx - ax) ** 2 + (c.cy - ay) ** 2,
      });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.anchor - b.anchor || a.pi - b.pi || a.si - b.si);

  const result = new Map<number, NormalizedQuad>();
  const usedPlate = new Set<number>();
  for (const p of pairs) {
    if (usedPlate.has(p.pi) || result.has(p.slot)) continue; // 양쪽 미배정일 때만 확정.
    // quad **참조** 그대로 담는다 — onPlaceFilter.ts:80-88·detectPipeline.ts:303 이 참조 동등성에 의존(기존 계약).
    result.set(p.slot, p.quad);
    usedPlate.add(p.pi);
  }
  return result;
}
