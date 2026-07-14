# 03 QA 검증 보고 — 정밀수집 "정지 즉시 반응 + LLM 타임아웃"

검증자(qa-tester)가 설계서(`01_architect_plan.md`)·구현요약(`02_developer_changes.md`)에 따라 vitest 로 검증했다.
결론: **전체 통과(464/464), typecheck PASS**. 설계 검증 항목 전부 그린. 발견 이슈 없음.

## 1. 실행 명령 / 결과

| 명령 | 결과 |
|------|------|
| `npx vitest run` (전체) | **59 파일 / 464 tests 전부 PASS** |
| `npx vitest run test/captureJob.test.ts test/floorRoiReviewer.test.ts test/agentRuntimeTimeout.test.ts` (핵심 3) | 34 tests PASS |
| `npm run typecheck` (tsc --noEmit) | **PASS** (에러 없음) |

- 회귀 없음: 기존 captureJob 12→15, floorRoiReviewer 11→14 로 케이스만 증가, 기존 케이스 전부 그대로 그린.
- OpenAI 생성자의 `timeout`/`maxRetries` 옵션은 tsc 가 타입 검증(미지원 키였다면 컴파일 에러) → typecheck 통과로 옵션 유효성 이중 확인.

## 2. 신규/보강 테스트 케이스 (설계 검증 항목 매핑)

### A. stop 즉시 반응 — 타깃 사이 (설계 §4-a) · `test/captureJob.test.ts`
- **"라운드 진행 중 stop → 다음 타깃 캡처 전 탈출"**: targets 3개, `requestImage` 첫 호출(타깃1) 시점에 `job.stop()` 유도.
  - 단언: `requestImage` 호출 수 **= 1 (< 3)** — 타깃2·3 캡처 전 for 루프 상단 `if(currentState()==='stopping') break;` 로 탈출.
  - 최종 `state==='stopped'`, `stopReason==='manual'`, `timers.queueLen()===0`(다음 라운드 미예약 = 무한 대기 없음).

### B. checkpoint 스킵 (설계 §4-b) · `test/captureJob.test.ts`
- **"checkpoint 직전 stop → floorReviewer.review 미호출"**: `checkpointEvery=1`(매 라운드 대상), 마지막 타깃 캡처에서 `job.stop()`.
  - 단언: `reviewSpy` **미호출**(`not.toHaveBeenCalled()`) — done%1===0 이지만 게이트 `&& currentState()!=='stopping'` 로 checkpoint 진입 자체 스킵. `state==='stopped'`.
- **대비군 "정상 라운드 → checkpoint 실행"**: stop 없이 checkpointEvery 도달 시 `review` 1회 호출 + **4번째 인자가 함수(shouldStop 콜백)** 임을 확인(§구현 CaptureJob→FloorRoiReviewer 경계).

### C. shouldStop 조기 탈출 (설계 §1-3(c) / 구현 §4) · `test/floorRoiReviewer.test.ts`
- **"shouldStop=()=>true → 첫 슬롯 전 break"**: 후보 3슬롯, `shouldStop` 항상 true → `recognizeFloorRoi` **0회**, upsert 0건.
- **"2번째 슬롯에서 true → 첫 슬롯만 처리"**: 첫 슬롯 처리 후 stopping → 호출 1회(**< 후보 4**), upsert 1건. 부분 진행 후 조기탈출 확인.
- **"shouldStop 미전달(undefined) → 하위호환"**: 콜백 없으면 전 슬롯(3) 처리 — 옵셔널 파라미터가 기존 동작 불변임을 회귀 방지.

### D. 타임아웃 설정 반영 (설계 §1-1·§4-c) · `test/agentRuntimeTimeout.test.ts` (신규)
- `vi.mock('openai')` 로 생성자 인자 캡처(default export class 목).
- **timeoutMs=5000** → 생성자 `timeout:5000`, `maxRetries:0` 전달 확인.
- **timeoutMs 미지정** → `timeout:30000`(기본), `maxRetries:0`.
- **enabled=false** → 생성자 미호출(클라이언트 미생성).
- llmConfig 파싱: `DEFAULT_LLM_CONFIG.llm.timeoutMs===30000`, `loadLlmConfig('없는경로').llm.timeoutMs===30000`.

### E. 상태 전이 / 무한 대기 없음
- A·B 케이스에서 `stopping → (라운드 종료) → stopped(finishRun('stopped','manual'))` 전이를 `state`·DB(`getRun().status/stopReason`)로 확인.
- `timers.queueLen()===0` 으로 정지 후 다음 라운드가 예약되지 않음(발화 소스 소멸)을 확인 → 인메모리 잡이 정지 후 매달리지 않음.

## 3. 경계면 교차 비교 (shape 검증)

- **CaptureJob.checkpoint → FloorRoiReviewer.review**: 호출 인자 4번째가 `() => currentState()==='stopping'` 함수임을 D-대비군에서 spy 로 확인. FloorRoiReviewer.review 시그니처의 옵셔널 `shouldStop?: () => boolean` 와 타입·아리티 일치(typecheck 로 이중 보증).
- **AgentRuntime → OpenAI 생성자**: `{ baseURL, apiKey, timeout, maxRetries }` 키·값 shape 을 mock 으로 캡처해 비교. `timeout` 은 `cfg.llm.timeoutMs ?? 30000` 병합 결과와 일치.
- **llm.config.json ↔ 스키마**: `config.test.ts` 및 신규 케이스로 파싱 후 `llm.timeoutMs` 기본 30000 부여 확인(옵셔널 필드가 병합 시 DEFAULT 로 보강됨).

## 4. 수동 확인 항목 (실서버 — 유닛 범위 밖, 미수행/누락 명시)

아래는 외부 서비스(카메라 시뮬레이터·gemma 비전 LLM)가 필요해 유닛(모킹)으로는 대체 불가. **실 환경에서 담당자가 확인 요망**:

1. **실 서버 재시작 후 정지 버튼 즉시 반응**: 설계 §6-4 — 현재 갇힌 잡은 인메모리 단일 잡이라 **재배포 + 프로세스 재시작**으로만 해소. 재시작 후 정밀수집 중 정지 클릭 시 "다음 타깃 경계(수 초)" 내 stopped 전이 확인.
2. **gemma4:12b(비전) floor ROI 성공**: `llm.config.json` 의 `floorRoi.enabled=true`·gemma 엔드포인트 실동작으로 checkpoint 에서 floor ROI 가 폴백이 아닌 LLM quad 로 생성되는지(`llmFloorUnavailable` 미표식) 확인. 단건 응답이 30s 타임아웃 내 완료되는지도 함께 관찰.
3. **타임아웃 실동작 스모크**: 느린/무응답 LLM 엔드포인트에서 단건 호출이 30s 내 폴백 전환되는지(수 분 매달림 없음). — 유닛은 생성자 인자만 검증, 실제 abort 타이밍은 SDK 소관이라 스모크 필요.

## 5. 발견 이슈

- **없음.** 구현이 설계 §1-1~3 + 리더 §6-2(경량 shouldStop)와 일치. 시그니처 변경은 전부 옵셔널로 하위호환 유지되어 기존 464 테스트 회귀 없음.

## 6. 산출물

- 보강: `test/captureJob.test.ts` (+3 케이스: 타깃 사이 stop / checkpoint 스킵 / checkpoint 정상+콜백 전달).
- 보강: `test/floorRoiReviewer.test.ts` (+3 케이스: shouldStop true 즉시 / 부분 진행 후 탈출 / undefined 하위호환).
- 신규: `test/agentRuntimeTimeout.test.ts` (5 케이스: OpenAI 생성자 timeout/maxRetries + llmConfig 기본값).
