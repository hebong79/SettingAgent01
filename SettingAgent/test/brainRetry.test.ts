import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';

/** 호출 횟수에 따라 응답을 바꾸는 목 서버(첫 호출 비-JSON, 둘째 JSON). */
let server: Server;
let baseUrl: string;
let calls = 0;
let mode: 'retry-success' | 'always-bad' = 'retry-success';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      res.setHeader('content-type', 'application/json');
      let content = '여기 결과를 드립니다: 중복 없음.'; // 비-JSON(파싱 실패 유발)
      const giveJson = mode === 'retry-success' && calls >= 2;
      if (giveJson) content = JSON.stringify({ duplicates: [['a', 'b']], zoneLabels: { a: 'A-01' }, notes: 'ok' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cfg(): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'qwen3', model: 'm', baseUrl, temperature: 0.1, maxTokens: 256, enabled: true, api: 'openai', think: false, imageMaxEdge: 960 },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
    },
  };
}

describe('chatJson 강건화(stage2)', () => {
  it('첫 응답이 비-JSON 이면 재시도해서 파싱 성공', async () => {
    calls = 0; mode = 'retry-success';
    const r = await new AgentRuntime(cfg()).dedupeAndLabel({ slotsByPreset: [{ key: '1:1', slotIds: ['a', 'b'] }] });
    expect(calls).toBe(2);                 // 재시도 1회
    expect(r?.duplicates).toEqual([['a', 'b']]);
  });

  it('두 번 다 비-JSON 이면 null(게이트 건너뜀)', async () => {
    calls = 0; mode = 'always-bad';
    const r = await new AgentRuntime(cfg()).dedupeAndLabel({ slotsByPreset: [] });
    expect(calls).toBe(2);                 // 최대 2회 시도
    expect(r).toBeNull();
  });
});
