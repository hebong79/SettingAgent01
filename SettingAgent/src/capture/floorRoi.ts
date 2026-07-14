// 바닥 점유 영역(floor ROI · 가변 다각형 4~10점) 결정형 모듈 (설계서 §2·§3).
// 좌표는 모두 정규화(0~1). 볼록·시계방향, 시작=앞왼(max y, 동률 min x) — 4점 특수화는 [FL,FR,RR,RL] 규약과 동일.
// 검증·클램프·정렬·마진·번호판 포함강제·비겹침은 전부 결정형(LLM 은 좌표 "생성"만).

import type { NormalizedRect, NormalizedPolygon, NormalizedPoint, NormalizedQuad } from '../domain/types.js';
import {
  convexHull,
  polygonCentroid,
  polygonSignedArea,
  pointInPolygon,
  rectCorners,
  clipByHalfPlane,
  convexIntersectionArea,
  perpBisector,
} from '../domain/polygon.js';
import { rectToQuad, quadBoundingRect, plateAngleRad, projectedSpan } from '../domain/geometry.js';
import { logger } from '../util/logger.js';

// ── 번호판 기준 사변형(buildPlateAnchoredQuad) 배치 상수 ────────────────
// QA/육안 검증 후 이 4개만 미세조정한다(참조 이미지 눈대중 초기값).
/** 사변형 좌우폭 하한 = 차량 bbox 폭 × 비율. */
const FLOOR_WIDTH_RATIO = 1.0;
/** 사변형 앞뒤깊이 하한 = 차량 bbox 높이 × 비율. */
const FLOOR_DEPTH_RATIO = 0.55;
/** 앞변에서 번호판 중심까지 비율(<0.5 = 중앙보다 앞/아래, 카메라 쪽). */
const PLATE_FRONT_RATIO = 0.42;
/** 번호판 포함 여유(W·D 하한을 번호판 span×(1+margin) 로 보정). */
const PLATE_CONTAIN_MARGIN = 0.15;

/** R1 여유마진: 무게중심 기준 방사 확장 비율(LLM 다각형 정규화 경로에서만 사용). */
const POLY_MARGIN = 0.03;
/** R3 번호판 예상 박스(차량 앞면 하단 중앙 밴드) 상수 — bbox 상대 위치. */
const PLATE_X_OFFSET = 0.3;
const PLATE_WIDTH = 0.4;
const PLATE_Y_OFFSET = 0.72;
const PLATE_HEIGHT = 0.18;
/** 비겹침 겹침 판정 임계. */
const OVERLAP_EPS = 1e-6;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * R3: 번호판 예상 박스. 번호판은 차량 앞면 하단 중앙 → bbox 하단 30~40% 중앙 밴드.
 * plate 인자 부재 시 이 rect 를 포함강제 대상으로 사용한다.
 */
export function predictPlateRect(vehicle: NormalizedRect): NormalizedRect {
  const x = clamp01(vehicle.x + vehicle.w * PLATE_X_OFFSET);
  const y = clamp01(vehicle.y + vehicle.h * PLATE_Y_OFFSET);
  return {
    x,
    y,
    w: Math.min(vehicle.w * PLATE_WIDTH, 1 - x),
    h: Math.min(vehicle.h * PLATE_HEIGHT, 1 - y),
  };
}

/** 이웃(같은 프리셋 그룹·번호판 보유) 슬롯 1개. estimatePlateQuadFromNeighbors 입력. */
export interface PlateNeighbor {
  vehicle: NormalizedRect;
  plateQuad: NormalizedQuad;
}

/**
 * 이웃(같은 프리셋 그룹·번호판 보유) 슬롯의 번호판 각도·상대오프셋·상대크기를
 * target 차량 bbox 에 적용해 예상 번호판 quad(규약 TL,TR,BR,BL)를 합성한다.
 * 위치 최근접 이웃 1개만 채택(행 원근 그래디언트 추종, 중앙값 아님).
 * 유효 이웃 0개면 undefined(호출측이 predictPlateRect 상수 폴백). 각 점 0~1 클램프.
 */
export function estimatePlateQuadFromNeighbors(
  vehicle: NormalizedRect,
  neighbors: readonly PlateNeighbor[],
): NormalizedQuad | undefined {
  const vcx = vehicle.x + vehicle.w / 2;
  const vcy = vehicle.y + vehicle.h / 2;
  // 위치 최근접(정규화 유클리드 거리) 이웃 1개 채택. degenerate bbox(w/h≈0) 이웃은 제외.
  let best: PlateNeighbor | undefined;
  let bestDist = Infinity;
  for (const n of neighbors) {
    if (n.vehicle.w < 1e-6 || n.vehicle.h < 1e-6) continue;
    const ncx = n.vehicle.x + n.vehicle.w / 2;
    const ncy = n.vehicle.y + n.vehicle.h / 2;
    const d = (ncx - vcx) ** 2 + (ncy - vcy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  if (!best) return undefined;

  const nv = best.vehicle;
  const qN = best.plateQuad;
  const theta = plateAngleRad(qN);
  // 이웃 번호판 중심의 bbox 내 분수 위치(상대오프셋). predictPlateRect 기본 rx≈0.5·ry≈0.72 와 동일 개념.
  const pcNx = (qN[0].x + qN[1].x + qN[2].x + qN[3].x) / 4;
  const pcNy = (qN[0].y + qN[1].y + qN[2].y + qN[3].y) / 4;
  const rx = (pcNx - nv.x) / nv.w;
  const ry = (pcNy - nv.y) / nv.h;
  // 로컬 단위축: right=하단변(TL→TR) 방향, down=이미지 아래(right 에 직교).
  const rightX = Math.cos(theta);
  const rightY = Math.sin(theta);
  const downX = -Math.sin(theta);
  const downY = Math.cos(theta);
  // 이웃 번호판의 로컬 크기 → bbox 대비 상대크기.
  const rw = projectedSpan(qN, rightX, rightY) / nv.w;
  const rh = projectedSpan(qN, downX, downY) / nv.h;
  // target 차량 bbox 스케일로 적용(중심·반폭·반높이).
  const pcTx = vehicle.x + rx * vehicle.w;
  const pcTy = vehicle.y + ry * vehicle.h;
  const hw = (rw * vehicle.w) / 2;
  const hh = (rh * vehicle.h) / 2;
  const corner = (sw: number, sh: number): NormalizedPoint => ({
    x: clamp01(pcTx + sw * hw * rightX + sh * hh * downX),
    y: clamp01(pcTy + sw * hw * rightY + sh * hh * downY),
  });
  // TL(-,-), TR(+,-), BR(+,+), BL(-,+).
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** 볼록껍질 정점을 캐노니컬 정렬(감김=원좌표 음부호, 시작=max y·동률 min x). 4점 시 [FL,FR,RR,RL] 재현. */
function orderConvexCanonical(hull: NormalizedPoint[]): NormalizedPoint[] {
  if (hull.length < 3) return hull;
  const ring = polygonSignedArea(hull) > 0 ? [...hull].reverse() : [...hull];
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    if (ring[i].y > ring[start].y || (ring[i].y === ring[start].y && ring[i].x < ring[start].x)) start = i;
  }
  return ring.slice(start).concat(ring.slice(0, start));
}

/** R1 마진: 무게중심 기준 방사 확장 후 0~1 클램프. */
function applyMargin(poly: NormalizedPolygon): NormalizedPolygon {
  const c = polygonCentroid(poly);
  return poly.map((p) => ({
    x: clamp01(c.x + (p.x - c.x) * (1 + POLY_MARGIN)),
    y: clamp01(c.y + (p.y - c.y) * (1 + POLY_MARGIN)),
  }));
}

/** 면적기여 최소 정점부터 제거해 정점 수를 max 이하로 단순화(볼록 유지). */
function simplifyToMax(poly: NormalizedPolygon, max: number): NormalizedPolygon {
  const pts = [...poly];
  while (pts.length > max) {
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const tri = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
      if (tri < bestArea) {
        bestArea = tri;
        bestIdx = i;
      }
    }
    pts.splice(bestIdx, 1);
  }
  return pts;
}

/**
 * 번호판(OBB quad)의 각도·위치를 기준으로 구성한 4점 회전 사변형(항상 존재 보장).
 * 번호판이 좌우 중앙·세로 약간앞(PLATE_FRONT_RATIO)에 놓이고, 번호판 각도만큼 기운다.
 * plateQuad 부재 시 각도=0 + 예상 번호판(predictPlateRect)을 가상 번호판으로 사용.
 */
export function buildPlateAnchoredQuad(
  vehicle: NormalizedRect,
  plateQuad?: NormalizedQuad,
): NormalizedQuad {
  const plate: NormalizedQuad = plateQuad ?? rectToQuad(predictPlateRect(vehicle));
  const theta = plateQuad ? plateAngleRad(plateQuad) : 0;
  // 로컬 축: nb=앞→뒤(카메라 반대, 이미지 위). 앞(-nb)=이미지 하단 되도록 nb.y<0 부호 정규화.
  let nb = { x: Math.sin(theta), y: -Math.cos(theta) };
  if (nb.y > 0) nb = { x: -nb.x, y: -nb.y };
  const u = { x: -nb.y, y: nb.x }; // nb 에 직교하는 좌우축.
  // 번호판 로컬 크기·중심.
  const wp = projectedSpan(plate, u.x, u.y);
  const hp = projectedSpan(plate, nb.x, nb.y);
  const pc = {
    x: (plate[0].x + plate[1].x + plate[2].x + plate[3].x) / 4,
    y: (plate[0].y + plate[1].y + plate[2].y + plate[3].y) / 4,
  };
  // 크기: bbox 유도값과 번호판 span×(1+margin) 하한(포함 보장).
  const W = Math.max(vehicle.w * FLOOR_WIDTH_RATIO, wp * (1 + PLATE_CONTAIN_MARGIN));
  const D = Math.max(vehicle.h * FLOOR_DEPTH_RATIO, hp * (1 + PLATE_CONTAIN_MARGIN));
  // 중심: 좌우는 번호판 중심 유지(좌우중앙), 세로는 nb 방향으로만 이동(번호판을 앞쪽에).
  const shift = D * (0.5 - PLATE_FRONT_RATIO);
  const cq = { x: pc.x + nb.x * shift, y: pc.y + nb.y * shift };
  const corner = (sd: number, sw: number): NormalizedPoint => ({
    x: clamp01(cq.x + sd * (D / 2) * nb.x + sw * (W / 2) * u.x),
    y: clamp01(cq.y + sd * (D / 2) * nb.y + sw * (W / 2) * u.y),
  });
  // 앞=-nb(sd=-1), 뒤=+nb(sd=+1); 왼=-u(sw=-1), 오=+u(sw=+1).
  const raw: NormalizedPolygon = [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
  const ring = orderConvexCanonical(raw);
  return [ring[0], ring[1], ring[2], ring[3]] as NormalizedQuad;
}

/**
 * LLM raw 다각형 → 유효 NormalizedPolygon. 점 수 4~10 밖·NaN·전부 범위초과면 null(호출측이 폴백).
 * 각 점 0~1 클램프 + 볼록껍질 + 캐노니컬 정렬 + R1 마진. 껍질이 4정점 미만(공선 제거 포함)이면 null(min-4 불변식).
 */
export function normalizePolygon(raw: Array<{ x: number; y: number }> | undefined | null): NormalizedPolygon | null {
  if (!Array.isArray(raw) || raw.length < 4 || raw.length > 10) return null;
  const pts: NormalizedPoint[] = [];
  for (const p of raw) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || Number.isNaN(p.x) || Number.isNaN(p.y)) {
      return null;
    }
    pts.push({ x: clamp01(p.x), y: clamp01(p.y) });
  }
  const hull = orderConvexCanonical(convexHull(pts));
  if (hull.length < 4) return null;
  return applyMargin(hull);
}

/**
 * rect(번호판 bbox) 4모서리를 다각형이 모두 포함하도록 최소 확장(멱등, 축소 없음).
 * 밖 모서리가 있으면 (다각형 ∪ rect모서리) 볼록껍질 → 볼록 유지 + 포함 보장. 정점 >10 이면 단순화.
 */
export function expandPolygonToContainRect(poly: NormalizedPolygon, rect: NormalizedRect): NormalizedPolygon {
  const corners = rectCorners(rect);
  const outside = corners.filter((c) => !pointInPolygon(poly, c));
  if (outside.length === 0) return poly;
  let ordered = orderConvexCanonical(convexHull([...poly, ...corners]));
  if (ordered.length > 10) ordered = simplifyToMax(ordered, 10);
  return ordered.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
}

/**
 * 최종 진입점: LLM 유효 폴리곤이 메인(원근 접지면 추정 권위). → 항상 유효 NormalizedPolygon.
 * LLM 유효 시 normalizePolygon 안전망(클램프·볼록껍질·정렬·마진)만 적용해 그대로 채택한다.
 * LLM 무효/부재 시에만 번호판 앵커 빌더 + 번호판 포함강제(폴백 불변식)로 재구성한다.
 */
export function resolveFloorPolygon(
  llmPoly: Array<{ x: number; y: number }> | undefined | null,
  vehicle: NormalizedRect,
  plateQuad?: NormalizedQuad,
  plateRect?: NormalizedRect,
): NormalizedPolygon {
  // LLM 메인: 유효 정규화 폴리곤이면 각도 재앵커·번호판 포함강제 없이 그대로 채택.
  const llmNorm = normalizePolygon(llmPoly);
  if (llmNorm) return llmNorm;
  // 폴백: LLM 무효/부재 → 번호판 앵커 빌더 + 번호판 포함강제(기존 불변식 유지).
  const base = buildPlateAnchoredQuad(vehicle, plateQuad);
  const containTarget = plateRect ?? (plateQuad ? quadBoundingRect(plateQuad) : predictPlateRect(vehicle));
  return expandPolygonToContainRect(base, containTarget);
}

/** 비겹침 대상 항목(같은 preset_key 그룹). */
export interface FloorPolyItem {
  ref: string;
  polygon: NormalizedPolygon;
  plate?: NormalizedRect;
  confidence?: number;
}

/**
 * 같은 프리셋 그룹의 다각형들에 상호 수직이등분선 반평면 클리핑을 단일 패스로 적용해 겹침=0 보장(R4).
 * 분리선은 번호판 예상/실측 박스를 침범하지 않게 이동(R3 우선). 번호판끼리 겹치는 병리적 경우만 비겹침 우선 + warn.
 * 입력 순서를 보존한 다각형 배열을 반환한다(클리핑은 축소만 → 단일 패스로 모든 쌍 분리 유지).
 */
export function deconflictPolygons(items: FloorPolyItem[]): NormalizedPolygon[] {
  const polys: NormalizedPolygon[] = items.map((it) => it.polygon.map((p) => ({ x: p.x, y: p.y })));
  const n = polys.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (convexIntersectionArea(polys[i], polys[j]) <= OVERLAP_EPS) continue;
      const line = perpBisector(polygonCentroid(polys[i]), polygonCentroid(polys[j]));
      const adjusted = adjustForPlates(line, items[i].plate, items[j].plate, items[i].ref, items[j].ref);
      polys[i] = clipByHalfPlane(polys[i], adjusted);
      polys[j] = clipByHalfPlane(polys[j], { p0: adjusted.p0, n: { x: -adjusted.n.x, y: -adjusted.n.y } });
    }
  }
  return polys;
}

/**
 * 분리선(법선 n 은 i 측 유지)을 n 방향으로 평행이동해 plateI 는 i 측, plateJ 는 j 측이 되게 한다(R3 우선).
 * 두 요구 양립 창이 있으면 그 안(둘 다 있으면 중앙)으로, 없으면(병리적 겹침) 수직이등분선 유지 + warn.
 */
function adjustForPlates(
  line: { p0: NormalizedPoint; n: NormalizedPoint },
  plateI: NormalizedRect | undefined,
  plateJ: NormalizedRect | undefined,
  refI: string,
  refJ: string,
): { p0: NormalizedPoint; n: NormalizedPoint } {
  const n = line.n;
  const nn = n.x * n.x + n.y * n.y;
  if (nn < 1e-12) return line; // 무게중심 일치(퇴화) → 이동 불가.
  const dm = n.x * line.p0.x + n.y * line.p0.y; // 기본 d(수직이등분선).
  // i 측은 n·x ≥ d → d ≤ (plateI 모서리 n·c 의 최솟값). j 측은 n·x ≤ d → d ≥ (plateJ 모서리 최댓값).
  let dHi = Infinity;
  if (plateI) for (const c of rectCorners(plateI)) dHi = Math.min(dHi, n.x * c.x + n.y * c.y);
  let dLo = -Infinity;
  if (plateJ) for (const c of rectCorners(plateJ)) dLo = Math.max(dLo, n.x * c.x + n.y * c.y);

  let d: number;
  if (dLo <= dHi) {
    if (plateI && plateJ) d = (dLo + dHi) / 2; // 양립 창 중앙.
    else d = Math.min(Math.max(dm, dLo), dHi); // 한쪽만 존재: 수직이등분선을 창 안으로 클램프.
  } else {
    logger.warn({ refA: refI, refB: refJ }, 'floor ROI 비겹침: 번호판 박스 충돌 — 비겹침 우선(마진 희생)');
    d = dm;
  }
  const t = (d - dm) / nn;
  return { p0: { x: line.p0.x + n.x * t, y: line.p0.y + n.y * t }, n };
}
