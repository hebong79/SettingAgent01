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
import { RpcCode } from '../src/rpc/errors.js';
import { METHODS } from '../src/rpc/methods.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
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
    rmSync(ctx.dir, { recursive: true, force: true });
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
});
