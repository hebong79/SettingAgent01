import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CaptureJob } from '../capture/CaptureJob.js';
import type { Finalizer } from '../capture/Finalizer.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { SetupTarget } from '../setup/SetupOrchestrator.js';
import { loadSetupTargets, type MapFiles } from '../setup/mapTargets.js';
import type { ToolsConfig } from '../config/toolsConfig.js';

const TargetSchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  label: z.string().optional(),
  ptz: z.object({ pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().optional() }).optional(),
});

const StartBodySchema = z.object({
  count: z.number().int().positive(),
  intervalMs: z.number().int().positive().optional(),
  checkpointEvery: z.number().int().positive().optional(),
  targets: z.array(TargetSchema).min(1).optional(),
});

const FinalizeBodySchema = z.object({ runId: z.number().int().positive().optional() }).default({});

export interface CaptureRouteDeps {
  job: CaptureJob;
  finalizer: Finalizer;
  store: SqliteStore;
  cfg: ToolsConfig['capture'];
  /** targets 미지정 시 camerapos 파일에서 로드. */
  mapFiles?: MapFiles;
}

/**
 * /capture/* 라우트 등록(설계서 §6.1). 기존 /setup/* 불변·가산.
 * 좌표·집계·LLM 로직은 CaptureJob/Finalizer 소유. 라우트는 얇은 진입점.
 */
export function registerCaptureRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  app.post('/capture/start', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    let targets: SetupTarget[];
    if (parsed.data.targets && parsed.data.targets.length > 0) {
      targets = parsed.data.targets;
    } else if (deps.mapFiles) {
      try {
        targets = loadSetupTargets(deps.mapFiles);
      } catch (err) {
        reply.code(400);
        return { error: 'target resolve failed', detail: err instanceof Error ? err.message : String(err) };
      }
    } else {
      reply.code(400);
      return { error: 'targets 미지정 + mapFiles 미설정' };
    }
    if (targets.length === 0) {
      reply.code(400);
      return { error: 'targets 비어 있음' };
    }
    try {
      const { runId } = deps.job.start({
        count: parsed.data.count,
        intervalMs: parsed.data.intervalMs ?? deps.cfg.intervalMs,
        checkpointEvery: parsed.data.checkpointEvery ?? deps.cfg.checkpointEvery,
        targets,
      });
      return { ok: true, runId };
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : 'capture already running' };
    }
  });

  app.get('/capture/status', async () => deps.job.getStatus());

  app.post('/capture/stop', async (_req, reply) => {
    const st = deps.job.getStatus();
    if (st.state !== 'running') {
      reply.code(400);
      return { error: 'not running', state: st.state };
    }
    deps.job.stop();
    return { ok: true, state: deps.job.getStatus().state };
  });

  app.post('/capture/finalize', async (req, reply) => {
    const parsed = FinalizeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const st = deps.job.getStatus();
    if (st.state === 'running' || st.state === 'stopping' || st.state === 'finalizing') {
      reply.code(409);
      return { error: 'capture still running', state: st.state };
    }
    const runId = parsed.data.runId ?? deps.job.getRunId() ?? deps.store.listRuns(1)[0]?.id;
    if (runId === undefined) {
      reply.code(404);
      return { error: 'no run to finalize' };
    }
    try {
      const r = await deps.finalizer.finalize(runId);
      return { ok: true, slots: r.slots, globalCount: r.globalCount };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/capture/runs', async () => deps.store.listRuns());

  app.get('/capture/runs/:id/aggregate', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid run id' };
    }
    const run = deps.store.getRun(id);
    if (!run) {
      reply.code(404);
      return { error: 'run not found' };
    }
    return deps.store.getAggregatedSlots(id);
  });
}
