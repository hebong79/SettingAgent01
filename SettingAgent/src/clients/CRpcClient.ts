import { fetchWithTimeout } from '../util/http.js';

/** JSON-RPC 2.0 오류 객체 (Unity /rpc 응답). */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Unity RPC 호출 실패 예외. */
export class RpcClientError extends Error {
  constructor(
    public readonly kind: 'rpc_error' | 'http_error' | 'connection_error',
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RpcClientError';
  }
}

export interface CRpcClientConfig {
  baseUrl: string;
  timeoutMs: number;
  /**
   * 모든 요청에 실을 추가 헤더(옵셔널·가산). SettingAgent 자기 RPC(13020 `/rpc`)를 호출할 때
   * `x-viewer-token` 을 주입하기 위해 도입했다 — `viewer.controlToken` 이 설정된 서버에서
   * 변이 메서드가 403 으로 막히는 것을 막는다. 미지정이면 기존 동작 그대로(Unity 호출자 무영향).
   */
  headers?: Record<string, string>;
}

/**
 * Unity JSON-RPC 2.0 클라이언트 (포트 13110 기준).
 * POST /rpc  — 단건 RPC 호출.
 * GET  /rpc/catalog — 사용 가능 method 목록 조회.
 * 아키텍처 §8 RPC 카탈로그 → MCP 툴 노출 파이프라인.
 */
export class CRpcClient {
  private readonly baseUrl: string;

  constructor(private readonly cfg: CRpcClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  }

  /**
   * Unity POST /rpc 를 JSON-RPC 2.0 봉투로 호출해 result 를 반환한다.
   * Unity 가 error 필드를 반환하면 RpcClientError(kind='rpc_error') throw.
   * 연결 실패(ECONNREFUSED 등) 시 RpcClientError(kind='connection_error') throw.
   */
  async callRpc(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method };
    if (params !== undefined) payload.params = params;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/rpc`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) },
          body: JSON.stringify(payload),
        },
        timeoutMs ?? this.cfg.timeoutMs,
        method,
      );
    } catch (err) {
      throw new RpcClientError(
        'connection_error',
        `Unity RPC 연결 실패 (${this.baseUrl}/rpc): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    let body: { jsonrpc?: string; id?: unknown; result?: unknown; error?: RpcError };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RpcClientError('http_error', `Unity RPC 응답 파싱 실패: HTTP ${res.status}`);
    }

    if (body.error) {
      throw new RpcClientError(
        'rpc_error',
        `RPC 오류 [${body.error.code}]: ${body.error.message}`,
        body.error,
      );
    }

    return body.result;
  }

  /**
   * GET /rpc/catalog 로 Unity 가 노출하는 method 목록을 조회한다.
   * Unity 미기동 시 RpcClientError(kind='connection_error') throw.
   */
  async getCatalog(): Promise<{ methods: string[] }> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/rpc/catalog`,
        { method: 'GET', ...(this.cfg.headers ? { headers: this.cfg.headers } : {}) },
        this.cfg.timeoutMs,
        'catalog',
      );
    } catch (err) {
      throw new RpcClientError(
        'connection_error',
        `Unity RPC catalog 연결 실패 (${this.baseUrl}/rpc/catalog): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    if (!res.ok) {
      throw new RpcClientError('http_error', `Unity RPC catalog HTTP 오류: ${res.status}`);
    }

    return (await res.json()) as { methods: string[] };
  }
}
