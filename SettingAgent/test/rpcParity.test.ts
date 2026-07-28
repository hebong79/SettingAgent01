import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { SaveStore } from '../src/store/SaveStore.js';
import { RpcCode, isRouteNotRegistered } from '../src/rpc/errors.js';
import { METHODS } from '../src/rpc/methods.js';
import { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import { PlateDiscoveryJob } from '../src/calibrate/PlateDiscoveryJob.js';
import { LensCalibrationJob } from '../src/calibrate/LensCalibrationJob.js';
import { TourJob } from '../src/capture/TourJob.js';
import { SetupPipeline } from '../src/pipeline/SetupPipeline.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CameraSource, Ptz } from '../src/viewer/CameraSource.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): **REST ↔ RPC 동등성**(설계서 §2 성공기준 2 / P1 이중구현 금지).
 *
 * ★ 이 파일이 증명하려는 것: RPC 는 자기 로직을 갖지 않는다.
 *   같은 작업을 REST 로 한 결과와 RPC 로 한 결과가 **바이트 수준으로 같아야** 브리지가 제 역할을 한 것이다.
 *   (다르다면 어딘가에 두 번째 구현이 생겼다는 뜻이다 — 이 저장소가 반복해서 겪은 실패 유형.)
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

const PLACE_FIXTURE = {
  cameras: [
    {
      camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
      presets: [
        {
          preset_idx: 1, pan: 10, tilt: -5, zoom: 2,
          parking_spaces: [{ idx: 1, points: [[100, 100], [200, 100], [200, 200], [100, 200]] }],
        },
      ],
    },
  ],
};

const fakeCamera = () => ({
  health: async () => true,
  clampZoom: (z: number) => z,
  requestImage: async (c: number, p: number): Promise<CapturedImage> =>
    ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

interface Ctx { app: FastifyInstance; store: SqliteStore; dir: string; placeFile: string }

function makeCtx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'rpcparity-'));
  const placeFile = join(dir, 'PtzCamRoi.json');
  writeFileSync(placeFile, JSON.stringify(PLACE_FIXTURE, null, 2), 'utf8');
  const store = new SqliteStore(':memory:');
  const saved: SetupArtifact[] = [];
  const repo = { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const app = buildServer({
    orchestrator: new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' }),
    repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job,
    finalizer: new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' }),
    sqlite: store, capture: captureCfg,
    saveStore: new SaveStore(join(dir, 'save'), join(dir, 'reports')),
    placeRoiFile: placeFile,
  });
  return { app, store, dir, placeFile };
}

/** listCameras/move/getPtz 까지 갖춘 카메라(완전 배선 ctx 용). */
const fullCamera = () => ({
  ...fakeCamera(),
  listCameras: async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, pan: 0, tilt: 0, zoom: 1 }] }] }),
  move: async () => true,
  getPtz: async () => ({ pan: 0, tilt: 0, zoom: 1 }),
} as unknown as CameraClient);

const fakeLpd = () => ({ detect: async () => [] } as unknown as LpdClient);

/** 뷰어 카메라 소스(가짜) — /viewer/api/* 라우트 등록 조건 충족용. */
function fakeSource(): CameraSource {
  return {
    kind: 'sim',
    listCameras: async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'P1' }] }] }),
    snapshot: async () => ({ jpeg: Buffer.from([0xff, 0xd8]), ptz: { pan: 0, tilt: 0, zoom: 1 } }),
    move: async () => true,
    getPtz: async () => ({ pan: 0, tilt: 0, zoom: 1 }),
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
  } as unknown as CameraSource;
}

/**
 * **모든 옵셔널 의존성을 주입한** 서버(T4 동적 라우트 검사 전용).
 * 여기서 미등록이 나오면 그건 진짜 미등록이다 — 의존성 미주입 때문이 아니다.
 */
function makeFullCtx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'rpcparity-full-'));
  const placeFile = join(dir, 'PtzCamRoi.json');
  writeFileSync(placeFile, JSON.stringify(PLACE_FIXTURE, null, 2), 'utf8');
  const cameraposFile = join(dir, 'camerapos.json');
  writeFileSync(cameraposFile, JSON.stringify({ views: [] }, null, 2), 'utf8');
  const dbFile = join(dir, 'setting.sqlite');
  const store = new SqliteStore(dbFile);
  const saved: SetupArtifact[] = [];
  const repo = { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
  const queue: Array<() => void> = [];
  const camera = fullCamera();
  const saveStore = new SaveStore(join(dir, 'save'), join(dir, 'reports'));
  const job = new CaptureJob({
    camera, vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const calibrateCfg: ToolsConfig['calibrate'] = {
    targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 1,
    probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
    settleMs: 0, outFile: join(dir, 'slot_ptz.json'),
  };
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const calibrator0 = new PtzCalibrator({ camera, lpd: fakeLpd(), cfg: calibrateCfg, store, saveStore });
  const discovery0 = new PlateDiscoveryJob({ camera, lpd: fakeLpd(), store, outFile: join(dir, 'plate_discovery.json'), now: () => 'T' });
  const app = buildServer({
    orchestrator: new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' }),
    repo, camera, vpd: fakeVpd(), lpd: fakeLpd(),
    captureJob: job,
    finalizer,
    sqlite: store, capture: captureCfg, saveStore,
    placeRoiFile: placeFile,
    refFrameDir: join(dir, 'refframes'),
    ground: { enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 },
    groundGridFile: join(dir, 'ground_grid.json'),
    mapFiles: { cameraposFile, presetFile: join(dir, 'preset.json') },
    calibrator: calibrator0,
    calibrate: calibrateCfg,
    plateDiscovery: discovery0,
    discoverOutFile: join(dir, 'plate_discovery.json'),
    // /capture/start-precise·/capture/pipeline 은 pipeline 주입 시에만 등록된다 — 동적 검사가 이 누락을 잡아냈다.
    pipeline: new SetupPipeline({ job, finalizer, discovery: discovery0, calibrator: calibrator0, store, sleep: async () => {}, now: () => 'T' }),
    lensCalib: new LensCalibrationJob({ sources: [], calibFile: join(dir, 'lens_calibration.json'), resultDir: dir }),
    lensCalibPaths: { calibFile: join(dir, 'lens_calibration.json'), resultDir: dir },
    // setup_result 를 두지 않는다 → POST /capture/tour/start 는 404 본문(no setup_result)으로 끝나고
    // 실제 순회를 시작하지 않는다(테스트가 카메라 잡을 띄우지 않게 한다). 라우트 등록 여부만 본다.
    tourJob: new TourJob({ camera, loadSetupResult: () => null, sleep: async () => {}, now: () => 'T' }),
    viewer: { enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' },
    sources: new Map<string, CameraSource>([['s', fakeSource()]]),
    cameraCfg: { baseUrl: 'http://localhost:13100', imageTimeoutMs: 1000, moveTimeoutMs: 1000, zoomMin: 1, zoomMax: 36 },
    dbFile,
  });
  return { app, store, dir, placeFile };
}

async function rpc(app: FastifyInstance, method: string, params?: Record<string, unknown>) {
  const r = await app.inject({
    method: 'POST', url: '/rpc',
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  });
  return r.json() as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
}

let ctx: Ctx | undefined;
afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx.store.close();
    // dbRoutes 의 read-only 연결(지연 오픈 후 캐시·close 훅 없음)이 파일 핸들을 붙들고 있으면
    // Windows 에서 EPERM 이 난다. 임시 디렉터리라 삭제 실패는 무해하므로 정리만 포기한다.
    try {
      rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      /* 임시 디렉터리 잔존 — 테스트 결과에 영향 없음 */
    }
    ctx = undefined;
  }
});

describe('읽기 메서드 — REST 응답과 RPC result 가 같다', () => {
  const cases: Array<[string, string]> = [
    ['system.health', '/health'],
    ['capture.status', '/capture/status'],
    ['slot.list', '/capture/slots'],
    ['place.get', '/capture/place-roi'],
    ['setup.saves.list', '/capture/saves'],
    ['config.get', '/settings'],
    ['capture.pipeline', '/capture/pipeline'],
  ];

  for (const [method, url] of cases) {
    it(`${method} == GET ${url}`, async () => {
      ctx = makeCtx();
      const rest = await ctx.app.inject({ method: 'GET', url });
      const viaRpc = await rpc(ctx.app, method);
      if (rest.statusCode === 404) {
        // 미등록 라우트는 RPC 에서 UNAVAILABLE 로 나타난다(같은 사실의 두 표현).
        expect(viaRpc.error?.code).toBe(RpcCode.UNAVAILABLE);
        return;
      }
      expect(rest.statusCode).toBe(200);
      expect(viaRpc.result).toEqual(rest.json());
    });
  }
});

describe('쓰기 메서드 — 같은 작업이 같은 부작용을 낸다', () => {
  it('slot.reset == POST /capture/slots/reset (응답 동일)', async () => {
    ctx = makeCtx();
    const rest = await ctx.app.inject({ method: 'POST', url: '/capture/slots/reset' });
    const viaRpc = await rpc(ctx.app, 'slot.reset', { confirm: true });
    expect(viaRpc.result).toEqual(rest.json());
  });

  it('place.save == PUT /capture/place-roi (파일 결과 동일)', async () => {
    ctx = makeCtx();
    const body = {
      camId: 1, presetIdx: 1,
      spaces: [{ idx: 1, points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.3 }, { x: 0.4, y: 0.4 }, { x: 0.3, y: 0.4 }] }],
    };
    const restRes = await ctx.app.inject({ method: 'PUT', url: '/capture/place-roi', payload: body });
    const afterRest = readFileSync(ctx.placeFile, 'utf8');

    // 같은 파일을 원상복구한 뒤 RPC 로 동일 작업.
    writeFileSync(ctx.placeFile, JSON.stringify(PLACE_FIXTURE, null, 2), 'utf8');
    const rpcRes = await rpc(ctx.app, 'place.save', body);
    const afterRpc = readFileSync(ctx.placeFile, 'utf8');

    expect(rpcRes.result).toEqual(restRes.json());
    expect(afterRpc).toBe(afterRest); // ★ 바이트 동일
  });

  it('slot.renumber == POST /mapping/renumber (검증 실패도 같은 방식으로 거부)', async () => {
    ctx = makeCtx();
    const bad = { mapping: [{ oldSlotId: 1, newSlotId: 2 }] }; // DB 가 비어 있어 검증 실패.
    const rest = await ctx.app.inject({ method: 'POST', url: '/mapping/renumber', payload: bad });
    const viaRpc = await rpc(ctx.app, 'slot.renumber', bad);
    expect(rest.statusCode).toBe(400);
    expect(viaRpc.error?.code).toBe(RpcCode.INVALID_PARAMS);
    // 라우트의 error 문자열이 RPC 메시지로 그대로 살아 있어야 진단이 갈리지 않는다.
    expect(viaRpc.error?.message).toBe((rest.json() as { error: string }).error);
  });
});

describe('오류도 같은 사실을 말한다', () => {
  it('없는 저장 이름 — REST 404 / RPC NOT_FOUND + 같은 메시지', async () => {
    ctx = makeCtx();
    const rest = await ctx.app.inject({ method: 'GET', url: '/capture/saves/nope' });
    const viaRpc = await rpc(ctx.app, 'setup.saves.load', { name: 'nope' });
    expect(rest.statusCode).toBe(404);
    expect(viaRpc.error?.code).toBe(RpcCode.NOT_FOUND);
    expect(viaRpc.error?.message).toBe((rest.json() as { error: string }).error);
  });

  it('zod 실패 — RPC data.response.detail 에 flatten 이 보존된다', async () => {
    ctx = makeCtx();
    const viaRpc = await rpc(ctx.app, 'capture.start', { count: -1 });
    expect(viaRpc.error?.code).toBe(RpcCode.INVALID_PARAMS);
    const data = viaRpc.error?.data as { response: { detail: unknown } };
    expect(data.response.detail).toBeTruthy();
  });
});

describe('브리지 계약(정적)', () => {
  it('브리지 메서드의 위임 URL 은 전부 기존 라우트 경로다(오타 방지)', () => {
    // 기존 REST 라우트 경로 집합(설계서 §1.2 인벤토리 기준). 새 경로를 만들면 이 목록에 걸린다.
    const known = new Set([
      '/health', '/settings', '/mapping', '/mapping/renumber', '/mapping/placement',
      '/capture/start', '/capture/start-precise', '/capture/stop', '/capture/finalize',
      '/capture/status', '/capture/pipeline', '/capture/slots', '/capture/slots/reset',
      '/capture/slots/load-roi', '/capture/slots/sync-roi', '/capture/slots/lpd',
      '/capture/slots/occupy', '/capture/slots/cuboid', '/capture/save', '/capture/setup-result',
      '/capture/saves', '/capture/place-roi', '/capture/place-roi/validate', '/capture/ground-model',
      '/capture/ground-grid', '/capture/ground-grid/bootstrap', '/capture/ground-grid/apply',
      '/capture/refframe', '/capture/autocorrect', '/capture/detect',
      // 순회(투어링) 서버 승격 — 웹에서 옮겨온 신규 라우트(§2). 아래 동적 교차검사가 실제 등록까지 확인한다.
      '/capture/tour/start', '/capture/tour/stop', '/capture/tour/status',
      '/calibrate/ptz', '/calibrate/point', '/calibrate/status', '/calibrate/result',
      '/calibrate/lens/start', '/calibrate/lens/stop', '/calibrate/lens/status',
      '/calibrate/lens/result', '/calibrate/lens/apply',
      '/discover/ptz', '/discover/status', '/discover/result',
      '/db/tables', '/db/table', '/viewer/api/cameras', '/viewer/api/ptz', '/viewer/api/move',
      '/viewer/api/health', '/viewer/api/camerapos',
    ]);
    const dummy = {
      cam: 1, preset: 1, camId: 1, presetIdx: 1, name: 'x', source: 's', imageWidth: 1, imageHeight: 1,
      confirm: true,
    };
    for (const m of METHODS) {
      if (!m.http) continue;
      const url = m.http(dummy).url.split('?')[0];
      // `/db/table/:name`·`/capture/saves/:name` 은 경로 파라미터가 붙는다 → 접두어로 판정.
      const hit = [...known].some((k) => url === k || url.startsWith(`${k}/`));
      expect(`${m.name} → ${url}: ${hit}`).toBe(`${m.name} → ${url}: true`);
    }
  });

  /**
   * ★ 위 정적 목록보다 **강한** 보증(설계 §5.2 T4). 목록은 "오타가 아니다"까지만 말한다 —
   *   "그 경로가 실제로 등록됐다"는 말하지 못한다(목록에 넣어두고 registerXRoutes 를 빠뜨리면 통과한다).
   *   그래서 **의존성을 전부 주입한 실제 buildServer 인스턴스**에 모든 위임 URL 을 두드려
   *   Fastify 기본 404(`Route ... not found`)가 **아님**을 단정한다. 본문 404·400·409 는 통과 —
   *   여기서 보려는 것은 "라우트가 거기 있는가"이지 "지금 값이 있는가"가 아니다.
   */
  it('★ 모든 http 위임 URL 이 완전 배선 서버에 실제로 등록돼 있다(동적 교차검사)', async () => {
    ctx = makeFullCtx();
    const dummy = {
      cam: 1, preset: 1, camId: 1, presetIdx: 1, name: 'x', source: 's', imageWidth: 1, imageHeight: 1,
      confirm: true,
    };
    const missing: string[] = [];
    for (const m of METHODS) {
      if (!m.http) continue;
      const mapping = m.http(dummy);
      const res = await ctx.app.inject({
        method: mapping.method,
        url: mapping.url,
        ...(mapping.payload !== undefined ? { payload: mapping.payload as object } : {}),
      });
      if (res.statusCode !== 404) continue;
      let body: unknown = null;
      try {
        body = JSON.parse(res.payload);
      } catch {
        body = null;
      }
      if (isRouteNotRegistered(body)) missing.push(`${m.name} → ${mapping.method} ${mapping.url}`);
    }
    expect(missing).toEqual([]);
  });
});
