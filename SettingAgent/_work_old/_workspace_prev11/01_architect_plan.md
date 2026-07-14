# 01 · 설계서 — LLM 추론(thinking) 제어 + 비전 이미지 다운스케일(16:9)

작성: 설계자(architect) / 대상: SettingAgent / 트리거: 마스터 요구(thinking 기본 OFF + config 토글, 비전 호출 전 다운스케일)

---

## 0. 요약 (한 문단)

gemma4:12b는 thinking 모델이고, 비전 호출 시 추론이 폭주해 30초 타임아웃을 넘겨 **모든 LLM 비전 추론이 실패→결정형 폴백**만 사용되고 있다. 근본 해결은 **thinking을 끄는 것**이다. 그런데 아래 서버 실측으로 **OpenAI 호환 `/v1` 엔드포인트로는 gemma4:12b의 thinking을 끌 방법이 없음**을 확정했다(`reasoning_effort`·`chat_template_kwargs`·`think` 모두 무시됨). 따라서 비전/채팅 호출을 **Ollama 네이티브 `/api/chat`(fetchWithTimeout, warmup과 동일 패턴)로 전환**하고 `think:false`를 실어보낸다. 이와 별개로 비전 프레임을 **종횡비 유지 균일 축소(긴변 960px 캡)**하여 프롬프트 비전 토큰·비용·타임아웃 여유를 확보한다. 정규화 좌표(0~1)는 **균일 스케일에서 불변**이므로 회귀 없음(강제 16:9 스쿼시/크롭은 금지).

---

## 1. 서버 실측 (설계자가 직접 검증 완료 · 근거)

서버 `http://192.168.0.210:11434`, Ollama `0.30.10`, model `gemma4:12b`. 실호출로 확인:

| # | 경로 / 필드 | thinking 여부 | 결과 | 지연 |
|---|-------------|--------------|------|------|
| A | 네이티브 `/api/chat` + `think:false` | **OFF** | `content:"OK"` 정상 | 0.78s |
| B1 | `/v1` 기본(필드 없음) | ON | `content:""`, `reasoning`만 채워짐 | (thinking 폭주) |
| B2 | `/v1` + `chat_template_kwargs:{thinking:false}` | **여전히 ON** | `content:""`, `reasoning` 채워짐 | 무효 |
| B3 | `/v1` + `reasoning_effort:"low"` | **여전히 ON** | `content:""`, `reasoning` 채워짐 | 무효 |
| C1 | `/v1` + `think:false`(패스스루) | **여전히 ON** | `content:""`, `reasoning` 채워짐 | 무효 |
| C2 | 네이티브 `/api/chat` + `think:false` + `format:"json"` | **OFF** | `content:'{"ball":0}'` 정상 JSON | 0.91s |
| D | 네이티브 `/api/chat` + `think:false` + `format:"json"` + `images:[b64]`(비전) | **OFF** | `content:'{"color":"gray"}'` 정상 | 1.08s |

**결론(확정):**
1. `/v1`(현재 openai SDK 경로)에서는 어떤 필드로도 gemma4:12b thinking을 끌 수 없다 → openai SDK 유지로는 근본 해결 불가.
2. 네이티브 `/api/chat`는 `think:false` + `format:"json"`(JSON 모드) + `images:[base64]`(비전)를 모두 지원하며 1초 내 정상 응답.
3. 따라서 **결정 A = 비전/채팅 호출을 네이티브 `/api/chat`로 전환**(아래 §2).

> 비고: `/v1` thinking-ON 응답은 답을 별도 `reasoning` 필드에 넣고 `content`는 빈 문자열이다. 이것이 로그의 "content 빈문자열=완전실패"·"자문 실패(폴백)"의 정체다.

---

## 2. 확정 설계 결정

### 결정 A — thinking OFF 전달 방식: **네이티브 `/api/chat` 전환**
- `AgentRuntime.chat()`을 Ollama 사용 시 openai SDK(`/v1`) 대신 **`fetchWithTimeout` 기반 네이티브 `/api/chat`** 로 호출한다(warmup이 이미 쓰는 패턴 재사용).
- 전송 바디: `{ model, stream:false, think:<cfg>, format?:'json', options:{ temperature, num_predict:maxTokens }, keep_alive, messages:[{role:'system',content},{role:'user',content, images?:[b64]}] }`.
  - 네이티브는 `max_tokens`→`options.num_predict`, JSON 모드→`format:'json'`, 이미지→메시지의 `images:[base64]`(문자열 배열, `image_url` 아님)로 **매핑이 다르다**.
- 응답 파싱: `data.message.content`(문자열) 반환. `choices[]` 없음.
- **전송 라우팅**: `llm.provider`가 `claude`/`codex`가 아닌 Ollama 계열일 때만 네이티브 사용. 명시적으로 `llm.api` enum(`'openai' | 'ollama'`, 기본 `'openai'`)을 config에 추가하고 `llm.config.json`에서 `'ollama'`로 지정. → 다른 배포(claude/codex/vLLM)는 기존 SDK 경로 그대로(하위호환).
- openai SDK 의존은 **유지**(제거 X): `ping()`·`reviewSetup()`·`api:'openai'` 경로가 계속 사용.

### 결정 B — config 스키마 (권고안 1: 최소)
`LlmSchema`(=`llm` 블록)에 옵셔널+기본값으로 3개 추가(하위호환):
- `think: z.boolean().default(false)` — **전역 추론 토글(기본 OFF)**. 마스터 핵심 요구.
- `api: z.enum(['openai','ollama']).default('openai')` — 전송 선택(결정 A).
- `imageMaxEdge: z.number().int().positive().optional()`(기본값은 `DEFAULT_LLM_CONFIG`에서 `960`) — 비전 다운스케일 긴변 상한(px). (0/미설정 시 다운스케일 skip은 §결정 C 참조.)

`DEFAULT_LLM_CONFIG.llm`에 `think:false, api:'openai', imageMaxEdge:960` 추가. `loadLlmConfig`의 병합은 `{...DEFAULT.llm, ...raw.llm}`이라 기존 config(신규 키 없음)도 기본값으로 정상 파싱됨(회귀 없음).

**권고안 2(확장, 리더 확인 필요 — 지금은 구현 안 함):** 전역 `think`는 "비전 OFF + 텍스트 ON"을 동시에 낼 수 없다. stage2/3·checkpoint·finalize(텍스트 전용)는 추론이 유익할 수 있으나, floor ROI·centering(비전)은 반드시 OFF여야 한다. 필요 시 `chat()/chatJson()`에 `think?:boolean` 오버라이드 파라미터를 추가하고 텍스트 단계에서만 opt-in하는 구조로 확장 가능. **과설계 방지 위해 1차는 전역 `think`만 구현**하고, 텍스트 단계 추론이 실제로 필요해지면 그때 도입(리더 판단).

### 결정 C — 다운스케일 위치·방식
- **위치: `AgentRuntime.chat()` 공통 진입점 1곳.** floor ROI·centering 두 비전 경로가 모두 `chatJson()→chat()`으로 수렴(코드 확인 완료). 여기서 처리하면 누락 없음. 호출측(`FloorRoiReviewer`/`PtzCalibrator`)은 **변경 없음**(base64 그대로 전달).
- **함수 분리:** 순수 유틸 `src/util/image.ts`에 `downscaleJpegBase64(b64: string, maxLongEdge: number): Promise<string>` 추가(단위 테스트 용이). `chat()`은 `imageBase64`가 있고 `cfg.llm.imageMaxEdge`가 설정됐을 때만 호출.
- **라이브러리:** `sharp` 신규 의존 추가(고속·견고 JPEG 리사이즈, Node20 win-x64 prebuilt 제공). package.json에 없음 → 추가 필요. (대안: 순수 JS `jimp` — 느림. 권장은 sharp. §5 영향도에 명시.)
- **리사이즈 규칙(정규화 불변 핵심):** **종횡비 유지 균일 축소만** 수행. 긴변 > `maxLongEdge`면 긴변=`maxLongEdge`로 스케일, 짧은변은 비율대로. **강제 16:9(스쿼시/크롭/레터박스) 금지** — 이는 정규화 좌표를 이동시켜 회귀를 유발한다. 실제 카메라 프레임이 1080p(16:9)이므로 균일 축소 결과는 자동으로 960×540(16:9)이 된다. 원본이 이미 상한 이하이면 원본 반환(업스케일 X). 재인코딩 품질 ~80.
  - **좌표 불변 근거:** LLM이 돌려주는 정규화 좌표(0~1)는 자신이 본 이미지 기준. 동일 크롭·동일 종횡비의 **균일 스케일**에서는 정규화 좌표가 완전히 동일하다. `floorRoi.ts`·`geometry.ts`의 정규화 좌표 소비부는 px가 아니라 0~1이므로 리사이즈에 불변(수정 불필요).
- **목표 해상도 근거:** 실측 `1280x720=22.8s / 1920x1080=39.7s`(think ON 기준)에서 1080p가 타임아웃 주범. `think:false`로 전환하면 1080p도 ~2s지만, 긴변 960 캡으로 비전 토큰·비용을 추가 절감하고 안전 여유 확보. 기본 `imageMaxEdge=960`(→960×540). (더 보수적으로 가려면 768 가능 — 정확도 여유 위해 960 권장.)

---

## 3. 구현 단계 (구현자 착수용, 번호별 검증 기준)

1. **의존성 추가** — `SettingAgent/package.json`에 `sharp` 추가 후 `npm install`.
   → 검증: `npm install` 성공, `node -e "require('sharp')"` 오류 없음, `npm run typecheck` 통과.

2. **config 스키마 확장** — `src/config/llmConfig.ts` `LlmSchema`에 `think`/`api`/`imageMaxEdge` 추가, `DEFAULT_LLM_CONFIG.llm`에 기본값(`false`/`'openai'`/`960`) 추가.
   → 검증(vitest): 신규 필드 없는 config 로드 시 `think===false`, `api==='openai'`, `imageMaxEdge===960`. `think:true` 지정 시 반영. 기존 `llm.config.json`(수정 전) 파싱 성공.

3. **다운스케일 유틸** — `src/util/image.ts` 신설: `downscaleJpegBase64(b64, maxLongEdge)`. sharp로 metadata→긴변 초과 시 종횡비 유지 리사이즈(`fit:'inside'`, no enlargement)→JPEG(q80)→base64.
   → 검증(vitest): 1920×1080 입력→출력 긴변=960, 종횡비 오차<1%(=16:9 유지). 800×450 입력(상한 이하)→크기 불변. 4:3(1200×900) 입력→종횡비 유지(크롭/스쿼시 없음, 4:3 유지) 확인(정규화 불변 프록시).

4. **네이티브 `/api/chat` 전송** — `src/brain/AgentRuntime.ts` `chat()` 리팩터:
   - `cfg.llm.api==='ollama'`(또는 provider 비-claude/codex) 분기: endpoint=`baseUrl.replace(/\/v1\/?$/,'')+'/api/chat'`, 바디 §2 결정 A 형식, `think:cfg.llm.think`, `format:'json'`(json 모드시), `options:{temperature:cfg.llm.temperature, num_predict:cfg.llm.maxTokens}`, `keep_alive:cfg.warmup?.keepAlive ?? '24h'`, 이미지 있으면 `messages[user].images=[b64]`. `fetchWithTimeout(endpoint, {POST, headers(+auth), body}, cfg.llm.timeoutMs ?? 30000)`. 응답 `data.message.content` 반환.
   - `imageBase64` 존재 시 전송 직전 `downscaleJpegBase64(imageBase64, cfg.llm.imageMaxEdge)` 적용(imageMaxEdge 설정 시).
   - `api==='openai'` 분기: 기존 SDK 경로 그대로(변경 최소).
   - `chatJson()`의 2회 재시도·`extractJson` 로직은 그대로.
   → 검증(vitest): `util/http`의 `fetchWithTimeout`를 `vi.mock`. `recognizeFloorRoi` 호출 시 POST 바디 JSON에 `think===false`, `format==='json'`, `messages[1].images`에 (축소된) base64 존재를 assert. 목 응답 `{message:{content:'{...유효 FloorRoi JSON...}'}}` → 파싱 성공. `adviseCentering`도 동일 검증. (외부 서버 모킹, 네트워크 없음.)

5. **config 실값 갱신** — `SettingAgent/config/llm.config.json`의 `llm`에 `"api":"ollama"`, `"think":false`, `"imageMaxEdge":960` 명시.
   → 검증: `loadLlmConfig()` 파싱 성공, 값 반영.

6. **(선택) reviewSetup 정합** — `reviewSetup()`이 SDK 직접호출(`/v1`, 텍스트)이라 thinking이 남는다. `api:'ollama'`일 때 `chat(system,user,undefined,false)` 재사용으로 라우팅하면 일관. **소폭·선택** — 리더가 원하면 포함. 미포함 시 §5에 잔여 사항으로 기록.
   → 검증: 라우팅 시 네이티브 경로로 think:false 전송.

7. **회귀 확인** — 전체 `npm run test` + `npm run typecheck`.
   → 검증: 기존 테스트(FloorRoiReviewer/PtzCalibrator/floorRoi/calibrateRoutes 등) 그대로 통과(호출측 미변경).

8. **실서버 동작 확인(구현자, 192.168.0.210)** — `enabled=true, api=ollama, think=false`로 floor ROI 1회 실행 → 로그에서 `floor ROI 추론 실패(폴백)`가 **사라지고 성공 추론(succeeded>0)**·응답<5s 확인. centering 자문도 정상 제안 수신.
   → 검증: "성공한 비전 추론 0건" → >0건, 타임아웃 로그 소멸.

---

## 4. MCP 도구 vs LLM 두뇌 경계 판단

이 작업은 **LLM 두뇌(비전 추론) 경로의 신뢰성 복구**다. 결정형 도구(줌 반복·PTZ 미세이동·`resolveFloorQuad` 폴백·`panTiltCorrection`)는 **일절 변경하지 않는다**. thinking 토글·다운스케일·전송 전환은 두뇌 호출 인프라이며, 두뇌 실패 시 기존 결정형 폴백이 그대로 안전망으로 유지된다. 경계 준수: 모호·맥락판단(바닥 ROI 4점, 중심정렬 자문)=두뇌, 반복 수치 제어=도구.

---

## 5. 영향도 분석 (documenter 인계 초안)

- **하위호환:** 신규 config 필드 전부 옵셔널+기본값. 기존 `llm.config.json`/`DEFAULT_LLM_CONFIG` 병합 로직(`{...DEFAULT.llm,...raw.llm}`)으로 미지정 시 안전한 기본(think OFF, api openai). 회귀 없음.
- **의존성:** `sharp` 신규(네이티브, prebuilt). 설치 용량 증가(~수십MB), CI/배포 환경 win-x64 Node20 prebuilt 필요. 문제 시 `jimp`(순수 JS) 대안. → 영향도 문서에 명기.
- **재시작 필요:** `npm start`(nodemon)는 `.ts`만 감시 → **`llm.config.json` 편집은 재시작해야 반영**(기존 동작, 운영자 안내 필요).
- **전송 파싱 변경:** `api:'ollama'` 경로는 `data.message.content` 사용(SDK `choices[]` 아님). 에러/비200은 `fetchWithTimeout` 로깅+throw→`chatJson`이 null 폴백(기존과 동일 안전). warmup이 이미 동일 네이티브 패턴이라 정합.
- **기존 테스트:** 호출측(FloorRoiReviewer/PtzCalibrator) 시그니처 불변 → 기존 유닛테스트 영향 없음. AgentRuntime 관련 테스트가 있으면 네이티브 목으로 갱신.
- **잔여/미결:**
  - (a) 권고안 2(per-call think 오버라이드)를 도입할지 — 텍스트 단계 추론 필요성 리더 판단.
  - (b) 단계 6(reviewSetup 정합) 포함 여부 리더 판단. 미포함 시 `/brain/review` 텍스트 보조에는 thinking이 남음(1초 대는 아니나 지연 가능).
  - (c) `imageMaxEdge` 960 vs 768 — 정확도 여유 위해 960 권장, 리더가 더 보수적으로 원하면 768.
  - (d) `provider` enum에 `'gemma'`가 있으나 실제 config는 `'openai-compatible'` 사용 — `api` enum을 별도로 두어 전송을 명시 제어하는 이유(문자열 매칭 취약성 회피).

---

## 6. 영향 받는 파일/모듈

| 파일 | 변경 |
|------|------|
| `SettingAgent/package.json` | `sharp` 의존 추가 |
| `SettingAgent/src/config/llmConfig.ts` | `LlmSchema`/`DEFAULT_LLM_CONFIG`에 `think`/`api`/`imageMaxEdge` |
| `SettingAgent/config/llm.config.json` | `llm.api:'ollama'`, `think:false`, `imageMaxEdge:960` |
| `SettingAgent/src/util/image.ts` | **신규** `downscaleJpegBase64` |
| `SettingAgent/src/brain/AgentRuntime.ts` | `chat()` 네이티브 `/api/chat` 전송 + think 실기 + 다운스케일 적용 |
| (선택) 동상 `reviewSetup()` | 네이티브 라우팅 |
| `SettingAgent/test/*` | config 기본값/토글, 다운스케일 크기·종횡비, chat think 플래그 목 검증 |
| (미변경 확인) `FloorRoiReviewer.ts`·`PtzCalibrator.ts`·`floorRoi.ts`·`geometry.ts` | 호출측·정규화 좌표 소비부 불변 |
