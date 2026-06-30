import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LlmConfig } from '../config/llmConfig.js';
import type { SetupArtifact } from '../domain/types.js';
import { loadPrompt, loadPromptPair, renderTemplate, extractJson } from './prompts.js';
import {
  Stage1ResultSchema,
  Stage2ResultSchema,
  Stage3ResultSchema,
  CheckpointResultSchema,
  FinalizeCaptureResultSchema,
  FloorRoiResultSchema,
  CenteringAdviceSchema,
  type SetupBrain,
  type FloorRoiInput,
  type FloorRoiResult,
  type CenteringAdviceInput,
  type CenteringAdvice,
  type Stage1Input,
  type Stage1Result,
  type Stage2Input,
  type Stage2Result,
  type Stage3Input,
  type Stage3Result,
  type CheckpointInput,
  type CheckpointResult,
  type FinalizeCaptureInput,
  type FinalizeCaptureResult,
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

  // ── 체크포인트: 장기 관측 중간 보정(텍스트 요약만 — §11-4) ───
  // 1차는 인라인 한글 프롬프트(단순함 우선). 좌표 불변 — 병합/라벨/거부 판정·자문만.
  async reviewCheckpoint(input: CheckpointInput): Promise<CheckpointResult | null> {
    if (!this.client) return null;
    const system =
      '너는 주차장 장기 관측 수집의 중간 체크포인트 검토자다. ' +
      '좌표(bbox)는 절대 만들거나 바꾸지 않는다. ' +
      '같은 면으로 볼 클러스터 병합(merges), 존 라벨(labels), 노이즈 클러스터 거부(rejects), ' +
      '기대 대비 부족 프리셋(coverage), 수렴 여부와 자문(convergence)만 판단한다. ' +
      'JSON 으로만 답하라.';
    const user =
      `라운드 ${input.atRound}/${input.plannedCount}, 최근 신규 면 수=${input.newFacesRecentK}.\n` +
      `프리셋별 집계 요약(JSON):\n${JSON.stringify(input.presets, null, 2)}\n` +
      '클러스터 식별자는 "presetKey#clusterId" 형식이다. ' +
      '스키마: { merges: string[][], labels: {key:label}, rejects: string[], ' +
      'coverage: [{preset, expected, got, short}], convergence: {converged, advice} }';
    return this.chatJson(system, user, (j) => CheckpointResultSchema.parse(j));
  }

  // ── 최종화: 전체 집계 보조 판정(중복 제거/라벨/노이즈/리포트) ──
  async finalizeCapture(input: FinalizeCaptureInput): Promise<FinalizeCaptureResult | null> {
    if (!this.client) return null;
    const system =
      '너는 주차장 장기 관측 수집의 최종 판정자다. 좌표(bbox)는 만들거나 바꾸지 않는다. ' +
      '프리셋 간 중복 클러스터 그룹(duplicates), 존 라벨(zoneLabels), 노이즈 거부(rejects), ' +
      '한국어 설치 리포트(report_ko)만 산출한다. JSON 으로만 답하라.';
    const user =
      `총 슬롯=${input.totalSlots}.\n프리셋 요약(JSON):\n${JSON.stringify(input.presets, null, 2)}\n` +
      `체크포인트 누적 메모:\n${input.checkpointNotes.length ? input.checkpointNotes.join('\n') : '(없음)'}\n` +
      'zoneLabels 의 키는 slotId 이다. duplicates/rejects 의 식별자는 "presetKey#clusterId" 형식이다. ' +
      '스키마: { duplicates: string[][], zoneLabels: {slotId:label}, rejects: string[], report_ko: string }';
    return this.chatJson(system, user, (j) => FinalizeCaptureResultSchema.parse(j), undefined, false);
  }

  // ── 바닥 점유 영역(floor ROI · 4점) 비전 추론 ──────────────
  // 좌표 "생성" 단계(원근 접지면). 검증·강등·폴백은 호출측 결정형(capture/floorRoi.ts).
  async recognizeFloorRoi(input: FloorRoiInput): Promise<FloorRoiResult | null> {
    if (!this.client || this.cfg.floorRoi?.enabled !== true) return null;
    const { system, user: userTpl } = loadPromptPair(this.cfg.floorRoi.prompt);
    const user = renderTemplate(userTpl, {
      camIdx: String(input.camIdx),
      presetIdx: String(input.presetIdx),
      vehicle: JSON.stringify(input.vehicle),
      plate: input.plate ? JSON.stringify(input.plate) : '(없음)',
    });
    return this.chatJson(system, user, (j) => FloorRoiResultSchema.parse(j), input.imageBase64);
  }

  // ── 캘리브레이션 중심정렬·줌 자문(좌표 생성 아님 — 소폭 보정 제안·판정) ──
  // 인라인 한글 프롬프트(reviewCheckpoint 스타일, 단순함 우선). 호출측이 클램프·폴백.
  async adviseCentering(input: CenteringAdviceInput): Promise<CenteringAdvice | null> {
    if (!this.client) return null;
    const { system, user: userTpl } = loadPromptPair(this.cfg.centering?.prompt ?? 'config/prompts/ptz_centering.yaml');
    const user = renderTemplate(userTpl, {
      phase: input.phase,
      errX: input.err.errX.toFixed(3),
      errY: input.err.errY.toFixed(3),
      plateWidth: input.plateWidth.toFixed(3),
      targetWidth: String(input.target.targetWidth),
      centerTol: String(input.target.centerTol),
    });
    return this.chatJson(system, user, (j) => CenteringAdviceSchema.parse(j), input.imageBase64);
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
