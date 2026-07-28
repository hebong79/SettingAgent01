import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { needsControlToken, READONLY_POST_PATHS } from '../src/api/controlGate.js';
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
 * 전역 변이 게이트(설계서 §1.2 / 리더 결정 W1-단계2).
 *
 * ★ 이 파일이 증명하려는 것 3가지
 *   1. controlToken 이 빈 값이면 **아무 일도 일어나지 않는다**(현행 배포 무회귀).
 *   2. controlToken 이 있으면 변이 요청은 토큰 없이 통과할 수 없다(deny-by-default).
 *   3. 게이트 면제 목록과 RPC 카탈로그의 `mutating` 선언이 **갈리지 않는다**(드리프트 봉인).
 *      갈리면 "읽기 메서드가 무토큰 호출에서 403" 또는 "변이 라우트가 무인증 통과" 중 하나가 조용히 생긴다.
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

const viewerCfg = (controlToken: string): ToolsConfig['viewer'] => ({
  enabled: false, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken,
});

const fakeCamera = () => ({
  health: async () => true,
  clampZoom: (z: number) => z,
  requestImage: async (c: number, p: number): Promise<CapturedImage> =>
    ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
} as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

interface Ctx { app: FastifyInstance; store: SqliteStore; dir: string }

function makeCtx(controlToken: string): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'ctlgate-'));
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
    viewer: viewerCfg(controlToken),
  });
  return { app, store, dir };
}

async function rpc(app: FastifyInstance, method: string, params?: Record<string, unknown>, token?: string) {
  const r = await app.inject({
    method: 'POST', url: '/rpc',
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    ...(token ? { headers: { 'x-viewer-token': token } } : {}),
  });
  return r.json() as { result?: unknown; error?: { code: number; message: string } };
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

describe('needsControlToken — 순수 판정표', () => {
  it('GET/HEAD/OPTIONS 는 면제(읽기는 토큰 없이 본다)', () => {
    expect(needsControlToken('GET', '/capture/slots')).toBe(false);
    expect(needsControlToken('HEAD', '/capture/slots')).toBe(false);
    expect(needsControlToken('OPTIONS', '/capture/start')).toBe(false);
  });

  it('POST /rpc 는 면제 — dispatch 가 메서드별로 자체 게이트한다', () => {
    expect(needsControlToken('POST', '/rpc')).toBe(false);
  });

  it('읽기전용 POST 4경로는 면제(카탈로그 mutating:false 와 1:1)', () => {
    expect(needsControlToken('POST', '/capture/detect')).toBe(false);
    expect(needsControlToken('POST', '/capture/place-roi/validate')).toBe(false);
    expect(needsControlToken('POST', '/capture/ground-grid/bootstrap')).toBe(false);
    expect(needsControlToken('POST', '/capture/autocorrect')).toBe(false);
  });

  it('그 외 변이는 전부 게이트(deny-by-default)', () => {
    expect(needsControlToken('POST', '/capture/start')).toBe(true);
    expect(needsControlToken('PUT', '/mapping')).toBe(true);
    expect(needsControlToken('PUT', '/settings')).toBe(true);
    expect(needsControlToken('POST', '/capture/slots/reset')).toBe(true);
    expect(needsControlToken('DELETE', '/whatever')).toBe(true);
  });

  it('쿼리스트링은 판정에 영향을 주지 않는다', () => {
    expect(needsControlToken('POST', '/capture/detect?cam=1&preset=2')).toBe(false);
    expect(needsControlToken('POST', '/capture/start?source=s')).toBe(true);
  });

  it('메서드 대소문자 무관(fastify 는 대문자지만 판정 자체를 견고하게)', () => {
    expect(needsControlToken('get', '/capture/start')).toBe(false);
  });
});

describe("controlToken:'' — 훅 미등록(현행 동작 100% 보존)", () => {
  it('토큰 없이도 읽기·변이 라우트가 전부 통과한다', async () => {
    ctx = makeCtx('');
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/capture/slots' })).statusCode).toBe(200);
    const reset = await ctx.app.inject({ method: 'POST', url: '/capture/slots/reset' });
    expect(reset.statusCode).toBe(200);
  });

  it('RPC 변이 메서드도 토큰 없이 통과한다(기존 계약)', async () => {
    ctx = makeCtx('');
    const r = await rpc(ctx.app, 'slot.reset', { confirm: true });
    expect(r.error).toBeUndefined();
  });
});

describe("controlToken:'SECRET' — REST 변이 게이트", () => {
  it('토큰 없는 변이 POST 는 403 {error:"invalid token"}', async () => {
    ctx = makeCtx('SECRET');
    const res = await ctx.app.inject({ method: 'POST', url: '/capture/slots/reset' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invalid token' });
  });

  it('틀린 토큰도 403', async () => {
    ctx = makeCtx('SECRET');
    const res = await ctx.app.inject({
      method: 'POST', url: '/capture/slots/reset', headers: { 'x-viewer-token': 'WRONG' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('토큰 동봉 변이 POST 는 정상 200', async () => {
    ctx = makeCtx('SECRET');
    const res = await ctx.app.inject({
      method: 'POST', url: '/capture/slots/reset', headers: { 'x-viewer-token': 'SECRET' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('읽기(GET)는 토큰 없이도 200 — 관측을 막지 않는다', async () => {
    ctx = makeCtx('SECRET');
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/capture/slots' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/capture/status' })).statusCode).toBe(200);
  });

  it('PUT /mapping 도 게이트된다(기존에 무인증이던 경로)', async () => {
    ctx = makeCtx('SECRET');
    const res = await ctx.app.inject({ method: 'PUT', url: '/mapping', payload: { slots: [], globalIndex: [] } });
    expect(res.statusCode).toBe(403);
  });
});

describe("controlToken:'SECRET' — RPC 평면은 메서드별 게이트를 유지한다", () => {
  it('읽기 메서드(slot.list)는 무토큰으로도 통과한다', async () => {
    ctx = makeCtx('SECRET');
    const r = await rpc(ctx.app, 'slot.list');
    expect(r.error).toBeUndefined();
    expect(r.result).toBeTruthy();
  });

  it('변이 메서드(slot.reset)는 무토큰이면 FORBIDDEN', async () => {
    ctx = makeCtx('SECRET');
    const r = await rpc(ctx.app, 'slot.reset', { confirm: true });
    expect(r.error?.code).toBe(RpcCode.FORBIDDEN);
  });

  it('토큰을 실으면 변이 메서드가 하류 라우트까지 통과한다(브리지 토큰 전달)', async () => {
    ctx = makeCtx('SECRET');
    const r = await rpc(ctx.app, 'slot.reset', { confirm: true }, 'SECRET');
    expect(r.error).toBeUndefined();
  });

  it('읽기 선언 + POST 위임(plate.detect)은 무토큰으로도 게이트에 걸리지 않는다', async () => {
    ctx = makeCtx('SECRET');
    // lpd 미주입이라 라우트는 미등록(UNAVAILABLE) — 확인 대상은 "FORBIDDEN 이 아니다"는 사실이다.
    const r = await rpc(ctx.app, 'plate.detect', { cam: 1, preset: 1 });
    expect(r.error?.code).not.toBe(RpcCode.FORBIDDEN);
  });
});

describe('드리프트 방지 — 게이트 면제 목록 ↔ 카탈로그 mutating (양방향)', () => {
  const dummy = {
    cam: 1, preset: 1, camId: 1, presetIdx: 1, name: 'x', source: 's', imageWidth: 1, imageHeight: 1,
    confirm: true,
  };

  it('비-GET 위임 메서드는 mutating:false ⟺ 면제목록 포함 이어야 한다', () => {
    for (const m of METHODS) {
      if (!m.http) continue;
      const mapping = m.http(dummy);
      if (mapping.method === 'GET') continue;
      const url = mapping.url.split('?')[0];
      const exempt = READONLY_POST_PATHS.has(url);
      // 좌: 카탈로그 선언 / 우: 게이트 면제. 어긋나면 어느 쪽이 틀렸는지 메시지로 드러난다.
      expect(`${m.name} ${mapping.method} ${url} mutating=${m.mutating} exempt=${exempt}`).toBe(
        `${m.name} ${mapping.method} ${url} mutating=${!exempt} exempt=${exempt}`,
      );
    }
  });

  it('면제목록의 모든 경로는 실제로 어떤 mutating:false 메서드가 쓰는 경로다(고아 면제 금지)', () => {
    const used = new Set<string>();
    for (const m of METHODS) {
      if (!m.http || m.mutating) continue;
      const mapping = m.http(dummy);
      if (mapping.method === 'GET') continue;
      used.add(mapping.url.split('?')[0]);
    }
    expect([...READONLY_POST_PATHS].sort()).toEqual([...used].sort());
  });
});
