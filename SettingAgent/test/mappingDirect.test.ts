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
import type { SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): /viewer/api/mapping 직접 읽기(프록시 폐기, G2-1 대체).
 * buildViewerServer 의 HTTP 자기호출을 폐기하고 repo.loadArtifact() 를 그대로 반환:
 *  - 산출물 있음 → 200 + JSON 패스스루
 *  - 산출물 없음 → 404 {error:'no setup artifact'}
 * (502/타임아웃 분기는 자기호출 제거로 소멸.)
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const fakeCamera = () => ({ health: async () => true } as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

/** loadArtifact 가 주입된 산출물(또는 null)을 반환하는 repo 스텁. */
const stubRepo = (artifact: SetupArtifact | null): Repository =>
  ({ saveArtifact: () => {}, loadArtifact: () => artifact, path: 'mem' } as unknown as Repository);

/** 임시 staticDir(@fastify/static root 존재 필요)로 viewer 활성 buildServer 구성. */
function mk(artifact: SetupArtifact | null): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mapdirect-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const repo = stubRepo(artifact);
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const sources = buildSourceRegistry({ camera: DEFAULT_TOOLS_CONFIG.camera, cameraSources: undefined });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: dir, controlToken: '' },
    sources,
  });
  return { app, dir };
}

let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe('/viewer/api/mapping 직접 읽기(프록시 폐기)', () => {
  it('산출물 있음 → 200 + repo.loadArtifact() JSON 패스스루', async () => {
    const artifact = { slots: [{ slotId: 's-1' }], globalIndex: [] } as unknown as SetupArtifact;
    ({ app, dir } = mk(artifact));
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(body.slots[0].slotId).toBe('s-1');
  });

  it('산출물 없음(null) → 404 {error:no setup artifact}', async () => {
    ({ app, dir } = mk(null));
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'no setup artifact' });
  });
});
