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
 * 검증자(qa-tester): PUT /mapping · PUT /viewer/api/mapping 영속화.
 *  - 유효 artifact → 200 + repo.saveArtifact 호출됨
 *  - coverage 깨진 artifact → 400 + 미저장
 *  - 잘못된 shape → 400 + 미저장
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const fakeCamera = () => ({ health: async () => true } as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

/** saveArtifact 호출을 기록하는 repo 스텁. */
function recordingRepo() {
  const saved: SetupArtifact[] = [];
  const repo = {
    saveArtifact: (a: SetupArtifact) => { saved.push(a); },
    loadArtifact: () => null,
    path: 'mem',
  } as unknown as Repository;
  return { repo, saved };
}

function validArtifact(): SetupArtifact {
  return {
    createdAt: 'T',
    presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['a'] }],
    slots: [{ slotId: 'a', zone: 'z', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }],
    globalIndex: [{ globalIdx: 1, slotId: 'a', camIdx: 1, presetIdx: 1 }],
  };
}

function mk(repo: Repository): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mapput-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
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

describe('PUT /mapping (헤드리스)', () => {
  it('유효 artifact → 200 + saveArtifact 호출', async () => {
    const { repo, saved } = recordingRepo();
    ({ app, dir } = mk(repo));
    const r = await app.inject({ method: 'PUT', url: '/mapping', payload: validArtifact() });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ ok: true, slots: 1, globalCount: 1 });
    expect(saved.length).toBe(1);
    expect(saved[0].slots[0].slotId).toBe('a');
  });

  it('coverage 깨짐(globalIndex 에 없는 slot) → 400 + 미저장', async () => {
    const { repo, saved } = recordingRepo();
    ({ app, dir } = mk(repo));
    const bad = validArtifact();
    bad.slots.push({ slotId: 'b', zone: 'z', roiByPreset: { '1:1': { x: 0, y: 0, w: 0.1, h: 0.1 } } });
    const r = await app.inject({ method: 'PUT', url: '/mapping', payload: bad });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.error).toBe('coverage mismatch');
    expect(body.missing).toEqual(['b']);
    expect(saved.length).toBe(0);
  });

  it('잘못된 shape → 400 + 미저장', async () => {
    const { repo, saved } = recordingRepo();
    ({ app, dir } = mk(repo));
    const r = await app.inject({ method: 'PUT', url: '/mapping', payload: { presets: 'nope' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid artifact');
    expect(saved.length).toBe(0);
  });
});

describe('PUT /viewer/api/mapping (뷰어)', () => {
  it('유효 artifact → 200 + saveArtifact 호출', async () => {
    const { repo, saved } = recordingRepo();
    ({ app, dir } = mk(repo));
    const r = await app.inject({ method: 'PUT', url: '/viewer/api/mapping', payload: validArtifact() });
    expect(r.statusCode).toBe(200);
    expect(saved.length).toBe(1);
  });

  it('coverage 깨짐 → 400 + 미저장', async () => {
    const { repo, saved } = recordingRepo();
    ({ app, dir } = mk(repo));
    const bad = validArtifact();
    bad.globalIndex = []; // slot a 가 인덱스에서 누락.
    const r = await app.inject({ method: 'PUT', url: '/viewer/api/mapping', payload: bad });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).missing).toEqual(['a']);
    expect(saved.length).toBe(0);
  });
});
