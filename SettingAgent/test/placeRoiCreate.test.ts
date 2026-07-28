import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * Stage 1 — PUT /capture/place-roi 의 `create`(빈 상태 골격 생성) + `applied`(조용한 거짓 성공 제거).
 * 기존 계약(파일 부재 + create 없음 = 404)은 그대로 유지되어야 한다.
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

function makeServer(placeRoiFile?: string) {
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
    captureJob: job, finalizer, sqlite: store, capture: captureCfg, placeRoiFile,
  });
  return { app, store };
}

/** 정규화 좌표(0..1) 4점 — 저장 시 imageWidth/Height 로 픽셀 역변환된다. */
const SPACES = [
  { idx: 1, points: [{ x: 0.1, y: 0.8 }, { x: 0.12, y: 0.6 }, { x: 0.3, y: 0.62 }, { x: 0.28, y: 0.82 }] },
];
const CREATE = { imageWidth: 1280, imageHeight: 720, pan: 12.5, tilt: -30.25, zoom: 3.5 };

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe('PUT /capture/place-roi — create(빈 상태 첫 주차면)', () => {
  it('T1 파일 부재 + create → 200, 파일이 생성되고 GET 이 그 JSON 을 돌려준다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'sub', 'PtzCamRoi.json'); // 상위 디렉터리도 없다(mkdir 필요).
    const s = makeServer(file); app = s.app; store = s.store;

    const r = await app.inject({
      method: 'PUT', url: '/capture/place-roi',
      payload: { camId: 1, presetIdx: 1, spaces: SPACES, create: CREATE },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.spaceCount).toBe(1);
    expect(existsSync(file)).toBe(true);

    const g = await app.inject({ method: 'GET', url: '/capture/place-roi' });
    expect(g.statusCode).toBe(200);
    expect(JSON.parse(g.body)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  it('T2 생성된 JSON 에 cam_id/imageWidth/imageHeight 및 preset_idx/pan/tilt/zoom 이 있다(L3 부트스트랩 전제)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    const s = makeServer(file); app = s.app; store = s.store;
    await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 2, presetIdx: 3, spaces: SPACES, create: CREATE } });

    const json = JSON.parse(readFileSync(file, 'utf8'));
    const cam = json.cameras[0];
    expect(cam.camera).toEqual({ cam_id: 2, imageWidth: 1280, imageHeight: 720 });
    const preset = cam.presets[0];
    expect(preset.preset_idx).toBe(3);
    expect(preset.pan).toBe(12.5);
    expect(preset.tilt).toBe(-30.25);
    expect(preset.zoom).toBe(3.5);
    expect(preset.parking_spaces).toHaveLength(1);
    expect(preset.parking_spaces[0].idx).toBe(1);
  });

  it('T3 파일 부재 + create 없음 → 여전히 404(기존 계약 불변)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const s = makeServer(join(dir, 'nope', 'PtzCamRoi.json')); app = s.app; store = s.store;
    const r = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 1, spaces: SPACES } });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toHaveProperty('error');
  });

  it('T4 cam 불일치 + create 없음 → applied === false(조용한 거짓 성공 제거)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 }, presets: [{ preset_idx: 1, parking_spaces: [] }] }] }), 'utf8');
    const s = makeServer(file); app = s.app; store = s.store;

    const r = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 9, presetIdx: 1, spaces: SPACES } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false); // ← 이전에는 ok:true 만 보고 저장됐다고 믿을 수 있었다.
    expect((body.issues ?? []).join(' ')).toContain('대상 없음');
    // 프리셋이 없는 경우도 동일.
    const r2 = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 7, spaces: SPACES } });
    expect(JSON.parse(r2.body).applied).toBe(false);
  });

  it('T5 기존 카메라에 create 를 보내도 imageWidth 가 덮이지 않는다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 }, presets: [{ preset_idx: 1, pan: 1, tilt: 2, zoom: 3, parking_spaces: [] }] }] }), 'utf8');
    const s = makeServer(file); app = s.app; store = s.store;

    const r = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 1, spaces: SPACES, create: CREATE } });
    expect(JSON.parse(r.body).applied).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.cameras[0].camera.imageWidth).toBe(1920); // create.imageWidth(1280) 로 덮이지 않는다.
    expect(json.cameras[0].camera.imageHeight).toBe(1080);
    expect(json.cameras[0].presets[0].pan).toBe(1); // 기존 PTZ 도 보존.
    // 픽셀 역변환은 기존 카메라 크기 기준.
    expect(json.cameras[0].presets[0].parking_spaces[0].points[0]).toEqual([0.1 * 1920, 0.8 * 1080]);
  });

  it('T5-b 기존 카메라 + 신규 프리셋 → 프리셋만 추가되고 PTZ 가 기록된다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 }, presets: [{ preset_idx: 1, parking_spaces: [] }] }] }), 'utf8');
    const s = makeServer(file); app = s.app; store = s.store;

    const r = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 2, spaces: SPACES, create: CREATE } });
    expect(JSON.parse(r.body).applied).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.cameras).toHaveLength(1);
    expect(json.cameras[0].presets.map((p: { preset_idx: number }) => p.preset_idx)).toEqual([1, 2]);
    expect(json.cameras[0].presets[1].zoom).toBe(3.5);
  });

  it('QA D-1 파일 존재 + 대상 cam/preset 부재: create 없으면 applied:false, create 붙이면 applied:true + 파일 반영', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({ cameras: [] }), 'utf8'); // 파일은 있고 주차면 0개(빈 상태 2종 중 ②).
    const s = makeServer(file); app = s.app; store = s.store;

    const before = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 1, spaces: SPACES } });
    expect(JSON.parse(before.body).applied).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).cameras).toEqual([]); // 아무것도 안 들어갔다.

    const after = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 1, spaces: SPACES, create: CREATE } });
    const body = JSON.parse(after.body);
    expect(body.applied).toBe(true);
    expect(body.appliedCount).toBe(1);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.cameras[0].camera.cam_id).toBe(1);
    expect(json.cameras[0].presets[0].parking_spaces[0].idx).toBe(1);

    // 기존 카메라 + 파일에 없는 프리셋(cam2:p3 류)도 같은 경로로 해소된다.
    const p3 = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 3, spaces: SPACES, create: CREATE } });
    expect(JSON.parse(p3.body).applied).toBe(true);
    const json2 = JSON.parse(readFileSync(file, 'utf8'));
    expect(json2.cameras[0].presets.map((p: { preset_idx: number }) => p.preset_idx)).toEqual([1, 3]);
  });

  it('QA D-4 appliedCount 는 실제 반영 수다(spaceCount 는 요청 수 그대로 유지)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({ cameras: [] }), 'utf8');
    const s = makeServer(file); app = s.app; store = s.store;
    const r = await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 1, spaces: SPACES } });
    const body = JSON.parse(r.body);
    expect(body.spaceCount).toBe(1); // 요청 개수(하위호환).
    expect(body.appliedCount).toBe(0); // 실제 반영 0.
    expect(body.applied).toBe(false);
  });

  it('T6 왕복: PUT 한 정규화 좌표 → GET → normalizePtzCamRoi 오차 ≤ 1e-5', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placecreate-'));
    const file = join(dir, 'PtzCamRoi.json');
    const s = makeServer(file); app = s.app; store = s.store;
    await app.inject({ method: 'PUT', url: '/capture/place-roi', payload: { camId: 1, presetIdx: 1, spaces: SPACES, create: CREATE } });

    const g = await app.inject({ method: 'GET', url: '/capture/place-roi' });
    const { byPreset } = normalizePtzCamRoi(JSON.parse(g.body));
    const back = byPreset.get('1:1');
    expect(back).toHaveLength(1);
    expect(back![0].idx).toBe(1);
    back![0].points.forEach((p, i) => {
      expect(Math.abs(p.x - SPACES[0].points[i].x)).toBeLessThanOrEqual(1e-5);
      expect(Math.abs(p.y - SPACES[0].points[i].y)).toBeLessThanOrEqual(1e-5);
    });
  });
});
