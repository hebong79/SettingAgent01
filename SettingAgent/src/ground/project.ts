// 지면 역투영/투영(순수). GroundModel (f, n, d) 하나만 쓴다 — 신규 수학 0줄, 재유도 0줄.
//
// ★ 뷰어 web/core.js:projectCuboid 와 **같은 식**이어야 한다(D-1 의 교훈: 같은 개념이 두 곳에 있으면 조용히 갈라진다).
//   파리티 증명:
//     지면점 X = d·m / (n·m),  m = K⁻¹p        (p = 동차 픽셀 [x,y,1])
//     높이 h 점  X_h = X − h·n                  (n 은 **하향** 단위법선 → −n 이 위쪽)
//     K·X_h = (d/s₀)·K·m − h·(K·n) = (d/s₀)·p − h·kn        (K·m = p)
//     스케일 s₀/d 를 곱하면  p − h·(s₀/d)·kn   ← core.js 의 `p − h·s·kn`, s = (n·K⁻¹p)/d 와 항등.
//   즉 projectPointAtHeight 는 core.js 와 대수적으로 동일한 식이다(테스트 T-4 가 수치로 봉인).
//
// 강등 철학(groundModel.ts 와 동일): 퇴화(지평선 위·카메라 뒤)는 throw 금지 → **null 반환**. NaN 전파 0건.

import type { GroundModel } from './types.js';
import type { Px, Vec3 } from './contactTypes.js';

/** 지면 법선·시선 내적 하한. 이보다 작으면 지평선 위(지면점 아님). groundModel.ts 와 같은 값. */
const HORIZON_EPS = 1e-4;
/** 투영 분모(깊이 z) 하한(m). 카메라 뒤/평면 위 퇴화 방어. */
const DEPTH_EPS = 1e-6;

export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** 단위벡터. 길이 0/비유한 → null. */
export function unit3(a: Vec3): Vec3 | null {
  const n = Math.hypot(a[0], a[1], a[2]);
  if (!Number.isFinite(n) || n < 1e-12) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** 픽셀 → 카메라좌표 시선 m = K⁻¹p (정규화 안 함). 주점=이미지 중심, 정사각픽셀 가정. */
function rayOf(px: Px, g: GroundModel): Vec3 {
  return [(px.x - g.imgW / 2) / g.f, (px.y - g.imgH / 2) / g.f, 1];
}

/**
 * 픽셀 → **지면점**(카메라좌표 meter). X = d·m/(n·m).
 * 지평선 위(n·m ≤ eps)/모델 퇴화 → null.
 *
 * ★ 2D 지면 기저를 만들지 않는다 — 지면점끼리는 3D 유클리드 거리가 곧 지면 거리다(같은 평면 위).
 */
export function backprojectToGround(px: Px, g: GroundModel): Vec3 | null {
  if (!(g.f > 0) || !(g.d > 0) || !(g.imgW > 0) || !(g.imgH > 0)) return null;
  if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null;
  const m = rayOf(px, g);
  const s = dot3(g.n as Vec3, m);
  if (!(s > HORIZON_EPS)) return null;
  const k = g.d / s;
  const X: Vec3 = [m[0] * k, m[1] * k, m[2] * k];
  return X.every(Number.isFinite) ? X : null;
}

/** 카메라좌표 3D 점 → 픽셀. 카메라 뒤/광심(z ≤ eps) → null. */
export function projectToPixel(X: Vec3, g: GroundModel): Px | null {
  if (!(g.f > 0) || !(g.imgW > 0) || !(g.imgH > 0)) return null;
  if (!X.every(Number.isFinite) || !(X[2] > DEPTH_EPS)) return null;
  const x = (g.f * X[0]) / X[2] + g.imgW / 2;
  const y = (g.f * X[1]) / X[2] + g.imgH / 2;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** 지면점 → 픽셀(왕복 검증용 별칭 — backprojectToGround 의 역). */
export function projectGroundToPixel(X: Vec3, g: GroundModel): Px | null {
  return projectToPixel(X, g);
}

/**
 * 지면점 **바로 위 높이 h** 인 점의 픽셀. X_h = X − h·n (n 은 하향 법선).
 * 뷰어 projectCuboid 의 상면 투영과 대수적으로 동일(파일 상단 파리티 증명).
 */
export function projectPointAtHeight(ground: Vec3, h: number, g: GroundModel): Px | null {
  if (!Number.isFinite(h)) return null;
  const n = g.n as Vec3;
  return projectToPixel([ground[0] - h * n[0], ground[1] - h * n[1], ground[2] - h * n[2]], g);
}

/** 바닥 4모서리 edge(코너 순서 규약). 앞면은 이 중 카메라 최근접 edge(뷰어 web/core.js CUBOID_BOTTOM_EDGES 동일). */
const BOTTOM_EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [3, 0]];

/**
 * 육면체 앞면(근접면) 4 corner 인덱스 — **감김순서 불변**. 뷰어 web/core.js frontFaceCornerIdx 와 **동일 정의**.
 * projectCuboidPixels 순서 규약: [바닥 0..3, 상면 4..7(같은 순서)]. 바닥 감김은 프리셋마다 회전될 수 있어
 * 고정 인덱스([0,3,7,4]) 대신 기하로 판정한다: 바닥 4 edge 중 두 끝점 y 평균이 최대(하향 틸트 카메라에서
 * y 클수록 최근접=화면 아래=앞) 인 edge 의 두 바닥 corner a,b → 앞면 = [a, b, a+4, b+4](대응 상면 포함).
 * 상면은 위로 올라가 y 가 작아지므로 판정엔 바닥 y 만 쓴다. bottomY = 바닥 corner 0..3 의 픽셀 y.
 */
function frontFaceCornerIdx(bottomY: readonly number[]): [number, number, number, number] {
  let best: readonly [number, number] = BOTTOM_EDGES[0];
  let bestVal = -Infinity;
  for (const [a, b] of BOTTOM_EDGES) {
    const avg = (bottomY[a] + bottomY[b]) / 2;
    if (avg > bestVal) {
      bestVal = avg;
      best = [a, b];
    }
  }
  const [a, b] = best;
  return [a, b, a + 4, b + 4];
}

/**
 * 육면체 앞면 중심 픽셀 = 근접면 4모서리 픽셀 산술평균. corners 길이≠8/비유한 → null.
 * 앞면 corner 는 frontFaceCornerIdx 로 감김순서-불변 판정 — 뷰어 frontFaceCenter 와 같은 정의(qa 파리티 대조).
 */
export function frontFaceCenterPx(corners: readonly Px[]): Px | null {
  if (corners.length !== 8) return null;
  const bottomY: number[] = [];
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    if (!c || !Number.isFinite(c.y)) return null;
    bottomY.push(c.y);
  }
  const idx = frontFaceCornerIdx(bottomY);
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    const c = corners[i];
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    sx += c.x;
    sy += c.y;
  }
  return { x: sx / idx.length, y: sy / idx.length };
}

/**
 * 지면 4점 + 높이 h → 육면체 8모서리의 픽셀. 하나라도 퇴화하면 **전체 null**(부분 육면체 금지).
 * 순서: [바닥 0..3, 상면 4..7] — 뷰어 projectCuboid.corners 와 같은 규약.
 */
export function projectCuboidPixels(
  floorGround: readonly Vec3[],
  h: number,
  g: GroundModel,
): Px[] | null {
  if (floorGround.length !== 4) return null;
  const out: Px[] = [];
  for (const X of floorGround) {
    const p = projectToPixel(X, g);
    if (!p) return null;
    out.push(p);
  }
  for (const X of floorGround) {
    const p = projectPointAtHeight(X, h, g);
    if (!p) return null;
    out.push(p);
  }
  return out;
}
