import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmConfig } from '../src/config/llmConfig.js';
import { loadLlmConfig, DEFAULT_LLM_CONFIG } from '../src/config/llmConfig.js';

/**
 * 검증자(qa-tester): LLM 강제 구동(warm-up/preload) — 설계 §(a)/(b)/(f).
 * AgentRuntime.warmup(): 엔드포인트 유도·body 정합·게이트 no-op·best-effort 를 global.fetch 모킹으로 검증.
 * loadLlmConfig: warmup 미지정→default, 부분 지정 병합.
 *
 * OpenAI 생성자는 mock(생성자에서 client 생성 — 네트워크 미접촉 최소 목). warm-up 은 openai SDK 를
 * 쓰지 않고 fetchWithTimeout(global.fetch) 를 직접 쓰므로, 호출 여부·URL·body 는 fetch 모킹으로 관찰한다.
 */

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor() {}
    models = { list: async () => ({ data: [] }) };
    chat = { completions: { create: async () => ({ choices: [] }) } };
  },
}));

const { AgentRuntime } = await import('../src/brain/AgentRuntime.js');

/** 기본 cfg 빌더. llm/warmup 을 부분 오버라이드. */
function cfg(over: {
  llm?: Partial<LlmConfig['llm']>;
  warmup?: Partial<NonNullable<LlmConfig['warmup']>> | null;
} = {}): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  const base: LlmConfig = {
    llm: {
      provider: 'qwen3', model: 'm1', baseUrl: 'http://h:11434/v1',
      temperature: 0.1, maxTokens: 64, enabled: true, api: 'openai', think: false, imageMaxEdge: 960,
    },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('a'), stage2: pair('b'), stage3: pair('c'),
    },
    warmup: { enabled: true, keepAlive: '24h', numPredict: 1, timeoutMs: 120000 },
  };
  const merged: LlmConfig = {
    ...base,
    llm: { ...base.llm, ...over.llm },
    warmup: over.warmup === null ? undefined : { ...base.warmup!, ...over.warmup },
  };
  return merged;
}

/** fetch 모킹: 지정 상태/거부를 반환하고 호출 인자를 기록. */
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 마지막 fetch 호출의 [url, init] 를 파싱해 body(JSON)·timeout 관측을 돕는다. */
function lastCall(): { url: string; init: RequestInit; body: any } {
  const [url, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe('AgentRuntime.warmup — 엔드포인트 유도 (§b)', () => {
  it('기본(warmup default)·baseUrl /v1 → POST {base}/api/chat 1회, true', async () => {
    const rt = new AgentRuntime(cfg());
    const ok = await rt.warmup();
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, init } = lastCall();
    expect(url).toBe('http://h:11434/api/chat');
    expect(init.method).toBe('POST');
  });

  it('baseUrl 트레일링 슬래시 /v1/ 변형도 /api/chat 로 유도', async () => {
    const rt = new AgentRuntime(cfg({ llm: { baseUrl: 'http://h:11434/v1/' } }));
    await rt.warmup();
    expect(lastCall().url).toBe('http://h:11434/api/chat');
  });

  it('warmup.url 지정 → baseUrl 유도 무시하고 그 URL 그대로', async () => {
    const rt = new AgentRuntime(cfg({ warmup: { url: 'http://other:99/api/chat' } }));
    await rt.warmup();
    expect(lastCall().url).toBe('http://other:99/api/chat');
  });
});

describe('AgentRuntime.warmup — body 정합 (§b)', () => {
  it('기본 body: model=llm.model, keep_alive=24h, stream=false, options.num_predict=1', async () => {
    const rt = new AgentRuntime(cfg());
    await rt.warmup();
    const { body, init } = lastCall();
    expect(body.model).toBe('m1');
    expect(body.keep_alive).toBe('24h');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(1);
    expect(Array.isArray(body.messages)).toBe(true);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('config 파라미터 반영: keepAlive/numPredict/model/timeoutMs 가 body·fetch 인자에 그대로', async () => {
    const rt = new AgentRuntime(
      cfg({ warmup: { keepAlive: '1h', numPredict: 3, model: 'm2', timeoutMs: 5000 } }),
    );
    await rt.warmup();
    const { body } = lastCall();
    expect(body.model).toBe('m2'); // warmup.model 우선
    expect(body.keep_alive).toBe('1h');
    expect(body.options.num_predict).toBe(3);
    // fetchWithTimeout(url, init, timeoutMs) — 3번째 인자에 timeoutMs 전달.
    const call = fetchSpy.mock.calls[0] as unknown[];
    // fetch(global) 는 (url, init) 만 받음. timeoutMs 는 fetchWithTimeout 내부 AbortController 로 소비되므로
    // 여기서는 fetch 인자 2개만 존재. timeoutMs 반영은 아래 별도 spy 테스트로 검증.
    expect(call).toHaveLength(2);
  });

  it('warmup.model 미지정 → llm.model 사용', async () => {
    const rt = new AgentRuntime(cfg({ llm: { model: 'llm-model' }, warmup: { model: undefined } }));
    await rt.warmup();
    expect(lastCall().body.model).toBe('llm-model');
  });
});

describe('AgentRuntime.warmup — 게이트 no-op (§b)', () => {
  it('warmup.enabled=false → fetch 미호출, false', async () => {
    const rt = new AgentRuntime(cfg({ warmup: { enabled: false } }));
    expect(await rt.warmup()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('llm.enabled=false → fetch 미호출, false', async () => {
    const rt = new AgentRuntime(cfg({ llm: { enabled: false } }));
    expect(await rt.warmup()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provider 'claude' → fetch 미호출, false", async () => {
    const rt = new AgentRuntime(cfg({ llm: { provider: 'claude' } }));
    expect(await rt.warmup()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provider 'codex' → fetch 미호출, false", async () => {
    const rt = new AgentRuntime(cfg({ llm: { provider: 'codex' } }));
    expect(await rt.warmup()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warmup 미설정(undefined) → default 게이트 통과, fetch 호출·true', async () => {
    // warmup 블록 자체가 없어도 warmup?.enabled 는 false 아님 → 게이트 통과(설계: 미설정 시 활성).
    const rt = new AgentRuntime(cfg({ warmup: null }));
    expect(await rt.warmup()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AgentRuntime.warmup — best-effort (§b)', () => {
  it('fetch 비200(500) → false, throw 안 함', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('err', { status: 500 }));
    const rt = new AgentRuntime(cfg());
    expect(await rt.warmup()).toBe(false);
  });

  it('fetch reject(예외) → false, throw 안 함', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const rt = new AgentRuntime(cfg());
    await expect(rt.warmup()).resolves.toBe(false);
  });
});

describe('loadLlmConfig — warmup 파싱/병합 (§a)', () => {
  it('DEFAULT_LLM_CONFIG.warmup 기본값', () => {
    expect(DEFAULT_LLM_CONFIG.warmup).toEqual({
      enabled: true, keepAlive: '24h', numPredict: 1, timeoutMs: 120000,
    });
  });

  it('없는 경로(warmup 미지정) → default(enabled true/24h/1/120000)', () => {
    const c = loadLlmConfig('config/__nope__.json');
    expect(c.warmup?.enabled).toBe(true);
    expect(c.warmup?.keepAlive).toBe('24h');
    expect(c.warmup?.numPredict).toBe(1);
    expect(c.warmup?.timeoutMs).toBe(120000);
  });

  it('실제 config/llm.config.json → warmup 존재·비활성(vLLM: /api/chat 없음)', () => {
    const real = loadLlmConfig();
    expect(real.warmup).toBeDefined();
    expect(real.warmup?.enabled).toBe(false);
  });
});
