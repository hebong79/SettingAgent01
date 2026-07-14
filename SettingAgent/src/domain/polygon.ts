// 순수 기하 프리미티브 (설계서 §2-1) — 외부 의존 0.
// 좌표계 정규화(0~1), 소형 n(≤10). 볼록 다각형 전제(비겹침 반평면 클리핑 견고성).
// 각 함수는 부작용 없이 새 배열/값을 반환하며 단위테스트 가능하게 export 한다.

import type { NormalizedPoint, NormalizedPolygon, NormalizedRect } from './types.js';

/** 반평면: `n·(x − p0) ≥ 0` 인 점을 유지(keep)한다. */
export interface HalfPlaneLine {
  p0: NormalizedPoint;
  n: NormalizedPoint;
}

const EPS = 1e-9;

/**
 * 볼록껍질(Andrew monotone chain). 중복·일직선 정점 제거. 점 ≤2 면 그대로(정렬·중복제거) 반환.
 * 반환 순서는 수학적 CCW(원좌표). 캐노니컬 정렬은 호출측(floorRoi)이 수행.
 */
export function convexHull(points: NormalizedPoint[]): NormalizedPoint[] {
  const pts = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const uniq: NormalizedPoint[] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;
  const cross = (o: NormalizedPoint, a: NormalizedPoint, b: NormalizedPoint) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: NormalizedPoint[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: NormalizedPoint[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 다각형 면적(shoelace 절댓값). */
export function polygonArea(poly: readonly NormalizedPoint[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 다각형 부호면적(원좌표 shoelace). 감김방향 판정용(양수=CCW·원좌표). */
export function polygonSignedArea(poly: readonly NormalizedPoint[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 다각형 무게중심(면적가중). 퇴화(면적≈0) 시 정점 평균. */
export function polygonCentroid(poly: readonly NormalizedPoint[]): NormalizedPoint {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cr = p.x * q.y - q.x * p.y;
    a += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / n,
      y: poly.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** 점이 다각형 내부(경계 포함 근사)에 있는가 — ray casting(core.js pointInQuad 의 TS판). */
export function pointInPolygon(poly: readonly NormalizedPoint[], p: NormalizedPoint): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    const intersect =
      pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 사각형 4모서리(TL,TR,BR,BL). */
export function rectCorners(r: NormalizedRect): [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** 단일 반평면(Sutherland–Hodgman) 클립. `n·(x−p0) ≥ 0` 유지. 결과 정점 0개 가능. */
export function clipByHalfPlane(poly: readonly NormalizedPoint[], line: HalfPlaneLine): NormalizedPoint[] {
  if (poly.length === 0) return [];
  const side = (p: NormalizedPoint) => line.n.x * (p.x - line.p0.x) + line.n.y * (p.y - line.p0.y);
  const out: NormalizedPoint[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const sc = side(cur);
    const sn = side(nxt);
    if (sc >= -EPS) out.push(cur);
    if ((sc > EPS && sn < -EPS) || (sc < -EPS && sn > EPS)) {
      const t = sc / (sc - sn);
      out.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
    }
  }
  return out;
}

/** 볼록 A ∩ B 면적 — A 를 B 각 변(내향 반평면)으로 클립 후 면적. 겹침 판정·측정용. */
export function convexIntersectionArea(a: readonly NormalizedPoint[], b: readonly NormalizedPoint[]): number {
  if (a.length < 3 || b.length < 3) return 0;
  let poly: NormalizedPoint[] = a.map((p) => ({ x: p.x, y: p.y }));
  const c = polygonCentroid(b);
  for (let i = 0; i < b.length; i++) {
    const p1 = b[i];
    const p2 = b[(i + 1) % b.length];
    let n: NormalizedPoint = { x: -(p2.y - p1.y), y: p2.x - p1.x };
    const d = n.x * (c.x - p1.x) + n.y * (c.y - p1.y);
    if (d < 0) n = { x: -n.x, y: -n.y };
    poly = clipByHalfPlane(poly, { p0: p1, n });
    if (poly.length === 0) return 0;
  }
  return polygonArea(poly);
}

/** 두 무게중심의 수직이등분선(비겹침 분리선 기본값). 법선 n 은 cA 측을 유지한다. */
export function perpBisector(cA: NormalizedPoint, cB: NormalizedPoint): HalfPlaneLine {
  return {
    p0: { x: (cA.x + cB.x) / 2, y: (cA.y + cB.y) / 2 },
    n: { x: cA.x - cB.x, y: cA.y - cB.y },
  };
}
