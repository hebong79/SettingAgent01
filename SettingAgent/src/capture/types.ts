// capture 모듈 내부 타입 (장기 관측·반복 수집 → SQLite 누적 → LLM 정밀 주차면).
// @parkagent/types(공유 계약: SetupArtifact/ParkingSlot/...)와 분리한다 — 공유 계약 오염 금지.
// 좌표는 모두 정규화(0~1), cam/preset/round 인덱스는 1-based.

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
  status: 'candidate' | 'accepted' | 'rejected' | 'merged';
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
}
