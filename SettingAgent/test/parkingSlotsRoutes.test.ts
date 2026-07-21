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
import type { SlotSetupRow } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): GET /capture/slots (§06 — DB 스키마 개편 후 재작성).
 * ★ 구 `/capture/runs/:id/slots`(run_id 기반 parking_slots) 는 폐기되었다 — 신 스키마는
 *   run_id 없는 slot_setup(전 슬롯 1행) 정본을 `store.getSlotSetup()` 으로 직접 조회한다.
 *   captureRoutes.test.ts 는 store.getSlotSetup 을 **모킹**해 라우트 위임 자체만 봉인하고,
 *   이 파일은 **실제 SqliteStore 왕복**(upsertCameraInfo/upsertPresetPos/replaceSlotSetup → GET)
 *   으로 FK·컬럼 매핑·presetKey 파생·null 처리·centered boolean 변환을 검증한다(비redundant).
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
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeServer() {
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
  const app = buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(), captureJob: job, finalizer, sqlite: store, capture: captureCfg });
  return { app, store };
}

/** slot_setup FK 부모(camera_info/preset_pos, 그리고 그 부모 place_info) 시딩. foreign_keys=ON 전제. */
function seedFkParents(store: SqliteStore, camId: number, presetId: number): void {
  store.upsertPlaceInfo([{ placeId: 1, placeName: 'P1' }]);
  store.upsertCameraInfo([{
    camId, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
    camType: 'ptz', camCompany: null, placeId: 1, imgW: null, imgH: null, updatedAt: null,
  }]);
  store.upsertPresetPos([{ camId, presetId, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: null }]);
}

const slotRow = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]),
  vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
  lpdObb: JSON.stringify([{ x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 }]),
  occupyRange: null,
  pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T',
  ...over,
});

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('GET /capture/slots (구 /capture/runs/:id/slots §06 H6 — slot_setup 정본)', () => {
  it('시드된 slot_setup → 200 + 행 배열(presetKey/roi/vpd/lpd/centered)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seedFkParents(store, 1, 1);
    store.replaceSlotSetup([
      slotRow({ slotId: 1, presetSlotIdx: 1, centered: 1 }),
      slotRow({ slotId: 2, presetSlotIdx: 2, vpdBbox: null, lpdObb: null, centered: 0 }),
    ]);

    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    const s1 = body.find((x) => x.slotId === 1)!;
    expect(s1.presetKey).toBe('1:1'); // 경계면: 프론트 오버레이 키 파생(`${camId}:${presetId}`)
    expect(s1.roi).toEqual([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]);
    expect(s1.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect(s1.centered).toBe(true); // 0/1 INTEGER → JSON boolean 변환
    const s2 = body.find((x) => x.slotId === 2)!;
    expect(s2.centered).toBe(false);
    expect(s2.vpd).toBeNull();
    expect(s2.lpd).toBeNull();
  });

  it('응답에 센터라이징 PTZ(pan/tilt/zoom) 필드 포함 — 값/null 모두', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seedFkParents(store, 1, 1);
    store.replaceSlotSetup([
      slotRow({ slotId: 1, presetSlotIdx: 1, pan: 15.5, tilt: -4.25, zoom: 6 }),
      slotRow({ slotId: 2, presetSlotIdx: 2, pan: null, tilt: null, zoom: null }),
    ]);

    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<Record<string, unknown>>;
    const s1 = body.find((x) => x.slotId === 1)!;
    expect(s1.pan).toBe(15.5);
    expect(s1.tilt).toBe(-4.25);
    expect(s1.zoom).toBe(6);
    const s2 = body.find((x) => x.slotId === 2)!;
    // JSON 직렬화 후에도 null 유지(undefined 로 사라지지 않음 — 소비처 shape 정합).
    expect(s2.pan).toBeNull();
    expect(s2.tilt).toBeNull();
    expect(s2.zoom).toBeNull();
    expect('pan' in s2).toBe(true);
  });

  it('slot_setup 행 없음(미시딩) → 200 빈 배열', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('presetKey 는 여러 프리셋에 걸쳐 cam_id:preset_id 로 정확히 파생된다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seedFkParents(store, 1, 1);
    seedFkParents(store, 2, 3);
    store.replaceSlotSetup([
      slotRow({ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1 }),
      slotRow({ slotId: 2, camId: 2, presetId: 3, presetSlotIdx: 1 }),
    ]);
    const r = await app.inject({ method: 'GET', url: '/capture/slots' });
    const body = r.json() as Array<Record<string, unknown>>;
    expect(body.find((x) => x.slotId === 1)!.presetKey).toBe('1:1');
    expect(body.find((x) => x.slotId === 2)!.presetKey).toBe('2:3');
  });
});
