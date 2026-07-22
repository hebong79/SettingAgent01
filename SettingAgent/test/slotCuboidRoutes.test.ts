// 검증자(qa-tester): POST /capture/slots/cuboid ("3D육면체 ROI생성") 라우트 + 웹 경계면 교차 검증.
// 근거: _workspace/05_architect_plan_cuboid.md §C·§D·§검증(qa) 3·4 + 06_developer_changes_cuboid.md.
// 하네스는 groundModelRoutes.test.ts 를 복제(동결 픽스처 사용 — data/Place01 런타임 가변분 미사용).
//
// 검증 계약:
//   200: {ok,updated,skipped[],models[],issues[],heightM} / 404: ground·placeRoi 미설정 /
//   409: slot_setup 0건 / 400: heightM 0.4·3.5 / 모델 없는 프리셋 슬롯 → skipped[] + 기존 값 미파괴.
//   경계면: web/app.js buildSlotCuboids 가 소비하는 필드 ↔ 실제 응답 shape 대조 + 버튼·후처리 배선 확인.
//
// 임시 파일은 os.tmpdir() 아래에만. DB 는 전부 :memory: (실 data/setting.sqlite 미접촉).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { H_CONST } from '../src/ground/slotFrontCenter.js';
import { projectCuboid, frontFaceCenter } from '../web/core.js';
import type { ViewerGroundModel } from '../web/core.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SlotSetupRow } from '../src/capture/types.js';

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const groundCfg: ToolsConfig['ground'] = { enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const fakeCamera = () => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeServer(opts: { placeRoiFile?: string; cameraposFile?: string; ground?: ToolsConfig['ground'] }) {
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
    mapFiles: opts.cameraposFile ? { cameraposFile: opts.cameraposFile } : undefined,
    ground: opts.ground,
  });
  return { app, store };
}

const REAL_PLACE_ROI = readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8');
const REAL_CAMERAPOS = readFileSync('test/fixtures/camerapos.sample.json', 'utf8');

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

function fixture(withCamerapos = true) {
  dir = mkdtempSync(join(tmpdir(), 'cuboid-'));
  const placeRoiFile = join(dir, 'PtzCamRoi.json');
  writeFileSync(placeRoiFile, REAL_PLACE_ROI, 'utf8');
  let cameraposFile: string | undefined;
  if (withCamerapos) {
    cameraposFile = join(dir, 'camerapos.json');
    writeFileSync(cameraposFile, REAL_CAMERAPOS, 'utf8');
  }
  return { placeRoiFile, cameraposFile };
}

const PRESET_ORPHAN = 9; // ROI 파일에 없는 프리셋 → 지면모델 없음 → skipped 대상.
const ORPHAN_FRONT = JSON.stringify({ x: 0.11111, y: 0.22222 }); // 기존 값(파괴 여부 관측용).

/**
 * 동결 ROI 픽스처의 cam1 프리셋 1~3 주차면을 slot_setup 으로 시드하고,
 * 지면모델이 없는 프리셋 9 슬롯 1건을 기존 slot3d_front_center 를 가진 채로 추가한다.
 * 반환: 프리셋 9 슬롯의 slotId.
 */
function seedSlots(s: SqliteStore): { orphanSlotId: number; total: number } {
  s.upsertPlaceInfo([{ placeId: 1, placeName: 'Place01' }]);
  s.upsertCameraInfo([{
    camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
    camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
  }]);
  s.upsertPresetPos([1, 2, 3, PRESET_ORPHAN].map((presetId) => ({
    camId: 1, presetId, sname: `Preset ${presetId}`, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T',
  })));

  const { byPreset } = normalizePtzCamRoi(JSON.parse(REAL_PLACE_ROI));
  const rows: SlotSetupRow[] = [];
  let slotId = 1;
  for (const presetId of [1, 2, 3]) {
    const spaces = byPreset.get(`1:${presetId}`) ?? [];
    spaces.forEach((sp, i) => {
      rows.push({
        slotId: slotId++, camId: 1, presetId, presetSlotIdx: i + 1,
        slotRoi: JSON.stringify(sp.points),
        vpdBbox: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
        lpdObb: null, occupyRange: null,
        pan: 3.5, tilt: -2.5, zoom: 1.5, centered: 1, img1: `s${slotId}.jpg`,
        slot3dFrontCenter: null, updatedAt: 'T',
      });
    });
  }
  const orphanSlotId = slotId;
  rows.push({
    slotId: orphanSlotId, camId: 1, presetId: PRESET_ORPHAN, presetSlotIdx: 1,
    slotRoi: JSON.stringify([{ x: 0.4, y: 0.72 }, { x: 0.42, y: 0.6 }, { x: 0.58, y: 0.6 }, { x: 0.6, y: 0.72 }]),
    vpdBbox: null, lpdObb: null, occupyRange: null,
    pan: null, tilt: null, zoom: null, centered: 0, img1: null,
    slot3dFrontCenter: ORPHAN_FRONT, updatedAt: 'T',
  });
  s.replaceSlotSetup(rows);
  return { orphanSlotId, total: rows.length };
}

// ─────────────────────────────────────────────────────────────
// 200 정상 경로
// ─────────────────────────────────────────────────────────────
describe('POST /capture/slots/cuboid — 200 정상', () => {
  it('응답 shape {ok,updated,skipped,models,issues,heightM} + DB 저장 반영', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    const { total } = seedSlots(store);

    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);

    expect(b.ok).toBe(true);
    expect(typeof b.updated).toBe('number');
    expect(Array.isArray(b.skipped)).toBe(true);
    expect(Array.isArray(b.models)).toBe(true);
    expect(Array.isArray(b.issues)).toBe(true);
    expect(b.heightM).toBe(H_CONST); // 미지정 → H_CONST.
    expect(b.updated + b.skipped.length).toBe(total); // 모든 슬롯이 산출 또는 스킵 중 하나.
    expect(b.updated).toBeGreaterThan(0);
    for (const m of b.models) {
      expect(typeof m.key).toBe('string');
      expect(m.key).toMatch(/^\d+:\d+$/);
      expect(typeof m.conf).toBe('number');
      expect(Array.isArray(m.issues)).toBe(true);
    }
    for (const sk of b.skipped) {
      expect(typeof sk.slotId).toBe('number');
      expect(typeof sk.reason).toBe('string');
    }

    // DB: 산출된 슬롯은 0~1 정규화 {x,y} 로 저장(소수점 5자리 규약).
    const saved = store.getSlotSetup().filter((v) => v.presetId !== PRESET_ORPHAN && v.slot3dFrontCenter);
    expect(saved.length).toBe(b.updated);
    for (const v of saved) {
      const p = v.slot3dFrontCenter!;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(String(p.x).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
      expect(String(p.y).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
    }
  });

  it('heightM 지정 → 응답 heightM 에코 + 높이에 따라 저장값이 달라진다(표시=저장 정합)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);

    const r1 = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: 0.5 } });
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body).heightM).toBe(0.5);
    const at05 = store.getSlotSetup().find((v) => v.slot3dFrontCenter && v.presetId === 1)!.slot3dFrontCenter!;

    const r2 = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: 3.0 } });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).heightM).toBe(3.0);
    const at30 = store.getSlotSetup().find((v) => v.slot3dFrontCenter && v.presetId === 1)!.slot3dFrontCenter!;

    expect(at30.y).not.toBe(at05.y); // 높이가 앞면 중심에 실제로 반영된다.
  });

  it('다른 컬럼(vpd/lpd/occupy/pan/tilt/zoom/centered/img1/slot_roi) 무접촉 + 행 수 불변', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const before = store.getSlotSetup();

    await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    const after = store.getSlotSetup();
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      const { slot3dFrontCenter: _b, updatedAt: _bu, ...restB } = before[i];
      const { slot3dFrontCenter: _a, updatedAt: _au, ...restA } = after[i];
      expect(restA).toEqual(restB);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// skipped[] + 기존 값 미파괴
// ─────────────────────────────────────────────────────────────
describe('POST /capture/slots/cuboid — 모델 없는 프리셋 슬롯', () => {
  it('skipped[] 로 빠지고 그 슬롯의 기존 slot3d_front_center 는 파괴되지 않는다', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    const { orphanSlotId } = seedSlots(store);

    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    const b = JSON.parse(r.body);
    const sk = b.skipped.find((x: { slotId: number }) => x.slotId === orphanSlotId);
    expect(sk).toBeDefined();
    expect(sk.reason).toContain('지면모델 없음');

    const orphan = store.getSlotSetup().find((v) => v.slotId === orphanSlotId)!;
    expect(orphan.slot3dFrontCenter).toEqual(JSON.parse(ORPHAN_FRONT)); // null 로 지워지지 않음.
    expect(orphan.updatedAt).toBe('T'); // updated_at 도 무접촉.
  });
});

// ─────────────────────────────────────────────────────────────
// 400 / 404 / 409
// ─────────────────────────────────────────────────────────────
describe('POST /capture/slots/cuboid — 오류 코드', () => {
  it.each([0.4, 3.5, -1, 'abc'])('heightM=%s → 400', async (h) => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: h } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
    // 400 이면 DB 는 손대지 않는다.
    expect(store.getSlotSetup().every((v) => v.presetId === 9 || v.slot3dFrontCenter === null)).toBe(true);
  });

  it('경계값 0.5·3.0 은 허용(400 아님)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    for (const h of [0.5, 3.0]) {
      const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: h } });
      expect(r.statusCode).toBe(200);
    }
  });

  it('placeRoiFile 미설정 → 404', async () => {
    const s = makeServer({ ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it('ground.enabled=false → 404(킬스위치)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: { ...groundCfg, enabled: false } });
    app = s.app; store = s.store;
    seedSlots(store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('ROI 파일 경로가 없음(ENOENT) → 404', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cuboid-missing-'));
    const s = makeServer({ placeRoiFile: join(dir, 'nope.json'), ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toContain('PtzCamRoi.json');
  });

  it('slot_setup 0건 → 409', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain('ROI 파일 로딩');
  });

  it('camerapos 없음 → 200 강등(ROI 자체 PTZ / zoom 미상, throw 없음)', async () => {
    const { placeRoiFile } = fixture(false);
    const s = makeServer({ placeRoiFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 경계면 교차: web/app.js buildSlotCuboids ↔ 라우트 응답
// ─────────────────────────────────────────────────────────────
describe('경계면 교차 — web/app.js buildSlotCuboids ↔ POST /capture/slots/cuboid', () => {
  const appJs = readFileSync('web/app.js', 'utf8');
  const indexHtml = readFileSync('web/index.html', 'utf8');
  /** 최상위 함수 1개의 소스만 잘라낸다(줄바꿈 CRLF/LF 무관 — 다음 열0 '}' 까지). */
  function fnSource(src: string, header: string): string {
    const i = src.indexOf(header);
    expect(i).toBeGreaterThan(-1);
    const end = src.slice(i).search(/\r?\n\}\r?\n/);
    expect(end).toBeGreaterThan(-1);
    return src.slice(i, i + end);
  }
  const body = fnSource(appJs, 'async function buildSlotCuboids()');

  it('버튼 #cap-build-cuboid 가 #cap-load-roi 뒤에 존재하고 핸들러가 연결돼 있다', () => {
    const iLoad = indexHtml.indexOf('id="cap-load-roi"');
    const iBuild = indexHtml.indexOf('id="cap-build-cuboid"');
    expect(iLoad).toBeGreaterThan(-1);
    expect(iBuild).toBeGreaterThan(iLoad);
    expect(appJs).toContain(`$('cap-build-cuboid').addEventListener('click', buildSlotCuboids)`);
  });

  it('요청 URL·메서드·바디(heightM) 가 라우트 계약과 일치', () => {
    expect(body).toContain(`fetch('/capture/slots/cuboid'`);
    expect(body).toContain(`method: 'POST'`);
    expect(body).toContain('heightM: cuboidHeight()');
    expect(appJs).toMatch(/function cuboidHeight\s*\(/); // 슬라이더 높이 소스 존재.
  });

  it('소비 필드(ok/updated/skipped[slotId,reason]/models[key,conf,issues]/issues/heightM/error) 가 실제 응답에 모두 있다', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const r = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: 1.5 } });
    const b = JSON.parse(r.body);

    // app.js 가 실제로 읽는 필드 목록(소스에서 확인) ↔ 응답 키 대조.
    for (const f of ['data.ok', 'data.updated', 'data.skipped', 'data.models', 'data.issues', 'data.heightM']) {
      expect(body).toContain(f);
    }
    expect(Object.keys(b).sort()).toEqual(['heightM', 'issues', 'models', 'ok', 'skipped', 'updated']);
    expect(body).toContain('s.slotId');
    expect(body).toContain('s.reason');
    expect(body).toContain('m.key');
    expect(body).toContain('m.conf');
    expect(body).toContain('m.issues');
    if (b.skipped.length) expect(Object.keys(b.skipped[0]).sort()).toEqual(['reason', 'slotId']);
    expect(Object.keys(b.models[0]).sort()).toEqual(['conf', 'issues', 'key']);
    // 타입: conf 는 Number(m.conf).toFixed(3) 로 소비 → 수치여야 한다.
    expect(typeof b.models[0].conf).toBe('number');
    expect(typeof b.heightM).toBe('number');

    // 실패 경로에서 소비하는 data.error 는 오류 응답에 존재.
    expect(body).toContain('data.error');
    const bad = await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: 9 } });
    expect(typeof JSON.parse(bad.body).error).toBe('string');
  });

  it('성공 후 후처리 배선: groundLoaded=false → loadGroundModel() / #roi-cuboid 자동 체크 / 목록·오버레이 갱신', () => {
    const iGuard = body.indexOf('state.groundLoaded = false');
    const iLoad = body.indexOf('await loadGroundModel()');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iLoad).toBeGreaterThan(iGuard); // 가드 해제가 재로딩보다 먼저여야 실제로 재산출된다.
    expect(body).toContain(`$('roi-cuboid').checked = true`);
    expect(body).toContain('state.roiHidden = false');
    expect(body).toContain('await loadParkingSlots()');
    expect(body).toContain('drawRoiOverlay()');
    expect(body).toContain('renderSlotList()');
    // 실패 시엔 조기 return(오버레이 상태를 건드리지 않는다).
    expect(body).toMatch(/if \(!res\.ok \|\| !data\.ok\)[\s\S]*?return;/);
  });

  it('loadRoiToDb 에도 동일한 1회 가드 해제가 추가돼 있다(설계 §D 함께 고칠 것)', () => {
    const roiFn = fnSource(appJs, 'async function loadRoiToDb()');
    expect(roiFn).toContain('state.groundLoaded = false');
    expect(roiFn).toContain('loadGroundModel()');
  });

  it('표시==저장 종단 파리티 — 뷰어(web/core.js projectCuboid+frontFaceCenter)와 DB 저장값 일치(1e-5)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    seedSlots(store);
    const H = 1.5;
    expect((await app.inject({ method: 'POST', url: '/capture/slots/cuboid', payload: { heightM: H } })).statusCode).toBe(200);

    // 뷰어가 쓰는 것과 같은 소스: GET /capture/ground-model 의 모델 + ROI 파일 폴리곤.
    const gm = JSON.parse((await app.inject({ method: 'GET', url: '/capture/ground-model' })).body);
    const modelByKey = new Map<string, ViewerGroundModel>(
      gm.models.map((m: ViewerGroundModel & { camIdx: number; presetIdx: number }) => [`${m.camIdx}:${m.presetIdx}`, m]),
    );
    let checked = 0;
    for (const v of store.getSlotSetup()) {
      if (!v.slot3dFrontCenter) continue;
      const g = modelByKey.get(`${v.camId}:${v.presetId}`);
      if (!g) continue;
      const cub = projectCuboid(v.roi, g, H);
      const disp = frontFaceCenter(cub);
      expect(disp).not.toBeNull();
      expect(disp!.x).toBeCloseTo(v.slot3dFrontCenter.x, 5);
      expect(disp!.y).toBeCloseTo(v.slot3dFrontCenter.y, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('drawCuboidOverlay 렌더 경로는 그대로 존재(버튼은 데이터·토글만 담당)', () => {
    expect(appJs).toMatch(/function drawCuboidOverlay\s*\(/);
    expect(body).not.toContain('drawCuboidOverlay(');  // 버튼 핸들러가 렌더를 직접 호출하지 않는다.
  });
});
