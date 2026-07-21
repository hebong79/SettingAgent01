import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { resolveProfiles, type LlmConfig, type LlmModelProfile } from '../config/llmConfig.js';
import type { LlmModelSelector } from './llmRegistry.js';
import type { SetupArtifact } from '../domain/types.js';
import { fetchWithTimeout } from '../util/http.js';
import { downscaleJpegBase64, smartResizeJpegBase64 } from '../util/image.js';
import { normalizeBox, normalizeQuad, rectToQuad } from '../domain/geometry.js';
import { logger } from '../util/logger.js';
import { loadPrompt, loadPromptPair, renderTemplate, extractJson } from './prompts.js';
import {
  Stage1ResultSchema,
  Stage2ResultSchema,
  Stage3ResultSchema,
  CheckpointResultSchema,
  FinalizeCaptureResultSchema,
  FloorRoiRawSchema,
  OccupancyRawSchema,
  type SetupBrain,
  type FloorRoiInput,
  type FloorRoiResult,
  type OccupancyInput,
  type OccupancyJudgment,
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
export class AgentRuntime implements SetupBrain, LlmModelSelector {
  private client?: OpenAI;
  private readonly profiles: LlmModelProfile[];
  private activeId: string;
  /** 마지막으로 OpenAI 클라이언트를 빌드한 활성 프로필 id(전환 감지·재빌드용). */
  private lastBuiltId?: string;

  constructor(private cfg: LlmConfig) {
    // self-normalize: models 없는 레거시 cfg 도 llm 단일 블록을 default 프로필로 승격.
    const { profiles, activeId } = resolveProfiles(cfg);
    this.profiles = profiles;
    this.activeId = activeId;
    this.ensureClient();
  }

  /** 현재 활성 프로필(id/name + 모든 llm 필드). */
  private get active(): LlmModelProfile {
    return this.profiles.find((p) => p.id === this.activeId) ?? this.profiles[0];
  }

  /** 활성 프로필 기준 OpenAI 클라이언트를 (재)빌드한다. 비활성 프로필이면 client 를 해제. */
  private ensureClient(): void {
    const a = this.active;
    if (!a.enabled) {
      this.client = undefined;
      this.lastBuiltId = undefined;
      return;
    }
    if (!this.client || this.lastBuiltId !== this.activeId) {
      const apiKey = (a.apiKeyEnv ? process.env[a.apiKeyEnv] : undefined) ?? 'not-needed';
      this.client = new OpenAI({ baseURL: a.baseUrl, apiKey, timeout: a.timeoutMs ?? 30000, maxRetries: 0 });
      this.lastBuiltId = this.activeId;
    }
  }

  get enabled(): boolean {
    return this.active.enabled;
  }

  // ── 런타임 LLM 모델 선택기(LlmModelSelector) — 동일 인스턴스 활성 프로필 스왑 ──
  listModels(): { id: string; name: string; provider: string; model: string; active: boolean }[] {
    return this.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      active: p.id === this.activeId,
    }));
  }

  selectModel(id: string): { ok: boolean; activeModel?: string } {
    if (!this.profiles.some((p) => p.id === id)) return { ok: false };
    this.activeId = id;
    this.ensureClient(); // 새 프로필의 baseUrl/timeout/apiKey 로 클라이언트 재빌드(또는 해제).
    return { ok: true, activeModel: id };
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
          model: this.active.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * LLM 강제 구동(warm-up/preload). Ollama 네이티브 `/api/chat` 에 keep_alive 를 실어 모델을 미리 로드/유지한다.
   * 콜드 로드(수십 초)로 인한 실호출 타임아웃·폴백을 방지한다. best-effort — 성공 true, 비활성/실패 false(throw 안 함).
   * 모든 파라미터(URL·keepAlive·numPredict·timeout·model·on/off)는 cfg.warmup 유래(하드코딩 없음).
   */
  async warmup(): Promise<boolean> {
    const w = this.cfg.warmup;
    // 게이트(no-op): llm 비활성 / warmup off / 비-Ollama(claude·codex) → fetch 미호출.
    if (!this.active.enabled || w?.enabled === false || this.active.provider === 'claude' || this.active.provider === 'codex') {
      logger.debug({ enabled: this.active.enabled, provider: this.active.provider, warmup: w?.enabled }, 'warm-up 스킵(게이트)');
      return false;
    }
    // 엔드포인트: warmup.url 우선, 없으면 baseUrl 의 /v1 을 벗겨 /api/chat 유도.
    const baseChat = this.active.baseUrl.replace(/\/v1\/?$/, '') + '/api/chat';
    const endpoint = w?.url ?? baseChat;
    const model = w?.model ?? this.active.model;
    const keepAlive = w?.keepAlive ?? '24h';
    const timeoutMs = w?.timeoutMs ?? 120000;
    const apiKey = this.active.apiKeyEnv ? process.env[this.active.apiKeyEnv] : undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: '.' }],
      stream: false,
      keep_alive: keepAlive,
      options: { num_predict: w?.numPredict ?? 1 },
    });
    try {
      const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body }, timeoutMs);
      if (res.ok) {
        logger.info({ endpoint, model, keepAlive }, 'LLM warm-up 성공');
        return true;
      }
      logger.warn({ endpoint, status: res.status }, 'LLM warm-up 비200(폴백 유지)');
      return false;
    } catch (err) {
      logger.warn({ endpoint, err: err instanceof Error ? err.message : String(err) }, 'LLM warm-up 실패(폴백 유지)');
      return false;
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
    // 정확도 경로: smart-resize 로 28정렬 이미지 준비 → 모델이 그 (W,H) 픽셀로 그라운딩.
    const prepared = await this.prepareGroundingImage(input.imageBase64);
    if (!prepared) return null;
    const { base64, width: W, height: H } = prepared;
    const { system, user: userTpl } = loadPromptPair(this.cfg.floorRoi.prompt);
    // 대상 차량 bbox 를 전송 이미지 픽셀 [x1,y1,x2,y2] 로 렌더(모델 좌표계 정합).
    const v = input.vehicle;
    const vehiclePx = [
      Math.round(v.x * W),
      Math.round(v.y * H),
      Math.round((v.x + v.w) * W),
      Math.round((v.y + v.h) * H),
    ];
    const user = renderTemplate(userTpl, {
      camIdx: String(input.camIdx),
      presetIdx: String(input.presetIdx),
      imgW: String(W),
      imgH: String(H),
      vehiclePx: JSON.stringify(vehiclePx),
    });
    const raw = await this.chatJson(
      system,
      user,
      (j) => FloorRoiRawSchema.parse(j),
      base64,
      true, // floor 는 단일 소형 객체 → json_object(guided) 유지.
      this.cfg.floorRoi.timeoutMs,
      true, // prepared: chat() 재다운스케일 건너뜀(이미 정확 크기).
    );
    if (!raw) return null;
    // 픽셀 → "보낸 이미지 (W,H)" 기준 정규화 0~1 폴리곤(경계 흡수). 다운스트림 무변경.
    const polygon = raw.points_2d
      ? normalizeQuad(raw.points_2d, W, H)
      : rectToQuad(normalizeBox(raw.bbox_2d!, W, H));
    return { polygon, confidence: raw.confidence };
  }

  // ── 차량 점유율 판정(프리셋 단위 비전 — 면별 occupied 플래그, 산술은 결정형) ──
  // 면별 occupied 만 LLM 이 책임. occupiedCount/total/rate 는 파싱 후 코드가 집계(LLM 산술 미신뢰).
  async judgeOccupancy(input: OccupancyInput): Promise<OccupancyJudgment | null> {
    if (!this.client || this.cfg.occupancy?.enabled !== true) return null;
    const prepared = await this.prepareGroundingImage(input.imageBase64);
    if (!prepared) return null;
    const { base64, width: W, height: H } = prepared;
    const { system, user: userTpl } = loadPromptPair(this.cfg.occupancy.prompt);
    const user = renderTemplate(userTpl, {
      camIdx: String(input.camIdx),
      presetIdx: String(input.presetIdx),
      imgW: String(W),
      imgH: String(H),
      expected: input.expected !== undefined ? String(input.expected) : '미상',
    });
    const parsed = await this.chatJson(
      system,
      user,
      (j) => OccupancyRawSchema.parse(j),
      base64,
      false, // guided JSON off — extractJson+재시도로 회수(stage3/finalize 선례). 다면 프리셋 디코딩 가속.
      this.cfg.occupancy?.timeoutMs,
      true, // prepared: chat() 재다운스케일 건너뜀.
    );
    if (!parsed) return null;
    // 각 면의 픽셀 points/bbox → "보낸 이미지 (W,H)" 기준 정규화 폴리곤(경계 흡수).
    // 둘 다 없으면 폴리곤 미보유(집계엔 포함, 오버레이만 skip — 기존 optional 계약 유지).
    const spaces = parsed.spaces.map((s) => {
      const polygon = s.points_2d
        ? normalizeQuad(s.points_2d, W, H)
        : s.bbox_2d
          ? rectToQuad(normalizeBox(s.bbox_2d, W, H))
          : undefined;
      return { id: s.id, occupied: s.occupied, ...(polygon ? { polygon } : {}) };
    });
    const total = spaces.length;
    const occupiedCount = spaces.filter((s) => s.occupied).length;
    return {
      spaces,
      occupiedCount,
      total,
      rate: total > 0 ? occupiedCount / total : 0,
      confidence: parsed.confidence,
    };
  }

  /** 셋업 산출물 자연어 검토(보조, /brain/review). 비활성 시 null. */
  async reviewSetup(artifact: SetupArtifact): Promise<string | null> {
    if (!this.client) return null;
    const summary = {
      presets: artifact.presets.map((p) => ({ key: `${p.camIdx}:${p.presetIdx}`, slots: p.coveredSlotIds.length })),
      totalSlots: artifact.slots.length,
      globalCount: artifact.globalIndex.length,
    };
    // 텍스트 보조 호출도 chat() 공통 경로로 라우팅 → api:'ollama' 시 네이티브 think:false 적용(잔존 thinking 제거).
    return this.chat(
      '너는 주차장 셋업 산출물의 이상(슬롯 누락/중복/불균형)을 점검하는 검토자다. 간결한 한국어로 답하라.',
      `다음 셋업 요약을 검토하라:\n${JSON.stringify(summary, null, 2)}`,
    );
  }

  /**
   * 그라운딩 정확도 경로용 이미지 준비: smart-resize 로 28정렬(전송 크기 확보). 실패 시 null(그레이스풀 스킵).
   * 반환 (W,H) 는 sharp 재인코딩 실측치 — 픽셀→정규화 변환의 기준(원본 크기 아님).
   */
  private async prepareGroundingImage(
    imageBase64: string,
  ): Promise<{ base64: string; width: number; height: number } | null> {
    try {
      return await smartResizeJpegBase64(imageBase64, this.active.imageMaxEdge ?? 1288);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '그라운딩 이미지 리사이즈 실패(스킵)');
      return null;
    }
  }

  /**
   * 구조화 출력 강건 호출: JSON 모드(response_format)로 호출하고 parse 검증. 실패 시 1회 재시도,
   * 그래도 실패면 null(게이트 건너뜀 = 결정형 폴백). 게이트2 가 비-JSON 을 주던 문제 보강.
   * prepared=true 면 이미지가 이미 정확 크기(smart-resize)라 chat() 내부 다운스케일을 건너뛴다.
   */
  private async chatJson<T>(
    system: string,
    user: string,
    parse: (json: unknown) => T,
    imageBase64?: string,
    jsonMode = true,
    timeoutMs?: number,
    prepared = false,
  ): Promise<T | null> {
    if (!this.client) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.chat(system, user, imageBase64, jsonMode, timeoutMs, prepared);
      if (!raw) return null;
      try {
        return parse(extractJson(raw));
      } catch {
        // 재시도(1회). 두 번째도 실패하면 null.
      }
    }
    return null;
  }

  /**
   * system+user(+선택 이미지) 메시지로 chat 호출 → 응답 문자열. json=true 면 JSON 응답 강제.
   * 이미지가 있으면 전송 직전 종횡비 유지 균일 축소(다운스케일). api 설정에 따라 네이티브/OpenAI 라우팅.
   */
  private async chat(system: string, user: string, imageBase64?: string, json = false, timeoutMs?: number, prepared = false): Promise<string | null> {
    if (!this.client) return null;
    let image = imageBase64;
    // prepared=true 면 이미 smart-resize 로 정확 크기 → 재다운스케일 금지(좌표계 불일치 방지).
    if (image && !prepared && this.active.imageMaxEdge) {
      try {
        image = await downscaleJpegBase64(image, this.active.imageMaxEdge);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, '비전 이미지 다운스케일 실패(원본 사용)');
      }
    }
    return this.active.api === 'ollama'
      ? this.chatNative(system, user, image, json, timeoutMs)
      : this.chatOpenai(system, user, image, json, timeoutMs);
  }

  /** Ollama 네이티브 `/api/chat` 전송(think:false 지원). 이미지는 messages[user].images=[b64]. */
  private async chatNative(system: string, user: string, imageBase64?: string, json = false, timeoutMs?: number): Promise<string | null> {
    const endpoint = this.active.baseUrl.replace(/\/v1\/?$/, '') + '/api/chat';
    const apiKey = this.active.apiKeyEnv ? process.env[this.active.apiKeyEnv] : undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    const userMsg: Record<string, unknown> = { role: 'user', content: user };
    if (imageBase64) userMsg.images = [imageBase64];
    const body = JSON.stringify({
      model: this.active.model,
      stream: false,
      think: this.active.think,
      ...(json ? { format: 'json' } : {}),
      options: { temperature: this.active.temperature, num_predict: this.active.maxTokens },
      keep_alive: this.cfg.warmup?.keepAlive ?? '24h',
      messages: [{ role: 'system', content: system }, userMsg],
    });
    const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body }, timeoutMs ?? this.active.timeoutMs ?? 30000);
    if (!res.ok) {
      logger.warn({ endpoint, status: res.status }, 'LLM 네이티브 chat 비200(폴백)');
      return null;
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? null;
  }

  /** OpenAI 호환 `/v1/chat/completions` 전송(SDK). 이미지는 image_url data URL. */
  private async chatOpenai(system: string, user: string, imageBase64?: string, json = false, timeoutMs?: number): Promise<string | null> {
    if (!this.client) return null;
    const userContent: ChatCompletionMessageParam['content'] = imageBase64
      ? [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ]
      : user;
    const res = await this.client.chat.completions.create(
      {
        model: this.active.model,
        temperature: this.active.temperature,
        max_tokens: this.active.maxTokens,
        ...(json ? { response_format: { type: 'json_object' as const } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      },
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
    );
    return res.choices[0]?.message?.content ?? null;
  }
}
