# 01 설계서 — 정밀수집(CaptureJob) "무한반복·정지 안됨" 근본 수정

## 0. 배경/목표
정밀수집이 무한 반복처럼 보이고 정지 버튼이 안 먹는 버그를 최소·외과적으로 수정한다.
근본 원인(로그 확정): ① LLM 클라이언트 타임아웃 없음 → 느린 호출이 수 분 매달림, ② checkpoint 가
슬롯마다 LLM 호출로 라운드를 수 분 블로킹, ③ stop() 이 협조적이라 라운드/checkpoint 블로킹 중엔
반영 안 됨(state:'stopping' 에 갇힘). 결과: 사용자가 "무한·정지불가"로 인지.

수정 3축: (1) LLM 요청 타임아웃+재시도 축소, (2) runRound 에서 stop 확인점 추가(타깃 사이·checkpoint 전),
(3) AbortController 는 이번 범위 제외(근거 §5). 상태머신·수집·검출·집계 흐름은 무변경.

## 1. 변경 계획 (단계 → 검증)

### 1) llmConfig: `timeoutMs` 스키마 추가
- 파일: `src/config/llmConfig.ts`
- `LlmSchema` 에 필드 추가: `timeoutMs: z.number().int().positive().optional()`.
- `DEFAULT_LLM_CONFIG.llm` 에 `timeoutMs: 30000` 명시(기본 30초).
- **기본값 30000ms 근거**: 현 로그상 floor ROI 비전 1건 ~18초 → 정상 상한을 넉넉히(≈1.6배) 덮으면서,
  OpenAI SDK 기본 600초 대비 20배 단축. 비전 모델(gemma4:12b) 단건 응답이 30초를 넘으면 사실상
  이상(정체)으로 보고 폴백함이 합당. config 로 override 가능하므로 하드코딩 아님.
- 검증: 기존 `llmConfig` 로드 테스트(있으면) 통과 + 신규 케이스 "timeoutMs 미지정 시 기본 30000",
  "config 지정값 우선".

### 2) AgentRuntime: 클라이언트 타임아웃·재시도 적용
- 파일: `src/brain/AgentRuntime.ts:43`
- 변경: `new OpenAI({ baseURL: cfg.llm.baseUrl, apiKey, timeout: cfg.llm.timeoutMs ?? 30000, maxRetries: 0 })`
  - **적용 지점은 생성자 1곳**(클라이언트 인스턴스 전역 적용) → per-call 옵션보다 단순·누락 없음.
  - `maxRetries: 0` 근거: 재시도는 지연을 배수로 키운다(타임아웃×(1+retries)). 수집 checkpoint 는
    실패 시 결정형 폴백이 항상 있으므로(§FloorRoiReviewer llmUnavailable, chatJson→null) 재시도 불필요.
    최악 대기 = timeout 1회로 상한. (기존 SDK 기본 maxRetries:2 → 최악 3배 대기였음.)
- 무변경: `chatJson` 내부 애플리케이션 레벨 재시도 1회(attempt<2)는 **유지**(파싱 실패 회수용, 네트워크
  재시도와 목적이 다름). 단, 이 루프는 각 시도가 이제 timeout 으로 상한되므로 최악 대기 = 2×timeout.
  → 이는 파싱 재시도의 의도된 비용이며 수 분과 무관(2×30s=60s 상한). 별도 축소 안 함(외과적).
- 검증: mock 으로 OpenAI 생성자 인자에 `timeout`,`maxRetries` 가 config 값으로 전달됨을 단언(§4-c).

### 3) CaptureJob.runRound: stop 확인점 2곳 추가 (핵심)
- 파일: `src/capture/CaptureJob.ts` `runRound()` (174~), `captureTarget` 루프(179~186), checkpoint 게이트(192~194)
- (a) **타깃 사이 확인**: `for (const t of this.params.targets)` 루프 상단에서
  `if (this.currentState() === 'stopping') break;` — 진행 중 stop 시 다음 타깃 캡처 전 루프 탈출.
  (이미 캡처된 타깃 적재는 유지 → 데이터 손실 없음, 결정형.)
- (b) **checkpoint 진입 전 확인**: `if (this.done % checkpointEvery === 0)` 조건에 `&& this.currentState() !== 'stopping'`
  추가 → stopping 이면 수 분짜리 checkpoint 스킵.
- 루프 종료 후 기존 흐름(201 `roundRunning=false` → 204 `currentState()==='stopping'` → `finishRun('stopped','manual')`)
  이 그대로 stopped 로 전이시킴. **finishRun/stop/상태머신 시그니처 무변경.**
- 효과: stop 이 "다음 타깃 경계(수 초=1캡처+검출)" 내 반영, 진행 라운드가 checkpoint 로 수 분 잡히지 않음.
- 주의(회귀 방지): break 후에도 `this.round = roundIdx; this.done = roundIdx;` 및 `updateRunProgress` 는
  **그대로 실행**(부분 라운드도 1 라운드로 카운트 — 기존 count 종료 로직과 일관, 진행 표시 단조 유지).
  대안(부분 라운드 미카운트)은 done 역행/off-by-one 위험 → 채택 안 함. 이 결정을 리더 확인점(§6)에 명시.
- 검증: §4-a, §4-b.

## 2. 영향 받는 파일/모듈
- `src/config/llmConfig.ts` — 스키마+기본값(구현자).
- `src/brain/AgentRuntime.ts` — 생성자 클라이언트 옵션(구현자).
- `src/capture/CaptureJob.ts` — runRound 확인점 2곳(구현자).
- `config/llm.config.json` — (선택) `llm.timeoutMs: 30000` 명시 추가. 미추가여도 기본값 적용되나,
  운영 가시성 위해 추가 권장(문서화 대상).
- `test/captureJob.test.ts` — 케이스 추가(기존 유지). `test/llmConfig*.test.ts`/신규 — timeoutMs.
- 문서화(documenter): 위 4개 소스 + config 변경, "갇힌 잡은 재배포·재시작으로 해소"(§운영) 기록.

## 3. MCP 도구 vs LLM 두뇌 경계
- 본 수정은 **결정형(상태머신·타임아웃·루프 제어)** 영역. LLM 판정 로직/프롬프트/폴백 시맨틱 무변경.
- 타임아웃·재시도는 LLM "호출 신뢰성" 인프라이지 두뇌 판단이 아님 → 결정형에 둔다(경계 준수).

## 4. 검증 가능 유닛테스트 (vitest, fake timers·mock LLM)
기존 `makeManualTimers`/`makeJob` 패턴 재사용. LLM 은 지연 Promise 로 모킹.

- **(a) 타깃 사이 stop → 다음 타깃 캡처 전 중단**
  - targets=[p1,p2,p3]. camera.requestImage 를 카운팅 mock. p1 캡처 직후(첫 await 해소 시점) `job.stop()`.
  - fake timer 로 라운드 발화하되, p2 진입 전 stopping 반영 → requestImage 호출 수 < 3, 최종 state='stopped'.
  - 구현 팁: requestImage mock 이 특정 호출(예: 1회차) 후 `job.stop()` 을 호출하도록 하여 루프 중 stopping 유도.
  - 단언: 캡처 호출 수 = 1(또는 2), `getStatus().state==='stopped'`, `stopReason==='manual'`.

- **(b) checkpoint 직전 stop → checkpoint 스킵**
  - reviewer/floorReviewer mock 의 review 를 spy. `checkpointEvery=1` 로 매 라운드 checkpoint 대상.
  - 마지막 타깃 캡처 mock 에서 `job.stop()` 호출 → done%every===0 이지만 stopping 이라 스킵.
  - 단언: `floorReviewer.review` **미호출**(spy call 0), state='stopped'. (checkpoint 진입 전 확인 검증.)

- **(c) llmConfig timeoutMs → OpenAI 생성자 반영**
  - `vi.mock('openai')` 로 OpenAI 생성자 캡처. `new AgentRuntime({ llm:{...enabled:true, timeoutMs:5000}})`.
  - 단언: 생성자 호출 인자에 `timeout:5000`, `maxRetries:0`. timeoutMs 미지정 config → `timeout:30000`.

- **(d) 회귀 유지**: 기존 captureJob 테스트 전부 통과(count 종료·중복 start·흡수·LPD·라운드사이 stop 즉시).
  특히 기존 "라운드 사이 stop → 즉시 stopped"(roundRunning=false 경로)는 무영향이어야 함.

## 5. AbortController 포함/제외 결정
- **제외**(이번 범위). 근거:
  - §1-2(타임아웃 30s) + §1-3(타깃 사이·checkpoint 전 stop 확인)만으로 stop 이 "다음 타깃 경계 수 초"
    내 반영되고, 최악의 진행 중 단건 LLM 대기도 30초로 상한. 무한 대기 원인이 제거됨.
  - Abort 전파는 `CaptureJob.stop → checkpoint → reviewer.review/floorReviewer.review → AgentRuntime.recognizeFloorRoi
    /reviewCheckpoint → chatJson → chat → openai.create({signal})` 로 6~7개 시그니처에 `signal?: AbortSignal`
    추가가 필요(광범위·회귀면 큼). 단순함·외과성 원칙 위배 대비 이득(≤30초 추가 단축)이 작다.
  - 단, checkpoint 는 §1-3(b)로 stopping 시 **아예 시작 안 함** → 진행 중 checkpoint 가 stop 을 막는
    시나리오 자체가 사라짐. 남는 건 "한 라운드의 마지막 checkpoint 가 이미 시작된 뒤 stop" 뿐인데,
    이는 30s×슬롯? 아니오 — 각 LLM 호출이 30s 상한이나 checkpoint 는 슬롯 루프(최대 maxPerCheckpoint=12건).
  - ⚠ **잔여 리스크(리더 확인점 §6-2)**: 이미 **시작된** checkpoint 는 (b) 확인을 통과했으므로 중단 안 됨.
    최악 = 12건×(2×30s 파싱재시도) 대기. 실무상 정상 18s×12≈3.6분. 이를 더 줄이려면 (옵션) checkpoint
    **내부** 슬롯 루프에도 stopping 확인을 넣는 경량 방법이 있음(Abort 없이). 필요 시 §6-2 결정 후 반영.

## 6. 미해결 / 가정 (리더 확인점)
1. **부분 라운드 카운트**: stop 으로 타깃 루프를 중도 탈출한 라운드도 `done+=1` 로 계수(단조 진행·off-by-one
   회피 목적). "부분 라운드는 미완료로 count 하지 말라"는 요구가 있으면 알려달라 — 기본은 계수.
2. **checkpoint 내부 슬롯 루프 조기중단(경량)**: §5 잔여 리스크(이미 시작된 checkpoint 3.6분)를 없애려면
   `FloorRoiReviewer.review`/`CheckpointReviewer.review` 에 `shouldStop?: () => boolean` 콜백을 주입해
   슬롯 루프 상단에서 확인·break 하는 방법이 있다(Abort 없이 시그니처 1개씩만 증가). **포함 여부 결정 요망.**
   기본안: 이번 범위 제외(§1-3(b) 만으로 "새 checkpoint 진입 차단" 충족). 포함 시 테스트 (b) 확장.
3. **maxRetries 0 vs 1**: 기본안 0(최악 대기 = timeout 1회). 네트워크 순간 오류 흡수를 원하면 1로.
   폴백이 항상 있으므로 0 권장. 확인 요망.
4. **운영 조치**: 현재 갇힌 잡은 코드 미반영 상태 → **재배포 + 프로세스 재시작** 필요(인메모리 단일 잡이라
   런타임 리셋으로만 해소). 배포 문서에 명시(documenter).

## 7. 회귀 위험 요약
- 낮음: 변경은 (i) 스키마 옵셔널 필드 추가, (ii) 생성자 옵션 2개, (iii) runRound 내 `break`/조건 `&&` 2줄.
  상태 전이·finishRun·저장 호출 순서 무변경 → 기존 vitest 그린 유지 기대.
- 주시 포인트: 타깃 사이 break 시 `updateRunProgress` 가 여전히 호출되는지(진행 표시 일관), stopping 확인이
  `currentState()`(await 사이 최신값) 로 되는지(206 기존 패턴과 동일 함수 사용).
