// RPC 라우트 등록(설계서 §4.1). `POST /rpc` + `GET /rpc/catalog` 2개만 추가한다(가산).
//
// ★ 경로 분리: `/viewer/api/rpc` 는 **Unity 프록시**로 그대로 둔다(의미 불변·하위호환).
//   이 파일이 등록하는 `/rpc` 는 **SettingAgent 자신의 능력**이며, Unity 는 `unity.*` 네임스페이스로 합류한다.
//   → 외부 제어자는 엔드포인트 하나만 알면 셋팅과 시뮬레이터를 모두 제어한다.

import type { FastifyInstance } from 'fastify';
import { buildCatalog, dispatchRpc } from './dispatch.js';
import { METHODS, buildMethodMap } from './methods.js';
import type { MethodDef, RpcDeps } from './types.js';

/** 요청 헤더에서 뷰어 제어 토큰 추출(기존 라우트와 같은 헤더명). */
function tokenOf(headers: Record<string, unknown>): string | undefined {
  const v = headers['x-viewer-token'];
  return typeof v === 'string' ? v : undefined;
}

export function registerRpcRoutes(app: FastifyInstance, deps: RpcDeps): void {
  // system.catalog 는 표 전체를 알아야 하므로 여기서 클로저로 만들어 표에 얹는다(자기참조 해소).
  const methodMap = buildMethodMap([
    ...METHODS,
    {
      name: 'system.catalog',
      title: '노출 메서드 카탈로그',
      mutating: false,
      handler: async (_p, ctx) => ({ methods: buildCatalog(methodMap, ctx.deps) }),
    } satisfies MethodDef,
  ]);

  app.post('/rpc', async (req, reply) => {
    const res = await dispatchRpc(req.body, {
      app,
      deps,
      methods: methodMap,
      ...(tokenOf(req.headers as Record<string, unknown>) ? { token: tokenOf(req.headers as Record<string, unknown>)! } : {}),
    });
    // JSON-RPC 는 **전송 성공 = HTTP 200** 이다. 오류는 봉투 안 error 필드로 전달한다
    // (HTTP 상태로도 오류를 내면 클라이언트가 두 곳을 봐야 한다).
    reply.header('Cache-Control', 'no-store');
    return res;
  });

  // 카탈로그(읽기·무게이트). Unity 가 배선돼 있으면 그 method 목록을 `unity.` 접두어로 병합한다.
  // Unity 미기동은 **강등**한다 — 자기 메서드 목록은 그대로 나온다(graceful, 기존 프록시 규약과 동일).
  app.get('/rpc/catalog', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const methods = buildCatalog(methodMap, deps);
    const issues: string[] = [];
    let unity: string[] = [];
    if (deps.unityRpc) {
      try {
        unity = (await deps.unityRpc.getCatalog()).methods.map((m) => `unity.${m}`);
      } catch (err) {
        issues.push(`Unity 카탈로그 조회 실패(자기 메서드는 정상): ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      issues.push('Unity RPC 미배선 — unity.* 미제공');
    }
    return { methods, unity, count: methods.length, unityCount: unity.length, issues };
  });
}
