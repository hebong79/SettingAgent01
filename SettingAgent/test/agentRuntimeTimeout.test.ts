import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmConfig } from '../src/config/llmConfig.js';
import { loadLlmConfig, DEFAULT_LLM_CONFIG } from '../src/config/llmConfig.js';

/**
 * 검증자(qa-tester): LLM 요청 타임아웃 반영(설계 §1-2 / §4-c).
 * OpenAI 생성자를 mock 하여 AgentRuntime 이 timeout=llm.timeoutMs(또는 30000), maxRetries:0 을
 * 전달하는지 단언. + llmConfig 파싱이 timeoutMs 기본 30000 을 부여하는지.
 */

// OpenAI 생성자 캡처(default export). 인스턴스는 ping/chat 이 필요 없으므로 최소 목만 반환.
const ctorArgs: Array<Record<string, unknown>> = [];
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      constructor(opts: Record<string, unknown>) {
        ctorArgs.push(opts);
      }
      models = { list: async () => ({ data: [] }) };
      chat = { completions: { create: async () => ({ choices: [] }) } };
    },
  };
});

// mock 적용 후 import(정적 import 는 hoist 되므로 동적 import 로 순서 보장).
const { AgentRuntime } = await import('../src/brain/AgentRuntime.js');

function cfg(over: Partial<LlmConfig['llm']> = {}): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: {
      provider: 'qwen3', model: 'm', baseUrl: 'http://localhost:1/v1',
      temperature: 0.1, maxTokens: 64, enabled: true, api: 'openai', think: false, imageMaxEdge: 960, ...over,
    },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('a'), stage2: pair('b'), stage3: pair('c'),
    },
  };
}

beforeEach(() => { ctorArgs.length = 0; });

describe('AgentRuntime LLM 타임아웃/재시도 (§4-c)', () => {
  it('timeoutMs 지정 → OpenAI 생성자에 timeout=지정값, maxRetries=0 전달', () => {
    new AgentRuntime(cfg({ timeoutMs: 5000 }));
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0].timeout).toBe(5000);
    expect(ctorArgs[0].maxRetries).toBe(0);
    expect(ctorArgs[0].baseURL).toBe('http://localhost:1/v1');
  });

  it('timeoutMs 미지정 → 기본 timeout=30000, maxRetries=0', () => {
    new AgentRuntime(cfg()); // timeoutMs 없음
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0].timeout).toBe(30000);
    expect(ctorArgs[0].maxRetries).toBe(0);
  });

  it('enabled=false → 클라이언트 생성 안 함(생성자 미호출)', () => {
    new AgentRuntime(cfg({ enabled: false }));
    expect(ctorArgs).toHaveLength(0);
  });
});

describe('llmConfig timeoutMs 스키마/기본값 (§1-1)', () => {
  it('DEFAULT_LLM_CONFIG.llm.timeoutMs === 30000', () => {
    expect(DEFAULT_LLM_CONFIG.llm.timeoutMs).toBe(30000);
  });

  it('없는 경로 로드 → 기본값 30000', () => {
    const c = loadLlmConfig('config/__nope__.json');
    expect(c.llm.timeoutMs).toBe(30000);
  });
});
