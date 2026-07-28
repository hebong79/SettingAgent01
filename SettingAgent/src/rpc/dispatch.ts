// JSON-RPC 2.0 디스패치(설계서 §4 / 다이어그램 §4·§5). 게이트 → 실행 → 봉투 변환.
//
// 순서가 계약이다: 봉투 → 메서드 조회 → 배선 확인 → 토큰 → 카메라 점유 → 실행.
// (토큰보다 배선 확인이 먼저인 이유: 존재하지 않는 기능에 대해 403 을 돌려주면 진단이 어긋난다.)

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { callViaHttp } from './bridge.js';
import { RpcCode, RpcMethodError, type RpcErrorObject } from './errors.js';
import type { CatalogEntry, MethodDef, RpcContext, RpcDeps } from './types.js';

/** Unity 패스스루 접두어(설계서 §4.6). `unity.cam.setPTZ` → Unity 의 `cam.setPTZ`. */
const UNITY_PREFIX = 'unity.';

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: RpcErrorObject;
}

function ok(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, error: RpcErrorObject): RpcResponse {
  return { jsonrpc: '2.0', id, error };
}

/** 예외 → JSON-RPC error 객체. ZodError(승격 서비스의 스키마 실패)는 INVALID_PARAMS 로 접는다. */
function toErrorObject(err: unknown): RpcErrorObject {
  if (err instanceof RpcMethodError) return err.toErrorObject();
  if (err instanceof z.ZodError) {
    return { code: RpcCode.INVALID_PARAMS, message: 'invalid params', data: { detail: err.flatten() } };
  }
  return { code: RpcCode.INTERNAL, message: err instanceof Error ? err.message : String(err) };
}

export interface DispatchOptions {
  app: FastifyInstance;
  deps: RpcDeps;
  methods: Map<string, MethodDef>;
  /** 요청 헤더 `x-viewer-token`. */
  token?: string;
}

/** 배선 확인 — `requires` 의 deps 키가 전부 주입돼 있는가. */
function isAvailable(def: MethodDef, deps: RpcDeps): boolean {
  return (def.requires ?? []).every((k) => deps[k] !== undefined);
}

/**
 * 카탈로그(GET /rpc/catalog). `available` 은 **의존성 주입 상태** 기준이다 —
 * 라우트 등록 여부(가산 게이트)까지는 여기서 알 수 없고, 호출 시 `-32004 UNAVAILABLE` 로 드러난다.
 */
export function buildCatalog(methods: Map<string, MethodDef>, deps: RpcDeps): CatalogEntry[] {
  return [...methods.values()].map((m) => ({
    name: m.name,
    title: m.title,
    mutating: m.mutating,
    destructive: m.destructive === true,
    requiresCamera: m.requiresCamera === true,
    stability: m.stability ?? 'stable',
    ...(m.preconditions ? { preconditions: m.preconditions } : {}),
    ...(m.note ? { note: m.note } : {}),
    available: isAvailable(m, deps),
  }));
}

/** 단건 요청 처리. throw 하지 않는다 — 모든 실패를 error 봉투로 되돌린다. */
export async function dispatchRpc(body: unknown, opts: DispatchOptions): Promise<RpcResponse> {
  if (Array.isArray(body)) {
    return fail(null, { code: RpcCode.INVALID_REQUEST, message: '배치 요청은 지원하지 않습니다(단건만)' });
  }
  const req = (body ?? {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = (typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null) as string | number | null;

  if (req.jsonrpc !== '2.0') {
    return fail(id, { code: RpcCode.INVALID_REQUEST, message: 'jsonrpc:"2.0" 이 필요합니다' });
  }
  if (typeof req.method !== 'string' || req.method === '') {
    return fail(id, { code: RpcCode.INVALID_REQUEST, message: 'method 문자열이 필요합니다' });
  }
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (typeof params !== 'object' || Array.isArray(params)) {
    return fail(id, { code: RpcCode.INVALID_PARAMS, message: 'params 는 객체여야 합니다' });
  }

  const ctx: RpcContext = { app: opts.app, deps: opts.deps, ...(opts.token ? { token: opts.token } : {}) };

  // ── Unity 패스스루(설계서 §4.6). 변이 여부를 알 수 없으므로 **항상 토큰 게이트**를 적용한다.
  if (req.method.startsWith(UNITY_PREFIX)) {
    const gate = tokenGate(opts.deps, opts.token);
    if (gate) return fail(id, gate);
    const unity = opts.deps.unityRpc;
    if (!unity) return fail(id, { code: RpcCode.UNAVAILABLE, message: 'Unity RPC 미배선' });
    try {
      const result = await unity.callRpc(req.method.slice(UNITY_PREFIX.length), params);
      return ok(id, result);
    } catch (err) {
      return fail(id, { code: RpcCode.UPSTREAM, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const def = opts.methods.get(req.method);
  if (!def) return fail(id, { code: RpcCode.METHOD_NOT_FOUND, message: `알 수 없는 method: ${req.method}` });

  if (!isAvailable(def, opts.deps)) {
    const missing = (def.requires ?? []).filter((k) => opts.deps[k] === undefined);
    return fail(id, {
      code: RpcCode.UNAVAILABLE,
      message: `${req.method}: 이 서버에 배선되지 않았습니다`,
      data: { missing },
    });
  }

  if (def.mutating) {
    const gate = tokenGate(opts.deps, opts.token);
    if (gate) return fail(id, gate);
  }

  if (def.requiresCamera && opts.deps.isBusy) {
    const busy = opts.deps.isBusy();
    if (busy.busy) {
      return fail(id, {
        code: RpcCode.BUSY,
        message: `카메라 점유 중(${busy.who ?? '진행 중인 잡'}) — 잠시 후 재시도하세요`,
        data: { who: busy.who },
      });
    }
  }

  try {
    if (def.handler) return ok(id, await def.handler(params, ctx));
    if (def.http) return ok(id, await callViaHttp(opts.app, def.http(params), opts.token));
    return fail(id, { code: RpcCode.INTERNAL, message: `${req.method}: 실행부 없음(메서드 표 오류)` });
  } catch (err) {
    return fail(id, toErrorObject(err));
  }
}

/** 변이 게이트 — controlToken 설정 시 `x-viewer-token` 일치 필요(기존 /viewer/api/move 와 동일 규칙). */
function tokenGate(deps: RpcDeps, token?: string): RpcErrorObject | null {
  const required = deps.viewer?.controlToken;
  if (!required) return null;
  if (token === required) return null;
  return { code: RpcCode.FORBIDDEN, message: 'invalid token' };
}
