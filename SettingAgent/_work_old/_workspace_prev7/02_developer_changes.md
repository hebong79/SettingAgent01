# 02 구현 변경 요약 — 정밀수집 "무한반복·정지 안됨" 수정

설계서(`01_architect_plan.md`) + 리더 확정 지침에 따라 4개 소스 + config 를 최소·외과적으로 수정했다.
상태머신·moveBeforeCapture·검출·집계·폴백 흐름은 무변경. 신규 파라미터는 전부 옵셔널(하위호환).

## 변경 파일 · 지점

### 1) `src/config/llmConfig.ts`
- `LlmSchema` 에 필드 추가: `timeoutMs: z.number().int().positive().optional()`.
- `DEFAULT_LLM_CONFIG.llm` 에 `timeoutMs: 30000` 명시(기본 30초).
- 목적: LLM 요청에 타임아웃을 부여해 느린 호출이 수 분 매달리는 것을 방지.

### 2) `src/brain/AgentRuntime.ts` (생성자, 43행)
- 변경 전: `new OpenAI({ baseURL: cfg.llm.baseUrl, apiKey })`
- 변경 후: `new OpenAI({ baseURL: cfg.llm.baseUrl, apiKey, timeout: cfg.llm.timeoutMs ?? 30000, maxRetries: 0 })`
- 클라이언트 인스턴스 전역 적용(per-call 아님 → 누락 없음). `maxRetries: 0` 으로 최악 대기 = timeout 1회.
- `chatJson` 내부 파싱 재시도(attempt<2)는 목적이 달라 **유지**(각 시도가 이제 timeout 으로 상한).

### 3) `src/capture/CaptureJob.ts` `runRound()` / `checkpoint()`
- (a) 타깃 for 루프 상단: `if (this.currentState() === 'stopping') break;`
  → 진행 중 stop 시 다음 타깃 캡처 전 탈출. 이미 캡처된 타깃 적재는 유지(데이터 손실 없음).
- (b) checkpoint 게이트 조건에 `&& this.currentState() !== 'stopping'` 추가
  → 정지 중이면 수 분짜리 checkpoint 진입 자체를 스킵.
- 루프 탈출 후에도 `this.round/done = roundIdx` 및 `updateRunProgress` 는 그대로 실행(부분 라운드도 1 라운드 계수 — 설계 §6-1, 진행 단조 유지). 이후 기존 stopping terminal 체크(현 209행 부근)가 `finishRun('stopped','manual')` 로 전이.
- `checkpoint()` 내 floorReviewer 호출에 `shouldStop` 콜백 전달:
  `this.deps.floorReviewer.review(this.runId, slots, this.lastFrameByPreset, () => this.currentState() === 'stopping')`.

### 4) `src/capture/FloorRoiReviewer.ts` `review()`
- 시그니처에 옵셔널 4번째 파라미터 추가: `shouldStop?: () => boolean` (JSDoc 포함).
- 후보 슬롯 for 루프 **각 반복 시작**에서 `if (shouldStop?.()) break;` (기존 `used >= maxPerCheckpoint` 가드 직전).
  → 이미 시작된 체크포인트도 다음 슬롯 전(≤1 LLM 호출) 조기 탈출. **AbortController/in-flight 취소는 미사용**(슬롯 간 boolean 체크만).

### 5) `config/llm.config.json` (운영 가시성 — 설계 §2 권장)
- `llm` 블록에 `"timeoutMs": 30000` 추가. 미추가여도 기본값 적용되나 운영 가시성 위해 명시.

## 설계 대비 편차
- 없음. 설계서 §1-1~3 + 리더 §6-2(경량 shouldStop) 확정안을 그대로 구현.
- `CheckpointReviewer.review` 는 floorReviewer 만으로 잔여 리스크(진행 중 checkpoint)가 해소되어 이번 범위에서 미적용(설계 §6-2 "trivial 하면 적용, 아니면 floorReviewer 만" — floorReviewer 로 충족).

## 검증 (typecheck)
- `npm run typecheck` (tsc -p tsconfig.json --noEmit): **PASS** (에러 없음).
- OpenAI SDK 생성자의 `timeout`/`maxRetries` 옵션은 tsc 가 타입 검증(미지원 키였다면 컴파일 에러).

## qa-tester 전달 사항 (테스트 파일 미생성 — qa 담당)
- (a) 타깃 사이 stop → 다음 타깃 캡처 전 중단: requestImage mock 이 1회차 후 `job.stop()` 유도 → 호출 수 < targets 수, state='stopped', stopReason='manual'.
- (b) checkpoint 직전 stop → checkpoint 스킵: `checkpointEvery=1`, 마지막 타깃 캡처 mock 에서 `job.stop()` → `floorReviewer.review` / `reviewer.review` 미호출, state='stopped'.
- (b') FloorRoiReviewer.review 에 `shouldStop=()=>true` 전달 시 첫 슬롯 전 break → `brain.recognizeFloorRoi` 0회. `shouldStop` 미전달(undefined) 시 기존 동작 동일(하위호환).
- (c) llmConfig timeoutMs → OpenAI 생성자: `vi.mock('openai')` 로 생성자 인자 `timeout`,`maxRetries:0` 단언. timeoutMs 미지정 config → `timeout:30000`.
- (d) 회귀: 기존 captureJob/floorRoiReviewer 테스트 전부 그린 유지 기대(시그니처 옵셔널 추가만).
