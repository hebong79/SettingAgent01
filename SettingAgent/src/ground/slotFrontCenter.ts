import { backprojectToGround, projectCuboidPixels, frontFaceCenterPx } from './project.js';
import type { GroundModel } from './types.js';
import type { Vec3 } from './contactTypes.js';
import type { NormalizedPoint } from '../domain/types.js';

/** slot_setup 앞면 중심 DB 저장용 캐노니컬 높이(m). 뷰어 슬라이더 기본값과 동일. */
export const H_CONST = 1.5;

/**
 * 정규화 슬롯 quad(4점) + GroundModel + 높이 → 앞면 중심(정규화 0..1) | null.
 * points→픽셀→backprojectToGround→projectCuboidPixels(h)→frontFaceCenterPx→ /imgW,/imgH.
 * 지면모델 퇴화(지평선 위 등)/코너 수 이상 → null(강등, 저장은 null).
 */
export function slotFrontCenter(points: NormalizedPoint[], g: GroundModel, h: number): { x: number; y: number } | null {
  if (!Array.isArray(points) || points.length !== 4) return null;
  const floorGround: Vec3[] = [];
  for (const p of points) {
    const X = backprojectToGround({ x: p.x * g.imgW, y: p.y * g.imgH }, g);
    if (!X) return null;
    floorGround.push(X);
  }
  const corners = projectCuboidPixels(floorGround, h, g);
  if (!corners) return null;
  const c = frontFaceCenterPx(corners);
  if (!c) return null;
  return { x: c.x / g.imgW, y: c.y / g.imgH };
}
