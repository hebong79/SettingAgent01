# 04 영향도 분석 — 정밀수집 "무한반복·정지불가" 수정

- 작성일시: 2026-07-01 22:40:16
- 대상: SettingAgent
- 변경 파일: `src/config/llmConfig.ts`, `src/brain/AgentRuntime.ts`, `src/capture/CaptureJob.ts`, `src/capture/FloorRoiReviewer.ts`, `config/llm.config.json`
- 최종 문서: `docs/20260701_224016_정밀수집_무한반복_정지불가_버그수정.md`

---

## 1. LLM 타임아웃이 전체 LLM 호출 경로에 미치는 영향 (전파 범위 = 전부)

타임아웃/재시도는 `AgentRuntime` **생성자의 단일 `this.client`(OpenAI 인스턴스)** 에 설정된다. 모든 LLM 메서드는 `chatJson → chat → this.client.chat.completions.create` 로 이 클라이언트를 공유하므로, **7개 호출 경로 전부**에 30s 상한·maxRetries:0 이 일괄 적용된다:

| 메서드 | 용도 | 호출처 | 영향 |
|--------|------|--------|------|
| `judgePreset` (stage1) | 프리셋별 비전 판정 | SetupOrchestrator | 30s 상한·재시도 0 |
| `dedupeAndLabel` (stage2) | 프리셋 간 중복 제거/라벨 | SetupOrchestrator | 30s 상한·재시도 0 |
| `finalReport` (stage3) | 최종 리포트 | SetupOrchestrator | 30s 상한·재시도 0 |
| `reviewCheckpoint` | 체크포인트 중간 검토 | CaptureJob(체크포인트) | 30s 상한·재시도 0 |
| `finalizeCapture` | 최종 집계 판정 | Finalizer | 30s 상한·재시도 0 |
| `recognizeFloorRoi` | floor ROI 4점 비전 | FloorRoiReviewer | 30s 상한·재시도 0 |
| `adviseCentering` | PTZ 중심정렬 자문 | PtzCalibrator | 30s 상한·재시도 0 |

- **긍정 영향**: 이 경로들 모두 종전 최악 600s×3=30분 대기 위험이 있었으나, 이제 **최악 30초/호출**(파싱 재시도가 있는 경로는 최악 2×30s=60s)로 상한. 어느 경로도 프로세스를 수 분 매달지 못함.
- **폴백 안전성 확인**: 모든 경로는 실패/타임아웃 시 결정형 폴백 또는 `null` 반환이 이미 존재 → 재시도 0 으로 인한 기능 저하 없음. `chatJson` 은 timeout 예외를 잡아 `null` 반환, floorReviewer 는 `resolveFloorQuad` 폴백, stage1~3/checkpoint 는 호출측이 null 을 결정형으로 처리.
- **주의(잠재적 부작용)**: 정상 응답이 30초를 넘는 무거운 프롬프트가 있다면 **정상 호출도 타임아웃으로 폴백**될 수 있다. 특히 stage3/finalizeCapture 는 긴 한글 리포트(JSON 모드 off) 라 응답이 길다 → 실서버에서 응답 시간 관찰 필요(**확인 필요** 항목). 30초 초과가 잦으면 config `timeoutMs` 상향으로 조정 가능(코드 변경 불필요).

---

## 2. stop 확인점이 상태머신·기존 캡처 흐름에 미치는 영향

`CaptureJob.runRound` 의 변경은 (a) 타깃 루프 상단 `break`, (b) 체크포인트 게이트 `&&` 조건, (c) floorReviewer 에 콜백 인자 1개 추가뿐이다.

- **상태머신 무변경**: `stop`/`finishRun` 시그니처, 상태 전이 순서(`stopping → stopped`), DB 기록(`endRun`/`updateRunProgress`) 호출 순서 모두 그대로. break 후에도 기존 종료 경로(206행)가 `finishRun('stopped','manual')` 로 전이.
- **부분 라운드 계수**: 중도 탈출한 라운드도 `done += 1` 로 계수(진행 단조성·off-by-one 회피). 기존 count 종료 로직(`done >= planned`)과 일관 → 회귀 없음. QA 테스트로 `state='stopped'`, `stopReason='manual'`, `queueLen()===0` 확인됨.
- **기존 흐름 무영향**: "라운드 사이 stop → 즉시 stopped"(roundRunning=false 경로), 중복 start 방지, 캡처 실패 흡수, LPD 흐름은 무변경 — 464 테스트 그린으로 확인.
- **경계면(shape)**: `CaptureJob.checkpoint → FloorRoiReviewer.review` 의 4번째 인자가 `() => currentState()==='stopping'` 함수임을 QA spy 로 확인. `review` 시그니처의 옵셔널 `shouldStop?: () => boolean` 과 아리티·타입 일치(typecheck 이중 보증).

---

## 3. FloorRoiReviewer.review 시그니처 변경의 파급

- `review` 에 **옵셔널** 4번째 파라미터 추가 → 기존 호출자(콜백 미전달)는 `undefined` 로 기존 동작 완전 동일(하위호환). QA "undefined → 전 슬롯 처리" 케이스로 회귀 방지 확인.
- 현재 `review` 호출처는 `CaptureJob.checkpoint` 1곳. 다른 호출처 없음(전파 범위 국소).
- `CheckpointReviewer.review` 는 좌표 불변(LLM 호출 없이 요약만)이라 shouldStop **미적용** — floorReviewer 만으로 진행 중 체크포인트 잔여 리스크가 해소되어 범위 밖(설계 §6-2). 회귀 없음.

---

## 4. gemma4:12b 교체가 프롬프트/토큰/성능에 미치는 영향

`config/llm.config.json` 의 `model: qwen3.6:27b → gemma4:12b` 는 **순수 config 변경**(코드는 model-agnostic OpenAI 호환 호출).

- **프롬프트 영향**: floor_roi.yaml / stage1~3 / ptz_centering.yaml 프롬프트 파일은 무변경. 다만 gemma4:12b 는 **비전 가능**하므로 이미지 입력 프롬프트(floorRoi, stage1, adviseCentering)가 실제로 동작한다(종전 텍스트 모델은 이미지 무시). → 기능 회복이지 회귀 아님.
- **토큰 영향**: `maxTokens: 3072` 유지. gemma4:12b(12B) 는 qwen3.6:27b(27B) 대비 작은 모델이라 **VRAM·추론 속도에 유리**할 가능성이 높음. 단, 응답 품질(quad 정확도·리포트 문장)은 실서버 관찰 필요(**확인 필요**).
- **성능 영향**: 원인 ②의 "비전 불가로 12건 전부 폴백·라운드 3.7분"이 해소되면, floor ROI 가 실제 LLM quad 로 채워지되 각 호출은 30s 상한. 정상 18s×12 ≈ 3.6분 체크포인트 시간은 여전할 수 있으므로, `floorRoi.maxPerCheckpoint`(현재 12)로 체크포인트당 부하를 조절하는 것이 운영 레버(코드 변경 불필요).

---

## 5. PtzCalibrator 등 LLM 자문 경로 영향

- `PtzCalibrator` 는 `this.brain?.adviseCentering` 를 `cfg.llmAdvise && brain.adviseCentering` 조건에서만 호출(PtzCalibrator.ts:258~261). 이 경로도 §1 표의 7번째 항목으로 **동일한 30s·재시도0 클라이언트**를 공유 → 캘리브레이션 중 LLM 자문이 매달리는 위험도 함께 제거됨.
- adviseCentering 실패/타임아웃 시 호출측이 클램프·폴백(결정형 제어)으로 처리하므로 재시도 0 영향 없음.
- SetupOrchestrator(stage1~3)·Finalizer(finalizeCapture)도 동일하게 상한 적용 — 셋업 파이프라인 전체가 타임아웃 보호를 받게 됨(부수 이득).

---

## 6. config 스키마 변경(timeoutMs)의 파급

- `LlmSchema.timeoutMs` 는 **옵셔널** + `DEFAULT_LLM_CONFIG.llm.timeoutMs=30000` + `loadLlmConfig` 병합(`{...DEFAULT, ...raw.llm}`)으로, 기존 `llm.config.json`(키 없어도) 파싱 시 항상 30000 보강 → **기존 config 파일 하위호환**. QA `config.test.ts` + 신규 케이스로 확인.
- `LlmConfig` 타입을 소비하는 모든 코드(AgentRuntime 등)는 옵셔널 필드 추가라 타입 오류 없음(typecheck PASS).

---

## 7. 롤백 고려

| 대상 | 롤백 방법 | 안전성 |
|------|-----------|--------|
| model(gemma4:12b) | config 되돌림 → 서버 재시작 | 순수 config. 단 되돌리면 원인 ②(비전 불가) 재발 |
| timeoutMs | config 값 조정(상향/제거) → 재시작 | 순수 config. 제거 시 기본 30000 유지 |
| maxRetries:0 / stop 확인점 / shouldStop | 코드 revert 필요 | **롤백 비권장** — 회귀 없이 무한 대기·정지불가를 직접 해소하는 핵심 수정 |

- config(model/timeoutMs)와 코드(stop 확인점)는 **독립 롤백 가능**. 성능 문제는 대부분 config 조정으로 흡수되므로 코드 revert 없이 대응 가능.

---

## 8. 확인 필요 (단정 회피)

- stage3/finalizeCapture 등 **긴 응답 경로가 30초를 넘겨 폴백되는 빈도** — 실서버 관찰 필요.
- gemma4:12b 의 **floor ROI quad 정확도·리포트 품질** — 실서버 스모크 필요.
- 타임아웃 abort 의 **실제 타이밍 정확도** — SDK 소관, 유닛은 생성자 인자만 검증(03 QA §4-3).

---

## 요약

- **전파 최대 범위**: LLM 타임아웃/재시도가 SettingAgent의 **7개 LLM 호출 경로 전부**(setup 3단계·checkpoint·finalize·floorRoi·centering)에 일괄 적용 — 단일 클라이언트 공유 구조 덕분.
- **회귀 위험 낮음**: 464/464 테스트 그린, typecheck PASS. 모든 신규 파라미터 옵셔널(하위호환).
- **잔여 관찰 항목**: 긴 응답 경로의 30s 초과 여부·gemma 품질(실서버).
