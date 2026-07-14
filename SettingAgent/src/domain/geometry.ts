import type { NormalizedRect, NormalizedQuad, NormalizedPoint } from './types.js';

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

/** 수열의 중앙값(빈 배열이면 0). 짝수 길이는 가운데 두 값의 평균. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
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

/**
 * 픽셀 4점(OBB) → 정규화 NormalizedQuad(0~1 클램프). 점 순서 보존.
 * LPD OBB 응답(TL→TR→BR→BL, 픽셀)을 캡처 해상도로 정규화. 길이!=4 면 throw.
 */
export function normalizeQuad(
  pts: [number, number][],
  imgW: number,
  imgH: number,
): NormalizedQuad {
  if (pts.length !== 4) {
    throw new Error(`normalizeQuad: 4점 필요(받은 점 수=${pts.length})`);
  }
  const p = pts.map(([px, py]) => ({ x: clamp01(px / imgW), y: clamp01(py / imgH) }));
  return [p[0], p[1], p[2], p[3]];
}

/** quad → 축정렬 bounding rect(min/max). 캘리브레이션·집계용 rect 유도. */
export function quadBoundingRect(q: NormalizedQuad): NormalizedRect {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * quad 4점의 **산술평균** 중심. `web/core.js:quadCentroid` 와 **동일 정의**(파리티: `test/quadCentroidParity.test.ts`).
 * 점유 판정(`web/core.js:computeOccupancy`)이 번호판 중심을 이 정의로 잡으므로,
 * **점유에 관여하는 서버 로직은 반드시 이 함수를 써야 한다**(정의가 갈리면 점유가 조용히 뒤집힌다 — D-1).
 * 주의: `polygon.ts:polygonCentroid`(면적가중)·`center(quadBoundingRect(q))`(bbox 중심)와 **값이 다르다**.
 * 세 정의는 중심대칭 quad(직사각형·회전 OBB)에서만 일치한다.
 */
export function quadCentroid(q: NormalizedQuad): NormalizedPoint {
  let sx = 0;
  let sy = 0;
  for (const p of q) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / 4, y: sy / 4 };
}

/** rect → 축정렬 quad(하위호환 승격). TL,TR,BR,BL 순서. */
export function rectToQuad(r: NormalizedRect): NormalizedQuad {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/**
 * 번호판 OBB quad(TL,TR,BR,BL)의 기울기(이미지 좌표 기준 하단변 방향, rad).
 * 상단변(TL→TR)·하단변(BL→BR) 평균 방향으로 산출해 점순서 뒤바뀜·노이즈에 강건.
 * 퇴화(평균벡터≈0, 예: 면적0) 시 0 반환.
 */
export function plateAngleRad(quad: NormalizedQuad): number {
  const dx = quad[1].x - quad[0].x + (quad[2].x - quad[3].x);
  const dy = quad[1].y - quad[0].y + (quad[2].y - quad[3].y);
  if (Math.hypot(dx, dy) < 1e-9) return 0;
  return Math.atan2(dy, dx);
}

/** 점들을 단위축 (ax,ay) 에 투영한 스팬(max−min). 로컬 OBB 크기 산출용. 빈 배열 0. */
export function projectedSpan(pts: readonly NormalizedPoint[], ax: number, ay: number): number {
  if (pts.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    const d = p.x * ax + p.y * ay;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return max - min;
}

// ── 강건 통계 헬퍼(집계 대표값 강건화 §2) — 무상태·0클램프 방어, O(N log N). ──

/** 각도를 (-π, π] 로 래핑(내부 보조). */
function wrapToPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/**
 * 축(axial, 주기 π) 각도 래핑 → (-π/2, π/2]. 선(line) 방향은 π-반전이 같은 자세이므로
 * 각도 배증(2a) 후 (-π,π] 래핑·2등분. Aggregator 의 축 잔차(residual) 계산에 사용.
 */
export function axialWrap(a: number): number {
  return wrapToPi(2 * a) / 2;
}

/** 중앙절대편차(raw, 미스케일). center 미지정 시 median(values) 기준. 길이<2 → 0. */
export function mad(values: number[], center?: number): number {
  if (values.length < 2) return 0;
  const c = center ?? median(values);
  return median(values.map((v) => Math.abs(v - c)));
}

/**
 * 가중 median. values·weights 동일 길이. 가중치 누적이 총합 절반을 처음 넘는 값.
 * 경계(누적 == 절반)에서는 다음 유효값과 평균(짝수 median 규약 정합 → 등가중이면 median 과 동일).
 * weights 전부 0/음수·빈배열 → 일반 median 폴백. (지터·이상치 강건 + conf 반영)
 */
export function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  let total = 0;
  for (const w of weights) if (w > 0) total += w;
  if (total <= 0) return median(values);
  const pairs = values
    .map((v, i) => ({ v, w: weights[i] > 0 ? weights[i] : 0 }))
    .sort((a, b) => a.v - b.v);
  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    cum += pairs[i].w;
    if (cum > half) return pairs[i].v;
    if (cum === half) {
      for (let j = i + 1; j < pairs.length; j++) {
        if (pairs[j].w > 0) return (pairs[i].v + pairs[j].v) / 2;
      }
      return pairs[i].v;
    }
  }
  return pairs[pairs.length - 1].v;
}

/** 좌표별 median 점(기하 median 근사). 빈 배열 → {x:0,y:0}. */
export function medianPoint(pts: NormalizedPoint[]): NormalizedPoint {
  if (pts.length === 0) return { x: 0, y: 0 };
  return { x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)) };
}

/**
 * 축(axial, 주기 π) 강건 각도 대표값. 각도배증(2θ)+피벗기준 언랩+(가중)median → (-π/2, π/2].
 * weights 주면 가중 median(선택). 길이 0 → 0, 1 → angles[0] 를 (-π/2, π/2] 로 폴딩.
 * 번호판은 선 방향(π-주기)이라 점순서 뒤바뀜(θ↔θ+π)을 배증으로 흡수한다.
 */
export function circularMedianAngle(angles: number[], weights?: number[]): number {
  if (angles.length === 0) return 0;
  if (angles.length === 1) return axialWrap(angles[0]);
  const w = weights ?? angles.map(() => 1);
  const phi = angles.map((a) => 2 * a); // 1) 각도 배증
  // 2) 가중 벡터평균 피벗(이상치 1개가 무한대로 끌지 못함).
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < phi.length; i++) {
    const wi = w[i] > 0 ? w[i] : 0;
    sx += wi * Math.cos(phi[i]);
    sy += wi * Math.sin(phi[i]);
  }
  const phi0 = Math.atan2(sy, sx);
  // 3) 피벗 기준 언랩(브랜치컷 제거) → 4) (가중) median.
  const unwrapped = phi.map((p) => phi0 + wrapToPi(p - phi0));
  const m = weights ? weightedMedian(unwrapped, w) : median(unwrapped);
  // 5) 2등분 후 (-π/2, π/2] 복원.
  return wrapToPi(m) / 2;
}

/** 축(주기 π) 각도 분산 = median(|axialWrap(θᵢ − center)|). 각도 이상치·퍼짐 척도. 길이<2 → 0. */
export function circularMad(angles: number[], center: number): number {
  if (angles.length < 2) return 0;
  return median(angles.map((a) => Math.abs(axialWrap(a - center))));
}

/**
 * 중심·각도·크기 → 번호판 대표 quad(TL,TR,BR,BL, 각 점 clamp01).
 * 로컬 축 u=(cosθ,sinθ)=폭방향(하변), v=(−sinθ,cosθ)=높이방향.
 * 하변(TL→TR) 방향 = theta 이므로 plateAngleRad(결과) == theta(경계 클램프 없을 때 규약 정합).
 */
export function synthesizePlateQuad(
  c: NormalizedPoint,
  theta: number,
  w: number,
  h: number,
): NormalizedQuad {
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const vx = -Math.sin(theta);
  const vy = Math.cos(theta);
  const hw = w / 2;
  const hh = h / 2;
  const corner = (su: number, sv: number): NormalizedPoint => ({
    x: clamp01(c.x + su * hw * ux + sv * hh * vx),
    y: clamp01(c.y + su * hw * uy + sv * hh * vy),
  });
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}
