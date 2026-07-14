import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { VpdSchema, LpdSchema } from './toolsConfig.js';
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
  })
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** GET /settings 반환 shape. apiKeyEnv 는 키 이름(노출 허용), 키 값은 미포함. */
export interface EditableSettings {
  llm: { provider?: string; model?: string; baseUrl?: string; apiKeyEnv?: string };
  vpd: { endpoint?: string; detPath?: string; apiKeyEnv?: string };
  lpd: { endpoint?: string; detPath?: string; apiKeyEnv?: string };
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

/** 두 config 파일에서 편집 대상 값만 추출한다(키 값 미노출). */
export function readEditableSettings(paths: SettingsPaths = DEFAULT_SETTINGS_PATHS): EditableSettings {
  const rawTools = readRaw(paths.toolsPath);
  const rawLlm = readRaw(paths.llmPath);
  const llm = rawLlm.llm ?? {};
  const vpd = rawTools.vpd ?? {};
  const lpd = rawTools.lpd ?? {};
  return {
    llm: { provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl, apiKeyEnv: llm.apiKeyEnv },
    vpd: { endpoint: vpd.endpoint, detPath: vpd.detPath, apiKeyEnv: vpd.apiKeyEnv },
    lpd: { endpoint: lpd.endpoint, detPath: lpd.detPath, apiKeyEnv: lpd.apiKeyEnv },
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
}
