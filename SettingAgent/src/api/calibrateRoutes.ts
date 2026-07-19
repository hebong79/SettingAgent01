import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PtzCalibrator } from '../calibrate/PtzCalibrator.js';

const StartBodySchema = z.object({ slotIds: z.array(z.string()).optional() }).default({});

export interface CalibrateRouteDeps {
  calibrator: PtzCalibrator;
  /** slot_ptz.json 경로(GET /calibrate/result). */
  outFile: string;
}

/**
 * /calibrate/* 라우트 등록(설계서 §3.1, captureRoutes 패턴). 기존 라우트 불변·가산.
 * 제어·좌표 로직은 PtzCalibrator 소유. 라우트는 얇은 진입점.
 */
export function registerCalibrateRoutes(app: FastifyInstance, deps: CalibrateRouteDeps): void {
  app.post('/calibrate/ptz', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    try {
      const { total } = deps.calibrator.start(parsed.data.slotIds);
      return { ok: true, started: true, total };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(msg.includes('already running') ? 409 : 400);
      return { error: msg };
    }
  });

  app.get('/calibrate/status', async () => deps.calibrator.getStatus());

  // 최근 센터라이징 프레임(진행 관찰용). 카메라 재명령 없이 잡이 방금 찍은 JPEG 그대로(/capture/frame 미러).
  app.get('/calibrate/frame', async (_req, reply) => {
    const latest = deps.calibrator.getLastFrame();
    if (!latest) {
      reply.code(404);
      return { error: 'no frame' };
    }
    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store')
      .header('X-Cal-Cam', String(latest.camIdx))
      .header('X-Cal-Preset', String(latest.presetIdx));
    return reply.send(latest.jpeg);
  });

  app.get('/calibrate/result', async (_req, reply) => {
    if (!existsSync(deps.outFile)) {
      reply.code(404);
      return { error: 'no result' };
    }
    return JSON.parse(readFileSync(deps.outFile, 'utf-8'));
  });
}
