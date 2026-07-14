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
import type { ParkingSlotRow } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): GET /capture/runs/:id/slots (§06 H6). /occupancy 패턴 미러.
 * 근거: 01_architect_plan.md §06 §3 H6 + 02_developer_changes.md 02-I QA 인계.
 * 200(행 배열, presetKey/slotIdx/roi/vpd/lpd/occupied), 잘못된 id 400, 없는 run 404, 행 없음 빈배열.
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

function makeServer() {
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
  const app = buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(), captureJob: job, finalizer, sqlite: store, capture: captureCfg });
  return { app, store };
}

const parkingRow = (over: Partial<ParkingSlotRow> = {}): ParkingSlotRow => ({
  camIdx: 1, presetIdx: 1, presetKey: '1:1', slotIdx: 1,
  roiJson: JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]),
  vpdJson: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
  lpdJson: JSON.stringify([{ x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 }]),
  occupied: 1, occupancyRate: 0.8, pan: null, tilt: null, zoom: null, updatedAt: 'T', ...over,
});

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('GET /capture/runs/:id/slots (§06 H6)', () => {
  it('시드된 run → 200 + 행 배열(presetKey/slotIdx/roi/vpd/lpd/occupied)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [
      parkingRow({ slotIdx: 1, occupied: 1 }),
      parkingRow({ slotIdx: 2, occupied: 0, vpdJson: null, lpdJson: null, occupancyRate: null }),
    ]);

    const r = await app.inject({ method: 'GET', url: `/capture/runs/${runId}/slots` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    const s1 = body.find((x) => x.slotIdx === 1)!;
    expect(s1.presetKey).toBe('1:1'); // 경계면: 프론트 parkingSlotsByKey 키
    expect(s1.roi).toEqual([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]);
    expect(s1.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect(s1.occupied).toBe(true); // JSON boolean
    const s2 = body.find((x) => x.slotIdx === 2)!;
    expect(s2.occupied).toBe(false);
    expect(s2.vpd).toBeNull();
    expect(s2.lpd).toBeNull();
  });

  it('응답에 preset PTZ(pan/tilt/zoom) 필드 포함 — 값/ null 모두(변경1)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [
      parkingRow({ slotIdx: 1, pan: 15.5, tilt: -4.25, zoom: 6 }),
      parkingRow({ slotIdx: 2, pan: null, tilt: null, zoom: null }),
    ]);

    const r = await app.inject({ method: 'GET', url: `/capture/runs/${runId}/slots` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<Record<string, unknown>>;
    const s1 = body.find((x) => x.slotIdx === 1)!;
    expect(s1.pan).toBe(15.5);
    expect(s1.tilt).toBe(-4.25);
    expect(s1.zoom).toBe(6);
    const s2 = body.find((x) => x.slotIdx === 2)!;
    // JSON 직렬화 후에도 null 유지(undefined 로 사라지지 않음 — 소비처 shape 정합).
    expect(s2.pan).toBeNull();
    expect(s2.tilt).toBeNull();
    expect(s2.zoom).toBeNull();
    expect('pan' in s2).toBe(true);
  });

  it('행 없는 run → 200 빈 배열', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const r = await app.inject({ method: 'GET', url: `/capture/runs/${runId}/slots` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('잘못된 id(0, 음수, 비정수) → 400', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    for (const bad of ['0', '-1', 'abc']) {
      const r = await app.inject({ method: 'GET', url: `/capture/runs/${bad}/slots` });
      expect(r.statusCode, `id=${bad}`).toBe(400);
      expect((r.json() as { error: string }).error).toBe('invalid run id');
    }
  });

  it('없는 run → 404', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/runs/99999/slots' });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: string }).error).toBe('run not found');
  });
});
