import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** 프롬프트 파일을 읽는다(plain text — md 등). */
export function loadPrompt(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * system+user 를 한 yaml 파일에서 읽는다(구분 용이 — md 분리 대신). 키: system, user.
 * 예: floor_roi.yaml. 누락 시 에러.
 */
export function loadPromptPair(path: string): { system: string; user: string } {
  const doc = parseYaml(readFileSync(path, 'utf-8')) as { system?: unknown; user?: unknown };
  if (typeof doc?.system !== 'string' || typeof doc?.user !== 'string') {
    throw new Error(`프롬프트 yaml 에 문자열 system/user 가 필요: ${path}`);
  }
  return { system: doc.system, user: doc.user };
}

/** {{key}} 플레이스홀더를 vars 값으로 치환. 없는 키는 빈 문자열. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

/**
 * LLM 응답 문자열에서 JSON 객체를 추출해 파싱한다.
 * 코드펜스(```json ... ```)나 앞뒤 설명이 섞여도 첫 '{' ~ 마지막 '}' 구간을 시도한다.
 */
export function extractJson<T = unknown>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('응답에서 JSON 객체를 찾지 못함');
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
