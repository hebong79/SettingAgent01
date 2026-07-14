import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer, type LogicOccupancyPreset } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { SetupBrain } from '../src/brain/SetupBrain.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): Finalizer occupancyAgreement(로직 점유 vs LLM 저장분 1회 비교) 게이트 (설계 §05 G6-②).
 * + POST /capture/finalize 의 FinalizeBodySchema.occupancy 옵셔널 수용(하위호환·잘못된 shape 거부).
 * 근거: 01_architect_plan.md §05 G6 + 02_developer_changes.md 02-H(§6 G6-②).
 * best-effort: brain 비활성 / LLM 저장분 없음 / 로직 점유 미전달 → graceful skip(agreement 미부착, 좌표·slots 불변).
 * LLM 재호출 0회 — store.getLatestOccupancy(캡처 중 저장분) 재사용만.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};

const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};

/** enabled=true 이지만 finalizeCapture/judgeOccupancy 미보유 두뇌 — occupancyAgreement 는 저장분 재사용만으로 산출됨을 증명. */
const enabledBrain = () => ({ enabled: true } as unknown as SetupBrain);

let stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* noop */ } } stores = []; });
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

/** 안정 클러스터(support>=3) 1개 → finalize 후 slot 1개(c1p1s1). */
function seedStableRun(store: SqliteStore): number {
  const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T' });
  for (const round of [1, 2, 3]) {
    const obs = store.insertObservation({ runId, roundIdx: round, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(obs, 1, 1, [{ kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 }]);
  }
  return runId;
}

/** LLM 점유 저장분(체크포인트 중 저장). cam1 preset1: id1=점유, id2=공차. */
function seedLlmOccupancy(store: SqliteStore, runId: number): void {
  store.insertOccupancy(runId, {
    camIdx: 1, presetIdx: 1, atRound: 1, occupiedCount: 1, total: 2, rate: 0.5,
    spacesJson: JSON.stringify([{ id: 1, occupied: true }, { id: 2, occupied: false }]),
    updatedAt: 'T',
  });
}

/** 로직 점유 바디: id1=점유(LLM 일치), id2=점유(LLM 불일치) → agreedSpaces=1/2. */
const logicOcc: LogicOccupancyPreset[] = [
  { key: '1:1', spaces: [{ idx: 1, occupied: true }, { idx: 2, occupied: true }] },
];

function makeFinalizer(store: SqliteStore, brain?: SetupBrain) {
  const { repo } = fakeRepo();
  return new Finalizer({ store, repo, brain, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
}

describe('Finalizer occupancyAgreement 게이트 (G6-②)', () => {
  it('brain 활성 + LLM 저장분 + 로직 점유 바디 → agreement 1회 산출(정확값)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    seedLlmOccupancy(store, runId);
    const getSpy = vi.spyOn(store, 'getLatestOccupancy');
    const finalizer = makeFinalizer(store, enabledBrain());

    const r = await finalizer.finalize(runId, { logicOccupancy: logicOcc });

    expect(r.occupancyAgreement).toEqual({ comparedPresets: 1, comparedSpaces: 2, agreedSpaces: 1, agreementRate: 0.5 });
    // LLM 재호출 없음 — 저장분(getLatestOccupancy) 재사용만(정확히 1회 참조).
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('LLM 저장분 없음 → occupancyAgreement 미부착(graceful skip)', async () => {
    const store = mem();
    const runId = seedStableRun(store); // insertOccupancy 없음.
    const finalizer = makeFinalizer(store, enabledBrain());
    const r = await finalizer.finalize(runId, { logicOccupancy: logicOcc });
    expect(r.occupancyAgreement).toBeUndefined();
  });

  it('로직 점유 바디 미전달 → skip(저장분 있어도 비교 안 함)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    seedLlmOccupancy(store, runId);
    const finalizer = makeFinalizer(store, enabledBrain());
    const r = await finalizer.finalize(runId); // opts 없음.
    expect(r.occupancyAgreement).toBeUndefined();
  });

  it('brain 비활성/미주입 → skip(저장분·바디 있어도 비교 안 함)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    seedLlmOccupancy(store, runId);
    const finalizer = makeFinalizer(store); // brain 미주입.
    const r = await finalizer.finalize(runId, { logicOccupancy: logicOcc });
    expect(r.occupancyAgreement).toBeUndefined();
  });

  it('일치 프리셋 없음(키 불일치) → comparedSpaces=0 → 미부착', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    seedLlmOccupancy(store, runId); // 저장분 키 '1:1'
    const finalizer = makeFinalizer(store, enabledBrain());
    const r = await finalizer.finalize(runId, { logicOccupancy: [{ key: '9:9', spaces: [{ idx: 1, occupied: true }] }] });
    expect(r.occupancyAgreement).toBeUndefined();
  });

  it('불변식: occupancyAgreement 유무와 무관하게 slots/좌표(roiByPreset) 동일(회귀)', async () => {
    // 동일 시드 두 run: 하나는 점유검증 수행, 하나는 skip → artifact.slots 동일해야.
    const storeA = mem();
    const runA = seedStableRun(storeA);
    seedLlmOccupancy(storeA, runA);
    const rA = await makeFinalizer(storeA, enabledBrain()).finalize(runA, { logicOccupancy: logicOcc });

    const storeB = mem();
    const runB = seedStableRun(storeB);
    const rB = await makeFinalizer(storeB).finalize(runB); // 검증 없음.

    expect(rA.occupancyAgreement).toBeDefined();
    expect(rB.occupancyAgreement).toBeUndefined();
    // 점유 검증은 메타만 — slots·좌표 불변.
    expect(rA.slots).toBe(rB.slots);
    expect(rA.artifact.slots).toEqual(rB.artifact.slots);
    expect(rA.artifact.slots[0].roiByPreset['1:1']).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });
});

// ---------- POST /capture/finalize 바디 스키마(occupancy?) ----------

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

function makeRouteServer() {
  const store = new SqliteStore(':memory:');
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), store, cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const { repo } = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: {
    presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  }, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
  });
  return { app, store, finalizer };
}

let app: FastifyInstance | undefined;
let routeStore: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (routeStore) { routeStore.close(); routeStore = undefined; }
});

describe('POST /capture/finalize — FinalizeBodySchema.occupancy 수용/거부', () => {
  it('occupancy 미지정(하위호환) → finalize(runId, {logicOccupancy: undefined}) 로 전달', async () => {
    const s = makeRouteServer(); app = s.app; routeStore = s.store;
    // 진행 중 run 이 없으면 400(no run to finalize) — 게이트 통과를 위해 스텁으로 대체 검증.
    const spy = vi.spyOn(s.finalizer, 'finalize').mockResolvedValue({ artifact: { presets: [], slots: [], globalIndex: [], createdAt: 'T' }, slots: 0, globalCount: 0 });
    // runId 명시 전달로 no-run 게이트 우회(FinalizeBodySchema.runId 옵셔널).
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: { runId: 1 } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(1, { logicOccupancy: undefined });
  });

  it('occupancy 옵셔널 바디 → finalize 로 logicOccupancy 전달', async () => {
    const s = makeRouteServer(); app = s.app; routeStore = s.store;
    const spy = vi.spyOn(s.finalizer, 'finalize').mockResolvedValue({
      artifact: { presets: [], slots: [], globalIndex: [], createdAt: 'T' }, slots: 0, globalCount: 0,
      occupancyAgreement: { comparedPresets: 1, comparedSpaces: 2, agreedSpaces: 1, agreementRate: 0.5 },
    });
    const occupancy = [{ key: '1:1', spaces: [{ idx: 1, occupied: true }, { idx: 2, occupied: false }] }];
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: { runId: 1, occupancy } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(1, { logicOccupancy: occupancy });
    // 응답에 occupancyAgreement 부가.
    expect(r.json().occupancyAgreement).toEqual({ comparedPresets: 1, comparedSpaces: 2, agreedSpaces: 1, agreementRate: 0.5 });
  });

  it('occupancy 잘못된 shape(spaces.idx 문자열) → 400', async () => {
    const s = makeRouteServer(); app = s.app; routeStore = s.store;
    const r = await app.inject({
      method: 'POST', url: '/capture/finalize',
      payload: { runId: 1, occupancy: [{ key: '1:1', spaces: [{ idx: 'x', occupied: true }] }] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('occupancy 잘못된 shape(occupied 누락) → 400', async () => {
    const s = makeRouteServer(); app = s.app; routeStore = s.store;
    const r = await app.inject({
      method: 'POST', url: '/capture/finalize',
      payload: { runId: 1, occupancy: [{ key: '1:1', spaces: [{ idx: 1 }] }] },
    });
    expect(r.statusCode).toBe(400);
  });
});
