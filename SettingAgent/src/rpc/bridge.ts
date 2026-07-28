// 브리지 — RPC 메서드를 **기존 REST 라우트**로 위임한다(설계서 §5 하이브리드 / 다이어그램 §4-1).
//
// ★ 이 파일이 "이중구현 금지"(P1)를 구조적으로 보장한다. RPC 는 로직을 갖지 않고
//   `app.inject()`(인메모리 · 네트워크 0)로 같은 핸들러를 호출한다 → REST 와 RPC 의 결과가
//   **정의상** 같다. 라우트를 고치면 RPC 도 함께 고쳐진다.

import type { FastifyInstance } from 'fastify';
import { RpcCode, RpcMethodError, mapHttpStatus, messageOf } from './errors.js';
import type { HttpMapping } from './types.js';

/** inject 응답 본문 파싱. JSON 아니면 원문 문자열 그대로(진단 보존). */
function parseBody(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * HTTP 매핑을 실행해 성공 payload 를 반환한다. 실패(4xx·5xx)면 RpcMethodError throw.
 *
 * - `token` 은 하류 라우트에 그대로 전달한다. 뷰어 라우트(`/viewer/api/move` 등)는 자체
 *   controlToken 게이트를 갖고 있어, 디스패처가 통과시킨 요청이 하류에서 403 이 되면 안 된다.
 * - 오류 `data` 에는 **원본 payload 전체**를 싣는다(zod `detail`, `issues[]`, `expected/actual`,
 *   `missing[]` 같은 진단이 RPC 경계에서 사라지지 않도록).
 */
export async function callViaHttp(
  app: FastifyInstance,
  mapping: HttpMapping,
  token?: string,
): Promise<unknown> {
  // ★ content-type 은 **본문이 있을 때만** 붙인다. 본문 없는 POST(`/capture/slots/reset` 등)에
  //   `application/json` 만 붙으면 Fastify 가 FST_ERR_CTP_EMPTY_JSON_BODY(400) 로 거부한다
  //   — 라우트는 정상인데 브리지 때문에 실패하는 거짓 오류가 된다(테스트로 고정).
  const res = await app.inject({
    method: mapping.method,
    url: mapping.url,
    ...(mapping.payload !== undefined ? { payload: mapping.payload as object } : {}),
    headers: {
      ...(mapping.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-viewer-token': token } : {}),
    },
  });
  const body = parseBody(res.payload);
  if (res.statusCode < 400) return body;
  throw new RpcMethodError(
    mapHttpStatus(res.statusCode, body),
    messageOf(body, `HTTP ${res.statusCode}`),
    { httpStatus: res.statusCode, response: body },
  );
}

/** 쿼리스트링 조립 — undefined/null 값은 생략(기존 라우트의 "미지정" 분기를 그대로 타게 한다). */
export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * URL 조립에 반드시 필요한 필드만 얕게 검증한다(값 검증은 **하지 않는다** — 그건 라우트 zod 소유).
 * 없으면 URL 이 `undefined` 로 깨져 엉뚱한 404 가 되므로 여기서 INVALID_PARAMS 로 끊는다.
 */
export function requireFields(params: Record<string, unknown>, keys: string[], method: string): void {
  const missing = keys.filter((k) => params[k] === undefined || params[k] === null);
  if (missing.length > 0) {
    throw new RpcMethodError(RpcCode.INVALID_PARAMS, `${method}: 필수 파라미터 누락(${missing.join(', ')})`, { missing });
  }
}
