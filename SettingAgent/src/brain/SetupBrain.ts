import { z } from 'zod';
import type { NormalizedRect } from '@parkagent/types';

/**
 * SettingAgent 셋업 두뇌 인터페이스 (전략 C — 단계별 비전 게이트).
 * 좌표는 만들지 않고 "판정/결정"만 반환한다. AgentRuntime 이 구현, 오케스트레이터가 주입받는다.
 */

// ── 1단계: 프리셋별 비전 판정 ──────────────────────────────
export interface PresetBoxInfo {
  box: number; // 1-based, buildSlots 의 positionIdx
  roi: NormalizedRect;
  confidence: number;
}
export interface Stage1Input {
  camIdx: number;
  presetIdx: number;
  /** 번호 오버레이된 캡처 이미지(base64 JPEG). 비전 모델용. 없으면 텍스트만. */
  imageBase64?: string;
  boxes: PresetBoxInfo[];
  expected?: number;
}
export const Stage1ResultSchema = z.object({
  validBoxes: z.array(z.number().int()),
  excluded: z.array(z.object({ box: z.number().int(), reason: z.string() })).default([]),
  orderOk: z.boolean(),
  reorder: z.array(z.number().int()).optional(),
  rescan: z.object({ needed: z.boolean(), reason: z.string() }).default({ needed: false, reason: '' }),
  confidence: z.number().min(0).max(1).default(0),
});
export type Stage1Result = z.infer<typeof Stage1ResultSchema>;

// ── 2단계: 프리셋 간 중복 제거 + 존/라벨 ───────────────────
export interface Stage2Input {
  slotsByPreset: Array<{ key: string; slotIds: string[] }>;
  ptzAdjacency?: string;
}
export const Stage2ResultSchema = z.object({
  duplicates: z.array(z.array(z.string())).default([]),
  zoneLabels: z.record(z.string(), z.string()).default({}),
  notes: z.string().optional(),
});
export type Stage2Result = z.infer<typeof Stage2ResultSchema>;

// ── 3단계: 최종 검증 + 설치 리포트 ─────────────────────────
export interface Stage3Input {
  totalSlots: number;
  globalCount: number;
  expectedVsFinal: Array<{ preset: string; expected: number; final: number }>;
  warnings: string[];
}
export const Stage3ResultSchema = z.object({
  approved: z.boolean(),
  totalSlots: z.number().int(),
  globalCount: z.number().int(),
  mismatches: z
    .array(z.object({ preset: z.string(), expected: z.number().int(), final: z.number().int(), likelyCause: z.string() }))
    .default([]),
  report_ko: z.string(),
  confidence: z.number().min(0).max(1).default(0),
});
export type Stage3Result = z.infer<typeof Stage3ResultSchema>;

// ── 체크포인트(장기 관측 수집 중간 보정) ─────────────────────
// 좌표 불변: LLM 은 클러스터 병합/라벨/거부 판정과 커버리지·수렴 자문만(좌표 생성/수정 금지).
export interface CheckpointInput {
  atRound: number;
  plannedCount: number;
  presets: Array<{ key: string; slotCount: number; expected?: number; avgOccupancy: number }>;
  /** 최근 K회 신규 면 수(수렴 신호 입력). */
  newFacesRecentK: number;
}
export const CheckpointResultSchema = z.object({
  merges: z.array(z.array(z.string())).default([]), // 같은 면으로 볼 `presetKey#clusterId` 그룹
  labels: z.record(z.string(), z.string()).default({}), // `presetKey#clusterId` → zone 라벨
  rejects: z.array(z.string()).default([]), // 노이즈 `presetKey#clusterId`
  coverage: z
    .array(z.object({ preset: z.string(), expected: z.number(), got: z.number(), short: z.boolean() }))
    .default([]),
  convergence: z.object({ converged: z.boolean(), advice: z.string() }).default({ converged: false, advice: '' }),
});
export type CheckpointResult = z.infer<typeof CheckpointResultSchema>;

// ── 최종화(전체 집계 → 보조 판정) ───────────────────────────
export interface FinalizeCaptureInput {
  totalSlots: number;
  presets: Array<{ key: string; slotCount: number; expected?: number }>;
  /** 체크포인트 누적 요약(자문 문자열). */
  checkpointNotes: string[];
}
export const FinalizeCaptureResultSchema = z.object({
  duplicates: z.array(z.array(z.string())).default([]), // 프리셋 간 중복 `presetKey#clusterId` 그룹
  zoneLabels: z.record(z.string(), z.string()).default({}), // slotId → zone 라벨
  rejects: z.array(z.string()).default([]),
  report_ko: z.string().default(''),
});
export type FinalizeCaptureResult = z.infer<typeof FinalizeCaptureResultSchema>;

/** 셋업 두뇌. 비활성/실패 시 각 메서드는 null 을 반환(결정형 폴백). */
export interface SetupBrain {
  readonly enabled: boolean;
  judgePreset(input: Stage1Input): Promise<Stage1Result | null>;
  dedupeAndLabel(input: Stage2Input): Promise<Stage2Result | null>;
  finalReport(input: Stage3Input): Promise<Stage3Result | null>;
  /** 체크포인트 보정(옵셔널 — 기존 구현 무영향). 비활성 시 null. */
  reviewCheckpoint?(input: CheckpointInput): Promise<CheckpointResult | null>;
  /** 최종화 보조 판정(옵셔널). 비활성 시 null. */
  finalizeCapture?(input: FinalizeCaptureInput): Promise<FinalizeCaptureResult | null>;
}
