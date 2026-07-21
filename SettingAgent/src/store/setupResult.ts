import type { SlotSetupView } from '../capture/types.js';
import type { NormalizedPoint } from '../domain/types.js';

/**
 * 최종 결과물 `save/setup_result.json` 의 고정 이름(확장자 제외 — SaveStore.saveSnapshot 규약).
 * 타임스탬프 아카이브(`Setup_YYYYMMDD_HHMMSS`)와 달리 **항상 같은 이름으로 덮어써** 소비측이 고정 경로를 읽는다.
 */
export const SETUP_RESULT_NAME = 'setup_result';

/** setup_result.json 슬롯 1건(data/setup_result_sample.json 스키마). 키 표기는 샘플 그대로 snake_case 혼용. */
export interface SetupResultSlot {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx: number | null;
  /** 주차면 바닥 폴리곤(정규화) — slot_setup.slot_roi. */
  floor_roi: NormalizedPoint[];
  /** 점유영역(발자국) 폴리곤(정규화) — slot_setup.occupy_range. 미도출 슬롯은 null(0 위장 금지). */
  occupy_roi: NormalizedPoint[] | null;
  /** 센터라이징 PTZ — pan/tilt/zoom 셋이 모두 있을 때만. 미센터라이징 슬롯은 null. */
  centering: { pan: number; tilt: number; zoom: number } | null;
}

/** setup_result.json 산출물. */
export interface SetupResult {
  slots: SetupResultSlot[];
}

/**
 * slot_setup 뷰(정본) → setup_result.json 페이로드 변환(순수 함수).
 * 행 순서는 소스(getSlotSetup: cam_id, preset_id, preset_slotidx 정렬)를 그대로 보존한다.
 */
export function buildSetupResult(slots: SlotSetupView[]): SetupResult {
  return {
    slots: slots.map((s) => ({
      slotId: s.slotId,
      camId: s.camId,
      presetId: s.presetId,
      presetSlotIdx: s.presetSlotIdx,
      floor_roi: s.roi ?? [],
      occupy_roi: s.occupyRange ?? null,
      centering:
        s.pan != null && s.tilt != null && s.zoom != null
          ? { pan: s.pan, tilt: s.tilt, zoom: s.zoom }
          : null,
    })),
  };
}
