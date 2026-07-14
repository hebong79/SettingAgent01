import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): 바닥 ROI LLM 토글 백엔드 배선(설계 #03 §3-F8~F10).
 * (1) StartBodySchema 가 floorRoiUseLlm 옵셔널 수용(미지정 하위호환) + 잘못된 타입 거부(400),
 *     start 라우트가 job.start 로 값을 전달.
 * (2) CaptureJob checkpoint floorReviewer 게이트: floorRoiUseLlm=false → review 미호출,
 *     true/미지정 → 호출(기본 true 회귀 0). — R2 는 capture 실행 자체가 아니라 게이트 배선만.
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

const target: SetupTarget = { camIdx: 1, presetIdx: 1 };

// ---------- (1) 라우트 배선(fastify.inject) ----------

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeRouteServer() {
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
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
  });
  return { app, store, job };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('StartBodySchema.floorRoiUseLlm 배선 (F8)', () => {
  it('floorRoiUseLlm 미지정 → 200(하위호환), job.start 로 undefined 전달', async () => {
    const s = makeRouteServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.job, 'start');
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ floorRoiUseLlm: undefined }));
  });

  it('floorRoiUseLlm:false → 200, job.start 로 false 전달(파일 모드)', async () => {
    const s = makeRouteServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.job, 'start');
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, floorRoiUseLlm: false, targets: [target] } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ floorRoiUseLlm: false }));
  });

  it('floorRoiUseLlm:true → 200, job.start 로 true 전달(LLM 모드)', async () => {
    const s = makeRouteServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.job, 'start');
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, floorRoiUseLlm: true, targets: [target] } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ floorRoiUseLlm: true }));
  });

  it('floorRoiUseLlm 잘못된 타입(문자열) → 400 (zod boolean)', async () => {
    const s = makeRouteServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, floorRoiUseLlm: 'yes', targets: [target] } });
    expect(r.statusCode).toBe(400);
  });
});

// ---------- (2) CaptureJob floorReviewer 게이트(F9/F10) ----------

function fakeCameraJob(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: `i-${camIdx}-${presetIdx}`, jpg: Buffer.from('img'),
    }),
  } as unknown as CameraClient;
}
const vb = (x: number): VehicleBox => ({ rect: { x, y: 0.2, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });
function fakeVpdJob(): VpdClient {
  return { detect: async () => [vb(0.2)] } as unknown as VpdClient;
}
const jobTargets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];

function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const idx = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (idx >= 0) queue.splice(idx, 1);
  };
  const fireNext = async (): Promise<boolean> => {
    const h = queue.shift();
    if (!h) return false;
    h.fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return true;
  };
  return { setTimer, clearTimer, fireNext };
}

let openStores: SqliteStore[] = [];
afterEach(() => {
  for (const s of openStores) { try { s.close(); } catch { /* noop */ } }
  openStores = [];
});

function makeJob(over: Partial<CaptureJobDeps> = {}) {
  const st = new SqliteStore(':memory:');
  const timers = makeManualTimers();
  const deps: CaptureJobDeps = {
    camera: fakeCameraJob(), vpd: fakeVpdJob(), store: st, cfg: captureCfg, lpdEnabled: false,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, sleep: async () => {}, now: () => 'T',
    ...over,
  };
  return { job: new CaptureJob(deps), store: st, timers };
}

describe('CaptureJob checkpoint floorReviewer 게이트 (F9/F10)', () => {
  it('floorRoiUseLlm:false(파일 모드) → floorReviewer.review 미호출(LLM floor 스킵)', async () => {
    const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
    const floorReviewer = { review: reviewSpy } as unknown as CaptureJobDeps['floorReviewer'];
    const { job, store, timers } = makeJob({ floorReviewer });
    openStores.push(store);
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: jobTargets, floorRoiUseLlm: false });
    await timers.fireNext();
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it('floorRoiUseLlm:true → floorReviewer.review 호출(LLM 모드)', async () => {
    const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
    const floorReviewer = { review: reviewSpy } as unknown as CaptureJobDeps['floorReviewer'];
    const { job, store, timers } = makeJob({ floorReviewer });
    openStores.push(store);
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: jobTargets, floorRoiUseLlm: true });
    await timers.fireNext();
    expect(reviewSpy).toHaveBeenCalledTimes(1);
  });

  it('floorRoiUseLlm 미지정(기본 true) → floorReviewer.review 호출(회귀 0)', async () => {
    const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
    const floorReviewer = { review: reviewSpy } as unknown as CaptureJobDeps['floorReviewer'];
    const { job, store, timers } = makeJob({ floorReviewer });
    openStores.push(store);
    // floorRoiUseLlm 필드 자체를 넘기지 않음 → start() 에서 기본 true 로 해석되어야 함.
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: jobTargets });
    await timers.fireNext();
    expect(reviewSpy).toHaveBeenCalledTimes(1);
  });
});
