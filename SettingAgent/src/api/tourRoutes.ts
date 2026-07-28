import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TourJob } from '../capture/TourJob.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraSource } from '../viewer/CameraSource.js';
import { resolveSourceCamera } from './routeHelpers.js';

const StartBodySchema = z
  .object({
    /** 각 위치 정지 시간(ms). 미지정 시 잡 기본값 1000(웹과 동일). */
    dwellMs: z.number().int().min(0).max(10000).optional(),
    /** 카메라 소스 지정(미지정 시 파이프라인 카메라) — /calibrate/point 와 동일 관용구. */
    source: z.string().min(1).optional(),
  })
  .default({});

export interface TourRouteDeps {
  job: TourJob;
  sources?: Map<string, CameraSource>;
  cameraCfg?: ToolsConfig['camera'];
  /**
   * 전역 카메라 점유 판정(index.ts 의 rpcBusy 와 같은 클로저).
   * ★ RPC 는 requiresCamera 게이트로 막히지만 **REST 직접 호출은 dispatch 를 안 탄다** —
   *   최종 방어선이 라우트에 있어야 렌즈 캘리브레이션 등과의 카메라 점유 경합을 막는다(설계 R5).
   */
  isBusy?: () => { busy: boolean; who?: string };
}

/**
 * /capture/tour/* 라우트 등록(discoverRoutes 패턴, 얇은 진입점). 기존 라우트 불변·가산.
 * 계획 산출·순회 로직은 TourJob/touringPlan 소유 — 이 파일은 검증과 상태코드만 책임진다.
 */
export function registerTourRoutes(app: FastifyInstance, deps: TourRouteDeps): void {
  app.post('/capture/tour/start', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const busy = deps.isBusy?.();
    if (busy?.busy) {
      reply.code(409);
      return { error: `busy — 다른 잡이 카메라를 사용 중입니다${busy.who ? ` (${busy.who})` : ''}` };
    }
    const resolved = resolveSourceCamera(deps, parsed.data.source, reply);
    if (!resolved) return; // source 미해석 → 400 전송 완료.
    try {
      const started = deps.job.start({
        ...(parsed.data.dwellMs !== undefined ? { dwellMs: parsed.data.dwellMs } : {}),
        ...(resolved.camera ? { camera: resolved.camera } : {}),
      });
      return { ok: true, started: true, ...started };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // setup_result 부재는 "값 없음"(404) — 기능은 있는데 정밀수집 결과가 아직 없다는 뜻.
      // 그 외(중복 시작·순회 대상 0)는 409 — 문자열이 BUSY/CONFLICT 를 가른다(errors.ts classify409).
      reply.code(msg === 'no setup_result' ? 404 : 409);
      return { error: msg };
    }
  });

  // 멱등 — idle 이어도 200(정지 요청은 몇 번 눌러도 같은 뜻이다).
  app.post('/capture/tour/stop', async () => {
    deps.job.stop();
    return { ok: true, state: deps.job.getStatus().state };
  });

  app.get('/capture/tour/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return deps.job.getStatus();
  });
}
