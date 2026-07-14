# 02 · 구현 변경 요약 — LLM thinking 제어 + 비전 이미지 다운스케일(16:9)

작성: 구현자(developer) / 대상: SettingAgent / 근거: `01_architect_plan.md` + 리더 확정 결정 4항목

---

## 0. 결과 요약

- 빌드(tsc): **통과**(타입 에러 0).
- 유닛테스트: 기존 전체 **503 passed / 61 files**(회귀 없음).
- sharp 설치: **성공**(prebuilt, `sharp@0.35.3`, native 빌드 불필요, 폴백 불사용).
- 다운스케일 자체검증: 1920×1080→960×540, 800×450→불변, 1200×900→960×720(종횡비 유지, 스쿼시/크롭 없음).

---

## 1. 리더 확정 결정 반영 결과

1. **thinking = 전역 단일 토글**: config `llm.think`(옵셔널, 기본 false)만 도입. per-call 오버라이드 미도입(과설계 회피).
2. **reviewSetup()도 네이티브 라우팅 포함**: `reviewSetup()`의 직접 SDK 호출을 `chat()` 공통 경로로 라우팅 → `api:'ollama'` 시 네이티브 `think:false` 적용(잔존 thinking 제거). 최소 변경(요약 생성 로직 불변, 전송만 chat()로 위임).
3. **imageMaxEdge = 960**(기본값). 1080p → 960×540(16:9).
4. **이미지 라이브러리 = sharp**(설치 성공, jimp 폴백 불필요).

---

## 2. 변경 파일별 요약

### `package.json`
- `dependencies`에 `"sharp": "^0.35.3"` 추가. `npm install` 성공, `require('sharp')` 정상(v0.35.3).

### `src/config/llmConfig.ts`
- `LlmSchema`에 옵셔널+기본값 3필드 추가:
  - `api: z.enum(['openai','ollama']).default('openai')` — 전송 라우팅.
  - `think: z.boolean().default(false)` — 전역 추론 토글(기본 OFF).
  - `imageMaxEdge: z.number().int().positive().default(960)` — 비전 다운스케일 긴변 상한.
- `DEFAULT_LLM_CONFIG.llm`에 `api:'openai', think:false, imageMaxEdge:960` 추가.
- `loadLlmConfig` 병합(`{...DEFAULT.llm, ...raw.llm}`)은 미변경 → 기존 config(신규 키 없음)도 기본값 적용(하위호환).
- `.default()` 채택 이유: think가 undefined로 남아 네이티브 바디에서 누락→모델 기본 thinking ON이 되는 것을 방지(방어적, feature 목적 보장).

### `src/util/image.ts` (신규)
- `downscaleJpegBase64(b64, maxLongEdge): Promise<string>` — sharp `resize({width,height:maxLongEdge, fit:'inside', withoutEnlargement:true})` → JPEG(q80) → base64.
- **종횡비 유지 균일 축소만**. 긴변 초과 시에만 축소, 이하면 원본 유지(업스케일 없음). 강제 16:9 스쿼시/크롭 없음 → 정규화 좌표(0~1) 불변.
- 디코드/인코드 오류 시 throw(순수 유틸, 테스트 용이) → 호출측(chat)에서 원본 폴백 + warn 처리.

### `src/brain/AgentRuntime.ts`
- `import { downscaleJpegBase64 } from '../util/image.js'` 추가.
- `chat()`: 공통 진입점으로 재구성.
  - 이미지 존재 + `imageMaxEdge` 설정 시 전송 직전 `downscaleJpegBase64` 적용. 실패 시 원본 사용 + `warn` 로그.
  - `cfg.llm.api==='ollama'` → `chatNative()`, 아니면 `chatOpenai()` 라우팅.
- `chatNative()` (신규 private): Ollama 네이티브 `/api/chat` 전송.
  - endpoint = `baseUrl.replace(/\/v1\/?$/,'') + '/api/chat'`(warmup과 동일 패턴).
  - 바디: `{ model, stream:false, think:cfg.llm.think, format:'json'(json 모드시), options:{temperature, num_predict:maxTokens}, keep_alive:warmup.keepAlive??'24h', messages:[{system},{user, images:[b64]?}] }`.
  - `fetchWithTimeout(..., cfg.llm.timeoutMs??30000)`. 응답 `data.message.content` 반환. 비200 → warn + null(결정형 폴백).
- `chatOpenai()` (신규 private): 기존 SDK `/v1/chat/completions` 경로를 그대로 이관(이미지 `image_url` data URL, `response_format` json). 로직 불변.
- `reviewSetup()`: 직접 SDK 호출 제거, `chat(system, user)`로 위임(결정 2).
- `chatJson()`·`ping()`·`warmup()`·단계별 메서드 시그니처/로직 불변.

### `config/llm.config.json`
- `llm` 블록에 `"api":"ollama"`, `"think":false`, `"imageMaxEdge":960` 추가. provider/model 등 나머지 working copy 상태 유지.

### `test/*.ts` (기존 픽스처 9개 — 스키마 변경 파급 보정)
- 신규 필수 출력필드(api/think/imageMaxEdge) 추가로 hand-built `LlmConfig` 리터럴이 컴파일 실패 → 각 픽스처의 `llm` 리터럴에 `api:'openai', think:false, imageMaxEdge:960` 추가(순전히 스키마 변경 파급 정리, 동작 의미 불변 = 기존 SDK 목 경로 유지).
- 대상: agentRuntime, agentRuntimeCentering, agentRuntimeFloor, agentRuntimeTimeout, brainJsonMode, brainRetry, brainStages, warmup, warmupTimeout.

---

## 3. 자가 점검(형태상 정합)

- 네이티브 `/api/chat` 바디: `think`(불리언)·`format:'json'`(json 모드)·`options.num_predict`(max_tokens 매핑)·`messages[user].images:[base64]`(image_url 아님) — 플랜 §2 결정 A / 서버 실측 표(A·C2·D)와 일치.
- 다운스케일: 균일 축소·업스케일 없음·종횡비 유지 실측 확인(§0).
- 기존 floor/centering 유닛테스트: `api:'openai'`로 SDK 목 경로 유지 → 회귀 없음. 테스트의 가짜 base64는 sharp가 디코드 실패 → warn 후 원본 사용(폴백 경로도 함께 검증됨).

---

## 4. 미해결/주의점 (검증자·문서화 인계)

- **네이티브 경로 유닛테스트 미작성**: 기존 테스트는 SDK 경로만 검증. `api:'ollama'` 시 `fetchWithTimeout` 목으로 POST 바디의 `think===false`·`format==='json'`·`messages[1].images` 존재·`data.message.content` 파싱을 검증하는 테스트는 **qa-tester가 작성**(플랜 단계 4·3). 구현은 테스트 가능하도록 `downscaleJpegBase64` export, `chat` 라우팅 분리(chatNative/chatOpenai) 완료.
- **실서버 검증(플랜 단계 8)**: 192.168.0.210 실호출로 floor ROI/centering 성공 추론(폴백 소멸)·응답<5s 확인은 qa 단계에서 수행.
- **재시작 필요**: `llm.config.json` 편집은 nodemon(.ts 감시) 특성상 재시작해야 반영(기존 동작).
- **의존성**: sharp 네이티브 prebuilt(win-x64 Node20 정상). 배포/CI 환경도 동일 prebuilt 필요.
- **jimp 폴백**: 불필요(sharp 설치 성공).
