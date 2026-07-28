import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { CRpcClient } from '../src/clients/CRpcClient.js';

/**
 * 검증자(qa-tester): MCP ↔ SettingAgent RPC 연결(`setting_rpc` / `setting_rpc_catalog`).
 *
 * ★ 이 도구가 필요한 이유: 셸이 없는 MCP 클라이언트(Claude Desktop·Codex 등)는 HTTP 를 직접 부를 수 없어
 *   13020 의 셋팅 제어 메서드에 닿을 방법이 아예 없었다. 이 파일은 그 통로가 실제로 뚫려 있는지,
 *   그리고 두뇌가 위험한 메서드를 분간할 수 있는 정보를 받는지 고정한다.
 */

/** MCP 클라이언트를 인메모리로 서버에 물린다(실제 stdio 프로세스 없이 프로토콜 그대로). */
async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** fetch 스텁 — 호출 URL·본문·헤더를 캡처하고 지정 JSON 을 돌려준다. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

/** 도구 호출 결과(JSON 텍스트 1건)를 객체로. */
function payloadOf(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('도구 노출', () => {
  it('setting_rpc / setting_rpc_catalog 가 등록된다(기존 5개는 그대로 — 가산)', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('setting_rpc');
    expect(names).toContain('setting_rpc_catalog');
    // 기존 도구 회귀 0.
    for (const n of ['camera_req_img', 'camera_req_move', 'vpd_detect', 'unity_rpc', 'unity_rpc_catalog']) {
      expect(names).toContain(n);
    }
    await client.close();
  });

  it('setting_rpc 설명이 두뇌에게 위험·오류 판단 근거를 준다', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'setting_rpc')!;
    const d = tool.description ?? '';
    // 파괴적 메서드 경고 + confirm 규약.
    expect(d).toContain('destructive');
    expect(d).toContain('confirm:true');
    // 재시도 여부를 가르는 두 코드가 설명에 있어야 한다(있어야 두뇌가 BUSY 만 재시도한다).
    expect(d).toContain('-32001');
    expect(d).toContain('-32005');
    // 선행 조회 유도.
    expect(d).toContain('setting_rpc_catalog');
    await client.close();
  });

  it('catalog 도구는 filter 파라미터를 받는다(70 메서드 전량 덤프 회피)', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'setting_rpc_catalog')!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('filter');
    await client.close();
  });
});

describe('setting_rpc 위임', () => {
  it('13020 /rpc 로 JSON-RPC 2.0 봉투를 보낸다(Unity 13110 이 아니다)', async () => {
    const calls = stubFetch({ jsonrpc: '2.0', id: 1, result: [{ slotId: 1 }] });
    const client = await connect();
    const res = await client.callTool({ name: 'setting_rpc', arguments: { method: 'slot.list' } });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^http:\/\/localhost:\d+\/rpc$/);
    expect(calls[0].url).not.toContain('13110'); // 시뮬레이터가 아니라 자기 자신
    const sent = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('slot.list');

    const out = payloadOf(res);
    expect(out.ok).toBe(true);
    expect(out.result).toEqual([{ slotId: 1 }]);
    await client.close();
  });

  it('params 를 그대로 실어 보낸다', async () => {
    const calls = stubFetch({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const client = await connect();
    await client.callTool({
      name: 'setting_rpc',
      arguments: { method: 'place.space.add', params: { camId: 1, presetIdx: 2, points: [] } },
    });
    const sent = JSON.parse(calls[0].init.body as string) as { params: Record<string, unknown> };
    expect(sent.params).toEqual({ camId: 1, presetIdx: 2, points: [] });
    await client.close();
  });

  it('RPC 오류의 code 를 detail 로 보존한다(두뇌가 BUSY/CONFLICT 를 구분할 수 있어야 한다)', async () => {
    stubFetch({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: '카메라 점유 중(정밀수집)', data: { who: '정밀수집' } } });
    const client = await connect();
    const res = await client.callTool({ name: 'setting_rpc', arguments: { method: 'center.start' } });
    const out = payloadOf(res);
    expect(out.ok).toBe(false);
    expect((out.detail as { code: number }).code).toBe(-32001);
    expect((out.detail as { data: { who: string } }).data.who).toBe('정밀수집');
    await client.close();
  });

  it('서버 미기동(연결 실패)이어도 크래시하지 않고 ok:false 를 돌려준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const client = await connect();
    const res = await client.callTool({ name: 'setting_rpc', arguments: { method: 'slot.list' } });
    const out = payloadOf(res);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('ECONNREFUSED');
    await client.close();
  });
});

describe('setting_rpc_catalog', () => {
  const catalog = {
    methods: [
      { name: 'slot.list', mutating: false, destructive: false, available: true },
      { name: 'place.space.add', mutating: true, destructive: false, available: true },
      { name: 'slot.roi.load', mutating: true, destructive: true, available: true },
    ],
    unity: ['unity.cam.list', 'unity.preset.list'],
    issues: [],
  };

  it('전체 목록을 돌려준다', async () => {
    stubFetch(catalog);
    const client = await connect();
    const out = payloadOf(await client.callTool({ name: 'setting_rpc_catalog', arguments: {} }));
    expect(out.ok).toBe(true);
    expect(out.count).toBe(3);
    expect(out.unityCount).toBe(2);
    await client.close();
  });

  it('filter 로 걸러내고 원본 개수를 함께 알려준다', async () => {
    stubFetch(catalog);
    const client = await connect();
    const out = payloadOf(await client.callTool({ name: 'setting_rpc_catalog', arguments: { filter: 'slot' } }));
    expect((out.methods as Array<{ name: string }>).map((m) => m.name)).toEqual(['slot.list', 'slot.roi.load']);
    expect(out.totalBeforeFilter).toBe(3);
    expect(out.unity).toEqual([]); // unity 쪽에는 'slot' 이 없다
    await client.close();
  });

  it('GET /rpc/catalog 를 부른다', async () => {
    const calls = stubFetch(catalog);
    const client = await connect();
    await client.callTool({ name: 'setting_rpc_catalog', arguments: {} });
    expect(calls[0].url).toMatch(/\/rpc\/catalog$/);
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    await client.close();
  });
});

describe('CRpcClient 헤더 주입(하위호환)', () => {
  it('headers 지정 시 callRpc 요청에 실린다', async () => {
    const calls = stubFetch({ jsonrpc: '2.0', id: 1, result: {} });
    const c = new CRpcClient({ baseUrl: 'http://x', timeoutMs: 100, headers: { 'x-viewer-token': 'secret' } });
    await c.callRpc('m', {});
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-viewer-token']).toBe('secret');
    expect(h['content-type']).toBe('application/json'); // 기존 헤더 유지
  });

  it('headers 지정 시 getCatalog 요청에도 실린다', async () => {
    const calls = stubFetch({ methods: [] });
    const c = new CRpcClient({ baseUrl: 'http://x', timeoutMs: 100, headers: { 'x-viewer-token': 'secret' } });
    await c.getCatalog();
    expect((calls[0].init.headers as Record<string, string>)['x-viewer-token']).toBe('secret');
  });

  it('headers 미지정이면 기존 동작 그대로(Unity 호출자 무영향)', async () => {
    const calls = stubFetch({ jsonrpc: '2.0', id: 1, result: {} });
    const c = new CRpcClient({ baseUrl: 'http://x', timeoutMs: 100 });
    await c.callRpc('m', {});
    expect(Object.keys(calls[0].init.headers as Record<string, string>)).toEqual(['content-type']);
  });
});

describe('MCP 진입점 경로 정합(설정 ↔ 실제 빌드 산출물)', () => {
  it('llm.config 의 args 경로가 tsconfig 산출 경로와 일치한다', () => {
    // ★ 실사고: 설정이 `dist/mcp/server.js` 를 가리켰는데 tsconfig 는 rootDir:"." 이라
    //   실제 산출물은 `dist/src/mcp/server.js` 였다 → 빌드해도 MCP 가 뜨지 않는다.
    const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8').replace(/\/\/.*$/gm, '')) as {
      compilerOptions: { outDir: string; rootDir: string };
    };
    const { outDir, rootDir } = tsconfig.compilerOptions;
    const srcPath = 'src/mcp/server.ts';
    const rel = rootDir === '.' ? srcPath : srcPath.replace(`${rootDir}/`, '');
    const expected = `${outDir}/${rel}`.replace(/\.ts$/, '.js');

    for (const file of ['config/llm.config.json', 'config/llm.config.example.json']) {
      if (!existsSync(file)) continue;
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as {
        mcp?: { servers?: Array<{ command: string; args: string[] }> };
      };
      for (const s of cfg.mcp?.servers ?? []) {
        if (s.command !== 'node') continue;
        expect(`${file}: ${s.args[0]}`).toBe(`${file}: ${expected}`);
      }
    }
  });
});
