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

  void registerViewerRoutes(app, { sources: deps.sources, viewer: deps.viewer });

  return app;
}
