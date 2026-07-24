import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nextStreamRetryDelay, streamRetryLabel, moveRenderDirective, createSnapshotFetcher } from '../web/core.js';

/**
 * 검증자(qa-tester): "3fps 스냅샷 폴링 폴백 제거 + 스트림 자동 재시도"
 * 근거: `_workspace/01_architect_plan.md` §5 검증 계획(A1~E20) / `_workspace/02_developer_changes.md`.
 *
 * 구성:
 *  - A/B: 순수 백오프 함수(`nextStreamRetryDelay`/`streamRetryLabel`) 계약.
 *  - C:   `moveRenderDirective` 축소된 계약('off'|'stream').
 *  - D:   `createSnapshotFetcher` — 1회 취득기 동작 + **자발 폴링 부재**(타이머 소멸 회귀).
 *  - E:   소스텍스트 회귀 + app.js 라이브 섹션을 **실제 배포 바이트 그대로** `new Function` 으로 실행하는
 *         결선 동작 검증(dbCenteringOverlay.test.ts 의 functionSource 관용구 확장).
 *         → 테스트가 app.js 코드를 복사하지 않는다. 추출 실패 시 테스트가 깨진다(위장 불가).
 */

const webUrl = (name: string) => fileURLToPath(new URL(`../web/${name}`, import.meta.url));
const appSrc = readFileSync(webUrl('app.js'), 'utf-8');
const coreSrc = readFileSync(webUrl('core.js'), 'utf-8');
const htmlSrc = readFileSync(webUrl('index.html'), 'utf-8');
const dtsSrc = readFileSync(webUrl('core.d.ts'), 'utf-8');

// --- A. nextStreamRetryDelay ------------------------------------------------

describe('A. nextStreamRetryDelay — 지수 백오프 수열(1s → ×2 → 30s 클램프)', () => {
  it('A1. 첫 실패(0/undefined/null/NaN/음수/비수치) → 1000ms', () => {
    expect(nextStreamRetryDelay(0)).toBe(1000);
    expect(nextStreamRetryDelay(undefined)).toBe(1000);
    expect(nextStreamRetryDelay(null)).toBe(1000);
    expect(nextStreamRetryDelay(Number.NaN)).toBe(1000);
    expect(nextStreamRetryDelay(-5000)).toBe(1000);
    expect(nextStreamRetryDelay(Number.NEGATIVE_INFINITY)).toBe(1000);
    expect(nextStreamRetryDelay(Number.POSITIVE_INFINITY)).toBe(1000); // 비유한 → 초기값
    expect(nextStreamRetryDelay('abc' as unknown as number)).toBe(1000);
    expect(nextStreamRetryDelay({} as unknown as number)).toBe(1000);
  });

  it('A2. 정상 증가: 1000→2000→4000→8000→16000', () => {
    expect(nextStreamRetryDelay(1000)).toBe(2000);
    expect(nextStreamRetryDelay(2000)).toBe(4000);
    expect(nextStreamRetryDelay(4000)).toBe(8000);
    expect(nextStreamRetryDelay(8000)).toBe(16000);
  });

  it('A3. 상한 클램프: 16000→30000(32000 아님), 30000→30000 반복 멱등', () => {
    expect(nextStreamRetryDelay(16000)).toBe(30000);
    let d = 30000;
    for (let i = 0; i < 5; i++) d = nextStreamRetryDelay(d);
    expect(d).toBe(30000);
    expect(nextStreamRetryDelay(999999)).toBe(30000); // 상한 초과 입력도 클램프
  });

  it('A4. 8회 누적 수열 = [1000,2000,4000,8000,16000,30000,30000,30000]', () => {
    const seq: number[] = [];
    let d = 0;
    for (let i = 0; i < 8; i++) {
      d = nextStreamRetryDelay(d);
      seq.push(d);
    }
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("A5. 수치형 문자열은 Number 강제변환 계약('1000' → 2000)", () => {
    expect(nextStreamRetryDelay('1000' as unknown as number)).toBe(2000);
  });
});

// --- B. streamRetryLabel ----------------------------------------------------

const CAP_NOTICE = '서버/카메라 상태를 확인하세요';

describe('B. streamRetryLabel — 상한 미도달/도달 문구 분기', () => {
  it('B5. (1, 1000) → "1초"·"1회째" 포함, 상한 안내 미포함', () => {
    const s = streamRetryLabel(1, 1000);
    expect(s).toContain('1초');
    expect(s).toContain('1회째');
    expect(s).toContain('스트림 끊김');
    expect(s).not.toContain(CAP_NOTICE);
  });

  it('B6. (6, 30000) → "30초"·"6회째" + 상한 안내 포함', () => {
    const s = streamRetryLabel(6, 30000);
    expect(s).toContain('30초');
    expect(s).toContain('6회째');
    expect(s).toContain(CAP_NOTICE);
  });

  it('B7. 경계: 16000(상한 직전)은 안내 없음 / 30000 이상은 안내 있음', () => {
    expect(streamRetryLabel(5, 16000)).not.toContain(CAP_NOTICE);
    expect(streamRetryLabel(7, 30000)).toContain(CAP_NOTICE);
    expect(streamRetryLabel(9, 45000)).toContain(CAP_NOTICE);
  });

  it('B8. 초 표기는 반올림(1500ms → 2초)', () => {
    expect(streamRetryLabel(2, 1500)).toContain('2초');
  });
});

// --- C. moveRenderDirective -------------------------------------------------

describe("C. moveRenderDirective — 계약 축소('off' | 'stream')", () => {
  it("C7. 'stream' → 'stream-reconnect'", () => {
    expect(moveRenderDirective('stream')).toBe('stream-reconnect');
  });

  it("C8. 'off' → 'tick'", () => {
    expect(moveRenderDirective('off')).toBe('tick');
  });

  it("C9. core.d.ts 의 인자 union 에 'poll' 이 남아있지 않다", () => {
    const decl = dtsSrc.slice(dtsSrc.indexOf('export function moveRenderDirective'));
    expect(decl.slice(0, 200)).not.toContain("'poll'");
  });
});

// --- D. createSnapshotFetcher ----------------------------------------------

function mkDeps() {
  const pending: Array<{ resolve: (v: unknown) => void }> = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const deps = {
    makeUrl: (seq: number) => `/snapshot?t=${seq}`,
    fetchFn: vi.fn((_url: string, _opt: { signal: AbortSignal }) => new Promise((resolve) => pending.push({ resolve }))),
    createObjectURL: vi.fn(() => {
      const u = `blob:${n++}`;
      created.push(u);
      return u;
    }),
    revokeObjectURL: vi.fn((u: string) => {
      revoked.push(u);
    }),
    setImage: vi.fn(),
    onPtz: vi.fn(),
  };
  const respond = () => pending.shift()?.resolve({ blob: async () => ({}), headers: { get: () => '7' } });
  return { deps, created, revoked, respond };
}

describe('D. createSnapshotFetcher — 1회 취득기(백프레셔·revoke·onPtz·abort) + 자발 폴링 부재', () => {
  it('D10. 백프레셔: inflight 중 tick 겹침 스킵(fetch 1회), 해소 후 재개', async () => {
    const { deps, respond } = mkDeps();
    const f = createSnapshotFetcher(deps as never);
    const t1 = f.tick();
    await f.tick(); // inflight 가드로 즉시 반환
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    respond();
    await t1;
    const t3 = f.tick();
    expect(deps.fetchFn).toHaveBeenCalledTimes(2);
    respond();
    await t3;
  });

  it('D11. 새 프레임 시 이전 Blob URL revoke, 첫 프레임은 revoke 없음', async () => {
    const { deps, revoked, respond } = mkDeps();
    const f = createSnapshotFetcher(deps as never);
    const a = f.tick();
    respond();
    await a;
    expect(revoked).toHaveLength(0);
    const b = f.tick();
    respond();
    await b;
    expect(revoked).toEqual(['blob:0']);
  });

  it('D12. onPtz 가 응답 헤더로 1회 호출', async () => {
    const { deps, respond } = mkDeps();
    const f = createSnapshotFetcher(deps as never);
    const a = f.tick();
    respond();
    await a;
    expect(deps.onPtz).toHaveBeenCalledTimes(1);
    expect(deps.onPtz.mock.calls[0][0]).toBeDefined();
  });

  it('D13. abort(): 진행 중 요청의 signal.aborted === true', () => {
    const { deps } = mkDeps();
    const f = createSnapshotFetcher(deps as never);
    void f.tick();
    f.abort();
    const signal = deps.fetchFn.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(true);
  });

  it('D14-a. 반환 객체는 { tick, abort } 뿐 — start 등 타이머 API 부재', () => {
    const { deps } = mkDeps();
    const f = createSnapshotFetcher(deps as never) as unknown as Record<string, unknown>;
    expect(f.start).toBeUndefined();
    expect(f.stop).toBeUndefined();
    expect(Object.keys(f).sort()).toEqual(['abort', 'tick']);
  });

  it('D14-b. 자발 폴링 없음: fake timer 로 60초 진행해도 fetch 추가 호출 0건', async () => {
    vi.useFakeTimers();
    try {
      const { deps, respond } = mkDeps();
      const f = createSnapshotFetcher(deps as never);
      // (1) 생성만 하고 시간 진행 → 요청 0건
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.fetchFn).toHaveBeenCalledTimes(0);
      // (2) 명시적 tick 1회 후 시간 진행 → 여전히 1건(자동 반복 없음)
      const t = f.tick();
      respond();
      await t;
      expect(deps.fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- E. 소스텍스트 회귀 ------------------------------------------------------

/** app.js 에서 함수 선언 전문(중괄호 균형)을 추출. 없으면 테스트 실패. */
function functionSource(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수가 app.js 에 존재해야 함`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 함수의 닫는 중괄호를 찾지 못함`);
}

/** app.js 의 라이브 스트림 섹션(선언 ~ 다음 섹션 주석) 텍스트. */
function liveSection(): string {
  const from = appSrc.indexOf('// --- 라이브 MJPEG 스트림');
  expect(from, '라이브 MJPEG 스트림 섹션 주석이 존재해야 함').toBeGreaterThan(-1);
  const to = appSrc.indexOf('// --- 제어 ---', from);
  expect(to, '제어 섹션 주석이 라이브 섹션 뒤에 존재해야 함').toBeGreaterThan(from);
  return appSrc.slice(from, to);
}

describe('E. 소스텍스트 회귀 — 폴링 폴백 잔재 부재 / 재시도 결선 존재', () => {
  it('E15. web/ 에 fallbackToPolling · loop.start( · fpsToInterval 문자열이 없다', () => {
    for (const [name, src] of [
      ['app.js', appSrc],
      ['core.js', coreSrc],
      ['core.d.ts', dtsSrc],
      ['index.html', htmlSrc],
    ] as const) {
      expect(src, `${name}: fallbackToPolling 잔재`).not.toContain('fallbackToPolling');
      expect(src, `${name}: loop.start( 잔재`).not.toContain('loop.start(');
      expect(src, `${name}: fpsToInterval 잔재`).not.toContain('fpsToInterval');
      expect(src, `${name}: createStreamLoop 잔재`).not.toContain('createStreamLoop');
    }
  });

  it("E16. web/ 에 'poll' 리터럴(liveMode 상태)이 없다", () => {
    expect(appSrc).not.toContain("'poll'");
    expect(coreSrc).not.toContain("'poll'");
    expect(dtsSrc).not.toContain("'poll'");
  });

  it('E17. core.js 는 타이머 미참조(setInterval/setTimeout 0건), 라이브 섹션에도 setInterval 없음', () => {
    expect(coreSrc).not.toContain('setInterval');
    // 호출 형태로 확인(1180행 주석의 'setTimeout' 단어는 타이머 참조가 아님).
    expect(coreSrc).not.toContain('setTimeout(');
    expect(liveSection()).not.toContain('setInterval'); // 재시도는 setTimeout 1회 예약만
  });

  it('E18. index.html: id="fps" 없음 / id="live-status" 있음', () => {
    expect(htmlSrc).not.toContain('id="fps"');
    expect(htmlSrc).toContain('id="live-status"');
  });

  it('E19. cancelStreamRetry 가 clearTimeout 을 호출하고, stopLive/connectStream 이 이를 호출(startLive·reconnectLiveIfActive 는 connectStream 경유)', () => {
    const cancel = functionSource(appSrc, 'cancelStreamRetry');
    expect(cancel).toContain('clearTimeout(');
    expect(cancel).toContain('streamRetryTimer = null');
    expect(functionSource(appSrc, 'stopLive')).toContain('cancelStreamRetry()');
    expect(functionSource(appSrc, 'connectStream')).toContain('cancelStreamRetry()');
    expect(functionSource(appSrc, 'startLive')).toContain('connectStream()');
    expect(functionSource(appSrc, 'reconnectLiveIfActive')).toContain('connectStream()');
  });

  it("E20. 재시도 setTimeout 콜백에 liveMode !== 'stream' 조기 반환 가드가 있다(중복 예약 금지 가드 포함)", () => {
    const err = functionSource(appSrc, 'onStreamError');
    const cb = err.slice(err.indexOf('setTimeout('));
    expect(cb, '재시도 예약 setTimeout 이 존재해야 함').toContain('setTimeout(');
    expect(cb).toContain("liveMode !== 'stream'");
    expect(err).toContain('if (streamRetryTimer) return;'); // 중복 예약 금지
    expect(err).toContain('nextStreamRetryDelay(');
    expect(err).toContain('streamRetryLabel(');
  });
});

// --- E'. app.js 라이브 결선 동작(실제 바이트를 new Function 으로 실행) ------------

type LiveHarness = {
  state: () => { liveMode: string; streamRetryTimer: unknown; streamRetryDelay: number; streamRetryAttempt: number };
  cancelStreamRetry: () => void;
  onStreamLoad: () => void;
  onStreamError: () => void;
  connectStream: () => void;
  startLive: () => void;
  stopLive: () => void;
  reconnectLiveIfActive: () => void;
};

const STREAM_URL = '/viewer/api/stream?cam=1&preset=1';

function makeHarness(transform?: (name: string, src: string) => string) {
  // 상태 선언 4줄을 app.js 텍스트에서 그대로 가져온다(복사 금지 — 실제 바이트).
  const decls = appSrc.match(/^let (?:liveMode|streamRetryTimer|streamRetryDelay|streamRetryAttempt) = .*$/gm) ?? [];
  expect(decls, '라이브 재시도 상태 선언 4줄이 app.js 에 있어야 함').toHaveLength(4);
  const names = ['cancelStreamRetry', 'onStreamLoad', 'onStreamError', 'connectStream', 'startLive', 'stopLive', 'reconnectLiveIfActive'];
  const body = [
    decls.join('\n'),
    ...names.map((n) => {
      const src = functionSource(appSrc, n);
      return transform ? transform(n, src) : src;
    }),
    `return { state: () => ({ liveMode, streamRetryTimer, streamRetryDelay, streamRetryAttempt }), ${names.join(', ')} };`,
  ].join('\n\n');

  const srcs: string[] = [];
  const status = { textContent: 'INIT' };
  const frame = {
    onerror: null as unknown,
    onload: null as unknown,
    removeAttribute: vi.fn(),
    get src() {
      return srcs[srcs.length - 1] ?? '';
    },
    set src(v: string) {
      srcs.push(v);
    },
  };
  const snapshot = { abort: vi.fn(), tick: vi.fn() };
  const drawRoiOverlay = vi.fn();
  const $ = (id: string) => (id === 'live-status' ? status : null);

  const factory = new Function('$', 'frame', 'snapshot', 'streamUrl', 'drawRoiOverlay', 'nextStreamRetryDelay', 'streamRetryLabel', body) as (
    ...a: unknown[]
  ) => LiveHarness;
  const live = factory($, frame, snapshot, () => STREAM_URL, drawRoiOverlay, nextStreamRetryDelay, streamRetryLabel);
  return { live, frame, srcs, status, snapshot, drawRoiOverlay };
}

describe("E'. app.js 라이브 결선 동작(추출 실행) — 재시도·취소·자발폴링 부재", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("E'1. startLive → liveMode='stream', 핸들러 결선, 스트림 URL 대입, 스냅샷 abort", () => {
    const { live, frame, srcs, snapshot, drawRoiOverlay } = makeHarness();
    live.startLive();
    expect(live.state().liveMode).toBe('stream');
    expect(typeof frame.onerror).toBe('function');
    expect(typeof frame.onload).toBe('function');
    expect(srcs).toEqual([STREAM_URL]);
    expect(snapshot.abort).toHaveBeenCalled();
    expect(drawRoiOverlay).toHaveBeenCalledTimes(1);
  });

  it("E'2. 자발 폴링 부재: 정상 스트림 상태에서 60초 진행해도 재요청·tick 0건", () => {
    const { live, srcs, snapshot } = makeHarness();
    live.startLive();
    vi.advanceTimersByTime(60_000);
    expect(srcs).toHaveLength(1); // 초기 연결 1회뿐
    expect(snapshot.tick).not.toHaveBeenCalled();
  });

  it("E'3. onStreamError 반복 → 1s→2s→4s 백오프로만 재연결(캐시버스터 _r 포함)", () => {
    const { live, srcs, status } = makeHarness();
    live.startLive();
    live.onStreamError();
    expect(live.state().streamRetryDelay).toBe(1000);
    expect(live.state().streamRetryAttempt).toBe(1);
    expect(status.textContent).toContain('1초');
    vi.advanceTimersByTime(999);
    expect(srcs).toHaveLength(1); // 아직 재연결 전
    vi.advanceTimersByTime(1);
    expect(srcs).toHaveLength(2);
    expect(srcs[1]).toContain('_r=');

    live.onStreamError();
    expect(live.state().streamRetryDelay).toBe(2000);
    expect(status.textContent).toContain('2초');
    vi.advanceTimersByTime(2000);
    expect(srcs).toHaveLength(3);

    live.onStreamError();
    expect(live.state().streamRetryDelay).toBe(4000);
    vi.advanceTimersByTime(4000);
    expect(srcs).toHaveLength(4);
    // 총 6초 동안 재연결은 3회뿐 — 3fps(=18회/6초) 폴링이 아님
  });

  it("E'4. 대기 중 중복 onStreamError 는 예약을 추가하지 않는다", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    live.onStreamError();
    live.onStreamError();
    live.onStreamError();
    expect(live.state().streamRetryAttempt).toBe(1);
    expect(live.state().streamRetryDelay).toBe(1000);
    vi.advanceTimersByTime(10_000);
    expect(srcs).toHaveLength(2); // 재연결 1회만
  });

  it("E'5. 대기 중 stopLive → 유령 재연결 없음, 상태 문구 비움", () => {
    const { live, srcs, status, frame } = makeHarness();
    live.startLive();
    live.onStreamError();
    expect(status.textContent).not.toBe('');
    live.stopLive();
    expect(live.state().liveMode).toBe('off');
    expect(live.state().streamRetryTimer).toBeNull();
    expect(status.textContent).toBe('');
    expect(frame.removeAttribute).toHaveBeenCalledWith('src');
    vi.advanceTimersByTime(60_000);
    expect(srcs).toHaveLength(1); // 초기 연결 이후 추가 요청 없음
  });

  it("E'6. 프레임 도착(onStreamLoad) → 백오프 리셋 + 문구 소멸", () => {
    const { live, status } = makeHarness();
    live.startLive();
    live.onStreamError();
    vi.advanceTimersByTime(1000); // 재연결 시도
    live.onStreamLoad(); // 프레임 도착
    expect(live.state().streamRetryDelay).toBe(0);
    expect(live.state().streamRetryAttempt).toBe(0);
    expect(live.state().streamRetryTimer).toBeNull();
    expect(status.textContent).toBe('');
    // 리셋 후 다시 실패하면 1초부터 재시작
    live.onStreamError();
    expect(live.state().streamRetryDelay).toBe(1000);
  });

  it("E'7. liveMode='off' 상태의 잔여 onStreamError 는 무시", () => {
    const { live, srcs, status } = makeHarness();
    expect(live.state().liveMode).toBe('off');
    live.onStreamError();
    expect(live.state().streamRetryTimer).toBeNull();
    expect(live.state().streamRetryAttempt).toBe(0);
    expect(status.textContent).toBe('INIT'); // 손대지 않음
    vi.advanceTimersByTime(60_000);
    expect(srcs).toHaveLength(0);
  });

  it("E'8. reconnectLiveIfActive: off 면 무동작 / stream 이면 재연결하며 대기 타이머 취소", () => {
    const { live, srcs } = makeHarness();
    live.reconnectLiveIfActive();
    expect(srcs).toHaveLength(0);
    live.startLive();
    live.onStreamError(); // 대기 예약
    live.reconnectLiveIfActive();
    expect(live.state().streamRetryTimer).toBeNull();
    expect(live.state().streamRetryDelay).toBe(0);
    expect(srcs).toHaveLength(2); // startLive + reconnect
    vi.advanceTimersByTime(60_000);
    expect(srcs).toHaveLength(2); // 취소된 예약이 되살아나지 않음
  });

  it("E'10. 첫 연결 URL 은 캐시버스터 없는 종전 형태(정상 경로 불변)", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    expect(srcs[0]).toBe(STREAM_URL);
    expect(srcs[0]).not.toContain('_r=');
  });

  it("E'9. 상한 도달: 6회 연속 실패 후 지연 30초 유지 + 안내 문구", () => {
    const { live, status } = makeHarness();
    live.startLive();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      live.onStreamError();
      delays.push(live.state().streamRetryDelay);
      vi.advanceTimersByTime(live.state().streamRetryDelay);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(status.textContent).toContain(CAP_NOTICE);
  });
});

// --- E''. connectStream 재연결 캐시버스터 보정(QA 관찰사항 #1 대응) ---------------

/**
 * 보정 내용(developer, 리더 승인): `connectStream()` 이 `cancelStreamRetry()` **이전에**
 * `retrying = !!streamRetryTimer || streamRetryAttempt > 0` 을 캡처하고,
 * 재시도 상태에서의 재연결에만 `&_r=<ts>` 를 붙인다.
 * 목적 — 최초 실패 후 재시도 발화 전에 `시작` 을 다시 눌러도 동일 URL 재대입이 되지 않게(재요청 보장).
 */
describe("E''. connectStream — 실패 후 재연결에만 캐시버스터(순서 의존성 포함)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("E''1. 실패 후 재시도 대기 중 '시작' 재클릭 → 직전 src 와 다른 문자열(_r 포함)", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    expect(srcs[0]).toBe(STREAM_URL); // 첫 연결: 캐시버스터 없음
    live.onStreamError(); // 대기 예약(아직 발화 전)
    live.startLive(); // 사용자가 '시작' 재클릭
    expect(srcs).toHaveLength(2);
    expect(srcs[1]).toContain('_r=');
    expect(srcs[1]).not.toBe(srcs[0]); // 동일 URL 재대입 아님 → 재요청 보장
    expect(srcs[1].startsWith(`${STREAM_URL}&_r=`)).toBe(true); // 기존 쿼리 보존 + 접미만 추가
    // 재클릭이 대기 예약을 취소했으므로 유령 재연결도 없음
    expect(live.state().streamRetryTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(srcs).toHaveLength(2);
  });

  it("E''2. 재시도 발화 후(대기 타이머 없음·attempt 잔존) 재클릭도 캐시버스터 유지", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    live.onStreamError();
    vi.advanceTimersByTime(1000); // 타이머 발화 → streamRetryTimer=null, attempt=1 잔존
    expect(srcs[1]).toContain('_r=');
    vi.advanceTimersByTime(5); // 실제 경과시간(ms 해상도) 모사
    live.startLive();
    expect(srcs).toHaveLength(3);
    expect(srcs[2]).toContain('_r='); // attempt>0 이므로 여전히 재시도 상태로 판정
    expect(srcs[2]).not.toBe(srcs[1]);
  });

  it("E''3. 정상 경로(retrying=false)는 URL 형태 종전과 동일 — 첫 연결·정상 중 재연결 모두 _r 없음", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    live.reconnectLiveIfActive(); // cam/preset 변경 등 정상 재연결
    live.reconnectLiveIfActive();
    expect(srcs).toEqual([STREAM_URL, STREAM_URL, STREAM_URL]);
    for (const s of srcs) expect(s).not.toContain('_r=');
  });

  it("E''4. 프레임 도착으로 리셋된 뒤의 재연결은 다시 _r 없음(재시도 이력 소멸)", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    live.onStreamError();
    vi.advanceTimersByTime(1000);
    live.onStreamLoad(); // 복구 → attempt/delay 0
    expect(srcs).toHaveLength(2); // [0]=최초 연결, [1]=재시도(_r)
    live.reconnectLiveIfActive();
    expect(srcs).toHaveLength(3);
    expect(srcs[2]).toBe(STREAM_URL);
    expect(srcs[2]).not.toContain('_r=');
  });

  it("E''5. 정지 후 재시작은 _r 없음(stopLive 가 재시도 이력을 지운다)", () => {
    const { live, srcs } = makeHarness();
    live.startLive();
    live.onStreamError();
    live.stopLive();
    live.startLive();
    expect(srcs[srcs.length - 1]).toBe(STREAM_URL);
  });

  it("E''6. 순서 의존성: retrying 캡처를 cancelStreamRetry() 뒤로 옮기면 보정이 무력화된다(변이 테스트)", () => {
    /** connectStream 소스에서 retrying 캡처 라인을 cancelStreamRetry() 호출 뒤로 이동시킨 변이본. */
    const swapOrder = (name: string, src: string) => {
      if (name !== 'connectStream') return src;
      const lines = src.split('\n'); // CRLF 유지(줄 끝 \r 는 그대로 따라간다)
      const ci = lines.findIndex((l) => /^\s*const retrying = /.test(l));
      const ki = lines.findIndex((l) => /^\s*cancelStreamRetry\(\);/.test(l));
      expect(ci, 'connectStream 에 retrying 캡처 라인이 있어야 함').toBeGreaterThan(-1);
      expect(ki, 'connectStream 에 cancelStreamRetry() 호출이 있어야 함').toBeGreaterThan(-1);
      expect(ci, '실제 코드에서 캡처는 cancelStreamRetry() 보다 앞이어야 함').toBeLessThan(ki);
      const [capture] = lines.splice(ci, 1); // 제거 → cancel 줄이 ki-1 로 당겨짐
      lines.splice(ki, 0, capture); // cancel 바로 다음에 삽입
      return lines.join('\n');
    };

    // (1) 실제 코드: 재클릭 시 _r 이 붙는다.
    const real = makeHarness();
    real.live.startLive();
    real.live.onStreamError();
    real.live.startLive();
    expect(real.srcs[1]).toContain('_r=');

    // (2) 순서를 뒤바꾼 변이본: cancelStreamRetry() 가 상태를 0 으로 지운 뒤 캡처 → retrying=false → _r 없음(동일 URL 재대입).
    const mutated = makeHarness(swapOrder);
    mutated.live.startLive();
    mutated.live.onStreamError();
    mutated.live.startLive();
    expect(mutated.srcs[1]).not.toContain('_r=');
    expect(mutated.srcs[1]).toBe(mutated.srcs[0]); // 보정 이전의 결함 재현 → 이 케이스가 순서를 실제로 검증함
  });
});
