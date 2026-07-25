// @parkagent/lens-calib — 공용 타입.
//
// ★ 단위는 전 구간 **Hucoms 네이티브**다(설계서 §4.2). ParkAgent 규약(정규화 0~1 · 도(°) · 배율 1~36)
//   과의 변환은 이 패키지 **밖**의 어댑터가 담당한다. 이유는 하나 — 네이티브가 곧 와이어 포맷이고,
//   참조본(unity/centering)의 실기 검증된 수식·표가 그 단위로 되어 있기 때문이다. 재유도는 검증을 버린다.
//
//   panpos  0~35999      centidegree (1/100°). + = 시계방향
//   tiltpos -2000~9000   centidegree.          + = 아래를 봄
//   zoompos 0~16384      레지스터 스텝(실측 포화값). 배율이 아니다 — zoomMap.ts 참조
//   클릭 좌표 0~1920 / 0~1080  (ptz_centering setcenter 의 고정 기준 해상도)

/** 장비 네이티브 PTZ. */
export interface Ptz {
  panpos: number;
  tiltpos: number;
  zoompos: number;
}

/** 프레임 픽셀 좌표(기준 1920x1080). */
export interface Point {
  x: number;
  y: number;
}

/** 8bit 그레이스케일 한 장. JPEG 디코딩은 **주입**한다(이 패키지는 디코더를 모른다). */
export interface GrayFrame {
  data: Uint8Array | Uint8ClampedArray | Float32Array;
  width: number;
  height: number;
}

// ── 표 스키마 ──────────────────────────────────────────────────────────────

/** 표시용 화각 곡선 앵커. h = 그 zoompos 에서 렌즈가 실제로 보는 수평 화각(도). */
export interface HfovPoint {
  z: number;
  h: number;
}

/** 조준용 게인 곡선 앵커. k = f_펌웨어 / f_렌즈 — 클릭 편심에 미리 곱할 배율. */
export interface GainPoint {
  z: number;
  k: number;
}

/**
 * 곡면율(방사왜곡) 곡선 앵커. 정규화 반경 r = r_px / f (교과서 Brown 규약, 설계서 §5.1).
 * 배럴이면 k1 < 0. `adopted:false` = 재봤지만 유의미하지 않아 0으로 기록한 것(미측정과 다르다).
 */
export interface DistortionPoint {
  z: number;
  k1: number;
  k2?: number;
  /** 채택 게이트 통과 여부. false 면 k1=k2=0 이며 reason 을 함께 읽어야 한다. */
  adopted?: boolean;
  reason?: 'not_significant' | 'too_few_samples';
  /** 왜곡항 없이 f 만 피팅했을 때의 잔차(px) — 게이트 판단 근거. */
  rms0Px?: number;
  /** 왜곡항 포함 잔차(px). */
  rms1Px?: number;
  /** 이 줌에서 쓴 유효 대응점 수. */
  n?: number;
}

/** config·아티팩트에 저장되는 캘리브레이션 한 벌. `CameraCalibration.from()` 에 그대로 넣을 수 있다. */
export interface CalibrationSpec {
  /** 상속할 프리셋 이름(기종 기록). 잰 곡선만 덮어쓴다. */
  model?: string;
  label?: string;
  zoomHfov?: HfovPoint[];
  centeringGain?: GainPoint[];
  lensDistortion?: DistortionPoint[];
  measuredAt?: string;
  residual?: ResidualReport;
}

export interface ResidualReport {
  /** 곡선이 존재하기 **전에** 이 카메라가 내던 최악 잔차(px). 보정 후 값이 아니다. */
  beforePx?: number | null;
  /** 단일 초점이 모든 착지를 얼마나 잘 설명하나 = 곡선 자체의 오차 막대. */
  fitRmsPx?: number | null;
  byZoom?: Record<string, number | null>;
}

// ── 캘리브레이션 샘플 ───────────────────────────────────────────────────────

/**
 * 측정 샘플 하나. **클릭 스윕과 광류 격자가 같은 스키마를 쓴다** — 그래서 솔버의 비용함수
 * (predictLanding)가 두 패스에 그대로 재사용된다(설계서 §7.2).
 *
 *   kind 'click' : 편심 클릭 → 중앙 근처 착지. dx/dy 가 있고 게인 추정에 쓰인다
 *   kind 'flow'  : 순수 회전 후 격자점 추적. dx/dy 가 없고 왜곡 추정에 쓰인다
 */
export interface Sample {
  kind: 'click' | 'flow';
  /** 이 샘플을 잰 줌 앵커. */
  zoomAnchor: number;
  /** 관측 시작점(프레임 픽셀). click 이면 클릭 좌표, flow 면 격자점. */
  fromX: number;
  fromY: number;
  /** click 전용 — 프레임 중심 기준 클릭 편심. flow 는 0. */
  dx: number;
  dy: number;
  ptzBefore: Ptz;
  ptzAfter: Ptz;
  /** 감김 처리된 PTZ 변화(centidegree). */
  dpanCd: number;
  dtiltCd: number;
  /** 관측 시작점의 내용이 실제로 떨어진 곳. */
  landedX: number;
  landedY: number;
  /** click 전용 — 프레임 중심 기준 잔차("덜 온 만큼"). */
  residualX: number;
  residualY: number;
  peak?: number;
  margin?: number;
  contrast?: number;
  usable?: boolean;
  reason?: MatchFailReason | 'error';
  matchError?: string;
}

export type MatchFailReason = 'dark' | 'smooth' | 'featureless';

// ── 카메라 어댑터 — 단 하나의 연결점 ─────────────────────────────────────────

/**
 * 기종·프로젝트 의존성은 전부 여기 모인다. 이 인터페이스만 구현하면 붙는다.
 *
 * ★ `snapshotGray` 는 **캘리브레이션을 직접 돌릴 때만** 필요하다. 조준(ClickCentering)만 쓸
 *   소비자는 getPtz + setCenter 두 개면 된다.
 */
export interface HucomsCameraPort {
  getPtz(): Promise<Ptz>;
  /** 이 픽셀을 화면 중앙으로 (ptz_centering action=setcenter type=point). */
  setCenter?(p: { x: number; y: number; speed?: number }): Promise<unknown>;
  /** 절대 이동 (goptzfpos). mode 'absolute' 와 스윕에 필요. */
  goPtz?(p: Partial<Ptz> & { speed?: number }): Promise<unknown>;
  /** 박스줌 (setcenter type=box). */
  setCenterBox?(p: { startX: number; startY: number; endX: number; endY: number; speed?: number }): Promise<unknown>;
  /** 정착까지 대기 후 최종 PTZ. 없으면 getPtz 한 번으로 대신한다. */
  waitSettle?(p?: { before?: Ptz }): Promise<Ptz>;
  /** 지금 자세에서 본 장면(그레이스케일). 캘리브레이션 전용. */
  snapshotGray?(): Promise<GrayFrame>;
}

/** 스윕 진행 보고. */
export interface SweepProgress {
  done: number;
  total: number;
  message?: string;
  sample?: Sample;
}
