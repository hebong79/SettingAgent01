import { describe, it, expect, afterEach, vi } from 'vitest';
import { CRpcClient, RpcClientError } from '../src/clients/CRpcClient.js';

/**
 * CRpcClient 단위 테스트.
 * 외부 네트워크(Unity /rpc, /rpc/catalog)는 globalThis.fetch 스텁으로 모킹.
 */

const cfg = { baseUrl: 'http://localhost:13110', timeoutMs: 5000 };

/** fetch 를 주어진 JSON body + status 로 스텁. */
function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

/** fetch 를 네트워크 오류로 스텁. */
function stubFetchError(message: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(message); }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────
// callRpc
// ─────────────────────────────────────────────
describe('CRpcClient.callRpc', () => {
  it('(a) 올바른 JSON-RPC 2.0 봉투로 POST', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { pong: true } }), { status: 200 });
      }),
    );

    const client = new CRpcClient(cfg);
    await client.callRpc('system.ping', { token: 'abc' });

    expect(capturedUrl).toBe('http://localhost:13110/rpc');
    expect(capturedBody.jsonrpc).toBe('2.0');
    expect(capturedBody.method).toBe('system.ping');
    expect(capturedBody.params).toEqual({ token: 'abc' });
    expect(capturedBody.id).toBeDefined();
  });

  it('(a-2) params 미전달 시 봉투에 params 필드 없음', async () => {
    let capturedBody: Record<string, unknown> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
      }),
    );

    const client = new CRpcClient(cfg);
    await client.callRpc('system.ping');

    expect(Object.prototype.hasOwnProperty.call(capturedBody, 'params')).toBe(false);
  });

  it('(b) result 파싱 — 반환값이 result 필드 그대로', async () => {
    stubFetch({ jsonrpc: '2.0', id: 1, result: { value: 42, list: [1, 2, 3] } });

    const client = new CRpcClient(cfg);
    const result = await client.callRpc('test.method');

    expect(result).toEqual({ value: 42, list: [1, 2, 3] });
  });

  it('(b-2) result 가 null 이어도 정상 반환', async () => {
    stubFetch({ jsonrpc: '2.0', id: 1, result: null });

    const client = new CRpcClient(cfg);
    const result = await client.callRpc('test.null');

    expect(result).toBeNull();
  });

  it('(c) RPC error 응답 → RpcClientError(kind=rpc_error)', async () => {
    stubFetch({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });

    const client = new CRpcClient(cfg);
    const err = await client.callRpc('unknown.method').catch((e) => e);

    expect(err).toBeInstanceOf(RpcClientError);
    expect((err as RpcClientError).kind).toBe('rpc_error');
    expect((err as RpcClientError).message).toContain('-32601');
    expect((err as RpcClientError).message).toContain('Method not found');
  });

  it('(c-2) RPC error 의 detail 에 원본 error 객체 보존', async () => {
    const rpcErr = { code: -32000, message: 'Server error', data: { hint: 'check unity' } };
    stubFetch({ jsonrpc: '2.0', id: 1, error: rpcErr });

    const client = new CRpcClient(cfg);
    const err = await client.callRpc('x').catch((e) => e);

    expect((err as RpcClientError).detail).toEqual(rpcErr);
  });

  it('(d) 연결 오류(fetch throw) → RpcClientError(kind=connection_error)', async () => {
    stubFetchError('connect ECONNREFUSED');

    const client = new CRpcClient(cfg);
    const err = await client.callRpc('test').catch((e) => e);

    expect(err).toBeInstanceOf(RpcClientError);
    expect((err as RpcClientError).kind).toBe('connection_error');
    expect((err as RpcClientError).message).toContain('ECONNREFUSED');
  });

  it('(d-2) baseUrl trailing-slash 무관하게 /rpc 로 POST', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 });
      }),
    );

    const client = new CRpcClient({ baseUrl: 'http://localhost:13110/', timeoutMs: 5000 });
    await client.callRpc('x');

    expect(capturedUrl).toBe('http://localhost:13110/rpc');
  });
});

// ─────────────────────────────────────────────
// getCatalog
// ─────────────────────────────────────────────
describe('CRpcClient.getCatalog', () => {
  it('GET /rpc/catalog 응답의 methods 배열을 반환', async () => {
    stubFetch({ methods: ['system.ping', 'scene.load', 'vehicle.spawn'] });

    const client = new CRpcClient(cfg);
    const catalog = await client.getCatalog();

    expect(catalog.methods).toEqual(['system.ping', 'scene.load', 'vehicle.spawn']);
  });

  it('빈 methods 배열도 정상 반환', async () => {
    stubFetch({ methods: [] });

    const client = new CRpcClient(cfg);
    const catalog = await client.getCatalog();

    expect(catalog.methods).toEqual([]);
  });

  it('연결 실패(fetch throw) → RpcClientError(kind=connection_error)', async () => {
    stubFetchError('connect ECONNREFUSED 127.0.0.1:13110');

    const client = new CRpcClient(cfg);
    const err = await client.getCatalog().catch((e) => e);

    expect(err).toBeInstanceOf(RpcClientError);
    expect((err as RpcClientError).kind).toBe('connection_error');
  });

  it('HTTP 4xx/5xx → RpcClientError(kind=http_error)', async () => {
    stubFetch({ error: 'not found' }, 404);

    const client = new CRpcClient(cfg);
    const err = await client.getCatalog().catch((e) => e);

    expect(err).toBeInstanceOf(RpcClientError);
    expect((err as RpcClientError).kind).toBe('http_error');
    expect((err as RpcClientError).message).toContain('404');
  });
});

// ─────────────────────────────────────────────
// MCP 툴 등록 스모크 (buildMcpServer 기동 확인)
// ─────────────────────────────────────────────
describe('buildMcpServer 스모크', () => {
  it('buildMcpServer() 가 예외 없이 McpServer 를 반환', async () => {
    const { buildMcpServer } = await import('../src/mcp/server.js');
    expect(() => buildMcpServer()).not.toThrow();
  });
});
