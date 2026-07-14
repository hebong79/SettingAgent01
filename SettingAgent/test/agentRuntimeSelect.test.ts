import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig, LlmModelProfile } from '../src/config/llmConfig.js';

/** 두 개의 OpenAI 호환 목 서버(프로필 전환 시 baseUrl 재빌드 관찰용). */
function mkServer(tag: string, calls: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    calls.push(`${tag} ${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: tag, object: 'model' }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let serverA: Server;
let serverB: Server;
let baseA: string;
let baseB: string;
const callsA: string[] = [];
const callsB: string[] = [];

beforeAll(async () => {
  serverA = await mkServer('A', callsA);
  serverB = await mkServer('B', callsB);
  baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}/v1`;
  baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => serverA.close(() => r()));
  await new Promise<void>((r) => serverB.close(() => r()));
});

const prompts = {
  stage1Enabled: true,
  stage2Enabled: true,
  stage3Enabled: true,
  stage1: { system: 's', user: 'u' },
  stage2: { system: 's', user: 'u' },
  stage3: { system: 's', user: 'u' },
};

function profile(over: Partial<LlmModelProfile> & Pick<LlmModelProfile, 'id' | 'name' | 'baseUrl' | 'enabled'>): LlmModelProfile {
  return {
    provider: 'openai-compatible',
    model: `${over.id}-model`,
    temperature: 0.1,
    maxTokens: 64,
    api: 'openai',
    think: false,
    imageMaxEdge: 960,
    ...over,
  };
}

function multiCfg(): LlmConfig {
  return {
    llm: { ...profile({ id: 'a', name: 'A', baseUrl: baseA, enabled: true }) },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: prompts,
    models: [
      profile({ id: 'a', name: 'A', baseUrl: baseA, enabled: true }),
      profile({ id: 'b', name: 'B', baseUrl: baseB, enabled: true }),
      profile({ id: 'off', name: 'Off', baseUrl: baseA, enabled: false }),
    ],
    activeModel: 'a',
  };
}

/** models 없는 레거시 cfg(self-normalize 검증용). */
function legacyCfg(enabled: boolean): LlmConfig {
  return {
    llm: { provider: 'qwen3', model: 'legacy', baseUrl: baseA, temperature: 0.1, maxTokens: 64, enabled, api: 'openai', think: false, imageMaxEdge: 960 },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: prompts,
  };
}

describe('AgentRuntime.listModels', () => {
  it('프로필 목록 + active 플래그(활성만 true)', () => {
    const rt = new AgentRuntime(multiCfg());
    const models = rt.listModels();
    expect(models.map((m) => m.id)).toEqual(['a', 'b', 'off']);
    expect(models.filter((m) => m.active).map((m) => m.id)).toEqual(['a']);
    expect(models.find((m) => m.id === 'a')).toMatchObject({ name: 'A', provider: 'openai-compatible', model: 'a-model' });
  });
});

describe('AgentRuntime.selectModel', () => {
  it('유효 id 전환 → 동일 인스턴스에서 active getter/enabled 가 새 프로필 반영', () => {
    const rt = new AgentRuntime(multiCfg());
    expect(rt.enabled).toBe(true); // a enabled
    const r = rt.selectModel('off');
    expect(r).toEqual({ ok: true, activeModel: 'off' });
    // 비활성 프로필로 스왑 → enabled=false(인스턴스 교체 없이).
    expect(rt.enabled).toBe(false);
    expect(rt.listModels().find((m) => m.active)?.id).toBe('off');
  });

  it('무효 id → {ok:false}, 활성 불변', () => {
    const rt = new AgentRuntime(multiCfg());
    const r = rt.selectModel('ghost');
    expect(r).toEqual({ ok: false });
    expect(rt.listModels().find((m) => m.active)?.id).toBe('a');
    expect(rt.enabled).toBe(true);
  });

  it('전환 후 클라이언트 재빌드 → 다음 ping 이 새 baseUrl(serverB) 로 감', async () => {
    const rt = new AgentRuntime(multiCfg());
    callsA.length = 0;
    callsB.length = 0;
    expect(await rt.ping()).toBe(true);
    expect(callsA.some((c) => c.includes('/models'))).toBe(true);
    expect(callsB.length).toBe(0);
    // 전환 → serverB 로 재빌드.
    rt.selectModel('b');
    expect(await rt.ping()).toBe(true);
    expect(callsB.some((c) => c.includes('/models'))).toBe(true);
  });

  it('비활성 프로필로 전환 → client 해제(ping=false, 네트워크 호출 없음)', async () => {
    const rt = new AgentRuntime(multiCfg());
    rt.selectModel('off');
    callsA.length = 0;
    callsB.length = 0;
    expect(await rt.ping()).toBe(false);
    expect(callsA.length).toBe(0);
    expect(callsB.length).toBe(0);
  });
});

describe('AgentRuntime self-normalize (무회귀)', () => {
  it('models 없는 레거시 cfg → default 프로필 1개, 기존 동작 유지', () => {
    const rt = new AgentRuntime(legacyCfg(true));
    const models = rt.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('default');
    expect(models[0].active).toBe(true);
    expect(rt.enabled).toBe(true);
  });

  it('models 없는 레거시 cfg(enabled=false) → enabled=false, ping=false', async () => {
    const rt = new AgentRuntime(legacyCfg(false));
    expect(rt.enabled).toBe(false);
    expect(await rt.ping()).toBe(false);
  });
});
