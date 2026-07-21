// GET /capture/ground-model 라우트(fastify.inject). placeRoiRoutes.test.ts 하네스 복제.
// 계약: ground.enabled + placeRoiFile 주입 시에만 등록(가산) / 미설정·비활성·파일부재 → 404 /
//       camerapos 부재 → zoom 미상 강등(200, issues 에 기록, throw 없음).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const groundCfg: ToolsConfig['ground'] = {
  enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0,
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

function makeServer(opts: { placeRoiFile?: string; cameraposFile?: string; ground?: ToolsConfig['ground'] }) {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    placeRoiFile: opts.placeRoiFile,
    mapFiles: opts.cameraposFile ? { cameraposFile: opts.cameraposFile } : undefined,
    ground: opts.ground,
  });
  return { app, store };
}

// 동결 픽스처(Unity 원형)를 쓴다 — data/Place01 은 런타임 가변이라 사용자 편집만으로 테스트가 깨진다.
const REAL_PLACE_ROI = readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8');
const REAL_CAMERAPOS = readFileSync('test/fixtures/camerapos.sample.json', 'utf8');

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

function fixture(withCamerapos = true) {
  dir = mkdtempSync(join(tmpdir(), 'ground-'));
  const placeRoiFile = join(dir, 'PtzCamRoi.json');
  writeFileSync(placeRoiFile, REAL_PLACE_ROI, 'utf8');
  let cameraposFile: string | undefined;
  if (withCamerapos) {
    cameraposFile = join(dir, 'camerapos.json');
    writeFileSync(cameraposFile, REAL_CAMERAPOS, 'utf8');
  }
  return { placeRoiFile, cameraposFile };
}

describe('GET /capture/ground-model', () => {
  it('placeRoiFile + camerapos + ground.enabled → 200 + 프리셋별 모델', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'GET', url: '/capture/ground-model' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.models).toHaveLength(3);
    expect(Math.abs(body.fovBaseV - 33.0) / 33.0).toBeLessThan(0.02); // Unity GT fovBaseV(32.83~33.17, §GT 불확실성) ±2%.
    for (const m of body.models) {
      expect(m.source).toBe('file');
      expect(m.n).toHaveLength(3);
      expect(m.f).toBeGreaterThan(0);
      expect(m.d).toBeGreaterThan(0);
      expect(Array.isArray(m.issues)).toBe(true);
      // 실카메라 호환: 응답에 Unity 전용 필드(position/eulerAngles/fov)를 싣지 않는다.
      expect(m).not.toHaveProperty('position');
      expect(m).not.toHaveProperty('eulerAngles');
    }
  });

  it('ground.enabled=false → 404(순수 가산·킬스위치)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: { ...groundCfg, enabled: false } });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/ground-model' });
    expect(r.statusCode).toBe(404);
  });

  it('ground 미주입 / placeRoiFile 미설정 → 404', async () => {
    const { placeRoiFile } = fixture();
    const s1 = makeServer({ placeRoiFile });
    app = s1.app; store = s1.store;
    expect((await app.inject({ method: 'GET', url: '/capture/ground-model' })).statusCode).toBe(404);
    await app.close(); store.close();

    const s2 = makeServer({ ground: groundCfg });
    app = s2.app; store = s2.store;
    expect((await app.inject({ method: 'GET', url: '/capture/ground-model' })).statusCode).toBe(404);
  });

  it('PtzCamRoi.json 부재 → 404(throw 없음)', async () => {
    const s = makeServer({ placeRoiFile: join(tmpdir(), 'nope-ground', 'x.json'), ground: groundCfg });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/ground-model' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toContain('없음');
  });

  it('camerapos 부재 → zoom 미상 강등(200 + 프리셋 단독 f advisory)', async () => {
    const { placeRoiFile } = fixture(false);
    const s = makeServer({ placeRoiFile, ground: groundCfg });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/ground-model' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.models.length).toBeGreaterThan(0); // 강등이지 기각이 아니다.
    expect(body.fovBaseV).toBeNull(); // zoom 없으면 공동추정 불가.
    expect(body.models[0].issues.join()).toContain('프리셋 단독 f');
  });
});
