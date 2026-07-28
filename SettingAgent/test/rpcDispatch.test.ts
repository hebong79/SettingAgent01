import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { RpcCode, classify409, isRouteNotRegistered, mapHttpStatus, messageOf } from '../src/rpc/errors.js';
import { METHODS, buildMethodMap } from '../src/rpc/methods.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CRpcClient } from '../src/clients/CRpcClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): RPC 제어 평면 — 봉투·게이트·에러매핑·카탈로그·unity 패스스루.
 * 설계 근거: 20260728_183010 설계서 §4 / 20260728_184621 다이어그램 §4·§5·§6.
 *
 * ★ 이 파일이 지키는 계약:
 *   - BUSY(-32001, 재시도 가능) 와 CONFLICT(-32005, 사람 개입) 가 **갈라져 있을 것**
 *   - 라우트 미등록(-32004) 과 값 없음(-32002) 이 **갈라져 있을 것**
 *   - 파괴적 메서드는 confirm 없이 위임되지 않을 것
 *   - 기존 REST 라우트는 이 기능이 붙어도 불변일 것(회귀 0)
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
const viewerCfg = (controlToken = ''): ToolsConfig['viewer'] =>
  ({ enabled: false, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken }) as ToolsConfig['viewer'];

const fakeCamera = () => ({
  health: async () => true,
  clampZoom: (z: number) => z,
  requestImage: async (c: number, p: number): Promise<CapturedImage> =>
    ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = () => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

interface ServerOpts {
  controlToken?: string;
  isBusy?: () => { busy: boolean; who?: string };
  unityRpc?: CRpcClient;
  /** capture 블록(=/capture/* 라우트) 자체를 빼고 싶을 때 false. 미배선 경로 검증용. */
  withCapture?: boolean;
}

function makeServer(opts: ServerOpts = {}) {
  const store = new SqliteStore(':memory:');
  const repo = fakeRepo();
  const queue: Array<() => void> = [];
  const job = new CaptureJob({
    camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    ...(opts.withCapture === false ? {} : { captureJob: job, finalizer, sqlite: store, capture: captureCfg }),
    viewer: viewerCfg(opts.controlToken ?? ''),
    ...(opts.isBusy ? { isBusy: opts.isBusy } : {}),
    ...(opts.unityRpc ? { rpc: opts.unityRpc } : {}),
  });
  return { app, store };
}

async function rpc(
  app: FastifyInstance,
  method: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/rpc',
    payload: { jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) },
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
  return { status: r.statusCode, body: r.json() as { jsonrpc: string; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } } };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
});

describe('메서드 표(정적 계약)', () => {
  it('이름 중복이 없다', () => {
    expect(() => buildMethodMap()).not.toThrow();
  });

  it('모든 메서드가 http 또는 handler 중 정확히 하나를 갖는다', () => {
    for (const m of METHODS) {
      const has = (m.http ? 1 : 0) + (m.handler ? 1 : 0);
      expect(`${m.name}:${has}`).toBe(`${m.name}:1`);
    }
  });

  it('파괴적 메서드는 destructive 로 표시돼 있다(카탈로그가 경고의 단일 출처)', () => {
    const map = buildMethodMap();
    for (const name of ['slot.roi.load', 'slot.reset', 'capture.finalize', 'grid.apply', 'place.revert']) {
      expect(`${name}:${map.get(name)?.destructive === true}`).toBe(`${name}:true`);
    }
  });
});

describe('오류 매핑(순수)', () => {
  it('409 를 BUSY / CONFLICT 로 가른다', () => {
    expect(classify409({ error: 'pipeline busy', stage: 'discovering' })).toBe(RpcCode.BUSY);
    expect(classify409({ error: 'capture still running', state: 'running' })).toBe(RpcCode.BUSY);
    expect(classify409({ error: 'centering already running' })).toBe(RpcCode.BUSY);
    expect(classify409({ error: 'raw 주차면 개수 불일치 — 저장하지 않음', expected: 8, actual: 7 })).toBe(RpcCode.CONFLICT);
    expect(classify409({ error: 'slot_id 불일치 16건' })).toBe(RpcCode.CONFLICT);
    expect(classify409({})).toBe(RpcCode.CONFLICT); // 판정 불가 → 안전측(사람 개입)
  });

  it('Fastify 미등록 404 와 핸들러 404 를 가른다', () => {
    const notRegistered = { statusCode: 404, error: 'Not Found', message: 'Route POST:/capture/start not found' };
    expect(isRouteNotRegistered(notRegistered)).toBe(true);
    expect(isRouteNotRegistered({ error: 'no result' })).toBe(false);
    expect(mapHttpStatus(404, notRegistered)).toBe(RpcCode.UNAVAILABLE);
    expect(mapHttpStatus(404, { error: 'no result' })).toBe(RpcCode.NOT_FOUND);
  });

  it('나머지 상태 매핑', () => {
    expect(mapHttpStatus(400, {})).toBe(RpcCode.INVALID_PARAMS);
    expect(mapHttpStatus(403, {})).toBe(RpcCode.FORBIDDEN);
    expect(mapHttpStatus(501, {})).toBe(RpcCode.UNAVAILABLE);
    expect(mapHttpStatus(503, {})).toBe(RpcCode.UNAVAILABLE);
    expect(mapHttpStatus(502, {})).toBe(RpcCode.UPSTREAM);
    expect(mapHttpStatus(500, {})).toBe(RpcCode.INTERNAL);
  });

  it('메시지는 라우트의 error 문자열을 그대로 살린다', () => {
    expect(messageOf({ error: 'targets 비어 있음' }, 'fallback')).toBe('targets 비어 있음');
    expect(messageOf({}, 'fallback')).toBe('fallback');
  });
});

describe('봉투 규약', () => {
  it('정상 호출 → HTTP 200 + result(전송 성공은 항상 200)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'system.ping');
    expect(r.status).toBe(200);
    expect(r.body.jsonrpc).toBe('2.0');
    expect(r.body.id).toBe(7);
    expect((r.body.result as { ok: boolean }).ok).toBe(true);
  });

  it('오류도 HTTP 200 + error 봉투(클라이언트가 한 곳만 본다)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'nope.nope');
    expect(r.status).toBe(200);
    expect(r.body.error?.code).toBe(RpcCode.METHOD_NOT_FOUND);
  });

  it('jsonrpc 누락 → INVALID_REQUEST', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/rpc', payload: { id: 1, method: 'system.ping' } });
    expect((r.json() as { error: { code: number } }).error.code).toBe(RpcCode.INVALID_REQUEST);
  });

  it('배치(배열) 요청 → 미지원 INVALID_REQUEST', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/rpc', payload: [{ jsonrpc: '2.0', id: 1, method: 'system.ping' }] });
    expect((r.json() as { error: { code: number } }).error.code).toBe(RpcCode.INVALID_REQUEST);
  });

  it('params 가 배열이면 INVALID_PARAMS(객체만 지원)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'POST', url: '/rpc', payload: { jsonrpc: '2.0', id: 1, method: 'system.ping', params: [1, 2] } });
    expect((r.json() as { error: { code: number } }).error.code).toBe(RpcCode.INVALID_PARAMS);
  });
});

describe('게이트', () => {
  it('controlToken 설정 시 변이 메서드는 토큰 없이 FORBIDDEN', async () => {
    const s = makeServer({ controlToken: 'secret' }); app = s.app; store = s.store;
    const r = await rpc(app, 'slot.reset', { confirm: true });
    expect(r.body.error?.code).toBe(RpcCode.FORBIDDEN);
  });

  it('controlToken 설정 시 읽기 메서드는 토큰 없이도 통과', async () => {
    const s = makeServer({ controlToken: 'secret' }); app = s.app; store = s.store;
    const r = await rpc(app, 'slot.list');
    expect(r.body.error).toBeUndefined();
  });

  it('토큰 일치 시 변이 메서드 통과', async () => {
    const s = makeServer({ controlToken: 'secret' }); app = s.app; store = s.store;
    const r = await rpc(app, 'slot.reset', { confirm: true }, { 'x-viewer-token': 'secret' });
    expect(r.body.error).toBeUndefined();
    expect((r.body.result as { ok: boolean }).ok).toBe(true);
  });

  it('카메라 점유 중이면 requiresCamera 메서드는 BUSY + who', async () => {
    const s = makeServer({ isBusy: () => ({ busy: true, who: '정밀수집' }) }); app = s.app; store = s.store;
    const r = await rpc(app, 'center.start', {});
    expect(r.body.error?.code).toBe(RpcCode.BUSY);
    expect((r.body.error?.data as { who: string }).who).toBe('정밀수집');
  });

  it('카메라 점유 중이어도 읽기 메서드는 통과', async () => {
    const s = makeServer({ isBusy: () => ({ busy: true, who: '정밀수집' }) }); app = s.app; store = s.store;
    const r = await rpc(app, 'capture.status');
    expect(r.body.error).toBeUndefined();
  });
});

describe('파괴적 메서드 confirm 게이트', () => {
  it('slot.roi.load 는 confirm 없이 INVALID_PARAMS(위임되지 않는다)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'slot.roi.load', {});
    expect(r.body.error?.code).toBe(RpcCode.INVALID_PARAMS);
    expect((r.body.error?.data as { confirmRequired: boolean }).confirmRequired).toBe(true);
  });

  it('capture.finalize 는 confirm 없이 INVALID_PARAMS', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'capture.finalize', {});
    expect(r.body.error?.code).toBe(RpcCode.INVALID_PARAMS);
  });

  it('grid.apply 는 confirm 없이 INVALID_PARAMS', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'grid.apply', { camId: 1, presetIdx: 1 });
    expect(r.body.error?.code).toBe(RpcCode.INVALID_PARAMS);
  });
});

describe('배선 상태(available)', () => {
  it('placeRoiFile 미주입이면 place.space.add 는 UNAVAILABLE + missing', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'place.space.add', { camId: 1, presetIdx: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
    expect(r.body.error?.code).toBe(RpcCode.UNAVAILABLE);
    expect((r.body.error?.data as { missing: string[] }).missing).toContain('placeRoiFile');
  });

  it('capture 블록 미등록이면 브리지 메서드는 UNAVAILABLE(라우트 미등록 404 를 구분한다)', async () => {
    const s = makeServer({ withCapture: false }); app = s.app; store = s.store;
    const r = await rpc(app, 'capture.status');
    expect(r.body.error?.code).toBe(RpcCode.UNAVAILABLE);
  });

  it('URL 필수 파라미터 누락 → INVALID_PARAMS(엉뚱한 404 로 새지 않는다)', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'db.table.query', {});
    expect(r.body.error?.code).toBe(RpcCode.INVALID_PARAMS);
    expect((r.body.error?.data as { missing: string[] }).missing).toContain('name');
  });
});

describe('카탈로그', () => {
  it('GET /rpc/catalog — 메서드 메타 + Unity 미배선 issue', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/rpc/catalog' });
    const body = r.json() as { methods: Array<{ name: string; mutating: boolean; available: boolean; destructive: boolean }>; unity: string[]; issues: string[] };
    expect(r.statusCode).toBe(200);
    expect(body.methods.length).toBeGreaterThan(50);
    expect(body.methods.find((m) => m.name === 'system.catalog')).toBeTruthy();
    expect(body.methods.find((m) => m.name === 'slot.roi.load')?.destructive).toBe(true);
    expect(body.methods.find((m) => m.name === 'place.space.add')?.available).toBe(false); // placeRoiFile 미주입
    expect(body.unity).toEqual([]);
    expect(body.issues.join(' ')).toContain('Unity RPC 미배선');
  });

  it('system.catalog 메서드도 같은 목록을 돌려준다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'system.catalog');
    expect((r.body.result as { methods: unknown[] }).methods.length).toBeGreaterThan(50);
  });
});

describe('unity.* 패스스루', () => {
  const fakeUnity = (): CRpcClient =>
    ({
      callRpc: async (method: string, params?: Record<string, unknown>) => ({ echo: method, params }),
      getCatalog: async () => ({ methods: ['cam.setPTZ', 'preset.list'] }),
    } as unknown as CRpcClient);

  it('unity.cam.setPTZ → 접두어를 벗겨 그대로 전달', async () => {
    const s = makeServer({ unityRpc: fakeUnity() }); app = s.app; store = s.store;
    const r = await rpc(app, 'unity.cam.setPTZ', { camId: 1, pan: 10 });
    expect(r.body.result).toEqual({ echo: 'cam.setPTZ', params: { camId: 1, pan: 10 } });
  });

  it('카탈로그에 unity. 접두어로 병합된다', async () => {
    const s = makeServer({ unityRpc: fakeUnity() }); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/rpc/catalog' });
    expect((r.json() as { unity: string[] }).unity).toEqual(['unity.cam.setPTZ', 'unity.preset.list']);
  });

  it('Unity 미배선이면 UNAVAILABLE', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    const r = await rpc(app, 'unity.cam.setPTZ', {});
    expect(r.body.error?.code).toBe(RpcCode.UNAVAILABLE);
  });

  it('Unity 실패는 UPSTREAM 으로 접힌다', async () => {
    const broken = { callRpc: async () => { throw new Error('ECONNREFUSED'); }, getCatalog: async () => { throw new Error('down'); } } as unknown as CRpcClient;
    const s = makeServer({ unityRpc: broken }); app = s.app; store = s.store;
    const r = await rpc(app, 'unity.cam.setPTZ', {});
    expect(r.body.error?.code).toBe(RpcCode.UPSTREAM);
  });

  it('Unity 다운이어도 카탈로그의 자기 메서드는 정상(강등)', async () => {
    const broken = { callRpc: async () => ({}), getCatalog: async () => { throw new Error('down'); } } as unknown as CRpcClient;
    const s = makeServer({ unityRpc: broken }); app = s.app; store = s.store;
    const r = await app.inject({ method: 'GET', url: '/rpc/catalog' });
    const body = r.json() as { methods: unknown[]; issues: string[] };
    expect(body.methods.length).toBeGreaterThan(50);
    expect(body.issues.join(' ')).toContain('Unity 카탈로그 조회 실패');
  });
});

describe('기존 REST 회귀(가산 확인)', () => {
  it('/rpc 추가 후에도 기존 라우트는 그대로 동작한다', async () => {
    const s = makeServer(); app = s.app; store = s.store;
    for (const url of ['/health', '/capture/status', '/capture/slots']) {
      const r = await app.inject({ method: 'GET', url });
      expect(`${url}:${r.statusCode}`).toBe(`${url}:200`);
    }
  });
});
