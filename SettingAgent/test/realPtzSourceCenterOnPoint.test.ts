import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';
import type { Ptz } from '../src/viewer/CameraSource.js';

/**
 * 검증자(qa-tester): RealPtzSource.centerOnPoint — 설계서 §1(c)·§2 테스트 계획 4번.
 *
 * 휴컴스 네이티브 `ptz_centering.cgi?action=setcenter&type=point`. 검증 축:
 *   1. 정규화(0~1) → 픽셀 변환: (0.5,0.5) → (960,540), 기준 해상도 1920×1080 고정.
 *   2. type='point'(box 아님) — pan/tilt 만 움직이는 사양.
 *   3. 범위 clamp: 0 미만/1 초과 클릭도 0~1920 / 0~1080 안으로(HucomsClient range 검증이 throw 하지 않음).
 *   4. setcenter 는 PTZ echo 가 없으므로 이후 장비 PTZ 조회(getptzfpos)로 확정해 반환.
 *
 * 두 층위로 본다: (A) HucomsClient 스텁 주입 = 인자 계약, (B) 실제 HTTP 서버 = 와이어 파라미터명.
 *
 * ★ 라이브 한계(은닉 금지): 실장비(192.168.0.153)는 미선택 상태라 물리 센터링 정확도·
 *   스트림 해상도가 1920×1080 이 아닐 때의 오차는 여기서 검증되지 않는다.
 */

type CenterPtzArg = Parameters<
  NonNullable<{ centerPtz(o: { type: 'point'; pointX: number; pointY: number; speed?: number }): Promise<unknown> }['centerPtz']>
>[0];

/** RealPtzSource 의 private client 를 스텁으로 치환(생성자 내부 생성이라 주입구가 없다). */
function stubClient(source: RealPtzSource) {
  const centerCalls: CenterPtzArg[] = [];
  let ptzCalls = 0;
  const stub = {
    centerPtz: async (o: CenterPtzArg) => { centerCalls.push(o); return { values: {} }; },
    getPtzfPosition: async () => {
      ptzCalls += 1;
      // 원시 PTZF(0~35999 / -2000~9000 / 0~65535) → Viewer 좌표계로 변환되어 반환돼야 한다.
      return { values: { panpos: '17999', tiltpos: '3500', zoompos: '32767' } };
    },
  };
  Reflect.set(source, 'client', stub);
  return { centerCalls, ptzCalls: () => ptzCalls };
}

/**
 * 정착 폴링 타이밍 주입(수정 8 이후). centerOnPoint 는 이제 "정지 확인"까지 기다리므로
 * 기본값(150ms×7폴)이면 케이스마다 1초씩 실시간 대기가 붙는다 — 검증 대상은 인자 계약이라 주기를 0 으로 낮춘다.
 */
const fastSettle = { pollMs: 0, timeoutMs: 200, sleep: async (): Promise<void> => {} };

const stubCfg: CameraSourceConfig = {
  id: 'ptz1', kind: 'hucoms', host: '127.0.0.1', port: 1,
  ptz: { panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 65535] },
};

// ── (A) HucomsClient 스텁 — 인자 계약 ───────────────────────────────────────────
describe('RealPtzSource.centerOnPoint — 정규화→픽셀 변환(스텁)', () => {
  it('(0.5,0.5) → center.pointX/Y = 960/540, type="point", centerPtz 1회', async () => {
    const source = new RealPtzSource(stubCfg, 7000, undefined, fastSettle);
    const spy = stubClient(source);
    await source.centerOnPoint(1, { x: 0.5, y: 0.5 });
    expect(spy.centerCalls).toHaveLength(1);
    expect(spy.centerCalls[0]).toEqual({ type: 'point', pointX: 960, pointY: 540, speed: 50 });
  });

  it('일반 지점: 1920×1080 선형 매핑 + 정수 반올림', async () => {
    const source = new RealPtzSource(stubCfg, 7000, undefined, fastSettle);
    const spy = stubClient(source);
    await source.centerOnPoint(1, { x: 0.117, y: 0.69 }); // 리더 라이브 검증 클릭 좌표.
    expect(spy.centerCalls[0].pointX).toBe(Math.round(0.117 * 1920)); // 224.64 → 225
    expect(spy.centerCalls[0].pointY).toBe(Math.round(0.69 * 1080));  // 745.2 → 745
    expect(Number.isInteger(spy.centerCalls[0].pointX)).toBe(true);   // range() 가 정수만 허용.
    expect(Number.isInteger(spy.centerCalls[0].pointY)).toBe(true);
  });

  it('경계: (0,0)→(0,0), (1,1)→(1920,1080)', async () => {
    const source = new RealPtzSource(stubCfg, 7000, undefined, fastSettle);
    const spy = stubClient(source);
    await source.centerOnPoint(1, { x: 0, y: 0 });
    await source.centerOnPoint(1, { x: 1, y: 1 });
    expect(spy.centerCalls[0]).toMatchObject({ pointX: 0, pointY: 0 });
    expect(spy.centerCalls[1]).toMatchObject({ pointX: 1920, pointY: 1080 });
  });

  it('범위 밖 클릭 clamp: 음수·1 초과는 0/최대로 접힘(HucomsValidationError 미발생)', async () => {
    const source = new RealPtzSource(stubCfg, 7000, undefined, fastSettle);
    const spy = stubClient(source);
    await source.centerOnPoint(1, { x: -0.4, y: 1.9 });
    expect(spy.centerCalls[0]).toMatchObject({ pointX: 0, pointY: 1080 });
    await source.centerOnPoint(1, { x: 3, y: -2 });
    expect(spy.centerCalls[1]).toMatchObject({ pointX: 1920, pointY: 0 });
  });

  it('setcenter 후 PTZ 조회로 확정해 Viewer 좌표계 Ptz 반환(echo 없음 → 장비 조회 위임)', async () => {
    const source = new RealPtzSource(stubCfg, 7000, undefined, fastSettle);
    const spy = stubClient(source);
    const ptz: Ptz = await source.centerOnPoint(1, { x: 0.3, y: 0.7 });
    // 수정 8: setcenter 후 "정지 확인" 폴링이 추가돼 조회는 여러 번 일어난다.
    // 이 케이스의 계약은 "echo 가 없으니 **장비 조회로 확정**한다"이지 "정확히 1회"가 아니다.
    expect(spy.ptzCalls()).toBeGreaterThanOrEqual(1);
    expect(ptz.pan).toBeCloseTo(0, 1);   // 17999/35999 → 중앙 → 0°
    expect(ptz.tilt).toBeCloseTo(0, 1);  // 3500 ∈ [-2000,9000] 중앙 → 0°
    expect(ptz.zoom).toBeCloseTo(18.5, 1);
  });

  it('centerPtz 실패는 삼키지 않고 전파(조용한 강등 금지)', async () => {
    const source = new RealPtzSource(stubCfg, 7000, undefined, fastSettle);
    Reflect.set(source, 'client', {
      centerPtz: async () => { throw new Error('setcenter http 500'); },
      getPtzfPosition: async () => ({ values: {} }),
    });
    await expect(source.centerOnPoint(1, { x: 0.5, y: 0.5 })).rejects.toThrow(/setcenter http 500/);
  });
});

// ── (B) 실 HTTP 서버 — 와이어 파라미터명(경계면 교차) ─────────────────────────────
let server: Server;
let seen: Array<{ path: string; query: URLSearchParams }>;
let host: string;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://camera.local');
    seen.push({ path: url.pathname, query: url.searchParams });
    response.setHeader('content-type', 'text/plain');
    if (url.pathname === '/cgi-bin/control/ptzf_status.cgi') {
      response.end('panpos = 17999\ntiltpos = 3500\nzoompos = 32767\n');
      return;
    }
    response.end(''); // ptz_centering.cgi 는 본문 없는 200.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = '127.0.0.1';
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { seen = []; });

describe('RealPtzSource.centerOnPoint — 와이어 계약(실 HTTP)', () => {
  it('/cgi-bin/control/ptz_centering.cgi?action=setcenter&type=point&center.pointx/y, 이후 getptzfpos', async () => {
    const source = new RealPtzSource({ ...stubCfg, host, port });
    const ptz = await source.centerOnPoint(1, { x: 0.5, y: 0.5 });

    const center = seen.find((s) => s.path === '/cgi-bin/control/ptz_centering.cgi');
    expect(center).toBeDefined();
    expect(center!.query.get('action')).toBe('setcenter');
    expect(center!.query.get('type')).toBe('point');
    expect(center!.query.get('center.pointx')).toBe('960');
    expect(center!.query.get('center.pointy')).toBe('540');
    expect(center!.query.get('speed')).toBe('50');
    // box 타입 파라미터는 섞이지 않는다(pan/tilt 전용 사양).
    expect(center!.query.get('center.startx')).toBeNull();
    // setcenter 다음에 PTZ 조회가 이어져야 반환 ptz 가 확정값이다.
    const centerIdx = seen.findIndex((s) => s.path === '/cgi-bin/control/ptz_centering.cgi');
    const posIdx = seen.findIndex((s) => s.query.get('action') === 'getptzfpos');
    expect(posIdx).toBeGreaterThan(centerIdx);
    expect(ptz.zoom).toBeCloseTo(18.5, 1);
  });
});
