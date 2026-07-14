import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { buildSourceRegistry } from '../src/viewer/sourceRegistry.js';
import { DEFAULT_TOOLS_CONFIG } from '../src/config/toolsConfig.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';

/**
 * 검증자(qa-tester): viewer.enabled 토글(헤드리스 강등·라우트 충돌 없음).
 * - enabled=false → /viewer/api/* 미등록(404), /health(루트)·/setup/status 정상.
 * - enabled=true  → /viewer/api/health 200 + /health(루트) 정상(경로 충돌 없음).
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const fakeCamera = () => ({ health: async () => true } as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = () => ({ saveArtifact: () => {}, loadArtifact: () => null, path: 'mem' } as unknown as Repository);

function mk(enabled: boolean): { app: FastifyInstance; dir?: string } {
  const repo = fakeRepo();
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  if (!enabled) {
    const app = buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(), viewer: { enabled: false, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' } });
    return { app };
  }
  const dir = mkdtempSync(join(tmpdir(), 'venabled-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const sources = buildSourceRegistry({ camera: DEFAULT_TOOLS_CONFIG.camera, cameraSources: undefined, unityRpc: DEFAULT_TOOLS_CONFIG.unityRpc, map: DEFAULT_TOOLS_CONFIG.map, cameraMode: 'simulator', realCamera: undefined });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: dir, controlToken: '' }, sources,
  });
  return { app, dir };
}

let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe('viewer.enabled 토글', () => {
  it('enabled=false → /viewer/api/health 404(헤드리스), /health·/setup/status 정상', async () => {
    ({ app, dir } = mk(false));
    const v = await app.inject({ method: 'GET', url: '/viewer/api/health' });
    expect(v.statusCode).toBe(404);
    const h = await app.inject({ method: 'GET', url: '/health' });
    expect(h.statusCode).toBe(200);
    const s = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(s.statusCode).toBe(200);
  });

  it('enabled=true → /viewer/api/health 200 + /health(루트) 정상(경로 충돌 없음)', async () => {
    ({ app, dir } = mk(true));
    const v = await app.inject({ method: 'GET', url: '/viewer/api/health' });
    expect(v.statusCode).toBe(200);
    expect(JSON.parse(v.body)).toMatchObject({ status: 'ok', sources: ['rpc'] });
    const h = await app.inject({ method: 'GET', url: '/health' });
    expect(h.statusCode).toBe(200);
    expect(JSON.parse(h.body).status).toBe('ok');
  });
});
