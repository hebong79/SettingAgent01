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
  latestAdvisory?: string[];
}

export function captureProgress(status: Partial<CaptureStatus> | null | undefined): {
  percent: number;
  label: string;
};
export function mapAdvisory(status: Partial<CaptureStatus> | null | undefined): string[];
export function pollPlan(state: string, intervalMs?: number): { poll: boolean; intervalMs: number };

export function toPixel(rect: NormalizedRect, imgW: number, imgH: number): PixelRect;
export function presetKey(camIdx: number | string, presetIdx: number | string): string;
export function slotLabel(slotId: string, globalIndex?: GlobalIndexEntry[]): string;
export function fpsToInterval(fps: number): number;
export function clampZoom(z: number, min?: number, max?: number): number;
export function stepPtz(cur: Ptz, dir: string, step: number): Ptz;
export function clampPanelWidth(px: number, min?: number, max?: number): number;

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
