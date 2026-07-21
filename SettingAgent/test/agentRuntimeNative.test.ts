import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { FloorRoiInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): AgentRuntime chat 라우팅(네이티브 /api/chat vs OpenAI SDK) — 설계 §결정 A / 구현 §chatNative.
 * 핵심 회귀 방지: api:'ollama' 시 네이티브 바디에 think(=config.think), format:'json', images:[b64] 가
 * 올바로 실리는지, think:false 가 실제로 false 로 전달되는지(근본수정 본질), 이미지가 전송 전 다운스케일되는지.
 * 외부 서버는 global.fetch 모킹, OpenAI SDK 는 create 스파이로 모킹(네트워크 미접촉).
 */

// OpenAI SDK 모킹: chat.completions.create 스파이(호출/인자 기록). ping 용 models.list 도 제공.
const createSpy = vi.fn(async (_args: unknown) => ({
  choices: [{ message: { content: JSON.stringify(FLOOR_JSON) } }],
}));
vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor() {}
    models = { list: async () => ({ data: [] }) };
    chat = { completions: { create: createSpy } };
  },
}));

// Qwen2.5-VL 네이티브 절대픽셀 그라운딩: floor RAW 는 픽셀 points_2d.
// 전송 이미지는 smartResize(imageMaxEdge=960)로 1920×1080 → 952×532(28배수·항등).
const FLOOR_JSON = {
  points_2d: [
    [190, 479], [571, 479], [524, 319], [238, 319],
  ],
  confidence: 0.7,
};

const { AgentRuntime } = await import('../src/brain/AgentRuntime.js');

/** 실제 1920×1080 단색 JPEG base64(다운스케일 검증용). */
let bigJpegB64 = '';
beforeEach(async () => {
  bigJpegB64 = (
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 30, g: 80, b: 150 } } })
      .jpeg({ quality: 90 })
      .toBuffer()
  ).toString('base64');
});

function cfg(over: Partial<LlmConfig['llm']> = {}): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: {
      provider: 'openai-compatible', model: 'gemma4:12b', baseUrl: 'http://192.168.0.210:11434/v1',
      apiKeyEnv: undefined, temperature: 0.1, maxTokens: 3072, enabled: true, timeoutMs: 30000,
      api: 'ollama', think: false, imageMaxEdge: 960, ...over,
    },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('config/prompts/_archive/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/_archive/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/_archive/stage3_final_report.system.md'),
    },
    floorRoi: { enabled: true, maxPerCheckpoint: 12, prompt: 'config/prompts/_archive/floor_roi.yaml', timeoutMs: 120000 },
    warmup: { enabled: true, keepAlive: '24h', numPredict: 1, timeoutMs: 120000 },
  };
}

/** 네이티브 응답 목: message.content 에 지정 JSON. */
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  createSpy.mockClear();
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ message: { content: JSON.stringify(FLOOR_JSON) } }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function lastFetchBody(): any {
  const [, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(init.body as string);
}
function lastFetchUrl(): string {
  return fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
}

const floorInput: FloorRoiInput = {
  camIdx: 1, presetIdx: 2, imageBase64: '', // beforeEach 에서 실제 JPEG 주입
  vehicle: { x: 0.2, y: 0.3, w: 0.4, h: 0.4 },
};

describe('AgentRuntime chat 라우팅 — 네이티브 /api/chat (api:ollama)', () => {
  it('(a) 네이티브 엔드포인트로 POST, think=false, format=json, images=[b64] 전송', async () => {
    const rt = new AgentRuntime(cfg());
    const res = await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    expect(res).not.toBeNull();
    expect(res!.polygon).toHaveLength(4);

    // OpenAI SDK 는 호출되지 않아야 한다(네이티브 라우팅).
    expect(createSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 엔드포인트: /v1 → /api/chat 유도.
    expect(lastFetchUrl()).toBe('http://192.168.0.210:11434/api/chat');

    const body = lastFetchBody();
    expect(body.model).toBe('gemma4:12b');
    expect(body.stream).toBe(false);
    expect(body.format).toBe('json'); // json 모드
    expect(body.options.num_predict).toBe(3072); // maxTokens → options.num_predict
    expect(body.options.temperature).toBe(0.1);
    // 이미지: messages[user].images = [base64] (image_url 아님)
    const userMsg = body.messages[1];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.images)).toBe(true);
    expect(typeof userMsg.images[0]).toBe('string');
    // image_url 형식이 아님
    expect(JSON.stringify(body)).not.toContain('image_url');
  });

  it('(b) 핵심 회귀: think:false 가 바디에 boolean false 로 전달', async () => {
    const rt = new AgentRuntime(cfg({ think: false }));
    await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    const body = lastFetchBody();
    expect(body.think).toBe(false);
    expect(body.think).not.toBe(undefined); // 누락되면 모델 기본 thinking ON → 회귀
  });

  it('(b2) think:true 지정 시 바디에 true 로 전달', async () => {
    const rt = new AgentRuntime(cfg({ think: true }));
    await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    expect(lastFetchBody().think).toBe(true);
  });

  it('(d) floor 는 smartResize(prepared) 경로 → images[0] 이 28배수 952×532(원본 1920×1080 아님)', async () => {
    const rt = new AgentRuntime(cfg());
    await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    const sentB64 = lastFetchBody().messages[1].images[0] as string;
    // 전송된 base64 는 원본과 달라야 하고(재인코딩), smartResize(960) 결과 952×532(28배수)여야 한다.
    expect(sentB64).not.toBe(bigJpegB64);
    const meta = await sharp(Buffer.from(sentB64, 'base64')).metadata();
    expect(meta.width).toBe(952);
    expect(meta.height).toBe(532);
    expect(meta.width! % 28).toBe(0);
    expect(meta.height! % 28).toBe(0);
  });

  it('네이티브 비200 → null(결정형 폴백), throw 안 함', async () => {
    fetchSpy.mockResolvedValue(new Response('err', { status: 500 }));
    const rt = new AgentRuntime(cfg());
    const res = await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    expect(res).toBeNull();
  });

  it('data.message.content 파싱(choices[] 아님) → FloorRoiResult 반환', async () => {
    const rt = new AgentRuntime(cfg());
    const res = await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    expect(res!.confidence).toBeCloseTo(0.7);
  });
});

describe('AgentRuntime chat 라우팅 — OpenAI SDK (api:openai, 하위호환)', () => {
  it('(c) api:openai → SDK create 호출, 네이티브 fetch 미호출', async () => {
    const rt = new AgentRuntime(cfg({ api: 'openai' }));
    const res = await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    expect(res).not.toBeNull();
    expect(createSpy).toHaveBeenCalledTimes(1);
    // 네이티브 /api/chat fetch 는 호출되지 않음.
    const nativeCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/chat'));
    expect(nativeCalls).toHaveLength(0);
    // SDK 인자: response_format json, 이미지 image_url data URL.
    const args = createSpy.mock.calls[0][0] as any;
    expect(args.response_format).toEqual({ type: 'json_object' });
    const userContent = args.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent.some((p: any) => p.type === 'image_url')).toBe(true);
  });

  it('(c) api:openai 경로도 floor smartResize 적용(image_url 의 base64 가 952×532)', async () => {
    const rt = new AgentRuntime(cfg({ api: 'openai' }));
    await rt.recognizeFloorRoi!({ ...floorInput, imageBase64: bigJpegB64 });
    const args = createSpy.mock.calls[0][0] as any;
    const imgPart = args.messages[1].content.find((p: any) => p.type === 'image_url');
    const dataUrl = imgPart.image_url.url as string;
    const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
    expect(meta.width).toBe(952);
    expect(meta.height).toBe(532);
  });
});
