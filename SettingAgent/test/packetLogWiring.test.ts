import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fetchWithTimeout } from '../src/util/http.js';
import { configurePacketLog } from '../src/util/packetLog.js';
import { CRpcClient } from '../src/clients/CRpcClient.js';
import { HucomsClient } from '../src/clients/hucoms/index.js';
import { logger } from '../src/util/logger.js';

/**
 * 통신 패킷 로그 결선 테스트 — logger 스파이로 실제 방출 줄을 검증한다.
 * VITEST 기본은 집계 OFF(창 0)이므로, 요약 경로는 configurePacketLog 로 창·시각을 주입해 켠다.
 */

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

/** 스파이가 잡은 (fields, msg) 쌍 목록. */
function calls(spy: typeof info): { fields: Record<string, unknown>; msg: string }[] {
  return spy.mock.calls.map((call) => ({
    fields: call[0] as Record<string, unknown>,
    msg: call[1] as string,
  }));
}

const packetCalls = (spy: typeof info) => calls(spy).filter((c) => (c.fields as { cat?: string }).cat === 'packet');

beforeEach(() => {
  info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configurePacketLog(); // 기본(VITEST=집계 OFF)으로 복원
});

describe('fetchWithTimeout 결선', () => {
  it('(13) 성공 → logger.info 로 기존 필드(method/url/status/ms) 그대로 1회', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await fetchWithTimeout('http://127.0.0.1:9/x', { method: 'GET' }, 1000);

    const c = packetCalls(info);
    expect(c).toHaveLength(1);
    expect(c[0].msg).toBe('통신 패킷');
    expect(c[0].fields.method).toBe('GET');
    expect(c[0].fields.url).toBe('http://127.0.0.1:9/x');
    expect(c[0].fields.status).toBe(200);
    expect(typeof c[0].fields.ms).toBe('number');
    expect(c[0].fields.win).toBeUndefined();
  });

  it('(14) 실패 → logger.warn(통신 패킷 실패) + 예외 재던짐', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));

    await expect(fetchWithTimeout('http://127.0.0.1:9/x', { method: 'GET' }, 1000)).rejects.toThrow('fetch failed');

    const c = packetCalls(warn);
    expect(c).toHaveLength(1);
    expect(c[0].msg).toBe('통신 패킷 실패');
    expect(c[0].fields.err).toBe('fetch failed');
  });

  it('(15) 집계 ON → 즉시 → (무음) → 요약 → 즉시 순으로 방출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    let clock = 1_000_000;
    configurePacketLog({ windowMs: 60_000, now: () => clock });

    await fetchWithTimeout('http://127.0.0.1:9/x', { method: 'GET' }, 1000); // 즉시
    clock += 10_000;
    await fetchWithTimeout('http://127.0.0.1:9/x', { method: 'GET' }, 1000); // 무음(집계)
    expect(packetCalls(info)).toHaveLength(1);

    clock += 60_000;
    await fetchWithTimeout('http://127.0.0.1:9/x', { method: 'GET' }, 1000); // 요약 + 즉시

    const c = packetCalls(info);
    expect(c).toHaveLength(3);
    expect(c[1].msg).toBe('통신 패킷 요약');
    expect(c[1].fields.win).toBe(70_000);
    expect(c[1].fields.span).toBe(10_000); // 실측 활성 구간(침묵 60초는 win 에만)
    expect(c[1].fields.n).toBe(2);
    expect(c[1].fields.ok).toBe(2);
    expect(c[1].fields.err).toBe(0);
    expect(c[2].msg).toBe('통신 패킷');
  });
});

describe('CRpcClient 결선', () => {
  it('(16) RPC 메서드가 op 로 실리고 메서드별로 키가 분리된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 })));
    let clock = 1_000_000;
    configurePacketLog({ windowMs: 60_000, now: () => clock });

    const client = new CRpcClient({ baseUrl: 'http://127.0.0.1:13110', timeoutMs: 1000 });
    await client.callRpc('cam.list');
    await client.callRpc('cam.captureJPG');
    await client.callRpc('cam.list'); // 같은 키 → 무음

    const c = packetCalls(info);
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.fields.op)).toEqual(['cam.list', 'cam.captureJPG']);
  });

  it('(16-2) getCatalog 의 op 는 catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ methods: [] }), { status: 200 })));

    await new CRpcClient({ baseUrl: 'http://127.0.0.1:13110', timeoutMs: 1000 }).getCatalog();

    expect(packetCalls(info)[0].fields.op).toBe('catalog');
  });
});

describe('HucomsClient 결선', () => {
  it('(17) op 에 action 이 실리고 url 의 passwd 마스킹이 유지된다', async () => {
    const client = new HucomsClient({
      baseUrl: 'http://camera.local',
      username: 'operator',
      password: 'plain-secret',
      fetchImpl: (async () => new Response('[Result]\nok = yes\n', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    });

    await client.getMac();

    const c = packetCalls(info);
    expect(c).toHaveLength(1);
    expect(c[0].msg).toBe('Hucoms 통신 패킷');
    expect(c[0].fields.op).toBe('getmac');
    expect(String(c[0].fields.url)).toContain('passwd=***');
    expect(String(c[0].fields.url)).not.toContain('plain-secret');
  });
});

describe('테스트 기본 모드', () => {
  it('(18) configurePacketLog 미호출 시 같은 URL 반복도 매번 기록된다(집계 OFF)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    for (let i = 0; i < 3; i++) await fetchWithTimeout('http://127.0.0.1:9/y', { method: 'GET' }, 1000);

    expect(packetCalls(info)).toHaveLength(3);
    expect(packetCalls(info).every((c) => c.fields.win === undefined)).toBe(true);
  });
});
