import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { SetupArtifact } from '../src/domain/types.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): /calibrate/* REST (fastify.inject).
 * start(200·중복 409·zod 400) + status(진행 shape) + result(있음 200·없음 404).
 * 기존 /setup/* 회귀(가산·미주입 시 미등록).
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

function calCfg(outFile: string): ToolsConfig['calibrate'] {
  return {
    targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
    probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
    settleMs: 0, outFile,
  };
}

function artifact(): SetupArtifact {
  return {
    createdAt: 'T', presets: [],
    globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    slots: [{ slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } }],
  };
}

function repoWith(a: SetupArtifact): Repository {
  return { loadArtifact: () => a } as unknown as Repository;
}

/** lpd 보유 1슬롯 slot_setup fixture(slot_id=1). PtzCalibrator 센터라이징 소스. */
function storeWith(): Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'> {
  const v: SlotSetupView[] = [{
    slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
  }];
  return { getSlotSetup: () => v, upsertSlotCentering: () => {} } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
}

function fakeCamera(): CameraClient {
  const moves: number[] = [];
  return {
    health: async () => true,
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      moves.push(ptz?.pan ?? 0);
      const pan = ptz?.pan ?? 0, tilt = ptz?.tilt ?? 0, zoom = ptz?.zoom ?? 1;
      const cx = 0.7 - pan * 0.02, cy = 0.8 - tilt * 0.02, w = Math.min(0.9, 0.05 * zoom);
      void cx; void cy; void w; // jpg 무관(LPD 가 결정)
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from(JSON.stringify({ pan, tilt, zoom })) };
    },
  } as unknown as CameraClient;
}
function fakeLpd(): LpdClient {
  return {
    detect: async (jpg: Buffer): Promise<PlateBox[]> => {
      const { pan, tilt, zoom } = JSON.parse(jpg.toString());
      const cx = 0.7 - pan * 0.02, cy = 0.8 - tilt * 0.02, w = Math.min(0.9, 0.05 * zoom), h = 0.03;
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;
}
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

function makeServer(outFile: string) {
  const repo = repoWith(artifact());
  const camera = fakeCamera();
  const calibrator = new PtzCalibrator({ camera, lpd: fakeLpd(), store: storeWith(), cfg: calCfg(outFile), sleep: async () => {}, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), calibrator, calibrate: calCfg(outFile) });
  return { app };
}

let app: FastifyInstance | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** start 후 잡 완료 대기(status 가 done 될 때까지 inject 폴링). */
async function waitDone(a: FastifyInstance): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await a.inject({ method: 'GET', url: '/calibrate/status' });
    if (JSON.parse(r.body).state !== 'running') return;
    await Promise.resolve();
  }
}

describe('/calibrate/ptz (start·409·zod)', () => {
  it('정상 start → 200 {ok, started, total}', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/ptz', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    await waitDone(app);
  });

  it('running 중 start → 409', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    // 잡이 첫 캡처에서 멈추도록 영원히 보류되는 sleep 주입 → running 유지 보장.
    let release: (() => void) | undefined;
    const blockingSleep = () => new Promise<void>((r) => { release = r; });
    const repo = repoWith(artifact());
    const camera = fakeCamera();
    const calibrator = new PtzCalibrator({ camera, lpd: fakeLpd(), store: storeWith(), cfg: calCfg(out), sleep: blockingSleep, now: () => 'T' });
    const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    app = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), calibrator, calibrate: calCfg(out) });
    await app.inject({ method: 'POST', url: '/calibrate/ptz', payload: {} });
    const r = await app.inject({ method: 'POST', url: '/calibrate/ptz', payload: {} });
    expect(r.statusCode).toBe(409);
    release?.(); // 정리
  });

  it('잘못된 body(slotIds 비배열) → 400', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'POST', url: '/calibrate/ptz', payload: { slotIds: 'nope' } });
    expect(r.statusCode).toBe(400);
  });
});

describe('/calibrate/status', () => {
  it('start 후 status → 진행 shape(state/done/total)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    const s = makeServer(out); app = s.app;
    await app.inject({ method: 'POST', url: '/calibrate/ptz', payload: {} });
    const r = await app.inject({ method: 'GET', url: '/calibrate/status' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('done');
    expect(body.total).toBe(1);
    await waitDone(app);
  });
});

describe('/calibrate/result', () => {
  it('결과 없음 → 404', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'GET', url: '/calibrate/result' });
    expect(r.statusCode).toBe(404);
  });

  it('완료 후 result → 200 {createdAt, items}', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    const s = makeServer(out); app = s.app;
    await app.inject({ method: 'POST', url: '/calibrate/ptz', payload: {} });
    await waitDone(app);
    const r = await app.inject({ method: 'GET', url: '/calibrate/result' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveProperty('createdAt');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slotId).toBe('1'); // slot_setup 소스: slotId=String(정수 slot_id)
  });
});

describe('calibrate 의존성 미주입 시 미등록(가산 보장)', () => {
  it('calibrator 미주입 → /calibrate/status 404, /setup/* 정상', async () => {
    const repo = repoWith(artifact());
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd() });
    const rc = await a.inject({ method: 'GET', url: '/calibrate/status' });
    expect(rc.statusCode).toBe(404);
    const rs = await a.inject({ method: 'GET', url: '/setup/status' });
    expect(rs.statusCode).toBe(200);
    await a.close();
  });
});

describe('result 직접 파일(잡 무관 200 경로 확인)', () => {
  it('outFile 존재 → 그대로 반환', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-')); const out = join(dir, 'slot_ptz.json');
    writeFileSync(out, JSON.stringify({ createdAt: 'X', items: [] }), 'utf-8');
    const s = makeServer(out); app = s.app;
    const r = await app.inject({ method: 'GET', url: '/calibrate/result' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).createdAt).toBe('X');
  });
});
