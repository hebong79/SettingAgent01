// RPC 오류 코드·매핑 (설계서 §4.3 / 다이어그램 §5). 순수 — I/O·throw 없음(makeError 는 객체만 만든다).
//
// ★ 이 파일의 존재 이유: 외부 제어자의 **재시도 정책**이 코드 하나로 갈린다.
//   BUSY(-32001)  = 기다리면 풀린다(잡 점유) → 백오프 재시도.
//   CONFLICT(-32005) = 기다려도 안 풀린다(가드 거부·파일 무변경) → 사람이 개입해야 한다.
//   HTTP 409 하나에 이 둘이 섞여 있어 REST 만으로는 구분이 불가능했다.

/** JSON-RPC 2.0 표준 + SettingAgent 확장 코드. */
export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** 잡 점유·이미 실행 중(409) — 재시도로 풀린다. */
  BUSY: -32001,
  /** 파일·결과·테이블 없음(404). */
  NOT_FOUND: -32002,
  /** 상류(카메라·VPD·LPD·Unity) 실패(502). */
  UPSTREAM: -32003,
  /** 미설정·미배선(501·503, 라우트 미등록 포함). */
  UNAVAILABLE: -32004,
  /** 무결성 가드 거부(409) — **파일·DB 무변경**. 재시도해도 안 풀린다. */
  CONFLICT: -32005,
  /** 토큰 불일치·기능 잠금(403). */
  FORBIDDEN: -32006,
} as const;

export type RpcCodeValue = (typeof RpcCode)[keyof typeof RpcCode];

/** JSON-RPC 2.0 error 객체(Unity 13110 응답과 동형 — CRpcClient.RpcError 와 같은 shape). */
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** 디스패치 계층에서 오류 응답으로 변환되는 예외. 서비스 핸들러가 throw 한다. */
export class RpcMethodError extends Error {
  constructor(
    public readonly code: RpcCodeValue,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcMethodError';
  }

  toErrorObject(): RpcErrorObject {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

/**
 * Fastify 기본 404(라우트 **미등록**) 판정.
 *
 * 라우트 미등록(가산 게이트로 인해 기능이 배선되지 않음)과 핸들러 본문 404(`{error:'no result'}`)는
 * 외부 제어자에게 **의미가 완전히 다르다** — 전자는 "이 서버는 그 기능이 꺼져 있다"(설정 문제),
 * 후자는 "기능은 있는데 지금 값이 없다"(상태). Fastify 미등록 응답은
 * `{ statusCode:404, error:'Not Found', message:'Route POST:/x not found' }` 형태이므로 그것으로 구분한다.
 */
export function isRouteNotRegistered(payload: unknown): boolean {
  const p = payload as { statusCode?: unknown; error?: unknown; message?: unknown } | null;
  return (
    !!p &&
    typeof p === 'object' &&
    p.statusCode === 404 &&
    p.error === 'Not Found' &&
    typeof p.message === 'string' &&
    p.message.startsWith('Route ')
  );
}

/**
 * 409 세분화 — 잡 점유(BUSY) vs 무결성 가드(CONFLICT).
 *
 * 판정은 **기존 라우트가 이미 쓰고 있는 문자열**을 근거로 한다(새 규약을 만들지 않는다):
 *  - BUSY: `pipeline busy` / `capture still running` / `already running` / `busy:...`(lensCalib)
 *  - CONFLICT: 그 외 전부 — `raw 주차면 개수 불일치`(expectRawCount), `sync-roi` slot_id 불일치,
 *              `slot_setup 비어있음`, `assertAutoPromoteSafe` G1~G4 거부.
 * 판정 불가(문자열 없음)면 **CONFLICT** 로 둔다 — 무한 재시도보다 사람 개입이 안전하다.
 */
export function classify409(payload: unknown): typeof RpcCode.BUSY | typeof RpcCode.CONFLICT {
  const p = payload as { error?: unknown; state?: unknown; stage?: unknown } | null;
  const msg = typeof p?.error === 'string' ? p.error : '';
  const busyMarks = ['pipeline busy', 'still running', 'already running', 'busy'];
  return busyMarks.some((m) => msg.includes(m)) ? RpcCode.BUSY : RpcCode.CONFLICT;
}

/**
 * HTTP 상태 → RPC 코드(설계서 §4.3 표). 409 는 classify409 가 갈라놓은 값을 그대로 쓴다.
 * 매핑에 없는 상태는 INTERNAL(-32603).
 */
export function mapHttpStatus(status: number, payload: unknown): RpcCodeValue {
  if (status === 400) return RpcCode.INVALID_PARAMS;
  if (status === 403) return RpcCode.FORBIDDEN;
  if (status === 404) return isRouteNotRegistered(payload) ? RpcCode.UNAVAILABLE : RpcCode.NOT_FOUND;
  if (status === 409) return classify409(payload);
  if (status === 501 || status === 503) return RpcCode.UNAVAILABLE;
  if (status === 502) return RpcCode.UPSTREAM;
  return RpcCode.INTERNAL;
}

/**
 * 오류 payload 에서 사람이 읽을 메시지 추출. 기존 라우트의 `error` 문자열을 **그대로** 살린다
 * (RPC 가 메시지를 새로 쓰면 REST 와 다른 문구가 생겨 진단이 갈린다).
 */
export function messageOf(payload: unknown, fallback: string): string {
  const p = payload as { error?: unknown; message?: unknown } | null;
  if (typeof p?.error === 'string' && p.error) return p.error;
  if (typeof p?.message === 'string' && p.message) return p.message;
  return fallback;
}
