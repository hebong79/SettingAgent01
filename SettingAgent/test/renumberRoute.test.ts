import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SaveStore } from '../src/store/SaveStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetInfoRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { SlotPtzArtifact } from '../src/calibrate/types.js';

/**
 * 검증자(qa): POST /mapping/renumber 통합(설계서 §6).
 * 200 정상 전파(DB slotId=new / setup_result slotId=new / setup_artifact globalIdx=new / slot_ptz remap) ·
 * 400 비순열 DB 무변경 · 뷰어 경로 동일 동작.
 */

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};

const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
};
const presetRow = (over: Partial<PresetInfoRow> = {}): PresetInfoRow => ({
  camId: 1, presetId: 1, presetName: 'P', placeId: 1, pan: 10, tilt: 5, zoom: 2, updatedAt: 'T', ...over,
});
const roi = [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }];
const slot = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi), vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: 10, tilt: 5, zoom: 3, centered: 1, img1: 'a.jpg', slot3dFrontCenter: null, updatedAt: 'T', ...over,
});

const slotPtzArtifact: SlotPtzArtifact = {
  createdAt: '2026-07-23T00:00:00.000Z',
  items: [
    { camIdx: 1, presetIdx: 1, slotId: '1', globalIdx: 1, ptz: { pan: 10, tilt: 5, zoom: 3 }, plateWidth: 0.12, centered: true, converged: true },
    { camIdx: 1, presetIdx: 2, slotId: '2', globalIdx: 2, ptz: { pan: 20, tilt: 6, zoom: 4 }, plateWidth: 0.15, centered: true, converged: true },
  ],
};

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined; store = undefined; dir = undefined;
});

interface Built { app: FastifyInstance; store: SqliteStore; saved: SetupArtifact[]; saveDir: string; slotPtzFile: string; }

function build(): Built {
  dir = mkdtempSync(join(tmpdir(), 'renum-route-'));
  const saveDir = join(dir, 'save');
  const slotPtzFile = join(dir, 'slot_ptz.json');
  writeFileSync(slotPtzFile, JSON.stringify(slotPtzArtifact), 'utf-8');

  store = new SqliteStore(':memory:');
  store.upsertPlaceInfo([placeRow]);
  store.upsertCameraInfo([cameraRow]);
  store.upsertPresetInfo([presetRow({ presetId: 1 }), presetRow({ presetId: 2 })]);
  store.replaceSlotSetup([
    slot({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
    slot({ slotId: 2, presetId: 2, presetSlotIdx: 1 }),
  ]);

  const { repo, saved } = fakeRepo();
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: {
    presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  } as ToolsConfig['setup'], sleep: async () => {}, now: () => 'T' });

  app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    sqlite: store, saveStore: new SaveStore(saveDir),
    calibrate: { outFile: slotPtzFile } as ToolsConfig['calibrate'],
  });
  return { app, store, saved, saveDir, slotPtzFile };
}

describe('POST /mapping/renumber', () => {
  it('유효 순열 → 200, DB slotId=new, setup_result/setup_artifact/slot_ptz 전파', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/renumber',
      payload: { mapping: [{ oldSlotId: 1, newSlotId: 2 }, { oldSlotId: 2, newSlotId: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.renumbered).toBe(2);
    expect(body.slotPtz).toBe('written');
    expect(body.artifactSaved).toBe(true);
    expect(body.setupResult).not.toBeNull();

    // DB: slotId 집합이 new({1,2}), 물리 1:1 행이 new id 2.
    const rows = b.store.getSlotSetup();
    expect(rows.map((r) => r.slotId).sort((a, c) => a - c)).toEqual([1, 2]);
    expect(rows.find((r) => r.presetKey === '1:1')!.slotId).toBe(2);
    expect(rows.find((r) => r.presetKey === '1:2')!.slotId).toBe(1);

    // setup_artifact: globalIdx=new slot_id.
    const artifact = b.saved.at(-1)!;
    expect(artifact.globalIndex.map((g) => g.globalIdx).sort((a, c) => a - c)).toEqual([1, 2]);

    // setup_result.json 고정본: slotId=new.
    const fixed = join(b.saveDir, 'setup_result.json');
    expect(existsSync(fixed)).toBe(true);
    const sr = JSON.parse(readFileSync(fixed, 'utf-8')) as { slots: Array<{ slotId: number }> };
    expect(sr.slots.map((s) => s.slotId).sort((a, c) => a - c)).toEqual([1, 2]);

    // slot_ptz.json: globalIdx new asc.
    const ptz = JSON.parse(readFileSync(b.slotPtzFile, 'utf-8')) as SlotPtzArtifact;
    expect(ptz.items.map((i) => i.globalIdx)).toEqual([1, 2]);
    expect(ptz.items[0].plateWidth).toBe(0.15); // new1 = 원래 slot2 데이터 보존
  });

  it('비순열(new 1..N 아님) → 400 & DB 무변경', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/renumber',
      payload: { mapping: [{ oldSlotId: 1, newSlotId: 1 }, { oldSlotId: 2, newSlotId: 4 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(b.store.getSlotSetup().map((r) => r.slotId).sort((a, c) => a - c)).toEqual([1, 2]);
  });

  it('zod 위반(빈 mapping) → 400', async () => {
    const b = build();
    const res = await b.app.inject({ method: 'POST', url: '/mapping/renumber', payload: { mapping: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('뷰어 경로 /viewer/api/mapping/renumber 도 동일 동작', async () => {
    dir = mkdtempSync(join(tmpdir(), 'renum-view-'));
    const saveDir = join(dir, 'save');
    const slotPtzFile = join(dir, 'slot_ptz.json');
    writeFileSync(slotPtzFile, JSON.stringify(slotPtzArtifact), 'utf-8');
    store = new SqliteStore(':memory:');
    store.upsertPlaceInfo([placeRow]);
    store.upsertCameraInfo([cameraRow]);
    store.upsertPresetInfo([presetRow({ presetId: 1 }), presetRow({ presetId: 2 })]);
    store.replaceSlotSetup([
      slot({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
      slot({ slotId: 2, presetId: 2, presetSlotIdx: 1 }),
    ]);
    const { repo } = fakeRepo();
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: {
      presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
      accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
    } as ToolsConfig['setup'], sleep: async () => {}, now: () => 'T' });
    app = buildServer({
      orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
      sqlite: store, saveStore: new SaveStore(saveDir),
      calibrate: { outFile: slotPtzFile } as ToolsConfig['calibrate'],
      viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: dir, controlToken: '' }, sources: new Map(),
    });
    const res = await app.inject({
      method: 'POST', url: '/viewer/api/mapping/renumber',
      payload: { mapping: [{ oldSlotId: 1, newSlotId: 2 }, { oldSlotId: 2, newSlotId: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().renumbered).toBe(2);
    expect(store.getSlotSetup().find((r) => r.presetKey === '1:1')!.slotId).toBe(2);
  });
});
