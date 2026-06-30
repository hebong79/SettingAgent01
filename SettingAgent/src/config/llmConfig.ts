import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

/**
 * LLM 두뇌 + MCP 연결 설정 (tools.config 와 역할 분리).
 * - llm: model-agnostic 두뇌(Claude/Codex/Gemma/Qwen3). OpenAI 호환 엔드포인트로 호출.
 * - mcp: 두뇌가 연결할 MCP 도구 서버 목록.
 * 아키텍처 §8 참조.
 */

const LlmSchema = z.object({
  provider: z.enum(['qwen3', 'gemma', 'claude', 'codex', 'openai-compatible']),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().optional(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  /** false 면 두뇌(LLM)를 호출하지 않고 결정형 경로만 사용한다. */
  enabled: z.boolean(),
});

const McpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
});

const McpSchema = z.object({
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http']),
  servers: z.array(McpServerSchema),
});

/** 단계별 프롬프트 파일 경로(system/user). 전략 C — 단계별 비전 게이트. */
const PromptPairSchema = z.object({
  system: z.string().min(1),
  user: z.string().min(1),
});

/** 셋업 3단계 프롬프트 설정 + on/off. config 에서 단계별로 교체 가능. */
const SetupPromptsSchema = z.object({
  /** 단계별 게이트 활성화(개별 on/off). */
  stage1Enabled: z.boolean(),
  stage2Enabled: z.boolean(),
  stage3Enabled: z.boolean(),
  stage1: PromptPairSchema, // 프리셋별 비전 판정
  stage2: PromptPairSchema, // 프리셋 간 중복 제거 + 존/라벨
  stage3: PromptPairSchema, // 최종 검증 + 설치 리포트
});

/** 바닥 점유 영역(floor ROI · 4점 사변형) 비전 추론 설정(옵셔널 — 미설정 시 비활성). */
const FloorRoiSchema = z.object({
  enabled: z.boolean(),
  /** 체크포인트 1회당 LLM 호출 상한(토큰·시간 비용 제한). 초과분은 다음 주기에. */
  maxPerCheckpoint: z.number().int().positive().default(12),
  /** system/user 를 담은 단일 yaml 프롬프트 파일 경로(구분 용이). */
  prompt: z.string().min(1),
});

/** PTZ 캘리브레이션 자문(adviseCentering) 설정(옵셔널 — 미설정 시 기본 yaml 사용). */
const CenteringSchema = z.object({
  /** system/user 를 담은 단일 yaml 프롬프트 파일 경로. */
  prompt: z.string().min(1),
});

export const LlmConfigSchema = z.object({
  llm: LlmSchema,
  mcp: McpSchema,
  setupPrompts: SetupPromptsSchema,
  floorRoi: FloorRoiSchema.optional(),
  centering: CenteringSchema.optional(),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  llm: {
    provider: 'qwen3',
    model: 'qwen3-8b',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnv: 'LLM_API_KEY',
    temperature: 0.1,
    maxTokens: 2048,
    enabled: false,
  },
  mcp: {
    enabled: true,
    transport: 'stdio',
    servers: [
      { name: 'parkagent-setting-tools', transport: 'stdio', command: 'node', args: ['dist/mcp/server.js'] },
    ],
  },
  setupPrompts: {
    stage1Enabled: true,
    stage2Enabled: true,
    stage3Enabled: true,
    stage1: { system: 'config/prompts/stage1_preset_judge.system.md', user: 'config/prompts/stage1_preset_judge.user.md' },
    stage2: { system: 'config/prompts/stage2_dedupe_label.system.md', user: 'config/prompts/stage2_dedupe_label.user.md' },
    stage3: { system: 'config/prompts/stage3_final_report.system.md', user: 'config/prompts/stage3_final_report.user.md' },
  },
  floorRoi: {
    enabled: false,
    maxPerCheckpoint: 12,
    prompt: 'config/prompts/floor_roi.yaml',
  },
  centering: {
    prompt: 'config/prompts/ptz_centering.yaml',
  },
};

/** llm.config.json 을 로드한다. 파일이 없으면 기본값을 검증해 반환. `_comment` 등 부가 키는 무시. */
export function loadLlmConfig(path = 'config/llm.config.json'): LlmConfig {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const merged = {
      llm: { ...DEFAULT_LLM_CONFIG.llm, ...(raw.llm as object) },
      mcp: { ...DEFAULT_LLM_CONFIG.mcp, ...(raw.mcp as object) },
      setupPrompts: { ...DEFAULT_LLM_CONFIG.setupPrompts, ...(raw.setupPrompts as object) },
      floorRoi: { ...DEFAULT_LLM_CONFIG.floorRoi, ...(raw.floorRoi as object) },
      centering: { ...DEFAULT_LLM_CONFIG.centering, ...(raw.centering as object) },
    };
    return LlmConfigSchema.parse(merged);
  }
  return LlmConfigSchema.parse(DEFAULT_LLM_CONFIG);
}
