import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerViewerRoutes } from '../src/viewer/routes.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';
import type { CRpcClient } from '../src/clients/CRpcClient.js';
import { RpcClientError } from '../src/clients/CRpcClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

const viewerCfg = (over: Partial<ToolsConfig['viewer']> = {}): ToolsConfig['viewer'] => ({
  enabled: true,
  allowMove: true,
  defaultFps: 3,
  staticDir: 'web',
  controlToken: '',
  ...over,
});

/** callRpc/getCatalog 호출 인자·반환을 제어하는 가짜 CRpcClient(구조적 프라이빗 회피 위해 캐스팅). */
interface FakeRpc {
  callRpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  getCatalog: () => Promise<{ methods: string[] }>;
  calls: { callRpc: { method: string; params?: Record<string, unknown> }[]; getCatalog: number };
}

function fakeRpc(opts: {
  callResult?: unknown;
  callThrow?: unknown;
  catalog?: { methods: string[] };
  catalogThrow?: unknown;
} = {}): FakeRpc {
  const calls: FakeRpc['calls'] = { callRpc: [], getCatalog: 0 };
  return {
    calls,
    async callRpc(method, params) {
      calls.callRpc.push({ method, params });
      if (opts.callThrow) throw opts.callThrow;
      return opts.callResult ?? { echoed: method };
    },
    async getCatalog() {
      calls.getCatalog++;
      if (opts.catalogThrow) throw opts.catalogThrow;
      return opts.catalog ?? { methods: ['system.ping'] };
    },
  };
}

async function mkApp(opts: {
  rpc?: FakeRpc;
  viewer?: Partial<ToolsConfig['viewer']>;
}): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-rpc-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const app = Fastify();
  const sources = new Map<string, CameraSource>();
  await registerViewerRoutes(app, {
    sources,
    viewer: viewerCfg({ staticDir: dir, ...opts.viewer }),
    rpc: opts.rpc as unknown as CRpcClient | undefined,
  });
  await app.ready();
  return { app, dir };
}

async function withApp(
  opts: Parameters<typeof mkApp>[0],
  fn: (app: FastifyInstance, rpc: FakeRpc | undefined) => Promise<void>,
): Promise<void> {
  const { app, dir } = await mkApp(opts);
  try {
    await fn(app, opts.rpc);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('POST /viewer/api/rpc (Unity RPC 프록시)', () => {
  it('정상 → 200 {ok:true, result}, callRpc 가 method/params 그대로 수신', async () => {
    const rpc = fakeRpc({ callResult: { pong: true } });
    await withApp({ rpc }, async (app) => {
      const r = await app.inject({
        method: 'POST',
        url: '/viewer/api/rpc',
        payload: { method: 'system.ping', params: { n: 1 } },
      });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true, result: { pong: true } });
      // 경계면 교차: 라우트가 body 를 callRpc(method, params) 로 정확히 전달.
      expect(rpc.calls.callRpc).toEqual([{ method: 'system.ping', params: { n: 1 } }]);
    });
  });

  it('params 생략 → callRpc 에 params=undefined 로 전달', async () => {
    const rpc = fakeRpc();
    await withApp({ rpc }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/rpc', payload: { method: 'cam.list' } });
      expect(r.statusCode).toBe(200);
      expect(rpc.calls.callRpc[0]).toEqual({ method: 'cam.list', params: undefined });
    });
  });

  it('controlToken 설정 + 토큰 헤더 없음 → 403(callRpc 미호출)', async () => {
    const rpc = fakeRpc();
    await withApp({ rpc, viewer: { controlToken: 'secret' } }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/rpc', payload: { method: 'system.ping' } });
      expect(r.statusCode).toBe(403);
      expect(rpc.calls.callRpc.length).toBe(0);
    });
  });

  it('controlToken 설정 + 토큰 불일치 → 403', async () => {
    const rpc = fakeRpc();
    await withApp({ rpc, viewer: { controlToken: 'secret' } }, async (app) => {
      const r = await app.inject({
        method: 'POST',
        url: '/viewer/api/rpc',
        headers: { 'x-viewer-token': 'wrong' },
        payload: { method: 'system.ping' },
      });
      expect(r.statusCode).toBe(403);
    });
  });

  it('controlToken 설정 + 토큰 일치 → 200(통과)', async () => {
    const rpc = fakeRpc({ callResult: 'ok' });
    await withApp({ rpc, viewer: { controlToken: 'secret' } }, async (app) => {
      const r = await app.inject({
        method: 'POST',
        url: '/viewer/api/rpc',
        headers: { 'x-viewer-token': 'secret' },
        payload: { method: 'system.ping' },
      });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true, result: 'ok' });
    });
  });

  it('body method 누락 → 400 invalid body', async () => {
    const rpc = fakeRpc();
    await withApp({ rpc }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/rpc', payload: { params: { a: 1 } } });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe('invalid body');
      expect(rpc.calls.callRpc.length).toBe(0);
    });
  });

  it('method 빈 문자열 → 400(min1 위반)', async () => {
    const rpc = fakeRpc();
    await withApp({ rpc }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/rpc', payload: { method: '' } });
      expect(r.statusCode).toBe(400);
    });
  });

  it('callRpc throw(RpcClientError) → 502 {ok:false, error}', async () => {
    const rpc = fakeRpc({ callThrow: new RpcClientError('connection_error', 'Unity 미기동') });
    await withApp({ rpc }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/rpc', payload: { method: 'system.ping' } });
      expect(r.statusCode).toBe(502);
      const body = JSON.parse(r.body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain('Unity 미기동');
    });
  });
});

describe('GET /viewer/api/rpc/catalog', () => {
  it('정상 → getCatalog 결과 그대로 반환(무게이트)', async () => {
    const rpc = fakeRpc({ catalog: { methods: ['system.ping', 'cam.setPan'] } });
    await withApp({ rpc, viewer: { controlToken: 'secret' } }, async (app) => {
      // controlToken 이 있어도 읽기 라우트는 게이트 없음(토큰 없이 200).
      const r = await app.inject({ method: 'GET', url: '/viewer/api/rpc/catalog' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ methods: ['system.ping', 'cam.setPan'] });
      expect(rpc.calls.getCatalog).toBe(1);
    });
  });

  it('getCatalog throw → 502', async () => {
    const rpc = fakeRpc({ catalogThrow: new RpcClientError('connection_error', 'catalog 실패') });
    await withApp({ rpc }, async (app) => {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/rpc/catalog' });
      expect(r.statusCode).toBe(502);
      expect(JSON.parse(r.body).error).toContain('catalog 실패');
    });
  });
});

describe('rpc 미주입(가산 보존)', () => {
  it('rpc 없이 등록 → POST /viewer/api/rpc, GET catalog 미등록(404)', async () => {
    await withApp({}, async (app) => {
      const post = await app.inject({ method: 'POST', url: '/viewer/api/rpc', payload: { method: 'x' } });
      expect(post.statusCode).toBe(404);
      const cat = await app.inject({ method: 'GET', url: '/viewer/api/rpc/catalog' });
      expect(cat.statusCode).toBe(404);
    });
  });
});
