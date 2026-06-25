import { readFileSync } from 'node:fs';

/** 프롬프트 파일을 읽는다. */
export function loadPrompt(path: string): string {
  return readFileSync(path, 'utf-8');
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
