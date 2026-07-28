// roimakerCore.js(브라우저용 순수 ESM)의 타입 선언. core.d.ts 규약과 1:1(런타임 JS 무변경).

import type { NormalizedPoint } from './core.js';

export const MIN_POINTS: 3;
export const PREFERRED_POINTS: 4;
export const VIEW_SCOPES: ViewScope[];

export type ViewScope = 'preset' | 'slot' | 'all';
export type SpaceOrigin = 'file' | 'new';

export interface RoiSpace {
  idx: number;
  points: NormalizedPoint[];
  origin: SpaceOrigin;
}

export interface RoiSelection {
  key: string;
  idx: number;
}

export interface RoiMakerState {
  mode: 'idle' | 'drawing';
  draft: { points: NormalizedPoint[] } | null;
  spaces: Record<string, RoiSpace[]>;
  selected: RoiSelection | null;
  dirtyKeys: string[];
  /** 로드 시점의 프리셋별 주차면 수 — 저장 무결성 가드(expectRawCount)의 기준선. */
  baseCounts: Record<string, number>;
}

export interface VisiblePolygon {
  key: string;
  idx: number;
  points: NormalizedPoint[];
  current: boolean;
  editable: boolean;
  dirty: boolean;
  warn: boolean;
  empty: boolean;
  selected: boolean;
}

export interface RoiListRow {
  key: string;
  idx: number;
  cam: number;
  preset: number;
  pointCount: number;
  current: boolean;
  selected: boolean;
  dirty: boolean;
  warn: boolean;
  empty: boolean;
}

export interface SavePayloadItem {
  key: string;
  camId: number;
  presetIdx: number;
  spaces: Array<{ idx: number; points: NormalizedPoint[] }>;
  expectRawCount: number;
}

export interface ViewArgs {
  spaces: Record<string, RoiSpace[]>;
  key: string;
  scope: ViewScope | string;
  selected: RoiSelection | null;
}

export function createRoiMakerState(): RoiMakerState;
export function countSpaces(spaces: Record<string, RoiSpace[]>): number;
export function loadSpaces(
  state: RoiMakerState,
  placeRoi: Record<string, Array<{ idx: number; points: NormalizedPoint[] }>>,
): RoiMakerState;
export function toggleDrawMode(state: RoiMakerState): RoiMakerState;
export function addDraftPoint(state: RoiMakerState, nx: number, ny: number): RoiMakerState;
export function undoDraftPoint(state: RoiMakerState): RoiMakerState;
export function cancelDraft(state: RoiMakerState): RoiMakerState;
export function addEmptySpace(state: RoiMakerState, key: string): { state: RoiMakerState; idx: number };
export function closeDraft(
  state: RoiMakerState,
  key: string,
): { state: RoiMakerState; error?: string; warning?: string; filled?: number };
export function selectSpace(state: RoiMakerState, key: string | null, idx: number | null): RoiMakerState;
export function hitTest(
  args: ViewArgs & { nx: number; ny: number; tolX: number; tolY: number },
): { idx: number; vertex: number | null } | null;
export function moveVertex(
  state: RoiMakerState,
  key: string,
  idx: number,
  vertexIndex: number,
  ndx: number,
  ndy: number,
): RoiMakerState;
export function deleteRoi(state: RoiMakerState, key: string, idx: number): { state: RoiMakerState; error?: string };
export function markAllDirty(state: RoiMakerState): RoiMakerState;
export function visiblePolygons(args: ViewArgs): VisiblePolygon[];
export function buildRoiMakerList(args: ViewArgs): RoiListRow[];
export function validateForSave(state: RoiMakerState): { ok: boolean; errors: string[]; warnings: string[] };
export function buildSavePayload(state: RoiMakerState): SavePayloadItem[];
export function presetKey(camIdx: number | string, presetIdx: number | string): string;
