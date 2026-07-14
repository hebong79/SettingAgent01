// GET /capture/job-cuboids — 잡 메모리 읽기 라우트(설계 §3-1).
//
// ★ 이 라우트의 **존재 이유**가 곧 성공 기준이다: 잡이 백그라운드로 PTZ 를 돌리는 중에 뷰어가
//   라이브 촬영 라우트(/capture/vehicle-cuboids)를 부르면 (a) 화면에 뜬 프레임과 **다른 프레임**의 육면체를
//   그리게 되고 (b) 잡에게서 **카메라를 뺏는다**. → 이 라우트는 **카메라를 절대 부르지 않는다**(단언으로 봉인).

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { polygonCentroid, convexHull } from '../src/domain/polygon.js';
import { projectToPixel } from '../src/ground/project.js';
import type { CuboidContext } from '../src/ground/frameCuboids.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient, VpdSegResult } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, NormalizedPoint, SetupArtifact, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

const FIXTURE = 'test/fixtures/PtzCamRoi.unity.json';
const CAM = 1;
const PRESET = 1;

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 0, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: false,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

const POLYS: NormalizedPoint[][] = (() => {
  const place = normalizePtzCamRoi(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  return place.byPreset.get(`${CAM}:${PRESET}`)!.map((s) => s.points);
})();
const parked = ((): VehicleBox => {
  const c = polygonCentroid(POLYS[0]);
  return { rect: { x: c.x - 0.03, y: c.y - 0.21, w: 0.06, h: 0.24 }, confidence: 0.9, cls: 'car' };
})();

const DEG = Math.PI / 180;
const TILT = 14;
const g: GroundModel = {
  camIdx: CAM, presetIdx: PRESET, imgW: 1920, imgH: 1080, zoom: 1, f: 1500,
  n: [0, Math.cos(TILT * DEG), Math.sin(TILT * DEG)], d: 5.0, tiltDeg: TILT,
  ptzTiltDeg: null, tiltErrDeg: null, slotBearingDeg: null, bearingDevDeg: null, dDevRel: null,
  depthEdgePx: 400, metricErr: 0, conf: 1, source: 'file', issues: [],
};
const O: Vec3 = [0, g.d * g.n[1], g.d * g.n[2]];
const W: Vec3 = [0, -Math.sin(TILT * DEG), Math.cos(TILT * DEG)];
const X = (a: number, b: number): Vec3 => [O[0] + a, O[1] + b * W[1], O[2] + b * W[2]];
const P = (v: Vec3): Px => projectToPixel(v, g)!;
const up = (p: Vec3, h: number): Vec3 => [p[0] - h * g.n[0], p[1] - h * g.n[1], p[2] - h * g.n[2]];
const slotPolysPx: Px[][] = [-1, 0, 1].map((k) => {
  const a0 = k * 2.5 - 1.25;
  return [P(X(a0, 8)), P(X(a0, 13)), P(X(a0 + 2.5, 13)), P(X(a0 + 2.5, 8))];
});
const CTX: CuboidContext = { model: g, slotPolysPx, slotWidthM: 2.5, slotDepthM: 5.0 };

const maskNorm = ((): Array<{ x: number; y: number }> => {
  const pts: Vec3[] = [];
  for (const [a, b] of [[-0.93, 8.5], [0.93, 8.5], [0.93, 13.2], [-0.93, 13.2]] as const) pts.push(X(a, b));
  for (const [a, b] of [[-0.72, 10.4], [0.72, 10.4], [0.72, 12.5], [-0.72, 12.5]] as const) pts.push(up(X(a, b), 1.45));
  return (convexHull(pts.map(P)) as Px[]).map((p) => ({ x: p.x / g.imgW, y: p.y / g.imgH }));
})();

const SEG: VpdSegResult = {
  boxes: [{ vpdIdx: 0, rect: parked.rect, confidence: 0.88, cls: 'car', mask: maskNorm }],
  segDegraded: false,
  maskMismatch: 0,
};

/** ★ 카메라 호출 **횟수를 센다** — job-cuboids 가 촬영하지 않는다는 것을 봉인하기 위해. */
function countingCamera() {
  const state = { calls: 0 };
  const camera = {
    health: async () => true,
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
      state.calls += 1;
      return { camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img') };
    },
  } as unknown as CameraClient;
  return { camera, state };
}

const fakeVpd = (): VpdClient =>
  ({
    health: async () => true,
    detect: async () => [parked],
    canSegment: () => true,
    segment: async () => SEG,
  }) as unknown as VpdClient;

const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  return {
    setTimer: (fn: () => void, ms: number): NodeJS.Timeout => {
      const h = { fn, ms };
      queue.push(h);
      return h as unknown as NodeJS.Timeout;
    },
    clearTimer: (h: NodeJS.Timeout): void => {
      const i = queue.indexOf(h as unknown as { fn: () => void; ms: number });
      if (i >= 0) queue.splice(i, 1);
    },
    fireNext: (): boolean => {
      const h = queue.shift();
      if (!h) return false;
      h.fn();
      return true;
    },
  };
}

async function waitDone(job: CaptureJob, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = job.getStatus().state;
    if (s === 'done' || s === 'stopped' || s === 'error') return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`라운드 미종료(state=${job.getStatus().state})`);
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

function makeServer(withCuboid: boolean) {
  const s = new SqliteStore(':memory:');
  const { camera, state } = countingCamera();
  const vpd = fakeVpd();
  const timers = makeManualTimers();
  const job = new CaptureJob({
    camera, vpd, store: s, cfg: captureCfg, lpdEnabled: false,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, sleep: async () => {}, now: () => 'T',
    placeRoiFile: FIXTURE,
    ...(withCuboid ? { cuboidCtx: async () => CTX } : {}),
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store: s, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera, vpd, repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const a = buildServer({
    orchestrator, repo, camera, vpd, captureJob: job, finalizer, sqlite: s, capture: captureCfg,
  });
  return { app: a, store: s, job, timers, camState: state };
}

const targets: SetupTarget[] = [{ camIdx: CAM, presetIdx: PRESET }];

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /capture/job-cuboids', () => {
  it('잡 미실행 → 404(사유 포함). 조용한 빈 배열이 아니다', async () => {
    const s = makeServer(true);
    app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: `/capture/job-cuboids?cam=${CAM}&preset=${PRESET}` });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toContain('육면체 없음');
  });

  it('cam/preset 은 **1-based 양의 정수** — 0·음수·비정수·누락 → 400', async () => {
    const s = makeServer(true);
    app = s.app; store = s.store;
    for (const q of ['cam=0&preset=1', 'cam=1&preset=0', 'cam=-1&preset=1', 'cam=x&preset=1', 'cam=1.5&preset=1', '']) {
      expect((await app.inject({ method: 'GET', url: `/capture/job-cuboids?${q}` })).statusCode, `q=${q}`).toBe(400);
    }
  });

  it('★ 잡 1라운드 후 → 200 + 전문. 그리고 **카메라를 한 번도 더 부르지 않는다**(잡에게서 카메라를 뺏지 않는다)', async () => {
    const s = makeServer(true);
    app = s.app; store = s.store;
    s.job.start({
      count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
      checkpointIntervalMs: 60000, targets,
    });
    s.timers.fireNext();
    await waitDone(s.job);

    const afterJob = s.camState.calls; // 잡이 찍은 횟수(라운드 1 → 1회).
    expect(afterJob).toBe(1);

    const r = await app.inject({ method: 'GET', url: `/capture/job-cuboids?cam=${CAM}&preset=${PRESET}` });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);

    // ★ **카메라 호출 0** — 라우트는 잡 메모리를 읽기만 한다.
    expect(s.camState.calls).toBe(afterJob);

    expect(b.camIdx).toBe(CAM);
    expect(b.presetIdx).toBe(PRESET);
    expect(b.roundIdx).toBe(1);
    expect(b.summary.detCount).toBe(1);
    expect(b.summary.matched).toBe(1);
    expect(b.cuboids).toHaveLength(1);
    expect(b.cuboids[0].vpdIdx).toBe(0); // det 권위 인덱스.
    expect(b.assoc).toEqual([{ detIdx: 0, segIdx: 0, iou: b.assoc[0].iou }]);
    expect(b.estimateUnverified).toBe(true); // ⚠️ 화면이 "미검증 추정"을 말할 근거.
  });

  it('육면체 기능 off(cuboidCtx 미주입) → 라운드를 돌아도 404(기능이 꺼졌다는 사실이 드러난다)', async () => {
    const s = makeServer(false);
    app = s.app; store = s.store;
    s.job.start({
      count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
      checkpointIntervalMs: 60000, targets,
    });
    s.timers.fireNext();
    await waitDone(s.job);
    expect((await app.inject({ method: 'GET', url: `/capture/job-cuboids?cam=${CAM}&preset=${PRESET}` })).statusCode).toBe(404);
  });
});
