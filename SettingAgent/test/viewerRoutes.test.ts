import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerViewerRoutes } from '../src/viewer/routes.js';
import type { CameraSource, SnapshotOpts, Ptz } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/** 호출 인자를 기록하는 가짜 소스. login 보유=hucoms 흉내. */
function spySource(kind: 'sim' | 'hucoms' = 'sim') {
  const calls: { snapshot: any[]; move: any[]; login: any[] } = { snapshot: [], move: [], login: [] };
  const src: CameraSource & { calls: typeof calls } = {
    kind,
    calls,
    async listCameras() {
      return { cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'P1' }] }] };
    },
    async snapshot(cam: number, opt: SnapshotOpts) {
      calls.snapshot.push({ cam, opt });
      const ptz: Ptz = opt.mode === 'manual' && opt.ptz ? opt.ptz : { pan: 7, tilt: 8, zoom: 9 };
      return { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ptz };
    },
    async move(cam: number, ptz: Ptz) {
      calls.move.push({ cam, ptz });
      return true;
    },
    ...(kind === 'hucoms'
      ? {
          async login(user: string, pass: string) {
            calls.login.push({ user, pass });
            return true;
          },
        }
      : {}),
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
  };
  return src;
}

const viewerCfg = (over: Partial<ToolsConfig['viewer']> = {}): ToolsConfig['viewer'] => ({
  enabled: true,
  allowMove: true,
  defaultFps: 3,
  staticDir: 'web',
  controlToken: '',
  ...over,
});

/** 임시 staticDir(최소 SPA 파일)로 fastify 앱 구성. */
async function mkApp(opts: {
  sources: Map<string, CameraSource>;
  viewer?: Partial<ToolsConfig['viewer']>;
}): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  writeFileSync(join(dir, 'app.js'), 'export const x=1;');
  writeFileSync(join(dir, 'core.js'), 'export const y=2;');
  const app = Fastify();
  await registerViewerRoutes(app, { sources: opts.sources, viewer: viewerCfg({ ...opts.viewer, staticDir: dir }) });
  await app.ready();
  return { app, dir };
}

describe('viewerRoutes — /viewer/api/*', () => {
  it('GET /cameras → 200 CameraList JSON', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/cameras' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.cameras[0].camIdx).toBe(1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /snapshot preset 모드 → image/jpeg + X-PTZ-* + no-store, 소스 인자 preset', async () => {
    const sim = spySource() as any;
    const sources = new Map<string, CameraSource>([['sim', sim]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/snapshot?cam=1&preset=2&mode=preset' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('image/jpeg');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-ptz-pan']).toBe('7');
      expect(r.headers['x-ptz-tilt']).toBe('8');
      expect(r.headers['x-ptz-zoom']).toBe('9');
      expect(r.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(sim.calls.snapshot[0].opt).toMatchObject({ mode: 'preset', presetIdx: 2 });
      expect(sim.calls.snapshot[0].opt.ptz).toBeUndefined();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /snapshot manual 모드 → PTZ 동봉(소스에 ptz 전달), X-PTZ-* 가 그 값 반영', async () => {
    const sim = spySource() as any;
    const sources = new Map<string, CameraSource>([['sim', sim]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/snapshot?cam=1&preset=1&mode=manual&pan=30&tilt=12&zoom=8' });
      expect(r.statusCode).toBe(200);
      expect(sim.calls.snapshot[0].opt).toMatchObject({ mode: 'manual', presetIdx: 1, ptz: { pan: 30, tilt: 12, zoom: 8 } });
      expect(r.headers['x-ptz-pan']).toBe('30');
      expect(r.headers['x-ptz-zoom']).toBe('8');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /snapshot manual zoom 클램프(99→36)', async () => {
    const sim = spySource() as any;
    const sources = new Map<string, CameraSource>([['sim', sim]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/snapshot?cam=1&preset=1&mode=manual&pan=0&tilt=0&zoom=99' });
      expect(r.statusCode).toBe(200);
      expect(sim.calls.snapshot[0].opt.ptz.zoom).toBe(36);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /snapshot zod 실패(cam=0) → 400', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/snapshot?cam=0&preset=1&mode=preset' });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /move → {ok:true}, 소스 move 인자(zoom 클램프 99→36)', async () => {
    const sim = spySource() as any;
    const sources = new Map<string, CameraSource>([['sim', sim]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/move', payload: { cam: 1, pan: 10, tilt: 5, zoom: 99 } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
      expect(sim.calls.move[0]).toEqual({ cam: 1, ptz: { pan: 10, tilt: 5, zoom: 36 } });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /move allowMove=false → 403', async () => {
    const sim = spySource() as any;
    const sources = new Map<string, CameraSource>([['sim', sim]]);
    const { app, dir } = await mkApp({ sources, viewer: { allowMove: false } });
    try {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/move', payload: { cam: 1, pan: 0, tilt: 0, zoom: 1 } });
      expect(r.statusCode).toBe(403);
      expect(sim.calls.move).toHaveLength(0); // 소스 미호출
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /move controlToken 불일치 → 403', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()]]);
    const { app, dir } = await mkApp({ sources, viewer: { controlToken: 'SECRET' } });
    try {
      const bad = await app.inject({ method: 'POST', url: '/viewer/api/move', headers: { 'x-viewer-token': 'WRONG' }, payload: { cam: 1, pan: 0, tilt: 0, zoom: 1 } });
      expect(bad.statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url: '/viewer/api/move', headers: { 'x-viewer-token': 'SECRET' }, payload: { cam: 1, pan: 0, tilt: 0, zoom: 1 } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /camera/login (sim 소스) → 400 login unsupported, 응답에 자격증명 미노출', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource('sim')]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/camera/login', payload: { source: 'sim', user: 'admin', pass: 's3cret' } });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain('s3cret');
      expect(r.body).not.toContain('admin');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /camera/login (hucoms 소스) → {ok:true}, 응답 body 에 자격증명 미노출', async () => {
    const hucoms = spySource('hucoms') as any;
    const sources = new Map<string, CameraSource>([['ptz1', hucoms]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/camera/login', payload: { source: 'ptz1', user: 'operator', pass: 'pa55word' } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
      expect(r.body).not.toContain('pa55word');
      expect(r.body).not.toContain('operator');
      // 소스에는 전달되었어야(통과)
      expect(hucoms.calls.login[0]).toEqual({ user: 'operator', pass: 'pa55word' });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /health → {status:ok, sources:[...]}', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()], ['ptz1', spySource('hucoms')]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/health' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ status: 'ok', sources: ['sim', 'ptz1'] });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('라우트 우선순위: /viewer/api/cameras 가 static 보다 먼저 매칭(JSON 반환, HTML 아님)', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/cameras' });
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.body).not.toContain('SPA');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('정적 서빙: GET /viewer/index.html → 200 text/html', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/index.html' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toContain('SPA');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /viewer → 302 redirect /viewer/', async () => {
    const sources = new Map<string, CameraSource>([['sim', spySource()]]);
    const { app, dir } = await mkApp({ sources });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer' });
      expect(r.statusCode).toBe(302);
      expect(r.headers['location']).toBe('/viewer/');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
