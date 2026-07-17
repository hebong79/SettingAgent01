import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';

/** 단계별 요청의 response_format(JSON 모드) 여부를 기록하고, 단계에 맞는 JSON 을 돌려주는 목. */
let server: Server;
let baseUrl: string;
const seen: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const sys = String(j.messages?.[0]?.content ?? '');
      res.setHeader('content-type', 'application/json');
      let content = '{}';
      if (sys.includes('비전 검수자')) {
        seen.stage1 = j.response_format;
        content = JSON.stringify({ validBoxes: [1], excluded: [], orderOk: true, rescan: { needed: false, reason: '' }, confidence: 0.9 });
      } else if (sys.includes('매핑 검수자')) {
        seen.stage2 = j.response_format;
        content = JSON.stringify({ duplicates: [], zoneLabels: {}, notes: '' });
      } else if (sys.includes('설치 리포트')) {
        seen.stage3 = j.response_format;
        content = JSON.stringify({ approved: true, totalSlots: 1, globalCount: 1, mismatches: [], report_ko: '리포트', confidence: 0.9 });
      }
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
      stage1: pair('config/prompts/_archive/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/_archive/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/_archive/stage3_final_report.system.md'),
    },
  };
}

describe('단계별 JSON 모드 정책', () => {
  it('stage1/2 는 JSON 강제, stage3 는 해제(자유 텍스트)', async () => {
    const rt = new AgentRuntime(cfg());
    await rt.judgePreset({ camIdx: 1, presetIdx: 1, boxes: [{ box: 1, roi: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 0.9 }] });
    await rt.dedupeAndLabel({ slotsByPreset: [{ key: '1:1', slotIds: ['a'] }] });
    const r3 = await rt.finalReport({ totalSlots: 1, globalCount: 1, expectedVsFinal: [], warnings: [] });

    expect(seen.stage1).toEqual({ type: 'json_object' }); // 강제
    expect(seen.stage2).toEqual({ type: 'json_object' }); // 강제
    expect(seen.stage3).toBeUndefined();                  // 해제
    expect(r3?.report_ko).toBe('리포트');                 // 그래도 정상 파싱
  });
});
