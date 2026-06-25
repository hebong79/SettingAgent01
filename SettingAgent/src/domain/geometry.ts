import type { NormalizedRect } from './types.js';

/** 사각형 중심점. */
export function center(r: NormalizedRect): { cx: number; cy: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
}

/** 사각형 면적. */
export function area(r: NormalizedRect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** 두 사각형의 교집합 면적. */
export function intersectionArea(a: NormalizedRect, b: NormalizedRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** IoU (Intersection over Union). */
export function iou(a: NormalizedRect, b: NormalizedRect): number {
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** 점이 사각형 내부에 있는가. */
export function containsPoint(r: NormalizedRect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** 사각형을 padding 비율만큼 확장(0~1 범위로 클램프). */
export function pad(r: NormalizedRect, padding: number): NormalizedRect {
  const dx = r.w * padding;
  const dy = r.h * padding;
  const x = Math.max(0, r.x - dx);
  const y = Math.max(0, r.y - dy);
  const w = Math.min(1 - x, r.w + 2 * dx);
  const h = Math.min(1 - y, r.h + 2 * dy);
  return { x, y, w, h };
}

/** 값을 0~1 로 클램프. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 사각형을 0~1 범위로 클램프(x+w, y+h 도 1 을 넘지 않게). 음수/경계초과 방어. */
export function clampRect(r: NormalizedRect): NormalizedRect {
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  const w = clamp01(r.x + r.w) - x;
  const h = clamp01(r.y + r.h) - y;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

/** 픽셀 bbox [x1,y1,x2,y2] 를 이미지 크기로 정규화(0~1 클램프). */
export function normalizeBox(
  box: [number, number, number, number],
  imgW: number,
  imgH: number,
): NormalizedRect {
  const [x1, y1, x2, y2] = box;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return clampRect({
    x: left / imgW,
    y: top / imgH,
    w: Math.abs(x2 - x1) / imgW,
    h: Math.abs(y2 - y1) / imgH,
  });
}
