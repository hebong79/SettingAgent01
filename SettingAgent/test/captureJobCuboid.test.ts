// ★★ T6 — **점유 회귀 봉인**(Goal 3). 이 파일이 이번 작업에서 가장 중요하다.
//
// 주장: "육면체는 점유 판정 경로를 한 줄도 건드리지 않는다."
//   설계는 이것을 **구조적으로** 논증했다(육면체 코드는 `insertDetections` 블록 **아래에 가산**되고 `raw`/`vehicles` 를
//   읽기만 한다). 하지만 구조 논증은 배신당할 수 있다 → **프로덕션 `CaptureJob` 을 실제로 두 번 돌려**
//   (육면체 off / on) `store.insertDetections` 에 들어간 인자가 **완전히 동일한지**(deep equal) 본다.
//
// 그리고 **잡은 절대 죽지 않는다**: seg 가 throw 해도 라운드가 완주하고 검출은 그대로 적재된다.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { aggregate } from '../src/capture/Aggregator.js';
import { polygonCentroid } from '../src/domain/polygon.js';
import { projectToPixel } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import type { CuboidContext } from '../src/ground/frameCuboids.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import type { GroundModel } from '../src/ground/types.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient, VpdSegResult } from '../src/clients/VpdClient.js';
import type { CapturedImage, NormalizedPoint, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

const FIXTURE = 'test/fixtures/PtzCamRoi.unity.json'; // ⚠️ 동결 픽스처(런타임 파일 금지 — HANDOFF §2-2).
const CAM = 1;
const PRESET = 1;

const POLYS: NormalizedPoint[][] = (() => {
  const place = normalizePtzCamRoi(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const spaces = place.byPreset.get(`${CAM}:${PRESET}`);
  if (!spaces?.length) throw new Error('픽스처에 cam1:preset1 주차면이 없다 — 테스트 전제 붕괴');
  return spaces.map((s) => s.points);
})();

function parkedOn(poly: NormalizedPoint[], w = 0.06, h = 0.24): VehicleBox {
  const c = polygonCentroid(poly);
  return { rect: { x: c.x - w / 2, y: c.y - h * 0.875, w, h }, confidence: 0.9, cls: 'car' };
}
const PARKED = parkedOn(POLYS[0]);
const PARKED2 = parkedOn(POLYS[1]);
const PASSING: VehicleBox = { rect: { x: 0.4, y: 0.8, w: 0.1, h: 0.18 }, confidence: 0.9, cls: 'car' };
const RAW = [PARKED, PASSING, PARKED2]; // 통행차가 **가운데** — 필터가 인덱스를 흔든다.

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 0, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: false,
};
const targets: SetupTarget[] = [{ camIdx: CAM, presetIdx: PRESET }];

// ── 육면체 문맥(합성 지면모델 + 슬롯) ────────────────────────────────────────
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

function carMaskNorm(aC: number, bFront: number): Array<{ x: number; y: number }> {
  const pts: Vec3[] = [];
  for (const [a, b] of [[aC - 0.93, bFront], [aC + 0.93, bFront], [aC + 0.93, bFront + 4.7], [aC - 0.93, bFront + 4.7]] as const) pts.push(X(a, b));
  for (const [a, b] of [[aC - 0.72, bFront + 1.9], [aC + 0.72, bFront + 1.9], [aC + 0.72, bFront + 4.0], [aC - 0.72, bFront + 4.0]] as const) {
    pts.push(up(X(a, b), 1.45));
  }
  return (convexHull(pts.map(P)) as Px[]).map((p) => ({ x: p.x / g.imgW, y: p.y / g.imgH }));
}

/** seg 응답: **유지된 주차차 2대**의 마스크(rect 는 det 와 같게 → IoU 1 → 정합 성공). */
const SEG: VpdSegResult = {
  boxes: [
    { vpdIdx: 0, rect: PARKED.rect, confidence: 0.88, cls: 'car', mask: carMaskNorm(-2.5, 8.5) },
    { vpdIdx: 1, rect: PARKED2.rect, confidence: 0.77, cls: 'car', mask: carMaskNorm(2.5, 8.5) },
  ],
  segDegraded: false,
  maskMismatch: 0,
};

const fakeCamera = (): CameraClient => ({
  requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
    camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img'),
  }),
} as unknown as CameraClient);

const fakeVpd = (opts: { segThrows?: boolean } = {}): VpdClient =>
  ({
    detect: async () => RAW,
    canSegment: () => true,
    segment: async (): Promise<VpdSegResult> => {
      if (opts.segThrows) throw new Error('VPD seg 폭발');
      return SEG;
    },
  }) as unknown as VpdClient;

function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const i = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (i >= 0) queue.splice(i, 1);
  };
  const fireNext = (): boolean => {
    const h = queue.shift();
    if (!h) return false;
    h.fn();
    return true;
  };
  return { setTimer, clearTimer, fireNext };
}

async function waitDone(job: CaptureJob, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = job.getStatus().state;
    if (s === 'done' || s === 'stopped' || s === 'error') return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`라운드가 ${timeoutMs}ms 내 종료되지 않음(state=${job.getStatus().state})`);
}

let openStores: SqliteStore[] = [];
afterEach(() => {
  for (const s of openStores) { try { s.close(); } catch { /* noop */ } }
  openStores = [];
});

/** 프로덕션 `CaptureJob` 1라운드 실행. `insertDetections` 의 **인자를 그대로 캡처**한다. */
async function runOneRound(over: Partial<CaptureJobDeps> = {}) {
  const store = new SqliteStore(':memory:');
  openStores.push(store);
  const calls: unknown[][] = [];
  const orig = store.insertDetections.bind(store);
  store.insertDetections = ((...args: Parameters<SqliteStore['insertDetections']>) => {
    calls.push(structuredClone(args)); // 참조가 아니라 **값**을 박제(이후 변형에 오염되지 않게).
    return orig(...args);
  }) as SqliteStore['insertDetections'];

  const timers = makeManualTimers();
  const job = new CaptureJob({
    camera: fakeCamera(),
    vpd: fakeVpd(),
    store,
    cfg: captureCfg,
    lpdEnabled: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    now: () => 'T',
    placeRoiFile: FIXTURE,
    ...over,
  });
  const { runId } = job.start({
    count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
    checkpointIntervalMs: 60000, targets,
  });
  timers.fireNext();
  await waitDone(job);
  return { job, store, runId, calls };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('★★ T6 — 육면체 on/off 가 점유 판정 경로를 바꾸지 않는다(Goal 3 · 회귀 0)', () => {
  it('`store.insertDetections` 인자가 **완전히 동일**하다(deep equal) — 육면체 off vs on', async () => {
    const off = await runOneRound(); // cuboidCtx 미주입 → 육면체 전 기능 off.
    const on = await runOneRound({ cuboidCtx: async () => CTX }); // 육면체 on(매 라운드 seg 호출).

    expect(off.calls).toHaveLength(1);
    expect(on.calls).toHaveLength(1);
    // ★ 봉인: 검출 적재 인자(obsId · cam · preset · dets 배열)가 **비트 동일**.
    expect(on.calls).toEqual(off.calls);

    // 육면체가 실제로 산출됐는지도 확인 — "아무 일도 안 해서 동일"한 게 아니다(공허한 통과 방지).
    const c = on.job.getCuboids(CAM, PRESET);
    expect(c).toBeDefined();
    expect(c!.summary.detCount).toBe(3); // det 권위 전량.
    expect(c!.summary.kept).toBe(2); // 주차면 필터 통과분.
    expect(c!.summary.matched).toBe(2);
    expect(off.job.getCuboids(CAM, PRESET)).toBeUndefined(); // off 면 아무것도 안 만든다.
  });

  it('`aggregate()` 산출(점유의 실제 소비처)도 동일하다', async () => {
    const off = await runOneRound();
    const on = await runOneRound({ cuboidCtx: async () => CTX });
    const agg = (r: Awaited<ReturnType<typeof runOneRound>>) =>
      aggregate(r.store.getDetectionsForRun(r.runId), r.store.getPresetRounds(r.runId), {
        clusterDist: captureCfg.clusterDist, clusterMinSupport: 1, minConfidence: captureCfg.minConfidence,
      });
    expect(agg(on)).toEqual(agg(off));
  });

  it('★ `keptDetIdx` 는 **참조 동일성**으로 얻는다 — 필터가 가운데 차를 빼도 det 인덱스가 안 흔들린다', async () => {
    const on = await runOneRound({ cuboidCtx: async () => CTX });
    const c = on.job.getCuboids(CAM, PRESET)!;
    // RAW = [주차차0, **통행차1**, 주차차2] → 필터는 index 1 을 뺀다.
    // 육면체의 vpdIdx 는 **원본 det 인덱스**(0, 2)여야 한다 — 재색인된 (0, 1) 이면 통행차를 가리키게 된다.
    expect(c.cuboids.map((x) => x.vpdIdx).sort()).toEqual([0, 2]);
    expect(c.summary.filteredOut).toBe(1);
  });
});

describe('★ 잡 사망 금지 — seg 가 죽어도 수집은 계속된다(마스터 §5)', () => {
  it('seg 가 throw 해도 라운드가 완주하고 **검출은 그대로 적재**된다', async () => {
    const store = new SqliteStore(':memory:');
    openStores.push(store);
    const timers = makeManualTimers();
    const job = new CaptureJob({
      camera: fakeCamera(),
      vpd: fakeVpd({ segThrows: true }), // ← seg 폭발.
      store,
      cfg: captureCfg,
      lpdEnabled: false,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      sleep: async () => {},
      now: () => 'T',
      placeRoiFile: FIXTURE,
      cuboidCtx: async () => CTX,
    });
    const { runId } = job.start({
      count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
      checkpointIntervalMs: 60000, targets,
    });
    timers.fireNext();
    await waitDone(job);

    expect(job.getStatus().state).toBe('done'); // ★ 'error' 가 아니다 — 잡은 죽지 않는다.
    const dets = store.getDetectionsForRun(runId);
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(2); // 주차차 2대 그대로 적재.
    // 육면체는 강등되지만 **사유가 남는다**(조용한 실패 금지).
    const c = job.getCuboids(CAM, PRESET);
    expect(c?.cuboids).toEqual([]);
    expect(c?.segError).toContain('VPD seg 폭발');
  });

  it('`cuboidCtx` 가 null 을 주면(지면모델 없음) 강등 — 잡은 정상 완주', async () => {
    const r = await runOneRound({ cuboidCtx: async () => null });
    expect(r.job.getStatus().state).toBe('done');
    const c = r.job.getCuboids(CAM, PRESET);
    expect(c?.cuboids).toEqual([]);
    expect(c?.issues.some((s) => s.includes('지면모델'))).toBe(true);
  });

  // ★ QA 추가 — `buildFrameCuboids` 자체는 throw 0 이 봉인돼 있지만(frameCuboids.test.ts),
  //   `updateCuboids` 는 그 앞에서 `this.deps.cuboidCtx!(...)` 도 호출한다. 프로덕션 팩토리
  //   (`makeCuboidContextResolver`)는 내부에서 전부 흡수해 절대 throw 하지 않지만, `cuboidCtx` 는
  //   **주입 가능한 일반 콜백 타입**이다 — 주입자가 다른 구현(파일 IO 예외를 안 삼키는 것 등)을 넣으면
  //   그 자체가 throw 할 수 있다. `updateCuboids` 의 try/catch 가 **seg 뿐 아니라 ctx 해결까지** 감싸는지는
  //   기존 스위트에 없었다 — "잡은 절대 죽지 않는다"가 이 기능의 최우선 불변식이므로 약한 지점을 닫는다.
  it('★ `cuboidCtx` 콜백 자체가 throw 해도(파일 IO 예외 등) 잡은 죽지 않고 검출은 그대로 적재된다', async () => {
    const r = await runOneRound({
      cuboidCtx: async () => {
        throw new Error('placeRoi 파일 파싱 폭발');
      },
    });
    expect(r.job.getStatus().state).toBe('done'); // ★ 'error' 가 아니다.
    const dets = r.store.getDetectionsForRun(r.runId);
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(2); // 점유 판정은 무영향.
    expect(r.job.getCuboids(CAM, PRESET)).toBeUndefined(); // 육면체는 강등(이번 라운드분 없음) — 조용히 죽지 않았다.
  });
});

describe('★ status 경량 인덱스 — 전문은 싣지 않는다(초당 폴링)', () => {
  it('status.cuboid 는 프리셋당 **숫자 4개**만 싣는다(floorQuad·issues 전문 없음)', async () => {
    const r = await runOneRound({ cuboidCtx: async () => CTX });
    const st = r.job.getStatus();
    expect(st.cuboid).toBeDefined();
    const entry = st.cuboid![`${CAM}:${PRESET}`];
    expect(entry).toEqual({ round: 1, cuboidCount: entry.cuboidCount, unmatched: 0, segDegraded: false });
    expect(Object.keys(entry).sort()).toEqual(['cuboidCount', 'round', 'segDegraded', 'unmatched']);
    // 전문(cuboids 배열)은 status 에 **없다** — 있으면 초당 폴링에 수십 KB 가 실린다.
    expect(JSON.stringify(st)).not.toContain('floorQuad');
  });

  it('육면체 off 면 status 에 `cuboid` 키가 아예 없다(기존 status shape 불변)', async () => {
    const r = await runOneRound();
    expect(r.job.getStatus().cuboid).toBeUndefined();
  });
});
