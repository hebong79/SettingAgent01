import { PACKET_WINDOW_MS, PacketAggregator, type PacketEmit, type PacketEntry } from './packetAggregator.js';
import { logger } from './logger.js';

/**
 * 통신 패킷 로그 결선 — 순수 집계기(PacketAggregator)와 logger 를 잇는 얇은 층.
 * - emit 은 방출 시점에 logger.info/warn 을 "직접" 호출한다(모듈 로드 시 메서드를 바인딩해 두면
 *   테스트의 vi.spyOn(logger, 'info') 가 잡히지 않는다).
 * - VITEST 에서는 기본 창 길이 0 = 집계 비활성 → 매 호출 즉시기록(기존 동작·기존 테스트 보존).
 *   결선 경로를 검증할 때만 configurePacketLog({ windowMs, now }) 로 켠다.
 */
const defaultWindowMs = process.env.VITEST ? 0 : PACKET_WINDOW_MS;

const emit: PacketEmit = (event) => {
  if (event.kind === 'packet') {
    const { entry, failed } = event;
    const fields: Record<string, unknown> = { cat: 'packet', method: entry.method, url: entry.url };
    if (entry.op !== undefined) fields.op = entry.op;
    if (entry.status !== undefined) fields.status = entry.status;
    if (entry.err !== undefined) fields.err = entry.err;
    fields.ms = entry.ms;
    /* 메시지는 기존 문자열 유지(예외만 '… 실패'). 비-2xx 는 메시지 그대로 두고 warn 으로만 승격. */
    const msg = entry.err !== undefined ? `${entry.msgBase} 실패` : entry.msgBase;
    if (failed) logger.warn(fields, msg);
    else logger.info(fields, msg);
    return;
  }

  const { sum } = event;
  const fields: Record<string, unknown> = {
    cat: 'packet',
    win: sum.win,
    span: sum.span,
    n: sum.n,
    ok: sum.ok,
    err: sum.err,
    method: sum.method,
    url: sum.url,
  };
  if (sum.op !== undefined) fields.op = sum.op;
  fields.msAvg = sum.msAvg;
  fields.msMax = sum.msMax;
  logger.info(fields, `${sum.msgBase} 요약`);
};

let aggregator = new PacketAggregator({ windowMs: defaultWindowMs, now: () => Date.now(), emit });

/** 통신 패킷 1건 기록(즉시기록/집계는 정책에 따라 결정). */
export function logPacket(entry: PacketEntry): void {
  aggregator.record(entry);
}

/** 미방출 창을 전부 요약으로 내보낸다(종료 훅 등에서 호출 가능 — 현재 미등록). */
export function flushPacketLog(): void {
  aggregator.flushAll();
}

/** 테스트 전용 — 창 길이·시각을 갈아끼운다. 인자 없이 호출하면 기본값으로 복원한다. */
export function configurePacketLog(opts: { windowMs?: number; now?: () => number } = {}): void {
  aggregator = new PacketAggregator({
    windowMs: opts.windowMs ?? defaultWindowMs,
    now: opts.now ?? (() => Date.now()),
    emit,
  });
}
