/** 타임아웃이 있는 fetch. AbortController 로 timeoutMs 초과 시 중단. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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
