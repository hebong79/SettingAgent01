// capture 모듈 내부 타입 (장기 관측·반복 수집 → SQLite 누적 → LLM 정밀 주차면).
// @parkagent/types(공유 계약: SetupArtifact/ParkingSlot/...)와 분리한다 — 공유 계약 오염 금지.
// 좌표는 모두 정규화(0~1), cam/preset/round 인덱스는 1-based.
//
// ★ DB 스키마 전면 개편(설계서 §1): 구 10테이블 → 신 6테이블(place_info/camera_info/
//   preset_pos/slot_setup/parking_evnt/parking_slot). 아래 Row/View 는 신 스키마 표면.
//   컬럼명은 md 기준 cam_id/preset_id(camIdx/presetIdx 아님).

import type { NormalizedPoint, NormalizedQuad } from '../domain/types.js';

/** 검출 박스 1건(정규화 좌표). Aggregator 입력의 평면 행(인메모리 누적 — DB 미저장). */
export interface DetectionRow {
  observationId: number;
  roundIdx: number;
  camIdx: number;
  presetIdx: number;
  kind: 'vehicle' | 'plate';
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
  /** plate 검출의 실제 OBB quad(방향 보존). vehicle 행·구DB 는 undefined. */
  quad?: NormalizedQuad;
}

/** 집계 결과 슬롯(결정형 산출). 좌표는 검출 멤버 중앙값(인메모리 — DB 미저장). */
export interface AggregatedSlot {
  presetKey: string; // `${camIdx}:${presetIdx}`
  clusterId: number; // 프리셋 내 1-based 클러스터 식별
  camIdx: number;
  presetIdx: number;
  x: number;
  y: number;
  w: number;
  h: number;
  support: number; // 클러스터 멤버(검출) 수
  occupancyRate: number; // 점유 관측 라운드 비율(0~1)
  plateX: number | null;
  plateY: number | null;
  plateW: number | null;
  plateH: number | null;
  /** 대표 번호판 OBB quad(방향 보존, 강건 합성). plate 부재/quad 부재 시 null. */
  plateQuad: NormalizedQuad | null;
  /** 슬롯 종합 신뢰도 0~1(§3.5). */
  confidence: number;
  /** vehicle center 공간 퍼짐(정규화 스칼라, MAD 기반 ≥0). */
  posSpread: number;
  /** 번호판 각도 분산(rad, circularMad). plate quad<2 → null. */
  angleSpread: number | null;
  status: 'candidate' | 'accepted' | 'rejected' | 'merged';
}

// ── 신 6테이블 Row/View (설계서 §1 DDL) ─────────────────────────────

/** place_info 행. 현재 place_id=1 고정(my_db_table §4). */
export interface PlaceInfoRow {
  placeId: number;
  placeName: string;
}

/**
 * camera_info 행(my_db_table §3 + 정규화 역변환 기준 img_w/img_h).
 * img_w/img_h 는 PtzCamRoi 픽셀↔정규화 0~1 역변환 기준(PtzCamRoi.json export 재생성에 필수).
 * password 는 평문 저장 — 노출 마스킹은 조회계층(dbRoutes) 담당.
 */
export interface CameraInfoRow {
  camId: number;
  camName: string | null;
  camUuid: string | null;
  url: string | null;
  userId: string | null;
  password: string | null;
  rtspUrl: string | null;
  camType: 'ptz' | 'static';
  camCompany: string | null;
  placeId: number;
  imgW: number | null;
  imgH: number | null;
  updatedAt: string | null;
}

/** preset_pos 행(프리셋 위치 PTZ = P1 존, camerapos.json datas). PTZ 는 REAL 3필드. */
export interface PresetPosRow {
  camId: number;
  presetId: number;
  sname: string | null;
  pan: number;
  tilt: number;
  zoom: number;
  updatedAt: string | null;
}

/**
 * slot_setup 저장 행 = floor_ROI + centering 병합(my_db_table §1+§5, 설계서 §1.1).
 * "전체 주차면 개수만큼, 슬롯당 1행"이 불변식(run_id 없음).
 * 가변정점(slotRoi/vpdBbox/lpdObb/occupyRange)은 **정규화 0~1** JSON TEXT 문자열.
 * pan/tilt/zoom 은 번호판중심 센터라이징 PTZ(REAL). centered 는 0/1. img1 은 상대경로.
 */
export interface SlotSetupRow {
  slotId: number; // 전역 슬롯번호 1..N (normalizeGlobalIdx 결과, PK)
  camId: number;
  presetId: number;
  presetSlotIdx: number | null; // 프리셋 내 순서(1-based). 미도출 시 null
  slotRoi: string; // 정규화 4점 폴리곤 JSON: [{x,y}×4] (NormalizedPoint[])
  vpdBbox: string | null; // 정규화 차량 bbox JSON: {x,y,w,h}. 미점유 null
  lpdObb: string | null; // 정규화 번호판 OBB JSON: [{x,y}×4]. 부재 null
  occupyRange: string | null; // 정규화 점유영역(발자국) 폴리곤 JSON. 부재 null
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
  centered: number; // 0/1
  img1: string | null; // 센터라이징 후 차량 스샷 상대경로. 부재 null
  slot3dFrontCenter: string | null; // 3D 육면체 앞면 중심 정규화 {x,y} JSON. 지면모델 없음/퇴화 시 null
  updatedAt: string | null;
}

/**
 * slot_setup 조회 결과(소비측 파싱 shape — 뷰어/REST). *_json → 객체/배열 복원.
 * presetKey(`${camId}:${presetId}`)는 파생필드(뷰어 오버레이 키 정합).
 */
export interface SlotSetupView {
  slotId: number;
  camId: number;
  presetId: number;
  presetSlotIdx: number | null;
  presetKey: string; // `${camId}:${presetId}`
  roi: NormalizedPoint[];
  vpd: { x: number; y: number; w: number; h: number } | null;
  lpd: NormalizedQuad | null;
  occupyRange: NormalizedPoint[] | null;
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
  centered: boolean;
  img1: string | null;
  slot3dFrontCenter: { x: number; y: number } | null; // 3D 육면체 앞면 중심(정규화). 부재 null
  updatedAt: string | null;
}

/**
 * upsertSlotCentering 입력(부분 갱신 — slot_id 키 UPDATE).
 * 센터라이징(PtzCalibrator)이 pan/tilt/zoom/centered/img1 만 갱신 — 타 슬롯 기하 불변.
 */
export interface SlotCenteringRow {
  slotId: number;
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
  centered: number; // 0/1
  img1: string | null;
  updatedAt: string;
}

/**
 * upsertSlotLpd 입력(부분 갱신 — slot_id 키 UPDATE).
 * 번호판 디스커버리(PlateDiscovery)가 lpd_obb 만 원본 좌표로 채운다 — 타 컬럼·타 슬롯 불변.
 * lpdObb 는 stringify5 로 직렬화된 정규화 OBB JSON TEXT(slot_setup TEXT writer 규약).
 */
export interface SlotLpdRow {
  slotId: number;
  lpdObb: string | null;
  /** 판 quad 로 결정형 생성한 점유영역(발자국) OBB — found 슬롯만 세팅, 미검출은 undefined(기존 값 보존). */
  occupyRange?: string | null;
  updatedAt: string;
}

/** 캡처 잡 상태머신 상태. */
export type CaptureState = 'idle' | 'running' | 'stopping' | 'finalizing' | 'done' | 'stopped' | 'error';

/** /capture/status 응답. */
export interface CaptureStatus {
  state: CaptureState;
  runId?: number;
  round: number;
  done: number;
  planned: number;
  /** 시작 시각(ISO8601). 경과 시간 표시용. */
  startedAt?: string;
  /** 종료 시각(ISO8601). 종료 후 총 소요 표시용. */
  endedAt?: string;
  /** 최근 체크포인트 자문(수렴/커버리지 표시용 문자열 배열). */
  latestAdvisory?: string[];
  /** floor ROI LLM 동작불가로 폴백 사용 중(UI 경고 메시지박스 표식). */
  llmFloorUnavailable?: boolean;
  /** 차량 점유율 LLM 동작불가(저장 생략) — UI 경고 표식. */
  llmOccupancyUnavailable?: boolean;
  /** 이번 run 의 VPD(차량) 검출 게이트(false=자동 경로 VPD 정지 · LPD 전용). 강등 위장 금지 노출. */
  vpdEnabled?: boolean;
  /** 이번 run 에 적용된 VPD 필터 모드(true=주차면 위 차량만). */
  vpdOnParkingOnly?: boolean;
  /** 필터로 제외된 차량 누적 대수(run 누적). */
  vpdFilteredOut?: number;
  /** 주차면 필터로 제외된 번호판 누적 수(run 누적). 강등/모드B 시 미노출. */
  lpdFilteredOut?: number;
  /** 주차면 폴리곤 부재로 모드B 강등 중(사유). 조용한 폴백 금지 — UI 가 항상 소스를 안다. */
  vpdOnPlaceDegraded?: string;
  /**
   * ★ 차량 육면체 **경량 인덱스**(프리셋키 → 숫자 4개). 전문은 `GET /capture/job-cuboids` 로 따로 가져간다.
   * status 는 초당 폴링되므로 육면체 전문(프리셋 7개 × 차량 10대 ≈ 수십 KB)을 매번 싣지 않는다.
   * 뷰어는 `round` 가 **바뀔 때만** 전문을 재요청한다.
   */
  cuboid?: Record<string, { round: number; cuboidCount: number; unmatched: number; segDegraded: boolean }>;
}
