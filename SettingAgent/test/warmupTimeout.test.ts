import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmConfig } from '../src/config/llmConfig.js';

/**
 * 검증자(qa-tester): warm-up 이 fetchWithTimeout 의 3번째 인자로 warmup.timeoutMs 를 전달하는지.
 * http.js 모듈의 fetchWithTimeout 을 모킹해 인자를 직접 관찰(global.fetch 모킹으로는 timeoutMs 를
 * 관찰 불가 — AbortController 내부 소비되므로). 콜드 로드용 긴 타임아웃 분리(설계 §a: 실호출 30s 와 분리).
 */

const calls: Array<{ url: string; init: RequestInit; timeoutMs: number }> = [];
vi.mock('../src/util/http.js', () => ({
  fetchWithTimeout: vi.fn(async (url: string, init: RequestInit, timeoutMs: number) => {
    calls.push({ url, init, timeoutMs });
    return new Response('{}', { status: 200 });
  }),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor() {}
    models = { list: async () => ({ data: [] }) };
    chat = { completions: { create: async () => ({ choices: [] }) } };
  },
}));

const { AgentRuntime } = await import('../src/brain/AgentRuntime.js');

function cfg(warmup: Partial<NonNullable<LlmConfig['warmup']>>): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'qwen3', model: 'm1', baseUrl: 'http://h:11434/v1', temperature: 0.1, maxTokens: 64, enabled: true, api: 'openai', think: false, imageMaxEdge: 960 },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: { stage1Enabled: true, stage2Enabled: true, stage3Enabled: true, stage1: pair('a'), stage2: pair('b'), stage3: pair('c') },
    warmup: { enabled: true, keepAlive: '24h', numPredict: 1, timeoutMs: 120000, ...warmup },
  };
}

beforeEach(() => { calls.length = 0; });

describe('warm-up timeoutMs → fetchWithTimeout 3번째 인자', () => {
  it('warmup.timeoutMs=5000 → fetchWithTimeout(_, _, 5000)', async () => {
    const rt = new AgentRuntime(cfg({ timeoutMs: 5000 }));
    await rt.warmup();
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBe(5000);
    expect(calls[0].url).toBe('http://h:11434/api/chat');
  });

  it('기본 timeoutMs=120000 전달', async () => {
    const rt = new AgentRuntime(cfg({}));
    await rt.warmup();
    expect(calls[0].timeoutMs).toBe(120000);
  });
});
