import { logPacket } from './packetLog.js';

/**
 * 타임아웃이 있는 fetch. AbortController 로 timeoutMs 초과 시 중단. 통신 패킷 로그(cat:'packet').
 * op 는 집계 키를 나누는 논리 오퍼레이션명(예: RPC 메서드). 생략하면 키는 METHOD+경로.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  op?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = init.method ?? 'GET';
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    logPacket({ method, url, op, status: res.status, ms: Date.now() - t0, msgBase: '통신 패킷' });
    return res;
  } catch (err) {
    logPacket({ method, url, op, err: err instanceof Error ? err.message : String(err), ms: Date.now() - t0, msgBase: '통신 패킷' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP 상태가 재시도 가능한지(5xx, 408, 429). */
export function isRetryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 지수 백오프 재시도. shouldRetry 가 true 인 오류만 재시도. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.baseDelayMs ?? 200;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.maxRetries || !shouldRetry(err)) break;
      await sleep(base * 2 ** attempt);
    }
  }
  throw lastErr;
}
