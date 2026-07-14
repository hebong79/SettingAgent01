# 03 · 검증 리포트 — LLM thinking 제어 + 비전 이미지 다운스케일(16:9)

작성: 검증자(qa-tester) / 대상: SettingAgent / 근거: `01_architect_plan.md` · `02_developer_changes.md` + 실제 `vitest` 실행 + 실서버(192.168.0.210) e2e

---

## 0. 결론 요약

- **판정: 통과 (구현자 재작업 불필요).**
- 유닛테스트: **전체 526 passed / 64 files** (기존 503 + 신규 23, **회귀 0**).
- 타입체크(`tsc --noEmit`): **통과**(에러 0).
- 실서버 e2e(192.168.0.210, gemma4:12b): **PASS** — 네이티브 `/api/chat` + `think:false` + `format:'json'` + 960px 다운스케일 이미지로 floor ROI류 프롬프트 호출 → **2.44초**만에 정상 JSON(4점 quad, content 비어있지 않음) 반환.
- 발견 결함: 없음. 경계면(config→chat 바디→Ollama 네이티브 스키마) 필드 일치 확인.

---

## 1. 실행 결과 (있는 그대로)

| 항목 | 명령 | 결과 |
|------|------|------|
| 신규 유닛 3파일 | `vitest run test/llmThinkConfig test/imageDownscale test/agentRuntimeNative` | **23 passed / 3 files** |
| 전체 회귀 | `npm test` | **526 passed / 64 files** (실패 0) |
| 타입 | `npm run typecheck` | 통과(에러 0) |
| 실서버 e2e | 스크래치 스크립트(네이티브 `/api/chat`) | **PASS**, 2.44s |

기존 베이스라인(구현자 보고) 503 passed 재현 확인 → 신규 23개 추가 후 526, 기존 테스트 전부 유지.

---

## 2. 작성한 유닛테스트 (외부 서버 모킹)

### 2.1 `test/llmThinkConfig.test.ts` — config 파싱 (6 tests)
- **(a) 하위호환**: 신규 3필드 없는 임시 config 로드 → `api==='openai'`, `think===false`, `imageMaxEdge===960` 기본값 적용(병합 `{...DEFAULT.llm,...raw.llm}` 경로 실통과).
- **(b) 커스텀**: `api:'ollama'` / `think:true` / `imageMaxEdge:768` 그대로 파싱.
- `DEFAULT_LLM_CONFIG.llm` 기본값 보유, 실제 `config/llm.config.json`(api=ollama·think=false·imageMaxEdge=960) 반영, `api` enum 위반·`imageMaxEdge` 0/음수 throw 검증.

### 2.2 `test/imageDownscale.test.ts` — downscaleJpegBase64 (8 tests, 실제 JPEG 바이트·sharp 경유)
- **(a)** 1920×1080 → **960×540**(16:9 종횡비 유지, 오차<0.001%).
- **(b)** 800×450(상한 이하) → **크기 불변**(업스케일 없음), 960×540(상한 동일)도 불변.
- **(c)** 4:3 (1200×900) → **960×720**(4:3 유지, 강제 16:9 스쿼시/크롭 없음). 세로형 3:4(900×1200) → 720×960(긴변=세로 기준).
- **(c-정규화 불변 핵심)**: 검은 배경에 정규화 `[0.25,0.5]×[0.25,0.5]` 흰 블록을 합성 → 다운스케일(960×720) 전후로 **흰 블록의 정규화 bbox가 동일**(±2% 이내, 원 의도 좌표 0.25/0.5와도 근접)함을 실픽셀 디코드로 측정. → `recognizeFloorRoi`의 0~1 좌표 계약이 리사이즈에 불변임을 실증.
- 재인코딩 결과가 유효 JPEG, 비-이미지 base64 입력은 throw(호출측 원본 폴백 경로 유효).

### 2.3 `test/agentRuntimeNative.test.ts` — chat 라우팅 (9 tests, fetch·SDK 모킹)
- **(a)** `api:'ollama'` → 네이티브 `http://…:11434/api/chat`로 POST, SDK `create` **미호출**. 바디: `model`, `stream:false`, `format:'json'`, `options.num_predict===3072`(maxTokens 매핑), `options.temperature===0.1`, `messages[1].images=[base64]`(문자열 배열, `image_url` 아님).
- **(b) 핵심 회귀 방지**: `think:false`가 바디에 boolean `false`로 전달되며 `undefined`가 아님(누락 시 모델 기본 thinking ON 회귀). `think:true` 지정 시 `true` 전달.
- **(d) 다운스케일 경계**: chat 진입 시 이미지가 전송 직전 축소됨 — 전송된 `images[0]`는 원본과 다르고 sharp 디코드 시 **960×540**.
- `adviseCentering`도 동일 네이티브 경로로 `think:false`·images 전송. 네이티브 비200 → `null`(결정형 폴백, throw 없음). `data.message.content` 파싱(choices[] 아님)으로 FloorRoiResult 복원.
- **(c) 하위호환**: `api:'openai'` → SDK `create` 호출·네이티브 fetch 미호출, `response_format:{type:'json_object'}`·`image_url` data URL 유지. OpenAI 경로도 이미지 다운스케일(960px) 적용 확인.

---

## 3. 경계면 교차 검증 (config → chat 바디 → Ollama 네이티브 스키마)

설계 §2 결정 A / 서버 실측표(A·C2·D)와 구현 바디를 필드 단위로 대조:

| 계약 필드 | config(llmConfig) | chatNative 바디 | Ollama 네이티브 API | 일치 |
|-----------|-------------------|-----------------|---------------------|------|
| thinking 토글 | `llm.think` | `think:` (boolean) | `think` | ✔ |
| JSON 모드 | (json 인자) | `format:'json'` | `format` | ✔ |
| 최대 토큰 | `llm.maxTokens` | `options.num_predict` | `options.num_predict` | ✔ |
| 온도 | `llm.temperature` | `options.temperature` | `options.temperature` | ✔ |
| 이미지 | `imageBase64`(다운스케일 후) | `messages[user].images:[b64]` | `images: string[]` | ✔ |
| keep_alive | `warmup.keepAlive` | `keep_alive` | `keep_alive` | ✔ |
| 응답 파싱 | — | `data.message.content` | `message.content` | ✔ |

- 다운스케일은 **정규화(0~1)에 불변** → `floorRoi.ts`/`geometry.ts`의 0~1 좌표 소비부 무영향(§2.2 c-정규화 불변 테스트로 실증). 픽셀이 아닌 정규화 좌표를 소비하므로 계약 유지.
- 엔드포인트 유도 `/(v1\/?)$/ → /api/chat`는 warmup과 동일 패턴(회귀 테스트 통과).

---

## 4. 실서버 동작 확인 (End-to-end)

서버 `http://192.168.0.210:11434`(Ollama, `/api/tags`로 gemma4:12b 존재 확인) 도달 가능 → 실호출 수행.

- **네이티브 `/api/chat` + `think:false` + `format:'json'` + 960px 다운스케일 이미지**(회색 바닥 + 붉은 차량 사각형 합성)로 floor ROI류 프롬프트 호출:
  - HTTP 200, **경과 2440ms**(목표 1~3s 부합, 30s 타임아웃 대비 대폭 여유).
  - `content` 길이 124, 유효 JSON `{"quad":[4점],"confidence":1.0}` 파싱 성공.
  - 반환 좌표(x 0.348~0.652)가 합성 차량의 실제 정규화 위치(x 0.344~0.656)와 근접 → **모델이 다운스케일 이미지를 실제로 인식**함을 확인(더미 응답 아님).
  - **thinking OFF 실효 확인**: content 비어있지 않고 응답 빠름.
- **대조(근본원인 재현)**: 동일 서버에 `think:true`로 호출 시 응답 5925ms + 별도 `thinking` 필드 채워짐 → `think` 플래그가 네이티브 경로에서 실제로 동작(false=빠름/thinking 없음, true=느림/thinking 채움). 이는 설계 실측(“/v1 경로는 content 빈문자열”)이 지목한 폴백 원인을 네이티브 `think:false`가 해소함을 뒷받침.

> 비고: 이 e2e는 `AgentRuntime.chatNative`가 구성하는 것과 동일한 바디(§3 표)를 실서버에 직접 전송해 검증. `enabled=true` 상태의 풀 SettingAgent 캡처 파이프라인 1회 구동(설계 단계 8의 "폴백 로그 소멸" 확인)은 카메라/캡처 하드웨어 의존이라 이번 검증 범위 밖 — 다만 두뇌 호출 인프라(전송 바디·thinking·다운스케일·응답 파싱)는 실서버로 통과 확인.

---

## 5. 미해결/주의점

- 신규 유닛테스트는 외부 서버(fetch)·OpenAI SDK를 모킹 → 네트워크 미접촉(CI 안전). 실연동은 §4 e2e로 별도 확인.
- 실서버 e2e는 스크래치 스크립트(`scratchpad/e2e.mjs`)로 수행 — 저장소 미오염(테스트 산출물 아님).
- `llm.config.json` 편집은 nodemon(.ts 감시) 특성상 재시작 반영(기존 동작, 운영 안내 필요 — 설계 §5 기재).
- sharp 네이티브 prebuilt(win-x64, v0.35.3) 로드 정상 확인(`sharp.versions.sharp`).

---

## 6. 산출물

- `SettingAgent/test/llmThinkConfig.test.ts` (신규, 6 tests)
- `SettingAgent/test/imageDownscale.test.ts` (신규, 8 tests)
- `SettingAgent/test/agentRuntimeNative.test.ts` (신규, 9 tests)
- 본 리포트 `SettingAgent/_workspace/03_qa_report.md`
