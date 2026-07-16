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
   * **zoomRef=1 기준** fallback 게인(°/정규화). PlatePtz 가 시작 zoom 으로 스케일해 사용.
   * cam1 시뮬 실측(−36.6/−21.0 @z1.69341) 유래 — 카메라별(FOV·마운트) 상이 가능하므로
   * 새 장비에서는 diagSweep 로 재실측할 것. 부호가 반대면 P 제어가 역방향 발산한다.
   */
  fallbackGainPanDeg: z.number(),
  fallbackGainTiltDeg: z.number(),
  /** move 후 정착 대기(ms). */
  settleMs: z.number().int().nonnegative(),
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

/**
 * 카메라 소스 설정(다중 소스). 미설정 시 camera(단일 sim)로 폴백(하위호환).
 * 자격증명은 여기 두지 않는다(UI 입력 → 통과).
 */
const CameraSourceConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['sim', 'hucoms']),
  baseUrl: z.string().url().optional(), // sim
  host: z.string().optional(), // hucoms
  port: z.number().int().positive().optional(),
  loginPath: z.string().optional(),
  snapshotUrl: z.string().optional(),
  ptz: z
    .object({
      panRange: z.tuple([z.number(), z.number()]),
      tiltRange: z.tuple([z.number(), z.number()]),
      zoomRange: z.tuple([z.number(), z.number()]),
    })
    .optional(),
});
export type CameraSourceConfig = z.infer<typeof CameraSourceConfigSchema>;

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
    checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: 'data/observations.sqlite',
    clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
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
    // cameraSources·realCamera 는 옵셔널(DEFAULT 에 없어 위 순회에서 누락) → 있으면 그대로 통과.
    if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;
    if (raw.realCamera !== undefined) merged.realCamera = raw.realCamera;
    return ToolsConfigSchema.parse(merged);
  }
  return ToolsConfigSchema.parse(DEFAULT_TOOLS_CONFIG);
}
