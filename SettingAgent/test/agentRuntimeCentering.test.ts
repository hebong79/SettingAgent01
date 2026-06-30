import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { CenteringAdviceInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): AgentRuntime.adviseCentering (캘리브레이션 자문).
 * fake OpenAI 호환 서버가 보정 제안 JSON 반환 → 파싱; 잘못된 JSON → 재시도 후 null; llm off → null.
 */

let server: Server;
let baseUrl: string;
let mode: 'ok' | 'bad' = 'ok';
let lastBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastBody = body;
        const content = mode === 'ok'
          ? JSON.stringify({ suggestPan: 1.2, suggestTilt: -0.8, converged: false })
          : 'not-json-at-all';
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cfg(enabled: boolean): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'gemma', model: 'gemma4:12b', baseUrl, temperature: 0.1, maxTokens: 256, enabled },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
    },
  };
}

const input: CenteringAdviceInput = {
  imageBase64: Buffer.from('img').toString('base64'),
  err: { errX: 0.1, errY: -0.05 },
  plateWidth: 0.12,
  target: { centerTol: 0.03, targetWidth: 0.2 },
  phase: 'center',
};

describe('AgentRuntime.adviseCentering', () => {
  it('정상 JSON → 보정 제안 파싱(이미지 멀티모달 전송)', async () => {
    mode = 'ok';
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.adviseCentering!(input);
    expect(res).not.toBeNull();
    expect(res!.suggestPan).toBeCloseTo(1.2);
    expect(res!.converged).toBe(false);
    expect(lastBody).toContain('image_url');
    expect(lastBody).toContain('data:image/jpeg;base64,');
  });

  it('잘못된 JSON → 재시도 후 null', async () => {
    mode = 'bad';
    const rt = new AgentRuntime(cfg(true));
    expect(await rt.adviseCentering!(input)).toBeNull();
  });

  it('llm.enabled=false → null(호출 안 함)', async () => {
    const rt = new AgentRuntime(cfg(false));
    expect(await rt.adviseCentering!(input)).toBeNull();
  });
});
