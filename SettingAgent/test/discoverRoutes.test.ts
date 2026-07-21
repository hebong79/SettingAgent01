import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { PlateDiscoveryJob } from '../src/calibrate/PlateDiscoveryJob.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { PlateDiscoveryItem, DiscoveryTarget } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): /discover/* REST(fastify.inject) — calibrateRoutes 미러.
 * start(200·중복 409) + status(진행 shape·found) + result(있음 200·없음 404) + frame(없음 404) +
 * 미주입 시 미등록(가산·대칭 404). PlateDiscoveryJob 는 makeDiscovery/writer 시임으로 제어.
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

function artifact(): SetupArtifact {
  return { createdAt: 'T', presets: [], globalIndex: [], slots: [] };
}
function repoWith(a: SetupArtifact): Repository {
  return { loadArtifact: () => a } as unknown as Repository;
}
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeLpd = () => ({ detect: async () => [] } as unknown as LpdClient);

/** listCameras/requestImage 만 있으면 충분(makeDiscovery 시임이 탐색을 대신). */
function fakeCamera(): CameraClient {
  return {
    health: async () => true,
    clampZoom: (z: number) => z,
    listCameras: async () => ({ cameras: [] }),
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('x') }),
  } as unknown as CameraClient;
}

/** slot3d_front_center 보유 1슬롯 → expandDiscoveryTargets 가 1 대상 산출. */
function storeWith(): Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'> {
  const v: SlotSetupView[] = [{
    slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
    centered: false, img1: null, slot3dFrontCenter: { x: 0.5, y: 0.5 }, updatedAt: null,
  }];
  return { getSlotSetup: () => v, upsertSlotLpd: () => {} } as unknown as Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>;
}

/** slot3d_front_center 보유 2슬롯(프리셋 1:1·1:2 각 1) → cam/preset 필터 검증용. */
function storeWith2(): Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'> {
  const base = {
    roi: [], vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
    centered: false, img1: null, slot3dFrontCenter: { x: 0.5, y: 0.5 }, updatedAt: null,
  };
  const v: SlotSetupView[] = [
    { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1', ...base },
    { slotId: 2, camId: 1, presetId: 2, presetSlotIdx: 1, presetKey: '1:2', ...base },
  ];
  return { getSlotSetup: () => v, upsertSlotLpd: () => {} } as unknown as Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>;
}

function jobWith2(out: string): PlateDiscoveryJob {
  return new PlateDiscoveryJob({
    camera: fakeCamera(), lpd: fakeLpd(), store: storeWith2(), outFile: out,
    makeDiscovery: () => ({ discoverSlot: async (t: DiscoveryTarget) => foundItem(t) }),
    now: () => 'T',
  });
}

const foundItem = (t: DiscoveryTarget): PlateDiscoveryItem => ({
  camIdx: t.camIdx, presetIdx: t.presetIdx, slotId: t.slotId, globalIdx: t.globalIdx,
  found: true, lpdOrig: rectToQuad({ x: 0.6, y: 0.6, w: 0.05, h: 0.03 }), tier: 'crop', step: 1, confidence: 0.9,
});

/** 즉시 완료되는 잡 서버. */
function makeServer(out: string): { app: FastifyInstance } {
  const repo = repoWith(artifact());
  const camera = fakeCamera();
  const job = new PlateDiscoveryJob({
    camera, lpd: fakeLpd(), store: storeWith(), outFile: out,
    makeDiscovery: () => ({ discoverSlot: async (t: DiscoveryTarget) => foundItem(t) }),
    now: () => 'T',
  });
  const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), plateDiscovery: job, discoverOutFile: out });
  return { app };
}

let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function waitDone(a: FastifyInstance): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await a.inject({ method: 'GET', url: '/discover/status' });
    if (JSON.parse(r.body).state !== 'running') return;
    await Promise.resolve();
  }
}

describe('/discover/ptz (start·409)', () => {
  it('정상 start → 200 {ok, started, total}', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/discover/ptz', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.started).toBe(true);
    expect(body.total).toBe(1);
    await waitDone(app);
  });

  it('잘못된 타입 cam → 400(스키마 회귀)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/discover/ptz', payload: { cam: 'x' } });
    expect(r.statusCode).toBe(400);
  });

  it('running 중 start → 409', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    // discoverSlot 을 영원히 보류시켜 running 유지.
    let release: (() => void) | undefined;
    const camera = fakeCamera();
    const job = new PlateDiscoveryJob({
      camera, lpd: fakeLpd(), store: storeWith(), outFile: out,
      makeDiscovery: () => ({ discoverSlot: () => new Promise<PlateDiscoveryItem>((r) => { release = () => r(foundItem(({ camIdx: 1, presetIdx: 1, slotId: '1', globalIdx: 1, anchor: null, presetSlotIdx: 1 }))); }) }),
      now: () => 'T',
    });
    const repo = repoWith(artifact());
    const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    app = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), plateDiscovery: job, discoverOutFile: out });
    await app.inject({ method: 'POST', url: '/discover/ptz', payload: {} });
    const r = await app.inject({ method: 'POST', url: '/discover/ptz', payload: {} });
    expect(r.statusCode).toBe(409);
    release?.(); // 정리
  });
});

describe('/discover/status', () => {
  it('start 후 status → 진행 shape(state/done/total/found)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const s = makeServer(out); app = s.app;
    await app.inject({ method: 'POST', url: '/discover/ptz', payload: {} });
    const r = await app.inject({ method: 'GET', url: '/discover/status' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('done');
    expect(body).toHaveProperty('found');
    expect(body.total).toBe(1);
    await waitDone(app);
    // 완료 후 found 카운트 반영.
    const r2 = await app.inject({ method: 'GET', url: '/discover/status' });
    const b2 = JSON.parse(r2.body);
    expect(b2.state).toBe('done');
    expect(b2.found).toBe(1);
  });
});

describe('/discover/result', () => {
  it('결과 없음 → 404', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'GET', url: '/discover/result' });
    expect(r.statusCode).toBe(404);
  });

  it('완료 후 result → 200 {createdAt, items}', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const s = makeServer(out); app = s.app;
    await app.inject({ method: 'POST', url: '/discover/ptz', payload: {} });
    await waitDone(app);
    const r = await app.inject({ method: 'GET', url: '/discover/result' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.createdAt).toBe('T');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slotId).toBe('1');
    expect(body.items[0].found).toBe(true);
  });
});

describe('/discover/frame', () => {
  it('캡처 프레임 없음 → 404(makeDiscovery 시임은 onFrame 미호출)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'GET', url: '/discover/frame' });
    expect(r.statusCode).toBe(404);
  });
});

describe('PlateDiscoveryJob.start 현재 프리셋 한정(cam/preset 필터)', () => {
  it('cam/preset 지정 → 해당 프리셋 슬롯만(total===1)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({ cam: 1, preset: 2 }).total).toBe(1);
  });

  it('빈 필터({}) → 전체 배치 보존(total===2, 회귀 0)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({}).total).toBe(2);
  });

  it('미보유 프리셋(cam:9,preset:9) → total===0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({ cam: 9, preset: 9 }).total).toBe(0);
  });

  // 옵셔널 게이트: 설계상 필터는 cam+preset **둘 다** 전달 시에만 적용(부분 지정은 미적용 → 전체 보존).
  it('cam 만 지정({cam:1}) → 게이트 미충족 → 전체 배치 보존(total===2)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({ cam: 1 }).total).toBe(2);
  });

  it('preset 만 지정({preset:2}) → 게이트 미충족 → 전체 배치 보존(total===2)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({ preset: 2 }).total).toBe(2);
  });

  // cam/preset 필터 + slotIds 필터 공존(둘 다 같은 자리) — 프리셋 한정 후 slotIds 교집합.
  it('cam/preset + slotIds 공존 → 교집합(cam:1,preset:1 & slotIds:[1] → total===1)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({ cam: 1, preset: 1, slotIds: ['1'] }).total).toBe(1);
  });

  it('cam/preset + 불일치 slotIds → 교집합 공집합(cam:1,preset:1 & slotIds:[2] → total===0)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    expect(job.start({ cam: 1, preset: 1, slotIds: ['2'] }).total).toBe(0);
  });

  it('라우트 payload {cam,preset} → total 반영(현재 프리셋 한정)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'disc-')); const out = join(dir, 'plate_discovery.json');
    const job = jobWith2(out);
    const repo = repoWith(artifact());
    const camera = fakeCamera();
    const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    app = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), plateDiscovery: job, discoverOutFile: out });
    const r = await app.inject({ method: 'POST', url: '/discover/ptz', payload: { cam: 1, preset: 2 } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).total).toBe(1);
    await waitDone(app);
  });
});

describe('discover 의존성 미주입 시 미등록(가산·대칭)', () => {
  it('plateDiscovery 미주입 → /discover/status 404, /health 정상', async () => {
    const repo = repoWith(artifact());
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd() });
    const rc = await a.inject({ method: 'GET', url: '/discover/status' });
    expect(rc.statusCode).toBe(404);
    const rh = await a.inject({ method: 'GET', url: '/health' });
    expect(rh.statusCode).toBe(200);
    await a.close();
  });
});
