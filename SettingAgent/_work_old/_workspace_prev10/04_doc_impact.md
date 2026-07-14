# 04 영향도 분석 — LLM 강제 구동(warm-up/preload) config 제어

- 작성일시: 2026-07-02 00:23:13
- 문서: `SettingAgent/docs/20260702_002313_LLM강제구동_warmup_config제어.md`
- 성격: **순수 가산(additive) 변경** — 기존 계약·시그니처 파괴 없음. 실제 구현 코드로 확인.

---

## 1. 변경 파일 및 의존성 전파

```
llmConfig.ts (WarmupSchema, LlmConfig.warmup)
   └─▶ AgentRuntime.ts (warmup() — this.cfg.warmup 소비)
          └─▶ SetupBrain.ts (warmup?() 옵셔널 시그니처)
                 ├─▶ CaptureJob.ts (deps.brain?.warmup?.() : start 발화 + checkpoint await)
                 └─▶ captureRoutes.ts (POST /capture/warmup)
                        └─▶ index.ts / server.ts (brain 주입 배선)
```

- `WarmupSchema` 는 SettingAgent 내부(`llmConfig.ts`) 전용이며 `@parkagent/types` 나 공유 도메인 타입(SlotState/ParkingEvent 등)에 **손대지 않는다** → 다른 에이전트(ActionAgent/DMAgent)로의 전파 **없음**.
- `src/util/http.ts`(`fetchWithTimeout`)·`src/util/logger.ts` 는 **재사용만** 하고 변경하지 않았다.

---

## 2. 다른 LLM 경로 — warm-up 미적용(capture 한정)

warm-up **트리거**는 `CaptureJob`(capture)과 수동 엔드포인트에만 배선됐다. 아래 경로에는 트리거를 넣지 않았다:

- **셋업**(`SetupOrchestrator`, stage1 비전 판정 `judgePreset` 등)
- **최종화**(`Finalizer`)
- **캘리브레이션**(`PtzCalibrator`)

→ 이 경로들도 콜드 로드 이슈가 이론상 가능하나, 이번 요구 범위(capture)가 아니므로 제외. 필요 시 후속 작업. **단, warm-up 이 24h keep_alive 로 모델을 로드해 두므로, capture 가 먼저 돈 뒤라면 이 경로들도 부수적으로 웜 상태의 이득을 볼 수 있다**(보장은 아님 — 확인 필요 항목).

또한 `chat()`/`chatJson()`/`finalReport()`/`recognizeFloorRoi()` 등 **기존 실호출 경로의 시그니처·동작은 완전 불변**이다(keep_alive-on-call 미채택 → OpenAI SDK `create` 무변경). warm-up 성공 시 floor ROI 의 `llmUnavailable`/`llmFloorUnavailable` 경고·폴백이 **감소**하는 것은 억지 결합이 아니라 웜 상태의 자연 결과다.

---

## 3. checkpoint 지연 영향

- **start()**: non-blocking 발화(`void ... warmup()`)이므로 **시작 지연 0**.
- **checkpoint()**: floor ROI reviewer 직전에 `await warmup()`. 모델이 이미 웜이면 warm-up 요청은 빠르게 반환(~수 초, num_predict=1). 콜드 상태면 최대 `warmup.timeoutMs`(120s)까지 이 **해당 checkpoint 만** 지연될 수 있다.
  - 단, 캡처 라운드 자체는 계속 진행되며(checkpoint 는 주기 작업), 이는 "필요할 때 강제 구동"이라는 요구 4의 의도와 일치.
  - `stopping` 상태에서는 게이트로 스킵 → 정지 시 콜드 로드 대기 없음.
- 순효과: 지연 대신 **타임아웃 폴백을 없애는 트레이드오프**. warm-up 이 성공하면 이후 checkpoint 는 웜 상태라 지연이 사라진다.

---

## 4. best-effort — 실패해도 폐해 없음

- `warmup()` 은 비200/예외를 삼키고 `false` 를 반환하며 **절대 throw 하지 않는다**.
- 모든 트리거가 반환값을 무시(start=void, checkpoint=await만)하거나 `{ok}` 로 감싸므로(라우트), warm-up 실패가 **기존 폴백 경로를 파괴하지 않는다**.
- Ollama 가 네이티브 `/api/chat` 를 노출하지 않거나 URL 유도가 실패하면 false 로 스킵 → 기존 동작 그대로(무해).

---

## 5. config 하위호환

- warmup 미지정(구 config) → `loadLlmConfig` 의 `{ ...DEFAULT.warmup, ...raw.warmup }` 병합으로 default(enabled=true, keepAlive='24h', numPredict=1, timeoutMs=120000)가 채워짐 → **크래시 없음**.
- 부분 지정(예: `keepAlive` 만) → 나머지 필드 default 유지.
- `llm` 블록·기존 필드 불변 → 기존 config 파일 그대로 로드 가능.

---

## 6. 라우트/인터페이스 시그니처 변화

- **신규 라우트**: `POST /capture/warmup` → `{ ok: boolean }`. 기존 라우트 계약 변화 없음(순수 추가). REST 클라이언트·기존 테스트 영향 없음(신규만 추가 검증).
- **인터페이스**: `SetupBrain.warmup?(): Promise<boolean>` **옵셔널** 추가 → 기존 `SetupBrain` 구현/소비자 무영향(옵셔널 체이닝).
- **Deps 시그니처**: `CaptureJobDeps.brain?: SetupBrain`, `CaptureRouteDeps.brain?: SetupBrain` **옵셔널** 추가. 기존 호출부는 brain 미주입이어도 컴파일·동작 정상(no-op).
  - 설계서 초안은 `warmup?: () => void` 클로저 주입이었으나, 리더 확정 지침대로 `brain?: SetupBrain` 직접 주입으로 구현됨(배선 단순화). 결과 계약은 동일하게 옵셔널·하위호환.
- **주입 배선**: `index.ts`(CaptureJob 조립)·`server.ts`(registerCaptureRoutes)에서 기존 `AgentRuntime` 인스턴스를 `brain` 으로 재사용 주입. `AgentRuntime` 이 `SetupBrain` 구현이라 타입 호환.

---

## 7. MCP 경계

warm-up 은 결정형 HTTP 인프라 준비 동작(수치 계산·반복 판정 아님)으로, LLM 두뇌의 판정 로직과 무관하다. MCP 두뇌/도구 경계 위반 없음.

---

## 8. 롤백

가산적 변경이므로 다음만 되돌리면 원복(기존 계약 파괴 없음):
- `llmConfig.ts` 의 `WarmupSchema`·`warmup` 필드·DEFAULT·병합 라인
- `AgentRuntime.warmup()` 메서드 + import 2줄
- `SetupBrain.warmup?()` 시그니처
- `CaptureJob`/`captureRoutes` 의 `brain?` deps·트리거 라인
- `index.ts`/`server.ts` brain 주입
- 신규 테스트 2파일·보강분

---

## 9. 확인 필요(단정 금지)

- 셋업/최종화/캘리브레이션이 capture 이후 부수적으로 웜 이득을 보는지 — 보장 아님, 실환경 확인 필요.
- 실 Ollama warm-up 후 `/api/ps` 로드·24h keep_alive 반영, 콜드 로드 흡수, floor ROI 폴백 감소는 **유닛 미포함 — 실환경 스모크로 별도 확인 필요**(현재 미수행). 상세 체크리스트는 문서 §8 참조.
