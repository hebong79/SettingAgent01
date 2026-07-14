import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';

/** 단계별 system 프롬프트의 특징 문구로 스테이지를 식별해 JSON 을 돌려주는 목 서버. */
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const sys = (() => {
        try {
          const j = JSON.parse(body);
          return String(j.messages?.[0]?.content ?? '');
        } catch {
          return '';
        }
      })();
      let content = '{}';
      if (sys.includes('비전 검수자')) {
        content = JSON.stringify({ validBoxes: [1, 2], excluded: [{ box: 3, reason: '프레임에 잘림' }], orderOk: true, rescan: { needed: false, reason: '' }, confidence: 0.9 });
      } else if (sys.includes('매핑 검수자')) {
        content = JSON.stringify({ duplicates: [['c1p2s1', 'c1p1s2']], zoneLabels: { c1p1s1: 'A-01' }, notes: 'ok' });
      } else if (sys.includes('설치 리포트')) {
        content = JSON.stringify({ approved: true, totalSlots: 3, globalCount: 3, mismatches: [], report_ko: '설치 완료', confidence: 0.95 });
      }
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cfg(over?: Partial<LlmConfig['setupPrompts']>): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'qwen3', model: 'm', baseUrl, temperature: 0.1, maxTokens: 256, enabled: true, api: 'openai', think: false, imageMaxEdge: 960 },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true,
      stage2Enabled: true,
      stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
      ...over,
    },
  };
}

describe('AgentRuntime 단계별(전략 C)', () => {
  it('stage1 judgePreset: 설정된 프롬프트 로드 + 구조화 결과 파싱', async () => {
    const rt = new AgentRuntime(cfg());
    const r = await rt.judgePreset({
      camIdx: 1,
      presetIdx: 1,
      imageBase64: Buffer.from('img').toString('base64'),
      boxes: [
        { box: 1, roi: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, confidence: 0.9 },
        { box: 2, roi: { x: 0.4, y: 0.1, w: 0.1, h: 0.1 }, confidence: 0.9 },
        { box: 3, roi: { x: 0.95, y: 0.1, w: 0.1, h: 0.1 }, confidence: 0.6 },
      ],
      expected: 2,
    });
    expect(r?.validBoxes).toEqual([1, 2]);
    expect(r?.excluded[0].box).toBe(3);
  });

  it('stage2 dedupeAndLabel: 중복/라벨 파싱', async () => {
    const rt = new AgentRuntime(cfg());
    const r = await rt.dedupeAndLabel({ slotsByPreset: [{ key: '1:1', slotIds: ['c1p1s1', 'c1p1s2'] }] });
    expect(r?.duplicates).toEqual([['c1p2s1', 'c1p1s2']]);
    expect(r?.zoneLabels['c1p1s1']).toBe('A-01');
  });

  it('stage3 finalReport: 승인/리포트 파싱', async () => {
    const rt = new AgentRuntime(cfg());
    const r = await rt.finalReport({ totalSlots: 3, globalCount: 3, expectedVsFinal: [], warnings: [] });
    expect(r?.approved).toBe(true);
    expect(r?.report_ko).toContain('설치');
  });

  it('단계 개별 비활성 시 null', async () => {
    const rt = new AgentRuntime(cfg({ stage1Enabled: false }));
    expect(await rt.judgePreset({ camIdx: 1, presetIdx: 1, boxes: [] })).toBeNull();
  });

  it('llm 비활성 시 모든 단계 null', async () => {
    const c = cfg();
    c.llm.enabled = false;
    const rt = new AgentRuntime(c);
    expect(await rt.judgePreset({ camIdx: 1, presetIdx: 1, boxes: [] })).toBeNull();
    expect(await rt.dedupeAndLabel({ slotsByPreset: [] })).toBeNull();
    expect(await rt.finalReport({ totalSlots: 0, globalCount: 0, expectedVsFinal: [], warnings: [] })).toBeNull();
  });
});
