// 주차면 위 차량만 남기는 필터(모드 A). 순수 — 기하는 전부 기존 유틸 재사용(신규 기하 0줄).
// VPD rect 는 지붕까지 포함한 axis-aligned bbox 라 **중심은 원근으로 바닥면 밖(먼 쪽)으로 이탈**한다
// (카메라 H≈8m, 차량중심 z≈0.75m → +10% ≈ 주차면 한 칸). 그래서 중심 규칙은 통로 통행차를
// 뒷줄 주차면에 올려놓는다(FP) — 모드 A 의 1차 목적(통행차 배제) 자체를 달성하지 못한다.
// → **접지 근사 밴드**(bbox 하단 25%)와 주차면 폴리곤의 겹침 면적비로 판정하고, 전 폴리곤 OR 로 통과시킨다.
// 배정(어느 칸인가)이 아니라 필터(주차면 위인가)이므로 옆 칸에 걸쳐도 정답이다.

import type { NormalizedPoint, NormalizedRect } from '../domain/types.js';
import type { PlateBox } from '../clients/LpdClient.js';
import { rectCorners, convexIntersectionArea, pointInPolygon } from '../domain/polygon.js';
import { area, quadCentroid } from '../domain/geometry.js';
import { matchPlatesToSlots } from '../setup/plateMatch.js';

/** 접지 근사 밴드 = bbox 하단 25%. */
export const GROUND_BAND_RATIO = 0.25;
/** 밴드 면적 대비 주차면 겹침 하한. */
export const ON_PLACE_MIN_OVERLAP = 0.15;

/** 차량 bbox 의 접지 근사 밴드(하단 GROUND_BAND_RATIO 스트립). */
export function groundBand(rect: NormalizedRect): NormalizedRect {
  const h = rect.h * GROUND_BAND_RATIO;
  return { x: rect.x, y: rect.y + rect.h - h, w: rect.w, h };
}

/**
 * 접지 밴드가 주차면 폴리곤들 중 **하나라도** 임계 이상 겹치는가(OR).
 * polys 빈 배열 / 밴드 면적 0(퇴화 rect) → false.
 */
export function isVehicleOnPlace(
  rect: NormalizedRect,
  polys: readonly (readonly NormalizedPoint[])[],
): boolean {
  const band = groundBand(rect);
  const bandArea = area(band);
  if (bandArea <= 0) return false;
  const corners = rectCorners(band);
  return polys.some((p) => convexIntersectionArea(corners, p) / bandArea >= ON_PLACE_MIN_OVERLAP);
}

/**
 * 모드 A 필터. VehicleBox·DetectVehicle 양쪽에 쓰이도록 구조적 제네릭.
 * polys 가 null/빈 배열이면 **강등**: 전량 통과 + degraded=true(드롭 금지 — 기준 부재로 데이터를 조용히 지우지 않는다).
 */
export function filterVehiclesOnPlace<T extends { rect: NormalizedRect }>(
  vehicles: readonly T[],
  polys: readonly (readonly NormalizedPoint[])[] | null | undefined,
): { kept: T[]; filteredOut: number; degraded: boolean } {
  if (!polys || polys.length === 0) {
    return { kept: [...vehicles], filteredOut: 0, degraded: true };
  }
  const kept = vehicles.filter((v) => isVehicleOnPlace(v.rect, polys));
  return { kept, filteredOut: vehicles.length - kept.length, degraded: false };
}

/**
 * 모드 A 번호판 필터. `keepPlate = (유지된 차량에 귀속) OR (번호판 중심 ∈ 주차면 폴리곤)`.
 *
 * - **(A) 귀속**: `matchPlatesToSlots` 재사용(신규 매칭 0줄). 차량당 번호판 1개 규칙이
 *   VPD 저신뢰 **거대 병합 박스**(프레임 절반 크기)가 배경 번호판을 전부 빨아들이는 것을 1건으로 봉쇄한다.
 *   → 자체 귀속 로직(중심 ∈ 유지된 차량 rect)으로 바꾸면 이 봉쇄가 풀린다.
 * - **(B) 주차면 보정**: VPD 가 놓친 주차차의 번호판을 살린다. 점유 판정(computeOccupancy)은 **번호판 중심**이
 *   주차면 폴리곤 안인지로 결정되므로, 이 항이 없으면 그 면이 `occupied:false` 로 뒤집힌다.
 *   (B)가 있으므로 **필터가 제거하는 번호판은 점유를 참으로 만들 수 없는 것뿐** → 점유 회귀 0.
 * - **(B) 의 중심 정의는 소비처와 동일해야 한다**(D-1): `web/core.js:computeOccupancy` 는 `quadCentroid`(4점 평균)로
 *   점유를 판정한다. (B)가 bbox 중심(`center(quadBoundingRect)`)을 쓰면 *4점평균은 폴리곤 안인데 bbox중심은 밖*인
 *   비아핀 quad 를 드롭해 **점유를 조용히 뒤집는다**. → (B)는 `quadCentroid` 를 쓴다(파리티: `test/quadCentroidParity.test.ts`).
 *   그 결과 위 "제거되는 번호판은 점유를 참으로 만들 수 없다"는 보장이 **ε 예외 없이 정확히 참**이 된다.
 * - **(A) 는 그대로 bbox 중심**(`matchPlatesToSlots` 내부 규칙) — 그건 *차량 귀속*이지 점유가 아니다. 통일 대상 아님.
 *
 * polys 부재 → **강등**: 전량 통과 + degraded=true(filterVehiclesOnPlace 와 동일 정책 — 기준 부재로 드롭 금지).
 */
export function filterPlatesOnPlace(
  plates: PlateBox[],
  keptVehicles: readonly { rect: NormalizedRect; confidence: number }[],
  polys: readonly (readonly NormalizedPoint[])[] | null | undefined,
): { kept: PlateBox[]; filteredOut: number; degraded: boolean } {
  if (!polys || polys.length === 0) {
    return { kept: [...plates], filteredOut: 0, degraded: true };
  }
  // matchPlatesToSlots 는 plate.quad **참조**를 그대로 담는다(detectPipeline 이 이미 의존하는 성질).
  const attached = new Set(
    matchPlatesToSlots(
      keptVehicles.map((v, i) => ({ positionIdx: i, roi: v.rect, confidence: v.confidence })),
      plates,
    ).values(),
  );
  const kept = plates.filter((p) => {
    if (attached.has(p.quad)) return true; // (A)
    const c = quadCentroid(p.quad); // (B) — 소비처(computeOccupancy)와 **동일** 중심 정의.
    return polys.some((poly) => pointInPolygon(poly, c));
  });
  return { kept, filteredOut: plates.length - kept.length, degraded: false };
}
