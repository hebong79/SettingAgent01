# 04 · 영향도 분석 — LLM thinking 제어 + 비전 이미지 다운스케일(16:9)

작성: 문서화·영향도 분석가(documenter) / 대상: SettingAgent
근거: 01(설계)·02(구현)·03(검증) 산출물 + 실제 변경 소스 대조
연계 상세 문서: `docs/20260702_183504_LLM추론제어_비전이미지다운스케일.md`

---

## 1. 의존성 영향 — `sharp` 신규 추가

- `package.json` `dependencies`에 `"sharp": "^0.35.3"` 추가(실제 파일 확인). native prebuilt 모듈.
- **설치**: `npm install`로 win-x64 Node20 prebuilt 자동 설치(구현자·검증자 모두 native 빌드 없이 성공, `sharp.versions.sharp` 로드 정상). 순수 JS 컴파일 아님 → 플랫폼별 prebuilt 존재 여부에 의존.
- **빌드/배포**: CI·배포 환경도 **동일 플랫폼 prebuilt**(win-x64 Node20)를 확보해야 한다. 다른 아키텍처(linux-arm64 등)로 배포 시 해당 prebuilt가 필요하다. prebuilt 부재 시 대안은 순수 JS `jimp`(느림)지만 현재는 불필요.
- **용량**: 설치 용량 수십 MB 증가.
- 사용처는 `src/util/image.ts` 1곳(신규)뿐. 다른 모듈은 sharp를 직접 참조하지 않는다.

## 2. 모듈 영향 — `AgentRuntime.chat()` 경로 변경 파급

`chat()`이 공통 진입점이 되면서(다운스케일 + `api` 라우팅), 이를 경유하는 **모든 두뇌 메서드**가 새 경로를 탄다:

- 비전 경유(이미지 다운스케일 + 라우팅): `judgePreset`(stage1), `recognizeFloorRoi`(floor ROI), `adviseCentering`(centering).
- 텍스트 경유(라우팅만): `dedupeAndLabel`(stage2), `finalReport`(stage3), `reviewCheckpoint`, `finalizeCapture`, `reviewSetup`.

**하위호환 보증**: 라우팅 분기는 `cfg.llm.api`로만 결정되며 **기본값 `'openai'`**. 즉 기존 vLLM/claude/codex/openai-compatible 배포는 `api`를 지정하지 않으면 **기존 SDK(`chatOpenai`) 경로 그대로** 동작한다. 위 8개 메서드의 시그니처·상위 로직은 불변(호출측 `chatJson`/단계 메서드 변경 없음). 검증자 회귀 526 passed로 실증.

**신규 위임 1건 주의**: `reviewSetup()`은 종전 SDK 직접 호출 → 이제 `chat()` 위임. `api:'openai'`에서는 결과 동일(같은 SDK 경로), `api:'ollama'`에서는 네이티브 `think:false`가 적용되어 잔존 thinking이 제거된다. 요약 생성 로직 자체는 불변.

**전송 파싱 변경**: 네이티브 경로는 `data.message.content`를 읽는다(SDK `choices[]` 아님). 비200·오류는 warn + null → `chatJson`의 null 폴백(결정형 안전망) 유지. 이는 warmup이 이미 쓰던 네이티브 패턴과 정합.

## 3. config 하위호환

- 신규 3필드(`api`/`think`/`imageMaxEdge`) 전부 옵셔널+`.default()`. `loadLlmConfig` 병합(`{...DEFAULT.llm, ...raw.llm}`)로 **3필드가 없는 기존 `llm.config.json`도 무중단** 파싱(openai/false/960 기본 적용). 검증자 하위호환 테스트 통과.
- `DEFAULT_LLM_CONFIG.llm`에도 3필드 반영 → 파일 부재 시에도 스키마 정합.

## 4. 테스트 픽스처 파급 — hand-built LlmConfig 리터럴 9개

`LlmSchema`에 신규 필드가 **필수 출력 타입**(`.default()`는 파싱 시 채워지나, `LlmConfig` 타입상 존재하는 프로퍼티)이 되면서, 코드에서 손으로 만든 `LlmConfig` 리터럴이 TS 컴파일 실패한다. 이를 보정하기 위해 다음 9개 픽스처의 `llm` 리터럴에 `api:'openai', think:false, imageMaxEdge:960`을 추가했다(순수 스키마 파급 정리, 동작 의미 불변 = 기존 SDK 목 경로 유지):

`agentRuntime`, `agentRuntimeCentering`, `agentRuntimeFloor`, `agentRuntimeTimeout`, `brainJsonMode`, `brainRetry`, `brainStages`, `warmup`, `warmupTimeout`.

(신규 3파일 `llmThinkConfig`/`imageDownscale`/`agentRuntimeNative`는 처음부터 신규 필드를 포함.) `grep imageMaxEdge test/`가 총 12개 파일(9 픽스처 + 3 신규)을 반환하여 파급 범위 일치 확인.

## 5. 좌표 계약 — 정규화 좌표 소비부 무영향

다운스케일은 **종횡비 유지 균일 축소**(강제 16:9 스쿼시/크롭 없음, 업스케일 없음). LLM이 반환하는 정규화 좌표(0~1)는 균일 스케일에 **불변**이다.

- 영향 없음: `capture/floorRoi.ts`(floor ROI 4점, 0~1 소비), `domain/geometry.ts`(정규화 좌표 연산), SettingViewer 뷰어(정규화 좌표 렌더). 이들은 픽셀이 아닌 0~1을 소비하므로 리사이즈에 불변.
- 실증: 검증자 `imageDownscale.test.ts`의 정규화 bbox 불변 테스트(검은 배경 흰 블록 합성 → 다운스케일 전후 정규화 bbox ±2% 이내)로 계약 유지 확인.
- 호출측 `FloorRoiReviewer.ts`·`PtzCalibrator.ts`는 base64를 그대로 전달(시그니처 불변) → 다운스케일이 `chat()` 내부에서만 일어나므로 호출측 무변경.

## 6. 잔여 리스크 / 후속

- **미검증(범위 밖)**: `enabled=true` 풀 캡처 파이프라인 1회 e2e(설계 단계 8 "폴백 로그 소멸")는 **카메라/캡처 하드웨어 의존**으로 미실행. 두뇌 호출 인프라만 실서버 e2e(2.44s)로 확인됨. 실캡처 검증은 후속 과제로 남김(통과 위장 아님).
- **provider vs api 관계**: 실 config의 `provider`는 `'openai-compatible'`(working copy는 gemma4:12b 사용). thinking 제어는 `provider`가 아니라 `api:'ollama'` 스위치로만 활성. `provider` enum의 `'gemma'`는 미사용 — `api`를 별도로 둔 이유(문자열 매칭 취약성 회피)와 직접 연관.
- **think 전역 단일 토글 한계**: 비전 OFF + 텍스트 ON을 동시에 낼 수 없다. 현재는 전역 `think:false`. 텍스트 단계 추론이 실제로 필요해지면 per-call `think` 오버라이드 도입 검토(현재 과설계 회피로 미도입).
- **재시작 필요**: `llm.config.json` 편집은 nodemon(src/ .ts 감시) 밖 → 서버 재시작 필요(기존 동작, 운영 안내 항목).
- **sharp 배포**: §1 prebuilt 플랫폼 의존.

## 7. 영향 파일 목록

| 파일 | 변경 | 하위호환 |
|---|---|---|
| `package.json` | `sharp@^0.35.3` 추가 | 신규 의존 |
| `src/config/llmConfig.ts` | `api`/`think`/`imageMaxEdge` 3필드 | 옵셔널+기본값(무중단) |
| `src/util/image.ts` | **신규** `downscaleJpegBase64` | 신규 |
| `src/brain/AgentRuntime.ts` | `chat` 공통화 + `chatNative`/`chatOpenai` 분리 + `reviewSetup` 위임 | `api:'openai'` 기본 시 기존 동작 |
| `config/llm.config.json` | `api:ollama`/`think:false`/`imageMaxEdge:960` | working copy 실값 |
| `test/*`(9 픽스처) | `llm` 리터럴 3필드 추가 | 스키마 파급, 의미 불변 |
| `test/{llmThinkConfig,imageDownscale,agentRuntimeNative}.test.ts` | **신규**(23 tests) | 신규 |
| (무영향 확인) `capture/floorRoi.ts`·`domain/geometry.ts`·`FloorRoiReviewer.ts`·`PtzCalibrator.ts`·뷰어 | 정규화 좌표/호출측 불변 | 무영향 |
