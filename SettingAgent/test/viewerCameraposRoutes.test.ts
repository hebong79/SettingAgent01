import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerViewerRoutes } from '../src/viewer/routes.js';
import type { CameraSource, SnapshotOpts, Ptz } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/** 최소 소스(라우트 등록 요건 충족용). camerapos 라우트는 소스를 쓰지 않는다. */
function stubSource(): CameraSource {
  return {
    kind: 'rpc',
    async listCameras() {
      return { cameras: [] };
    },
    async snapshot(_c: number, opt: SnapshotOpts) {
      return { jpeg: Buffer.from([0xff, 0xd8]), ptz: (opt.ptz ?? { pan: 0, tilt: 0, zoom: 1 }) as Ptz };
    },
    async move() {
      return true;
    },
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
  };
}

const viewerCfg = (over: Partial<ToolsConfig['viewer']> = {}): ToolsConfig['viewer'] => ({
  enabled: true,
  allowMove: true,
  defaultFps: 3,
  staticDir: 'web',
  controlToken: '',
  ...over,
});

/** camerapos 라우트가 등록된 fastify 앱 구성(tmp staticDir + tmp cameraposFile). */
async function mkApp(opts: {
  viewer?: Partial<ToolsConfig['viewer']>;
  withCamerapos?: boolean;
  seedFile?: string;
}): Promise<{ app: FastifyInstance; dir: string; cameraposFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'campos-routes-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const cameraposFile = join(dir, 'camerapos.json');
  if (opts.seedFile !== undefined) writeFileSync(cameraposFile, opts.seedFile);
  const app = Fastify();
  await registerViewerRoutes(app, {
    sources: new Map<string, CameraSource>([['rpc', stubSource()]]),
    viewer: viewerCfg({ ...opts.viewer, staticDir: dir }),
    ...(opts.withCamerapos === false ? {} : { cameraposFile }),
  });
  await app.ready();
  return { app, dir, cameraposFile };
}

const sampleViews = [
  { camIdx: 1, presetIdx: 1, label: 'C1-P1', pan: 22, tilt: 6.8, zoom: 1.6 },
  { camIdx: 1, presetIdx: 2, label: 'C1-P2', pan: 95, tilt: 10, zoom: 2.5 },
  { camIdx: 2, presetIdx: 1, label: 'C2-P1', pan: 40, tilt: 5, zoom: 4 },
];

describe('viewerRoutes — GET/PUT /viewer/api/camerapos', () => {
  it('GET 파일 없음 → { views: [] }', async () => {
    const { app, dir } = await mkApp({});
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/camerapos' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ views: [] });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PUT 유효 views → { ok:true, count } + 파일 기록 → GET 왕복 동일', async () => {
    const { app, dir } = await mkApp({});
    try {
      const put = await app.inject({ method: 'PUT', url: '/viewer/api/camerapos', payload: { views: sampleViews } });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(put.body)).toEqual({ ok: true, count: 3 });

      const get = await app.inject({ method: 'GET', url: '/viewer/api/camerapos' });
      const views = JSON.parse(get.body).views;
      // 왕복: camIdx/presetIdx/label/pan/tilt/zoom 보존(writeCamerapos↔parseCameraViews).
      expect(views.map((v: any) => `${v.camIdx}:${v.presetIdx}`)).toEqual(['1:1', '1:2', '2:1']);
      expect(views[0]).toMatchObject({ camIdx: 1, presetIdx: 1, label: 'C1-P1', pan: 22, tilt: 6.8, zoom: 1.6 });
      expect(views[2]).toMatchObject({ camIdx: 2, presetIdx: 1, pan: 40, tilt: 5, zoom: 4 });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PUT 잘못된 body(누락 필드) → 400, 파일 미기록', async () => {
    const { app, dir, cameraposFile } = await mkApp({});
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/viewer/api/camerapos',
        payload: { views: [{ camIdx: 1, presetIdx: 1 }] }, // label/pan/tilt/zoom 누락
      });
      expect(r.statusCode).toBe(400);
      expect(existsSync(cameraposFile)).toBe(false);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PUT 잘못된 body(camIdx=0, 비양수) → 400', async () => {
    const { app, dir } = await mkApp({});
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/viewer/api/camerapos',
        payload: { views: [{ camIdx: 0, presetIdx: 1, label: 'x', pan: 0, tilt: 0, zoom: 1 }] },
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PUT zoom 서버측 clamp(1~36): 99→36, 0→1', async () => {
    const { app, dir } = await mkApp({});
    try {
      await app.inject({
        method: 'PUT',
        url: '/viewer/api/camerapos',
        payload: {
          views: [
            { camIdx: 1, presetIdx: 1, label: 'hi', pan: 0, tilt: 0, zoom: 99 },
            { camIdx: 1, presetIdx: 2, label: 'lo', pan: 0, tilt: 0, zoom: 0 },
          ],
        },
      });
      const get = await app.inject({ method: 'GET', url: '/viewer/api/camerapos' });
      const views = JSON.parse(get.body).views;
      expect(views.find((v: any) => v.presetIdx === 1).zoom).toBe(36);
      expect(views.find((v: any) => v.presetIdx === 2).zoom).toBe(1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PUT controlToken 불일치 → 403, 파일 미기록; 일치 → 200', async () => {
    const { app, dir, cameraposFile } = await mkApp({ viewer: { controlToken: 'SECRET' } });
    try {
      const bad = await app.inject({
        method: 'PUT',
        url: '/viewer/api/camerapos',
        headers: { 'x-viewer-token': 'WRONG' },
        payload: { views: sampleViews },
      });
      expect(bad.statusCode).toBe(403);
      expect(existsSync(cameraposFile)).toBe(false);

      const ok = await app.inject({
        method: 'PUT',
        url: '/viewer/api/camerapos',
        headers: { 'x-viewer-token': 'SECRET' },
        payload: { views: sampleViews },
      });
      expect(ok.statusCode).toBe(200);
      expect(existsSync(cameraposFile)).toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET controlToken 설정에도 게이트 없음(읽기 무게이트)', async () => {
    const { app, dir } = await mkApp({ viewer: { controlToken: 'SECRET' }, seedFile: JSON.stringify({ datas: [] }) });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/camerapos' });
      expect(r.statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET 파싱 실패 파일 → { views: [] }(graceful)', async () => {
    const { app, dir } = await mkApp({ seedFile: '{ broken' });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/camerapos' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ views: [] });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cameraposFile 미주입 → 라우트 미등록(GET 은 static 로 폴백, JSON 아님)', async () => {
    const { app, dir } = await mkApp({ withCamerapos: false });
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/camerapos' });
      // 라우트 미등록 → @fastify/static 이 처리(404 또는 SPA). JSON {views} 는 아님.
      expect(r.statusCode).not.toBe(200);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
