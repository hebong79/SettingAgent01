import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { FloorRoiInput, CenteringAdviceInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): 재다운스케일 방지 (설계 §3-3 chat.prepared, 성공기준 5).
 * recognizeFloorRoi/judgeOccupancy 는 prepareGroundingImage(smartResize) 로 이미 정확 크기라
 * chat() 이 downscaleJpegBase64 를 다시 호출하면 안 된다(좌표계 불일치 방지).
 * 반면 비-그라운딩 경로(adviseCentering)는 기존 downscale 을 그대로 탄다(회귀 보존).
 * image 모듈을 partial mock 하여 downscaleJpegBase64 호출 여부를 직접 관찰한다.
 */

const downscaleSpy = vi.fn();
vi.mock('../src/util/image.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/util/image.js')>();
  return {
    ...actual,
    // smartResizeJpegBase64 는 실제 구현 유지(prepareGroundingImage 통과), downscale 만 스파이.
    downscaleJpegBase64: (b64: string, edge: number) => {
      downscaleSpy(edge);
      return actual.downscaleJpegBase64(b64, edge);
    },
  };
});

const { AgentRuntime } = await import('../src/brain/AgentRuntime.js');

let server: Server;
let baseUrl: string;
let nextContent = '{}';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: nextContent }, finish_reason: 'stop' }],
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

function cfg(): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'gemma', model: 'g', baseUrl, temperature: 0.1, maxTokens: 256, enabled: true, api: 'openai', think: false, imageMaxEdge: 1288 },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
    },
    floorRoi: { enabled: true, maxPerCheckpoint: 12, prompt: 'config/prompts/floor_roi.yaml', timeoutMs: 120000 },
    centering: { prompt: 'config/prompts/ptz_centering.yaml' },
  };
}

let jpegB64 = '';
beforeAll(async () => {
  jpegB64 = (
    await sharp({ create: { width: 1288, height: 728, channels: 3, background: { r: 40, g: 90, b: 160 } } })
      .jpeg({ quality: 90 })
      .toBuffer()
  ).toString('base64');
});

describe('prepared=true → chat() 재다운스케일 방지 (성공기준 5)', () => {
  it('recognizeFloorRoi(prepared) → downscaleJpegBase64 미호출(smartResize 결과 그대로 전송)', async () => {
    downscaleSpy.mockClear();
    nextContent = JSON.stringify({ points_2d: [[644, 364], [644, 364], [644, 364], [644, 364]], confidence: 0.5 });
    const rt = new AgentRuntime(cfg());
    const floorInput: FloorRoiInput = {
      camIdx: 1, presetIdx: 2, imageBase64: jpegB64, vehicle: { x: 0.2, y: 0.3, w: 0.4, h: 0.4 },
    };
    const res = await rt.recognizeFloorRoi!(floorInput);
    expect(res).not.toBeNull();
    expect(downscaleSpy).not.toHaveBeenCalled(); // 중복 리사이즈 없음
  });

  it('대조: adviseCentering(비-prepared) → downscaleJpegBase64 호출(기존 경로 보존)', async () => {
    downscaleSpy.mockClear();
    nextContent = JSON.stringify({ converged: true });
    const rt = new AgentRuntime(cfg());
    const input: CenteringAdviceInput = {
      phase: 'center', err: { errX: 0.1, errY: -0.05 }, plateWidth: 0.12,
      target: { targetWidth: 0.2, centerTol: 0.03 }, imageBase64: jpegB64,
    };
    const res = await rt.adviseCentering!(input);
    expect(res).not.toBeNull();
    expect(downscaleSpy).toHaveBeenCalledWith(1288); // imageMaxEdge 로 다운스케일
  });
});
