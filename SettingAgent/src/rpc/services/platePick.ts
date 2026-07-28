// plate.pickAt 승격 서비스(설계서 §7-11) — "선택한 차량 번호판 위치".
//
// 지금까지 "클릭 지점 최근접 번호판" 은 `PtzCalibrator.centerOnPoint` **안에만** 있었다
// (그것도 즉시 카메라를 움직이는 부수효과와 함께). 외부 제어자가 *조회만* 할 방법이 없었다.
// → 같은 선택 규칙(`pickNearestPlate`)을 **읽기 전용**으로 노출한다. 카메라를 움직이지도, DB 를 쓰지도 않는다.
//
// 파이프라인: plate.detect(전체 목록) → **plate.pickAt(지점 선택)** → plate.assign(DB 저장) → center.point(조준)

import { z } from 'zod';
import { pickNearestPlate } from '../../calibrate/controlMath.js';
import { quadBoundingRect, center as rectCenter } from '../../domain/geometry.js';
import { assignPlatesToSlotViews } from '../../setup/plateMatch.js';
import { CameraSourceClient } from '../../clients/CameraSourceClient.js';
import type { ICameraClient } from '../../clients/CameraClient.js';
import { RpcCode, RpcMethodError } from '../errors.js';
import type { RpcContext } from '../types.js';

export const PlatePickAtSchema = z.object({
  cam: z.number().int().positive(),
  preset: z.number().int().positive(),
  /** 정규화 화면 좌표(0~1) — 조작자가 가리킨 지점. */
  point: z.object({ x: z.number(), y: z.number() }),
  /**
   * 선택 반경(정규화). 이 밖의 판은 **채택하지 않는다** — 화면에 판이 하나뿐이면 어디를 찍어도
   * 그것이 선택되는 거짓 성공을 막는다(centerOnPoint 의 initialRadiusNorm 기본값과 같은 0.10).
   */
  radius: z.number().positive().max(1).default(0.1),
  source: z.string().min(1).optional(),
});

/** source 지정 시 그 소스로, 아니면 파이프라인 카메라. 둘 다 없으면 UNAVAILABLE. */
function resolveCamera(ctx: RpcContext, source?: string): ICameraClient {
  if (source) {
    const src = ctx.deps.cameraCfg ? ctx.deps.sources?.get(source) : undefined;
    if (!src) throw new RpcMethodError(RpcCode.INVALID_PARAMS, 'source not found', { source });
    return new CameraSourceClient(src, ctx.deps.cameraCfg!);
  }
  if (!ctx.deps.camera) throw new RpcMethodError(RpcCode.UNAVAILABLE, '카메라 미배선');
  return ctx.deps.camera;
}

export async function platePickAt(raw: unknown, ctx: RpcContext): Promise<unknown> {
  const p = PlatePickAtSchema.parse(raw);
  const lpd = ctx.deps.lpd;
  if (!lpd) throw new RpcMethodError(RpcCode.UNAVAILABLE, 'LPD 미배선');
  const camera = resolveCamera(ctx, p.source);

  let jpg: Buffer;
  try {
    const img = await camera.requestImage(p.cam, p.preset);
    jpg = img.jpg;
  } catch (err) {
    throw new RpcMethodError(RpcCode.UPSTREAM, '프레임 캡처 실패', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let plates;
  try {
    plates = await lpd.detect(jpg);
  } catch (err) {
    throw new RpcMethodError(RpcCode.UPSTREAM, 'LPD 검출 실패', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 클릭점을 크기 0 인 rect 로 넘긴다 — 기존 centerOnPoint 가 쓰는 관용구 그대로(선택 규칙 단일 구현).
  const best = pickNearestPlate(plates, { x: p.point.x, y: p.point.y, w: 0, h: 0 });
  if (!best) {
    return { ok: false, reason: 'no_plate_detected', plateCount: 0, cam: p.cam, preset: p.preset };
  }
  const c = rectCenter(quadBoundingRect(best.quad));
  const distance = Math.hypot(c.cx - p.point.x, c.cy - p.point.y);
  if (distance > p.radius) {
    // 위장 금지 — 반경 밖 판을 "대신 채택" 하지 않는다. 무엇이 얼마나 떨어져 있었는지는 돌려준다.
    return {
      ok: false,
      reason: 'no_plate_within_radius',
      plateCount: plates.length,
      nearestDistance: distance,
      radius: p.radius,
      cam: p.cam,
      preset: p.preset,
    };
  }

  // 슬롯 후보(선택) — DB 가 배선돼 있으면 "이 번호판이 어느 주차면인가" 까지 답한다.
  // 배정 규칙은 plate.assign(=POST /capture/slots/lpd)과 **같은 함수**를 쓴다(두 답이 갈리지 않게).
  let slotId: number | null = null;
  const store = ctx.deps.store;
  if (store) {
    const views = store.getSlotSetup().filter((v) => v.camId === p.cam && v.presetId === p.preset && v.roi?.length >= 3);
    const assigned = assignPlatesToSlotViews(views, [best]);
    slotId = [...assigned.keys()][0] ?? null;
  }

  return {
    ok: true,
    cam: p.cam,
    preset: p.preset,
    quad: best.quad,
    confidence: best.confidence,
    center: { x: c.cx, y: c.cy },
    distance,
    plateCount: plates.length,
    slotId,
  };
}
