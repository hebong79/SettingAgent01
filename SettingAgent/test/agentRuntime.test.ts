import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { SetupArtifact } from '../src/domain/types.js';

/** OpenAI 호환 엔드포인트를 흉내내는 목 서버(로컬 LLM 대역). */
let server: Server;
let baseUrl: string;
const calls: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model' }] }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '이상 없음(슬롯 균형 양호)' }, finish_reason: 'stop' }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cfg(enabled: boolean): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'qwen3', model: 'qwen3-8b', baseUrl, temperature: 0.1, maxTokens: 64, enabled, api: 'openai', think: false, imageMaxEdge: 960 },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true,
      stage2Enabled: true,
      stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
    },
  };
}

const artifact: SetupArtifact = {
  presets: [{ camIdx: 1, presetIdx: 1, label: 'p', coveredSlotIds: ['c1p1s1'] }],
  slots: [{ slotId: 'c1p1s1', zone: 'cam1', roiByPreset: {} }],
  globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
  createdAt: 'T',
};

describe('AgentRuntime (로컬 LLM 목 서버)', () => {
  it('enabled=false 면 ping=false, review=null (호출 안 함)', async () => {
    const rt = new AgentRuntime(cfg(false));
    expect(rt.enabled).toBe(false);
    expect(await rt.ping()).toBe(false);
    expect(await rt.reviewSetup(artifact)).toBeNull();
  });

  it('enabled=true 면 모델 엔드포인트에 실제 호출하여 ping/review 동작', async () => {
    const rt = new AgentRuntime(cfg(true));
    expect(await rt.ping()).toBe(true);
    const review = await rt.reviewSetup(artifact);
    expect(review).toContain('이상 없음');
    expect(calls.some((c) => c.includes('/chat/completions'))).toBe(true);
  });
});
