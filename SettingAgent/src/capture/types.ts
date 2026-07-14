// capture 모듈 내부 타입 (장기 관측·반복 수집 → SQLite 누적 → LLM 정밀 주차면).
// @parkagent/types(공유 계약: SetupArtifact/ParkingSlot/...)와 분리한다 — 공유 계약 오염 금지.
// 좌표는 모두 정규화(0~1), cam/preset/round 인덱스는 1-based.

import type { NormalizedPoint, NormalizedQuad } from '../domain/types.js';

/** 캡처 잡 1회(런)의 메타 행. */
export interface CaptureRunRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  plannedCount: number;
  doneCount: number;
  intervalMs: number;
  status: 'running' | 'stopped' | 'done' | 'error';
  stopReason: 'count' | 'manual' | 'error' | null;
}

/** 라운드·프리셋 단위 관측(프레임 1장). */
export interface ObservationRow {
  id: number;
  runId: number;
  roundIdx: number;
  camIdx: number;
  presetIdx: number;
  capturedAt: string;
  pan: number;
  tilt: number;
  zoom: number;
  imgName: string;
}

/** 검출 박스 1건(정규화 좌표). Aggregator 입력의 평면 행. */
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

/** 집계 결과 슬롯(결정형 산출). 좌표는 검출 멤버 중앙값. */
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

/**
 * 파일 바닥ROI(PtzCamRoi.json) 기준 주차면 저장 행(finalize 조립 산출, §06 H1/H4).
 * *_json 은 SQLite TEXT 컬럼에 문자열로 저장(nullable). occupied 는 0/1.
 */
export interface ParkingSlotRow {
  camIdx: number;
  presetIdx: number;
  presetKey: string; // `${camIdx}:${presetIdx}`
  slotIdx: number; // 파일 ROI idx(원본 값)
  roiJson: string; // 파일 폴리곤 정규화 점 [{x,y}...]
  vpdJson: string | null; // 차량 bbox {x,y,w,h}
  lpdJson: string | null; // 번호판 quad [{x,y}×4]
  occupied: number; // 0/1
  occupancyRate: number | null;
  /** 프리셋 실 PTZ(GET /cameras 조회). 미조회/미보유 시 null. */
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
  updatedAt: string;
}

/** parking_slots 조회 결과(파싱 shape, §06 H1 getParkingSlots). */
export interface ParkingSlotView {
  camIdx: number;
  presetIdx: number;
  presetKey: string;
  slotIdx: number;
  roi: NormalizedPoint[];
  vpd: { x: number; y: number; w: number; h: number } | null;
  lpd: NormalizedQuad | null;
  occupied: boolean;
  occupancyRate: number | null;
  /** 프리셋 실 PTZ(GET /cameras 조회). 미조회/미보유 시 null. */
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
}

/** LLM 체크포인트 기록 행. */
export interface CheckpointRow {
  id: number;
  runId: number;
  atRound: number;
  createdAt: string;
  summaryJson: string;
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
  /** 이번 run 에 적용된 VPD 필터 모드(true=주차면 위 차량만). */
  vpdOnParkingOnly?: boolean;
  /** 필터로 제외된 차량 누적 대수(run 누적). */
  vpdFilteredOut?: number;
  /** 주차면 필터로 제외된 번호판 누적 수(run 누적). 강등/모드B 시 미노출. */
  lpdFilteredOut?: number;
  /** 주차면 폴리곤 부재로 모드B 강등 중(사유). 조용한 폴백 금지 — UI 가 항상 소스를 안다. */
  vpdOnPlaceDegraded?: string;
}
