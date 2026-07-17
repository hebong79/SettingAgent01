import type { GlobalSlotIndex, ParkingSlot } from '../domain/types.js';

/** 전역 인덱싱 입력: 슬롯과 그 출처(프리셋·프리셋 내 위치). */
export interface IndexableSlot {
  slotId: string;
  camIdx: number;
  presetIdx: number;
  positionIdx: number; // 프리셋 내 위치(1-based)
}

/**
 * 전 카메라·전 프리셋의 슬롯을 정렬하여 전역 슬롯 인덱스를 부여한다 (할일 7, 아키텍처 §7).
 * 정렬 규칙(확정): camIdx ASC → presetIdx ASC → 프리셋 내 위치(positionIdx) ASC.
 * 동일 입력 → 동일 결과(결정적, 멱등).
 *
 * ★ slot_id 단일화(설계서 §2-5·§8.2): 본 규칙(cam→preset→프리셋내순서)은 `normalizeGlobalIdx`
 *   (placeRoi.ts — slot_setup.slot_id 부여, cam→preset→parking_spaces 배열순)와 **동일 컨벤션**이다.
 *   따라서 setup_artifact.globalIndex[].globalIdx == slot_setup.slot_id 가 성립한다(전제: PtzCamRoi.json 의
 *   parking_spaces 배열순이 프리셋 내 공간 순서(orderByPosition, 상→하·좌→우)와 일치 — 통상 페인팅 순서).
 *   이 정합으로 PtzCalibrator 의 정수 slot_id(=it.globalIdx) 센터라이징 UPDATE 가 올바른 slot_setup 행을 맞춘다.
 */
export function buildGlobalIndex(slots: IndexableSlot[]): GlobalSlotIndex[] {
  const sorted = [...slots].sort(
    (a, b) =>
      a.camIdx - b.camIdx ||
      a.presetIdx - b.presetIdx ||
      a.positionIdx - b.positionIdx ||
      a.slotId.localeCompare(b.slotId),
  );
  return sorted.map((s, i) => ({
    globalIdx: i + 1,
    slotId: s.slotId,
    camIdx: s.camIdx,
    presetIdx: s.presetIdx,
  }));
}

/** ParkingSlot 목록에서 전역 인덱스 조회용 맵(slotId → globalIdx). */
export function indexMap(global: GlobalSlotIndex[]): Map<string, number> {
  return new Map(global.map((g) => [g.slotId, g.globalIdx]));
}

/** 전역 인덱스에 포함된 slotId 들이 실제 슬롯 집합과 일치하는지 검증(누락/초과 탐지). */
export function validateCoverage(global: GlobalSlotIndex[], slots: ParkingSlot[]): {
  ok: boolean;
  missing: string[];
  extra: string[];
} {
  const indexed = new Set(global.map((g) => g.slotId));
  const actual = new Set(slots.map((s) => s.slotId));
  const missing = [...actual].filter((id) => !indexed.has(id));
  const extra = [...indexed].filter((id) => !actual.has(id));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}
