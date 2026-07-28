import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { SaveStore } from '../src/store/SaveStore.js';
import { judgeOccupancy } from '../src/domain/occupancyJudge.js';
import { buildOccupyRegionsBySlot } from '../src/domain/occupancyRegion.js';
import { RpcCode } from '../src/rpc/errors.js';
import { OccupancyJudge } from '../web/occupancy.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * O2 — `POST /capture/slots/judge-occupancy`(설계 §3.2 / §5.2 O2, 단계 8).
 *
 * ★ 이 파일이 고정하는 것
 *   1. **배치**: frames[] 하나로 여러 프리셋을 판정한다(프리셋 수만큼의 왕복을 1회로 접는 것이 R7 의 본체).
 *   2. **부작용 0**: 카메라·DB·파일을 건드리지 않는다 → 토큰 게이트 면제(mutating:false)와 정합.
 *   3. `regions:true` 결과가 `buildOccupyRegionsBySlot` **직접 호출과 동일**하다(정의가 갈리지 않는다).
 *   4. 라우트 결과 == 도메인 함수 결과 == 웹 기준변 결과(라우트가 로직을 갖지 않는다).
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
  clampZoom: (z: number) => z,
  requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

interface Ctx { app: FastifyInstance; store: SqliteStore; dir: string }

function makeCtx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'occroutes-'));
  const store = new SqliteStore(':memory:');
  const saved: SetupArtifact[] = [];
  const repo = {
    saveArtifact: (a: SetupArtifact) => saved.push(a),
    loadArtifact: () => saved.at(-1) ?? null,
    path: 'mem',
  } as unknown as Repository;
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: () => 0 as unknown as NodeJS.Timeout, clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const app = buildServer({
    orchestrator: new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' }),
    repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job,
    finalizer: new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' }),
    sqlite: store, capture: captureCfg,
    saveStore: new SaveStore(join(dir, 'save'), join(dir, 'reports')),
  });
  return { app, store, dir };
}

let ctx: Ctx | undefined;
afterEach(async () => {
  if (ctx) {
    await ctx.app.close();
    ctx.store.close();
    try { rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* 임시 디렉터리 잔존 — 무해 */ }
    ctx = undefined;
  }
});

const URL = '/capture/slots/judge-occupancy';

type Pt = { x: number; y: number };
const floorQuad = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const plateAt = (cx: number, cy: number, hs = 0.02) => ({
  quad: [
    { x: cx - hs, y: cy - hs }, { x: cx + hs, y: cy - hs },
    { x: cx + hs, y: cy + hs }, { x: cx - hs, y: cy + hs },
  ],
});

const FLOORS_A = [
  { idx: 1, quad: floorQuad(0.0, 0.0, 0.4, 0.4) },
  { idx: 2, quad: floorQuad(0.4, 0.0, 0.8, 0.4) },
];
const FLOORS_B = [{ idx: 3, quad: floorQuad(0.0, 0.5, 0.4, 0.9) }];

const DETECT_A = {
  plates: [plateAt(0.2, 0.2)],
  vehicles: [{ rect: { x: 0.45, y: 0.0, w: 0.25, h: 0.35 }, plate: plateAt(0.6, 0.2) }],
};
const DETECT_B = { plates: [plateAt(0.2, 0.7)] };

async function post(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'POST', url: URL, payload: payload as object });
}

describe('POST /capture/slots/judge-occupancy — 판정', () => {
  it('단일 frame → byKey[key].rows 가 도메인 함수 결과와 동일', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, { frames: [{ key: '1:1', floorPolygons: FLOORS_A, detect: DETECT_A }] });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(Object.keys(body.byKey)).toEqual(['1:1']);
    expect(body.byKey['1:1'].rows).toEqual(JSON.parse(JSON.stringify(judgeOccupancy(FLOORS_A, DETECT_A))));
    // 공허한 통과 방지 — 두 슬롯 모두 점유로 판정된 상태다.
    expect(body.byKey['1:1'].rows.map((o: { occupied: boolean }) => o.occupied)).toEqual([true, true]);
  });

  it('라우트 결과 == 웹 기준변(OccupancyJudge) 결과 — 라우트는 로직을 갖지 않는다', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, { frames: [{ key: '1:1', floorPolygons: FLOORS_A, detect: DETECT_A }] });
    const web = new OccupancyJudge().judge(FLOORS_A as never, DETECT_A as never);
    expect(JSON.parse(r.body).byKey['1:1'].rows).toEqual(JSON.parse(JSON.stringify(web)));
  });

  it('다중 frames → 프레임 수만큼의 요청이 1회로 접힌다(키별 독립 판정)', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, {
      frames: [
        { key: '1:1', floorPolygons: FLOORS_A, detect: DETECT_A },
        { key: '1:2', floorPolygons: FLOORS_B, detect: DETECT_B },
        { key: '1:3', floorPolygons: FLOORS_B, detect: null }, // 검출 없음 → 전 슬롯 미점유.
      ],
    });
    expect(r.statusCode).toBe(200);
    const { byKey } = JSON.parse(r.body);
    expect(Object.keys(byKey)).toEqual(['1:1', '1:2', '1:3']);
    expect(byKey['1:2'].rows).toEqual([{ idx: 3, occupied: true, source: 'plate', center: { x: 0.2, y: 0.7 }, plateQuad: plateAt(0.2, 0.7).quad }]);
    expect(byKey['1:3'].rows).toEqual([{ idx: 3, occupied: false, source: null }]);
  });

  it('cfg 오버라이드가 판정에 반영된다(minBandOverlap 상향 → bbox 귀속 소멸)', async () => {
    ctx = makeCtx();
    // slot1 을 2/3 만 덮는 차량 — 기본 임계(0.15)는 통과, 0.99 는 미달.
    const detect = { vehicles: [{ rect: { x: 0.3, y: 0.0, w: 0.15, h: 0.35 } }] };
    const base = await post(ctx.app, { frames: [{ key: 'k', floorPolygons: FLOORS_A, detect }] });
    const strict = await post(ctx.app, { frames: [{ key: 'k', floorPolygons: FLOORS_A, detect }], cfg: { minBandOverlap: 0.99 } });
    expect(JSON.parse(base.body).byKey.k.rows[0].occupied).toBe(true);
    expect(JSON.parse(strict.body).byKey.k.rows[0].occupied).toBe(false);
  });

  it('퇴화 입력(비4점 quad·w=0 rect·plates:null)은 400 이 아니라 graceful 판정이다', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, {
      frames: [{
        key: 'k',
        floorPolygons: [{ idx: 1, quad: [{ x: 0, y: 0 }, { x: 0.4, y: 0 }] }],
        detect: { plates: null, vehicles: [{ rect: { x: 0, y: 0, w: 0, h: 0.3 } }] },
      }],
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).byKey.k.rows).toEqual([{ idx: 1, occupied: false, source: null }]);
  });

  it('빈 frames → 200 {byKey:{}}(graceful — throw 금지)', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, { frames: [] });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ byKey: {} });
  });
});

describe('POST /capture/slots/judge-occupancy — regions:true', () => {
  it('regions 없이 호출하면 regions/overlapPairs 키가 없다(요청한 것만 준다)', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, { frames: [{ key: 'k', floorPolygons: FLOORS_A, detect: DETECT_A }] });
    expect(Object.keys(JSON.parse(r.body).byKey.k)).toEqual(['rows']);
  });

  it('★ regions 결과가 buildOccupyRegionsBySlot 직접 호출과 동일(정의 갈림 방지)', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, { frames: [{ key: 'k', floorPolygons: FLOORS_A, detect: DETECT_A }], regions: true });
    const body = JSON.parse(r.body);
    // 응답의 (idx → polygon) 사영이 곧 buildOccupyRegionsBySlot 의 반환 Map 이다.
    const fromRoute = new Map<number, unknown>(
      body.byKey.k.regions.map((g: { idx: number; polygon: unknown }) => [g.idx, g.polygon]),
    );
    // 모집단은 라우트와 동일하게 plate 점유분만.
    const rows = judgeOccupancy(FLOORS_A, DETECT_A);
    const direct = buildOccupyRegionsBySlot(
      rows.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ slotId: o.idx, quad: o.plateQuad as NormalizedQuad })),
    );
    expect(fromRoute).toEqual(new Map(direct));
    expect(fromRoute.size).toBe(2); // 공허한 통과 방지(빈 Map == 빈 Map 금지).
    expect(body.byKey.k.overlapPairs).toEqual([]);
  });

  it('bbox 폴백(번호 미인식)은 사다리꼴 모집단에서 빠진다(위장 생성 금지)', async () => {
    ctx = makeCtx();
    const detect = { vehicles: [{ rect: { x: 0.05, y: 0.0, w: 0.25, h: 0.35 } }] }; // plate 없음.
    const r = await post(ctx.app, { frames: [{ key: 'k', floorPolygons: FLOORS_A, detect }], regions: true });
    const body = JSON.parse(r.body);
    expect(body.byKey.k.rows[0]).toMatchObject({ occupied: true, source: 'bbox' });
    expect(body.byKey.k.regions).toEqual([]);
  });
});

describe('POST /capture/slots/judge-occupancy — 계약', () => {
  it('zod 실패(frames 누락·비배열·key 비문자열) → 400 invalid body', async () => {
    ctx = makeCtx();
    for (const payload of [{}, { frames: 'x' }, { frames: [{ key: 1, floorPolygons: [] }] }, { frames: [{ key: 'k' }] }]) {
      const r = await post(ctx.app, payload);
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe('invalid body');
    }
  });

  it('cfg/regions 타입 위반 → 400', async () => {
    ctx = makeCtx();
    const r = await post(ctx.app, { frames: [], cfg: { minBandOverlap: 'x' } });
    expect(r.statusCode).toBe(400);
    const r2 = await post(ctx.app, { frames: [], regions: 'yes' });
    expect(r2.statusCode).toBe(400);
  });

  it('부작용 0 — 호출 전후 slot_setup 이 바뀌지 않는다(DB 쓰기 금지)', async () => {
    ctx = makeCtx();
    const before = JSON.stringify(ctx.store.getSlotSetup());
    await post(ctx.app, { frames: [{ key: 'k', floorPolygons: FLOORS_A, detect: DETECT_A }], regions: true });
    expect(JSON.stringify(ctx.store.getSlotSetup())).toBe(before);
  });
});

describe('RPC slot.occupancy.evaluate — 위임(로직 0줄)', () => {
  async function rpc(app: FastifyInstance, method: string, params?: unknown) {
    const r = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) },
    });
    return JSON.parse(r.body);
  }

  it('RPC result == REST 응답(같은 입력)', async () => {
    ctx = makeCtx();
    const params = { frames: [{ key: '1:1', floorPolygons: FLOORS_A, detect: DETECT_A }], regions: true };
    const rest = await post(ctx.app, params);
    const viaRpc = await rpc(ctx.app, 'slot.occupancy.evaluate', params);
    expect(viaRpc.result).toEqual(JSON.parse(rest.body));
  });

  it('zod 실패 → INVALID_PARAMS(-32602)', async () => {
    ctx = makeCtx();
    const viaRpc = await rpc(ctx.app, 'slot.occupancy.evaluate', { frames: 'x' });
    expect(viaRpc.error?.code).toBe(RpcCode.INVALID_PARAMS);
  });

  it('카탈로그에 mutating:false 로 실려 있다(읽기 — 토큰 게이트 면제 근거)', async () => {
    ctx = makeCtx();
    const r = await ctx.app.inject({ method: 'GET', url: '/rpc/catalog' });
    const cat = JSON.parse(r.body);
    const m = cat.methods.find((x: { name: string }) => x.name === 'slot.occupancy.evaluate');
    expect(m).toBeDefined();
    expect(m.mutating).toBe(false);
  });
});
