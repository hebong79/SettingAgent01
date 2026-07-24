/**
 * 통신 패킷 로그 집계기(순수 모듈 — logger/pino 를 import 하지 않는다).
 * 시각(now)·방출(emit)을 주입받아 결정적으로 동작하므로 유닛테스트가 타이머 없이 가능하다.
 *
 * 정책:
 * 1) 같은 키(METHOD + 쿼리제거 URL + op)의 첫 발생은 즉시기록하고 그때부터 창을 연다.
 * 2) 실패(예외) · 비-2xx 는 창 중에도 항상 즉시기록한다(집계로 숨기지 않는다).
 * 3) 창 만료분은 별도 타이머 없이 "임의 패킷 도착 시 전 키 sweep"으로 지연 플러시한다(타이머 0개).
 * 4) 요약의 n 은 즉시기록된 첫 줄을 포함한 창 안의 총 시도 건수.
 * 5) n <= 1 인 창은 요약하지 않는다 — 즉시 줄과 정보가 같아 저빈도 키의 로그만 2배가 된다.
 *
 * 케이던스(초당 건수) 읽는 법 — 두 산식을 구분해 쓴다:
 * - 창 평균: n / win * 1000        (win = 창 총 길이. sweep 이 지연되면 침묵 구간이 섞여 과소평가된다)
 * - 활성 구간: (n - 1) / span * 1000  (span = 실측 활성 구간. 버스트의 실제 케이던스. n >= 2 에서만 유효)
 * - 침묵량 = win - span            (요약이 얼마나 늦게 방출됐는지)
 */

/** 창 길이(5분). env/config 로 노출하지 않는다 — 테스트는 인스턴스에 windowMs 를 주입한다. */
export const PACKET_WINDOW_MS = 5 * 60_000;

/** 통신 패킷 1건. */
export interface PacketEntry {
  method: string;
  url: string;
  /** 논리 오퍼레이션(RPC 메서드명 · Hucoms action). 없으면 키는 METHOD+경로. */
  op?: string;
  status?: number;
  err?: string;
  ms: number;
  /** 로그 메시지 접두 — '통신 패킷' | 'Hucoms 통신 패킷'. */
  msgBase: string;
}

/** 창 1개의 요약. */
export interface PacketSummary {
  method: string;
  /** 쿼리를 제거한 URL(집계 키와 동일 기준). */
  url: string;
  op?: string;
  msgBase: string;
  /** 창 총 길이(ms) = flushAt - windowStart. 침묵 후 지연 sweep 되면 부풀 수 있다. */
  win: number;
  /** 실측 활성 구간(ms) = 마지막 기록 시각 - 창 시작 시각. 활성 rate = (n-1)/span*1000. */
  span: number;
  /** 창 안의 총 시도 건수(즉시기록된 첫 줄 포함). 요약은 n >= 2 일 때만 방출된다. */
  n: number;
  ok: number;
  err: number;
  msAvg: number;
  msMax: number;
}

/** 방출 콜백 — 즉시기록(packet) 또는 창 요약(summary). */
export type PacketEmit = (
  event:
    | { kind: 'packet'; entry: PacketEntry; failed: boolean }
    | { kind: 'summary'; sum: PacketSummary },
) => void;

interface WindowState {
  windowStart: number;
  /** 이 창에서 마지막으로 기록된 시각(span 산출용). */
  lastAt: number;
  n: number;
  ok: number;
  err: number;
  msSum: number;
  msMax: number;
  /** 요약 줄에 실을 대표 필드(창의 첫 패킷 기준). */
  method: string;
  url: string;
  op?: string;
  msgBase: string;
}

/** 쿼리를 제거한다 — Hucoms 처럼 좌표·자격증명이 쿼리에 실리면 키가 무한증식한다. */
function stripQuery(url: string): string {
  return url.split('?')[0];
}

function packetKey(entry: PacketEntry): string {
  return `${entry.method} ${stripQuery(entry.url)}${entry.op ? `#${entry.op}` : ''}`;
}

/** 실패 판정 — 예외이거나 2xx 가 아닌 응답. */
function isFailed(entry: PacketEntry): boolean {
  if (entry.err !== undefined) return true;
  return entry.status !== undefined && (entry.status < 200 || entry.status >= 300);
}

export class PacketAggregator {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly emit: PacketEmit;
  private readonly windows = new Map<string, WindowState>();

  constructor(opts: { windowMs: number; now: () => number; emit: PacketEmit }) {
    this.windowMs = opts.windowMs;
    this.now = opts.now;
    this.emit = opts.emit;
  }

  /** 패킷 1건을 기록한다. 즉시기록 여부·요약 방출은 정책에 따라 내부에서 결정한다. */
  record(entry: PacketEntry): void {
    const failed = isFailed(entry);
    if (this.windowMs <= 0) {
      /* 집계 비활성 — 항상 즉시기록(현행 동작). */
      this.emit({ kind: 'packet', entry, failed });
      return;
    }

    const t = this.now();
    this.sweep(t);

    const key = packetKey(entry);
    let state = this.windows.get(key);
    if (!state) {
      this.emit({ kind: 'packet', entry, failed });
      state = {
        windowStart: t,
        lastAt: t,
        n: 0,
        ok: 0,
        err: 0,
        msSum: 0,
        msMax: 0,
        method: entry.method,
        url: stripQuery(entry.url),
        op: entry.op,
        msgBase: entry.msgBase,
      };
      this.windows.set(key, state);
    } else if (failed) {
      /* 창이 열려 있어도 실패는 숨기지 않는다(창은 리셋하지 않음). */
      this.emit({ kind: 'packet', entry, failed });
    }

    state.n += 1;
    state.lastAt = t;
    if (failed) state.err += 1;
    else state.ok += 1;
    state.msSum += entry.ms;
    if (entry.ms > state.msMax) state.msMax = entry.ms;
  }

  /** 미방출 창을 전부 요약으로 내보내고 비운다(재호출 시 무방출). */
  flushAll(): void {
    const t = this.now();
    for (const state of this.windows.values()) this.emitSummary(state, t);
    this.windows.clear();
  }

  /** 만료된 창을 요약 방출 후 삭제한다(다음 패킷이 다시 즉시기록되도록 재무장). */
  private sweep(t: number): void {
    for (const [key, state] of this.windows) {
      if (t - state.windowStart >= this.windowMs) {
        this.emitSummary(state, t);
        this.windows.delete(key);
      }
    }
  }

  private emitSummary(state: WindowState, flushAt: number): void {
    /* 반복이 없었던 창(n<=1)은 즉시 줄과 정보가 같으므로 요약하지 않는다. */
    if (state.n <= 1) return;
    this.emit({
      kind: 'summary',
      sum: {
        method: state.method,
        url: state.url,
        op: state.op,
        msgBase: state.msgBase,
        win: flushAt - state.windowStart,
        span: state.lastAt - state.windowStart,
        n: state.n,
        ok: state.ok,
        err: state.err,
        msAvg: Math.round(state.msSum / state.n),
        msMax: state.msMax,
      },
    });
  }
}
