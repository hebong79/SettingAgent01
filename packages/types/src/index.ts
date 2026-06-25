// @parkagent/types — ParkAgent 3개 에이전트(Setting/Action/DM) 공유 도메인 타입 (아키텍처 §6).
// 이 패키지는 에이전트 간 "계약"이다. 변경 시 3개 에이전트 동시 영향 → 신중히 버전 관리.

/** 정규화 사각형 (좌표계 0~1). VPD 검출 bbox·주차면 ROI 표현. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 카메라: camIdx 는 1-based. Unity m_Cameras 와 매핑. */
export interface Camera {
  camIdx: number;
  name: string;
  enabled: boolean;
}

/** 프리셋: 실제 PTZ/FOV 는 Unity 소유. 식별자 + 매핑 메타 + 보관용 PTZ. */
export interface Preset {
  camIdx: number;
  presetIdx: number;
  label: string;
  /** 이 프리셋이 비추는 주차면 ID 목록(프리셋 내 위치 순서). */
  coveredSlotIds: string[];
  pan?: number;
  tilt?: number;
  zoom?: number;
}

/** 주차면(slot). 프리셋 이미지 좌표계 기준 ROI 를 프리셋 키별로 보관. */
export interface ParkingSlot {
  slotId: string;
  zone: string;
  /** key = `${camIdx}:${presetIdx}` → 해당 프리셋 이미지에서 이 면의 **차량 ROI**(VPD, 정규화). */
  roiByPreset: Record<string, NormalizedRect>;
  /**
   * key = `${camIdx}:${presetIdx}` → 이 면 차량의 **번호판 ROI**(LPD, 정규화).
   * 셋업 시 VPD 차량 ROI 안에서 LPD 로 번호판 위치를 찾아 보관한다(있을 때만).
   * ActionAgent 센터라이징의 prior(초기 조준점)로 활용 → 줌/이동 수렴을 가속.
   */
  plateRoiByPreset?: Record<string, NormalizedRect>;
}

/** 전역 슬롯 인덱스 매핑 (할일 7). 전 카메라·전 프리셋 정렬 결과. */
export interface GlobalSlotIndex {
  globalIdx: number; // 1-based
  slotId: string;
  camIdx: number;
  presetIdx: number;
}

/** Unity 캡처 결과(이미지 + PTZ 상태). */
export interface CapturedImage {
  camIdx: number;
  presetIdx: number;
  pan: number;
  tilt: number;
  zoom: number;
  imgName: string;
  jpg: Buffer;
}

/** VPD(da_vpd_api) 차량 검출 1건 (정규화 bbox). */
export interface VehicleBox {
  rect: NormalizedRect;
  confidence: number;
  cls: string;
}

/** 스캔 1건 식별 단위. */
export interface ScanTarget {
  camIdx: number;
  presetIdx: number;
}

/** 점유 상태 (Action/DM 공용). */
export type Occupancy = 'OCCUPIED' | 'EMPTY' | 'UNKNOWN';

/** 입출차 이벤트 (DM 공용). */
export interface ParkingEvent {
  eventId: string;
  slotId: string;
  type: 'ENTER' | 'EXIT';
  plate?: string;
  at: string; // ISO8601
  confidence: number;
  sourceImage?: string;
}
