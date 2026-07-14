import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

/**
 * LLM 두뇌 + MCP 연결 설정 (tools.config 와 역할 분리).
 * - llm: model-agnostic 두뇌(Claude/Codex/Gemma/Qwen3). OpenAI 호환 엔드포인트로 호출.
 * - mcp: 두뇌가 연결할 MCP 도구 서버 목록.
 * 아키텍처 §8 참조.
 */

export const LlmSchema = z.object({
  provider: z.enum(['qwen3', 'gemma', 'claude', 'codex', 'gemini', 'openai-compatible']),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().optional(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  /** false 면 두뇌(LLM)를 호출하지 않고 결정형 경로만 사용한다. */
  enabled: z.boolean(),
  /** LLM 요청 타임아웃(ms). 미지정 시 30000. 느린 호출이 수 분 매달리는 것을 방지. */
  timeoutMs: z.number().int().positive().optional(),
  /** 전송 방식: 'openai'(SDK /v1) | 'ollama'(네이티브 /api/chat). 기본 'openai'(하위호환). */
  api: z.enum(['openai', 'ollama']).default('openai'),
  /** 전역 추론(thinking) 토글. 기본 false(비전 추론 폭주·타임아웃 방지). 네이티브 경로에서만 유효. */
  think: z.boolean().default(false),
  /** 비전 이미지 다운스케일 긴변 상한(px). 종횡비 유지 균일 축소. 기본 960. */
  imageMaxEdge: z.number().int().positive().default(960),
});

/**
 * LLM 모델 프로필(멀티 프로바이더). 기존 단일 llm 필드 + 식별자(id/name).
 * 모든 프로필은 OpenAI 호환 /v1 엔드포인트로 호출(Claude/Gemini 도 각자 호환 엔드포인트).
 */
export const LlmModelProfileSchema = LlmSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type LlmModelProfile = z.infer<typeof LlmModelProfileSchema>;

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
  /** floor ROI 판정 전용 요청 타임아웃(ms). 고해상도 프레임+32B 그라운딩이 llm.timeoutMs(30s)를 초과하는 문제 대응(occupancy 선례). */
  timeoutMs: z.number().int().positive().default(120000),
});

/** 차량 점유율 판정(judgeOccupancy) 설정(옵셔널 — 미설정 시 비활성). floorRoi 와 동일 패턴(관심사 분리). */
const OccupancySchema = z.object({
  enabled: z.boolean(),
  /** system/user 를 담은 단일 yaml 프롬프트 파일 경로. */
  prompt: z.string().min(1),
  /** occupancy 판정 전용 요청 타임아웃(ms). 고해상도 프레임+guided JSON 디코딩이 llm.timeoutMs(30s)를 초과하는 문제 대응. */
  timeoutMs: z.number().int().positive().default(120000),
});

/** PTZ 캘리브레이션 자문(adviseCentering) 설정(옵셔널 — 미설정 시 기본 yaml 사용). */
const CenteringSchema = z.object({
  /** system/user 를 담은 단일 yaml 프롬프트 파일 경로. */
  prompt: z.string().min(1),
});

/**
 * LLM 강제 구동(warm-up/preload) 설정(옵셔널 — 미설정 시 default 로 활성).
 * Ollama 네이티브 `/api/chat` 에 keep_alive 를 실어 모델을 미리 로드/유지한다(콜드 로드 폴백 방지).
 * 별도 최상위 블록(관심사 분리, floorRoi/centering 과 동일 패턴).
 */
const WarmupSchema = z.object({
  /** false → warm-up no-op(강제구동 off). */
  enabled: z.boolean().default(true),
  /** 명시 시 이 URL 로 직접 호출. 미지정 시 llm.baseUrl 에서 `/api/chat` 유도. */
  url: z.string().url().optional(),
  /** 네이티브 /api/chat keep_alive(모델 유지 시간). */
  keepAlive: z.string().default('24h'),
  /** options.num_predict(예열용 최소 토큰). */
  numPredict: z.number().int().positive().default(1),
  /** 콜드 로드용 긴 타임아웃(실호출 timeoutMs 와 분리). */
  timeoutMs: z.number().int().positive().default(120000),
  /** 미지정 시 llm.model 사용. */
  model: z.string().min(1).optional(),
});

export const LlmConfigSchema = z.object({
  llm: LlmSchema,
  mcp: McpSchema,
  setupPrompts: SetupPromptsSchema,
  floorRoi: FloorRoiSchema.optional(),
  occupancy: OccupancySchema.optional(),
  centering: CenteringSchema.optional(),
  warmup: WarmupSchema.optional(),
  /** 멀티 프로바이더 프로필 목록(옵셔널). 미지정 시 llm 단일 블록을 id='default' 프로필로 승격. */
  models: z.array(LlmModelProfileSchema).optional(),
  /** 활성 프로필 id(옵셔널). 미지정/불일치 시 첫 프로필로 폴백. */
  activeModel: z.string().optional(),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/**
 * 활성 프로필 정규화(로더·AgentRuntime 공용).
 * - models 없음/빈 배열 → llm 단일 블록을 id='default' 프로필로 승격.
 * - models 있음 → activeModel 로 활성 해석(불일치 시 첫 프로필).
 */
export function resolveProfiles(cfg: LlmConfig): {
  profiles: LlmModelProfile[];
  activeId: string;
  active: LlmModelProfile;
} {
  const profiles: LlmModelProfile[] =
    cfg.models && cfg.models.length > 0
      ? cfg.models
      : [{ ...cfg.llm, id: 'default', name: cfg.llm.model }];
  const active = profiles.find((p) => p.id === cfg.activeModel) ?? profiles[0];
  return { profiles, activeId: active.id, active };
}

const DEFAULT_LLM: LlmConfig['llm'] = {
  provider: 'qwen3',
  model: 'qwen3-8b',
  baseUrl: 'http://localhost:8000/v1',
  apiKeyEnv: 'LLM_API_KEY',
  temperature: 0.1,
  maxTokens: 2048,
  enabled: false,
  timeoutMs: 30000,
  api: 'openai',
  think: false,
  imageMaxEdge: 960,
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  llm: DEFAULT_LLM,
  models: [{ ...DEFAULT_LLM, id: 'default', name: DEFAULT_LLM.model }],
  activeModel: 'default',
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
    timeoutMs: 120000,
  },
  occupancy: {
    enabled: false,
    prompt: 'config/prompts/occupancy.yaml',
    timeoutMs: 120000,
  },
  centering: {
    prompt: 'config/prompts/ptz_centering.yaml',
  },
  warmup: {
    enabled: true,
    keepAlive: '24h',
    numPredict: 1,
    timeoutMs: 120000,
  },
};

/**
 * 활성 프로필 정규화: cfg.llm 이 항상 활성 프로필의 alias 가 되도록 채운다(레거시 리더 무회귀).
 * models 미지정 레거시 config 도 models=[default]·activeModel='default' 로 채워 반환.
 */
function normalizeActiveProfile(cfg: LlmConfig): LlmConfig {
  const { profiles, activeId, active } = resolveProfiles(cfg);
  const { id: _id, name: _name, ...llm } = active; // llm alias 는 id/name 없는 순수 LlmSchema 형태.
  return { ...cfg, models: profiles, activeModel: activeId, llm };
}

/** llm.config.json 을 로드한다. 파일이 없으면 기본값을 검증해 반환. `_comment` 등 부가 키는 무시. */
export function loadLlmConfig(path = 'config/llm.config.json'): LlmConfig {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const merged = {
      llm: { ...DEFAULT_LLM_CONFIG.llm, ...(raw.llm as object) },
      mcp: { ...DEFAULT_LLM_CONFIG.mcp, ...(raw.mcp as object) },
      setupPrompts: { ...DEFAULT_LLM_CONFIG.setupPrompts, ...(raw.setupPrompts as object) },
      floorRoi: { ...DEFAULT_LLM_CONFIG.floorRoi, ...(raw.floorRoi as object) },
      occupancy: { ...DEFAULT_LLM_CONFIG.occupancy, ...(raw.occupancy as object) },
      centering: { ...DEFAULT_LLM_CONFIG.centering, ...(raw.centering as object) },
      warmup: { ...DEFAULT_LLM_CONFIG.warmup, ...(raw.warmup as object) },
      // models/activeModel 은 배열/문자열 → 섹션 머지 대상 아님(raw 값 그대로 통과, 없으면 미포함).
      ...(raw.models !== undefined ? { models: raw.models } : {}),
      ...(raw.activeModel !== undefined ? { activeModel: raw.activeModel } : {}),
    };
    return normalizeActiveProfile(LlmConfigSchema.parse(merged));
  }
  return normalizeActiveProfile(LlmConfigSchema.parse(DEFAULT_LLM_CONFIG));
}
