import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): GET /capture/place-roi (fastify.inject).
 * 근거: 01_architect_plan.md #02 §3 B1~B2 + 02_developer_changes.md 02-C.
 * 파일 주입 → 200 + raw JSON 동일 / 미설정·부재 → 404. 백엔드는 정규화 없이 raw 서빙.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

/** placeRoiFile 을 옵션으로 주입하는 서버(라우트 검증은 파일 I/O 만 본다). */
function makeServer(placeRoiFile?: string) {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), store, cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg, placeRoiFile,
  });
  return { app, store };
}

/** 최소 PtzCamRoi 샘플(라우트는 raw JSON 그대로 반환하는지만 본다). */
const samplePtzCamRoi = {
  cameras: [
    {
      camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 },
      presets: [{ preset_idx: 1, parking_spaces: [{ idx: 0, points: [[57.31739, 828.721436], [8.672562, 721.8646], [278.876282, 704.4789], [377.818726, 803.8074]] }] }],
    },
  ],
};

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe('GET /capture/place-roi', () => {
  it('placeRoiFile 주입(임시 파일) → 200 + raw JSON 동일', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placeroi-'));
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify(samplePtzCamRoi), 'utf8');
    const s = makeServer(file); app = s.app; store = s.store;

    const r = await app.inject({ method: 'GET', url: '/capture/place-roi' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    // 백엔드는 정규화 없이 raw JSON 그대로 반환.
    expect(body).toEqual(samplePtzCamRoi);
    expect(body.cameras[0].camera.cam_id).toBe(1);
  });

  it('placeRoiFile 미설정 → 404 { error }', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/place-roi' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toHaveProperty('error');
  });

  it('placeRoiFile 파일 부재(ENOENT) → 404 { error }', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placeroi-'));
    const missing = join(dir, 'nope', 'PtzCamRoi.json');
    const s = makeServer(missing); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/place-roi' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toHaveProperty('error');
  });
});
