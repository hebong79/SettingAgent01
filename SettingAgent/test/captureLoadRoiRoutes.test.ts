import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import { buildCameraList } from '../src/viewer/cameraposCatalog.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CameraInfoRow, PlaceInfoRow, PresetPosRow, SlotSetupRow } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): POST /capture/slots/load-roi (신규 라우트) — 설계서 "검증(qa)" 5번.
 * 200(성공) / 404(placeRoiFile 미설정) / 409(loadRoiIntoDb 실패) 응답 shape 과
 * 실패 시 slot_setup 무손실을 라우트 경유로 확인한다(captureResetRoutes.test.ts 패턴 재사용).
 *
 * 응답 shape 은 web/app.js `loadRoiToDb` 가 소비하는 필드
 * (ok / error / slots / cameras / presets / skipped[{camId,presetId,count,reason}] / issues[]) 와 대조한다.
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

function makeServer(opts: { placeRoiFile?: string; cameraposFile?: string; presetProvider?: unknown } = {}) {
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
    ...(opts.cameraposFile ? { mapFiles: { cameraposFile: opts.cameraposFile } } : {}),
    ...(opts.presetProvider ? { presetProvider: opts.presetProvider as never } : {}),
  });
  return { app, store };
}

// ── 시드(파괴 여부 판정용) ─────────────────────────────────
const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
};
const presetRow: PresetPosRow = { camId: 1, presetId: 1, sname: 'Preset 1', pan: 10, tilt: 5, zoom: 2, updatedAt: 'T' };
const existingSlot = (slotId: number): SlotSetupRow => ({
  slotId, camId: 1, presetId: 1, presetSlotIdx: slotId,
  slotRoi: JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]),
  vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: null, slot3dFrontCenter: null, updatedAt: 'T-old',
});
function seed(store: SqliteStore, n: number): void {
  store.upsertPlaceInfo([placeRow]);
  store.upsertCameraInfo([cameraRow]);
  store.upsertPresetPos([presetRow]);
  store.replaceSlotSetup(Array.from({ length: n }, (_, i) => existingSlot(i + 1)));
}

let tmp: string | undefined;
function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'loadroi-route-'));
  return tmp;
}
/** cam1:preset1 에 2면을 가진 소형 ROI 파일. */
function writeRoi(dir: string): string {
  const poly = (o: number): number[][] => [[100 + o, 100], [300 + o, 100], [300 + o, 300], [100 + o, 300]];
  const p = join(dir, 'PtzCamRoi.json');
  writeFileSync(p, JSON.stringify({
    cameras: [{
      camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
      presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: poly(0) }, { idx: 2, points: poly(400) }] }],
    }],
  }));
  return p;
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; }
});

describe('POST /capture/slots/load-roi', () => {
  it('404: placeRoiFile 미설정 → {ok:false, error}', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    expect(r.statusCode).toBe(404);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('placeRoiFile 미설정');
  });

  it('200: 성공 시 RoiDbLoadResult shape(ok/slots/cameras/presets/skipped/issues) 반환', async () => {
    const dir = newTmp();
    const camerapos = join(dir, 'camerapos.json');
    writeFileSync(camerapos, JSON.stringify({ datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: 'P1', pan: 1, tilt: 2, zoom: 3 }] }] }));
    const s = makeServer({ placeRoiFile: writeRoi(dir), cameraposFile: camerapos });
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.slots).toBe(2);
    expect(body.cameras).toBe(1);
    expect(body.presets).toBe(1);
    expect(Array.isArray(body.skipped)).toBe(true);
    expect(body.skipped).toHaveLength(0);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.error).toBeUndefined();

    // 왕복: GET /capture/slots 로 실제 재구성 확인.
    const slots = JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body);
    expect(slots).toHaveLength(2);
    expect(slots.map((v: { slotId: number }) => v.slotId)).toEqual([1, 2]);
    for (const v of slots) {
      expect(v.centered).toBe(false);
      expect(v.vpd).toBeNull();
      expect(v.pan).toBeNull();
      expect(v.roi).toHaveLength(4);
    }
  });

  it('409: 로딩 실패(파일 없음) → error 포함 + 기존 slot_setup 무손실', async () => {
    const dir = newTmp();
    const s = makeServer({ placeRoiFile: join(dir, 'missing.json') });
    app = s.app; store = s.store;
    seed(s.store, 3);

    const r = await app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.slots).toBe(0);
    expect(Array.isArray(body.skipped)).toBe(true);
    expect(Array.isArray(body.issues)).toBe(true);

    const slots = JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body);
    expect(slots).toHaveLength(3); // ★ 파괴 없음
    expect(slots[0].centered).toBe(true);
  });

  it('409: 빈 cameras / 파싱 실패도 동일하게 무손실', async () => {
    const dir = newTmp();
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ cameras: [] }));
    const s = makeServer({ placeRoiFile: empty });
    app = s.app; store = s.store;
    seed(s.store, 2);

    const r1 = await app.inject({ method: 'POST', url: '/capture/slots/load-roi' });
    expect(r1.statusCode).toBe(409);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body)).toHaveLength(2);
  });

  // 프리셋 라이브 선갱신: camerapos.json 이 옛 프리셋(cam1)만 담고 있어도, 공급자가 알려준 신규
  // 카메라(cam2) 프리셋이 preset_pos 로 upsert 되어 cam2 주차면이 skipped 되지 않아야 한다.
  it('presetProvider 있으면 프리셋 선갱신 → 신규 카메라 주차면이 skipped 되지 않음', async () => {
    const dir = newTmp();
    const camerapos = join(dir, 'camerapos.json');
    // 옛 정본: cam1 만 존재(= cam2 주차면은 FK 부모 없음).
    writeFileSync(camerapos, JSON.stringify({ datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: 'P1', pan: 1, tilt: 2, zoom: 3 }] }] }));
    // ROI 파일: cam1 2면 + cam2 1면.
    const poly = (o: number): number[][] => [[100 + o, 100], [300 + o, 100], [300 + o, 300], [100 + o, 300]];
    const roi = join(dir, 'PtzCamRoi.json');
    writeFileSync(roi, JSON.stringify({
      cameras: [
        { camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: poly(0) }, { idx: 2, points: poly(400) }] }] },
        { camera: { cam_id: 2, imageWidth: 1000, imageHeight: 1000 }, presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: poly(0) }] }] },
      ],
    }));
    const presetProvider = {
      name: 'fake',
      listViews: async () => [
        { camIdx: 1, presetIdx: 1, label: 'P1', pan: 1, tilt: 2, zoom: 3 },
        { camIdx: 2, presetIdx: 1, label: 'P1', pan: 4, tilt: 5, zoom: 6 },
      ],
    };
    const s = makeServer({ placeRoiFile: roi, cameraposFile: camerapos, presetProvider });
    app = s.app; store = s.store;

    const body = JSON.parse((await app.inject({ method: 'POST', url: '/capture/slots/load-roi' })).body);
    expect(body.ok).toBe(true);
    expect(body.skipped).toHaveLength(0); // ★ cam2 가 FK 로 탈락하지 않음
    expect(body.slots).toBe(3);
    expect(body.presets).toBe(2);

    const slots = JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body);
    expect(slots.map((v: { camId: number }) => v.camId)).toEqual([1, 1, 2]);
  });

  it('presetProvider 실패는 강등 — 기존 camerapos.json 으로 계속 진행(issues 기록)', async () => {
    const dir = newTmp();
    const camerapos = join(dir, 'camerapos.json');
    writeFileSync(camerapos, JSON.stringify({ datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: 'P1', pan: 1, tilt: 2, zoom: 3 }] }] }));
    const presetProvider = { name: 'fake', listViews: async () => { throw new Error('unity down'); } };
    const s = makeServer({ placeRoiFile: writeRoi(dir), cameraposFile: camerapos, presetProvider });
    app = s.app; store = s.store;

    const body = JSON.parse((await app.inject({ method: 'POST', url: '/capture/slots/load-roi' })).body);
    expect(body.ok).toBe(true);
    expect(body.slots).toBe(2);
    expect(body.issues.some((i: string) => i.includes('프리셋 라이브 갱신 실패'))).toBe(true);
  });

  // "ROI 로딩 → 시작" 이 같은 정본을 쓰도록: ROI 파일이 프리셋 PTZ 를 담고 있으면
  // /capture/start 의 순회 대상도 camerapos.json 이 아니라 ROI 파일에서 나온다.
  it('ROI 파일에 프리셋 PTZ 가 있으면 /capture/start 대상이 ROI 에서 나온다(camerapos 불요)', async () => {
    const dir = newTmp();
    const poly: number[][] = [[100, 100], [300, 100], [300, 300], [100, 300]];
    const roi = join(dir, 'PtzCamRoi.json');
    writeFileSync(roi, JSON.stringify({
      cameras: [
        { camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [
          { preset_idx: 1, pan: 19.8, tilt: 8.7, zoom: 1.69, parking_spaces: [{ idx: 1, points: poly }] },
          { preset_idx: 2, pan: 41.5, tilt: 20.1, zoom: 1.58, parking_spaces: [{ idx: 2, points: poly }] },
        ] },
        { camera: { cam_id: 2, imageWidth: 1000, imageHeight: 1000 }, presets: [
          { preset_idx: 1, pan: 113.8, tilt: 10, zoom: 1.81, parking_spaces: [{ idx: 3, points: poly }] },
        ] },
      ],
    }));
    // mapFiles(=camerapos.json) 를 아예 주입하지 않는다 — 그래도 시작할 수 있어야 한다.
    const s = makeServer({ placeRoiFile: roi });
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 1 } });
    expect(r.statusCode).toBe(200); // 이전에는 'targets 미지정 + presetProvider/mapFiles 미설정' 400
    expect(JSON.parse(r.body).ok).toBe(true);
    // (대상 목록의 내용·개수는 loadSetupTargetsFromRoi 단위테스트가 고정한다 — status 는 대상 수를 노출하지 않음.)
  });

  it('PTZ 없는 구형 ROI 파일이면 기존 camerapos 폴백 유지(하위호환)', async () => {
    const dir = newTmp();
    const camerapos = join(dir, 'camerapos.json');
    writeFileSync(camerapos, JSON.stringify({ datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: 'P1', pan: 1, tilt: 2, zoom: 3 }] }] }));
    const s = makeServer({ placeRoiFile: writeRoi(dir), cameraposFile: camerapos }); // writeRoi = PTZ 미보유
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'POST', url: '/capture/start', payload: { count: 1 } });
    expect(r.statusCode).toBe(200); // camerapos 폴백으로 대상 확보(ROI 에 PTZ 없음)
  });

  // ★ 육면체 위치 어긋남 회귀 가드.
  // 뷰어 카메라·프리셋 드롭다운과 프리셋 이동 PTZ 의 정본은 camerapos.json(CameraposSource) 이다.
  // 이 파일이 뒤처지면 화면은 옛 PTZ 로 이동하고 오버레이는 새 ROI 기준이라 육면체가 어긋난다.
  // → ROI 로딩이 camerapos.json 을 ROI 정본으로 재생성해야 한다.
  it('ROI 로딩이 camerapos.json 을 ROI 정본 PTZ 로 재생성한다(드롭다운·이동 정합)', async () => {
    const dir = newTmp();
    const camerapos = join(dir, 'camerapos.json');
    // 낡은 정본: cam1 1프리셋만, PTZ 도 어긋남.
    writeFileSync(camerapos, JSON.stringify({ datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: 'old', pan: 22, tilt: 6.8, zoom: 1.69341 }] }] }));

    const poly: number[][] = [[100, 100], [300, 100], [300, 300], [100, 300]];
    const roi = join(dir, 'PtzCamRoi.json');
    writeFileSync(roi, JSON.stringify({
      cameras: [
        { camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [
          { preset_idx: 1, pan: 19.8, tilt: 8.7, zoom: 1.69341, parking_spaces: [{ idx: 1, points: poly }] },
          { preset_idx: 3, pan: 90.1, tilt: 35.8, zoom: 1, parking_spaces: [{ idx: 2, points: poly }] },
        ] },
        { camera: { cam_id: 2, imageWidth: 1000, imageHeight: 1000 }, presets: [
          { preset_idx: 1, pan: 113.8, tilt: 10, zoom: 1.80643, parking_spaces: [{ idx: 3, points: poly }] },
        ] },
      ],
    }));

    const s = makeServer({ placeRoiFile: roi, cameraposFile: camerapos });
    app = s.app; store = s.store;

    const body = JSON.parse((await app.inject({ method: 'POST', url: '/capture/slots/load-roi' })).body);
    expect(body.ok).toBe(true);
    expect(body.issues.join(' ')).toContain('camerapos.json 을 ROI 정본으로 갱신');

    // 파일이 ROI 의 5개 아닌 3개 프리셋 전부(cam2 포함)로 재생성됐는가.
    const written = parseCameraViews(JSON.parse(readFileSync(camerapos, 'utf8')));
    expect(written.map((v) => `${v.camIdx}:${v.presetIdx}`)).toEqual(['1:1', '1:3', '2:1']);
    expect(written.find((v) => v.camIdx === 1 && v.presetIdx === 1)).toMatchObject({ pan: 19.8, tilt: 8.7 });
    expect(written.find((v) => v.camIdx === 1 && v.presetIdx === 3)).toMatchObject({ pan: 90.1, tilt: 35.8, zoom: 1 });
    expect(written.find((v) => v.camIdx === 2 && v.presetIdx === 1)).toMatchObject({ pan: 113.8, tilt: 10 });

    // 뷰어 드롭다운이 보게 될 목록에 cam2 가 실제로 들어온다.
    const list = buildCameraList(written, [{ camId: 1, name: 'Camera-0' }, { camId: 2, name: 'Camera-1' }]);
    expect(list.cameras.map((c) => c.camIdx)).toEqual([1, 2]);
    expect(list.cameras[1].presets).toHaveLength(1);
  });

  it('PTZ 없는 구형 ROI 파일이면 camerapos.json 을 덮어쓰지 않는다(하위호환)', async () => {
    const dir = newTmp();
    const camerapos = join(dir, 'camerapos.json');
    const original = JSON.stringify({ datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: 'keep', pan: 22, tilt: 6.8, zoom: 1.69341 }] }] });
    writeFileSync(camerapos, original);
    const s = makeServer({ placeRoiFile: writeRoi(dir), cameraposFile: camerapos }); // writeRoi = PTZ 미보유
    app = s.app; store = s.store;

    const body = JSON.parse((await app.inject({ method: 'POST', url: '/capture/slots/load-roi' })).body);
    expect(body.ok).toBe(true);
    expect(readFileSync(camerapos, 'utf8')).toBe(original); // ★ 무변경
  });

  it('POST /capture/slots/reset 은 영향 없음(별개 버튼) — 회귀', async () => {
    const dir = newTmp();
    const s = makeServer({ placeRoiFile: writeRoi(dir) });
    app = s.app; store = s.store;
    seed(s.store, 2);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/reset' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, cleared: 2 });
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/capture/slots' })).body)).toHaveLength(2);
  });
});
