import type { SlotSetupView } from '../capture/types.js';
import type { NormalizedPoint } from '../domain/types.js';
import { setupSaveName, type SaveStore } from './SaveStore.js';
import { logger } from '../util/logger.js';

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

/** writeSetupResultFiles 결과. 실패한 쪽은 null(기록 안 됨) — 위장 성공 금지. */
export interface SetupResultWrite {
  result: SetupResult;
  /** 타임스탬프 이력본 파일명(save/Setup_*.json). 실패 시 null. */
  archive: string | null;
  /** 고정본 파일명(save/setup_result.json). 실패 시 null. */
  fixed: string | null;
}

/**
 * 최종 결과물 기록(**동일 내용 2벌**) — 센터라이징 잡 done 경로와 수동 'result 파일 생성' 버튼의 공통 진입점.
 *   1) save/Setup_YYYYMMDD_HHMMSS.json — 타임스탬프 이력본(덮어쓰기 없음)
 *   2) save/setup_result.json — 소비측이 읽는 고정 경로(매 실행 덮어쓰기)
 * payload = buildSetupResult(slot_setup 정본) 1회 변환 → 2벌 동일 내용 보장.
 * 두 기록은 각자 best-effort(한쪽 실패가 다른쪽을 막지 않음) — 호출측 잡·정본을 죽이지 않는다.
 */
export function writeSetupResultFiles(
  slots: SlotSetupView[],
  saveStore: Pick<SaveStore, 'saveSnapshot'>, // 호출측(PtzCalibrator)이 좁힌 타입 그대로 받는다.
  now: Date = new Date(),
): SetupResultWrite {
  const result = buildSetupResult(slots);
  let archive: string | null = null;
  let fixed: string | null = null;
  try {
    archive = saveStore.saveSnapshot(setupSaveName(now), result);
  } catch (e) {
    logger.warn({ err: e }, 'Setup_* 이력본 저장 실패(격리 — DB 정본은 무관)');
  }
  try {
    fixed = saveStore.saveSnapshot(SETUP_RESULT_NAME, result);
  } catch (e) {
    logger.warn({ err: e }, 'setup_result.json 저장 실패(격리 — DB 정본은 무관)');
  }
  return { result, archive, fixed };
}
