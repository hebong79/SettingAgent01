import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PtzCalibrator } from '../calibrate/PtzCalibrator.js';
import type { ICameraClient } from '../clients/CameraClient.js';
import { CameraSourceClient } from '../clients/CameraSourceClient.js';
import type { CameraSource } from '../viewer/CameraSource.js';
import type { ToolsConfig } from '../config/toolsConfig.js';

const StartBodySchema = z.object({ slotIds: z.array(z.string()).optional() }).default({});

/** 개별(클릭) 센터라이징 요청 바디(설계서 §3.2). cam/preset 1-based, point 정규화(0~1). */
const PointBodySchema = z.object({
  cam: z.number().int().nonnegative(),
  preset: z.number().int().nonnegative(),
  point: z.object({ x: z.number(), y: z.number() }),
  // mode: 'point'=클릭 지점 자체를 화면중앙으로(pan/tilt·검출없음) / 'plate'=번호판 center / 'plate-zoom'=center+zoom.
  // 미전달 시 legacy zoom 불리언 경로(하위호환).
  mode: z.enum(['point', 'plate', 'plate-zoom']).optional(),
  zoom: z.boolean().optional(),
  // 명령 대상 카메라 소스 id(뷰어가 보고 있는 소스). 미지정 시 파이프라인 카메라(기존 동작).
  source: z.string().min(1).optional(),
});

export interface CalibrateRouteDeps {
  calibrator: PtzCalibrator;
  /** slot_ptz.json 경로(GET /calibrate/result). */
  outFile: string;
  /** 카메라 소스 레지스트리(옵셔널·가산). 주입 시에만 POST /calibrate/point 의 source 지정을 처리한다. */
  sources?: Map<string, CameraSource>;
  /** CameraSourceClient 조립용 카메라 설정(zoom 클램프). sources 와 함께 주입된다. */
  cameraCfg?: ToolsConfig['camera'];
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

  // 개별(클릭) 센터라이징(가산). 클릭 지점 최근접 번호판으로 pan/tilt(+옵션 zoom) 정렬 — 저장 없음.
  // 배치/개별 진행 경합 시 throw('running'|'busy') → 409, 그 외 예외 → 400.
  app.post('/calibrate/point', async (req, reply) => {
    const p = PointBodySchema.safeParse(req.body);
    if (!p.success) {
      reply.code(400);
      return { error: 'invalid body', detail: p.error.flatten() };
    }
    // source 지정 시 그 소스로만 명령한다(뷰어에서 보고 있는 카메라 = 명령 대상).
    // 요청마다 얇은 어댑터를 새로 만든다(상태 없음). 미지정이면 기존 파이프라인 카메라 그대로.
    let camera: ICameraClient | undefined;
    if (p.data.source) {
      const src = deps.cameraCfg ? deps.sources?.get(p.data.source) : undefined;
      if (!src) {
        reply.code(400);
        return { error: 'source not found' };
      }
      camera = new CameraSourceClient(src, deps.cameraCfg!);
    }
    try {
      if (p.data.mode === 'point') {
        // 클릭 지점 조준: 검출·저장 없이 그 지점을 화면중앙으로(zoom 불변).
        const a = await deps.calibrator.aimPointToCenter(p.data.cam, p.data.preset, p.data.point, camera ? { camera } : undefined);
        return { ok: a.ok, ptz: a.ptz, plateWidth: a.plateWidth, mode: a.mode, ...(a.reason ? { reason: a.reason } : {}) };
      }
      // 번호판 기반 centerOnPlate. mode 우선(plate=center만/plate-zoom=center+zoom), 없으면 legacy zoom 불리언.
      const zoom = p.data.mode ? p.data.mode === 'plate-zoom' : p.data.zoom;
      const r = await deps.calibrator.centerOnPoint(p.data.cam, p.data.preset, p.data.point, { zoom, ...(camera ? { camera } : {}) });
      return { ok: r.ok, ptz: r.ptz, plateWidth: r.plateWidth, ...(r.reason ? { reason: r.reason } : {}) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(msg.includes('running') || msg.includes('busy') ? 409 : 400);
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
