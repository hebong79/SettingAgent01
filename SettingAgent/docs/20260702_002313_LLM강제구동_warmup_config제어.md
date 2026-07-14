# LLM 강제 구동(warm-up/preload) config 제어 — 상세 문서

- 작성일시: 2026-07-02 00:23:13
- 대상: SettingAgent
- 관련 산출물: `_workspace/01_architect_plan.md`(설계), `_workspace/02_developer_changes.md`(구현), `_workspace/03_qa_report.md`(검증)

---

## 1. 문제 (콜드 로드 → 타임아웃 → 폴백)

- SettingAgent 의 LLM 두뇌는 Ollama(실서버 192.168.0.210:11434)를 사용한다.
- Ollama 는 모델이 유휴 상태이면 일정 시간(기본 `keep_alive` ~5분) 후 모델을 메모리에서 **언로드**한다.
- 언로드된 상태에서 첫 호출이 들어오면 12B 모델을 다시 로드하는 **콜드 로드**가 발생하며, 이는 수십 초가 걸린다.
- 실호출 타임아웃(`llm.timeoutMs`, 30s)을 초과하면 호출이 실패하고, floor ROI 같은 비전 판정이 **폴백 경로**로 빠지면서 로그에 "LLM 동작 안 함"(`llmUnavailable` / `llmFloorUnavailable`) 경고가 반복된다.
- 결과적으로 실제로는 LLM 이 정상 동작 가능한 환경인데도, 유휴 언로드 타이밍 때문에 폴백이 발생하는 문제.

**해법 방향**: 실제 사용 직전에 모델을 미리 로드(warm-up)해 두어, 첫 실호출이 콜드 로드에 걸리지 않게 한다.

---

## 2. 원인 조사 — 왜 keep_alive-on-call 이 아니라 warm-up 인가

직관적으로는 "실제 호출(`chat()`/`finalReport`)에 `keep_alive` 를 실어 매 호출마다 만료 시각을 리셋"하는 방법이 가장 단순해 보인다. 그러나 웹 조사 결과 **현재 Ollama 에서 이 방법은 동작하지 않는다**:

- 본 코드가 사용하는 경로는 **OpenAI 호환** `/v1/chat/completions` 이다. 이 경로는 body 의 `keep_alive`(OpenAI SDK v4 `extra_body` 포함)를 **무시하고 기본 5분으로 리셋**한다. (알려진 이슈: ollama/ollama#11458 = dup #2963, 0.9.6 기준 미해결)
- 반면 **네이티브 `/api/chat`·`/api/generate` 의 `keep_alive` 는 정상 반영**되며, 서버의 `OLLAMA_KEEP_ALIVE` 환경변수까지 override 한다.

→ **결론**: `chat()`/`finalReport` 의 OpenAI SDK create 에 `keep_alive` 를 넣는 방식(keep_alive-on-call)은 효과가 없어 **채택하지 않는다**. 대신 **네이티브 `/api/chat` 에 warm-up 요청을 `keep_alive="24h"` 로 걸어** 모델을 로드·유지하고, 실제 사용 경로 **직전에 warm-up 을 보장**한다.

- 서버에 `OLLAMA_KEEP_ALIVE=0`(무한 유지)을 설정하는 방법(대안 A)이 가장 확실하나, 이는 **우리 앱 밖(서버 관리자 영역)**이라 코드로 보장할 수 없어 운영 노트로만 병기한다.
- 상시 폴링 백그라운드 타이머는 24h warm-up + 사용 직전 보장으로 불필요해 도입하지 않는다(과설계 회피).

---

## 3. warmup config 스키마

warm-up 요청의 **엔드포인트·keepAlive·num_predict·timeout·on/off·model** 을 전부 config 로 제어한다(하드코딩 없음). `llm` 밑이 아닌 **별도 최상위 `warmup` 블록**(옵셔널)으로 분리했다(floorRoi/centering 과 동일 패턴 — 관심사 분리).

### 3.1 스키마 (`src/config/llmConfig.ts` — `WarmupSchema`)

| 필드 | 타입 | 기본값 | 의미 |
|------|------|--------|------|
| `enabled` | boolean | `true` | `false` 이면 warm-up 전체 no-op(강제 구동 off). |
| `url` | string(url), 옵셔널 | (없음) | 명시하면 이 URL 로 직접 호출. **미지정 시 `baseUrl` 에서 유도**. URL/포트/경로가 바뀌어도 코드 수정 없이 이 필드만 세팅. |
| `keepAlive` | string | `'24h'` | 네이티브 `/api/chat` 의 `keep_alive`. 모델을 얼마나 유지할지. |
| `numPredict` | int > 0 | `1` | `options.num_predict`. warm-up 은 로드만 하면 되므로 1토큰. |
| `timeoutMs` | int > 0 | `120000` | 콜드 로드용 긴 타임아웃. 실호출(`llm.timeoutMs` 30s)과 **분리**해 콜드 로드(수십 초)를 흡수. |
| `model` | string(min 1), 옵셔널 | (없음) | 미지정 시 `llm.model` 사용. |

`LlmConfigSchema` 에 `warmup: WarmupSchema.optional()` 로 추가. `DEFAULT_LLM_CONFIG.warmup = { enabled:true, keepAlive:'24h', numPredict:1, timeoutMs:120000 }`. `loadLlmConfig` 병합에 `warmup: { ...DEFAULT_LLM_CONFIG.warmup, ...(raw.warmup as object) }` 를 추가해 **부분 지정 시 나머지는 default 로 채움**(하위호환).

`llm` 블록과 기존 필드는 **변경 없음** — warmup 은 순수 가산 최상위 블록이다.

### 3.2 예시 JSON (`config/llm.config.json`)

기본(실서버):
```json
"warmup": {
  "enabled": true,
  "keepAlive": "24h",
  "numPredict": 1,
  "timeoutMs": 120000
}
```

URL 을 직접 지정해야 할 때(baseUrl 유도를 덮어씀):
```json
"warmup": {
  "enabled": true,
  "url": "http://192.168.0.210:11434/api/chat",
  "keepAlive": "24h",
  "numPredict": 1,
  "timeoutMs": 120000
}
```

강제 구동 전체 off:
```json
"warmup": { "enabled": false }
```

---

## 4. warmup 메서드 동작 (`src/brain/AgentRuntime.ts`)

시그니처: `async warmup(): Promise<boolean>` (`SetupBrain` 인터페이스에는 `warmup?(): Promise<boolean>` 옵셔널로 선언).

동작 순서:

1. **게이트(no-op, false 반환, fetch 미호출)**: 다음 중 하나면 즉시 `false` 반환하고 로그(`logger.debug`)만 남긴다.
   - `!this.cfg.llm.enabled` (LLM 비활성)
   - `warmup.enabled === false` (warm-up off)
   - provider 가 `claude` 또는 `codex` (비-Ollama)
2. **엔드포인트 유도**: `warmup.url` 이 있으면 그대로 사용. 없으면 `baseUrl.replace(/\/v1\/?$/, '') + '/api/chat'` 로 유도한다(`/v1`·`/v1/` 두 변형 모두 정확히 치환). 즉 OpenAI 호환 baseUrl 에서 `/v1` 을 벗겨 네이티브 `/api/chat` 로 전환.
3. **model 결정**: `warmup.model ?? llm.model`.
4. **body**(네이티브 `/api/chat` 스키마, snake_case 주의):
   ```json
   { "model": "...", "messages": [{ "role": "user", "content": "." }],
     "stream": false, "keep_alive": "24h", "options": { "num_predict": 1 } }
   ```
5. **호출**: `fetchWithTimeout(endpoint, { method:'POST', headers, body }, warmup.timeoutMs)`. `llm.apiKeyEnv` 가 있으면 `Authorization: Bearer <key>` 헤더를 추가한다.
6. **best-effort**: `res.ok` 이면 `true`(info 로그), 비200 이면 `false`(warn), 예외이면 catch 후 `false`(warn). **절대 throw 하지 않는다** → 실패해도 기존 폴백 경로가 그대로 유지된다.

반환 bool 은 수동 엔드포인트 응답·테스트 검증용이며, 자동 트리거는 값을 무시한다.

모든 파라미터(URL·keepAlive·numPredict·timeout·model·on/off)가 config 유래 → **하드코딩 없음**.

---

## 5. 트리거 지점 — "필요할 때 강제 구동"

warm-up 은 브레인 인스턴스(`AgentRuntime`)가 보유한다. `CaptureJob`/`captureRoutes` 는 `SetupBrain` 을 옵셔널 주입받아 `brain?.warmup?.()` 옵셔널 체이닝으로 호출한다.

### 5.1 자동 (capture 한정)

1. **`CaptureJob.start()` 비동기 발화(핵심)** — 런 생성 직후:
   ```ts
   void this.deps.brain?.warmup?.();   // non-blocking, await 안 함
   ```
   `start()` 는 warm-up 완료를 기다리지 않으므로 **시작 지연 0**. 라운드1 캡처·검출(수 초) 동안 12B 로드가 진행되어, 첫 checkpoint 의 floor ROI 실호출은 웜 상태가 된다.

2. **`checkpoint()` 직전 await 재보장** — LLM reviewer/floorReviewer 호출 직전:
   ```ts
   if (this.currentState() !== 'stopping') await this.deps.brain?.warmup?.();
   ```
   라운드 간격(5분+)으로 모델이 언로드됐어도, floor ROI LLM 사용 **직전에 재로드**를 보장한다. `warmup.timeoutMs`(120s)로 콜드 로드를 흡수한다. 정지(`stopping`) 중이면 콜드 로드 대기를 피하기 위해 스킵한다.

### 5.2 수동 엔드포인트

`POST /capture/warmup` (`src/api/captureRoutes.ts`):
```ts
const ok = await deps.brain?.warmup?.();
return { ok: ok ?? false };
```
사용자가 필요할 때마다 즉시 로드를 강제할 수 있다. brain 미주입/비활성 시 `{ ok: false }`.

### 5.3 범위 제한

셋업(`SetupOrchestrator`)·최종화(`Finalizer`)·캘리브레이션(`PtzCalibrator`)에는 이번에 트리거를 **넣지 않았다**(우선순위 = capture, 요구 명시). 필요 시 후속 작업.

---

## 6. keep_alive 지속 전략

- warm-up 요청에 `keep_alive="24h"` 를 걸어, 한 번 로드된 모델이 24시간 동안 유지되도록 요청한다(네이티브 `/api/chat` 이므로 반영됨).
- 5분 유휴로 언로드가 발생하더라도, **사용 직전 재 warm-up**(checkpoint 직전 await)이 재로드를 보장하므로 실호출은 항상 웜 상태다.
- 즉 지속성은 "24h keep_alive" + "사용 직전 보장"의 이중 안전망으로 확보한다. 상시 폴링 타이머는 불필요.

---

## 7. 검증 결과 (검증 보고 03 인용)

- **전체 vitest**: `Test Files 61 passed (61)`, `Tests 503 passed (503)` — 실패 0. (베이스라인 59파일/477테스트 → 신규 2파일 `warmup.test.ts`(16), `warmupTimeout.test.ts`(2) + captureJob 6 + captureRoutes 3 = +26 테스트, 전부 통과. 기존 477 회귀 통과.)
- **typecheck**: `tsc --noEmit` 에러 0(exit 0).
- **발견 이슈**: 없음(구현이 설계 §a/§b/§d/§e 와 일치).

검증된 케이스 요약:

- **warmup 메서드**: 엔드포인트 유도(`/v1`·`/v1/`→`/api/chat`), `warmup.url` 오버라이드, body 필드(`keep_alive`/`num_predict`/`model`), 파라미터 반영(keepAlive/numPredict/model/timeoutMs), 게이트(warmup.enabled=false / llm.enabled=false / provider claude / provider codex / warmup 블록 미설정→활성), best-effort(비200·예외 시 throw 안 함). 모두 ✅
- **timeoutMs 전달**: `fetchWithTimeout` 3번째 인자로 `warmup.timeoutMs`(5000/120000) 전달 확인(별도 `warmupTimeout.test.ts`). ✅
- **loadLlmConfig 병합**: DEFAULT warmup 값, warmup 미지정→default 채움, 실 config 로드 활성 확인. ✅
- **트리거**: start() 1회 발화(비블로킹 동기 반환), checkpoint 도달 시 재보장(총 2회), stopping 중 스킵(1회), brain 미주입 no-op, warmup false 여도 잡 정상 done. ✅
- **수동 엔드포인트**: 성공 `{ok:true}`, 실패 `{ok:false}`, 미주입 `{ok:false}`. ✅

---

## 8. 수동 동작 확인 체크리스트 (실환경 스모크 — 현재 미수행, 별도 확인 필요)

외부 서비스(Ollama 192.168.0.210:11434)는 유닛에서 전량 모킹했다. 아래는 실 연동 스모크로 별도 확인이 필요하다:

- [ ] **실 Ollama warm-up 후 로드 확인**: `POST /capture/warmup` 호출 → Ollama `GET /api/ps`(또는 `/api/tags`)로 12B 모델이 로드되어 `keep_alive` 만료 시각이 ~24h 로 세팅됐는지 확인.
- [ ] **콜드 로드 흡수**: 모델 언로드(5분 유휴) 상태에서 capture `start()` → 라운드1 동안 warm-up 이 12B 로드를 흡수 → 첫 checkpoint 의 floor ROI 실호출이 웜 상태(타임아웃 폴백 없음)인지 로그(`LLM warm-up 성공` / floor ROI `llmUnavailable` 미발생)로 확인.
- [ ] **floor ROI 실동작**: warm-up 도입 후 실 수집에서 `llmFloorUnavailable` 경고가 감소/소멸하는지 확인.
- [ ] **config 오버라이드 반영**: `config/llm.config.json` warmup 블록의 `enabled:false` / `url` 조정 후 재기동 시 게이트/엔드포인트가 config 대로 바뀌는지 확인.

---

## 9. 운영 노트

- **config 반영 시점**: warmup 블록은 프로세스 기동 시 `loadLlmConfig` 로 읽힌다. 값을 바꾸면 **SettingAgent 재시작** 후 반영된다(핫 리로드 없음).
- **URL 변경 대응**: Ollama 호스트/포트/경로가 바뀌면 `warmup.url` 을 세팅하면 된다(코드 수정 불필요). 미지정 시 `llm.baseUrl` 에서 `/api/chat` 를 유도한다.
- **가장 확실한 상시 유지**: 서버 측 `OLLAMA_KEEP_ALIVE=0`(무한 유지) 환경변수(관리자 영역). 본 기능은 그것 없이도 사용 직전 warm-up 으로 폴백을 없앤다.
- **가정**: 실서버 Ollama 가 네이티브 `/api/chat`(11434, non-/v1)를 노출한다(표준 설치면 참). 아니면 warm-up 이 false 를 반환하고 기존 폴백 동작으로 되돌아간다(무해).

---

## 10. 변경 파일 목록

| 파일 | 변경 |
|------|------|
| `src/config/llmConfig.ts` | `WarmupSchema` 신설, `LlmConfigSchema.warmup`, `DEFAULT_LLM_CONFIG.warmup`, `loadLlmConfig` 병합 |
| `config/llm.config.json` | `warmup` 블록 추가 |
| `src/brain/SetupBrain.ts` | `warmup?(): Promise<boolean>` 옵셔널 시그니처 |
| `src/brain/AgentRuntime.ts` | `warmup()` 메서드 구현(`fetchWithTimeout`/`logger` import) |
| `src/capture/CaptureJob.ts` | `CaptureJobDeps.brain?`, start() 비동기 발화, checkpoint 직전 await 재보장 |
| `src/api/captureRoutes.ts` | `CaptureRouteDeps.brain?`, `POST /capture/warmup` |
| `src/index.ts`, `src/api/server.ts` | brain 주입 배선(기존 AgentRuntime 인스턴스 재사용) |
| `test/warmup.test.ts`, `test/warmupTimeout.test.ts` | 신규 유닛 테스트 |
| `test/captureJob.test.ts`, `test/captureRoutes.test.ts` | 트리거·엔드포인트 테스트 보강 |
