import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LensCalibrationJob } from '../calibrate/LensCalibrationJob.js';
import { setLensCalibEnabled } from '../calibrate/lensCalibFile.js';

const StartBodySchema = z.object({
  source: z.string().min(1),
  mode: z.enum(['full', 'verify', 'distortion']).default('full'),
});

const ApplyBodySchema = z.object({
  source: z.string().min(1),
  enabled: z.boolean(),
});

const StatusQuerySchema = z.object({
  sinceSeq: z.coerce.number().int().nonnegative().optional(),
});

export interface LensCalibRouteDeps {
  job: LensCalibrationJob;
  /** data/lens_calibration.json 경로(apply 대상). */
  calibFile: string;
  /** 결과 전문 디렉터리(GET /calibrate/lens/result). */
  resultDir: string;
}

/**
 * /calibrate/lens/* 라우트 등록(discoverRoutes 패턴, 얇은 진입점). 기존 라우트 불변·가산.
 * 측정·상태 로직은 LensCalibrationJob 소유.
 */
export function registerLensCalibRoutes(app: FastifyInstance, deps: LensCalibRouteDeps): void {
  app.post('/calibrate/lens/start', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    try {
      const started = deps.job.start(parsed.data);
      return { ok: true, started: true, ...started };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 이미 실행 중·타 잡 점유 = 재시도로 풀리는 일시 충돌 → 409. 설정 오류(소스/종류) → 400.
      reply.code(msg.includes('already running') || msg.startsWith('busy') ? 409 : 400);
      return { error: msg };
    }
  });

  app.post('/calibrate/lens/stop', async (_req, reply) => {
    try {
      return { ok: true, ...deps.job.stop() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: msg };
    }
  });

  app.get('/calibrate/lens/status', async (req, reply) => {
    const q = StatusQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      reply.code(400);
      return { error: 'invalid query', detail: q.error.flatten() };
    }
    reply.header('Cache-Control', 'no-store');
    return deps.job.getStatus(q.data.sinceSeq);
  });

  app.get('/calibrate/lens/result', async (req, reply) => {
    const source = (req.query as { source?: string } | undefined)?.source;
    if (!source) {
      reply.code(400);
      return { error: 'source required' };
    }
    const file = join(deps.resultDir, `lens_calib_result_${source}.json`);
    if (!existsSync(file)) {
      reply.code(404);
      return { error: 'no result' };
    }
    return JSON.parse(readFileSync(file, 'utf-8'));
  });

  // 표 활성/비활성. ★ sourceRegistry 는 프로세스 시작 시 표를 1회 로드하므로 **서버 재시작 전까지
  //   조준은 바뀌지 않는다**. 응답에 restartRequired 를 실어 UI 가 그 사실을 반드시 말하게 한다.
  app.post('/calibrate/lens/apply', async (req, reply) => {
    const parsed = ApplyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const entry = setLensCalibEnabled(deps.calibFile, parsed.data.source, parsed.data.enabled);
    if (!entry) {
      reply.code(400);
      return { error: `카메라 "${parsed.data.source}" 의 보정표가 없습니다 — 먼저 캘리브레이션을 실행하세요` };
    }
    return { ok: true, enabled: entry.enabled === true, restartRequired: true };
  });
}
