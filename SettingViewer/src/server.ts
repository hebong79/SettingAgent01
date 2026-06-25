import Fastify, { type FastifyInstance } from 'fastify';
import type { CameraSource } from './viewer/CameraSource.js';
import type { ViewerConfig } from './config/viewerConfig.js';
import { registerViewerRoutes } from './viewer/routes.js';
import { fetchWithTimeout } from './util/http.js';

export interface ViewerServerDeps {
  sources: Map<string, CameraSource>;
  viewer: ViewerConfig['viewer'];
  /** ROI(/mapping) 프록시 대상 SettingAgent 주소(예: http://localhost:13020). */
  settingAgentUrl: string;
}

/** /mapping 프록시 호출 타임아웃(ms). */
const MAPPING_TIMEOUT_MS = 5000;

/**
 * SettingViewer REST 서버.
 * 브라우저는 이 서비스만 호출하며, ROI(/mapping)는 SettingAgent 로 서버측 프록시한다.
 * 라우트 순서: /viewer/api/mapping 프록시 → registerViewerRoutes(API + 정적 와일드카드).
 */
export function buildViewerServer(deps: ViewerServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const settingAgentUrl = deps.settingAgentUrl.replace(/\/+$/, '');

  // ROI 매핑(SetupArtifact)을 SettingAgent /mapping 에서 중계(JSON 패스스루).
  app.get('/viewer/api/mapping', async (_req, reply) => {
    try {
      const res = await fetchWithTimeout(`${settingAgentUrl}/mapping`, { method: 'GET' }, MAPPING_TIMEOUT_MS);
      if (res.status === 404) {
        reply.code(404);
        return { error: 'no setup artifact' };
      }
      if (!res.ok) {
        reply.code(502);
        return { error: `mapping upstream HTTP ${res.status}` };
      }
      reply.header('Content-Type', 'application/json');
      return reply.send(await res.text());
    } catch {
      reply.code(502);
      return { error: 'mapping upstream unreachable' };
    }
  });

  // 장기 관측·반복 수집(/capture/*) 프록시. /mapping 과 동일 중계 패턴(JSON 패스스루).
  // 정적 와일드카드(registerViewerRoutes)보다 앞에 등록한다.
  const captureGet = (path: string) =>
    app.get(`/viewer/api/capture/${path}`, async (req, reply) =>
      proxyCapture(settingAgentUrl, 'GET', `/capture/${captureUpstreamPath(path, req.params)}`, undefined, reply),
    );
  const capturePost = (path: string) =>
    app.post(`/viewer/api/capture/${path}`, async (req, reply) =>
      proxyCapture(settingAgentUrl, 'POST', `/capture/${path}`, req.body, reply),
    );

  captureGet('status');
  captureGet('runs');
  captureGet('runs/:id/aggregate');
  capturePost('start');
  capturePost('stop');
  capturePost('finalize');

  void registerViewerRoutes(app, { sources: deps.sources, viewer: deps.viewer });

  return app;
}

/** GET 경로 중 파라미터(:id)를 실제 값으로 치환한 업스트림 경로를 만든다. */
function captureUpstreamPath(path: string, params: unknown): string {
  if (path === 'runs/:id/aggregate') {
    const id = (params as { id?: string })?.id ?? '';
    return `runs/${encodeURIComponent(id)}/aggregate`;
  }
  return path;
}

/** SettingAgent /capture/* 로 중계(JSON 패스스루). /mapping 프록시와 동일 에러 처리. */
async function proxyCapture(
  settingAgentUrl: string,
  method: 'GET' | 'POST',
  upstreamPath: string,
  body: unknown,
  reply: import('fastify').FastifyReply,
): Promise<unknown> {
  try {
    const init: RequestInit = { method };
    if (method === 'POST') {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetchWithTimeout(`${settingAgentUrl}${upstreamPath}`, init, MAPPING_TIMEOUT_MS);
    if (res.status === 404) {
      reply.code(404);
      return reply.send(await res.text());
    }
    if (res.status === 400 || res.status === 409) {
      // 클라이언트 오류는 상태코드·본문을 그대로 전달(중복 시작/정지 불가 등).
      reply.code(res.status);
      reply.header('Content-Type', 'application/json');
      return reply.send(await res.text());
    }
    if (!res.ok) {
      reply.code(502);
      return { error: `capture upstream HTTP ${res.status}` };
    }
    reply.header('Content-Type', 'application/json');
    return reply.send(await res.text());
  } catch {
    reply.code(502);
    return { error: 'capture upstream unreachable' };
  }
}
