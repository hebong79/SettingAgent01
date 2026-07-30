import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerViewerRoutes } from '../src/viewer/routes.js';
import type { CameraSource, DevicePreset, Ptz, SnapshotOpts } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 장비 프리셋 라우트(GET /viewer/api/presets · POST /viewer/api/preset/goto).
 *
 * 규약:
 *  - 목록은 **읽기**다(카메라 무이동) → 게이트 없음.
 *  - 이동은 **변이**다 → 기존 /move 와 **같은 게이트**(allowMove·controlToken)를 통과해야 한다.
 *  - 장비 프리셋 개념이 없는 소스(시뮬레이터)는 **501** 이다. 빈 목록으로 위장하면
 *    "프리셋이 0개인 카메라"와 구분되지 않아 화면이 거짓말을 한다.
 */

const PRESETS: DevicePreset[] = [
  { token: '001', name: 'EV1', number: 1 },
  { token: '002', name: 'EV2', number: 2 },
];

/** 장비 프리셋을 지원하는 가짜 실카 소스. */
function deviceSource(over: Partial<CameraSource> = {}) {
  const calls: { list: number[]; goto: Array<{ cam: number; number: number }> } = { list: [], goto: [] };
  const src: CameraSource & { calls: typeof calls } = {
    kind: 'hucoms',
    calls,
    async listCameras() {
      return { cameras: [{ camIdx: 1, name: 'real', enabled: true, presets: [{ presetIdx: 1, label: '현재 위치' }] }] };
    },
    async snapshot(_cam: number, _opt: SnapshotOpts) {
      return { jpeg: Buffer.from([0xff, 0xd8]), ptz: { pan: 0, tilt: 0, zoom: 1 } };
    },
    async move() {
      return true;
    },
    async getPtz() {
      return { pan: 1, tilt: 2, zoom: 3 };
    },
    async getNativePtz() {
      return { pan: 7034, tilt: 2760, zoom: 8155 };
    },
    async listDevicePresets(cam: number) {
      calls.list.push(cam);
      return PRESETS;
    },
    async gotoDevicePreset(cam: number, presetNumber: number) {
      calls.goto.push({ cam, number: presetNumber });
      return {
        number: presetNumber,
        ptz: { pan: 10, tilt: 20, zoom: 30 },
        native: { pan: 7034, tilt: 2760, zoom: 8155 },
        settled: true,
      };
    },
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
    ...over,
  };
  return src;
}

/** 장비 프리셋을 모르는 소스(시뮬레이터). */
function plainSource(): CameraSource {
  const src = deviceSource();
  delete (src as Partial<CameraSource>).listDevicePresets;
  delete (src as Partial<CameraSource>).gotoDevicePreset;
  delete (src as Partial<CameraSource>).getNativePtz;
  return { ...src, kind: 'sim' };
}

const viewerCfg = (over: Partial<ToolsConfig['viewer']> = {}): ToolsConfig['viewer'] => ({
  enabled: true,
  allowMove: true,
  defaultFps: 3,
  staticDir: 'web',
  controlToken: '',
  ...over,
});

async function mkApp(sources: Map<string, CameraSource>, viewer: Partial<ToolsConfig['viewer']> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-preset-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const app = Fastify();
  await registerViewerRoutes(app, { sources, viewer: viewerCfg({ ...viewer, staticDir: dir }) });
  await app.ready();
  return { app, dir, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('viewerRoutes — 장비 프리셋', () => {
  it('GET /presets → 200 목록(카메라 인덱스를 소스에 그대로 전달)', async () => {
    const real = deviceSource();
    const { app, close } = await mkApp(new Map([['real', real as CameraSource]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/presets?source=real&cam=1' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ presets: PRESETS, count: 2 });
      expect(real.calls.list).toEqual([1]);
    } finally {
      await close();
    }
  });

  it('GET /presets — 미지원 소스는 501(빈 목록으로 위장하지 않는다)', async () => {
    const { app, close } = await mkApp(new Map([['sim', plainSource()]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/presets?source=sim&cam=1' });
      expect(r.statusCode).toBe(501);
      expect(JSON.parse(r.body).code).toBe('DEVICE_PRESETS_UNSUPPORTED');
    } finally {
      await close();
    }
  });

  it('GET /presets — 소스 조회가 실패하면 502(에러 메시지 전달)', async () => {
    const failing = deviceSource({ listDevicePresets: async () => { throw new Error('ONVIF GetPresets 거부: Sender not Authorized'); } });
    const { app, close } = await mkApp(new Map([['real', failing as CameraSource]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/presets?source=real&cam=1' });
      expect(r.statusCode).toBe(502);
      expect(JSON.parse(r.body).error).toMatch(/Sender not Authorized/);
    } finally {
      await close();
    }
  });

  it('POST /preset/goto → 200 이동 + 이동 후 실측 PTZ(뷰어 좌표 + 장비 원시)', async () => {
    const real = deviceSource();
    const { app, close } = await mkApp(new Map([['real', real as CameraSource]]));
    try {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/preset/goto', payload: { source: 'real', cam: 1, number: 2 } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({
        ok: true,
        number: 2,
        ptz: { pan: 10, tilt: 20, zoom: 30 },
        native: { pan: 7034, tilt: 2760, zoom: 8155 },
        settled: true,
      });
      expect(real.calls.goto).toEqual([{ cam: 1, number: 2 }]);
    } finally {
      await close();
    }
  });

  it('POST /preset/goto — 범위 밖 번호(0·256)는 400, 소스는 호출되지 않는다', async () => {
    const real = deviceSource();
    const { app, close } = await mkApp(new Map([['real', real as CameraSource]]));
    try {
      for (const number of [0, 256]) {
        const r = await app.inject({ method: 'POST', url: '/viewer/api/preset/goto', payload: { source: 'real', cam: 1, number } });
        expect(r.statusCode).toBe(400);
      }
      expect(real.calls.goto).toEqual([]);
    } finally {
      await close();
    }
  });

  it('POST /preset/goto — allowMove:false 면 403(이동 게이트가 /move 와 동일)', async () => {
    const real = deviceSource();
    const { app, close } = await mkApp(new Map([['real', real as CameraSource]]), { allowMove: false });
    try {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/preset/goto', payload: { source: 'real', cam: 1, number: 1 } });
      expect(r.statusCode).toBe(403);
      expect(real.calls.goto).toEqual([]);
    } finally {
      await close();
    }
  });

  it('POST /preset/goto — controlToken 설정 시 토큰 불일치는 403, 일치하면 200', async () => {
    const real = deviceSource();
    const { app, close } = await mkApp(new Map([['real', real as CameraSource]]), { controlToken: 'T' });
    try {
      const bad = await app.inject({ method: 'POST', url: '/viewer/api/preset/goto', payload: { source: 'real', cam: 1, number: 1 } });
      expect(bad.statusCode).toBe(403);
      const good = await app.inject({
        method: 'POST',
        url: '/viewer/api/preset/goto',
        headers: { 'x-viewer-token': 'T' },
        payload: { source: 'real', cam: 1, number: 1 },
      });
      expect(good.statusCode).toBe(200);
      expect(real.calls.goto).toEqual([{ cam: 1, number: 1 }]);
    } finally {
      await close();
    }
  });

  it('POST /preset/goto — 미지원 소스 501, 이동 실패는 502', async () => {
    const failing = deviceSource({ gotoDevicePreset: async () => { throw new Error('gopreset 실패'); } });
    const { app, close } = await mkApp(new Map([['sim', plainSource()], ['real', failing as CameraSource]]));
    try {
      const unsupported = await app.inject({ method: 'POST', url: '/viewer/api/preset/goto', payload: { source: 'sim', cam: 1, number: 1 } });
      expect(unsupported.statusCode).toBe(501);
      const broken = await app.inject({ method: 'POST', url: '/viewer/api/preset/goto', payload: { source: 'real', cam: 1, number: 1 } });
      expect(broken.statusCode).toBe(502);
      expect(JSON.parse(broken.body).error).toMatch(/gopreset 실패/);
    } finally {
      await close();
    }
  });

  it('GET /ptz — 지원 소스는 장비 원시 PTZ 를 가산으로 함께 준다', async () => {
    const { app, close } = await mkApp(new Map([['real', deviceSource() as CameraSource]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/ptz?source=real&cam=1' });
      expect(JSON.parse(r.body)).toEqual({ ptz: { pan: 1, tilt: 2, zoom: 3 }, native: { pan: 7034, tilt: 2760, zoom: 8155 } });
    } finally {
      await close();
    }
  });

  it('GET /ptz — 원시 PTZ 조회가 실패해도 뷰어 PTZ 응답은 그대로다(표시용이라 제어를 막지 않는다)', async () => {
    const flaky = deviceSource({ getNativePtz: async () => { throw new Error('불완전 응답'); } });
    const { app, close } = await mkApp(new Map([['real', flaky as CameraSource]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/ptz?source=real&cam=1' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ptz: { pan: 1, tilt: 2, zoom: 3 } });
    } finally {
      await close();
    }
  });

  it('GET /ptz — 미지원 소스(sim)에는 native 키가 없다(기존 응답과 동일)', async () => {
    const { app, close } = await mkApp(new Map([['sim', plainSource()]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/ptz?source=sim&cam=1' });
      expect(JSON.parse(r.body)).toEqual({ ptz: { pan: 1, tilt: 2, zoom: 3 } });
    } finally {
      await close();
    }
  });
});
