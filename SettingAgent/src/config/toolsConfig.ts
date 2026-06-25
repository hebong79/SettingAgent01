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

const VpdSchema = z.object({
  endpoint: z.string().url(),
  detPath: z.string().startsWith('/'),
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
});

/**
 * LPD(번호판 검출, da_lpd_api) REST. SettingAgent 는 사용하지 않으나,
 * 실 서버 사양(포트/경로)을 정확히 보관하기 위해 포함(ActionAgent 가 사용 예정).
 */
const LpdSchema = z.object({
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
  /** 라운드 주기(ms, 점유 변화 포착). */
  intervalMs: z.number().int().positive(),
  /** K라운드마다 LLM 체크포인트(llm.enabled 시). */
  checkpointEvery: z.number().int().positive(),
  /** SQLite 파일 경로(테스트는 주입으로 :memory:). */
  dbFile: z.string().min(1),
  /** 집계 클러스터 거리 임계(중심 간 거리, 정규화). */
  clusterDist: z.number().min(0).max(1),
  /** 면 인정 최소 지지수(단발보다 높게). */
  clusterMinSupport: z.number().int().positive(),
  /** 집계용 최소 신뢰도(setup 과 독립값 허용). */
  minConfidence: z.number().min(0).max(1),
});

const ServerSchema = z.object({
  port: z.number().int().positive(),
  apiKeyEnv: z.string().optional(),
});

const StoreSchema = z.object({
  dataDir: z.string().min(1),
  captureDir: z.string().min(1),
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
  server: ServerSchema,
  store: StoreSchema,
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  camera: { baseUrl: 'http://localhost:13100', imageTimeoutMs: 7000, moveTimeoutMs: 3000, zoomMin: 1.0, zoomMax: 36.0 },
  vpd: { endpoint: 'http://127.0.0.1:9081', detPath: '/vpd/api/v2/det/imgupload', apiKeyEnv: 'VPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
  lpd: { endpoint: 'http://127.0.0.1:9082', detPath: '/lpd/api/v1/imgupload', apiKeyEnv: 'LPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
  setup: {
    presetSettleMs: 1000, betweenPresetMs: 500, minConfidence: 0.5, roiPadding: 0.05, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 1000, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  },
  map: { cameraposFile: 'config/camerapos.json', presetFile: 'config/preset.json' },
  discovery: { enabled: false, maxCameras: 32, maxPresetsPerCamera: 32 },
  presetProvider: { type: 'unity-api', unityUrl: '', refreshOnRun: false },
  capture: {
    defaultCount: 50, intervalMs: 30000, checkpointEvery: 10, dbFile: 'data/observations.sqlite',
    clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5,
  },
  server: { port: 13020, apiKeyEnv: 'SETTING_API_KEY' },
  store: { dataDir: 'data', captureDir: 'data/captures' },
};

/** tools.config.json 을 로드한다. 파일이 없으면 기본값을 검증해 반환. 섹션 단위 병합. */
export function loadToolsConfig(path = 'config/tools.config.json'): ToolsConfig {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Record<string, unknown>>;
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_TOOLS_CONFIG) as Array<keyof ToolsConfig>) {
      merged[key] = { ...DEFAULT_TOOLS_CONFIG[key], ...(raw[key] ?? {}) };
    }
    return ToolsConfigSchema.parse(merged);
  }
  return ToolsConfigSchema.parse(DEFAULT_TOOLS_CONFIG);
}
