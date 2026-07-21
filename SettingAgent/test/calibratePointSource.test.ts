import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCalibrateRoutes } from '../src/api/calibrateRoutes.js';
import type { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { CameraSource, Ptz } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * POST /calibrate/point 의 `source` 위임(뷰어가 보고 있는 소스 = 명령 대상).
 *
 * 배경: /calibrate/* 는 부팅 시 selectedCameraId 로 **고정된** 카메라 하나만 쓴다. 뷰어에서 실카를 보며
 * 클릭해도 명령이 시뮬로 가던 실측 결함을 source 옵션으로 교정한다(미지정 시 기존 카메라 — 회귀 0).
 */

const okPtz: Ptz = { pan: 11, tilt: 21, zoom: 4 };
const SRC_PTZ: Ptz = { pan: -141.479, tilt: -3.2, zoom: 2 };

const cameraCfg = { zoomMin: 1, zoomMax: 36 } as unknown as ToolsConfig['camera'];

/** 실카 소스 스텁(getPtz 만 관찰). 호출 여부로 "그 소스로 명령이 갔는지"를 판정한다. */
function makeSource() {
  const getPtzCalls: number[] = [];
  const source = {
    kind: 'hucoms',
    listCameras: async () => ({ cameras: [] }),
    snapshot: async () => ({ jpeg: Buffer.alloc(0), ptz: SRC_PTZ }),
    move: async () => true,
    getPtz: async (cam: number) => { getPtzCalls.push(cam); return SRC_PTZ; },
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (p: unknown) => p as Ptz,
  } as unknown as CameraSource;
  return { source, getPtzCalls };
}

/** centerOnPoint/aimPointToCenter 스파이 calibrator + 라우트 조립(sources/cameraCfg 주입 여부 제어). */
function makeApp(opts: { sources?: Map<string, CameraSource> }) {
  const calls: Array<{ cam: number; preset: number; opts?: { zoom?: boolean; camera?: ICameraClient } }> = [];
  const calibrator = {
    centerOnPoint: async (cam: number, preset: number, _point: unknown, o?: { zoom?: boolean; camera?: ICameraClient }) => {
      calls.push({ cam, preset, opts: o });
      return { ok: true, ptz: okPtz, plateWidth: 0.2 };
    },
    getStatus: () => ({ state: 'idle', done: 0, total: 0 }),
    getLastFrame: () => undefined,
  } as unknown as PtzCalibrator;
  const app = Fastify({ logger: false });
  registerCalibrateRoutes(app, {
    calibrator,
    outFile: 'data/slot_ptz.json',
    ...(opts.sources ? { sources: opts.sources, cameraCfg } : {}),
  });
  return { app, calls };
}

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });

const payload = { cam: 1, preset: 1, point: { x: 0.42, y: 0.58 }, mode: 'plate' };

describe('POST /calibrate/point — source 위임', () => {
  it('source 지정 → 해당 소스로 조립된 카메라 클라이언트를 opts.camera 로 전달', async () => {
    const { source, getPtzCalls } = makeSource();
    const built = makeApp({ sources: new Map([['real-camera-1', source]]) });
    app = built.app;

    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { ...payload, source: 'real-camera-1' } });
    expect(r.statusCode).toBe(200);
    const camera = built.calls[0].opts?.camera;
    expect(camera).toBeDefined();
    // 전달된 클라이언트의 호출이 **그 소스**에 도달하는지(위임 증명).
    await expect(camera!.getPtz(1)).resolves.toEqual(SRC_PTZ);
    expect(getPtzCalls).toEqual([1]);
  });

  it('알 수 없는 source → 400 source not found, calibrator 미호출', async () => {
    const { source } = makeSource();
    const built = makeApp({ sources: new Map([['real-camera-1', source]]) });
    app = built.app;

    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload: { ...payload, source: 'nope' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'source not found' });
    expect(built.calls).toHaveLength(0);
  });

  it('source 미지정 → opts.camera 없음(기존 파이프라인 카메라 — 회귀 0)', async () => {
    const { source } = makeSource();
    const built = makeApp({ sources: new Map([['real-camera-1', source]]) });
    app = built.app;

    const r = await app.inject({ method: 'POST', url: '/calibrate/point', payload });
    expect(r.statusCode).toBe(200);
    expect(built.calls[0].opts?.camera).toBeUndefined();
  });
});
