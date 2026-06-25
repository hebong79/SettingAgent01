import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

/**
 * SettingViewer 설정. SettingAgent toolsConfig 의 뷰어 관련 섹션만 발췌
 * (camera / viewer / cameraSources / server.port) + 프록시 대상 settingAgentUrl.
 * SettingAgent 소스에 의존하지 않도록 독립 정의한다.
 */

const CameraSchema = z.object({
  baseUrl: z.string().url(),
  imageTimeoutMs: z.number().int().positive(),
  moveTimeoutMs: z.number().int().positive(),
  zoomMin: z.number().positive(),
  zoomMax: z.number().positive(),
});

const ViewerSchema = z.object({
  enabled: z.boolean(),
  allowMove: z.boolean(),
  defaultFps: z.number().int().positive(),
  staticDir: z.string().min(1),
  controlToken: z.string(),
});

/**
 * 카메라 소스 설정. 미설정 시 camera(단일 sim)로 폴백(하위호환).
 * 자격증명은 여기 두지 않는다(UI 입력 → 프록시 통과).
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

const ServerSchema = z.object({ port: z.number().int().positive() });

export const ViewerConfigSchema = z.object({
  camera: CameraSchema,
  viewer: ViewerSchema,
  cameraSources: z.array(CameraSourceConfigSchema).optional(),
  settingAgentUrl: z.string().url(), // /mapping 프록시 대상
  server: ServerSchema,
});

export type ViewerConfig = z.infer<typeof ViewerConfigSchema>;

export const DEFAULT_VIEWER_CONFIG: ViewerConfig = {
  camera: { baseUrl: 'http://localhost:13100', imageTimeoutMs: 7000, moveTimeoutMs: 3000, zoomMin: 1.0, zoomMax: 36.0 },
  viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' },
  settingAgentUrl: 'http://localhost:13020',
  server: { port: 13030 },
};

/** viewer.config.json 을 로드한다. 파일이 없으면 기본값을 검증해 반환. 섹션 단위 병합. */
export function loadViewerConfig(path = 'config/viewer.config.json'): ViewerConfig {
  if (!existsSync(path)) return ViewerConfigSchema.parse(DEFAULT_VIEWER_CONFIG);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
  const merged: Record<string, unknown> = {};
  for (const key of ['camera', 'viewer', 'server'] as const) {
    merged[key] = { ...DEFAULT_VIEWER_CONFIG[key], ...(raw[key] ?? {}) };
  }
  merged.settingAgentUrl = raw.settingAgentUrl ?? DEFAULT_VIEWER_CONFIG.settingAgentUrl;
  // cameraSources 는 옵셔널 배열(섹션 병합 부적합) → 있으면 그대로 통과, 없으면 undefined.
  if (raw.cameraSources !== undefined) merged.cameraSources = raw.cameraSources;
  return ViewerConfigSchema.parse(merged);
}
