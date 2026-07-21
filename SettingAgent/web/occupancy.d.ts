// occupancy.js(브라우저용 순수 ESM)의 타입 선언. vitest 가 직접 로드하는 occupancy.js 와 1:1.
// core.d.ts 관례와 동일한 짝 구조.

import type { NormalizedPoint, NormalizedRect } from './core.js';

// ===== 상수 =====
export const GROUND_BAND_RATIO: number;
export const ON_PLACE_MIN_OVERLAP: number;

// ===== 기하 파리티 포트(src 원본과 동일 정의 — 파리티 테스트용 export) =====
export interface HalfPlaneLine {
  p0: NormalizedPoint;
  n: NormalizedPoint;
}
export function area(r: NormalizedRect): number;
export function rectCorners(
  r: NormalizedRect,
): [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
export function polygonArea(poly: readonly NormalizedPoint[]): number;
export function polygonCentroid(poly: readonly NormalizedPoint[]): NormalizedPoint;
export function clipByHalfPlane(
  poly: readonly NormalizedPoint[],
  line: HalfPlaneLine,
): NormalizedPoint[];
export function convexIntersectionArea(
  a: readonly NormalizedPoint[],
  b: readonly NormalizedPoint[],
): number;
export function groundBand(rect: NormalizedRect, ratio?: number): NormalizedRect;

// ===== OccupancyJudge =====

export interface OccupancyJudgeConfig {
  /** bbox 접지 근사 밴드 비율(하단 스트립). 기본 0.25 = src GROUND_BAND_RATIO. */
  groundBandRatio?: number;
  /** 밴드 면적 대비 슬롯 겹침 하한(이 미만이면 배정 안 함). 기본 0.15 = src ON_PLACE_MIN_OVERLAP. */
  minBandOverlap?: number;
}

export interface OccupancyJudgement {
  /** 바닥 폴리곤 전역 인덱스(입력 그대로). */
  idx: number;
  occupied: boolean;
  /**
   * 번호 인식 여부(귀속 근거가 아님 — 슬롯 귀속은 차량 접지밴드가 담당).
   * 'plate' = 귀속 차량이 번호판 보유(또는 차량 미귀속 번호판 폴백), 'bbox' = 차량 귀속·번호 미인식, null = 빈 면.
   */
  source: 'plate' | 'bbox' | null;
  /** source==='plate' 일 때만: 번호판 중심(기존 computeOccupancy center 그대로). */
  center?: NormalizedPoint;
  /** source==='plate' 일 때만: 번호판 OBB quad — 점유영역 사다리꼴 축 소스. */
  plateQuad?: NormalizedPoint[];
  /** 차량 접지로 귀속된 행(source 'plate'/'bbox' 공통): 그 차량 bbox. 번호판 폴백 행에는 없다. */
  vehicleRect?: NormalizedRect;
}

export interface OccupancyJudgeDetect {
  plates?: Array<{ quad: NormalizedPoint[] }> | null;
  vehicles?: Array<{ rect: NormalizedRect; plate?: { quad: NormalizedPoint[] } | null }> | null;
}

export class OccupancyJudge {
  constructor(cfg?: OccupancyJudgeConfig);
  groundBandRatio: number;
  minBandOverlap: number;
  judge(
    floorPolygons: Array<{ idx: number; quad: NormalizedPoint[] }> | null | undefined,
    detect: OccupancyJudgeDetect | null | undefined,
  ): OccupancyJudgement[];
}
