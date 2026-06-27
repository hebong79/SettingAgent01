import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { CameraApiError } from '../clients/CameraClient.js';
import type { CameraSource } from './CameraSource.js';

export interface ViewerDeps {
  sources: Map<string, CameraSource>;
  viewer: ToolsConfig['viewer'];
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 36;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const CamerasQuery = z.object({ source: z.string().optional() });

const SnapshotQuery = z.object({
  source: z.string().optional(),
  cam: z.coerce.number().int().positive(),
  preset: z.coerce.number().int().positive(),
  mode: z.enum(['preset', 'manual']),
  pan: z.coerce.number().optional(),
  tilt: z.coerce.number().optional(),
  zoom: z.coerce.number().optional(),
  t: z.coerce.number().optional(),
});

const MoveBody = z.object({
  source: z.string().optional(),
  cam: z.number().int().positive(),
  pan: z.number(),
  tilt: z.number(),
  zoom: z.number(),
});

const LoginBody = z.object({
  source: z.string().min(1),
  user: z.string(),
  pass: z.string(),
});

/**
 * 뷰어 라우트 등록(설계서 §6.2).
 * 라우트 순서 필수: /viewer/api/* (정확 경로) 먼저 → @fastify/static (와일드카드) 나중.
 */
export async function registerViewerRoutes(app: FastifyInstance, deps: ViewerDeps): Promise<void> {
  const { sources, viewer } = deps;

  /** source 쿼리 → CameraSource. 미지정 시 첫 소스. */
  const pickSource = (id?: string): CameraSource | undefined => {
    if (id) return sources.get(id);
    return sources.values().next().value;
  };

  app.get('/viewer/api/cameras', async (req, reply) => {
    const parsed = CamerasQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid query', detail: parsed.error.flatten() };
    }
    const source = pickSource(parsed.data.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    try {
      return await source.listCameras();
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  app.get('/viewer/api/snapshot', async (req, reply) => {
    const parsed = SnapshotQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid query', detail: parsed.error.flatten() };
    }
    const q = parsed.data;
    const source = pickSource(q.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    try {
      const opt =
        q.mode === 'manual'
          ? {
              mode: 'manual' as const,
              presetIdx: q.preset,
              ptz: { pan: q.pan ?? 0, tilt: q.tilt ?? 0, zoom: clampZoom(q.zoom ?? ZOOM_MIN) },
            }
          : { mode: 'preset' as const, presetIdx: q.preset };
      const result = await source.snapshot(q.cam, opt);
      reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'no-store')
        .header('X-PTZ-Pan', String(result.ptz.pan))
        .header('X-PTZ-Tilt', String(result.ptz.tilt))
        .header('X-PTZ-Zoom', String(result.ptz.zoom));
      return reply.send(result.jpeg);
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  app.post('/viewer/api/move', async (req, reply) => {
    if (viewer.allowMove === false) {
      reply.code(403);
      return { error: 'move disabled' };
    }
    if (viewer.controlToken && req.headers['x-viewer-token'] !== viewer.controlToken) {
      reply.code(403);
      return { error: 'invalid token' };
    }
    const parsed = MoveBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const b = parsed.data;
    const source = pickSource(b.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    try {
      const ok = await source.move(b.cam, { pan: b.pan, tilt: b.tilt, zoom: clampZoom(b.zoom) });
      return { ok };
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  app.post('/viewer/api/camera/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const source = pickSource(parsed.data.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    if (!source.login) {
      reply.code(400);
      return { error: 'login unsupported' };
    }
    try {
      // 자격증명은 통과만 — 응답/로그에 노출하지 않는다.
      const ok = await source.login(parsed.data.user, parsed.data.pass);
      return { ok };
    } catch {
      reply.code(502);
      return { error: 'login failed' };
    }
  });

  app.get('/viewer/api/health', async () => ({ status: 'ok', sources: [...sources.keys()] }));

  // GET /viewer → /viewer/ (트레일링 슬래시) redirect.
  app.get('/viewer', async (_req, reply) => reply.redirect('/viewer/'));

  // 정적 SPA 서빙(와일드카드) — 반드시 API 라우트 등록 뒤에.
  await app.register(fastifyStatic, {
    root: resolve(viewer.staticDir),
    prefix: '/viewer/',
    redirect: true,
  });
}
