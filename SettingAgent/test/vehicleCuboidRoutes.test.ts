// GET /capture/vehicle-cuboids 라우트 계약(fastify.inject). groundModelRoutes.test.ts 하네스 복제.
//
// ★ 이 파일이 검증하는 것은 **경계면**이다 — 순수 기하는 cuboidBoundary/cuboidBoxPremise 가 본다.
//   1) VpdClient(정규화 0..1) → 라우트(× imgW/imgH → 원본 픽셀) → 지면모델. **정규화가 새면 조용히 틀린다.**
//   2) 강등이 전부 **200 + summary/issues** 로 드러나는가(throw·조용한 빈 배열 금지).
//   3) 1-based(cam/preset) 와 0-based(boxIdx) 가 섞이지 않는가.
//   4) 가림 배제가 **주차면 필터 前 전량**을 쓰는가(필터로 뺀 차도 가리기는 한다 — 설계 §D ⚠️).

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
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { slotAxes, toAxisCoords, fromAxisCoords } from '../src/ground/contact.js';
import { projectToPixel, backprojectToGround } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import { DEFAULT_CONTACT_OPTIONS, type Px, type Vec3 } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient, VpdSegResult } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const groundCfg: ToolsConfig['ground'] = { enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const REAL_PLACE_ROI = readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8');
const REAL_CAMERAPOS = readFileSync('test/fixtures/camerapos.sample.json', 'utf8');

// ─── 실 픽스처의 지면모델·슬롯을 **라우트와 같은 경로**로 재현한다(이중구현 금지) ────────────
function realModelAndSlots(): { model: GroundModel; slotPolysPx: Px[][]; cam: number; preset: number } {
  const raw = JSON.parse(REAL_PLACE_ROI);
  const views = parseCameraViews(JSON.parse(REAL_CAMERAPOS));
  const models: GroundModel[] = [];
  for (const camInput of buildGroundInputs(raw, views)) models.push(...estimateGroundModels(camInput, groundCfg).models);
  const model = models[0];
  const place = normalizePtzCamRoi(raw);
  const polysNorm = place.byPreset.get(`${model.camIdx}:${model.presetIdx}`)!.map((s) => s.points);
  const slotPolysPx = polysNorm.map((pts) => pts.map((p) => ({ x: p.x * model.imgW, y: p.y * model.imgH })));
  return { model, slotPolysPx, cam: model.camIdx, preset: model.presetIdx };
}

const CAR = { W: 1.85, L: 4.7, H: 1.445 };
const ROOF = { back: 1.9, front: 4.0, halfW: 0.72 };

/**
 * 슬롯 (a,b) 좌표계에 **차다운 마스크**(바닥 4점 + 짧고 물러난 지붕 슬래브)를 세우고 **정규화 폴리곤**으로 낸다.
 * ★ 육면체-껍질 금지 규약 준수(cuboidBoxPremise.test.ts 의 교훈).
 * 반환은 VPD 가 주는 것과 **같은 형태**(정규화 0..1) — 라우트가 픽셀로 되돌리는지 보기 위해서다.
 */
function carBoxNorm(model: GroundModel, axes: ReturnType<typeof slotAxes>['axes'], aC: number, bFront: number): VehicleBox {
  const A = axes!;
  const up = (p: Vec3, h: number): Vec3 => [p[0] - h * model.n[0], p[1] - h * model.n[1], p[2] - h * model.n[2]];
  const pts3: Vec3[] = [];
  for (const [a, b] of [
    [aC - CAR.W / 2, bFront], [aC + CAR.W / 2, bFront],
    [aC + CAR.W / 2, bFront + CAR.L], [aC - CAR.W / 2, bFront + CAR.L],
  ] as const) pts3.push(fromAxisCoords(a, b, A));
  for (const [a, b] of [
    [aC - ROOF.halfW, bFront + ROOF.back], [aC + ROOF.halfW, bFront + ROOF.back],
    [aC + ROOF.halfW, bFront + ROOF.front], [aC - ROOF.halfW, bFront + ROOF.front],
  ] as const) pts3.push(up(fromAxisCoords(a, b, A), CAR.H));

  const px = convexHull(pts3.map((p) => projectToPixel(p, model)!)) as Px[];
  const mask = px.map((p) => ({ x: p.x / model.imgW, y: p.y / model.imgH })); // ★ VPD 규약: 정규화.
  const xs = mask.map((p) => p.x);
  const ys = mask.map((p) => p.y);
  return {
    rect: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
    confidence: 0.9, cls: 'car', mask,
  };
}

/** 슬롯 k 의 (a 중심, 앞선 b) — 차량을 그 슬롯 안에 정확히 세우기 위해. */
function slotAB(model: GroundModel, axes: ReturnType<typeof slotAxes>['axes'], poly: Px[]) {
  const ab = poly.map((p) => toAxisCoords(backprojectToGround(p, model)!, axes!));
  return { aC: (Math.min(...ab.map((c) => c.a)) + Math.max(...ab.map((c) => c.a))) / 2, bFront: Math.min(...ab.map((c) => c.b)) };
}

// ─── 서버 하네스 ───────────────────────────────────────────────────────────────
const fakeCamera = (opts: { throws?: boolean } = {}) => ({
  health: async () => true,
  requestImage: async (c: number, p: number): Promise<CapturedImage> => {
    if (opts.throws) throw new Error('카메라 응답 없음');
    return { camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('jpg') };
  },
} as unknown as CameraClient);

/**
 * ★ **det 스텁 가산**(리더 Q1 승인 — 라우트 내부가 `buildFrameCuboids` 로 교체됨).
 *
 * 이전 라우트는 **seg 를 권위**로 차량 목록을 만들었다(seg 검출 4대 → 육면체 4개) → `detect()` 를 아예 안 불렀다.
 * 새 라우트는 **det 가 권위**다(점유 판정이 쓰는 그 배열) → `detect()` + `segment()` **둘 다** 부르고
 * `associateDetSeg` 로 잇는다. 그래서 스텁도 det 를 줘야 한다 — **단언은 전부 유지**(계약 불변).
 *
 * det 는 seg 와 **같은 rect** 를 준다(같은 차를 두 모델이 본 것 → IoU≈1 → 정합 성공).
 * ⚠️ 실제 det/seg 는 rect 가 다르다 — 그 현실은 **녹화 픽스처 테스트**(`assocRealFrames.test.ts`)가 본다.
 *    이 파일이 보는 것은 **경계면**(정규화↔픽셀, 강등 노출, 1-based/0-based)이다.
 */
const fakeVpd = (opts: { canSeg?: boolean; seg?: VpdSegResult; segThrows?: boolean; det?: VehicleBox[] } = {}) => ({
  health: async () => true,
  detect: async (): Promise<VehicleBox[]> =>
    opts.det ?? (opts.seg?.boxes ?? []).map((b) => ({ rect: b.rect, confidence: b.confidence, cls: b.cls })),
  canSegment: () => opts.canSeg !== false,
  segment: async (): Promise<VpdSegResult> => {
    if (opts.segThrows) throw new Error('VPD 연결 실패');
    return opts.seg ?? { boxes: [], segDegraded: false, maskMismatch: 0 };
  },
} as unknown as VpdClient);

const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeServer(o: {
  placeRoiFile?: string; cameraposFile?: string; ground?: ToolsConfig['ground'];
  camera?: CameraClient; vpd?: VpdClient;
}) {
  const store = new SqliteStore(':memory:');
  const cam = o.camera ?? fakeCamera();
  const vpd = o.vpd ?? fakeVpd();
  const job = new CaptureJob({
    camera: cam, vpd, store, cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { void fn; return [] as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: cam, vpd, repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: cam, vpd, captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    placeRoiFile: o.placeRoiFile,
    mapFiles: o.cameraposFile ? { cameraposFile: o.cameraposFile } : undefined,
    ground: o.ground,
  });
  return { app, store };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'vcub-'));
  const placeRoiFile = join(dir, 'PtzCamRoi.json');
  const cameraposFile = join(dir, 'camerapos.json');
  writeFileSync(placeRoiFile, REAL_PLACE_ROI, 'utf8');
  writeFileSync(cameraposFile, REAL_CAMERAPOS, 'utf8');
  return { placeRoiFile, cameraposFile };
}

/** 실 픽스처 슬롯 3칸에 차량 3대를 세운 seg 결과(정규화) — VPD 실응답과 같은 shape. */
function threeCarsInSlots(): { seg: VpdSegResult; model: GroundModel; cam: number; preset: number } {
  const { model, slotPolysPx, cam, preset } = realModelAndSlots();
  const axes = slotAxes(slotPolysPx, model, groundCfg.slotWidthM, groundCfg.slotDepthM, 10).axes;
  const boxes = slotPolysPx.slice(0, 3).map((poly, i) => {
    const { aC, bFront } = slotAB(model, axes, poly);
    // vpdIdx = 원본 VPD 검출 인덱스(여기선 drop 없음 → 배열 위치와 같다).
    return { ...carBoxNorm(model, axes, aC, bFront + 0.5), vpdIdx: i }; // 앞범퍼가 슬롯 앞선에서 0.5m 물러남(현실적).
  });
  return { seg: { boxes, segDegraded: false, maskMismatch: 0 }, model, cam, preset };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /capture/vehicle-cuboids — 배선 계약(404/400)', () => {
  it('vpd.segPath 미배선(canSegment=false) → 404', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ canSeg: false }) });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=1' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toContain('segPath');
  });

  it('ground 비활성 / placeRoiFile 미설정 → 404', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s1 = makeServer({ placeRoiFile, cameraposFile, ground: { ...groundCfg, enabled: false } });
    app = s1.app; store = s1.store;
    expect((await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=1' })).statusCode).toBe(404);
    await app.close(); store.close();

    const s2 = makeServer({ cameraposFile, ground: groundCfg });
    app = s2.app; store = s2.store;
    expect((await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=1' })).statusCode).toBe(404);
  });

  it('★ cam/preset 은 **1-based 양의 정수** — 0·음수·비정수·누락 → 400', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    for (const q of ['cam=0&preset=1', 'cam=1&preset=0', 'cam=-1&preset=1', 'cam=x&preset=1', 'cam=1.5&preset=1', 'preset=1', '']) {
      const r = await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?${q}` });
      expect(r.statusCode, `q=${q}`).toBe(400);
    }
  });

  it('카메라/VPD 호출 실패 → 502(500 이 아니다)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s1 = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, camera: fakeCamera({ throws: true }) });
    app = s1.app; store = s1.store;
    const r1 = await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=1' });
    expect(r1.statusCode).toBe(502);
    await app.close(); store.close();

    const s2 = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ segThrows: true }) });
    app = s2.app; store = s2.store;
    expect((await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=1' })).statusCode).toBe(502);
  });
});

describe('강등은 전부 200 + summary/issues 로 드러난다(조용한 실패 0)', () => {
  it('★ 지면모델 없는 프리셋 → **404 가 아니라 200 + cuboids:[] + issues**(설계 §8 #12)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=99' });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.cuboids).toEqual([]);
    expect(b.issues.some((s2: string) => s2.includes('지면모델 없음'))).toBe(true); // 조용한 빈 배열이 아니다.
    expect(b.anchor.depthDevM).toBeNull(); // 0 이 아니라 null.
  });

  it('★ VPD 500(검출 0대) → 200 + summary.segDegraded=true + 빈 육면체', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { cam, preset } = realModelAndSlots();
    const s = makeServer({
      placeRoiFile, cameraposFile, ground: groundCfg,
      vpd: fakeVpd({ seg: { boxes: [], segDegraded: true, maskMismatch: 0 } }),
    });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.summary.segDegraded).toBe(true); // ← 강등이 **응답에 드러난다**.
    expect(b.summary.detected).toBe(0);
    expect(b.cuboids).toEqual([]);
    expect(b.anchor.depthDevM).toBeNull();
  });

  it('★ masks/bboxes 짝 불일치 → summary.maskMismatch 로 drop 수가 드러난다', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { seg, cam, preset } = threeCarsInSlots();
    const s = makeServer({
      placeRoiFile, cameraposFile, ground: groundCfg,
      vpd: fakeVpd({ seg: { ...seg, maskMismatch: 2 } }), // VpdClient 가 2대를 drop 했다.
    });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` });
    const b = JSON.parse(r.body);
    expect(b.summary.maskMismatch).toBe(2); // ← 조용히 사라지지 않는다.
    expect(b.summary.detected).toBe(3); // 마스크가 살아남은 3대.
  });
});

describe('★ 경계면: 정규화(VPD) → 원본 픽셀(지면모델) → 정규화(뷰어)', () => {
  it('정상 3대 → 육면체 3개. floorQuad=정규화 · *Ground=미터 · heightM=PRIOR_H', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { seg, cam, preset } = threeCarsInSlots();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ seg }) });
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);

    expect(b.cam).toBe(cam); // 1-based 그대로 에코.
    expect(b.preset).toBe(preset);
    expect(b.summary.cuboidCount).toBe(3);
    expect(b.summary.rejectedCount).toBe(0);
    expect(b.rejected).toEqual([]);

    for (const c of b.cuboids) {
      // 뷰어 계약: floorQuad 는 **정규화 스케일**. 라우트가 imgW 를 안 나누면 O(1000) 이 되어 깨진다.
      for (const p of c.floorQuad) {
        expect(Math.abs(p.x)).toBeLessThan(2);
        expect(Math.abs(p.y)).toBeLessThan(2);
      }
      // 지면 3D 는 **미터**(카메라좌표) — 정규화가 새어 들어오면 O(0.01) 이 된다.
      expect(Math.hypot(...(c.frontGround as number[]))).toBeGreaterThan(1);
      expect(c.heightM).toBeCloseTo(DEFAULT_CONTACT_OPTIONS.priorH, 6); // H = 항상 prior.
      expect(c.source.H).toBe('prior');
      expect(c.source.L).toBe('prior');
      expect(c.source.position).toBe('observed');
      expect(c.source.yaw).toBe('slot-prior');
    }
    // ★ boxIdx 는 **0-based**(cam/preset 의 1-based 와 섞이지 않는다).
    expect(b.cuboids.map((c: { boxIdx: number }) => c.boxIdx)).toEqual([0, 1, 2]);

    // ★ 앞선 적합 잔차(advisory) — **배치 지표가 아니다**(자기참조. §5 「G2b 의 사각」에서 봉인).
    //   여기서 재는 것은 "라우트가 마스크를 픽셀로 되돌렸는가"뿐이다 — 정규화가 샜다면 잔차가 폭발한다.
    for (const c of b.cuboids) {
      expect(c.frontFitResidPx).not.toBeNull();
      expect(c.frontFitResidPx).toBeLessThan(8); // 적합이 성립했다는 뜻일 뿐, 배치가 맞다는 뜻이 아니다.
    }

    // ★ 추적성(D-3): 원본 VPD 검출 인덱스가 응답에 실린다 — 소비자가 bbox·confidence 로 되짚을 수 있다.
    expect(b.cuboids.map((c: { vpdIdx: number }) => c.vpdIdx)).toEqual([0, 1, 2]); // 이 케이스는 drop·필터 0 → 일치.
  });

  it('★ 라우트가 마스크를 픽셀로 되돌리지 않으면(정규화 누출) 육면체가 **전멸**한다 — 회귀 감지선', async () => {
    // 라우트 버그 시뮬레이션: VPD 가 마스크를 **이미 픽셀로** 줬다고 치면(정규화 규약 위반),
    // 라우트가 다시 imgW 를 곱해 1920배 커진 좌표가 된다 → 마스크가 화면 밖 → 접지열 0/퇴화.
    const { placeRoiFile, cameraposFile } = fixture();
    const { seg, model, cam, preset } = threeCarsInSlots();
    const wrong: VpdSegResult = {
      ...seg,
      boxes: seg.boxes.map((box) => ({
        ...box,
        mask: box.mask!.map((p) => ({ x: p.x * model.imgW, y: p.y * model.imgH })), // 규약 위반(픽셀).
      })),
    };
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ seg: wrong }) });
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` });
    const b = JSON.parse(r.body);
    // 조용히 틀린 육면체가 아니라 **강등**이 나온다(사유 보존).
    expect(b.summary.cuboidCount).toBe(0);
    expect(b.summary.rejectedCount).toBeGreaterThan(0);
  });
});

describe('★ 주차면 필터[0.5] — onPlace 계약 + 가림 배제는 필터 前 전량', () => {
  it('기본 onPlace=on: 주차면 밖 차량(통행차)은 필터되고 summary.filteredOut 에 드러난다', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { seg, model, cam, preset } = threeCarsInSlots();
    const { slotPolysPx } = realModelAndSlots();
    const axes = slotAxes(slotPolysPx, model, 2.5, 5.0, 10).axes;
    // 주차면에서 **한참 앞으로 벗어난** 통행 차량(b = 슬롯앞 − 8m).
    const { aC, bFront } = slotAB(model, axes, slotPolysPx[1]);
    const passer = { ...carBoxNorm(model, axes, aC, bFront - 8), vpdIdx: seg.boxes.length };
    const withPasser: VpdSegResult = { ...seg, boxes: [...seg.boxes, passer] };

    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ seg: withPasser }) });
    app = s.app; store = s.store;

    const on = JSON.parse((await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` })).body);
    expect(on.summary.detected).toBe(4);
    expect(on.summary.onPlace).toBe(true); // 기본 on(§D).
    expect(on.summary.filteredOut).toBeGreaterThanOrEqual(1); // 통행차 제외.
    expect(on.summary.kept).toBeLessThan(4);
    expect(on.summary.onPlaceDegraded).toBe(false);

    // ?onPlace=0 → 모드 B(전량 통과).
    const off = JSON.parse((await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}&onPlace=0` })).body);
    expect(off.summary.onPlace).toBe(false);
    expect(off.summary.filteredOut).toBe(0);
    expect(off.summary.kept).toBe(4); // 전량 통과.
  });

  it('★ 필터로 제외된 차량도 **가림자로는 남는다**(설계 §D ⚠️ — 가림 조용한 누락 금지)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { seg, model, cam, preset } = threeCarsInSlots();
    const { slotPolysPx } = realModelAndSlots();
    const axes = slotAxes(slotPolysPx, model, 2.5, 5.0, 10).axes;
    // 주차면 밖(앞쪽)에서 **1번 슬롯 차량의 발 앞을 덮는** 통행 차량 → 필터는 빼지만 가림은 만든다.
    const { aC, bFront } = slotAB(model, axes, slotPolysPx[1]);
    const blocker = { ...carBoxNorm(model, axes, aC, bFront - 4.4), vpdIdx: seg.boxes.length };
    const withBlocker: VpdSegResult = { ...seg, boxes: [...seg.boxes, blocker] };

    const sA = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ seg }) });
    app = sA.app; store = sA.store;
    const clean = JSON.parse((await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` })).body);
    const cleanRatio2 = clean.cuboids.find((c: { boxIdx: number }) => c.boxIdx === 2)!.cleanRatio;
    expect(clean.summary.cuboidCount).toBe(3);
    await app.close(); store.close();

    const sB = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ seg: withBlocker }) });
    app = sB.app; store = sB.store;
    const blocked = JSON.parse((await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` })).body);

    expect(blocked.summary.filteredOut).toBeGreaterThanOrEqual(1); // 통행차는 **육면체 대상에서 제외**되고,
    expect(blocked.summary.detected).toBe(4);

    // ★ 그런데도 **가림은 반영된다** — 가림 판정을 필터 後 집합으로 하면 아래 둘 다 깨진다(가림 조용한 누락).
    //   ① 가려진 차량이 강등된다(유효 접지열 부족 → 사유 보존).
    expect(blocked.summary.cuboidCount).toBeLessThan(3);
    expect(blocked.summary.rejectedCount).toBeGreaterThanOrEqual(1);
    expect(blocked.rejected.length).toBeGreaterThanOrEqual(1);
    //   ② 살아남은 이웃 차량도 유효 접지비율이 떨어진다(실측 0.89 → 0.44).
    const ratio2 = blocked.cuboids.find((c: { boxIdx: number }) => c.boxIdx === 2)?.cleanRatio;
    expect(ratio2).toBeLessThan(cleanRatio2);
  });

  // ⚠️ **발견된 경계면 결함(경미) — boxIdx 의 기준 배열이 응답에 없다.**
  //   boxIdx 는 `buildVehicleCuboids` 입력(= **주차면 필터 通過분**) 배열의 0-based 인덱스다.
  //   VPD 검출 순서가 아니다 — (a) VpdClient 가 마스크 없는 bbox 를 drop 하고(maskMismatch),
  //   (b) 라우트가 주차면 필터로 또 거른다. **두 번 재색인된다.**
  //   → 클라이언트는 boxIdx 를 어떤 검출 목록과도 대조할 수 없다(응답에 그 배열이 없다).
  //   지금은 표시·로그 전용이라 무해하지만, **추적성이 필요해지면 원 검출 인덱스를 함께 실어야 한다.**
  it('⚠️ boxIdx 는 VPD 검출 인덱스가 **아니다** — 필터 通過분 기준으로 재색인된다(추적성 한계 봉인)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { seg, model, cam, preset } = threeCarsInSlots();
    const { slotPolysPx } = realModelAndSlots();
    const axes = slotAxes(slotPolysPx, model, 2.5, 5.0, 10).axes;
    const { aC, bFront } = slotAB(model, axes, slotPolysPx[1]);

    // 검출 순서: [슬롯차0, **통행차(필터 대상)**, 슬롯차1, 슬롯차2] — 통행차가 **가운데**에 있다.
    const passer = carBoxNorm(model, axes, aC, bFront - 12);
    // vpdIdx 는 **원본 VPD 검출 순서**를 그대로 반영한다(0..3). 주차면 필터가 가운데(1)를 빼도 이 키는 안 흔들린다.
    const reordered: VpdSegResult = {
      ...seg,
      boxes: [seg.boxes[0], passer, seg.boxes[1], seg.boxes[2]].map((b, i) => ({ ...b, vpdIdx: i })),
    };

    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, vpd: fakeVpd({ seg: reordered }) });
    app = s.app; store = s.store;
    const b = JSON.parse((await app.inject({ method: 'GET', url: `/capture/vehicle-cuboids?cam=${cam}&preset=${preset}` })).body);

    expect(b.summary.detected).toBe(4);
    expect(b.summary.filteredOut).toBe(1); // 통행차(검출 인덱스 1) 제외.
    expect(b.summary.cuboidCount).toBe(3);
    // ★ boxIdx 가 0,1,2 로 **연속**이다 — 검출 인덱스(0,2,3)가 아니다. 이것이 재색인의 증거다.
    expect(b.cuboids.map((c: { boxIdx: number }) => c.boxIdx)).toEqual([0, 1, 2]);
  });
});
