# 02 구현 변경 요약 — LLM 강제 구동(warm-up/preload)

## 개요
Ollama 유휴 언로드로 인한 콜드 로드(수십 초) → 실호출 타임아웃 → floor ROI 등 폴백을 방지하기 위해,
사용 직전 모델을 미리 로드/유지하는 warm-up 기능을 가산(additive)·외과적으로 구현했다.
`chat()`/`finalReport`/기존 LLM 실호출 경로는 **무변경**. 순수 최상위 `warmup` config 블록·`warmup()` 메서드·트리거 주입만 추가.

## 수정 파일 · 지점

### 1. `src/config/llmConfig.ts` — config 스키마·기본값·병합
- `WarmupSchema` 신설(z.object): `enabled`(default true), `url`(url, optional), `keepAlive`(default '24h'), `numPredict`(int>0, default 1), `timeoutMs`(int>0, default 120000), `model`(min1, optional).
- `LlmConfigSchema` 에 `warmup: WarmupSchema.optional()` 추가.
- `DEFAULT_LLM_CONFIG` 에 `warmup: { enabled:true, keepAlive:'24h', numPredict:1, timeoutMs:120000 }` 추가.
- `loadLlmConfig` 병합에 `warmup: { ...DEFAULT_LLM_CONFIG.warmup, ...(raw.warmup as object) }` 라인 추가(부분 지정 시 default 채움 → 하위호환).
- `llm` 블록·기존 필드 불변.

### 2. `config/llm.config.json` — warmup 블록 명시
- `centering` 뒤에 `"warmup": { "enabled": true, "keepAlive": "24h", "numPredict": 1, "timeoutMs": 120000 }` 추가.
- URL 변경 시 `"url": "http://192.168.0.210:11434/api/chat"` 추가로 baseUrl 유도 덮어쓰기 가능. `"enabled": false` 로 전체 off.

### 3. `src/brain/SetupBrain.ts` — 인터페이스 시그니처
- `SetupBrain` 에 `warmup?(): Promise<boolean>` 옵셔널 추가(하위호환 — 기존 구현·호출 무영향).

### 4. `src/brain/AgentRuntime.ts` — warmup 메서드 구현
- import 추가: `fetchWithTimeout`(../util/http.js), `logger`(../util/logger.js).
- `async warmup(): Promise<boolean>` 신설(`ping()` 다음):
  - **게이트(no-op, false 반환, fetch 미호출)**: `!cfg.llm.enabled` 또는 `warmup.enabled === false` 또는 provider `claude`/`codex`. 로그 `logger.debug`.
  - **엔드포인트**: `warmup.url ?? (cfg.llm.baseUrl.replace(/\/v1\/?$/,'') + '/api/chat')`.
  - **model**: `warmup.model ?? cfg.llm.model`.
  - **body**: `{ model, messages:[{role:'user',content:'.'}], stream:false, keep_alive, options:{ num_predict } }`.
  - **호출**: `fetchWithTimeout(endpoint, { method:'POST', headers, body }, timeoutMs)`. `apiKeyEnv` 있으면 `Authorization: Bearer` 헤더 추가.
  - **best-effort**: `res.ok`→true(info 로그), 비200→false(warn), 예외→catch 후 false(warn). **절대 throw 안 함**(폴백 유지).
  - 모든 파라미터가 cfg.warmup 유래 → 하드코딩 없음.

### 5. `src/capture/CaptureJob.ts` — 자동 트리거(capture 한정)
- import 추가: `SetupBrain`(../brain/SetupBrain.js, type-only).
- `CaptureJobDeps` 에 `brain?: SetupBrain` 추가(옵셔널).
- `start()`: 런 생성 직후 `void this.deps.brain?.warmup?.();` **non-blocking 발화**(start 지연 0 — await 안 함).
- `checkpoint()` 진입 직후(LLM reviewer/floorReviewer 호출 직전): `if (this.currentState() !== 'stopping') await this.deps.brain?.warmup?.();` 로 재보장(모델 로드 확정). best-effort — 실패해도 진행. 정지 중이면 콜드 로드 대기 회피 위해 스킵.

### 6. `src/api/captureRoutes.ts` — 수동 엔드포인트
- import 추가: `SetupBrain`(type-only).
- `CaptureRouteDeps` 에 `brain?: SetupBrain` 추가.
- `POST /capture/warmup` 신설(`/capture/status` 다음): `const ok = await deps.brain?.warmup?.(); return { ok: ok ?? false };`. 미주입/비활성 시 `{ ok:false }`.

### 7. 주입 배선(index.ts / server.ts)
- `src/index.ts`: `new CaptureJob({ ..., brain, ... })` — 기존 `brain`(AgentRuntime) 인스턴스 재사용 주입.
- `src/api/server.ts`: `registerCaptureRoutes(app, { ..., brain: deps.brain })` — `RegisterDeps.brain?: AgentRuntime`(기존 필드) 전달. `AgentRuntime` 이 `SetupBrain` 구현이라 타입 호환.

## config 스키마 (신규 warmup 블록)
```
warmup?: {
  enabled:    boolean  = true       // false → warm-up 전체 no-op
  url?:       string(url)           // 미지정 시 baseUrl 에서 /api/chat 유도
  keepAlive:  string   = '24h'      // 네이티브 /api/chat keep_alive
  numPredict: int>0    = 1          // options.num_predict
  timeoutMs:  int>0    = 120000     // 콜드 로드용 긴 타임아웃(실호출 30s 와 분리)
  model?:     string                // 미지정 시 llm.model
}
```

## 엔드포인트
- `POST /capture/warmup` → `{ ok: boolean }` (best-effort. LLM 비활성/비-Ollama/미주입 시 `{ok:false}`).

## 트리거
- **자동(capture 한정)**: `CaptureJob.start()` non-blocking 발화 + `checkpoint()` 직전 await 재보장.
- **수동**: `POST /capture/warmup`.
- 셋업/최종화/캘리브레이션에는 트리거 미추가(리더 확정 범위 — capture 한정).

## typecheck 결과
`npm run typecheck` (tsc -p tsconfig.json --noEmit) — **통과(에러 0)**.

## 설계 대비 편차
- **딜리버리 방식 변경(리더 확정 반영)**: 설계서 (d)/(e)는 `CaptureJobDeps.warmup?: () => void`·`CaptureRouteDeps.warmup?: () => Promise<boolean>` 클로저 주입을 제안했으나,
  리더 확정 지침대로 **`brain?: SetupBrain` 를 직접 주입**하고 트리거측에서 `this.deps.brain?.warmup?.()` / `deps.brain?.warmup?.()` 옵셔널 체이닝 호출로 구현했다.
  (`SetupBrain.warmup?()` 옵셔널이라 안전 호출·하위호환 동일. index.ts 클로저 조립이 불필요해져 배선이 더 단순.)
- 그 외(config 스키마·warmup 메서드 로직·엔드포인트·게이트·keep_alive-on-call 미채택)는 설계서·리더 지침과 일치.
- 테스트 파일은 생성하지 않음(qa-tester 담당).

## 하위호환 / 안전성
- warmup 미설정(구 config) → loadLlmConfig 가 default 로 채움(enabled=true) → 크래시 없음.
- `brain` 미주입 / provider claude·codex / llm.enabled=false → 전 트리거 no-op(옵셔널 체이닝·게이트).
- warm-up 실패 시 throw 안 함 → 기존 폴백 경로 그대로 유지.
