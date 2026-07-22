import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

/**
 * MCP 도구(능력 엔드포인트) + 기타 설정 (llm.config 와 역할 분리).
 * SettingAgent 가 사용하는 도구: camera(Unity req_img/req_move), vpd(da_vpd_api 차량 검출).
 * 아키텍처 §5, §8 참조.
 */

const CameraSchema = z.object({
  baseUrl: z.string().url(),
  imageTimeoutMs: z.number().int().positive(),
  moveTimeoutMs: z.number().int().positive(),
  zoomMin: z.number().positive(),
  zoomMax: z.number().positive(),
});

export const VpdSchema = z.object({
  endpoint: z.string().url(),
  detPath: z.string().startsWith('/'),
  /** 세그멘테이션(마스크) 경로. 미설정이면 seg 기능 비활성(GET /capture/vehicle-cuboids → 404). */
  segPath: z.string().startsWith('/').optional(),
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
});

/**
 * LPD(번호판 검출, da_lpd_api) REST. SettingAgent 는 사용하지 않으나,
 * 실 서버 사양(포트/경로)을 정확히 보관하기 위해 포함(ActionAgent 가 사용 예정).
 */
export const LpdSchema = z.object({
  endpoint: z.string().url(),
  detPath: z.string().startsWith('/'),
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
});

const SetupSchema = z.object({
  presetSettleMs: z.number().int().nonnegative(),
  betweenPresetMs: z.number().int().nonnegative(),
  minConfidence: z.number().min(0).max(1),
  /** ROI 를 bbox 대비 확장하는 비율(0~1, 정규화). */
  roiPadding: z.number().min(0).max(1),
  /** 같은 y 밴드(행)로 묶을 때의 허용 오차(정규화). 전역 인덱스 정렬에 사용. */
  yBandTolerance: z.number().min(0).max(1),
  /** 프리셋당 캡처 프레임 수(>1 이면 누적 클러스터링 모드, 실 PTZ 권장). 설계서 §8-1-1. */
  accumFrames: z.number().int().positive(),
  /** 누적 프레임 간 대기(ms). */
  accumIntervalMs: z.number().int().nonnegative(),
  /** 클러스터 병합 거리 임계(중심 간 거리, 정규화). */
  clusterDist: z.number().min(0).max(1),
  /** 슬롯으로 인정할 최소 관측 횟수(전이성 노이즈 제거). */
  clusterMinSupport: z.number().int().positive(),
  /** 셋업 시 LPD 로 번호판 위치를 함께 검출해 슬롯에 저장할지(ActionAgent 센터라이징 prior). */
  lpdEnabled: z.boolean(),
});

/**
 * 장기 관측·반복 수집(/capture/*) 설정. 단발 셋업(setup)과 독립값 허용(설계서 §7).
 */
const CaptureSchema = z.object({
  /** 기본 반복 횟수(정지조건). 시작 시 UI 값으로 덮어쓸 수 있음. */
  defaultCount: z.number().int().positive(),
  /** 라운드 주기(ms, 점유 변화 포착 — 라운드 간 대기). */
  intervalMs: z.number().int().positive(),
  /**
   * 라운드 내 프리셋 이동 최소 간격(ms, floor). 한 타깃 사이클(이동+캡처+검출)이
   * 이 값보다 짧으면 남은 시간만큼 대기해 연속 이동이 버스트되지 않게 한다.
   * intervalMs(라운드 간)와 구분되는 타깃 간 간격. 0 이면 페이싱 없음(기존 동작).
   */
  moveIntervalMs: z.number().int().nonnegative().default(1000),
  /** K라운드마다 LLM 체크포인트(llm.enabled 시). */
  checkpointEvery: z.number().int().positive(),
  /** 체크포인트 트리거 모드: 'rounds'(done%K==0) | 'time'(경과 ≥ intervalMs). 기본 rounds(하위호환). */
  checkpointTriggerMode: z.enum(['rounds', 'time']).default('rounds'),
  /** time 모드 주기(ms). rounds 모드에서는 무시. */
  checkpointIntervalMs: z.number().int().positive().default(60000),
  /** SQLite 파일 경로(테스트는 주입으로 :memory:). */
  dbFile: z.string().min(1),
  /** 집계 클러스터 거리 임계(중심 간 거리, 정규화). */
  clusterDist: z.number().min(0).max(1),
  /** 면 인정 최소 지지수(단발보다 높게). */
  clusterMinSupport: z.number().int().positive(),
  /** 집계용 최소 신뢰도(setup 과 독립값 허용). */
  minConfidence: z.number().min(0).max(1),
  /**
   * finalize 공간배정 거리 게이트(정규화). 대표점↔주차면 centroid 거리가 이 값 미만이면
   * 폴리곤 밖이라도 후보쌍 형성(인접 슬롯 회수). 관측형 튜닝값(설계서 §4).
   * 라이브 검증: 최대매칭+상호배타가 과배정을 억제하므로 원근 오프셋 큰 프리셋의 정당 슬롯(실측 0.172)까지 포함하도록 0.18.
   */
  slotAssignGate: z.number().min(0).max(1).default(0.18),
  /**
   * 캡처 전 카메라를 프리셋 PTZ 로 실제 이동(/req_move)할지.
   * true 면 시뮬/실 카메라의 활성 화면이 프리셋마다 물리적으로 이동(미리보기와 동일하게 보임).
   * false 면 /req_img 스냅샷만(활성 화면 정지). 기본 true.
   */
  moveBeforeCapture: z.boolean().default(true),
});

/**
 * 주차면별 번호판 중심정렬·줌 센터라이징(/calibrate/*) 설정(설계서 §3.4).
 * 결정형 적응형 비례제어(PlatePtz 위임). 실 단위는 후속(시뮬 도(°) 한정).
 */
const CalibrateSchema = z.object({
  /** 목표 번호판 가로폭(정규화). */
  targetPlateWidth: z.number().min(0).max(1),
  /**
   * 1단계 pan/tilt 센터링을 수행할 **넓은 시야 zoom**(기본 1.0=최대광각). 마스터 요구 순서 보장:
   * 넓은 시야에서 번호판을 화면중앙에 완전 정렬한 뒤 2단계에서 이 zoom 부터 targetPlateWidth 까지 점진 확대.
   * 너무 넓어 LPD 미검이면 상향(프리셋 zoom 근처). 미지정 시 코드 기본 1.0(PtzCalibrator).
   */
  centerZoom: z.number().min(1).max(36).optional(),
  /** 중심 수렴 허용오차(정규화). */
  centerTol: z.number().min(0).max(1),
  /** 폭 수렴 허용오차(정규화). */
  widthTol: z.number().min(0).max(1),
  /** pan/tilt·zoom 각 단계 반복 상한. */
  maxIterations: z.number().int().positive(),
  /** 게인 추정용 probe 이동(도). */
  probeStepDeg: z.number().positive(),
  /** 1스텝 최대 보정(도, 진동 방지). */
  maxStepDeg: z.number().positive(),
  /**
   * 2단계 zoom 1스텝 최대 증배([z/r, z·r]). 작을수록 스텝당 중심 드리프트↓ → 줌 중 재중심(pan/tilt) 빈도↓
   * = "줌 우세"(마스터 순서 요구) + plate_lost↓. 단 목표폭 도달에 반복 더 필요. 미지정 시 PlatePtz 기본 1.5.
   */
  maxZoomStepRatio: z.number().min(1).max(3).optional(),
  /**
   * **zoomRef=1 기준** fallback 게인(°/정규화). PlatePtz 가 시작 zoom 으로 스케일해 사용.
   * cam1 시뮬 실측(−36.6/−21.0 @z1.69341) 유래 — 카메라별(FOV·마운트) 상이 가능하므로
   * 새 장비에서는 diagSweep 로 재실측할 것. 부호가 반대면 P 제어가 역방향 발산한다.
   */
  fallbackGainPanDeg: z.number(),
  fallbackGainTiltDeg: z.number(),
  /** move 후 정착 대기(ms). */
  settleMs: z.number().int().nonnegative(),
  /**
   * (방안2) acquire 시작줌이 겨눌 판폭(정규화). "먼저 확대해 찾기"의 확대 정도 — 작은 lpd(실측 0.027)를
   * 이 폭까지 줌인해 큰 판을 검출·센터한 뒤 targetPlateWidth 로 마감. 미지정 시 코드 기본 0.12(점진).
   * targetPlateWidth(0.2)로 두면 full-jump(중간 zoom 없이 목표까지 바로 확대).
   */
  acquirePlateWidth: z.number().min(0).max(1).optional(),
  /** (방안3) acquire 미검 시 줌아웃 사다리 1스텝 배율(rungZoom/=step). 미지정 시 코드 기본 1.5. */
  acquireLadderStep: z.number().min(1).max(3).optional(),
  /** (방안3) 줌아웃 사다리 최대 rung 수. 0 이면 사다리 없음(acquire 1발만). 미지정 시 코드 기본 5. */
  acquireLadderMaxSteps: z.number().int().nonnegative().optional(),
  /**
   * (개별 클릭 전용) 최초 대상 선정 반경 게이트(정규화). 클릭점에서 이 거리를 넘는 판만 있으면
   * **다른 판을 대신 채택하지 않고** no_plate_near_click 으로 실패한다(거짓 성공 제거).
   * 미지정 시 코드 기본 0.10 — 클릭정밀도(±0.02)+차체↔판 오프셋(≤0.08) worst 합 이상이면서
   * 이웃 판 최소 간격 0.11 미만인 구간. ★0.11 이상으로 올리면 이웃 오채택이 되살아나 게이트가 무의미해진다.
   * 라이브에서 오탐(no_plate_near_click)이 잦으면 0.13 까지 상향하되 그 대가를 감수하는 것임을 알 것.
   * ★ 배치(calibrateSlot) 경로에는 적용되지 않는다(그쪽은 peerOffsets 소유권 게이트가 담당).
   */
  pointMatchRadiusNorm: z.number().min(0).max(1).optional(),
  /**
   * (개별 클릭 전용) 추적 캡처 미검 시 **재포착 1배수 화면 변위(정규화)**. 미지정 시 코드 기본 0.0014(1080p ≈1.5px).
   * LPD 는 같은 프레임에 대해 결정적이라 같은 PTZ 재캡처로는 회복되지 않는다 — tilt 를 흔들어 프레이밍을
   * 바꾼 뒤 다시 본다. ★ 단위가 각도가 아니라 변위인 이유: 검출기 불안정은 **픽셀 공간** 현상이라
   * 고정 각도는 zoom 에 따라 픽셀 이동이 36배까지 달라진다. 실제 tilt 각은 zoom 별로 환산된다.
   * 라이브에서 더 큰 재프레이밍이 필요하면 이 값을 올린다(실측: 6px 에서 회복).
   */
  pointRecaptureDitherNorm: z.number().min(0).max(0.5).optional(),
  /**
   * (개별 클릭 전용) 재포착 디더 재캡처 최대 횟수. 미지정 시 코드 기본 6 = 에스컬레이팅 사다리
   * `[+1,−1,+2,−2,+4,−4]×변위` 전체(1.5px→3px→6px 양방향) → `plate_lost` 는 연속 7회 미검에서만 확정.
   * 0 으로 두면 1회 미검 즉시 실패(구 동작).
   * ★ 게이트(matchRadiusNorm)는 재시도에서도 **완화되지 않는다** — 반경 밖 이웃 판을 대신 채택하는 일은 없다.
   * ★ 배치(calibrateSlot) 경로에는 적용되지 않는다.
   */
  pointRecaptureRetries: z.number().int().min(0).max(8).optional(),
  /**
   * (개별 클릭 전용) **줌 스텝 직후 캡처**의 재포착 승법 디더 1배수 비율. 미지정 시 코드 기본 0.01(±1%).
   * 그 지점은 배율이 바뀐 새 프레임이라 회복 축이 tilt 가 아니라 **zoom** 이다(실측: tilt 디더 7시도 전패,
   * zoom +1% 로 재검출 — LPD 의 zoom 축 데드존이 좁고 산발적이다). 사다리 배수와 곱해 ±1/2/4% 를 훑는다.
   * ★ pan/tilt 이동 직후 캡처는 `pointRecaptureDitherNorm`(tilt 축)이 담당한다 — 두 노브는 지점이 다르다.
   */
  pointRecaptureZoomStep: z.number().min(0).max(0.5).optional(),
  /**
   * (개별 클릭 전용) center+zoom 줌 사다리 사용 여부. 미지정 시 'auto'.
   * - 'auto'   = 소스가 네이티브 센터링(centerOnPoint)을 지원할 때만 사다리(실카). 시뮬은 기존 경로 100%(회귀 0).
   * - 'always' = 네이티브 없는 소스(시뮬)에서도 사다리(재중심은 기하 게인 1샷 폴백). 통합 실험용.
   * - 'off'    = 사다리 완전 비활성(실카도 기존 경로) — 배포 없이 롤백하는 안전핀.
   */
  pointZoomLadder: z.enum(['auto', 'always', 'off']).optional(),
  /**
   * (개별 클릭 전용) 줌 사다리 rung 상한. **미지정 권장** — 미지정 시 시작 zoom·maxZoomStepRatio·zoom 상한에서
   * 자동 산출해 비율이 무엇이든(현 설정 1.3) clampZoom 상한 도달을 보장한다. 지정하면 그 값이 우선이며,
   * 상한에 못 미치는 값을 넣으면 사다리가 중도 포기하고 "최대 줌에서 못 찾음"으로 오보한다.
   */
  ladderMaxRungs: z.number().int().nonnegative().optional(),
  /** (개별 클릭 전용) 네이티브 setcenter 후 정착 대기(ms). 미지정 시 코드 기본 1000(★라이브 미측정 튜닝값). */
  nativeAimSettleMs: z.number().int().nonnegative().optional(),
  /**
   * (개별 클릭 전용) 사다리의 **latch 이전** 눈먼 줌인 배율. 미지정 시 코드 기본 2.0.
   * latch 전에는 추적 대상이 아직 없어 maxZoomStepRatio(1.3)의 "대상을 날린다" 근거가 성립하지 않는다 →
   * 성기게 올려 칸수(=rung 당 정착 대기)를 줄인다. latch 후 구간은 maxZoomStepRatio 가 그대로 지배한다.
   * 근거 전문은 platePtz.ts 의 LADDER_PRELATCH_RATIO 주석.
   */
  preLatchZoomStepRatio: z.number().min(1).max(4).optional(),
  /** 산출물 경로. */
  outFile: z.string().min(1),
});

/**
 * Unity JSON-RPC 2.0 서버 연결 설정 (포트 13110 /rpc, /rpc/catalog).
 * MCP 툴 unity_rpc · unity_rpc_catalog 에서 사용(아키텍처 §8).
 */
const UnityRpcSchema = z.object({
  baseUrl: z.string().url(),
  timeoutMs: z.number().int().positive(),
});

const ServerSchema = z.object({
  port: z.number().int().positive(),
  apiKeyEnv: z.string().optional(),
});

/**
 * 웹 뷰어(SPA + /viewer/api/*) 설정. enabled=false 면 뷰어 라우트·정적 미등록(헤드리스).
 * (SettingViewer 통합 — 기존 viewerConfig.ts 의 ViewerSchema 를 흡수.)
 */
const ViewerSchema = z.object({
  enabled: z.boolean(),
  allowMove: z.boolean(),
  defaultFps: z.number().int().positive(),
  staticDir: z.string().min(1),
  controlToken: z.string(),
});

/** TypeScript 네이티브 카메라 클라이언트 실행 모드. */
export const CameraExecutionModeSchema = z.enum(['typescript-native']);

/**
 * 카메라 소스 설정(다중 소스). 미설정 시 camera(단일 sim)로 폴백(하위호환).
 * password는 독립형 폐쇄망 배포를 위해 선택적으로 저장할 수 있지만 GET /settings에는 절대 노출하지 않는다.
 */
export const CameraSourceConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: z.enum(['sim', 'hucoms']),
  /** 소스 프로토콜. 기존 설정(undefined)은 kind별 레거시 동작을 유지한다. */
  protocol: z.enum(['unity-rpc', 'unity-rest', 'hucoms-v1.22']).optional(),
  /** 시뮬레이터/실카메라 HTTP 제어 URL. Hucoms는 host/port보다 우선한다. */
  baseUrl: z.string().url().optional(),
  host: z.string().optional(), // hucoms 레거시
  port: z.number().int().positive().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  /** 영상 소비자가 직접 사용할 스트림 주소. Hucoms HTTP 제어에는 사용하지 않는다. */
  rtspUrl: z.string().url().or(z.literal('')).optional(),
  /** @deprecated Hucoms V1.22는 별도 login CGI가 없으며 id/passwd query 인증을 사용한다. */
  loginPath: z.string().optional(),
  /** @deprecated 네이티브 클라이언트는 /cgi-bin/image/jpeg.cgi를 사용한다. */
  snapshotUrl: z.string().optional(),
  /**
   * 장비 raw PTZ 범위(미지정 축은 RealPtzSource 의 HUCOMS_DEFAULT_* 기본값).
   * ★ 축별 optional — 한 축만 정정하려고 나머지 두 축까지 적어야 하면 기본값이 config 에 복제되어
   *   기본값 변경이 반영되지 않는 사본이 남는다. RealPtzSource:132~134 이 이미 축별 `?? 기본값` 이라
   *   코드가 요구하지 않는 것을 스키마만 요구하고 있었다(실카 zoomRange 단독 지정이 기동 실패를 냈다).
   */
  ptz: z
    .object({
      panRange: z.tuple([z.number(), z.number()]).optional(),
      tiltRange: z.tuple([z.number(), z.number()]).optional(),
      zoomRange: z.tuple([z.number(), z.number()]).optional(),
    })
    .optional(),
});
export type CameraSourceConfig = z.infer<typeof CameraSourceConfigSchema>;

export const CameraRuntimeSchema = z.object({
  executionMode: CameraExecutionModeSchema.default('typescript-native'),
  /** 옵션창과 런타임이 공통으로 사용하는 활성 카메라 source id. */
  selectedCameraId: z.string().min(1),
});

/** 실카메라 RTSP를 Viewer용 JPEG 프레임으로 변환하는 로컬 FFmpeg 설정. */
export const CameraStreamingSchema = z.object({
  ffmpegPath: z.string().min(1).default('ffmpeg'),
  rtspTransport: z.enum(['tcp', 'udp']).default('tcp'),
  fps: z.number().int().min(1).max(30).default(5),
  /** FFmpeg MJPEG q:v. 낮을수록 고화질. */
  jpegQuality: z.number().int().min(2).max(31).default(5),
  startupTimeoutMs: z.number().int().positive().default(10_000),
});

const StoreSchema = z.object({
  dataDir: z.string().min(1),
  captureDir: z.string().min(1),
  /** 정밀수집 결과 저장/열기(save/*) 폴더. */
  saveDir: z.string().min(1),
  /** 결과 artifact 보조 미러(reports/*) 폴더. save/ 와 동일 JSON 복사. */
  reportsDir: z.string().min(1).default('reports'),
  /** 미리 정의된 주차면 폴리곤 파일(dataDir 상대). finalize/detect 의 PtzCamRoi 소스. */
  placeRoiFile: z.string().min(1).default('Place01/PtzCamRoi.json'),
});

/**
 * 지면모델(GroundModel) 산출 설정 — 3D 육면체 렌더용(설계 §5-1).
 * 순수 가산: enabled=false 면 GET /capture/ground-model 이 404, 기존 렌더는 픽셀 단위로 동일.
 */
const GroundSchema = z.object({
  enabled: z.boolean().default(true),
  /** 조건수 게이트(px). 깊이변이 이보다 짧은 프리셋은 f 공동추정 표본에서 제외(설계 §4-4 실측 근거). */
  minDepthEdgePx: z.number().positive().default(250),
  /** 주차면 폭(m) — metric 스케일 1순위 앵커. 설계 §4-5 에서 2.53~2.58m 실측 확인. */
  slotWidthM: z.number().positive().default(2.5),
  /** 주차면 깊이(m) — 폭/깊이 대응 뒤집힘 판별용. 설계 §4-5 에서 5.01~5.13m 실측 확인. */
  slotDepthM: z.number().positive().default(5.0),
});

/** mapConfig 자동 프리셋 로딩 파일 경로(설계서 §8). camerapos 필수, preset 선택. */
const MapSchema = z.object({
  cameraposFile: z.string().min(1),
  presetFile: z.string().optional(),
});

/**
 * 프리셋 자동 탐색(B). enabled=false 면 camerapos 사용(기본, A).
 * enabled=true 면 cam/preset 인덱스를 순회 캡처하며 범위초과 에러에서 종료해 목록을 구성한다.
 * 실 PTZ 는 없는 프리셋에도 영상을 줄 수 있어 부정확할 수 있으므로 상한으로 폭주를 막는다(옵트인).
 */
const DiscoverySchema = z.object({
  enabled: z.boolean(),
  maxCameras: z.number().int().positive(),
  maxPresetsPerCamera: z.number().int().positive(),
});

/**
 * 프리셋 공급자 선택(camerapos.json 을 채울 출처). export 시 사용.
 * - camerapos: 수동 파일(공급자 없음).
 * - discovery: 자동 탐색(B).
 * - unity-api: 서버 목록 API(A). unityUrl 비우면 camera.baseUrl 사용.
 */
const PresetProviderSchema = z.object({
  type: z.enum(['camerapos', 'discovery', 'unity-api']),
  unityUrl: z.string(),
  /**
   * 셋업 직전(run-from-map 시작 시) 공급자(A/B)로 camerapos.json 을 자동 갱신할지.
   * true + type≠camerapos + discovery.enabled=false 일 때 동작. (camerapos 파일 입력을 항상 최신화)
   */
  refreshOnRun: z.boolean(),
});

export const ToolsConfigSchema = z.object({
  camera: CameraSchema,
  vpd: VpdSchema,
  lpd: LpdSchema,
  setup: SetupSchema,
  map: MapSchema,
  discovery: DiscoverySchema,
  presetProvider: PresetProviderSchema,
  capture: CaptureSchema,
  calibrate: CalibrateSchema,
  ground: GroundSchema,
  server: ServerSchema,
  store: StoreSchema,
  viewer: ViewerSchema,
  /** Unity JSON-RPC 2.0 서버 설정(MCP unity_rpc 툴). */
  unityRpc: UnityRpcSchema,
  /** 다중 카메라 소스(옵셔널). 미설정 시 단일 sim 폴백. */
  cameraSources: z.array(CameraSourceConfigSchema).optional(),
  /** TypeScript 네이티브 실행 및 활성 카메라 선택. 미설정 시 기존 cameraMode 동작을 유지한다. */
  cameraRuntime: CameraRuntimeSchema.optional(),
  /** RTSP → JPEG 변환 기본값. */
  cameraStreaming: CameraStreamingSchema,
  /**
   * 뷰어 카메라 소스 선택. cameraSources(다중/고급) 미설정 시 이 값으로 단일 소스를 구성.
   * precedence: cameraSources(명시·길이>0) > cameraMode.
   */
  cameraMode: z.enum(['simulator', 'real']).default('simulator'),
  /** 리얼(Hucoms) 카메라 접속정보. cameraMode='real' 일 때 필요(자격증명 미포함 — UI 세션). */
  realCamera: CameraSourceConfigSchema.optional(),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  camera: { baseUrl: 'http://localhost:13100', imageTimeoutMs: 7000, moveTimeoutMs: 3000, zoomMin: 1.0, zoomMax: 36.0 },
  vpd: { endpoint: 'http://127.0.0.1:9081', detPath: '/vpd/api/v2/det/imgupload', segPath: '/vpd/api/v2/seg/imgupload', apiKeyEnv: 'VPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
  lpd: { endpoint: 'http://127.0.0.1:9082', detPath: '/lpd/api/v1/imgupload', apiKeyEnv: 'LPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
  setup: {
    presetSettleMs: 1000, betweenPresetMs: 500, minConfidence: 0.5, roiPadding: 0.05, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 1000, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  },
  map: { cameraposFile: 'config/camerapos.json', presetFile: 'config/preset.json' },
  discovery: { enabled: false, maxCameras: 32, maxPresetsPerCamera: 32 },
  presetProvider: { type: 'camerapos', unityUrl: '', refreshOnRun: false },
  capture: {
    defaultCount: 50, intervalMs: 30000, moveIntervalMs: 1000, checkpointEvery: 10,
    checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: 'data/setting.sqlite',
    clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.18, moveBeforeCapture: true,
  },
  calibrate: {
    targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 15,
    probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
    settleMs: 300, outFile: 'data/slot_ptz.json',
  },
  ground: { enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 },
  server: { port: 13020, apiKeyEnv: 'SETTING_API_KEY' },
  store: { dataDir: 'data', captureDir: 'data/captures', saveDir: 'save', reportsDir: 'reports', placeRoiFile: 'Place01/PtzCamRoi.json' },
  viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' },
  unityRpc: { baseUrl: 'http://localhost:13110', timeoutMs: 10000 },
  // cameraSources 는 기본값 미설정(undefined → sourceRegistry 가 단일 sim 으로 폴백).
  cameraMode: 'simulator',
  cameraStreaming: { ffmpegPath: 'ffmpeg', rtspTransport: 'tcp', fps: 5, jpegQuality: 5, startupTimeoutMs: 10_000 },
  // realCamera 는 기본값 미설정(cameraMode='real' 전환 시 사용자가 추가).
};

/** tools.config.json 을 로드한다. 파일이 없으면 기본값을 검증해 반환. 섹션 단위 병합. */
export function loadToolsConfig(path = 'config/tools.config.json'): ToolsConfig {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_TOOLS_CONFIG) as Array<keyof ToolsConfig>) {
      const def = DEFAULT_TOOLS_CONFIG[key];
      // 객체 섹션만 스프레드 병합. 스칼라(cameraMode 등)를 스프레드하면 문자 인덱스 객체로 깨지므로 값으로 대입.
      if (def !== null && typeof def === 'object' && !Array.isArray(def)) {
        merged[key] = { ...(def as Record<string, unknown>), ...((raw[key] as Record<string, unknown>) ?? {}) };
      } else {
        merged[key] = raw[key] ?? def;
      }
    }
    // cameraSources·cameraRuntime·realCamera 는 옵셔널(DEFAULT 에 없어 위 순회에서 누락) → 있으면 그대로 통과.
    if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;
    if (raw.cameraRuntime !== undefined) merged.cameraRuntime = raw.cameraRuntime;
    if (raw.realCamera !== undefined) merged.realCamera = raw.realCamera;
    return ToolsConfigSchema.parse(merged);
  }
  return ToolsConfigSchema.parse(DEFAULT_TOOLS_CONFIG);
}
