# 01 설계서 — LLM 강제 구동(warm-up/preload)로 폴백 대신 실제 LLM 사용

## 배경·문제 (확정)
- Ollama(192.168.0.210:11434) 유휴 시 모델 언로드(기본 keep_alive ~5분). 12B 콜드 로드 수십 초 → `llm.timeoutMs`(30s) 초과 실패 → floor ROI 등 폴백 → "LLM 동작 안 함" 경고 반복.
- 해법: 사용 직전 모델을 미리 로드(warm-up)해 첫 실호출이 콜드 로드에 걸리지 않게 한다.

## ★ 리더 확인 1순위 — keep_alive-on-call 은 불가(웹조사 결론)
요구 3("실제 호출에 keep_alive 실어 만료 리셋")은 **현재 Ollama 에서 동작하지 않는다**:
- OpenAI 호환 `/v1/chat/completions` 는 body 의 `keep_alive`(OpenAI SDK v4 `extra_body` 포함)를 **무시**하고 기본 5분으로 리셋한다. (알려진 이슈 #11458 = dup #2963, 0.9.6 기준 미해결)
- 반면 **네이티브 `/api/chat`·`/api/generate` 의 keep_alive 는 정상 반영**되며 `OLLAMA_KEEP_ALIVE` 환경변수를 override 한다.
- 근거: ollama/ollama#11458, #2963, Ollama OpenAI 호환 문서.

→ **결론(채택안 = 대안 B)**: `chat()`/`finalReport` 의 OpenAI SDK create 에 keep_alive 를 넣는 방식은 **효과가 없어 채택하지 않는다**. 대신 **네이티브 `/api/chat` warm-up 을 keep_alive="24h" 로 걸어 유지**하고, 실제 사용 경로 **직전에 warm-up 을 보장**한다(= 필요할 때 강제 구동). 5분 유휴로 언로드돼도, 사용 직전 warm-up 이 재로드하므로 실호출은 항상 웜 상태.

- **왜 대안 B**: SDK-on-call 은 근본적으로 무효(무시됨). warm-up-직전-보장은 코드로 완결(서버 환경변수 의존 X)되고, 이미 요구 4(트리거)와 자연 결합.
- **대안 A(참고, 미채택)**: 서버에 `OLLAMA_KEEP_ALIVE=0`(무한 유지) 설정. 가장 확실하나 **우리 앱 밖(서버 관리자 영역)**이라 코드로 보장 불가 → 운영 노트로만 병기.
- **불필요한 백그라운드 타이머**: 24h warm-up + 사용직전 보장이면 상시 폴링 불필요 → 과설계 회피(단순함 우선).

## (a) 설정 스키마·기본값 (llmConfig.ts) — ★ warm-up 전체를 config 로 제어(하드코딩 금지)
warm-up 요청의 **엔드포인트·keepAlive·num_predict·timeout·on/off·model** 을 전부 config 로 조정. `llm` 밑이 아닌 **별도 최상위 `warmup` 블록**(옵셔널 — 미설정 시 default 로 활성)으로 분리(관심사 분리, floorRoi/centering 과 동일 패턴):
```
const WarmupSchema = z.object({
  enabled:    z.boolean().default(true),                 // false → warm-up no-op(강제구동 off)
  url:        z.string().url().optional(),               // 명시 시 이 URL 로 직접 호출. 미지정 시 baseUrl 유도
  keepAlive:  z.string().default('24h'),                 // 네이티브 /api/chat keep_alive
  numPredict: z.number().int().positive().default(1),    // options.num_predict
  timeoutMs:  z.number().int().positive().default(120000),// 콜드 로드용 긴 타임아웃(실호출 30s 와 분리)
  model:      z.string().min(1).optional(),              // 미지정 시 llm.model 사용
});
// LlmConfigSchema 에 추가:  warmup: WarmupSchema.optional()
```
- **엔드포인트 결정 로직**(warmup 메서드에서): `warmup.url` 있으면 그대로 사용, 없으면 `llm.baseUrl.replace(/\/v1\/?$/,'') + '/api/chat'` 유도. → URL/경로 변경 시 **코드 수정 없이 `warmup.url` 만** 세팅.
- **model 결정**: `warmup.model ?? llm.model`.
- `DEFAULT_LLM_CONFIG` 에 `warmup: { enabled:true, keepAlive:'24h', numPredict:1, timeoutMs:120000 }` 추가.
- **loadLlmConfig 병합**: 기존 패턴대로 `warmup: { ...DEFAULT.warmup, ...(raw.warmup as object) }` 라인 추가(부분 지정 시 default 채움). LlmConfigSchema.parse 로 검증.
- **`llm` 블록은 변경 없음**(기존 keepAlive/warmupTimeoutMs 를 llm 밑에 넣지 않음 — 리더 지시대로 별도 warmup 블록으로 일원화).

**llm.config.json warmup 블록 예시**(실서버 gemma4:12b):
```json
"warmup": {
  "enabled": true,
  "keepAlive": "24h",
  "numPredict": 1,
  "timeoutMs": 120000
}
```
(URL 을 바꿔야 하면 `"url": "http://192.168.0.210:11434/api/chat"` 를 추가하면 baseUrl 유도를 덮어씀. `"enabled": false` 로 강제구동 전체 off.)

검증: DEFAULT 파싱 시 warmup default 존재; warmup 미지정 config 로드 시 default 채워짐(enabled=true); 부분 지정(예: keepAlive 만) 시 나머지 default.

## (b) warmup 메서드 (AgentRuntime.ts)
```
async warmup(): Promise<boolean>
```
`const w = this.cfg.warmup` (미설정 시 WarmupSchema default — loadLlmConfig 에서 항상 채워짐).
- **게이트(no-op, false 반환)**: `!this.cfg.llm.enabled` **또는** `w.enabled === false` → 즉시 false(fetch 미호출). 비-Ollama 판정: provider `claude`/`codex` 이면 false. (그 외 provider + 아래 엔드포인트 유도 성립 시 시도.)
- **엔드포인트**: `w.url ?? (this.cfg.llm.baseUrl.replace(/\/v1\/?$/, '') + '/api/chat')`. `w.url` 미지정인데 baseUrl 이 `/v1` 로 안 끝나면(유도 불가·비-Ollama) false 로 스킵.
- **body**: `{ model: w.model ?? cfg.llm.model, messages:[{role:'user',content:'.'}], stream:false, keep_alive: w.keepAlive, options:{ num_predict: w.numPredict } }`.
- **호출**: `fetchWithTimeout(endpoint, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }, w.timeoutMs)`.
- **best-effort**: try/catch 로 예외·비200 을 삼키고 `logger.info/warn` 1줄. 성공(res.ok)=true, 그 외 false. **던지지 않는다**(폴백 유지). fetchWithTimeout 자체가 packet 로그를 남기므로 warmup 은 결과 요약 로그만.
- 반환 bool 은 수동 엔드포인트 응답·테스트 검증용(트리거는 값 무시).
- 모든 파라미터(URL·keepAlive·numPredict·timeout·model·on/off)가 config 유래 → **하드코딩 없음**.

검증: 아래 (f).

## (c) 실제 호출 keep_alive — 미채택(위 ★ 참조)
`chat()`/`finalReport` 의 `client.chat.completions.create({...})` 는 **변경하지 않는다**. (/v1 이 keep_alive 무시 → 넣어도 무효, 코드만 지저분). 대신 유지 책임은 (b) warm-up + (d) 사용직전 보장이 진다.
- (만약 리더가 그래도 시도를 원하면: OpenAI SDK v4 는 create 의 두 번째 인자가 아니라 **첫 인자 객체에 미지의 키를 그대로 실어** 전송하므로 `create({..., keep_alive: cfg.warmup.keepAlive} as any)` 로 전달 가능하나, 위 근거상 Ollama /v1 이 무시하므로 무의미. 문서화용으로만 기록.)

## (d) 트리거 지점 — "필요할 때 강제 구동"
브레인 인스턴스는 `index.ts` 의 concrete `AgentRuntime`(warmup 보유). `SetupBrain` 인터페이스엔 warmup 없음 → **옵셔널 추가**: `SetupBrain.warmup?():Promise<boolean>` (구현은 AgentRuntime). 트리거측은 `brain.warmup?.()` 로 안전 호출.

1. **capture start() 비동기 발화(핵심)**: CaptureJob 이 brain 미보유 → `CaptureJobDeps` 에 `warmup?: () => void` (또는 `brain?: SetupBrain`) 주입. `start()` 진입 직후(runId 생성 후, 첫 라운드 타이머 전) **non-blocking** 발화: `void this.deps.warmup?.()`. 라운드1 캡처·검출(수 초) 동안 12B 로드 → 첫 checkpoint(K라운드 후) 의 floor ROI 실호출은 웜. **start 지연 0**(await 안 함).
   - 최소침습 선택: `index.ts` 에서 `captureJob` 조립 시 `warmup: () => void brain.warmup?.()` 클로저 주입(CaptureJob 은 AgentRuntime 타입 몰라도 됨).
2. **checkpoint 직전 보장**: `CaptureJob.checkpoint()`(floorReviewer.review 직전)에서 `await this.deps.warmup?.()`(best-effort, 실패해도 진행). 5분+ 라운드 간격으로 언로드됐어도 floor ROI LLM 직전 재로드 → 폴백 감소. warmupTimeoutMs(120s)로 콜드 로드 흡수. (checkpoint 는 이미 async·주기적이라 여기가 "필요한 시점".)
3. **수동 엔드포인트**: (e).
- **범위 제한(과설계 금지)**: 셋업(SetupOrchestrator)·최종화(Finalizer)·캘리브레이션(PtzCalibrator)에는 이번에 트리거 **넣지 않는다**. 우선순위=capture(요구 명시). 필요 시 후속. (셋업 stage1 비전도 콜드 이슈 가능하나, 이번 요청 범위 밖 — 리더 판단 사항으로만 표기.)

검증: start() 호출 시 warmup 클로저 1회 발화(await 안 함); checkpoint 실행 시 warmup 1회 await.

## (e) 수동 강제 구동 엔드포인트
`POST /capture/warmup` (captureRoutes.ts, 얇은 진입점):
- `CaptureRouteDeps` 에 `warmup?: () => Promise<boolean>` 주입(index.ts 에서 `() => brain.warmup?.() ?? Promise.resolve(false)`).
- 핸들러: `const ok = await deps.warmup?.() ?? false; return { ok };`. 미주입/비활성 시 `{ ok:false }`.
- 사용자가 "필요할때마다 강제로" 즉시 로드 가능. (별도 /llm/warmup 라우트 신설보다 기존 captureRoutes 재사용이 단순.)

검증: 주입 시 200 + `{ok:true|false}`; 미주입 시 `{ok:false}`.

## (f) 유닛테스트 케이스 (vitest, 외부 HTTP 모킹)
`test/warmup.test.ts` 신설 + 기존 captureJob.test.ts 보강.
- **AgentRuntime.warmup**(global.fetch 모킹):
  1. 기본(warmup 미설정→default)·baseUrl `/v1` → `POST {base}/api/chat` 1회, body 에 `model`, `keep_alive==='24h'`, `stream===false`, `options.num_predict===1` 포함. → true.
  2. **baseUrl 유도**: baseUrl `http://h:11434/v1` → 호출 URL `http://h:11434/api/chat` (`/v1/` 트레일링슬래시 변형도).
  3. **warmup.url 오버라이드**: `warmup.url='http://other:99/api/chat'` 지정 시 baseUrl 유도 무시하고 그 URL 로 호출.
  4. **config 파라미터 반영**: `warmup.keepAlive='1h'`·`numPredict=3`·`model='m2'`·`timeoutMs=5000` 지정 → body 의 keep_alive/num_predict/model 이 그대로, fetchWithTimeout 3번째 인자==5000.
  5. **warmup.enabled=false 게이트**: fetch 미호출, false.
  6. **llm.enabled=false 게이트**: fetch 미호출, false.
  7. **실패 삼킴**: fetch reject/500 → 예외 없이 false, 로그 warn.
  8. **비-Ollama 게이트**: provider `claude`(또는 warmup.url 없이 baseUrl `/v1` 아님) → fetch 미호출, false.
- **loadLlmConfig**: warmup 미지정 config → default(enabled=true,keepAlive='24h',numPredict=1,timeoutMs=120000); 부분 지정(keepAlive 만) → 나머지 default 유지.
- **트리거**:
  7. CaptureJob.start() → 주입 warmup 스파이 1회 호출, start 반환이 warmup await 에 안 막힘(동기 반환 확인).
  8. checkpoint 경로 → warmup await 1회(fake timer 로 K라운드 진행).
- **수동 엔드포인트**(captureRoutes 테스트): `/capture/warmup` → warmup 스파이 호출·`{ok}` 반환; 미주입 `{ok:false}`.
- (create 에 keep_alive 미포함 — (c) 미채택이므로 해당 테스트 없음. 기존 chat 테스트 불변 확인.)

## (g) 영향도 분석
- **수정 파일**: `src/config/llmConfig.ts`(WarmupSchema 신설·LlmConfigSchema.warmup·DEFAULT·loadLlmConfig 병합), `config/llm.config.json`(warmup 블록 추가), `src/brain/AgentRuntime.ts`(warmup 메서드), `src/brain/SetupBrain.ts`(옵셔널 warmup 시그니처), `src/capture/CaptureJob.ts`(start 발화·checkpoint 보장·deps.warmup), `src/api/captureRoutes.ts`(POST /capture/warmup·deps.warmup), `src/index.ts`(warmup 클로저 주입 2곳). `src/util/http.ts` 재사용(변경 없음). **`llm` 블록·기존 필드 불변**(warmup 은 순수 가산 최상위 블록).
- **다른 LLM 경로**: chat/chatJson/finalReport/recognizeFloorRoi 등 **시그니처·동작 불변**(create 미변경). 부수효과로 웜 상태라 floor ROI `llmUnavailable` 경고·폴백 **감소**(억지 결합 아님 — warm-up 성공의 자연 결과).
- **시작 지연**: start() 는 non-blocking 발화라 **0 지연**. checkpoint 는 이미 async 주기 작업 — warmup await(≤120s)만큼 해당 checkpoint 만 지연되나 캡처 라운드는 계속(요구 4 의도).
- **비활성/비-Ollama**: 전 트리거가 `brain.warmup?.()` 옵셔널 체이닝·no-op → claude/codex/enabled=false 환경 무영향.
- **MCP 경계**: warm-up 은 결정형 HTTP(수치·반복 아님, 인프라 준비). LLM 두뇌 판정 로직 불변. 경계 위반 없음.
- **롤백**: 설정 2필드·warmup 메서드·트리거 주입만 되돌리면 원복(가산적, 기존 계약 파괴 없음).
- **운영 노트(코드 외)**: 가장 확실한 상시 유지는 서버 `OLLAMA_KEEP_ALIVE=0` 환경변수(관리자). 본 설계는 그것 없이도 사용직전 warm-up 으로 폴백을 없앤다.

## 미해결/가정
- 가정: 실서버 Ollama 가 네이티브 `/api/chat`(11434, non-/v1) 를 노출한다(표준 설치면 참). 아니면 warm-up false→기존 폴백 동작(무해).
- 리더 확인: (1) ★ keep_alive-on-call 미채택(대안 B: warm-up-직전-보장) 승인 여부. (2) 트리거 범위를 capture 로 한정(셋업/최종화 제외) 승인 여부.

## 근거 링크
- ollama/ollama#11458 (/v1 keep_alive 무시, dup #2963), Ollama OpenAI 호환 문서, Ollama FAQ(네이티브 keep_alive override·OLLAMA_KEEP_ALIVE).
