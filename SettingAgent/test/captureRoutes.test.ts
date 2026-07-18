import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { polygonCentroid } from '../src/domain/polygon.js';
import { SaveStore } from '../src/store/SaveStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): /capture/* REST (fastify.inject) — DB 스키마 개편 후 재작성.
 * start/status/stop/finalize/aggregate/occupancy + zod 400 + 중복 409.
 * 기존 /setup/*·/mapping 회귀 확인(가산·불변).
 *
 * ★ run_id 폐기(설계서 §3): `/capture/runs` 제거, `/capture/runs/:id/aggregate` → `/capture/aggregate`,
 *   `/capture/runs/:id/occupancy` → `/capture/occupancy`(둘 다 CaptureJob 인메모리 getter 위임).
 *   `/capture/finalize` 바디에 runId 없음 — 현재 잡의 getSnapshot() 을 finalize. CaptureJobDeps 에서
 *   `store` 가 제거되어 `new CaptureJob({...})` 리터럴에서도 제거했다(store 는 SqliteStore/buildServer.sqlite
 *   에는 여전히 필요 — `/capture/slots` 가 store.getSlotSetup() 을 직접 쓴다).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
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
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
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

describe('/capture/finalize (runId 폐기 — 현재 잡 인메모리 스냅샷 finalize)', () => {
  it('running 중 finalize → 409', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 5, targets: [target] } });
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).state).toBe('running');
  });

  it('잡을 한 번도 시작하지 않은 상태(idle)에서도 finalize 가능 → 200 slots:0(runId 불필요)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.slots).toBe(0); // 빈 스냅샷(검출 없음) → 강등 slots 0.
    expect(body).toHaveProperty('globalCount');
  });

  it('중지된 잡 finalize → 200 {ok, slots, globalCount}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 5, targets: [target] } });
    await app.inject({ method: 'POST', url: '/capture/stop' }); // 타이머 미발화(roundRunning=false) → 즉시 stopped.
    const r = await app.inject({ method: 'POST', url: '/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('slots');
    expect(body).toHaveProperty('globalCount');
  });

  it('바디에 occupancy(로직 점유 스냅샷) 동봉 → 400 없이 수용(비교 불가 시 occupancyAgreement 미부착)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({
      method: 'POST', url: '/capture/finalize',
      payload: { occupancy: [{ key: '1:1', spaces: [{ idx: 1, occupied: true }] }] },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    // brain 미주입 → 비교 자체가 비활성(graceful skip) → occupancyAgreement 키 없음.
    expect(body.occupancyAgreement).toBeUndefined();
  });
});

describe('/capture/aggregate (구 /capture/runs/:id/aggregate — run_id 폐기)', () => {
  it('초기 상태(캡처 이력 없음) → 200 빈 배열', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/aggregate' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('job.getAggregated() 를 그대로 위임(AggregatedSlot[] shape 불변)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const fake: AggregatedSlot[] = [{
      presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1,
      support: 3, occupancyRate: 0.5, plateX: null, plateY: null, plateW: null, plateH: null, plateQuad: null,
      confidence: 0, posSpread: 0, angleSpread: null, status: 'candidate',
    }];
    vi.spyOn(s.job, 'getAggregated').mockReturnValue(fake);
    const r = await app.inject({ method: 'GET', url: '/capture/aggregate' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveLength(1);
    expect(body[0].presetKey).toBe('1:1');
  });
});

describe('/capture/occupancy (구 /capture/runs/:id/occupancy — 성공기준 5, run_id 폐기)', () => {
  it('LLM off(occByPreset 비어있음) → 200 빈 배열', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/occupancy' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('job.getOccupancy() 를 그대로 위임(프리셋별 shape 불변)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const fake = [{ camIdx: 1, presetIdx: 1, occupiedCount: 2, total: 4, rate: 0.5, spacesJson: JSON.stringify([{ id: 1, occupied: true }]) }];
    vi.spyOn(s.job, 'getOccupancy').mockReturnValue(fake);
    const r = await app.inject({ method: 'GET', url: '/capture/occupancy' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ camIdx: 1, presetIdx: 1, occupiedCount: 2, total: 4, rate: 0.5 });
    expect(body[0]).toHaveProperty('spacesJson');
  });
});

describe('/capture/slots (구 /capture/runs/:id/slots — store.getSlotSetup() 직접 위임)', () => {
  it('store.getSlotSetup() 을 그대로 위임(SlotSetupView[] shape 통과)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const fake = [{
      slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
      roi: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }],
      vpd: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
      lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null, updatedAt: 'T',
    }];
    vi.spyOn(s.store, 'getSlotSetup').mockReturnValue(fake);
    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual(fake);
  });

  it('빈 slot_setup → 200 빈 배열', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });
});

describe('/capture/start 트리거 필드 → job.start 조립 (성공기준 6)', () => {
  it('트리거 미지정 → cfg 폴백(rounds, 60000)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.job, 'start');
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000,
    }));
  });

  it('트리거 지정(time + interval) → job.start 로 그대로 전달', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.job, 'start');
    const r = await app.inject({
      method: 'POST', url: '/capture/start',
      payload: { count: 3, checkpointTriggerMode: 'time', checkpointIntervalMs: 5000, targets: [target] },
    });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      checkpointTriggerMode: 'time', checkpointIntervalMs: 5000,
    }));
  });

  it('잘못된 트리거 모드 값 → 400 (zod enum)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({
      method: 'POST', url: '/capture/start',
      payload: { count: 3, checkpointTriggerMode: 'bogus', targets: [target] },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('POST /capture/warmup (수동 강제 구동 §e)', () => {
  /** brain 을 주입한 서버(warmup 스파이 관찰용). */
  function makeServerWithBrain(warmupImpl: () => Promise<boolean>) {
    const store = new SqliteStore(':memory:');
    const queue: Array<() => void> = [];
    const warmup = vi.fn(warmupImpl);
    const brain = { enabled: true, warmup } as unknown as import('../src/brain/AgentRuntime.js').AgentRuntime;
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false, brain,
      setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
      clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
    });
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({
      orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(), brain,
      captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    });
    return { app: a, store, warmup };
  }

  it('brain 주입 + warmup 성공 → 200 {ok:true}, warmup 스파이 1회', async () => {
    const s = makeServerWithBrain(async () => true); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/warmup' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(s.warmup).toHaveBeenCalledTimes(1);
  });

  it('brain 주입 + warmup 실패(false) → 200 {ok:false}', async () => {
    const s = makeServerWithBrain(async () => false); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/warmup' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: false });
  });

  it('brain 미주입 → 200 {ok:false} (옵셔널 체이닝 no-op)', async () => {
    const s = makeServer(); app = s.app; store = s.store; // brain 없음
    const r = await app.inject({ method: 'POST', url: '/capture/warmup' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: false });
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

describe('/capture/save·saves (정밀수집 결과 저장/열기)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  });

  function validArtifact(): SetupArtifact {
    return {
      createdAt: 'T',
      presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['a'] }],
      slots: [{ slotId: 'a', zone: 'z', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }],
      globalIndex: [{ globalIdx: 1, slotId: 'a', camIdx: 1, presetIdx: 1 }],
    };
  }

  /** SaveStore(임시 saveDir) 를 주입한 서버. */
  function makeSaveServer() {
    const saveDir = mkdtempSync(join(tmpdir(), 'caproutes-save-'));
    dir = saveDir;
    const s = new SqliteStore(':memory:');
    const queue: Array<() => void> = [];
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
      setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
      clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
    });
    const { repo } = fakeRepo();
    const saveStore = new SaveStore(saveDir);
    const finalizer = new Finalizer({ store: s, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({
      orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
      captureJob: job, finalizer, sqlite: s, capture: captureCfg, saveStore,
    });
    return { app: a, store: s, saveDir };
  }

  it('POST /capture/save 유효 → 200 + 파일 생성', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/save', payload: { name: '내 결과', artifact: validArtifact() } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ ok: true, name: '내_결과', slots: 1, globalCount: 1 });
    expect(existsSync(join(sv.saveDir, '내_결과.json'))).toBe(true);
  });

  it('POST /capture/save 잘못된 name(traversal) → 400 invalid name', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/save', payload: { name: '../etc/passwd', artifact: validArtifact() } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid name');
  });

  it('POST /capture/save coverage 불일치 → 400', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    const bad = validArtifact();
    bad.globalIndex = []; // slot a 누락.
    const r = await app.inject({ method: 'POST', url: '/capture/save', payload: { name: 'x', artifact: bad } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('coverage mismatch');
    expect(JSON.parse(r.body).missing).toEqual(['a']);
  });

  it('POST /capture/save 잘못된 artifact shape → 400 invalid artifact', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/save', payload: { name: 'x', artifact: { presets: 'nope' } } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid artifact');
  });

  it('GET /capture/saves → 저장 목록', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    await app.inject({ method: 'POST', url: '/capture/save', payload: { name: 'one', artifact: validArtifact() } });
    await app.inject({ method: 'POST', url: '/capture/save', payload: { name: 'two', artifact: validArtifact() } });
    const r = await app.inject({ method: 'GET', url: '/capture/saves' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.saves.map((x: { name: string }) => x.name).sort()).toEqual(['one', 'two']);
    expect(typeof body.saves[0].savedAt).toBe('string');
  });

  it('GET /capture/saves/:name → 200 artifact', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    await app.inject({ method: 'POST', url: '/capture/save', payload: { name: 'openme', artifact: validArtifact() } });
    const r = await app.inject({ method: 'GET', url: '/capture/saves/openme' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).slots[0].slotId).toBe('a');
  });

  it('GET /capture/saves/:name 없는 이름 → 404', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'GET', url: '/capture/saves/nope' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('not found');
  });

  it('GET /capture/saves/:name 잘못된 이름(허용문자 0) → 400', async () => {
    const sv = makeSaveServer(); app = sv.app; store = sv.store;
    // 단일 세그먼트로 라우팅되지만 안전화 후 빈 문자열(허용 외 문자만) → 400.
    const r = await app.inject({ method: 'GET', url: `/capture/saves/${encodeURIComponent('!!!')}` });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid name');
  });

  it('saveStore 미주입 → /capture/save 404(미등록, 가산)', async () => {
    const s = makeServer(); app = s.app; store = s.store; // saveStore 없음
    const r = await app.inject({ method: 'POST', url: '/capture/save', payload: { name: 'x', artifact: validArtifact() } });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /capture/detect (라이브 VPD/LPD 검출 — §04)', () => {
  // readJpegSize 가 파싱 가능한 최소 JPEG(SOF0: 200×100).
  const VALID_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  /** detect 라우트용 카메라 스텁(listCameras/clampZoom/requestImage 포함, 유효 JPEG). */
  const detectCamera = (requestThrows = false) => ({
    health: async () => true,
    clampZoom: (z: number) => Math.min(10, Math.max(1, z)),
    listCameras: async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'p1', pan: 10, tilt: 5, zoom: 1.5 }] }] }),
    requestImage: async (c: number, p: number): Promise<CapturedImage> => {
      if (requestThrows) throw new Error('req_img down');
      return { camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG };
    },
  } as unknown as CameraClient);
  const detectVpd = (vehicles: unknown[] = []) => ({ health: async () => true, detect: async () => vehicles } as unknown as VpdClient);
  const detectLpd = (plates: unknown[] = []) => ({ health: async () => true, detect: async () => plates } as unknown as LpdClient);

  /** camera/vpd/lpd 모두 주입해야 detect 라우트 등록됨(가드). */
  function makeDetectServer(camera: CameraClient) {
    const s = new SqliteStore(':memory:');
    const queue: Array<() => void> = [];
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
      setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
      clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
    });
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store: s, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({
      orchestrator, repo, camera, vpd: detectVpd(), lpd: detectLpd(),
      captureJob: job, finalizer, sqlite: s, capture: captureCfg,
    });
    return { app: a, store: s };
  }

  it('정상 {cam:1,preset:1} → 200 + vehicles/plates/summary/basePtz', async () => {
    const sv = makeDetectServer(detectCamera()); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1 } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveProperty('vehicles');
    expect(body).toHaveProperty('plates');
    expect(body).toHaveProperty('summary');
    // 경계면: resolvePresetPtz 로 basePtz 가 프리셋 PTZ(echo 0/0/1 아님).
    expect(body.basePtz).toEqual({ pan: 10, tilt: 5, zoom: 1.5 });
    // placeRoiFile 미주입 → 모드A 요청(기본 true)이 강등(전량 통과) + 사유 노출(조용한 폴백 금지).
    expect(body.summary).toEqual({
      vpdCount: 0,
      lpdCount: 0,
      recovered: 0,
      onPlaceOnly: false,
      filteredOut: 0,
      lpdFilteredOut: 0,
      onPlaceDegraded: '주차면 파일 없음/로드 실패',
    });
  });

  it('cam 누락(잘못된 body) → 400', async () => {
    const sv = makeDetectServer(detectCamera()); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { preset: 1 } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid body');
  });

  it('camera.requestImage throw → 502 detect failed', async () => {
    const sv = makeDetectServer(detectCamera(true)); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1 } });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body).error).toBe('detect failed');
  });

  it('lpd 미주입 → detect 라우트 미등록(404, 가산 가드)', async () => {
    const s = makeServer(); app = s.app; store = s.store; // lpd 없음
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1 } });
    expect(r.statusCode).toBe(404);
  });
});

/**
 * 주차면 필터(모드A) REST 경계 — 01_architect_plan.md §6 항목 16~18.
 * ⚠️ 동결 픽스처 `test/fixtures/PtzCamRoi.unity.json` 만 쓴다(런타임 data/Place01/PtzCamRoi.json 금지 — HANDOFF §2-2).
 */
describe('주차면 필터 REST 경계 (§6-16~18)', () => {
  const FIXTURE = 'test/fixtures/PtzCamRoi.unity.json';
  const VALID_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  /** 픽스처 cam1:preset1 주차면 → 주차차/통행차 좌표 파생(하드코딩 금지). */
  const POLYS = (() => {
    const place = normalizePtzCamRoi(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const spaces = place.byPreset.get('1:1');
    if (!spaces?.length) throw new Error('픽스처 cam1:preset1 주차면 없음 — 테스트 전제 붕괴');
    return spaces.map((s) => s.points);
  })();
  const PARKED = (() => {
    const c = polygonCentroid(POLYS[0]);
    const w = 0.06, h = 0.24; // 접지 밴드(하단 25%) 중심이 폴리곤 무게중심에 오도록.
    return { rect: { x: c.x - w / 2, y: c.y - h * 0.875, w, h }, confidence: 0.9, cls: 'car' };
  })();
  const PASSING = { rect: { x: 0.40, y: 0.80, w: 0.10, h: 0.18 }, confidence: 0.9, cls: 'car' }; // 통로.

  const roiCamera = () => ({
    health: async () => true,
    clampZoom: (z: number) => Math.min(10, Math.max(1, z)),
    listCameras: async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'p1', pan: 10, tilt: 5, zoom: 1.5 }] }] }),
    requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG }),
  } as unknown as CameraClient);

  /** placeRoiFile(동결 픽스처) 주입 서버 — detect 가 실제로 폴리곤을 읽는 경로. */
  function makeRoiServer() {
    const s = new SqliteStore(':memory:');
    const queue: Array<() => void> = [];
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
      setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
      clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
    });
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store: s, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({
      orchestrator, repo, camera: roiCamera(),
      vpd: { health: async () => true, detect: async () => [PARKED, PASSING] } as unknown as VpdClient,
      lpd: { health: async () => true, detect: async () => [] } as unknown as LpdClient,
      captureJob: job, finalizer, sqlite: s, capture: captureCfg,
      placeRoiFile: FIXTURE,
    });
    return { app: a, store: s, job };
  }

  it('§6-16 POST /capture/start {vpdOnParkingOnly:false} → zod 통과 + job.start 로 전달', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.job, 'start');
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target], vpdOnParkingOnly: false } });
    expect(r.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ vpdOnParkingOnly: false }));
    expect(s.job.getStatus().vpdOnParkingOnly).toBe(false); // status 로도 관측(진행 중 run 의 실제 모드).
  });

  it('§6-16b start 에서 미지정 → 기본 모드A(status.vpdOnParkingOnly=true)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    expect(r.statusCode).toBe(200);
    expect(s.job.getStatus().vpdOnParkingOnly).toBe(true);
  });

  it('§6-16c vpdOnParkingOnly 비불리언 → 400 (zod)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target], vpdOnParkingOnly: 'yes' } });
    expect(r.statusCode).toBe(400);
  });

  it('★ §6-17 POST /capture/detect 모드 미지정 + placeRoiFile 주입 → 기본 모드A 로 필터', async () => {
    const sv = makeRoiServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1 } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.vehicles).toHaveLength(1); // 통행차 제외.
    expect(body.summary).toEqual({
      vpdCount: 2, lpdCount: 0, recovered: 0, onPlaceOnly: true, filteredOut: 1, lpdFilteredOut: 0,
    });
    expect(body.summary.onPlaceDegraded).toBeUndefined(); // 폴리곤이 있으므로 강등 아님.
  });

  it('§6-18 POST /capture/detect {vpdOnParkingOnly:false} + placeRoiFile 주입 → 전량 통과', async () => {
    const sv = makeRoiServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1, vpdOnParkingOnly: false } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.vehicles).toHaveLength(2);
    expect(body.summary.onPlaceOnly).toBe(false);
    expect(body.summary.filteredOut).toBe(0);
    expect(body.summary.onPlaceDegraded).toBeUndefined(); // 사용자 선택 — 강등 아님.
  });

  it('§6-18b 주차면 없는 프리셋(preset 9) → 강등 사유가 파일 부재와 구별된다', async () => {
    const sv = makeRoiServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 9 } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.vehicles).toHaveLength(2); // 전량 통과(드롭 금지).
    expect(body.summary.onPlaceOnly).toBe(false);
    expect(body.summary.onPlaceDegraded).toBe('프리셋 1:9 주차면 0개');
  });

  /**
   * ★ 경계면 교차 비교(qa 핵심): 서버 summary shape ↔ web/app.js:runLiveDetect 소비 필드.
   * app.js 는 `s.vpdCount - s.filteredOut` / `s.onPlaceOnly` / `s.onPlaceDegraded` 를 읽는다.
   * 필드명이 하나라도 바뀌면 프론트는 `NaN/undefined` 를 조용히 표시한다 → 여기서 봉인한다.
   */
  it('★ 경계면: detect summary 가 web/app.js 소비 계약(vpdCount·filteredOut·lpdCount·lpdFilteredOut·onPlaceOnly·onPlaceDegraded)을 만족', async () => {
    const sv = makeRoiServer(); app = sv.app; store = sv.store;
    const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1 } });
    const body = JSON.parse(r.body);
    const s = body.summary;
    expect(typeof s.vpdCount).toBe('number');
    expect(typeof s.filteredOut).toBe('number');
    expect(typeof s.onPlaceOnly).toBe('boolean');
    // app.js: `검출 ${s.vpdCount - s.filteredOut}/${s.vpdCount}대` → NaN 이 아니어야 한다.
    expect(Number.isFinite(s.vpdCount - s.filteredOut)).toBe(true);
    expect(s.vpdCount - s.filteredOut).toBe(body.vehicles.length);
    // 신규 필드(app.js: `번호판 ${s.lpdCount - s.lpdFilteredOut}/${s.lpdCount}`) — 이름이 바뀌면 프론트가 조용히 NaN 을 그린다.
    expect(typeof s.lpdCount).toBe('number');
    expect(typeof s.lpdFilteredOut).toBe('number');
    expect(Number.isFinite(s.lpdCount - s.lpdFilteredOut)).toBe(true);
    expect(body.plates.length).toBe(s.lpdCount - s.lpdFilteredOut); // 불변식.
  });

  /**
   * ★ 경계면 교차 비교: GET /capture/status shape ↔ web/app.js:renderCaptureStatus 소비 필드
   * (`status.vpdOnParkingOnly` / `status.vpdOnPlaceDegraded` / `status.vpdFilteredOut`).
   */
  it('★ 경계면: status 가 app.js 배지 계약(vpdOnParkingOnly·vpdFilteredOut·vpdOnPlaceDegraded)을 만족', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    // start 전: 필터 필드 자체가 없다(app.js 는 `!== undefined` 로 배지를 감춘다).
    const before = JSON.parse((await app.inject({ method: 'GET', url: '/capture/status' })).body);
    expect(before.vpdOnParkingOnly).toBeUndefined();

    await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 3, targets: [target] } });
    const after = JSON.parse((await app.inject({ method: 'GET', url: '/capture/status' })).body);
    expect(typeof after.vpdOnParkingOnly).toBe('boolean'); // 배지 표시 조건.
    expect(after.vpdFilteredOut).toBeUndefined(); // 제외 0 → 키 없음(app.js 의 falsy 가드와 정합).
    expect(after.lpdFilteredOut).toBeUndefined(); // 번호판 제외 0 → 동일(배지 괄호 생략).
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
