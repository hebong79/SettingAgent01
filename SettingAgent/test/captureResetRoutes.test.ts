import { describe, it, expect, afterEach, vi } from 'vitest';
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
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetInfoRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): POST /capture/slots/reset (신규 라우트).
 * 라우트가 store.clearSlotSetupEnrichment 를 호출하고 `{ok:true, cleared:N}` 을 반환하는지,
 * 그리고 선행 저장 → reset → GET /capture/slots 왕복에서 enrichment 컬럼이 실제 null 이 되고
 * slot_roi 는 보존되는지 확인한다(captureRoutes.test.ts 앱부팅/inject 패턴 재사용).
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

// ── 시드 픽스처(왕복 검증용) ────────────────────────────────
const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
};
const presetRow: PresetInfoRow = { camId: 1, presetId: 1, presetName: 'Preset 1', placeId: 1, pan: 10, tilt: 5, zoom: 2, updatedAt: 'T' };
const roi: NormalizedPoint[] = [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }];
const lpdQuad: NormalizedQuad = [{ x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 }];
const enrichedSlot = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi),
  vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
  lpdObb: JSON.stringify(lpdQuad),
  occupyRange: JSON.stringify(roi),
  pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/c1.jpg', slot3dFrontCenter: null, updatedAt: 'T-old', ...over,
});

function seed(store: SqliteStore, slots: SlotSetupRow[]): void {
  store.upsertPlaceInfo([placeRow]);
  store.upsertCameraInfo([cameraRow]);
  store.upsertPresetInfo([presetRow]);
  store.replaceSlotSetup(slots);
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('POST /capture/slots/reset (검출·센터링 초기화 라우트)', () => {
  it('빈 slot_setup → 200 {ok:true, cleared:0}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/slots/reset' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, cleared: 0 });
  });

  it('store.clearSlotSetupEnrichment 를 호출하고 반환 cleared 를 그대로 위임', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const spy = vi.spyOn(s.store, 'clearSlotSetupEnrichment').mockReturnValue(4);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/reset' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, cleared: 4 });
    expect(spy).toHaveBeenCalledTimes(1);
    // updatedAt 인자(ISO 문자열) 전달 확인.
    expect(typeof spy.mock.calls[0][0]).toBe('string');
  });

  it('★ 왕복: 선행 저장 → reset → GET /capture/slots 시 enrichment null·slot_roi 보존', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    seed(s.store, [
      enrichedSlot({ slotId: 1, presetSlotIdx: 1 }),
      enrichedSlot({ slotId: 2, presetSlotIdx: 2 }),
    ]);

    // reset 전: enrichment 채워짐.
    const before = JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body);
    expect(before).toHaveLength(2);
    expect(before[0].vpd).not.toBeNull();
    expect(before[0].centered).toBe(true);

    const reset = await app.inject({ method: 'POST', url: '/capture/slots/reset' });
    expect(reset.statusCode).toBe(200);
    expect(JSON.parse(reset.body)).toEqual({ ok: true, cleared: 2 });

    // reset 후: enrichment null, roi/행 보존.
    const after = JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body);
    expect(after).toHaveLength(2); // 행 삭제 아님
    for (const v of after) {
      expect(v.vpd).toBeNull();
      expect(v.lpd).toBeNull();
      expect(v.occupyRange).toBeNull();
      expect(v.pan).toBeNull();
      expect(v.tilt).toBeNull();
      expect(v.zoom).toBeNull();
      expect(v.centered).toBe(false);
      expect(v.img1).toBeNull();
      expect(v.roi).toEqual(roi); // ★ 바닥 geometry 보존
    }
  });
});
