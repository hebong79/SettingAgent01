import { describe, it, expect, beforeEach } from 'vitest';
import {
  PACKET_WINDOW_MS,
  PacketAggregator,
  type PacketEmit,
  type PacketEntry,
  type PacketSummary,
} from '../src/util/packetAggregator.js';

/**
 * 통신 패킷 집계기(순수 모듈) 단위 테스트.
 * 시각(now)·방출(emit)을 주입하므로 타이머·로거 없이 결정적으로 검증한다.
 */

type Emitted =
  | { kind: 'packet'; entry: PacketEntry; failed: boolean }
  | { kind: 'summary'; sum: PacketSummary };

let out: Emitted[];
let clock: number;

const emit: PacketEmit = (event) => {
  out.push(event as Emitted);
};
const now = () => clock;

/** 기본 진입값 — 성공 GET /rpc. */
function entry(over: Partial<PacketEntry> = {}): PacketEntry {
  return { method: 'POST', url: 'http://127.0.0.1:13110/rpc', status: 200, ms: 40, msgBase: '통신 패킷', ...over };
}

function make(windowMs = 300_000): PacketAggregator {
  return new PacketAggregator({ windowMs, now, emit });
}

const packets = () => out.filter((e): e is Extract<Emitted, { kind: 'packet' }> => e.kind === 'packet');
const summaries = () => out.filter((e): e is Extract<Emitted, { kind: 'summary' }> => e.kind === 'summary');

beforeEach(() => {
  out = [];
  clock = 1_000_000;
});

describe('PacketAggregator', () => {
  it('(1) 새 키의 첫 record 는 즉시기록 1회(요약 없음)', () => {
    const agg = make();
    agg.record(entry({ op: 'cam.list' }));

    expect(out).toHaveLength(1);
    expect(packets()).toHaveLength(1);
    expect(packets()[0].entry.status).toBe(200);
    expect(packets()[0].failed).toBe(false);
  });

  it('(2) 창 안의 성공 반복 9회는 추가 방출 0회', () => {
    const agg = make();
    for (let i = 0; i < 10; i++) {
      agg.record(entry({ op: 'cam.list' }));
      clock += 30_000;
    }
    /* 마지막 record 시점(clock=1,000,000+270,000)까지는 창(300s) 미만 → 즉시기록 1건만 */
    expect(out).toHaveLength(1);
  });

  it('(3) 창 만료 후 record → 요약 1줄 + 즉시기록 1줄(순서: 요약 → 즉시)', () => {
    const agg = make();
    for (let i = 0; i < 10; i++) {
      agg.record(entry({ op: 'cam.list' }));
      clock += 30_000;
    }
    /* clock 은 이제 시작 + 300,000 → 창 만료 */
    agg.record(entry({ op: 'cam.list' }));

    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe('packet'); // 첫 즉시기록
    expect(out[1].kind).toBe('summary');
    expect(out[2].kind).toBe('packet');

    const sum = summaries()[0].sum;
    expect(sum.n).toBe(10);
    expect(sum.ok).toBe(10);
    expect(sum.err).toBe(0);
    expect(sum.win).toBeGreaterThanOrEqual(300_000);
    expect(sum.op).toBe('cam.list');
  });

  it('(4) 같은 URL·다른 op 는 키가 분리된다(각각 즉시기록·독립 창)', () => {
    const agg = make();
    agg.record(entry({ op: 'cam.list' }));
    agg.record(entry({ op: 'cam.captureJPG' }));
    agg.record(entry({ op: 'cam.list' }));
    agg.record(entry({ op: 'cam.captureJPG' }));

    expect(packets()).toHaveLength(2);
    expect(packets().map((p) => p.entry.op)).toEqual(['cam.list', 'cam.captureJPG']);
  });

  it('(5) 쿼리스트링은 키에서 제거된다(Map 무한증식 방지)', () => {
    const agg = make();
    const base = 'http://cam/cgi-bin/control/ptzf.cgi';
    agg.record(entry({ method: 'GET', url: `${base}?id=op&passwd=***&panpos=1` }));
    agg.record(entry({ method: 'GET', url: `${base}?id=op&passwd=***&panpos=2` }));
    agg.record(entry({ method: 'GET', url: `${base}?id=op&passwd=***&panpos=3` }));

    expect(packets()).toHaveLength(1); // 2·3번째는 같은 키로 집계

    clock += 300_000;
    agg.flushAll();
    const sum = summaries()[0].sum;
    expect(sum.n).toBe(3);
    expect(sum.url).toBe(base); // 요약 url 에도 쿼리 없음
    expect(sum.url).not.toContain('?');
  });

  it('(6) 실패(err)는 창 중에도 즉시기록되고 요약의 err·n 에 반영된다', () => {
    const agg = make();
    agg.record(entry({ op: 'cam.list' }));
    agg.record(entry({ op: 'cam.list', status: undefined, err: 'fetch failed' }));
    agg.record(entry({ op: 'cam.list' }));

    expect(packets()).toHaveLength(2);
    expect(packets()[1].failed).toBe(true);
    expect(packets()[1].entry.err).toBe('fetch failed');

    clock += 300_000;
    agg.flushAll();
    const sum = summaries()[0].sum;
    expect(sum.n).toBe(3);
    expect(sum.ok).toBe(2);
    expect(sum.err).toBe(1);
  });

  it('(7) 비-2xx(500)는 즉시기록되고 ok 는 증가하지 않는다', () => {
    const agg = make();
    agg.record(entry({ op: 'cam.list' }));
    agg.record(entry({ op: 'cam.list', status: 500 }));

    expect(packets()).toHaveLength(2);
    expect(packets()[1].failed).toBe(true);

    clock += 300_000;
    agg.flushAll();
    const sum = summaries()[0].sum;
    expect(sum.n).toBe(2);
    expect(sum.ok).toBe(1);
    expect(sum.err).toBe(1);
  });

  it('(8) 다른 키의 record 가 만료된 창을 sweep 한다(정체 방지)', () => {
    const agg = make();
    agg.record(entry({ op: 'A' }));
    agg.record(entry({ op: 'A' })); // 요약 대상이 되려면 n >= 2
    clock += 300_001;
    agg.record(entry({ op: 'B' }));

    /* B 의 즉시기록에 앞서 A 의 요약이 방출된다. */
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].sum.op).toBe('A');
  });

  it('(9) flushAll 은 미방출 창을 전부 요약하고 비운다(재호출 시 무방출)', () => {
    const agg = make();
    agg.record(entry({ op: 'A' }));
    agg.record(entry({ op: 'B' }));
    clock += 10_000;
    agg.record(entry({ op: 'A' }));
    agg.record(entry({ op: 'B' }));

    agg.flushAll();
    expect(summaries()).toHaveLength(2);
    expect(summaries().map((s) => s.sum.win)).toEqual([10_000, 10_000]);

    out = [];
    agg.flushAll();
    expect(out).toHaveLength(0);
  });

  it('(10) windowMs <= 0 이면 집계 비활성 — 매 record 즉시기록', () => {
    const agg = make(0);
    for (let i = 0; i < 5; i++) agg.record(entry({ op: 'cam.list' }));

    expect(packets()).toHaveLength(5);
    expect(summaries()).toHaveLength(0);

    agg.flushAll();
    expect(out).toHaveLength(5);
  });

  it('(11) msAvg 는 정수 반올림, msMax 는 최대값, win 은 실측 경과', () => {
    const agg = make();
    agg.record(entry({ op: 'cam.list', ms: 10 }));
    agg.record(entry({ op: 'cam.list', ms: 11 }));
    agg.record(entry({ op: 'cam.list', ms: 76 }));
    clock += 123_456;
    agg.flushAll();

    const sum = summaries()[0].sum;
    expect(sum.msAvg).toBe(Math.round((10 + 11 + 76) / 3)); // 32
    expect(sum.msMax).toBe(76);
    expect(sum.win).toBe(123_456);
  });

  it('(12) 요약 한 줄만으로 초당 건수(rate)가 복원된다', () => {
    const agg = make();
    for (let i = 0; i < 10; i++) {
      agg.record(entry({ op: 'cam.list' }));
      clock += 30_000;
    }
    agg.record(entry({ op: 'cam.list' })); // 창 만료 → 요약 방출

    const sum = summaries()[0].sum;
    const rate = (sum.n / sum.win) * 1000;
    expect(rate).toBeCloseTo(0.0333, 4);
  });

  it('(13) span 은 마지막 기록까지의 실측 활성 구간이다(침묵은 win 에만 반영)', () => {
    const agg = make();
    /* 30초 폴 10건 → 활성 구간 270초, 이후 45분 침묵 뒤 재개 시점에 sweep */
    for (let i = 0; i < 10; i++) {
      agg.record(entry({ op: 'X' }));
      clock += 30_000;
    }
    clock += 2_700_000 - 30_000; // 마지막 기록으로부터 45분 경과
    agg.record(entry({ op: 'X' }));

    const sum = summaries()[0].sum;
    expect(sum.n).toBe(10);
    expect(sum.span).toBe(270_000);          // 실측 활성 구간
    expect(sum.win).toBe(2_970_000);         // 침묵 포함 창 총 길이
    expect(sum.win - sum.span).toBe(2_700_000); // 침묵량이 그대로 드러난다

    /* 활성 rate 는 실제 케이던스(0.0333/s)를 복원하고, 창 평균은 희석돼 있다. */
    expect(((sum.n - 1) / sum.span) * 1000).toBeCloseTo(0.0333, 4);
    expect((sum.n / sum.win) * 1000).toBeLessThan(0.0035);
  });

  it('(13-2) 침묵 없이 창이 만료되면 span 은 창 길이에 수렴한다', () => {
    const agg = make();
    for (let i = 0; i < 11; i++) {
      agg.record(entry({ op: 'X' }));
      clock += 30_000;
    }
    /* 10번째까지가 한 창(0~270s), 11번째(300s)가 sweep 을 돌린다 */
    const sum = summaries()[0].sum;
    expect(sum.win).toBe(300_000);
    expect(sum.span).toBe(270_000);
  });

  it('(14) n=1 창은 요약을 방출하지 않는다(저빈도 키 로그 2배 방지)', () => {
    const agg = make();
    agg.record(entry({ op: 'rare' }));  // 즉시 1
    clock += 600_000;
    agg.record(entry({ op: 'rare' }));  // 만료됐지만 n=1 → 요약 없음, 즉시 1
    clock += 600_000;
    agg.record(entry({ op: 'rare' }));  // 동일

    expect(packets()).toHaveLength(3);
    expect(summaries()).toHaveLength(0);
    expect(out).toHaveLength(3); // 호출 3회 = 로그 3줄(도입 전과 동일)
  });

  it('(14-2) n=2 부터는 요약을 방출한다(경계)', () => {
    const agg = make();
    agg.record(entry({ op: 'rare' }));
    clock += 1_000;
    agg.record(entry({ op: 'rare' })); // n=2
    clock += 600_000;
    agg.record(entry({ op: 'rare' }));

    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].sum.n).toBe(2);
    expect(summaries()[0].sum.span).toBe(1_000);
  });

  it('(14-3) flushAll 도 n=1 창은 방출하지 않는다', () => {
    const agg = make();
    agg.record(entry({ op: 'A' }));           // n=1
    agg.record(entry({ op: 'B' }));
    agg.record(entry({ op: 'B' }));           // n=2
    clock += 5_000;
    agg.flushAll();

    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].sum.op).toBe('B');
  });

  it('창 길이 상수는 5분이다', () => {
    expect(PACKET_WINDOW_MS).toBe(300_000);
  });
});
