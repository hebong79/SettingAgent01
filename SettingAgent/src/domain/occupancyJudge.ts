// 슬롯 점유 **판정**(순수·결정형·I/O 0) — `web/occupancy.js:OccupancyJudge.judge` + `web/core.js:computeOccupancy`
// 의 **자구 포팅**본. 기준변은 언제나 `web/*` 이고(실운영 검증된 쪽), 이 파일이 그것을 따라간다.
// 동일성은 `test/occupancyJudgeParity.test.ts` 가 `toEqual` 깊은 비교로 봉인한다(값이 갈리면 포팅 오류다).
//
// ★ 신규 알고리즘 0줄. 기하 프리미티브·상수는 **이미 서버에 있는 것을 재사용**한다:
//   - `domain/geometry.ts:quadCentroid`(4점 산술평균 — 점유 판정의 중심 정의, `quadCentroidParity` 봉인)
//   - `domain/polygon.ts:pointInPolygon`/`rectCorners`/`convexIntersectionArea`
//   - `capture/onPlaceFilter.ts:groundBand`/`GROUND_BAND_RATIO`/`ON_PLACE_MIN_OVERLAP`
//     (값 복제 금지 — 복제하면 파리티가 못 잡는 3번째 정의가 생긴다. 리더 결정 Q2(a).)
//   `domain → capture` 방향 import 가 새로 생기지만 순환은 없다(onPlaceFilter 는 domain 만 참조한다).
//
// ★ 웹판이 갖고 서버 프리미티브가 갖지 않는 **퇴화 입력 가드**는 로컬로 되살린다(아래 두 함수).
//   가드를 빼면 비4점·비수치 quad 에서 판정이 조용히 뒤집힌다.

import type { NormalizedPoint, NormalizedQuad, NormalizedRect } from './types.js';
import { area, quadCentroid } from './geometry.js';
import { pointInPolygon, rectCorners, convexIntersectionArea } from './polygon.js';
import { groundBand, GROUND_BAND_RATIO, ON_PLACE_MIN_OVERLAP } from '../capture/onPlaceFilter.js';

export interface FloorPolygon {
  idx: number;
  quad: readonly NormalizedPoint[];
}
export interface PlateDet {
  quad: readonly NormalizedPoint[];
}
export interface VehicleDet {
  rect?: NormalizedRect | null;
  plate?: PlateDet | null;
}
export interface DetectInput {
  plates?: PlateDet[] | null;
  vehicles?: VehicleDet[] | null;
}

/** 판정 결과 1행. `source` 는 귀속 근거가 아니라 **번호 인식 여부**다('bbox' = 차량은 귀속, 번호 미인식). */
export interface OccupancyRow {
  idx: number;
  occupied: boolean;
  /** `computeOccupancy` 경로에는 이 키 자체가 없다(웹판과 동일 — 파리티 대상). */
  source?: 'plate' | 'bbox' | null;
  center?: NormalizedPoint;
  plateQuad?: readonly NormalizedPoint[];
  vehicleRect?: NormalizedRect;
}

export interface JudgeConfig {
  groundBandRatio: number;
  minBandOverlap: number;
}

/**
 * 4점 quad 의 산술평균 중심. **비4점·비수치 → null**(= `web/core.js:quadCentroid`).
 * `geometry.quadCentroid` 는 가드가 없어 항상 값을 낸다 → 가드만 로컬로 두고 계산은 위임한다
 * (`occupancyRegion.ts:quadCentroid4` 와 같은 가드).
 */
function quadCentroidOrNull(quad: unknown): NormalizedPoint | null {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  for (const p of quad) {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return null;
  }
  return quadCentroid(quad as NormalizedQuad);
}

/** 점 ∈ 다각형(ray casting). 웹판(`core.js:pointInQuad`)의 `length < 3` 선행 가드를 유지한다. */
function pointInQuad(nx: number, ny: number, quad: unknown): boolean {
  if (!Array.isArray(quad) || quad.length < 3) return false;
  return pointInPolygon(quad as readonly NormalizedPoint[], { x: nx, y: ny });
}

/**
 * quad 좌표 동등성 키(4점 수치 직렬화). 서버가 같은 번호판을 `detect.plates[]` 와 `vehicles[].plate`
 * 양쪽에 직렬화하므로 수치는 정확히 같다 — JSON 왕복 후엔 참조 동등성이 성립하지 않아 좌표로 맞춘다.
 */
function quadKey(quad: readonly NormalizedPoint[]): string {
  return quad.map((p) => `${p.x},${p.y}`).join(';');
}

/**
 * 로직 점유 판정 — 번호판 중심 ∈ 바닥 폴리곤(첫 매칭). = `web/core.js:577 computeOccupancy` 자구 포팅.
 * throw 금지 — `floorPolygons`/`plates` 누락·비배열 시 `[]`(graceful, 강등 철학).
 */
export function computeOccupancy(floorPolygons: unknown, plates: unknown): OccupancyRow[] {
  if (!Array.isArray(floorPolygons)) return [];
  const cands = (Array.isArray(plates) ? plates : [])
    .map((p) => ({ center: quadCentroidOrNull(p?.quad), quad: p?.quad as readonly NormalizedPoint[] }))
    .filter((c): c is { center: NormalizedPoint; quad: readonly NormalizedPoint[] } => c.center !== null);
  return floorPolygons.map((f) => {
    const hit = cands.find((c) => pointInQuad(c.center.x, c.center.y, f?.quad));
    return hit
      ? { idx: f?.idx, occupied: true, center: hit.center, plateQuad: hit.quad }
      : { idx: f?.idx, occupied: false };
  });
}

/**
 * 슬롯별 ① 차량 접지밴드 겹침 argmax 귀속 → ② 비점유 슬롯 번호판 중심 폴백.
 * = `web/occupancy.js:152 OccupancyJudge.judge` 자구 포팅(임계값만 인자로 받는다).
 *
 * 귀속 앵커가 차량 접지인 이유: 번호판은 지면에서 떠 있어(차체 전면 ~0.5m) 바닥 ROI 와 다른 평면이라
 * 그 시차가 원경의 얇은 폴리곤을 넘겨 이웃 슬롯 오귀속·열 끝 차량 소실을 만든다. 접지밴드는 바닥 ROI 와
 * 같은 평면이라 시차가 원리적으로 0이다.
 */
export function judgeOccupancy(
  floorPolygons: unknown,
  detect: unknown,
  cfg?: Partial<JudgeConfig>,
): OccupancyRow[] {
  const groundBandRatio = cfg?.groundBandRatio ?? GROUND_BAND_RATIO;
  const minBandOverlap = cfg?.minBandOverlap ?? ON_PLACE_MIN_OVERLAP;
  if (!Array.isArray(floorPolygons)) return [];
  const polys = floorPolygons as FloorPolygon[];

  const d = detect as DetectInput | null | undefined;
  const vehicles: VehicleDet[] = Array.isArray(d?.vehicles) ? d!.vehicles! : [];
  const rows: OccupancyRow[] = polys.map((f) => ({ idx: f?.idx, occupied: false, source: null }));

  // ── 1단계: 차량 접지밴드 겹침 argmax 귀속(주 매칭기) ──
  // 슬롯 위치별 최대 겹침 차량 1대만 유지(argmax). rows 는 floorPolygons 와 같은 순서.
  const bestByPos = new Map<number, { ratio: number; v: VehicleDet }>();
  for (const v of vehicles) {
    const rect = v?.rect;
    if (!rect) continue;
    const band = groundBand(rect, groundBandRatio);
    const bandArea = area(band);
    if (bandArea <= 0) continue; // 퇴화 rect — onPlaceFilter 와 동일 처리.
    const corners = rectCorners(band);
    let bestPos = -1;
    let bestRatio = 0;
    for (let j = 0; j < polys.length; j++) {
      const ratio = convexIntersectionArea(corners, polys[j].quad) / bandArea;
      if (ratio > bestRatio) {
        // strict → 동률 시 배열 앞 슬롯 유지(결정적 tie-break).
        bestRatio = ratio;
        bestPos = j;
      }
    }
    // 차량은 최대 겹침 슬롯 1개에만 지원 → 한 차량의 이중 점유는 구조적으로 불가.
    if (bestPos >= 0 && bestRatio >= minBandOverlap) {
      const prev = bestByPos.get(bestPos);
      if (!prev || bestRatio > prev.ratio) bestByPos.set(bestPos, { ratio: bestRatio, v });
    }
  }

  const placedPlateKeys = new Set<string>(); // 배치 차량의 attached plate 좌표키 — 2단계 중복 차단.
  const placedVehicles = new Set<VehicleDet>();
  for (const [pos, cand] of bestByPos) {
    const v = cand.v;
    placedVehicles.add(v);
    // source 는 귀속 근거가 아니라 번호 인식 여부. plate 퇴화(중심 null)면 bbox 로 강등(throw 금지).
    const c = v.plate ? quadCentroidOrNull(v.plate.quad) : null;
    rows[pos] = c
      ? {
          idx: polys[pos].idx,
          occupied: true,
          source: 'plate',
          center: c,
          plateQuad: v.plate!.quad,
          vehicleRect: v.rect!,
        }
      : { idx: polys[pos].idx, occupied: true, source: 'bbox', vehicleRect: v.rect! };
    if (c) placedPlateKeys.add(quadKey(v.plate!.quad));
  }

  // ── 2단계: 번호판 중심 폴백(1단계 비점유 슬롯만 — computeOccupancy 위임, 재구현 금지) ──
  // 후보: 차량에 귀속 안 된 standalone plate ∪ 미배치 차량(임계 미달·경합 패배)의 plate.
  const fallbackPlates: PlateDet[] = [
    ...(Array.isArray(d?.plates) ? d!.plates! : []).filter(
      (p) => p?.quad && !placedPlateKeys.has(quadKey(p.quad)),
    ),
    ...vehicles.filter((v) => !placedVehicles.has(v) && v?.plate).map((v) => v.plate!),
  ];
  const openPos: number[] = [];
  const openPolys: FloorPolygon[] = [];
  polys.forEach((f, j) => {
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
