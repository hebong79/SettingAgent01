// placeDraw.js(브라우저용 순수 ESM)의 타입 선언. vitest 가 직접 로드하는 .js 와 1:1.
// core.d.ts / occupancyRegion.d.ts 관례와 동일한 짝 구조.

import type { NormalizedPoint } from './core.js';

/** 프리셋 키(`${cam}:${preset}`) → 주차면 배열. app.js 의 state.placeRoi 와 동일 형태. */
export interface PlaceSpace {
  idx: number;
  points: NormalizedPoint[];
}
export type PlaceRoiMap = Record<string, PlaceSpace[]>;

/** 그리기 진행 상태(그리는 중에만 non-null). */
export interface PlaceDraw {
  key: string;
  points: NormalizedPoint[];
}

export function beginPlaceDraw(key: string): PlaceDraw;
export function addPlaceDrawPoint(
  draw: PlaceDraw | null,
  pt: NormalizedPoint,
): { draw: PlaceDraw | null; full: boolean };
export function undoPlaceDrawPoint(draw: PlaceDraw | null): PlaceDraw | null;
export function nextPlaceIdx(placeRoi: PlaceRoiMap | null | undefined): number;
export function appendPlaceSpace(
  placeRoi: PlaceRoiMap | null | undefined,
  key: string,
  points: NormalizedPoint[],
): { placeRoi: PlaceRoiMap; idx: number };
export function clearPresetSpaces(
  placeRoi: PlaceRoiMap | null | undefined,
  key: string,
): PlaceRoiMap;
export function placeQuadOf(
  placeRoi: PlaceRoiMap | null | undefined,
  key: string,
  idx: number,
): NormalizedPoint[] | null;
export function movePlaceVertex(
  placeRoi: PlaceRoiMap | null | undefined,
  key: string,
  idx: number,
  vertexIndex: number,
  dx: number,
  dy: number,
): PlaceRoiMap;
export function importAutoQuads(
  placeRoi: Record<string, Array<{ idx: number; points: Array<{ x: number; y: number }> }>> | null,
  key: string,
  quads: Array<Array<{ x: number; y: number }>>,
): {
  placeRoi: Record<string, Array<{ idx: number; points: Array<{ x: number; y: number }> }>>;
  added: number;
  skipped: number;
  firstIdx: number | null;
};
export function hitTestPlaceSpace(
  placeRoi: Record<string, Array<{ idx: number; points: Array<{ x: number; y: number }> }>> | null,
  key: string,
  pt: { x: number; y: number },
): number | null;
