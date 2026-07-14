import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AgentRuntime } from '../src/brain/AgentRuntime.js';
import { loadLlmConfig, DEFAULT_LLM_CONFIG } from '../src/config/llmConfig.js';
import type { LlmConfig } from '../src/config/llmConfig.js';
import type { OccupancyInput, FloorRoiInput } from '../src/brain/SetupBrain.js';
import { OccupancyResultSchema, OccupancySpaceSchema } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): AgentRuntime.judgeOccupancy (설계서 §3-3, 성공기준 1·3·7).
 * fake OpenAI 호환 서버가 픽셀 points_2d spaces JSON 반환 → 면별 occupied 만 LLM 책임,
 * occupiedCount/total/rate 는 코드가 재계산(LLM 산술 미신뢰), 픽셀→전송(W,H) 정규화는 코드가 흡수.
 * 전송 이미지는 smartResize(imageMaxEdge=960) 로 952×532(28배수·항등) → W=952, H=532.
 */

// 전송 이미지 크기(952×532 원본 → smartResize(edge=960) 항등). 정규화 기준값.
const W = 952;
const H = 532;

let server: Server;
let baseUrl: string;
let lastBody = '';
/** 다음 응답 content(JSON 문자열). 테스트별로 교체. */
let nextContent = '{}';
/** 응답을 지연시켜 per-request 타임아웃 경계를 실증(0=즉시). 테스트별로 교체. */
let nextDelayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastBody = body;
        const send = () =>
          res.end(
            JSON.stringify({
              id: 'x',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: nextContent }, finish_reason: 'stop' }],
            }),
          );
        if (nextDelayMs > 0) setTimeout(send, nextDelayMs);
        else send();
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

/** over: per-request 타임아웃 경계 테스트용 오버라이드(llm.timeoutMs · occupancy.timeoutMs · floorRoi). */
function cfg(
  occEnabled: boolean,
  llmEnabled = true,
  over: { llmTimeoutMs?: number; occTimeoutMs?: number; floorEnabled?: boolean; floorTimeoutMs?: number } = {},
): LlmConfig {
  const pair = (s: string) => ({ system: s, user: s });
  return {
    llm: { provider: 'gemma', model: 'gemma4:12b', baseUrl, temperature: 0.1, maxTokens: 256, enabled: llmEnabled, api: 'openai', think: false, imageMaxEdge: 960, ...(over.llmTimeoutMs !== undefined ? { timeoutMs: over.llmTimeoutMs } : {}) },
    mcp: { enabled: false, transport: 'stdio', servers: [] },
    setupPrompts: {
      stage1Enabled: true, stage2Enabled: true, stage3Enabled: true,
      stage1: pair('config/prompts/stage1_preset_judge.system.md'),
      stage2: pair('config/prompts/stage2_dedupe_label.system.md'),
      stage3: pair('config/prompts/stage3_final_report.system.md'),
    },
    occupancy: { enabled: occEnabled, prompt: 'config/prompts/occupancy.yaml', timeoutMs: over.occTimeoutMs ?? 120000 },
    ...(over.floorEnabled ? { floorRoi: { enabled: true, maxPerCheckpoint: 12, prompt: 'config/prompts/floor_roi.yaml', timeoutMs: over.floorTimeoutMs ?? 120000 } } : {}),
  };
}

/** create(body, opts) 2번째 인자(per-request timeout)를 캡처하는 스파이 부착(callThrough). */
function spyCreate(rt: AgentRuntime) {
  // client 는 private — 경계면(SDK create 2번째 인자) 직접 검증 위해 접근.
  const client = (rt as unknown as { client: { chat: { completions: { create: unknown } } } }).client;
  return vi.spyOn(client.chat.completions, 'create' as never);
}

/** 실제 952×532 단색 JPEG(smartResize·readJpegSize 통과용). smartResize(960) → 항등(W,H). */
let jpegB64 = '';
beforeAll(async () => {
  jpegB64 = (
    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 40, g: 90, b: 160 } } })
      .jpeg({ quality: 90 })
      .toBuffer()
  ).toString('base64');
  input.imageBase64 = jpegB64;
  floorInput.imageBase64 = jpegB64;
});

const input: OccupancyInput = {
  camIdx: 1,
  presetIdx: 2,
  imageBase64: '', // beforeAll 에서 실제 JPEG 주입
  expected: 3,
};

const floorInput: FloorRoiInput = {
  camIdx: 1,
  presetIdx: 2,
  imageBase64: '', // beforeAll 에서 실제 JPEG 주입
  vehicle: { x: 0.2, y: 0.3, w: 0.4, h: 0.4 },
};

describe('AgentRuntime.judgeOccupancy', () => {
  it('occupancy.enabled=false → null(호출 안 함)', async () => {
    const rt = new AgentRuntime(cfg(false));
    expect(await rt.judgeOccupancy!(input)).toBeNull();
  });

  it('llm.enabled=false → null', async () => {
    const rt = new AgentRuntime(cfg(true, false));
    expect(await rt.judgeOccupancy!(input)).toBeNull();
  });

  it('enabled=true → spaces 파싱 후 count/rate 결정형 산출(멀티모달 이미지 전송)', async () => {
    nextContent = JSON.stringify({
      spaces: [{ id: 1, occupied: true }, { id: 2, occupied: false }, { id: 3, occupied: true }],
      confidence: 0.6,
    });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res).not.toBeNull();
    expect(res!.total).toBe(3);
    expect(res!.occupiedCount).toBe(2);
    expect(res!.rate).toBeCloseTo(2 / 3);
    expect(res!.confidence).toBeCloseTo(0.6);
    // 이미지 멀티모달 전송(floor 경로 재사용).
    expect(lastBody).toContain('image_url');
    expect(lastBody).toContain('data:image/jpeg;base64,');
  });

  it('LLM 이 잘못된 rate/총계를 줘도 무시 — 코드가 spaces 로 재계산(성공기준 7)', async () => {
    // LLM 이 rate=0.99, total=100 같은 헛소리를 섞어도 스키마가 무시하고 spaces 로만 산술.
    nextContent = JSON.stringify({
      spaces: [{ id: 1, occupied: true }, { id: 2, occupied: false }],
      rate: 0.99, total: 100, occupiedCount: 77, // ← 신뢰 금지(스키마에 없어 strip)
      confidence: 0.5,
    });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res!.total).toBe(2); // spaces.length
    expect(res!.occupiedCount).toBe(1); // occupied=true 개수
    expect(res!.rate).toBeCloseTo(0.5); // 1/2, LLM 의 0.99 무시
  });

  it('빈 spaces → total=0, rate=0(0으로 나눔 방지)', async () => {
    nextContent = JSON.stringify({ spaces: [], confidence: 0.1 });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res!.total).toBe(0);
    expect(res!.occupiedCount).toBe(0);
    expect(res!.rate).toBe(0);
  });

  it('points_2d(픽셀) → 전송(W,H) 기준 정규화 폴리곤 보존(성공기준 1·3)', async () => {
    // 픽셀 4코너 → 정규화 기대 = px/W, py/H.
    const pts: [number, number][] = [
      [95, 266],
      [286, 266],
      [286, 186],
      [95, 186],
    ];
    nextContent = JSON.stringify({
      spaces: [{ id: 1, occupied: true, points_2d: pts }],
      confidence: 0.7,
    });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    const poly = res!.spaces[0].polygon!;
    expect(poly).toHaveLength(4);
    poly.forEach((p, i) => {
      expect(p.x).toBeCloseTo(pts[i][0] / W, 5);
      expect(p.y).toBeCloseTo(pts[i][1] / H, 5);
    });
  });

  it('points_2d 미보유 면 graceful — polygon undefined + 집계는 포함(성공기준 3)', async () => {
    nextContent = JSON.stringify({
      spaces: [{ id: 1, occupied: true, points_2d: [[95, 266], [286, 266], [286, 186], [95, 186]] }, { id: 2, occupied: false }],
      confidence: 0.6,
    });
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res!.total).toBe(2); // 폴리곤 미보유 면도 집계 포함
    expect(res!.occupiedCount).toBe(1);
    expect(res!.spaces[0].polygon).toHaveLength(4); // 보유 면
    expect(res!.spaces[1].polygon).toBeUndefined(); // 미보유 면 graceful skip
  });
});

/**
 * B · guided JSON off (jsonMode=false) — 설계 §2【B】, §7 T-2.
 * judgeOccupancy 는 chatJson 6번째 인자 jsonMode=false 로 호출 → chatOpenai 가 create body 에
 * response_format:{json_object} 를 **넣지 않는다**. 대신 extractJson 이 코드펜스·산문 섞인 응답을 회수한다.
 * 경계면 교차: SDK create 1번째 인자(body) + fake 서버가 받은 와이어 원문(lastBody) 둘 다에서 부재 확인.
 */
describe('B · guided JSON off — response_format 미전송 + extractJson 회수 (T-2)', () => {
  // 픽셀 points_2d(전송 952×532) → 정규화 기대 폴리곤.
  const pts: [number, number][] = [
    [95, 266],
    [286, 266],
    [286, 186],
    [95, 186],
  ];
  const polygon = pts.map(([px, py]) => ({ x: px / W, y: py / H }));
  const validJson = { spaces: [{ id: 1, occupied: true, points_2d: pts }, { id: 2, occupied: false }], confidence: 0.7 };

  it('occupancy create body 에 response_format 부재(guided off) + 와이어 원문에도 없음', async () => {
    nextContent = JSON.stringify(validJson);
    const rt = new AgentRuntime(cfg(true));
    const createSpy = spyCreate(rt);
    const res = await rt.judgeOccupancy!(input);
    expect(res).not.toBeNull();
    // SDK create 1번째 인자(body)에 response_format 키 자체가 없어야 함(스프레드 미포함).
    const body = (createSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect('response_format' in body).toBe(false);
    // 와이어 레벨(fake 서버 수신 원문 JSON)에도 response_format 문자열 없음.
    expect(lastBody).not.toContain('response_format');
  });

  it('대조: floor(recognizeFloorRoi)는 jsonMode 기본 true → response_format 전송(occupancy 만 off 임을 입증)', async () => {
    // floor RAW 는 픽셀 points_2d(전송 952×532).
    nextContent = JSON.stringify({
      points_2d: [[95, 53], [190, 53], [190, 106], [95, 106]],
      confidence: 0.5,
    });
    const rt = new AgentRuntime(cfg(true, true, { floorEnabled: true }));
    const createSpy = spyCreate(rt);
    await rt.recognizeFloorRoi!(floorInput);
    const body = (createSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(lastBody).toContain('response_format');
  });

  it('코드펜스(```json … ```)로 감싼 응답도 extractJson 이 회수 → spaces 파싱 성공', async () => {
    nextContent = '```json\n' + JSON.stringify(validJson) + '\n```';
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.occupiedCount).toBe(1);
    expect(res!.spaces[0].polygon).toEqual(polygon);
  });

  it('산문 머리말 + JSON 섞인 자유형 응답도 회수', async () => {
    nextContent = '분석 결과는 다음과 같습니다:\n' + JSON.stringify(validJson) + '\n감사합니다.';
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.occupiedCount).toBe(1);
  });

  it('회수 불가(JSON 객체 부재) → 2회 재시도 후 null(graceful skip · 잡 미중단)', async () => {
    nextContent = 'JSON 없음 죄송합니다';
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res).toBeNull();
  });
});

/**
 * #1 · OBB polygon 스키마 직접 검증 — 설계 §2【#1】, §7 T-1 확장.
 * OccupancySpaceSchema: id(int·필수)·occupied(필수)·polygon(4점 {x,y} optional), box 제거.
 * OccupancyResultSchema.parse 가 polygon/무polygon/거부(길이≠4)를 정확히 처리.
 */
describe('#1 · OccupancySpaceSchema polygon 4점 스키마 (T-1)', () => {
  const poly4 = [
    { x: 0.1, y: 0.5 },
    { x: 0.3, y: 0.5 },
    { x: 0.3, y: 0.35 },
    { x: 0.1, y: 0.35 },
  ];

  it('polygon 4점 통과 + 왕복 보존', () => {
    const parsed = OccupancyResultSchema.parse({ spaces: [{ id: 1, occupied: true, polygon: poly4 }], confidence: 0.6 });
    expect(parsed.spaces[0].polygon).toEqual(poly4);
  });

  it('polygon 없는 면도 통과(optional) → polygon undefined', () => {
    const parsed = OccupancyResultSchema.parse({ spaces: [{ id: 1, occupied: false }] });
    expect(parsed.spaces[0].polygon).toBeUndefined();
    expect(parsed.spaces[0].occupied).toBe(false);
  });

  it('polygon 3점 거부(.length(4))', () => {
    expect(() => OccupancySpaceSchema.parse({ id: 1, occupied: true, polygon: poly4.slice(0, 3) })).toThrow();
  });

  it('polygon 5점 거부(.length(4))', () => {
    expect(() => OccupancySpaceSchema.parse({ id: 1, occupied: true, polygon: [...poly4, { x: 0.5, y: 0.5 }] })).toThrow();
  });

  it('occupied 누락 거부(필수)', () => {
    expect(() => OccupancySpaceSchema.parse({ id: 1, polygon: poly4 })).toThrow();
  });

  it('id 누락 거부(필수 int)', () => {
    expect(() => OccupancySpaceSchema.parse({ occupied: true, polygon: poly4 })).toThrow();
  });

  it('구 box 필드 제거됨 — box 전달 시 strip(무시), polygon undefined', () => {
    const parsed = OccupancySpaceSchema.parse({ id: 1, occupied: true, box: { x: 0, y: 0, w: 0.1, h: 0.1 } });
    expect(parsed.polygon).toBeUndefined();
    expect((parsed as Record<string, unknown>).box).toBeUndefined();
  });

  it('집계(judgeOccupancy 산술) — total=spaces.length·occupiedCount=occupied 필터·rate 정확(polygon 유무 무관)', () => {
    const parsed = OccupancyResultSchema.parse({
      spaces: [{ id: 1, occupied: true, polygon: poly4 }, { id: 2, occupied: false }, { id: 3, occupied: true }],
      confidence: 0.5,
    });
    const total = parsed.spaces.length;
    const occupiedCount = parsed.spaces.filter((s) => s.occupied).length;
    expect(total).toBe(3);
    expect(occupiedCount).toBe(2);
    expect(occupiedCount / total).toBeCloseTo(2 / 3);
  });
});

/**
 * per-request 타임아웃 격리(설계 §3~4, §7 T1~T4). 지연 응답 fake 서버로:
 *  - occupancy 만 occupancy.timeoutMs 를 create 2번째 인자 {timeout} 로 사용(길게)
 *  - floor(및 그 외)는 per-call 미전달 → 전역 클라이언트 timeout 유지(짧으면 타임아웃)
 * 을 결정적으로 실증한다(실 vLLM 시간 검증은 리더 라이브 스모크 — 유닛 범위 밖).
 */
describe('AgentRuntime per-request 타임아웃 격리 (T1~T4)', () => {
  const spacesJson = JSON.stringify({ spaces: [{ id: 1, occupied: true }, { id: 2, occupied: false }], confidence: 0.5 });

  it('T1: occupancy 는 occupancy.timeoutMs(2000)를 per-request 로 사용 → 전역(50ms)보다 길어 지연(300ms) 응답 수용 + create 2번째 인자 {timeout:2000}', async () => {
    nextContent = spacesJson;
    nextDelayMs = 300;
    const rt = new AgentRuntime(cfg(true, true, { llmTimeoutMs: 50, occTimeoutMs: 2000 }));
    const createSpy = spyCreate(rt);
    const res = await rt.judgeOccupancy!(input);
    nextDelayMs = 0;
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.occupiedCount).toBe(1);
    // 경계면 교차: SDK create(body, { timeout }) 2번째 인자에 occupancy 전용 값 전달.
    expect(createSpy).toHaveBeenCalled();
    expect((createSpy.mock.calls[0] as unknown[])[1]).toEqual({ timeout: 2000 });
  });

  it('T2(회귀 핵심): floor(recognizeFloorRoi)는 floorRoi.timeoutMs 를 per-call 로 사용 → 자기 값(50ms)이 짧으면 지연(300ms)에서 타임아웃, create 2번째 인자 {timeout:50}(전역 5000 무관)', async () => {
    nextContent = spacesJson; // 내용 무관 — 타임아웃이 먼저.
    nextDelayMs = 300;
    // 전역 5000ms 로 넉넉하되 floorRoi.timeoutMs=50ms 로 짧게 → floor 는 자기 값으로 타임아웃(격리 입증).
    const rt = new AgentRuntime(cfg(true, true, { llmTimeoutMs: 5000, occTimeoutMs: 2000, floorEnabled: true, floorTimeoutMs: 50 }));
    const createSpy = spyCreate(rt);
    await expect(rt.recognizeFloorRoi!(floorInput)).rejects.toThrow();
    nextDelayMs = 0;
    // 경계면 교차: floor 는 2번째 인자 {timeout:50}(floorRoi 전용 per-call) → 전역/occupancy 와 격리.
    expect((createSpy.mock.calls[0] as unknown[])[1]).toEqual({ timeout: 50 });
  });

  it('T3: occupancy.timeoutMs 가 짧으면(50ms) occupancy 도 타임아웃 throw(전역 5000 무관 — 자기 값 사용, chatJson try 밖 await 예외 전파)', async () => {
    nextContent = spacesJson;
    nextDelayMs = 300;
    const rt = new AgentRuntime(cfg(true, true, { llmTimeoutMs: 5000, occTimeoutMs: 50 }));
    await expect(rt.judgeOccupancy!(input)).rejects.toThrow();
    nextDelayMs = 0;
  });

  it('T4(회귀): 지연 0 + 기본 occupancy.timeoutMs(120000) → 정상 파싱(기존 동작 불변)', async () => {
    nextContent = spacesJson;
    nextDelayMs = 0;
    const rt = new AgentRuntime(cfg(true));
    const res = await rt.judgeOccupancy!(input);
    expect(res!.total).toBe(2);
    expect(res!.occupiedCount).toBe(1);
  });
});

/** occupancy.timeoutMs config 기본값·하위호환(설계 §7 T5). */
describe('occupancy.timeoutMs config 기본값·하위호환 (T5)', () => {
  it('DEFAULT_LLM_CONFIG.occupancy.timeoutMs === 120000', () => {
    expect(DEFAULT_LLM_CONFIG.occupancy?.timeoutMs).toBe(120000);
  });

  it('config/llm.config.json 로드 → occupancy.timeoutMs === 300000(파일 명시·다면 프리셋 5분)', () => {
    expect(loadLlmConfig('config/llm.config.json').occupancy?.timeoutMs).toBe(300000);
  });

  it('하위호환: occupancy.timeoutMs 생략 json → default 120000 채움', () => {
    const p = join(tmpdir(), `occ_no_timeout_${Date.now()}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        llm: { provider: 'qwen3', model: 'm', baseUrl: 'http://localhost:1/v1', temperature: 0.1, maxTokens: 64, enabled: false },
        occupancy: { enabled: true, prompt: 'config/prompts/occupancy.yaml' }, // timeoutMs 없음
      }),
    );
    const c = loadLlmConfig(p);
    expect(c.occupancy?.timeoutMs).toBe(120000);
  });
});
