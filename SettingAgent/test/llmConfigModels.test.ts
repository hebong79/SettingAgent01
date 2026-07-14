import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadLlmConfig,
  resolveProfiles,
  DEFAULT_LLM_CONFIG,
  LlmConfigSchema,
  type LlmConfig,
} from '../src/config/llmConfig.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function writeCfg(obj: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'llmcfg-'));
  tmpDirs.push(d);
  const p = join(d, 'llm.config.json');
  writeFileSync(p, JSON.stringify(obj), 'utf-8');
  return p;
}

/** 스키마 최소 필수(llm/mcp/setupPrompts). floorRoi 등은 옵셔널. */
const baseLlm = {
  provider: 'qwen3',
  model: 'legacy-model',
  baseUrl: 'http://localhost:9000/v1',
  apiKeyEnv: 'LLM_API_KEY',
  temperature: 0.2,
  maxTokens: 128,
  enabled: true,
};
const baseMcp = { enabled: false, transport: 'stdio', servers: [] };
const basePrompts = {
  stage1Enabled: true,
  stage2Enabled: true,
  stage3Enabled: true,
  stage1: { system: 's1', user: 'u1' },
  stage2: { system: 's2', user: 'u2' },
  stage3: { system: 's3', user: 'u3' },
};

function profile(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id} name`,
    provider: 'openai-compatible',
    model: `${id}-model`,
    baseUrl: `http://host-${id}:8000/v1`,
    temperature: 0.1,
    maxTokens: 256,
    enabled: false,
    ...over,
  };
}

describe('resolveProfiles (순수 정규화 로직)', () => {
  it('models 없음 → llm 단일 블록을 id="default" 프로필로 승격, activeId="default"', () => {
    const cfg = LlmConfigSchema.parse({ llm: baseLlm, mcp: baseMcp, setupPrompts: basePrompts });
    const { profiles, activeId, active } = resolveProfiles(cfg);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('default');
    expect(profiles[0].name).toBe(baseLlm.model);
    expect(activeId).toBe('default');
    expect(active.model).toBe('legacy-model');
  });

  it('빈 models 배열 → default 승격', () => {
    const cfg = LlmConfigSchema.parse({ llm: baseLlm, mcp: baseMcp, setupPrompts: basePrompts, models: [] });
    const { profiles, activeId } = resolveProfiles(cfg);
    expect(profiles).toHaveLength(1);
    expect(activeId).toBe('default');
  });

  it('models + activeModel 일치 → 해당 프로필 활성', () => {
    const cfg = LlmConfigSchema.parse({
      llm: baseLlm,
      mcp: baseMcp,
      setupPrompts: basePrompts,
      models: [profile('a', { enabled: true }), profile('b')],
      activeModel: 'b',
    });
    const { activeId, active } = resolveProfiles(cfg);
    expect(activeId).toBe('b');
    expect(active.model).toBe('b-model');
  });

  it('activeModel 이 목록에 없음 → 첫 프로필 폴백', () => {
    const cfg = LlmConfigSchema.parse({
      llm: baseLlm,
      mcp: baseMcp,
      setupPrompts: basePrompts,
      models: [profile('a'), profile('b')],
      activeModel: 'ghost',
    });
    const { activeId } = resolveProfiles(cfg);
    expect(activeId).toBe('a');
  });
});

describe('loadLlmConfig — 멀티 프로바이더 로드/정규화', () => {
  it('레거시(llm-only) 파일 → models=[default], activeModel="default", llm 보존', () => {
    const p = writeCfg({ llm: baseLlm, mcp: baseMcp, setupPrompts: basePrompts });
    const cfg = loadLlmConfig(p);
    expect(cfg.activeModel).toBe('default');
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models![0].id).toBe('default');
    // cfg.llm 은 활성 프로필 alias(id/name 없는 순수 LlmSchema).
    expect(cfg.llm.model).toBe('legacy-model');
    expect(cfg.llm.enabled).toBe(true);
    expect((cfg.llm as Record<string, unknown>).id).toBeUndefined();
    expect((cfg.llm as Record<string, unknown>).name).toBeUndefined();
  });

  it('models + activeModel 파일 → 활성 해석, cfg.llm == 활성 프로필', () => {
    const p = writeCfg({
      llm: baseLlm,
      mcp: baseMcp,
      setupPrompts: basePrompts,
      models: [profile('qwen', { enabled: true }), profile('claude', { enabled: false })],
      activeModel: 'claude',
    });
    const cfg = loadLlmConfig(p);
    expect(cfg.activeModel).toBe('claude');
    expect(cfg.models).toHaveLength(2);
    // cfg.llm 은 활성(claude) 프로필의 필드를 반영(레거시 리더 무회귀 alias).
    expect(cfg.llm.model).toBe('claude-model');
    expect(cfg.llm.baseUrl).toBe('http://host-claude:8000/v1');
    expect(cfg.llm.enabled).toBe(false);
    expect((cfg.llm as Record<string, unknown>).id).toBeUndefined();
  });

  it('activeModel 불일치 파일 → 첫 프로필로 폴백(activeModel 재기록)', () => {
    const p = writeCfg({
      llm: baseLlm,
      mcp: baseMcp,
      setupPrompts: basePrompts,
      models: [profile('first', { enabled: true }), profile('second')],
      activeModel: 'does-not-exist',
    });
    const cfg = loadLlmConfig(p);
    expect(cfg.activeModel).toBe('first');
    expect(cfg.llm.model).toBe('first-model');
  });

  it('파일 없음 → DEFAULT_LLM_CONFIG(신 필드 포함) 그대로', () => {
    const cfg = loadLlmConfig('config/__nope__.json');
    expect(cfg).toEqual(DEFAULT_LLM_CONFIG);
    expect(cfg.activeModel).toBe('default');
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models![0].id).toBe('default');
  });

  it('실제 config/llm.config.json → activeModel=qwen-vl, 프로필 4개, llm alias=활성', () => {
    const cfg = loadLlmConfig();
    expect(cfg.activeModel).toBe('qwen-vl');
    expect(cfg.models).toHaveLength(4);
    const active = cfg.models!.find((m) => m.id === cfg.activeModel)!;
    expect(active.enabled).toBe(true);
    // llm alias 가 활성 프로필과 정합.
    expect(cfg.llm.model).toBe(active.model);
    expect(cfg.llm.baseUrl).toBe(active.baseUrl);
  });

  it('DEFAULT_LLM_CONFIG 는 스키마 파싱 통과(신 필드 포함)', () => {
    expect(() => LlmConfigSchema.parse(DEFAULT_LLM_CONFIG)).not.toThrow();
  });
});
