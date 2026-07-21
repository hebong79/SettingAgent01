import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PlateDiscoveryJob } from '../calibrate/PlateDiscoveryJob.js';

const StartBodySchema = z
  .object({
    slotIds: z.array(z.string()).optional(),
    cam: z.number().int().positive().optional(), // 현재 프리셋 한정(cam+preset 동시 전달 시만 필터).
    preset: z.number().int().positive().optional(),
  })
  .default({});

export interface DiscoverRouteDeps {
  discovery: PlateDiscoveryJob;
  /** plate_discovery.json 경로(GET /discover/result). */
  outFile: string;
}

/**
 * /discover/* 라우트 등록(calibrateRoutes 패턴, 얇은 진입점). 기존 라우트 불변·가산.
 * 탐색·역계산 로직은 PlateDiscoveryJob/PlateDiscovery 소유.
 */
export function registerDiscoverRoutes(app: FastifyInstance, deps: DiscoverRouteDeps): void {
  app.post('/discover/ptz', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    try {
      const { total } = deps.discovery.start(parsed.data);
      return { ok: true, started: true, total };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(msg.includes('already running') ? 409 : 400);
      return { error: msg };
    }
  });

  app.get('/discover/status', async () => deps.discovery.getStatus());

  // 최근 탐색 프레임(진행 관찰용). 카메라 재명령 없이 잡이 방금 찍은 원본 JPEG 그대로(/calibrate/frame 미러).
  app.get('/discover/frame', async (_req, reply) => {
    const latest = deps.discovery.getLastFrame();
    if (!latest) {
      reply.code(404);
      return { error: 'no frame' };
    }
    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store')
      .header('X-Disc-Cam', String(latest.camIdx))
      .header('X-Disc-Preset', String(latest.presetIdx));
    return reply.send(latest.jpeg);
  });

  app.get('/discover/result', async (_req, reply) => {
    if (!existsSync(deps.outFile)) {
      reply.code(404);
      return { error: 'no result' };
    }
    return JSON.parse(readFileSync(deps.outFile, 'utf-8'));
  });
}
