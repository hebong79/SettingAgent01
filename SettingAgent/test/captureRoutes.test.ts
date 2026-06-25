import { describe, it, expect, afterEach } from 'vitest';
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
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): /capture/* REST (fastify.inject).
 * start/status/stop/finalize/runs/runs:id/aggregate + zod 400 + 중복 409.
 * 기존 /setup/*·/mapping 회귀 확인(가산·불변).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, checkpointEvery: 10, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5,
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
const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};

/** 타이머를 보관하되 자동 발화하지 않는 잡(라우트 검증은 상태 전이만 본다). */
function makeServer() {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), store, cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const { repo } = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
  });
  return { app, store, job };
}

const target: SetupTarget = { camIdx: 1, presetIdx: 1 };

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('/capture/start (zod·409)', () => {
  it('정상 start → 200 {ok, runId}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.runId).toBeGreaterThan(0);
  });

  it('count 누락/0 → 400 (zod)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r1 = await app.inject({ method: 'POST', url: '/capture/start', payload: { targets: [target] } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 0, targets: [target] } });
    expect(r2.statusCode).toBe(400);
  });

  it('targets 미지정 + mapFiles 미설정 → 400', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3 } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toContain('targets');
  });

  it('이미 running 중 start → 409', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain('already running');
  });
});

describe('/capture/status·stop', () => {
  it('start 후 status → running, 진행 필드 노출', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 5, targets: [target] } });
    const r = await app.inject({ method: 'GET', url: '/capture/status' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.state).toBe('running');
    expect(body.planned).toBe(5);
    expect(body).toHaveProperty('done');
    expect(body).toHaveProperty('round');
  });

  it('running 중 stop → 200 {ok, state}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 5, targets: [target] } });
    const r = await app.inject({ method: 'POST', url: '/capture/stop' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });

  it('running 아님 stop → 400', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/stop' });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toContain('not running');
  });
});

describe('/capture/finalize', () => {
  it('running 중 finalize → 409', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 5, targets: [target] } });
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).state).toBe('running');
  });

  it('런 없음(미지정 runId) → 404', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toContain('no run');
  });

  it('종료된 런 finalize → 200 {ok, slots, globalCount}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    // 런을 직접 만들고 종료(LLM off 결정형 강등 — 빈 검출이면 slots 0).
    const runId = s.store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    s.store.endRun(runId, { status: 'done', stopReason: 'count', endedAt: 'T1' });
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: { runId } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('slots');
    expect(body).toHaveProperty('globalCount');
  });
});

describe('/capture/runs·aggregate', () => {
  it('runs → CaptureRunRow[] (메타)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    s.store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const r = await app.inject({ method: 'GET', url: '/capture/runs' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('plannedCount');
  });

  it('runs/:id/aggregate → AggregatedSlot[]', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const runId = s.store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    s.store.replaceAggregatedSlots(runId, [{
      presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1,
      support: 3, occupancyRate: 0.5, plateX: null, plateY: null, plateW: null, plateH: null, status: 'candidate',
    }]);
    const r = await app.inject({ method: 'GET', url: `/capture/runs/${runId}/aggregate` });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveLength(1);
    expect(body[0].presetKey).toBe('1:1');
  });

  it('runs/:id/aggregate (없는 id) → 404', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/runs/999/aggregate' });
    expect(r.statusCode).toBe(404);
  });

  it('runs/:id/aggregate (잘못된 id) → 400', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/runs/abc/aggregate' });
    expect(r.statusCode).toBe(400);
  });
});

describe('기존 /setup/*·/mapping 회귀 (capture 가산 후 불변)', () => {
  it('GET /health → 200 (capture 라우트 등록과 무관)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).status).toBe('ok');
  });

  it('GET /mapping (산출물 없음) → 404 (기존 동작 유지)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/mapping' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /setup/run 잘못된 body → 400 (기존 zod 유지)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/setup/run', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('GET /setup/status → 200 (기존 라우트 동작)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(r.statusCode).toBe(200);
  });
});

describe('capture 의존성 미주입 시 라우트 미등록(가산 보장)', () => {
  it('captureJob 미주입 → /capture/status 404, /setup/* 정상', async () => {
    const { repo } = fakeRepo();
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd() });
    const rc = await a.inject({ method: 'GET', url: '/capture/status' });
    expect(rc.statusCode).toBe(404); // 라우트 없음
    const rs = await a.inject({ method: 'GET', url: '/setup/status' });
    expect(rs.statusCode).toBe(200);
    await a.close();
  });
});
