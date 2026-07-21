// 캘리브레이션(주차면별 번호판 중심정렬·줌 PTZ) 로컬 타입.
// SettingAgent 초기 셋팅 산출물 — @parkagent/types 승격 안 함(설계서 §0-A, 영향도 §7).
// 좌표는 모두 정규화(0~1), cam/preset 인덱스는 1-based, PTZ pan/tilt 는 도(°)·zoom 은 배율(1~36).

import type { NormalizedRect, NormalizedPoint, NormalizedQuad } from '../domain/types.js';

/** 캘리브레이션 대상(plateRoiByPreset 펼침 1건). */
export interface PlateTarget {
  camIdx: number;
  presetIdx: number;
  slotId: string;
  /** setup_artifact.globalIndex 역참조(없으면 null). */
  globalIdx: number | null;
  /** 대상 번호판 prior ROI(정규화) — 다수 번호판 중 최근접 선택 기준. */
  plateRoi: NormalizedRect;
  /**
   * 프리셋 내 슬롯 순서(1-based, presets[].coveredSlotIds 순서). DB centering_slot.preset_slotidx 소스.
   * 프리셋 부재·coveredSlotIds 미포함 시 null(0/−1 발명 금지).
   */
  presetSlotIdx: number | null;
}

/** PTZ 상태(명령값 추적 — 시뮬 응답 echo 신뢰 불가, 설계서 ★). */
export interface Ptz {
  pan: number;
  tilt: number;
  zoom: number;
}

/** slot_ptz.json 항목 1건. */
export interface SlotPtzItem {
  camIdx: number;
  presetIdx: number;
  slotId: string;
  globalIdx: number | null;
  ptz: Ptz;
  /** 최종 번호판 정규화 가로폭. */
  plateWidth: number;
  /** pan/tilt 중심 수렴 여부. */
  centered: boolean;
  /** zoom 폭 수렴 여부. */
  converged: boolean;
  /** 스킵·미수렴 사유(정상이면 생략). */
  reason?: string;
}

/** slot_ptz.json 산출물. */
export interface SlotPtzArtifact {
  createdAt: string; // ISO8601
  items: SlotPtzItem[];
}

// ── 번호판 탐색·확대반복·역계산(plate discovery, 설계서 §5) ─────────────────
// 슬롯 앞면중심(slot3d_front_center)을 조준점으로 디지털 크롭-줌 탐색한 결과. 센터라이징의 상류 별개 잡.

/** 디스커버리 대상 1건(slot_setup 펼침, slot3d_front_center 보유분 — 검출 무관). */
export interface DiscoveryTarget {
  camIdx: number;
  presetIdx: number;
  slotId: string;
  /** setup_artifact.globalIndex(=정수 slot_id) — DB UPDATE 키. 없으면 null(DB 스킵). */
  globalIdx: number | null;
  /** 조준점 = 육면체 앞면중심(정규화). 부재면 no_anchor. */
  anchor: NormalizedPoint | null;
  /** 프리셋 내 슬롯 순서(1-based). DB preset_slotidx 소스. 미도출 null. */
  presetSlotIdx: number | null;
}

/** 슬롯별 탐색 결과 1건(설계서 §5-1). lpdOrig = 원본(프리셋) 프레임 정규화 LPD OBB. */
export interface PlateDiscoveryItem {
  camIdx: number;
  presetIdx: number;
  slotId: string;
  globalIdx: number | null;
  found: boolean;
  /** 원본 프레임 좌표계 LPD OBB(정규화 4점). 못 찾으면 null. */
  lpdOrig: NormalizedQuad | null;
  tier: 'full' | 'crop' | 'optical';
  step: number; // full=0, crop=1..maxSteps(격자 인덱스)
  cropWindow?: NormalizedRect; // crop tier 만(감사·재현용)
  ptz?: Ptz; // optical tier 만(후속)
  confidence: number;
  reason?: 'no_anchor' | 'no_plate' | 'needs_optical';
}

/** plate_discovery.json 산출물(설계서 §5-1). */
export interface PlateDiscoveryArtifact {
  createdAt: string; // ISO8601
  items: PlateDiscoveryItem[];
}

/** 디스커버리 잡 상태머신 상태. */
export type DiscoverState = 'idle' | 'running' | 'done' | 'error';

/** /discover/status 응답. */
export interface DiscoverStatus {
  state: DiscoverState;
  done: number;
  total: number;
  found: number;
  current?: { slotId: string };
  startedAt?: string;
  endedAt?: string;
}

/** 캘리브레이션 잡 상태머신 상태. */
export type CalibrateState = 'idle' | 'running' | 'done' | 'error';

/** /calibrate/status 응답. */
export interface CalibrateStatus {
  state: CalibrateState;
  done: number;
  total: number;
  /** 현재 처리 중 슬롯. */
  current?: { slotId: string };
  startedAt?: string;
  endedAt?: string;
}
