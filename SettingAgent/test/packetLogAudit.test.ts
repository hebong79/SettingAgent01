import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { PacketAggregator, type PacketEmit, type PacketEntry, type PacketSummary } from '../src/util/packetAggregator.js';
import { fetchWithTimeout } from '../src/util/http.js';
import { configurePacketLog, flushPacketLog } from '../src/util/packetLog.js';
import { CRpcClient } from '../src/clients/CRpcClient.js';
import { HucomsClient } from '../src/clients/hucoms/index.js';
import { logger } from '../src/util/logger.js';

/**
 * QA 독립 검증 — 구현자 테스트(packetAggregator/packetLogWiring)의 커버리지 구멍 보강.
 * 정책(첫 발생 즉시기록 / 실패 무집계 / rate 복원 / sweep 플러시 / 마스킹)을 경계면에서 재확인한다.
 */

type Emitted =
  | { kind: 'packet'; entry: PacketEntry; failed: boolean }
  | { kind: 'summary'; sum: PacketSummary };

let out: Emitted[];
let clock: number;
const emit: PacketEmit = (e) => { out.push(e as Emitted); };
const now = () => clock;

function entry(over: Partial<PacketEntry> = {}): PacketEntry {
  return { method: 'POST', url: 'http://127.0.0.1:13110/rpc', status: 200, ms: 40, msgBase: '통신 패킷', ...over };
}
const packets = () => out.filter((e): e is Extract<Emitted, { kind: 'packet' }> => e.kind === 'packet');
const summaries = () => out.filter((e): e is Extract<Emitted, { kind: 'summary' }> => e.kind === 'summary');

describe('QA audit — 순수 집계기 보강', () => {
  beforeEach(() => { out = []; clock = 1_000_000; });

  it('A1 쿼리 500종이 와도 창은 1개다(Map 무한증식 회귀 — 요약 개수로 카디널리티 측정)', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    const base = 'http://camera.local/cgi-bin/control/ptzf_status.cgi';
    for (let i = 0; i < 500; i++) {
      agg.record(entry({ method: 'GET', url: `${base}?id=op&passwd=***&action=goptzfpos&panpos=${i}` , op: 'goptzfpos' }));
    }
    expect(packets()).toHaveLength(1);

    clock += 300_000;
    agg.flushAll();
    /* 요약 1건 = 활성 키가 정확히 1개였다는 증거(Map 무한증식 없음). */
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].sum.n).toBe(500);
    expect(summaries()[0].sum.url).toBe(base);
  });

  it('A2 op 없음과 op 있음은 다른 키다', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    agg.record(entry({ op: undefined }));
    agg.record(entry({ op: 'cam.list' }));
    agg.record(entry({ op: undefined }));
    agg.record(entry({ op: 'cam.list' }));
    expect(packets()).toHaveLength(2);
    expect(packets().map((p) => p.entry.op)).toEqual([undefined, 'cam.list']);
  });

  it('A3 창 경계 — 정확히 windowMs 경과는 만료, windowMs-1 은 미만료', () => {
    const a = new PacketAggregator({ windowMs: 300_000, now, emit });
    a.record(entry({ op: 'X' }));
    clock += 299_999;
    a.record(entry({ op: 'X' }));
    expect(summaries()).toHaveLength(0);

    out = []; clock = 1_000_000;
    const b = new PacketAggregator({ windowMs: 300_000, now, emit });
    b.record(entry({ op: 'X' }));
    clock += 1_000;
    b.record(entry({ op: 'X' })); // n>=2 여야 요약이 나간다
    clock += 299_000;
    b.record(entry({ op: 'X' }));
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].sum.win).toBe(300_000);
  });

  it('A4 첫 record 가 실패여도 즉시기록 + 창 개설, 이후 성공은 무음', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    agg.record(entry({ op: 'X', status: undefined, err: 'ECONNREFUSED' }));
    agg.record(entry({ op: 'X' }));
    agg.record(entry({ op: 'X' }));
    expect(packets()).toHaveLength(1);
    expect(packets()[0].failed).toBe(true);

    clock += 300_000;
    agg.flushAll();
    expect(summaries()[0].sum).toMatchObject({ n: 3, ok: 2, err: 1 });
  });

  it('A5 창 안의 실패는 몇 건이든 전부 즉시기록(집계로 숨기지 않음)', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    agg.record(entry({ op: 'X' }));
    for (let i = 0; i < 20; i++) agg.record(entry({ op: 'X', status: 500 }));
    expect(packets()).toHaveLength(21);
    expect(packets().slice(1).every((p) => p.failed)).toBe(true);
  });

  it('A6 만료된 창이 여러 개면 record 1회가 전부 sweep 한다', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    for (const op of ['A', 'B', 'C']) {
      agg.record(entry({ op }));
      agg.record(entry({ op })); // n>=2 여야 요약 대상
    }
    clock += 300_001;
    out = [];
    agg.record(entry({ op: 'D' }));
    expect(summaries().map((s) => s.sum.op).sort()).toEqual(['A', 'B', 'C']);
    expect(packets()).toHaveLength(1); // D 즉시기록
  });

  it('A7 [L2 보정] sweep 이 지연돼 win 은 부풀어도 span 으로 실제 케이던스를 복원한다', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    /* 30초 폴 10건(실제 케이던스 0.0333/s) */
    for (let i = 0; i < 10; i++) { agg.record(entry({ op: 'X' })); clock += 30_000; }
    /* 이후 모든 트래픽이 45분간 멈췄다가 재개 → 그때서야 sweep */
    clock += 2_700_000;
    agg.record(entry({ op: 'X' }));
    const sum = summaries()[0].sum;
    expect(sum.n).toBe(10);
    expect(sum.win).toBe(3_000_000);
    expect((sum.n / sum.win) * 1000).toBeCloseTo(0.00333, 5); // 창 평균은 침묵으로 희석된다
    /* span 은 활성 구간만 재므로 활성 rate 가 실제 케이던스와 일치한다. */
    expect(sum.span).toBe(270_000);
    expect(((sum.n - 1) / sum.span) * 1000).toBeCloseTo(0.0333, 4);
    expect(sum.win - sum.span).toBe(2_730_000); // 침묵량이 드러난다
  });

  it('A8 [L1 보정] 창당 1건뿐인 저빈도 키는 요약이 붙지 않아 호출당 1줄을 유지한다', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    agg.record(entry({ op: 'rare' }));   // 즉시 1
    clock += 600_000;                    // 10분 뒤 다음 호출
    agg.record(entry({ op: 'rare' }));   // n=1 창 → 요약 없음, 즉시 1
    clock += 600_000;
    agg.record(entry({ op: 'rare' }));   // 동일
    expect(packets()).toHaveLength(3);
    expect(summaries()).toHaveLength(0);
    /* 호출 3회에 로그 3줄 — 도입 전과 동일. */
    expect(out).toHaveLength(3);
  });

  it('A9 [경미] URL 프래그먼트는 제거되지 않아 op 키와 형식상 충돌할 수 있다', () => {
    const agg = new PacketAggregator({ windowMs: 300_000, now, emit });
    agg.record(entry({ method: 'GET', url: 'http://h/x#a', op: undefined }));
    agg.record(entry({ method: 'GET', url: 'http://h/x', op: 'a' }));
    /* 같은 키로 합쳐진다(즉시기록이 1건뿐) — 실사용 URL 에 프래그먼트가 없어 실동 영향은 없다. */
    expect(packets()).toHaveLength(1);
  });
});

/* ------------------------------ 결선 / 실전 경계 ------------------------------ */

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const rows = (spy: typeof info) =>
  spy.mock.calls
    .map((c) => ({ fields: c[0] as Record<string, unknown>, msg: c[1] as string }))
    .filter((r) => (r.fields as { cat?: string }).cat === 'packet');
const allCallsText = () => JSON.stringify([...info.mock.calls, ...warn.mock.calls]);

describe('QA audit — 결선 경계면', () => {
  beforeEach(() => {
    info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configurePacketLog();
  });

  it('B1 Hucoms 좌표 50회(집계 ON) → 즉시 1 + 요약 1, 요약 url 에 쿼리 없음, passwd 어디에도 없음', async () => {
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });
    const client = new HucomsClient({
      baseUrl: 'http://camera.local',
      username: 'operator',
      password: 'plain-secret',
      fetchImpl: (async () => new Response('[Result]\nok = yes\n', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
    });

    for (let i = 0; i < 50; i++) {
      await client.goPtzfPosition({ pan: i * 100, tilt: 100 + i, zoom: 1000 + i });
      t += 2_000;
    }
    expect(rows(info)).toHaveLength(1);          // 즉시기록 1줄뿐
    t += 300_000;
    flushPacketLog();

    const r = rows(info);
    expect(r).toHaveLength(2);
    expect(r[1].msg).toBe('Hucoms 통신 패킷 요약');
    expect(r[1].fields.op).toBe('goptzfpos');
    expect(r[1].fields.n).toBe(50);
    expect(String(r[1].fields.url)).toBe('http://camera.local/cgi-bin/control/ptzf_status.cgi');
    expect(String(r[1].fields.url)).not.toContain('?');
    /* 마스킹 회귀 — 요약·즉시 어느 줄에도 평문 비밀번호가 없다. */
    expect(allCallsText()).not.toContain('plain-secret');
    expect(String(r[0].fields.url)).toContain('passwd=***');
  });

  it('B2 Hucoms transport 실패는 warn 즉시기록이고 err 메시지의 비밀번호도 마스킹된다', async () => {
    const client = new HucomsClient({
      baseUrl: 'http://camera.local',
      username: 'operator',
      password: 'plain-secret',
      fetchImpl: (async () => { throw new Error('connect ECONNREFUSED (passwd=plain-secret)'); }) as unknown as typeof fetch,
    });
    await expect(client.getMac()).rejects.toThrow();

    const r = rows(warn);
    expect(r).toHaveLength(1);
    expect(r[0].msg).toBe('Hucoms 통신 패킷 실패');
    expect(String(r[0].fields.err)).toContain('***');
    expect(allCallsText()).not.toContain('plain-secret');
  });

  it('B3 비-2xx 는 warn 승격(메시지는 그대로) + 집계 ON 에서도 매번 즉시기록', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });

    for (let i = 0; i < 4; i++) { await fetchWithTimeout('http://127.0.0.1:9/z', { method: 'GET' }, 1000); t += 1_000; }

    const r = rows(warn);
    expect(r).toHaveLength(4);                 // 실패는 집계로 숨기지 않는다
    expect(r[0].msg).toBe('통신 패킷');          // '실패' 는 예외 전용
    expect(r[0].fields.status).toBe(500);
    expect(r[0].fields.err).toBeUndefined();
    expect(rows(info)).toHaveLength(0);
  });

  it('B4 flushPacketLog 는 미방출 창을 logger 로 내보내고 재호출 시 무방출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });

    await fetchWithTimeout('http://127.0.0.1:9/f', { method: 'GET' }, 1000);
    t += 30_000;
    await fetchWithTimeout('http://127.0.0.1:9/f', { method: 'GET' }, 1000);
    expect(rows(info)).toHaveLength(1);

    flushPacketLog();
    const r = rows(info);
    expect(r).toHaveLength(2);
    expect(r[1].msg).toBe('통신 패킷 요약');
    expect(r[1].fields.n).toBe(2);
    expect(r[1].fields.win).toBe(30_000);

    flushPacketLog();
    expect(rows(info)).toHaveLength(2);
  });

  it('B5 다른 키의 트래픽이 정체된 창을 방출한다(결선 경로)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });

    await fetchWithTimeout('http://127.0.0.1:9/a', { method: 'GET' }, 1000);
    t += 1_000;
    await fetchWithTimeout('http://127.0.0.1:9/a', { method: 'GET' }, 1000); // n>=2 여야 요약이 나간다
    t += 300_001;
    await fetchWithTimeout('http://127.0.0.1:9/b', { method: 'GET' }, 1000);

    const r = rows(info);
    expect(r.map((x) => x.msg)).toEqual(['통신 패킷', '통신 패킷 요약', '통신 패킷']);
    expect(String(r[1].fields.url)).toBe('http://127.0.0.1:9/a');
  });

  it('B6 요약 1줄만으로 케이던스가 복원된다(2초 폴 → 0.5/s)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });

    for (let i = 0; i < 150; i++) { await fetchWithTimeout('http://127.0.0.1:9/poll', { method: 'GET' }, 1000); t += 2_000; }
    await fetchWithTimeout('http://127.0.0.1:9/poll', { method: 'GET' }, 1000); // 창 만료 → 요약

    const s = rows(info).find((x) => x.msg === '통신 패킷 요약')!;
    const rate = ((s.fields.n as number) / (s.fields.win as number)) * 1000;
    expect(rate).toBeCloseTo(0.5, 6);
    expect(s.fields.n).toBe(150);
    expect(s.fields.win).toBe(300_000);
  });

  it('B7 같은 RPC 메서드의 params 가 달라도 1개 키로 집계된다(캡처 루프 회귀)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 })));
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });

    const c = new CRpcClient({ baseUrl: 'http://127.0.0.1:13110', timeoutMs: 1000 });
    for (let i = 0; i < 12; i++) { await c.callRpc('cam.captureJPG', { cam: i, preset: i }); t += 1_000; }

    expect(rows(info)).toHaveLength(1);
    expect(rows(info)[0].fields.op).toBe('cam.captureJPG');
  });

  it('B8 요약 줄의 필드 집합이 계약과 일치하고 즉시 줄과 구분된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    let t = 1_000_000;
    configurePacketLog({ windowMs: 300_000, now: () => t });

    await fetchWithTimeout('http://127.0.0.1:9/s', { method: 'GET' }, 1000, 'cam.list');
    t += 1_000;
    await fetchWithTimeout('http://127.0.0.1:9/s', { method: 'GET' }, 1000, 'cam.list');
    t += 300_001;
    await fetchWithTimeout('http://127.0.0.1:9/s', { method: 'GET' }, 1000, 'cam.list');

    const r = rows(info);
    const immediate = r[0].fields;
    const summary = r[1].fields;
    expect(Object.keys(immediate).sort()).toEqual(['cat', 'method', 'ms', 'op', 'status', 'url']);
    expect(Object.keys(summary).sort()).toEqual(['cat', 'err', 'method', 'msAvg', 'msMax', 'n', 'ok', 'op', 'span', 'url', 'win']);
    expect(summary.status).toBeUndefined();
    expect(immediate.win).toBeUndefined();
  });
});
