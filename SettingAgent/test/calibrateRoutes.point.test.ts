import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCalibrateRoutes } from '../src/api/calibrateRoutes.js';
import type { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import type { Ptz } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): POST /calibrate/point (개별·클릭 센터라이징 라우트, 설계서 §5-B).
 *
 * calibrator.centerOnPoint 를 스파이로 목킹해 라우트의 얇은 진입점(파싱·매핑·에러코드)만 검증.
 * 경계면 교차: 프론트 body {cam,preset,point:{x,y},zoom} ↔ PointBodySchema, 반환 타입 ↔ 200 응답 shape.
 */

interface PointCall { cam: number; preset: number; point: { x: number; y: number }; opts?: { zoom?: boolean } }

/** centerOnPoint 스파이 calibrator 조립. impl 로 반환/throw 를 제어하고 calls 로 전달 인자를 교차 검증. */
function makeApp(
  impl: (c: PointCall) => Promise<{ ok: boolean; ptz: Ptz; plateWidth: number | null; reason?: string }>,
) {
  const calls: PointCall[] = [];
  const calibrator = {
    centerOnPoint: async (cam: number, preset: number, point: { x: number; y: number }, opts?: { zoom?: boolean }) => {
      calls.push({ cam, preset, point, opts });
      return impl({ cam, preset, point, opts });
    },
    getStatus: () => ({ state: 'idle', done: 0, total: 0 }),
    getLastFrame: () => undefined,
  } as unknown as PtzCalibrator;
  const app = Fastify({ logger: false });
  registerCalibrateRoutes(app, { calibrator, outFile: 'data/slot_ptz.json' });
  return { app, calls };
}

const okPtz: Ptz = { pan: 11, tilt: 21, zoom: 4 };

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });

describe('POST /calibrate/point — 정상 (§5-B-1)', () => {
  it('정상 body → 200 + {ok, ptz, plateWidth} (centerOnPoint 반환 그대로 매핑)', async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.42, y: 0.58 }, zoom: true } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ ok: true, ptz: okPtz, plateWidth: 0.2 });
    // 경계면: 라우트가 body 를 그대로 centerOnPoint(cam,preset,point,{zoom}) 로 전달.
    expect(built.calls[0]).toEqual({ cam: 1, preset: 1, point: { x: 0.42, y: 0.58 }, opts: { zoom: true } });
  });

  it('reason 있는 반환 → 응답에 reason 포함(정직 전파)', async () => {
    const built = makeApp(async () => ({ ok: false, ptz: okPtz, plateWidth: null, reason: 'no_plate' }));
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 } } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: false, ptz: okPtz, plateWidth: null, reason: 'no_plate' });
  });

  it('zoom 생략 → opts.zoom=undefined 전달(스키마 optional)', async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
    app = built.app;
    await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 } } });
    expect(built.calls[0].opts).toEqual({ zoom: undefined });
  });
});

describe('POST /calibrate/point — 잘못된 body → 400 (§5-B-2)', () => {
  // payload 타입은 object(모든 bad 케이스가 객체 리터럴) — Fastify inject 의 InjectPayload(=string|object|Buffer|Stream)에
  // 정합해 tsc TS2322/2339/2345 3에러 제거(런타임 무변경, 테스트 코드 타입 정합만).
  const bad: Array<{ name: string; payload: object }> = [
    { name: 'point 누락', payload: { cam: 1, preset: 1 } },
    { name: 'cam 문자열', payload: { cam: '1', preset: 1, point: { x: 0.4, y: 0.5 } } },
    { name: 'cam 음수', payload: { cam: -1, preset: 1, point: { x: 0.4, y: 0.5 } } },
    { name: 'preset 소수', payload: { cam: 1, preset: 1.5, point: { x: 0.4, y: 0.5 } } },
    { name: 'point.x 누락', payload: { cam: 1, preset: 1, point: { y: 0.5 } } },
    { name: 'point.x 문자열', payload: { cam: 1, preset: 1, point: { x: 'a', y: 0.5 } } },
    { name: 'zoom 문자열', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 }, zoom: 'yes' } },
    { name: '빈 body', payload: {} },
  ];
  for (const { name, payload } of bad) {
    it(`${name} → 400, centerOnPoint 미호출`, async () => {
      const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
      app = built.app;
      const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe('invalid body');
      expect(built.calls).toHaveLength(0); // 파싱 실패 → calibrator 진입 안 함.
    });
  }
});

describe('POST /calibrate/point — throw 매핑 (§5-B-3)', () => {
  it("'calibrate already running' throw → 409", async () => {
    const built = makeApp(async () => { throw new Error('calibrate already running'); });
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 } } });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toMatch(/running/);
  });

  it("'point centering busy' throw → 409", async () => {
    const built = makeApp(async () => { throw new Error('point centering busy'); });
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 } } });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toMatch(/busy/);
  });

  it('그 외 throw → 400', async () => {
    const built = makeApp(async () => { throw new Error('camera offline'); });
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 } } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('camera offline');
  });
});

describe('POST /calibrate/point — mode 분기 (§5-B mode)', () => {
  // 회귀 가드: 폐기된 클릭지점 조준(mode:'point')은 스키마에서 제거 — 400 이어야 한다.
  it("mode:'point'(폐기) → 400, centerOnPoint 미호출", async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.42, y: 0.58 }, mode: 'point' } });
    expect(r.statusCode).toBe(400);
    expect(built.calls).toHaveLength(0);
  });

  it("mode:'plate-zoom' → centerOnPoint({zoom:true}), 200 {ok,ptz,plateWidth}", async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 }, mode: 'plate-zoom' } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, ptz: okPtz, plateWidth: 0.2 });
    expect(built.calls[0].opts).toEqual({ zoom: true });
  });

  it("mode:'plate' → centerOnPoint({zoom:false})", async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: null }));
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 }, mode: 'plate' } });
    expect(r.statusCode).toBe(200);
    expect(built.calls[0].opts).toEqual({ zoom: false });
  });

  it("legacy mode 미전달 + zoom:true → centerOnPoint({zoom:true}) (하위호환)", async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
    app = built.app;
    await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 }, zoom: true } });
    expect(built.calls[0].opts).toEqual({ zoom: true });
  });

  it("legacy mode 미전달 + zoom:false → centerOnPoint({zoom:false}) (하위호환)", async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.05 }));
    app = built.app;
    await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 }, zoom: false } });
    expect(built.calls[0].opts).toEqual({ zoom: false });
  });

  it('잘못된 mode 값 → 400, 어느 메서드도 미호출', async () => {
    const built = makeApp(async () => ({ ok: true, ptz: okPtz, plateWidth: 0.2 }));
    app = built.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { cam: 1, preset: 1, point: { x: 0.4, y: 0.5 }, mode: 'foo' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid body');
    expect(built.calls).toHaveLength(0);
  });
});
