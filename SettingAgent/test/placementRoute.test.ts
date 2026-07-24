import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
import type { CameraInfoRow, PlaceInfoRow, PresetInfoRow, SlotSetupRow } from '../src/capture/types.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa): POST /mapping/placement 통합.
 * 200 정상(DB cam/preset/위치 갱신 + setup_result·setup_artifact 전파) ·
 * 400(충돌·미등록 프리셋) DB 무변경 · 위치 교환(UNIQUE 충돌 회피) · 뷰어 경로 동일.
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

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined; store = undefined; dir = undefined;
});

interface Built { app: FastifyInstance; store: SqliteStore; saved: SetupArtifact[]; saveDir: string; }

function build(viewer = false): Built {
  dir = mkdtempSync(join(tmpdir(), 'place-route-'));
  const saveDir = join(dir, 'save');

  store = new SqliteStore(':memory:');
  store.upsertPlaceInfo([placeRow]);
  store.upsertCameraInfo([cameraRow]);
  store.upsertPresetInfo([presetRow({ presetId: 1 }), presetRow({ presetId: 2 })]);
  store.replaceSlotSetup([
    slot({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
    slot({ slotId: 2, presetId: 1, presetSlotIdx: 2 }),
    slot({ slotId: 3, presetId: 2, presetSlotIdx: 1 }),
  ]);

  const { repo, saved } = fakeRepo();
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: {
    presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  } as ToolsConfig['setup'], sleep: async () => {}, now: () => 'T' });

  app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    sqlite: store, saveStore: new SaveStore(saveDir),
    ...(viewer
      ? { viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: dir, controlToken: '' }, sources: new Map() }
      : {}),
  });
  return { app, store, saved, saveDir };
}

/** slotId → `cam:preset:위치` 스냅샷(비교용). */
const placementOf = (s: SqliteStore): Record<number, string> =>
  Object.fromEntries(s.getSlotSetup().map((r) => [r.slotId, `${r.camId}:${r.presetId}:${r.presetSlotIdx}`]));

describe('POST /mapping/placement', () => {
  it('프리셋 이동 + 위치 교환 → 200, DB 갱신 & setup_result/setup_artifact 전파', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/placement',
      payload: { placements: [
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 2 }, // 1↔2 위치 교환(UNIQUE 충돌 회피 확인)
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 1 },
        { slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 1 },
      ] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(3);
    expect(body.artifactSaved).toBe(true);

    expect(placementOf(b.store)).toEqual({ 1: '1:1:2', 2: '1:1:1', 3: '1:2:1' });

    // 기하·센터링 컬럼은 무접촉(배치만 바뀐다).
    const s1 = b.store.getSlotSetup().find((r) => r.slotId === 1)!;
    expect(s1.roi).toEqual(roi);
    expect(s1.pan).toBe(10);
    expect(s1.centered).toBe(true);

    // setup_result.json 고정본 재생성(정렬은 cam,preset,위치 → slot 2 가 먼저).
    const fixed = join(b.saveDir, 'setup_result.json');
    expect(existsSync(fixed)).toBe(true);
    const sr = JSON.parse(readFileSync(fixed, 'utf-8')) as { slots: Array<{ slotId: number; presetSlotIdx: number }> };
    expect(sr.slots.map((s) => s.slotId)).toEqual([2, 1, 3]);

    // setup_artifact: 이동 후 coveredSlotIds 순서 = 위치순.
    const artifact = b.saved.at(-1)!;
    expect(artifact.presets.find((p) => p.presetIdx === 1)!.coveredSlotIds).toEqual(['2', '1']);
  });

  it('다른 카메라·프리셋으로 이동 → 200(ROI·PTZ 는 그대로 남는다)', async () => {
    const b = build();
    const before = b.store.getSlotSetup().find((r) => r.slotId === 2)!;
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/placement',
      payload: { placements: [{ slotId: 2, camId: 1, presetId: 2, presetSlotIdx: 2 }] },
    });
    expect(res.statusCode).toBe(200);
    const after = b.store.getSlotSetup().find((r) => r.slotId === 2)!;
    expect(after.presetKey).toBe('1:2');
    expect(after.roi).toEqual(before.roi); // 좌표 변환 없음(설계 명시 — 재수집 필요)
    expect(after.pan).toBe(before.pan);
  });

  it('삼중키 충돌 → 400 & DB 무변경', async () => {
    const b = build();
    const snapshot = placementOf(b.store);
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/placement',
      payload: { placements: [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 2 }] }, // slot2 가 점유중
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('배치 충돌');
    expect(placementOf(b.store)).toEqual(snapshot);
  });

  it('미등록 프리셋 → 400 & DB 무변경(FK 사전차단)', async () => {
    const b = build();
    const snapshot = placementOf(b.store);
    const res = await b.app.inject({
      method: 'POST', url: '/mapping/placement',
      payload: { placements: [{ slotId: 1, camId: 1, presetId: 7, presetSlotIdx: 1 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(placementOf(b.store)).toEqual(snapshot);
  });

  it('zod 위반(빈 placements) → 400', async () => {
    const b = build();
    const res = await b.app.inject({ method: 'POST', url: '/mapping/placement', payload: { placements: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('뷰어 경로 /viewer/api/mapping/placement 도 동일 동작', async () => {
    const b = build(true);
    const res = await b.app.inject({
      method: 'POST', url: '/viewer/api/mapping/placement',
      payload: { placements: [{ slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 2 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(placementOf(b.store)[3]).toBe('1:2:2');
  });
});
