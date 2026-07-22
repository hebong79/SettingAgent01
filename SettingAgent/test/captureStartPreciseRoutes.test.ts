import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCaptureRoutes } from '../src/api/captureRoutes.js';
import { SetupPipeline, type SetupPipelineDeps } from '../src/pipeline/SetupPipeline.js';
import type { CaptureJob, CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { Finalizer } from '../src/capture/Finalizer.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CalibrateStatus } from '../src/calibrate/types.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): POST /capture/start-precise (W2) — 설계서 §11.1 U7·U8.
 *
 * 라우트는 얇은 진입점이어야 한다: 대기·단계전이·가드는 SetupPipeline 소유, source 해석만 라우트.
 * 외부(카메라 소스) 전부 스텁 — REST 왕복 0. 파이프라인은 **실물**(SetupPipeline)을 쓰되 잡만 스파이.
 *
 * 경계면 교차: 응답 shape ↔ web/app.js `startPrecise()` 가 소비하는 필드
 *   (res.ok / data.error / data.stage / data.failure.{stage,reason}).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};
const cameraCfg = { zoomMin: 1, zoomMax: 36 } as unknown as ToolsConfig['camera'];

function view(slotId: number, camId: number, presetId: number, front = true): SlotSetupView {
  return {
    slotId, camId, presetId, presetSlotIdx: slotId, presetKey: `${camId}:${presetId}`,
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null,
    slot3dFrontCenter: front ? { x: 0.5, y: 0.5 } : null, updatedAt: null,
  };
}

/** cam:preset 목록을 프리셋 테이블로 노출하는 소스 스텁. listThrows 로 502 경로도 만든다. */
function makeSource(presets: Array<[number, number]>, opts: { listThrows?: string } = {}) {
  const listCalls: number[] = [];
  const byCam = new Map<number, number[]>();
  for (const [c, p] of presets) byCam.set(c, [...(byCam.get(c) ?? []), p]);
  const source = {
    kind: 'stub',
    listCameras: async () => {
      listCalls.push(1);
      if (opts.listThrows) throw new Error(opts.listThrows);
      return {
        cameras: [...byCam.entries()].map(([camIdx, ps]) => ({
          camIdx, label: `C${camIdx}`,
          presets: ps.map((presetIdx) => ({ presetIdx, label: `C${camIdx}-P${presetIdx}`, pan: 0, tilt: 0, zoom: 1 })),
        })),
      };
    },
    snapshot: async () => ({ jpeg: Buffer.alloc(0), ptz: { pan: 0, tilt: 0, zoom: 1 } }),
    move: async () => true,
    getPtz: async () => ({ pan: 0, tilt: 0, zoom: 1 }),
    toNativePtz: (p: unknown) => p,
    fromNativePtz: (p: unknown) => p,
  } as unknown as CameraSource;
  return { source, listCalls };
}

function makeApp(opts: {
  views?: SlotSetupView[];
  sources?: Map<string, CameraSource>;
  withCameraCfg?: boolean;
  withPipeline?: boolean;
} = {}) {
  const views = opts.views ?? [view(1, 1, 1)];
  const discoverStart = vi.fn(() => ({ total: views.length }));
  const calStart = vi.fn(() => ({ total: views.length }));
  const deps: SetupPipelineDeps = {
    job: { getSnapshot: () => ({ dets: [], presetRounds: new Map(), aggregated: [], occByPreset: new Map() }) as CaptureSnapshot },
    finalizer: { finalize: (async () => ({ artifact: {}, slots: 0, globalCount: 0 })) as unknown as Finalizer['finalize'] },
    discovery: { start: discoverStart, getStatus: () => ({ state: 'idle', done: 0, total: 0, found: 0 }) },
    calibrator: { start: calStart, getStatus: (): CalibrateStatus => ({ state: 'idle', done: 0, total: 0 }) },
    store: { getSlotSetup: () => views },
    now: () => 'T',
    sleep: async () => {},
  };
  const pipeline = new SetupPipeline(deps);
  const app = Fastify({ logger: false });
  registerCaptureRoutes(app, {
    job: { getStatus: () => ({}), getSnapshot: () => ({}), getLastFrame: () => undefined, getFramePresets: () => [] } as unknown as CaptureJob,
    finalizer: {} as unknown as Finalizer,
    store: { getSlotSetup: () => views } as unknown as SqliteStore,
    cfg: captureCfg,
    ...(opts.withPipeline === false ? {} : { pipeline }),
    ...(opts.sources ? { sources: opts.sources } : {}),
    ...(opts.withCameraCfg === false ? {} : { cameraCfg }),
  });
  return { app, pipeline, discoverStart, calStart };
}

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });

// ══════════════════════════════════════════════════════════════════
// U7 — 200 + 단계 전이 / 409 busy / 400 source not found
// ══════════════════════════════════════════════════════════════════
describe('U7. POST /capture/start-precise 기본 계약', () => {
  it('200 + {ok:true, stage:"discovering", precise:true} + discovery 발화', async () => {
    const h = makeApp(); app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: {} });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.ok).toBe(true);
    expect(b.stage).toBe('discovering');
    expect(b.precise).toBe(true);
    expect(b.armed).toBe(true);
    expect(h.discoverStart).toHaveBeenCalledTimes(1);
    // GET /capture/pipeline 로도 같은 stage 가 보인다(프론트 폴러 경계면).
    const p = await app.inject({ method: 'GET', url: '/capture/pipeline' });
    expect(JSON.parse(p.body).stage).toBe('discovering');
  });

  it('body 없음(payload 미전달)도 200 — source 옵셔널', async () => {
    const h = makeApp(); app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).stage).toBe('discovering');
  });

  it('진행 중(pipeline.isBusy) 재호출 → 409 {error:"pipeline busy", stage}', async () => {
    const h = makeApp(); app = h.app;
    await app.inject({ method: 'POST', url: '/capture/start-precise', payload: {} });
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: {} });
    expect(r.statusCode).toBe(409);
    const b = JSON.parse(r.body);
    expect(b.error).toBe('pipeline busy');
    expect(b.stage).toBe('discovering');
    expect(h.discoverStart).toHaveBeenCalledTimes(1); // 2회차는 잡을 건드리지 않는다.
  });

  it('source 미존재 → 400 {error:"source not found"} + 잡 미발화', async () => {
    const h = makeApp({ sources: new Map([['sim-1', makeSource([[1, 1]]).source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'nope' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('source not found');
    expect(h.discoverStart).not.toHaveBeenCalled();
    expect(h.pipeline.getStatus().stage).toBe('idle');
  });

  it('sources 미주입(헤드리스)에서 source 지정 → 400 source not found(조용한 무시 없음)', async () => {
    const h = makeApp(); app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'sim-1' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('source not found');
  });

  it('invalid body(source:"" ) → 400 invalid body', async () => {
    const h = makeApp(); app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: '' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid body');
  });

  it('preflight 실패(앞면중심 0) → 200 이지만 ok:false + stage failed + failure 사유', async () => {
    const h = makeApp({ views: [view(1, 1, 1, false)] }); app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: {} });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.ok).toBe(false); // ★ 프론트가 stage==='failed' 로도 분기한다(양쪽 다 관측 가능).
    expect(b.stage).toBe('failed');
    expect(b.failure.stage).toBe('discover');
    expect(b.failure.reason).toContain('ROI 파일 로딩');
    expect(h.discoverStart).not.toHaveBeenCalled();
  });

  it('pipeline 미주입(헤드리스) → 라우트 자체가 없다(404)', async () => {
    const h = makeApp({ withPipeline: false }); app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('유효한 source 지정 → 200 + 그 소스 어댑터가 calibrator.start 로 전달된다', async () => {
    const src = makeSource([[1, 1]]);
    const h = makeApp({ sources: new Map([['sim-1', src.source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'sim-1' } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).stage).toBe('discovering');
    expect(src.listCalls.length).toBe(1); // preflight 프리셋 조회 1회.

    h.pipeline.onDiscoverFinished('done');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.calStart).toHaveBeenCalledTimes(1);
    const opts = (h.calStart.mock.calls[0] as unknown as unknown[])[1] as { betweenSlotMs: number; camera?: ICameraClient };
    expect(opts.betweenSlotMs).toBe(1000);
    expect(opts.camera).toBeDefined();
    expect(typeof opts.camera!.clampZoom).toBe('function'); // CameraSourceClient 어댑터.
  });

  it('source.listCameras 실패 → 502(강등 아님) + 잡 미발화', async () => {
    const src = makeSource([[1, 1]], { listThrows: 'ECONNREFUSED' });
    const h = makeApp({ sources: new Map([['sim-1', src.source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'sim-1' } });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body).error).toBe('source listCameras failed');
    expect(h.discoverStart).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// U8 — 요건13: 프리셋 미보유 소스(리얼 카메라) 정직 차단
// ══════════════════════════════════════════════════════════════════
describe('U8. 리얼 소스 프리셋 부족 → 400 정직 실패', () => {
  const views4 = [view(1, 1, 1), view(2, 1, 2), view(3, 2, 1), view(4, 2, 2)];

  it('대상 프리셋 4개 중 1개만 보유 → 400 + 사유에 "프리셋" 포함 + missing[] 나열', async () => {
    const src = makeSource([[1, 1]]); // 리얼 카메라: 현재 위치 1개뿐.
    const h = makeApp({ views: views4, sources: new Map([['real-camera-1', src.source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'real-camera-1' } });

    expect(r.statusCode).toBe(400);
    const b = JSON.parse(r.body);
    expect(b.error).toContain('프리셋'); // ★ 조용한 강등이 아니라 사유 있는 차단.
    expect(b.error).toContain('1개'); // 소스가 실제로 가진 프리셋 수를 드러낸다.
    expect(b.missing).toEqual(['1:2', '2:1', '2:2']);
    expect(h.discoverStart).not.toHaveBeenCalled(); // 카메라를 엉뚱한 곳으로 보내지 않는다.
    expect(h.pipeline.getStatus().stage).toBe('idle'); // 파이프라인도 무장되지 않는다.
  });

  it('프리셋 전량 보유(시뮬레이터) → 통과 200', async () => {
    const src = makeSource([[1, 1], [1, 2], [2, 1], [2, 2]]);
    const h = makeApp({ views: views4, sources: new Map([['simulator-1', src.source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'simulator-1' } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).stage).toBe('discovering');
    expect(h.discoverStart).toHaveBeenCalledTimes(1);
  });

  it('여분 프리셋 보유는 문제 없음(want ⊆ have 만 요구)', async () => {
    const src = makeSource([[1, 1], [1, 2], [2, 1], [2, 2], [3, 7]]);
    const h = makeApp({ views: views4, sources: new Map([['simulator-1', src.source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: { source: 'simulator-1' } });
    expect(r.statusCode).toBe(200);
  });

  it('source 미지정이면 프리셋 preflight 자체를 하지 않는다(구현자 보고 §7-5 — 구멍을 봉인이 아니라 기록)', async () => {
    const src = makeSource([[1, 1]]);
    const h = makeApp({ views: views4, sources: new Map([['real-camera-1', src.source]]) });
    app = h.app;
    const r = await app.inject({ method: 'POST', url: '/capture/start-precise', payload: {} });
    expect(r.statusCode).toBe(200); // 부팅 카메라 사용 — 프리셋 집합 미검사.
    expect(src.listCalls.length).toBe(0);
  });
});
