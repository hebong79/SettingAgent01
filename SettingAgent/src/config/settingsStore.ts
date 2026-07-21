import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  VpdSchema,
  LpdSchema,
  CameraExecutionModeSchema,
  CameraSourceConfigSchema,
} from './toolsConfig.js';
import { LlmSchema } from './llmConfig.js';

/**
 * 웹 옵션 페이지(설계서 §4)용 결정형 설정 I/O.
 * 두 config 파일(llm.config.json·tools.config.json)에서 편집 대상 값만 추출/부분갱신한다.
 * - 편집 대상: llm.{provider,model,baseUrl}, vpd/lpd.{endpoint,detPath}.
 * - API 키는 편집·노출 금지: apiKeyEnv(키 이름 문자열)만 읽어 노출, 키 값(process.env)은 절대 접근하지 않음.
 * - 부분 병합: 파일 raw JSON 을 읽어 화이트리스트 필드만 교체 후 다시 기록 →
 *   `_comment`·`mcp`·`setup`·`capture` 등 다른 모든 섹션·키를 보존한다(전체 스키마 덮어쓰기 금지).
 * LPR 은 마스터 보류(설계서 §8 A-2)로 미포함.
 */

/** patch 유효성 검사(기존 스키마 재사용, 편집 필드만 pick·partial). 잘못된 URL/detPath/provider 거부. */
export const SettingsPatchSchema = z
  .object({
    llm: LlmSchema.pick({ provider: true, model: true, baseUrl: true }).partial().optional(),
    vpd: VpdSchema.pick({ endpoint: true, detPath: true }).partial().optional(),
    lpd: LpdSchema.pick({ endpoint: true, detPath: true }).partial().optional(),
    camera: z
      .object({
        executionMode: CameraExecutionModeSchema.optional(),
        selectedCameraId: z.string().min(1).optional(),
        /** 현재 콤보에서 편집한 소스 한 건. 배열 전체 교체를 피해서 ptz 등 미편집 필드를 보존한다. */
        source: CameraSourceConfigSchema.pick({
          id: true,
          label: true,
          kind: true,
          protocol: true,
          baseUrl: true,
          host: true,
          port: true,
          username: true,
          password: true,
          rtspUrl: true,
        })
          .required({ id: true, kind: true })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    const source = patch.camera?.source;
    if (source?.kind === 'hucoms' && !source.rtspUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['camera', 'source', 'rtspUrl'],
        message: '실카메라 RTSP URL이 필요합니다',
      });
    } else if (source?.kind === 'hucoms' && source.rtspUrl) {
      try {
        const parsedUrl = new URL(source.rtspUrl);
        const protocol = parsedUrl.protocol;
        if (!['rtsp:', 'rtsps:'].includes(protocol)) throw new Error('invalid protocol');
        if (parsedUrl.username || parsedUrl.password) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['camera', 'source', 'rtspUrl'],
            message: 'RTSP URL 계정은 관리자 ID/Password 입력란에 분리해야 합니다',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['camera', 'source', 'rtspUrl'],
          message: '실카메라 URL은 rtsp:// 또는 rtsps:// 이어야 합니다',
        });
      }
    }
  });

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** GET /settings 반환 shape. apiKeyEnv 는 키 이름(노출 허용), 키 값은 미포함. */
export interface EditableSettings {
  llm: { provider?: string; model?: string; baseUrl?: string; apiKeyEnv?: string };
  vpd: { endpoint?: string; detPath?: string; apiKeyEnv?: string };
  lpd: { endpoint?: string; detPath?: string; apiKeyEnv?: string };
  camera: {
    executionMode: 'typescript-native';
    selectedCameraId: string;
    sources: Array<{
      id: string;
      label: string;
      kind: 'sim' | 'hucoms';
      protocol?: 'unity-rpc' | 'unity-rest' | 'hucoms-v1.22';
      baseUrl?: string;
      host?: string;
      port?: number;
      username?: string;
      rtspUrl?: string;
      passwordSet: boolean;
    }>;
  };
}

export interface SettingsPaths {
  toolsPath: string;
  llmPath: string;
}

export const DEFAULT_SETTINGS_PATHS: SettingsPaths = {
  toolsPath: 'config/tools.config.json',
  llmPath: 'config/llm.config.json',
};

/** config 파일 raw JSON 을 읽는다. 파일이 없으면 빈 객체(부팅 시엔 항상 존재). */
function readRaw(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
}

/** RTSP URL에 잘못 포함된 userinfo가 있어도 설정 조회 API에는 노출하지 않는다. */
function editableRtspUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/** 두 config 파일에서 편집 대상 값만 추출한다(키 값 미노출). */
export function readEditableSettings(paths: SettingsPaths = DEFAULT_SETTINGS_PATHS): EditableSettings {
  const rawTools = readRaw(paths.toolsPath);
  const rawLlm = readRaw(paths.llmPath);
  const llm = rawLlm.llm ?? {};
  const vpd = rawTools.vpd ?? {};
  const lpd = rawTools.lpd ?? {};
  const runtime = rawTools.cameraRuntime ?? {};
  const rawSources = Array.isArray(rawTools.cameraSources) ? rawTools.cameraSources : [];
  const sources = rawSources.map((source: Record<string, any>) => ({
    id: String(source.id ?? ''),
    label: String(source.label ?? source.id ?? ''),
    kind: source.kind === 'hucoms' ? ('hucoms' as const) : ('sim' as const),
    protocol: source.protocol,
    baseUrl: source.baseUrl,
    host: source.host,
    port: source.port,
    username: source.username,
    rtspUrl: editableRtspUrl(source.rtspUrl),
    passwordSet: typeof source.password === 'string' && source.password.length > 0,
  }));
  return {
    llm: { provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl, apiKeyEnv: llm.apiKeyEnv },
    vpd: { endpoint: vpd.endpoint, detPath: vpd.detPath, apiKeyEnv: vpd.apiKeyEnv },
    lpd: { endpoint: lpd.endpoint, detPath: lpd.detPath, apiKeyEnv: lpd.apiKeyEnv },
    camera: {
      executionMode: 'typescript-native',
      selectedCameraId: String(runtime.selectedCameraId ?? sources[0]?.id ?? ''),
      sources,
    },
  };
}

/** raw 객체의 섹션에 화이트리스트 키만 in-place 교체. */
function mergeSection(target: Record<string, any>, patch: Record<string, unknown> | undefined, keys: string[]): boolean {
  if (!patch) return false;
  const section = (target ??= {}) as Record<string, unknown>;
  let changed = false;
  for (const k of keys) {
    if (patch[k] !== undefined) {
      section[k] = patch[k];
      changed = true;
    }
  }
  return changed;
}

/**
 * 허용 키 화이트리스트만 부분 병합해 파일에 기록한다. 변경된 파일만 다시 쓴다(무변경 파일 재포맷 방지).
 * raw 객체를 in-place 수정 후 JSON.stringify(obj, null, 2) 로 기록 → 다른 섹션·키 순서 보존.
 */
export function writeEditableSettings(patch: SettingsPatch, paths: SettingsPaths = DEFAULT_SETTINGS_PATHS): void {
  if (patch.llm) {
    const rawLlm = readRaw(paths.llmPath);
    if (!rawLlm.llm || typeof rawLlm.llm !== 'object') rawLlm.llm = {};
    if (mergeSection(rawLlm.llm, patch.llm, ['provider', 'model', 'baseUrl'])) {
      writeFileSync(paths.llmPath, JSON.stringify(rawLlm, null, 2), 'utf-8');
    }
  }
  if (patch.vpd || patch.lpd) {
    const rawTools = readRaw(paths.toolsPath);
    if (!rawTools.vpd || typeof rawTools.vpd !== 'object') rawTools.vpd = {};
    if (!rawTools.lpd || typeof rawTools.lpd !== 'object') rawTools.lpd = {};
    const a = mergeSection(rawTools.vpd, patch.vpd, ['endpoint', 'detPath']);
    const b = mergeSection(rawTools.lpd, patch.lpd, ['endpoint', 'detPath']);
    if (a || b) writeFileSync(paths.toolsPath, JSON.stringify(rawTools, null, 2), 'utf-8');
  }
  if (patch.camera) {
    const rawTools = readRaw(paths.toolsPath);
    if (!rawTools.cameraRuntime || typeof rawTools.cameraRuntime !== 'object') rawTools.cameraRuntime = {};
    let changed = mergeSection(rawTools.cameraRuntime, patch.camera, ['executionMode', 'selectedCameraId']);
    if (patch.camera.source) {
      if (!Array.isArray(rawTools.cameraSources)) rawTools.cameraSources = [];
      const sourcePatch = patch.camera.source as Record<string, unknown>;
      const index = rawTools.cameraSources.findIndex((source: Record<string, unknown>) => source?.id === sourcePatch.id);
      const current = index >= 0 ? rawTools.cameraSources[index] : {};
      const merged = { ...current } as Record<string, unknown>;
      for (const key of ['id', 'label', 'kind', 'protocol', 'baseUrl', 'host', 'port', 'username', 'password', 'rtspUrl']) {
        if (sourcePatch[key] !== undefined) merged[key] = sourcePatch[key];
      }
      if (index >= 0) rawTools.cameraSources[index] = merged;
      else rawTools.cameraSources.push(merged);
      changed = true;
    }
    if (changed) writeFileSync(paths.toolsPath, JSON.stringify(rawTools, null, 2), 'utf-8');
  }
}
