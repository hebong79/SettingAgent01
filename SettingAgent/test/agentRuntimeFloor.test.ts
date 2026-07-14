import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { FloorRoiInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): AgentRuntime.recognizeFloorRoi (설계서 §3-3, §4 좌표변환 · 성공기준 1·4).
 * Qwen2.5-VL 네이티브 절대픽셀 그라운딩: fake 서버가 픽셀 points_2d/bbox_2d 반환 →
 * AgentRuntime 이 "전송 이미지 (W,H)" 기준으로 0~1 정규화한 FloorRoiResult 를 돌려줘야 한다.
 * 전송 이미지는 smartResize(imageMaxEdge=1288) 로 1288×728(28배수·항등) → W=1288, H=728.
 */

// 전송 이미지 크기(1288×728 원본 → smartResize(edge=1288) 항등). 정규화 기준값.
const W = 1288;
const H = 728;

let server: Server;
let baseUrl: string;
let lastBody = '';
/** 다음 응답 content(JSON 문자열). 테스트별로 교체(픽셀 RAW). */
let nextContent = '{}';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastBody = body;
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

function cfg(floorEnabled: boolean): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    // imageMaxEdge=1288: 1288×728 원본이 smartResize 항등 → 모델 픽셀좌표계 == 전송(W,H).
    llm: { provider: 'gemma', model: 'gemma4:12b', baseUrl, temperature: 0.1, maxTokens: 256, enabled: true, api: 'openai', think: false, imageMaxEdge: 1288 },
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
      prompt: 'config/prompts/floor_roi.yaml',
      timeoutMs: 120000,
    },
  };
}

/** 실제 1288×728 단색 JPEG(readJpegSize·smartResize 통과용). smartResize(1288) → 항등. */
let jpegB64 = '';
beforeAll(async () => {
  jpegB64 = (
    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 40, g: 90, b: 160 } } })
      .jpeg({ quality: 90 })
      .toBuffer()
  ).toString('base64');
});

function input(): FloorRoiInput {
  return {
    camIdx: 1,
    presetIdx: 2,
    imageBase64: jpegB64,
    vehicle: { x: 0.2, y: 0.3, w: 0.4, h: 0.4 },
  };
}

describe('AgentRuntime.recognizeFloorRoi', () => {
  it('points_2d(픽셀) → 전송(W,H) 기준 정규화 폴리곤(성공기준 1)', async () => {
    // 접지면 4코너(픽셀). 정규화 기대 = px/W, py/H.
    const pts: [number, number][] = [
      [258, 655],
      [1030, 655],
      [966, 510],
      [322, 510],
    ];
    nextContent = JSON.stringify({ points_2d: pts, confidence: 0.7 });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.recognizeFloorRoi!(input());
    expect(res).not.toBeNull();
    expect(res!.polygon).toHaveLength(4);
    expect(res!.confidence).toBeCloseTo(0.7);
    // 픽셀→정규화 정합(전송크기 W,H 로 나눔 — 원본 아님).
    res!.polygon.forEach((p, i) => {
      expect(p.x).toBeCloseTo(pts[i][0] / W, 5);
      expect(p.y).toBeCloseTo(pts[i][1] / H, 5);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    });
    // 이미지가 image_url(base64)로 멀티모달 전송됐는지.
    expect(lastBody).toContain('image_url');
    expect(lastBody).toContain('data:image/jpeg;base64,');
  });

  it('좌표변환 수치검증: 중심 픽셀 [644,364]@1288×728 → {0.5,0.5}', async () => {
    nextContent = JSON.stringify({
      points_2d: [[644, 364], [644, 364], [644, 364], [644, 364]],
      confidence: 0.5,
    });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.recognizeFloorRoi!(input());
    expect(res).not.toBeNull();
    res!.polygon.forEach((p) => {
      expect(p.x).toBeCloseTo(0.5, 6);
      expect(p.y).toBeCloseTo(0.5, 6);
    });
  });

  it('bbox_2d 폴백 → rectToQuad(normalizeBox) 정규화 4점(성공기준 1·4)', async () => {
    // bbox_2d=[0,0,644,364] → 좌상 절반 rect → quad [TL,TR,BR,BL] 정규화.
    nextContent = JSON.stringify({ bbox_2d: [0, 0, 644, 364], confidence: 0.4 });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.recognizeFloorRoi!(input());
    expect(res).not.toBeNull();
    expect(res!.polygon).toHaveLength(4);
    expect(res!.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 0, y: 0.5 },
    ]);
    expect(res!.confidence).toBeCloseTo(0.4);
  });

  it('points_2d/bbox_2d 둘 다 부재 → refine 실패 → null(결정형 폴백)', async () => {
    nextContent = JSON.stringify({ confidence: 0.9 });
    const rt = new AgentRuntime(cfg(true));
    expect(await rt.recognizeFloorRoi!(input())).toBeNull();
  });

  it('floorRoi.enabled=false → null(호출 안 함)', async () => {
    const rt = new AgentRuntime(cfg(false));
    expect(await rt.recognizeFloorRoi!(input())).toBeNull();
  });

  it('llm.enabled=false → null', async () => {
    const c = cfg(true);
    c.llm.enabled = false;
    const rt = new AgentRuntime(c);
    expect(await rt.recognizeFloorRoi!(input())).toBeNull();
  });
});
