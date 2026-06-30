import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { FloorRoiInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): AgentRuntime.recognizeFloorRoi (설계서 §3).
 * fake OpenAI 호환 서버가 4점 JSON 반환 → FloorRoiResult 파싱; floorRoi.enabled=false 면 null.
 */

let server: Server;
let baseUrl: string;
let lastBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastBody = body;
        const content = JSON.stringify({
          quad: [
            { x: 0.2, y: 0.9 },
            { x: 0.6, y: 0.9 },
            { x: 0.55, y: 0.6 },
            { x: 0.25, y: 0.6 },
          ],
          confidence: 0.7,
        });
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }),
        );
      });
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

function cfg(floorEnabled: boolean): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'gemma', model: 'gemma4:12b', baseUrl, temperature: 0.1, maxTokens: 256, enabled: true },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
    },
    floorRoi: {
      enabled: floorEnabled,
      maxPerCheckpoint: 12,
      prompt: pair('config/prompts/floor_roi.system.md'),
    },
  };
}

const input: FloorRoiInput = {
  camIdx: 1,
  presetIdx: 2,
  imageBase64: Buffer.from('img').toString('base64'),
  vehicle: { x: 0.2, y: 0.3, w: 0.4, h: 0.4 },
  plate: { x: 0.3, y: 0.6, w: 0.05, h: 0.03 },
};

describe('AgentRuntime.recognizeFloorRoi', () => {
  it('floorRoi.enabled=true → 4점 JSON 파싱(이미지 멀티모달 전송)', async () => {
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.recognizeFloorRoi!(input);
    expect(res).not.toBeNull();
    expect(res!.quad).toHaveLength(4);
    expect(res!.confidence).toBeCloseTo(0.7);
    // 이미지가 image_url(base64)로 전송됐는지(기존 멀티모달 경로 재사용).
    expect(lastBody).toContain('image_url');
    expect(lastBody).toContain('data:image/jpeg;base64,');
  });

  it('floorRoi.enabled=false → null(호출 안 함)', async () => {
    const rt = new AgentRuntime(cfg(false));
    expect(await rt.recognizeFloorRoi!(input)).toBeNull();
  });

  it('llm.enabled=false → null', async () => {
    const c = cfg(true);
    c.llm.enabled = false;
    const rt = new AgentRuntime(c);
    expect(await rt.recognizeFloorRoi!(input)).toBeNull();
  });
});
