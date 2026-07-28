import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { CameraInfoRow, PlaceInfoRow, PresetInfoRow, SlotSetupRow } from '../src/capture/types.js';

/**
 * ROIMaker 저장 경로의 라우트 검증(설계서 §9.2 7~8).
 *   - POST /capture/slots/sync-roi : 비파괴 차등 동기(200/404/409)
 *   - PUT  /capture/place-roi      : 옵셔널 무결성 가드 expectRawCount(409 + 파일 무변경)
 *
 * captureLoadRoiRoutes.test.ts 의 서버 조립 패턴 재사용. 실 data/ 는 건드리지 않는다.
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

function makeServer(opts: { placeRoiFile?: string } = {}) {
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
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    placeRoiFile: opts.placeRoiFile,
  });
  return { app, store };
}

const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
};
const presetRow: PresetInfoRow = { camId: 1, presetId: 1, presetName: 'Preset 1', placeId: 1, pan: 10, tilt: 5, zoom: 2, updatedAt: 'T' };

/** 파일과 같은 자리(1:1#1, 1:1#2)에 있는 슬롯 2개 + 검출·센터링 채워넣기. */
function seedMatching(store: SqliteStore): void {
  store.upsertPlaceInfo([placeRow]);
  store.upsertCameraInfo([cameraRow]);
  store.upsertPresetInfo([presetRow]);
  const row = (slotId: number, off: number): SlotSetupRow => ({
    slotId, camId: 1, presetId: 1, presetSlotIdx: slotId,
    slotRoi: JSON.stringify([
      { x: (100 + off) / 1000, y: 0.1 }, { x: (300 + off) / 1000, y: 0.1 },
      { x: (300 + off) / 1000, y: 0.3 }, { x: (100 + off) / 1000, y: 0.3 },
    ]),
    vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
    lpdObb: null, occupyRange: null,
    pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/a.jpg', slot3dFrontCenter: null, updatedAt: 'T-old',
  });
  store.replaceSlotSetup([row(1, 0), row(2, 400)]);
}

let tmp: string | undefined;
function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'roisync-route-'));
  return tmp;
}
const poly = (o: number): number[][] => [[100 + o, 100], [300 + o, 100], [300 + o, 300], [100 + o, 300]];

/** cam1:preset1 에 2면을 가진 소형 ROI 파일(시드와 동일 좌표). */
function writeRoi(dir: string, spaces = [{ idx: 1, points: poly(0) }, { idx: 2, points: poly(400) }]): string {
  const p = join(dir, 'PtzCamRoi.json');
  writeFileSync(p, JSON.stringify({
    cameras: [{
      camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
      presets: [{ preset_idx: 1, pan: 10, tilt: 5, zoom: 2, parking_spaces: spaces }],
    }],
  }, null, 2));
  return p;
}

const md5 = (p: string) => createHash('md5').update(readFileSync(p)).digest('hex');

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; }
});

describe('POST /capture/slots/sync-roi', () => {
  it('404: placeRoiFile 미설정', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/slots/sync-roi' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false, error: 'placeRoiFile 미설정' });
  });

  it('200: 좌표 변경 → updates 1 · 검출·센터링 보존 · 행 수 불변', async () => {
    const dir = newTmp();
    const file = writeRoi(dir);
    const s = makeServer({ placeRoiFile: file }); app = s.app; store = s.store;
    seedMatching(store);

    // #1 만 이동한 파일로 교체.
    writeRoi(dir, [{ idx: 1, points: poly(50) }, { idx: 2, points: poly(400) }]);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/sync-roi' });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ ok: true, updates: 1, inserts: 0, unchanged: 1 });
    expect(body.orphans).toEqual([]);
    expect(Array.isArray(body.issues)).toBe(true);

    const views = store.getSlotSetup();
    expect(views).toHaveLength(2);
    expect(views.find((v) => v.slotId === 1)?.roi[0]).toEqual({ x: 0.15, y: 0.1 });
    // ★ 검출·센터링 보존.
    for (const v of views) {
      expect(v.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
      expect(v.centered).toBe(true);
      expect(v.pan).toBe(51.5);
      expect(v.img1).toBe('shots/a.jpg');
    }
  });

  it('409: 아이덴티티 불일치 → DB 무변경(ok:false)', async () => {
    const dir = newTmp();
    const file = writeRoi(dir);
    const s = makeServer({ placeRoiFile: file }); app = s.app; store = s.store;
    seedMatching(store);
    const before = store.getSlotSetup();

    // 두 면의 전역번호를 뒤바꾼다(유효한 순열이지만 배치가 DB 와 다르다).
    writeRoi(dir, [{ idx: 2, points: poly(0) }, { idx: 1, points: poly(400) }]);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/sync-roi' });

    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/아이덴티티 불일치/);
    expect(store.getSlotSetup()).toEqual(before);
  });

  it('멱등: 같은 파일 재호출 시 updates 0', async () => {
    const dir = newTmp();
    const s = makeServer({ placeRoiFile: writeRoi(dir) }); app = s.app; store = s.store;
    seedMatching(store);
    const first = JSON.parse((await app.inject({ method: 'POST', url: '/capture/slots/sync-roi' })).body);
    const second = JSON.parse((await app.inject({ method: 'POST', url: '/capture/slots/sync-roi' })).body);
    expect(first.updates).toBe(0); // 시드가 이미 파일과 같다.
    expect(second).toMatchObject({ ok: true, updates: 0, inserts: 0 });
  });
});

describe('PUT /capture/place-roi — expectRawCount 무결성 가드', () => {
  it('7. 개수 불일치 → 409 + 파일 md5 동일(무변경)', async () => {
    const dir = newTmp();
    const file = writeRoi(dir);
    const s = makeServer({ placeRoiFile: file }); app = s.app; store = s.store;
    const before = md5(file);

    const r = await app.inject({
      method: 'PUT',
      url: '/capture/place-roi',
      payload: { camId: 1, presetIdx: 1, spaces: [{ idx: 1, points: [{ x: 0.1, y: 0.1 }] }], expectRawCount: 1 },
    });

    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ expected: 1, actual: 2 });
    expect(md5(file)).toBe(before); // ★ 파일 무변경.
  });

  it('개수 일치 → 200 + 저장된다', async () => {
    const dir = newTmp();
    const file = writeRoi(dir);
    const s = makeServer({ placeRoiFile: file }); app = s.app; store = s.store;

    const r = await app.inject({
      method: 'PUT',
      url: '/capture/place-roi',
      payload: {
        camId: 1, presetIdx: 1, expectRawCount: 2,
        spaces: [
          { idx: 1, points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }] },
          { idx: 2, points: [] }, // ROI 만 지운 주차면(지시 #13) — 엔트리는 남는다.
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, spaceCount: 2 });
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    const spaces = saved.cameras[0].presets[0].parking_spaces;
    expect(spaces).toHaveLength(2);
    expect(spaces[1]).toEqual({ idx: 2, points: [] });
  });

  it('없는 카메라/프리셋을 가리키면 409(actual:-1) — 조용한 무시 금지', async () => {
    const dir = newTmp();
    const file = writeRoi(dir);
    const s = makeServer({ placeRoiFile: file }); app = s.app; store = s.store;
    const before = md5(file);

    const r = await app.inject({
      method: 'PUT',
      url: '/capture/place-roi',
      payload: { camId: 9, presetIdx: 9, spaces: [], expectRawCount: 0 },
    });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).actual).toBe(-1);
    expect(md5(file)).toBe(before);
  });

  it('8. expectRawCount 미제공 → 현행 동작 유지(기존 자동보정 호출자 회귀 0)', async () => {
    const dir = newTmp();
    const file = writeRoi(dir);
    const s = makeServer({ placeRoiFile: file }); app = s.app; store = s.store;

    const r = await app.inject({
      method: 'PUT',
      url: '/capture/place-roi',
      payload: { camId: 1, presetIdx: 1, spaces: [{ idx: 1, points: [{ x: 0.1, y: 0.1 }] }] },
    });
    expect(r.statusCode).toBe(200); // 가드 미개입 — 개수가 달라도 저장된다(종전과 동일).
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved.cameras[0].presets[0].parking_spaces).toHaveLength(1);
  });
});
