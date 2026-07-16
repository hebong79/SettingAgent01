// occupancyRegion.js(브라우저용 순수 ESM)의 타입 선언. vitest 가 직접 로드하는 .js 와 1:1.
// occupancy.d.ts 관례와 동일한 짝 구조.

import type { NormalizedPoint } from './core.js';

export interface RegionConfig {
  /** 배율 탐색 하한(전역 단계). 기본 3.5. */
  widthScaleMin?: number;
  /** 배율 탐색 상한. 기본 4.0. */
  widthScaleMax?: number;
  /** 위 변 폭 / 아래 변 폭. 기본 1.0(= 평행사변형). 1.0 미만이면 위가 좁은 사다리꼴. */
  topWidthRatio?: number;
  /** 중심→위 변 거리 / 아래 변 폭. 기본 0.90. */
  upRatio?: number;
  /** 중심→아래 변 거리 / 아래 변 폭. 기본 0.60. */
  downRatio?: number;
  /** 전역 배율 그리드 스냅(내림). 기본 0.05. */
  scaleQuantum?: number;
  /** 겹침 판정 면적 임계. 기본 1e-6. */
  areaEps?: number;
  /** 인스턴스별 축소율(폴백 단계). 기본 0.9. */
  shrinkFactor?: number;
  /** 폴백 축소 반복 상한. 기본 20. */
  maxShrinkIters?: number;
  /** 인스턴스 배율 하한. 기본 1.0. */
  minScale?: number;
}

export interface PlateAxes {
  /** 번호판 중심(quadCentroid). */
  c: NormalizedPoint;
  /** û 단위 가로축. */
  u: NormalizedPoint;
  /** v̂ 단위 세로축(화면 아래 방향 보장). */
  v: NormalizedPoint;
  /** W(대변 평균 폭) — 배율 기준. */
  width: number;
}

export interface OccupancyRegion {
  /** 입력 items[i].idx 그대로. */
  idx: number;
  /** 적용 배율(전역 or 개별). */
  scale: number;
  /** 클램프 후 볼록 3~8각형. */
  polygon: NormalizedPoint[];
}

export interface RegionResult {
  /** 퇴화/전부클립 인스턴스는 제외. */
  regions: OccupancyRegion[];
  /** 1단계 성공 시 값, 2단계 진입 시 null. */
  globalScale: number | null;
  /** 최종 잔존 겹침(idx 쌍) — 정상 시 []. */
  overlapPairs: Array<[number, number]>;
}

export function plateAxes(quad: NormalizedPoint[] | null | undefined): PlateAxes | null;
export function buildTrapezoid(
  axes: PlateAxes,
  scale: number,
  cfg?: RegionConfig,
): NormalizedPoint[];
export function clampToUnit(poly: NormalizedPoint[]): NormalizedPoint[];
export function computeOccupancyRegions(
  items: Array<{ idx: number; quad: NormalizedPoint[] }>,
  cfg?: RegionConfig,
): RegionResult;
