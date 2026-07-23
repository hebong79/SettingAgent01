import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import {
  parseOr400,
  fileErrorReply,
  parseCamPreset,
  sendJpeg,
  resolveSourceCamera,
} from '../src/api/routeHelpers.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): routeHelpers 순수 유닛테스트(리팩토링 1단계).
 * FastifyReply 를 code()/header()/send() 만 기록하는 최소 목으로 대체하고,
 * 각 헬퍼가 기존 호출부 응답(상태코드·JSON 필드·에러 메시지·헤더)을 그대로 재현하는지 검증한다.
 */

interface MockReply {
  statusCode?: number;
  sent?: unknown;
  headers: Record<string, string>;
  code(n: number): MockReply;
  header(k: string, v: string): MockReply;
  send(body: unknown): MockReply;
}

function mockReply(): MockReply {
  const r: MockReply = {
    headers: {},
    code(n: number) {
      r.statusCode = n;
      return r;
    },
    header(k: string, v: string) {
      r.headers[k] = v;
      return r;
    },
    send(body: unknown) {
      r.sent = body;
      return r;
    },
  };
  return r;
}

/** 헬퍼는 FastifyReply 를 요구하므로 목을 그 타입으로 통과시킨다(테스트 전용 캐스팅). */
const asReply = (r: MockReply): FastifyReply => r as unknown as FastifyReply;

const cameraCfg: ToolsConfig['camera'] = {
  baseUrl: 'http://localhost:13100',
  imageTimeoutMs: 7000,
  moveTimeoutMs: 3000,
  zoomMin: 1.0,
  zoomMax: 36.0,
};

/** CameraSourceClient 조립에 필요한 최소 CameraSource 목(centerOnPoint 미보유). */
function fakeSource(): CameraSource {
  return { kind: 'sim' } as unknown as CameraSource;
}

describe('parseOr400', () => {
  const Schema = z.object({ count: z.number().int().positive() });

  it('유효 입력 → 파싱값 반환, 응답 미전송', () => {
    const r = mockReply();
    const out = parseOr400(asReply(r), Schema, { count: 3 });
    expect(out).toEqual({ count: 3 });
    expect(r.statusCode).toBeUndefined();
    expect(r.sent).toBeUndefined();
  });

  it('무효 입력 → 400 + { error:"invalid body", detail: flatten } 전송, undefined 반환', () => {
    const r = mockReply();
    const out = parseOr400(asReply(r), Schema, { count: -1 });
    expect(out).toBeUndefined();
    expect(r.statusCode).toBe(400);
    const body = r.sent as { error: string; detail: unknown };
    expect(body.error).toBe('invalid body');
    expect(body.detail).toEqual(Schema.safeParse({ count: -1 }).error!.flatten());
  });

  it('errorMsg 인자 → 응답 error 문자열 대체(viewer 의 "invalid query" 재현)', () => {
    const r = mockReply();
    parseOr400(asReply(r), Schema, { count: 0 }, 'invalid query');
    expect((r.sent as { error: string }).error).toBe('invalid query');
  });
});

describe('fileErrorReply', () => {
  it('ENOENT → 404 + notFoundMsg + detail(err.message)', () => {
    const r = mockReply();
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    fileErrorReply(asReply(r), err, 'PtzCamRoi.json 없음', 'ground-model 산출 실패');
    expect(r.statusCode).toBe(404);
    expect(r.sent).toEqual({ error: 'PtzCamRoi.json 없음', detail: 'no such file' });
  });

  it('그 외 에러 → 500 + failMsg + detail(err.message)', () => {
    const r = mockReply();
    const err = Object.assign(new Error('parse boom'), { code: 'EACCES' });
    fileErrorReply(asReply(r), err, 'PtzCamRoi.json 없음', '읽기/파싱 실패');
    expect(r.statusCode).toBe(500);
    expect(r.sent).toEqual({ error: '읽기/파싱 실패', detail: 'parse boom' });
  });

  it('code 없는 에러 → 500(비-ENOENT 취급)', () => {
    const r = mockReply();
    fileErrorReply(asReply(r), new Error('plain'), 'nf', 'fail');
    expect(r.statusCode).toBe(500);
    expect((r.sent as { error: string }).error).toBe('fail');
  });
});

describe('parseCamPreset', () => {
  it('정상 1-based 정수 → { cam, preset } 반환', () => {
    const r = mockReply();
    const out = parseCamPreset(asReply(r), { cam: '2', preset: '3' });
    expect(out).toEqual({ cam: 2, preset: 3 });
    expect(r.statusCode).toBeUndefined();
  });

  it('cam=0 거부 → 400 + "invalid cam/preset (1-based 정수)"', () => {
    const r = mockReply();
    const out = parseCamPreset(asReply(r), { cam: '0', preset: '1' });
    expect(out).toBeUndefined();
    expect(r.statusCode).toBe(400);
    expect(r.sent).toEqual({ error: 'invalid cam/preset (1-based 정수)' });
  });

  it('음수 preset 거부 → 400', () => {
    const r = mockReply();
    expect(parseCamPreset(asReply(r), { cam: '1', preset: '-2' })).toBeUndefined();
    expect(r.statusCode).toBe(400);
  });

  it('비정수 거부 → 400', () => {
    const r = mockReply();
    expect(parseCamPreset(asReply(r), { cam: '1.5', preset: '2' })).toBeUndefined();
    expect(r.statusCode).toBe(400);
  });

  it('미지정(undefined) 거부 → 400(NaN)', () => {
    const r = mockReply();
    expect(parseCamPreset(asReply(r), {})).toBeUndefined();
    expect(r.statusCode).toBe(400);
  });
});

describe('sendJpeg', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);

  it('Content-Type + Cache-Control + 전달 헤더 세팅 후 jpeg 전송', () => {
    const r = mockReply();
    sendJpeg(asReply(r), jpeg, {
      'X-Cap-Cam': '1',
      'X-Cap-Preset': '2',
      'X-Cap-Round': '0',
    });
    expect(r.headers['Content-Type']).toBe('image/jpeg');
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(r.headers['X-Cap-Cam']).toBe('1');
    expect(r.headers['X-Cap-Preset']).toBe('2');
    expect(r.headers['X-Cap-Round']).toBe('0');
    expect(r.sent).toBe(jpeg);
  });

  it('헤더 인자 없이도 기본 두 헤더 세팅 후 전송', () => {
    const r = mockReply();
    sendJpeg(asReply(r), jpeg);
    expect(r.headers['Content-Type']).toBe('image/jpeg');
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(r.sent).toBe(jpeg);
  });
});

describe('resolveSourceCamera', () => {
  it('sourceId 미지정 → { camera: undefined, src: undefined }, 응답 미전송', () => {
    const r = mockReply();
    const out = resolveSourceCamera({ sources: new Map(), cameraCfg }, undefined, asReply(r));
    expect(out).toEqual({ camera: undefined, src: undefined });
    expect(r.statusCode).toBeUndefined();
  });

  it('sourceId 지정·해석 → CameraSourceClient + src 반환', () => {
    const src = fakeSource();
    const sources = new Map([['unity', src]]);
    const r = mockReply();
    const out = resolveSourceCamera({ sources, cameraCfg }, 'unity', asReply(r));
    expect(out).toBeDefined();
    expect(out!.src).toBe(src);
    expect(out!.camera).toBeDefined();
    // clampZoom 은 cameraCfg 를 사용 — 조립이 정상임을 간접 확인.
    expect(out!.camera!.clampZoom(100)).toBe(36);
    expect(r.statusCode).toBeUndefined();
  });

  it('sourceId 지정·미해석 → 400 + "source not found", undefined 반환', () => {
    const r = mockReply();
    const out = resolveSourceCamera({ sources: new Map(), cameraCfg }, 'ghost', asReply(r));
    expect(out).toBeUndefined();
    expect(r.statusCode).toBe(400);
    expect(r.sent).toEqual({ error: 'source not found' });
  });

  it('cameraCfg 미주입 → src 해석 차단, 400', () => {
    const src = fakeSource();
    const sources = new Map([['unity', src]]);
    const r = mockReply();
    const out = resolveSourceCamera({ sources }, 'unity', asReply(r));
    expect(out).toBeUndefined();
    expect(r.statusCode).toBe(400);
    expect(r.sent).toEqual({ error: 'source not found' });
  });
});
