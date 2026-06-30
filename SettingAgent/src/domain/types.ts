// SettingAgent 도메인 타입.
// 공유 계약은 @parkagent/types 에서 재수출(기존 `../domain/types.js` import 경로 유지 — 외과적 변경).
export type {
  NormalizedRect,
  NormalizedPoint,
  NormalizedQuad,
  Camera,
  Preset,
  ParkingSlot,
  GlobalSlotIndex,
  CapturedImage,
  VehicleBox,
  ScanTarget,
  Occupancy,
  ParkingEvent,
} from '@parkagent/types';

import type { Preset, ParkingSlot, GlobalSlotIndex } from '@parkagent/types';

/** 셋업 산출물(Repository 영속화 단위). SettingAgent 고유 — 공유 타입의 조합. */
export interface SetupArtifact {
  presets: Preset[];
  slots: ParkingSlot[];
  globalIndex: GlobalSlotIndex[];
  createdAt: string; // ISO8601
  /** preset 파일 기대 슬롯 수와 검출 결과가 다른 경우의 경고(교차검증). */
  warnings?: string[];
  /** 전략 C 게이트3 의 한글 설치 리포트(LLM 활성 시). */
  report?: string;
}
