// autoPaint.js(브라우저용 순수 ESM)의 타입 선언. vitest 가 직접 로드하는 .js 와 1:1.
// core.d.ts / placeDraw.d.ts 관례와 동일한 짝 구조.

import type { NormalizedPoint } from './core.js';

/** 자동 산출 quad 1건(정규화 4점 + 격자 인덱스). `roi.auto.*` 응답 detectView.quads[] 와 동일. */
export interface AutoQuad {
  latticeIndex: number;
  quadNorm: NormalizedPoint[];
}

/** 채점된 슬롯 1건. 서버 SlotScore(src/ground/roiAutoScore.ts) 와 동일. */
export interface AutoSlotScore {
  slotIdx: number;
  iouVsManual: number;
  paintDevPx: number | null;
  matched: boolean;
  degrade: string | null;
}

/** 현재뷰 응답의 행 1건(「리스트」 단계). `roi.auto.detect{view:"current"}` 의 rows[] 와 동일. */
export interface AutoRow {
  rowIndex: number;
  paintScore: number;
  quads: Array<AutoQuad & { candidateId: string }>;
}

/** detect/score 두 응답을 접은 프리셋 뷰 1건. */
export interface AutoPaintView {
  key: string;
  camId: number | null;
  presetIdx: number | null;
  frameHash: string | null;
  quads: AutoQuad[];
  /** 'current' = 현재 화면 그대로 검출. preset 응답에는 없다(null). */
  view: 'current' | null;
  /** 현재뷰에서 실제로 쓴 PTZ(재현·채점의 유일한 입력). preset 응답에는 없다(null). */
  ptzUsed: { pan: number; tilt: number; zoom: number } | null;
  /** 보이는 행 전체. preset 응답에서는 빈 배열이다. */
  rows: AutoRow[];
  issues: string[];
  slots: AutoSlotScore[];
  scored: boolean;
  meanIoU: number | null;
  graded: boolean;
  gradeReason: string | null;
}

export interface AutoPaintSummary {
  scored: boolean;
  presetCount: number;
  quadCount: number;
  frameHashes: string[];
  keys: string[];
  meanIoU: number | null;
  minIoU: number | null;
  gradedSlots: number;
  pass98: number;
  pass95: number;
}

export interface AutoQuadItem {
  quadNorm: NormalizedPoint[];
  label: string;
}

export interface SlotScoreItem {
  slotIdx: number;
  iou: number | null;
  degrade: string | null;
  label: string;
}

export function autoPaintViews(result: unknown): AutoPaintView[];
export function autoPaintViewFor(result: unknown, key: string): AutoPaintView | null;
export function formatIoU(v: unknown): string;
export function autoQuadItems(view: AutoPaintView | null | undefined): AutoQuadItem[];
export function slotScoreItems(view: AutoPaintView | null | undefined): SlotScoreItem[];
export function passCount(result: unknown, min: number): number;
export function autoPaintSummary(result: unknown): AutoPaintSummary;
export function autoPaintSummaryText(result: unknown): string;
export function autoPaintIssues(result: unknown): Array<{ key: string; issues: string[] }>;
