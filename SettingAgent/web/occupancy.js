// 차량 점유 판정 컴포넌트(순수, 환경 비의존 — DOM/fetch/state 미참조).
// 슬롯별 2단계 판정: ① 차량 접지밴드 겹침 argmax 귀속 → ② 비점유 슬롯에 번호판 중심 폴백
// (web/core.js:computeOccupancy 위임). 번호판만 있을 때(차량 미검출) 결과는 computeOccupancy 에
// source 필드만 얹은 것과 항등(회귀 0).
//
// 귀속 앵커가 차량 접지인 이유: 번호판은 지면에서 떠 있어(차체 전면 ~0.5m) 바닥 ROI(지면 발자국)와
// 다른 평면이다. 그 시차가 원경의 얇은 폴리곤(y두께 30px 미만)을 넘겨 이웃 슬롯 오귀속·열 끝 차량
// 소실을 만든다(진단 05 실측 10~33px). 접지밴드는 바닥 ROI 와 동일 평면이라 시차가 원리적으로 0.
// → source 는 귀속 근거가 아니라 **번호 인식 여부**를 뜻한다('bbox' = 차량은 귀속, 번호 미인식).
//
// 접지 판정에 필요한 기하(groundBand·rectCorners·convexIntersectionArea·area 계열)는
// src(TypeScript: onPlaceFilter.ts/domain/polygon.ts/domain/geometry.ts)에만 있어 브라우저에서
// import 할 수 없다. 코드베이스 관례(quadCentroid·normalizeGlobalIdx 파리티 포트)를 따라
// **src 원본을 자구 그대로 포팅**하고 파리티 테스트(test/occupancyGeometryParity.test.ts)로 고정한다.
// 새 기하 알고리즘은 발명하지 않는다.

import { computeOccupancy, quadCentroid } from './core.js';

// ===== 상수(출처: src/capture/onPlaceFilter.ts — 모드A 필터에서 실측 검증된 값) =====

/** 접지 근사 밴드 = bbox 하단 25%. (= src GROUND_BAND_RATIO) */
export const GROUND_BAND_RATIO = 0.25;
/** 밴드 면적 대비 슬롯 겹침 하한. (= src ON_PLACE_MIN_OVERLAP) */
export const ON_PLACE_MIN_OVERLAP = 0.15;

const EPS = 1e-9; // (= src/domain/polygon.ts:EPS)

// ===== 기하 파리티 포트 (src 원본과 동일 식 — 파리티 테스트로 봉인) =====

/** 사각형 면적. (= src/domain/geometry.ts:area) */
export function area(r) {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** 사각형 4모서리(TL,TR,BR,BL). (= src/domain/polygon.ts:rectCorners) */
export function rectCorners(r) {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** 다각형 면적(shoelace 절댓값). (= src/domain/polygon.ts:polygonArea) */
export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 다각형 무게중심(면적가중). 퇴화(면적≈0) 시 정점 평균. (= src/domain/polygon.ts:polygonCentroid) */
export function polygonCentroid(poly) {
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

/** 단일 반평면(Sutherland–Hodgman) 클립. `n·(x−p0) ≥ 0` 유지. (= src/domain/polygon.ts:clipByHalfPlane) */
export function clipByHalfPlane(poly, line) {
  if (poly.length === 0) return [];
  const side = (p) => line.n.x * (p.x - line.p0.x) + line.n.y * (p.y - line.p0.y);
  const out = [];
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

/** 볼록 A ∩ B 면적 — A 를 B 각 변(내향 반평면)으로 클립 후 면적. (= src/domain/polygon.ts:convexIntersectionArea) */
export function convexIntersectionArea(a, b) {
  if (a.length < 3 || b.length < 3) return 0;
  let poly = a.map((p) => ({ x: p.x, y: p.y }));
  const c = polygonCentroid(b);
  for (let i = 0; i < b.length; i++) {
    const p1 = b[i];
    const p2 = b[(i + 1) % b.length];
    let n = { x: -(p2.y - p1.y), y: p2.x - p1.x };
    const d = n.x * (c.x - p1.x) + n.y * (c.y - p1.y);
    if (d < 0) n = { x: -n.x, y: -n.y };
    poly = clipByHalfPlane(poly, { p0: p1, n });
    if (poly.length === 0) return 0;
  }
  return polygonArea(poly);
}

/**
 * 차량 bbox 의 접지 근사 밴드(하단 ratio 스트립). (= src/capture/onPlaceFilter.ts:groundBand)
 * ratio 기본값은 GROUND_BAND_RATIO — 기본 인자로 호출하면 src 원본과 동일(파리티 유지).
 */
export function groundBand(rect, ratio = GROUND_BAND_RATIO) {
  const h = rect.h * ratio;
  return { x: rect.x, y: rect.y + rect.h - h, w: rect.w, h };
}

/**
 * quad 좌표 동등성 키(4점 수치 직렬화). 서버가 같은 번호판을 detect.plates[] 와 vehicles[].plate
 * 양쪽에 직렬화하므로 수치는 정확히 같다 — JSON 왕복 후엔 참조 동등성이 성립하지 않아 좌표로 맞춘다.
 */
function quadKey(quad) {
  return quad.map((p) => `${p.x},${p.y}`).join(';');
}

// ===== OccupancyJudge =====

/**
 * 차량 점유 판정기. 상태 없음(생성자 config 만 보유) — 인스턴스 재사용/매 프레임 호출 안전.
 * 임계값은 생성자 한 곳에서만 관리한다.
 */
export class OccupancyJudge {
  /** @param {{ groundBandRatio?: number, minBandOverlap?: number }} [cfg] */
  constructor(cfg = {}) {
    this.groundBandRatio = cfg.groundBandRatio ?? GROUND_BAND_RATIO;
    this.minBandOverlap = cfg.minBandOverlap ?? ON_PLACE_MIN_OVERLAP;
  }

  /**
   * 슬롯별 차량 접지 귀속 > 번호판 폴백 점유 판정.
   * @param {Array<{ idx: number, quad: Array<{x:number,y:number}> }>|null|undefined} floorPolygons
   * @param {{ plates?: Array<{quad:Array<{x:number,y:number}>}>|null, vehicles?: Array<{rect:{x:number,y:number,w:number,h:number}, plate?:{quad:Array<{x:number,y:number}>}|null}>|null }|null|undefined} detect
   * @returns {Array<{ idx:number, occupied:boolean, source:'plate'|'bbox'|null, center?:{x:number,y:number}, plateQuad?:Array<{x:number,y:number}>, vehicleRect?:{x:number,y:number,w:number,h:number} }>}
   */
  judge(floorPolygons, detect) {
    if (!Array.isArray(floorPolygons)) return [];

    const vehicles = Array.isArray(detect?.vehicles) ? detect.vehicles : [];
    const rows = floorPolygons.map((f) => ({ idx: f.idx, occupied: false, source: null }));

    // ── 1단계: 차량 접지밴드 겹침 argmax 귀속(주 매칭기) ──
    // 슬롯 위치별 최대 겹침 차량 1대만 유지(argmax). rows 는 floorPolygons 와 같은 순서.
    const bestByPos = new Map();
    for (const v of vehicles) {
      const rect = v?.rect;
      if (!rect) continue;
      const band = groundBand(rect, this.groundBandRatio);
      const bandArea = area(band);
      if (bandArea <= 0) continue; // 퇴화 rect — src onPlaceFilter 와 동일 처리.
      const corners = rectCorners(band);
      let bestPos = -1;
      let bestRatio = 0;
      for (let j = 0; j < floorPolygons.length; j++) {
        const ratio = convexIntersectionArea(corners, floorPolygons[j].quad) / bandArea;
        if (ratio > bestRatio) {
          // strict → 동률 시 배열 앞 슬롯 유지(결정적 tie-break).
          bestRatio = ratio;
          bestPos = j;
        }
      }
      // 차량은 최대 겹침 슬롯 1개에만 지원 → 한 차량의 이중 점유는 구조적으로 불가.
      if (bestPos >= 0 && bestRatio >= this.minBandOverlap) {
        const prev = bestByPos.get(bestPos);
        if (!prev || bestRatio > prev.ratio) bestByPos.set(bestPos, { ratio: bestRatio, v });
      }
    }

    const placedPlateKeys = new Set(); // 배치 차량의 attached plate 좌표키 — 2단계 중복 차단.
    const placedVehicles = new Set();
    for (const [pos, cand] of bestByPos) {
      const v = cand.v;
      placedVehicles.add(v);
      // source 는 귀속 근거가 아니라 번호 인식 여부. plate 퇴화(중심 null)면 bbox 로 강등(throw 금지).
      const c = v.plate ? quadCentroid(v.plate.quad) : null;
      rows[pos] = c
        ? {
            idx: floorPolygons[pos].idx,
            occupied: true,
            source: 'plate',
            center: c,
            plateQuad: v.plate.quad,
            vehicleRect: v.rect,
          }
        : { idx: floorPolygons[pos].idx, occupied: true, source: 'bbox', vehicleRect: v.rect };
      if (c) placedPlateKeys.add(quadKey(v.plate.quad));
    }

    // ── 2단계: 번호판 중심 폴백(1단계 비점유 슬롯만 — computeOccupancy 위임, 재구현 금지) ──
    // 후보: 차량에 귀속 안 된 standalone plate ∪ 미배치 차량(임계 미달·경합 패배)의 plate.
    const fallbackPlates = [
      ...(Array.isArray(detect?.plates) ? detect.plates : []).filter(
        (p) => p?.quad && !placedPlateKeys.has(quadKey(p.quad)),
      ),
      ...vehicles.filter((v) => !placedVehicles.has(v) && v?.plate).map((v) => v.plate),
    ];
    const openPos = [];
    const openPolys = [];
    floorPolygons.forEach((f, j) => {
      if (!rows[j].occupied) {
        openPos.push(j);
        openPolys.push(f);
      }
    });
    // computeOccupancy 는 입력 폴리곤 순서를 보존 → k 번째 결과 = openPos[k] 위치.
    computeOccupancy(openPolys, fallbackPlates).forEach((r, k) => {
      if (r.occupied) {
        rows[openPos[k]] = {
          idx: r.idx,
          occupied: true,
          source: 'plate',
          center: r.center,
          plateQuad: r.plateQuad,
        };
      }
    });

    return rows;
  }
}
