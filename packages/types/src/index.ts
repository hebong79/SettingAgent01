// @parkagent/types — ParkAgent 3개 에이전트(Setting/Action/DM) 공유 도메인 타입 (아키텍처 §6).
// 이 패키지는 에이전트 간 "계약"이다. 변경 시 3개 에이전트 동시 영향 → 신중히 버전 관리.

/** 정규화 사각형 (좌표계 0~1). VPD 검출 bbox·주차면 ROI 표현. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 정규화 점 (좌표계 0~1). NormalizedQuad 의 모서리. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/**
 * 정규화 4점 사변형 (좌표계 0~1). 차량 바닥 점유 영역(원근 투영 footprint).
 * 모서리 순서 규약: [0]=앞왼(frontLeft), [1]=앞오(frontRight), [2]=뒤오(rearRight), [3]=뒤왼(rearLeft).
 * "앞"=카메라에 가까운 변(이미지 하단 쪽), 시계방향.
 */
export type NormalizedQuad = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

/**
 * 정규화 가변 다각형 (좌표계 0~1, 런타임 불변식 4~10점, 볼록·시계방향). 차량 바닥 점유 footprint.
 * 4점 특수화는 [FL,FR,RR,RL] 규약과 호환 — NormalizedQuad(4점 튜플)는 구조적으로 이 타입에 할당 가능(하위호환).
 */
export type NormalizedPolygon = NormalizedPoint[];

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
   * key = `${camIdx}:${presetIdx}` → 이 면 차량의 **번호판 ROI**(LPD OBB, 정규화 4점 사변형).
   * 셋업 시 VPD 차량 ROI 안에서 LPD 로 번호판 OBB(회전 4점)를 찾아 보관한다(있을 때만).
   * 점 순서 규약 = ultralytics OBB(TL→TR→BR→BL). 구데이터(rect)는 로드 시 rectToQuad 승격.
   * ActionAgent 센터라이징의 prior(초기 조준점)로 활용 → 줌/이동 수렴을 가속(quadBoundingRect 유도).
   */
  plateRoiByPreset?: Record<string, NormalizedQuad>;
  /**
   * key = `${camIdx}:${presetIdx}` → 이 면 차량의 **바닥 점유 영역**(LLM 비전 추론, 정규화 가변 다각형 4~10점).
   * roiByPreset(축정렬 차량 bbox)과 별개·가산. 미산출 시 키 없음.
   * 구데이터(4점 NormalizedQuad)는 구조적 호환으로 그대로 유효.
   */
  floorRoiByPreset?: Record<string, NormalizedPolygon>;
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
