// core.js(브라우저용 순수 ESM)의 타입 선언. vitest 가 직접 로드하는 core.js 와 1:1.
// 분리 전 SettingAgent 에는 선언이 없어 import 가 implicit any(TS7016)였으나,
// SettingViewer 독립 typecheck 통과를 위해 명시 선언을 추가한다(런타임 JS 무변경).

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  px: number;
  py: number;
  pw: number;
  ph: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}
export type NormalizedQuad = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

export interface PixelPoint {
  px: number;
  py: number;
}

export interface Ptz {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface GlobalIndexEntry {
  globalIdx: number;
  slotId: string;
}

export interface CaptureStatus {
  state: string;
  runId?: number;
  round: number;
  done: number;
  planned: number;
  startedAt?: string;
  endedAt?: string;
  latestAdvisory?: string[];
}

export function captureProgress(status: Partial<CaptureStatus> | null | undefined): {
  percent: number;
  label: string;
};
export function captureElapsedMs(status: Partial<CaptureStatus> | null | undefined, nowMs: number): number | null;
export function formatElapsed(ms: number | null | undefined): string;
export function captureResultSummary(
  status: Partial<CaptureStatus> | null | undefined,
  nowMs: number,
): { title: string; lines: string[] };
export function mapAdvisory(status: Partial<CaptureStatus> | null | undefined): string[];
export function pollPlan(state: string, intervalMs?: number): { poll: boolean; intervalMs: number };

export function toPixel(rect: NormalizedRect, imgW: number, imgH: number): PixelRect;
export function toPixelQuad(quad: NormalizedQuad, imgW: number, imgH: number): PixelPoint[];
export function presetKey(camIdx: number | string, presetIdx: number | string): string;
export function slotLabel(slotId: string, globalIndex?: GlobalIndexEntry[]): string;
export function fpsToInterval(fps: number): number;
export function clampZoom(z: number, min?: number, max?: number): number;
export function stepPtz(cur: Ptz, dir: string, step: number): Ptz;
export function clampPanelWidth(px: number, min?: number, max?: number): number;

export interface CameraListItem {
  camIdx: number;
  presets: Array<{ presetIdx: number; pan?: number; tilt?: number; zoom?: number; label?: string }>;
}
export function findPresetPtz(
  cameras: CameraListItem[] | undefined,
  camIdx: number,
  presetIdx: number,
): Ptz | null;

export interface ArtifactAnalysis {
  ok: boolean;
  createdAt: string | null;
  totals: {
    cameras: number;
    presets: number;
    slots: number;
    globalSlots: number;
    withPlate: number;
    withFloor: number;
    warnings: number;
    zones: number;
  };
  perPreset: Array<{ key: string; camIdx: number; presetIdx: number; label: string; slotCount: number }>;
  slots: Array<{
    globalIdx: number | null;
    slotId: string;
    zone: string;
    presetKey: string;
    roi: NormalizedRect | null;
    hasPlate: boolean;
    hasFloor: boolean;
  }>;
  warnings: string[];
  report: string;
}
export function analyzeArtifact(artifact: unknown): ArtifactAnalysis;

export interface SlotLike {
  slotId: string;
  zone?: string;
  // 편집 순수 함수는 형태만 읽는다(엄격한 quad 튜플 강제 X) — 호출측 입력 부담 완화.
  roiByPreset?: Record<string, NormalizedRect>;
  plateRoiByPreset?: Record<string, NormalizedRect>;
  floorRoiByPreset?: Record<string, NormalizedPoint[] | NormalizedQuad>;
}
export interface PresetLike {
  camIdx: number;
  presetIdx: number;
  label?: string;
  coveredSlotIds?: string[];
}
export interface GlobalSlotIndexEntry {
  globalIdx: number;
  slotId: string;
  camIdx: number;
  presetIdx: number;
}
export interface ArtifactLike {
  presets?: PresetLike[];
  slots?: SlotLike[];
  globalIndex?: GlobalSlotIndexEntry[];
  createdAt?: string;
  warnings?: string[];
  report?: string;
  [k: string]: unknown;
}

export function diffArtifactVsCameras(
  artifact: ArtifactLike | null | undefined,
  cameras: CameraListItem[] | undefined,
): { artifactOnly: string[]; camerasOnly: string[] };
export function pointInRect(nx: number, ny: number, rect: NormalizedRect | null | undefined): boolean;
export function pointInQuad(nx: number, ny: number, quad: NormalizedPoint[] | null | undefined): boolean;
export function hitTestSlots(args: {
  nx: number;
  ny: number;
  slots: readonly SlotLike[] | undefined;
  key: string;
  layers?: { vehicle?: boolean; floor?: boolean };
}): string | null;
export function rebuildGlobalIndex(
  slots: readonly { slotId: string }[] | undefined,
  presets: readonly PresetLike[] | undefined,
): GlobalSlotIndexEntry[];
export function removeSlot<T extends ArtifactLike>(artifact: T, slotId: string): T;
export function clamp01Rect(rect: NormalizedRect): NormalizedRect;
export function resizeRect(rect: NormalizedRect, handle: string, ndx: number, ndy: number): NormalizedRect;
export function updateSlotRoi<T extends ArtifactLike>(artifact: T, slotId: string, key: string, rect: NormalizedRect): T;
export function validateManualIndex(
  globalIndex: readonly { globalIdx: number; slotId?: string }[] | undefined,
): { ok: boolean; duplicates: number[]; gaps: number[] };
export function reorderGlobalIndex<T extends ArtifactLike>(artifact: T, orderedSlotIds: string[]): T | null;

export interface StreamLoopDeps {
  fetchFn: (url: string, opt: { signal: AbortSignal }) => Promise<{
    blob: () => Promise<unknown>;
    headers: { get: (name: string) => string | null };
  }>;
  makeUrl: (seq: number) => string;
  createObjectURL: (blob: unknown) => string;
  revokeObjectURL: (url: string) => void;
  setImage: (url: string) => void | Promise<void>;
  onPtz?: (headers: { get: (name: string) => string | null }) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StreamLoop {
  start: (fps: number) => void;
  stop: () => void;
  tick: () => Promise<void>;
}

export function createStreamLoop(deps: StreamLoopDeps): StreamLoop;
