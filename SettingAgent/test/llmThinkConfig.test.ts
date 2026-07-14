import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLlmConfig, DEFAULT_LLM_CONFIG } from '../src/config/llmConfig.js';

/**
 * 검증자(qa-tester): LLM thinking 제어 config 스키마(설계 §결정 B / 구현 §llmConfig.ts).
 * 신규 3필드(api/think/imageMaxEdge)의 하위호환 기본값·커스텀 파싱을 검증한다.
 * 임시 JSON 파일을 써서 loadLlmConfig 병합(`{...DEFAULT.llm,...raw.llm}`)을 실제로 통과시킨다.
 */

/** 임시 config 파일 생성 후 로드하고 정리. */
function loadWith(llm: Record<string, unknown>) {
  const path = join(tmpdir(), `llm-config-${Math.random().toString(36).slice(2)}.json`);
  const doc = {
    llm: {
      provider: 'openai-compatible',
      model: 'gemma4:12b',
      baseUrl: 'http://192.168.0.210:11434/v1',
      apiKeyEnv: 'LLM_API_KEY',
      temperature: 0.1,
      maxTokens: 3072,
      enabled: true,
      timeoutMs: 30000,
      ...llm,
    },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: { system: 'a', user: 'a' },
      stage2: { system: 'b', user: 'b' },
      stage3: { system: 'c', user: 'c' },
    },
  };
  writeFileSync(path, JSON.stringify(doc), 'utf-8');
  try {
    return loadLlmConfig(path);
  } finally {
    rmSync(path, { force: true });
  }
}

describe('llmConfig — thinking 제어 신규 필드 (하위호환)', () => {
  it('(a) 신규 3필드 없는 config → 기본값 api=openai, think=false, imageMaxEdge=960', () => {
    const c = loadWith({}); // api/think/imageMaxEdge 미지정
    expect(c.llm.api).toBe('openai');
    expect(c.llm.think).toBe(false);
    expect(c.llm.imageMaxEdge).toBe(960);
  });

  it('(b) think:true / api:ollama / imageMaxEdge 커스텀 → 그대로 파싱', () => {
    const c = loadWith({ api: 'ollama', think: true, imageMaxEdge: 768 });
    expect(c.llm.api).toBe('ollama');
    expect(c.llm.think).toBe(true);
    expect(c.llm.imageMaxEdge).toBe(768);
  });

  it('DEFAULT_LLM_CONFIG.llm 도 신규 기본값 보유', () => {
    expect(DEFAULT_LLM_CONFIG.llm.api).toBe('openai');
    expect(DEFAULT_LLM_CONFIG.llm.think).toBe(false);
    expect(DEFAULT_LLM_CONFIG.llm.imageMaxEdge).toBe(960);
  });

  it('실제 config/llm.config.json → api=openai(vLLM), think=false, imageMaxEdge=1288(그라운딩 해상도 상향)', () => {
    const real = loadLlmConfig();
    expect(real.llm.api).toBe('openai');
    expect(real.llm.think).toBe(false);
    expect(real.llm.imageMaxEdge).toBe(1288); // 960→1288(28×46, 16:9 시 1288×728≈0.94M<max_pixels)
  });

  it('api enum 검증: 잘못된 값이면 throw', () => {
    expect(() => loadWith({ api: 'bogus' })).toThrow();
  });

  it('imageMaxEdge 는 양의 정수만 허용(0/음수 throw)', () => {
    expect(() => loadWith({ imageMaxEdge: 0 })).toThrow();
    expect(() => loadWith({ imageMaxEdge: -5 })).toThrow();
  });
});
