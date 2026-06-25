import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LlmConfig } from '../config/llmConfig.js';
import type { SetupArtifact } from '../domain/types.js';
import { loadPrompt, renderTemplate, extractJson } from './prompts.js';
import {
  Stage1ResultSchema,
  Stage2ResultSchema,
  Stage3ResultSchema,
  type SetupBrain,
  type Stage1Input,
  type Stage1Result,
  type Stage2Input,
  type Stage2Result,
  type Stage3Input,
  type Stage3Result,
} from './SetupBrain.js';

/**
 * LLM 두뇌 런타임 (model-agnostic, 아키텍처 §8). SetupBrain 구현(전략 C — 단계별 비전 게이트).
 * OpenAI 호환 엔드포인트(vLLM/Ollama/llama.cpp)로 Qwen3-VL/Gemma3/Claude 등을 동일하게 호출한다.
 * 좌표는 만들지 않고 "판정/결정"만 반환한다. llm.enabled=false 면 모든 단계가 null(결정형 폴백).
 *
 * 단계별 프롬프트는 llm.config.json 의 setupPrompts.{stage1,stage2,stage3}.{system,user} 파일에서 로드한다.
 */
export class AgentRuntime implements SetupBrain {
  private client?: OpenAI;
  constructor(private cfg: LlmConfig) {
    if (cfg.llm.enabled) {
      const apiKey = (cfg.llm.apiKeyEnv ? process.env[cfg.llm.apiKeyEnv] : undefined) ?? 'not-needed';
      this.client = new OpenAI({ baseURL: cfg.llm.baseUrl, apiKey });
    }
  }

  get enabled(): boolean {
    return this.cfg.llm.enabled;
  }

  /** LLM 엔드포인트 연결 점검(models 목록 조회). 비활성/실패 시 false. */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.models.list();
      return true;
    } catch {
      try {
        await this.client.chat.completions.create({
          model: this.cfg.llm.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  // ── 1단계: 프리셋별 비전 판정 ──────────────────────────────
  async judgePreset(input: Stage1Input): Promise<Stage1Result | null> {
    if (!this.client || !this.cfg.setupPrompts.stage1Enabled) return null;
    const p = this.cfg.setupPrompts.stage1;
    const system = loadPrompt(p.system);
    const user = renderTemplate(loadPrompt(p.user), {
      camIdx: String(input.camIdx),
      presetIdx: String(input.presetIdx),
      boxCount: String(input.boxes.length),
      expected: input.expected !== undefined ? String(input.expected) : '미상',
      boxes: JSON.stringify(input.boxes),
    });
    return this.chatJson(system, user, (j) => Stage1ResultSchema.parse(j), input.imageBase64);
  }

  // ── 2단계: 프리셋 간 중복 제거 + 존/라벨 ───────────────────
  async dedupeAndLabel(input: Stage2Input): Promise<Stage2Result | null> {
    if (!this.client || !this.cfg.setupPrompts.stage2Enabled) return null;
    const p = this.cfg.setupPrompts.stage2;
    const system = loadPrompt(p.system);
    const user = renderTemplate(loadPrompt(p.user), {
      slotsByPreset: JSON.stringify(input.slotsByPreset, null, 2),
      ptzAdjacency: input.ptzAdjacency ?? '(없음)',
    });
    return this.chatJson(system, user, (j) => Stage2ResultSchema.parse(j));
  }

  // ── 3단계: 최종 검증 + 설치 리포트 ─────────────────────────
  async finalReport(input: Stage3Input): Promise<Stage3Result | null> {
    if (!this.client || !this.cfg.setupPrompts.stage3Enabled) return null;
    const p = this.cfg.setupPrompts.stage3;
    const system = loadPrompt(p.system);
    const user = renderTemplate(loadPrompt(p.user), {
      totalSlots: String(input.totalSlots),
      globalCount: String(input.globalCount),
      expectedVsFinal: JSON.stringify(input.expectedVsFinal, null, 2),
      warnings: input.warnings.length ? input.warnings.join('\n') : '(없음)',
    });
    // stage3 는 긴 한글 리포트(report_ko)가 핵심이라 JSON 강제(response_format) 시 토큰 한도에서
    // 잘려 무효화될 위험이 큼 → JSON 모드를 끄고 extractJson+재시도로 회수(2번 방안).
    return this.chatJson(system, user, (j) => Stage3ResultSchema.parse(j), undefined, false);
  }

  /** 셋업 산출물 자연어 검토(보조, /brain/review). 비활성 시 null. */
  async reviewSetup(artifact: SetupArtifact): Promise<string | null> {
    if (!this.client) return null;
    const summary = {
      presets: artifact.presets.map((p) => ({ key: `${p.camIdx}:${p.presetIdx}`, slots: p.coveredSlotIds.length })),
      totalSlots: artifact.slots.length,
      globalCount: artifact.globalIndex.length,
    };
    const res = await this.client.chat.completions.create({
      model: this.cfg.llm.model,
      temperature: this.cfg.llm.temperature,
      max_tokens: this.cfg.llm.maxTokens,
      messages: [
        { role: 'system', content: '너는 주차장 셋업 산출물의 이상(슬롯 누락/중복/불균형)을 점검하는 검토자다. 간결한 한국어로 답하라.' },
        { role: 'user', content: `다음 셋업 요약을 검토하라:\n${JSON.stringify(summary, null, 2)}` },
      ],
    });
    return res.choices[0]?.message?.content ?? null;
  }

  /**
   * 구조화 출력 강건 호출: JSON 모드(response_format)로 호출하고 parse 검증. 실패 시 1회 재시도,
   * 그래도 실패면 null(게이트 건너뜀 = 결정형 폴백). 게이트2 가 비-JSON 을 주던 문제 보강.
   */
  private async chatJson<T>(
    system: string,
    user: string,
    parse: (json: unknown) => T,
    imageBase64?: string,
    jsonMode = true,
  ): Promise<T | null> {
    if (!this.client) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.chat(system, user, imageBase64, jsonMode);
      if (!raw) return null;
      try {
        return parse(extractJson(raw));
      } catch {
        // 재시도(1회). 두 번째도 실패하면 null.
      }
    }
    return null;
  }

  /** system+user(+선택 이미지) 메시지로 chat 호출 → 응답 문자열. json=true 면 JSON 응답 강제. */
  private async chat(system: string, user: string, imageBase64?: string, json = false): Promise<string | null> {
    if (!this.client) return null;
    const userContent: ChatCompletionMessageParam['content'] = imageBase64
      ? [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ]
      : user;
    const res = await this.client.chat.completions.create({
      model: this.cfg.llm.model,
      temperature: this.cfg.llm.temperature,
      max_tokens: this.cfg.llm.maxTokens,
      ...(json ? { response_format: { type: 'json_object' as const } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    });
    return res.choices[0]?.message?.content ?? null;
  }
}
