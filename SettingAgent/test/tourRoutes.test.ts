import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { TourJob } from '../src/capture/TourJob.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { RpcCode } from '../src/rpc/errors.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): /capture/tour/* REST(fastify.inject) — discoverRoutes 미러(설계 §2.2 / T3).
 *
 * ★ 이 파일이 고정하는 것: 상태코드가 외부 제어자의 **재시도 정책**을 정확히 가른다.
 *   409 + 'busy'/'already running' → RPC BUSY(재시도) / 409(그 외) → CONFLICT(사람 개입) /
 *   404 → NOT_FOUND(정밀수집 먼저) / 미주입 404 → UNAVAILABLE.
 *   특히 **isBusy 409 는 REST 직접 호출의 최종 방어선**이다(RPC dispatch 를 안 타는 경로).
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

const SETUP_RESULT = {
  slots: [
    { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 1, tilt: 2, zoom: 3 } },
    { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, centering: null },
  ],
};

const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

function fakeCamera(): CameraClient {
  return {
    health: async () => true,
    clampZoom: (z: number) => z,
    listCameras: async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, pan: 9, tilt: 9, zoom: 9 }] }] }),
    move: async () => true,
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('x') }),
  } as unknown as CameraClient;
}

function artifact(): SetupArtifact {
  return { createdAt: 'T', presets: [], globalIndex: [], slots: [] };
}

function makeApp(opts: {
  loadSetupResult?: () => unknown | null;
  isBusy?: () => { busy: boolean; who?: string };
  sleep?: () => Promise<void>;
  withTour?: boolean;
} = {}): { app: FastifyInstance; job: TourJob } {
  const camera = fakeCamera();
  const repo = { loadArtifact: () => artifact(), saveArtifact: () => {} } as unknown as Repository;
  const job = new TourJob({
    camera,
    loadSetupResult: opts.loadSetupResult ?? (() => SETUP_RESULT),
    sleep: opts.sleep ?? (() => new Promise<void>(() => {})), // 기본은 첫 스텝에서 멈춰 running 유지.
    now: () => 'T',
  });
  const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera, vpd: fakeVpd(),
    ...(opts.withTour === false ? {} : { tourJob: job }),
    ...(opts.isBusy ? { isBusy: opts.isBusy } : {}),
  });
  return { app, job };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
});

describe('POST /capture/tour/start', () => {
  it('정상 → 200 {ok,started,total,presets,slots,skipped}', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, started: true, total: 2, presets: 1, slots: 1, skipped: 1 });
  });

  it('본문 없이 호출해도 200(기본값 적용)', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start' });
    expect(r.statusCode).toBe(200);
  });

  it('dwellMs:-1 → 400 invalid body(detail 보존)', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: { dwellMs: -1 } });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.error).toBe('invalid body');
    expect(body.detail).toBeTruthy();
  });

  it('dwellMs 상한 초과(10001) → 400', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: { dwellMs: 10001 } });
    expect(r.statusCode).toBe(400);
  });

  it('중복 시작 → 409 + "already running"(RPC BUSY 로 접힘)', async () => {
    const s = makeApp(); app = s.app;
    await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain('already running');
  });

  it('setup_result 없음 → 404 {error:"no setup_result"}', async () => {
    const s = makeApp({ loadSetupResult: () => null }); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('no setup_result');
  });

  it('순회 대상 0 → 409 + BUSY 단어 없음(→ RPC CONFLICT: 사람 개입)', async () => {
    const s = makeApp({ loadSetupResult: () => ({ slots: [] }) }); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    expect(r.statusCode).toBe(409);
    const msg = JSON.parse(r.body).error as string;
    expect(msg).toBe('순회할 슬롯/프리셋이 없습니다');
    expect(msg).not.toContain('busy');
    expect(msg).not.toContain('already running');
  });

  it('★ isBusy=true → 409 + "busy"(REST 직접 호출의 최종 방어선, R5). 잡은 시작되지 않는다', async () => {
    const s = makeApp({ isBusy: () => ({ busy: true, who: '렌즈 캘리브레이션' }) }); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain('busy');
    expect(JSON.parse(r.body).error).toContain('렌즈 캘리브레이션');
    expect(s.job.getStatus().state).toBe('idle');
  });

  it('isBusy=false → 정상 시작(게이트가 항상 막지는 않는다)', async () => {
    const s = makeApp({ isBusy: () => ({ busy: false }) }); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    expect(r.statusCode).toBe(200);
  });

  it('source 미해석 → 400 source not found(sources 미주입)', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/start', payload: { source: 'nope' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('source not found');
    expect(s.job.getStatus().state).toBe('idle');
  });
});

describe('GET /capture/tour/status', () => {
  it('시작 전 → idle shape', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'GET', url: '/capture/tour/status' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ state: 'idle', done: 0, total: 0, presets: 0, slots: 0, skipped: 0, succeeded: 0, failed: 0 });
  });

  it('시작 후 → running + total/presets/slots/skipped 반영', async () => {
    const s = makeApp(); app = s.app;
    await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/capture/tour/status' })).body);
    expect(body.state).toBe('running');
    expect(body.total).toBe(2);
    expect(body.skipped).toBe(1);
    expect(body.startedAt).toBe('T');
  });

  it('sleep 즉시 resolve → 완료 후 done 상태(done===total)', async () => {
    const s = makeApp({ sleep: async () => {} }); app = s.app;
    await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    for (let i = 0; i < 200; i++) {
      const b = JSON.parse((await app.inject({ method: 'GET', url: '/capture/tour/status' })).body);
      if (b.state === 'done') { expect(b.done).toBe(b.total); return; }
    }
    throw new Error('완료되지 않았다');
  });
});

describe('POST /capture/tour/stop', () => {
  it('running 중 stop → 200 {ok, state:"stopping"}', async () => {
    const s = makeApp(); app = s.app;
    await app.inject({ method: 'POST', url: '/capture/tour/start', payload: {} });
    const r = await app.inject({ method: 'POST', url: '/capture/tour/stop' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, state: 'stopping' });
  });

  it('idle 에서 stop → 200 {ok, state:"idle"}(멱등)', async () => {
    const s = makeApp(); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/capture/tour/stop' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, state: 'idle' });
  });
});

describe('RPC 위임 — capture.tour.* 는 로직을 갖지 않는다(같은 라우트·같은 사실)', () => {
  const rpc = async (a: FastifyInstance, method: string, params?: Record<string, unknown>) => {
    const r = await a.inject({ method: 'POST', url: '/rpc', payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } });
    return r.json() as { result?: unknown; error?: { code: number; message: string } };
  };

  it('capture.tour.status == GET /capture/tour/status', async () => {
    const s = makeApp(); app = s.app;
    const rest = await app.inject({ method: 'GET', url: '/capture/tour/status' });
    expect((await rpc(app, 'capture.tour.status')).result).toEqual(rest.json());
  });

  it('capture.tour.start — setup_result 없음 → -32002 NOT_FOUND(+ 같은 메시지)', async () => {
    const s = makeApp({ loadSetupResult: () => null }); app = s.app;
    const e = (await rpc(app, 'capture.tour.start', {})).error;
    expect(e?.code).toBe(RpcCode.NOT_FOUND);
    expect(e?.message).toBe('no setup_result');
  });

  it('capture.tour.start — isBusy → -32001 BUSY(재시도로 풀린다)', async () => {
    const s = makeApp({ isBusy: () => ({ busy: true, who: '정밀수집' }) }); app = s.app;
    expect((await rpc(app, 'capture.tour.start', {})).error?.code).toBe(RpcCode.BUSY);
  });

  it('capture.tour.start — 순회 대상 0 → -32005 CONFLICT(사람 개입)', async () => {
    const s = makeApp({ loadSetupResult: () => ({ slots: [] }) }); app = s.app;
    expect((await rpc(app, 'capture.tour.start', {})).error?.code).toBe(RpcCode.CONFLICT);
  });

  it('capture.tour.stop — 본문 없는 POST 도 정상(브리지 content-type 결함 재발 방지)', async () => {
    const s = makeApp(); app = s.app;
    expect((await rpc(app, 'capture.tour.stop')).result).toEqual({ ok: true, state: 'idle' });
  });

  it('tourJob 미주입 → -32004 UNAVAILABLE(기능 off 와 값 없음을 구분)', async () => {
    const s = makeApp({ withTour: false }); app = s.app;
    expect((await rpc(app, 'capture.tour.status')).error?.code).toBe(RpcCode.UNAVAILABLE);
  });
});

describe('tourJob 미주입 시 미등록(가산·대칭)', () => {
  it('/capture/tour/status·start·stop 전부 404, /health 정상', async () => {
    const s = makeApp({ withTour: false }); app = s.app;
    for (const [method, url] of [['GET', '/capture/tour/status'], ['POST', '/capture/tour/start'], ['POST', '/capture/tour/stop']] as const) {
      const r = await app.inject({ method, url });
      expect(`${method} ${url}: ${r.statusCode}`).toBe(`${method} ${url}: 404`);
      // Fastify 기본 404(라우트 미등록) → RPC 는 UNAVAILABLE 로 접는다(값 없음 404 와 구분).
      expect(JSON.parse(r.body).message).toMatch(/^Route /);
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
