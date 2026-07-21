# 02b. 구현 변경 요약 — P4(dbRoutes 보안) + P5 config/brain (LLM 정리)

> 담당 범위: **P4 + P5의 config/brain 부분**. CaptureJob/index/Finalizer/SqliteStore/captureRoutes/web/reviewer 배선은 **미터치**(devA-dbcore 병렬 담당). reviewer 배선 제거는 다음 라운드.
> 설계 근거: `_workspace/01_architect_plan.md` §4, §6.

---

## 1. 수정한 소스 파일

| 파일 | 변경 |
|---|---|
| `src/api/dbRoutes.ts` | **P4** password 마스킹. `SENSITIVE = { camera_info: Set(['password']) }` 도입. 조회 rows 후처리(값!=null ? '****' : null). 검색(LIKE clauses)에서 민감 컬럼 제외(존재여부 유출 차단). |
| `src/brain/AgentRuntime.ts` | **P5-d** `adviseCentering` 메서드 삭제 + 고아 import 3종 제거(`CenteringAdviceSchema`, `type CenteringAdviceInput`, `type CenteringAdvice`). `loadPromptPair`는 recognizeFloorRoi/judgeOccupancy에서 계속 사용 → import 유지. |
| `src/brain/SetupBrain.ts` | **P5-d** `CenteringAdviceInput`/`CenteringAdviceSchema`/`CenteringAdvice` 삭제 + `SetupBrain` 인터페이스의 `adviseCentering?` 선언 삭제. |
| `src/calibrate/types.ts` | **P5-d** `CenteringAdvice` 인터페이스 삭제(호출자 0). |
| `src/config/llmConfig.ts` | **P5-d** `CenteringSchema` 삭제, `LlmConfigSchema.centering` 삭제, `DEFAULT_LLM_CONFIG.centering` 블록 삭제, `loadLlmConfig`의 centering 머지 라인 삭제(내 삭제로 고아가 된 참조 정리). |

## 2. 수정한 config / 프롬프트

| 파일 | 변경 |
|---|---|
| `config/prompts/occupancy.yaml` | **P5-a** 축소본으로 교체(좌표/points_2d 요구 제거, occupied bool만). 출력 스키마 `{"spaces":[{"id":1,"occupied":true}],"confidence":0.0}`. |
| `config/llm.config.json` | **P5-c** `stage1/2/3Enabled=false`, `floorRoi.enabled=false`, `occupancy.enabled=true` 유지, **`centering` 블록 제거**, stage1/2/3·floorRoi 프롬프트 경로를 `_archive/`로 갱신(정합). |

## 3. 아카이브 이동 (git mv, 물리삭제 아님) — **P5-b**

`config/prompts/` → `config/prompts/_archive/` (git rename로 이력 보존, 11파일):
- stage1_preset_judge.system.md / .user.md
- stage2_dedupe_label.system.md / .user.md
- stage3_final_report.system.md / .user.md
- floor_roi.yaml, floor_roi_origin_01.yaml, floor_roi_origin_02.yaml, floor_roi.en_box.draft.yaml
- ptz_centering.yaml

**유지(루트 잔존):** `config/prompts/occupancy.yaml`(축소본).

## 4. 삭제한 死코드 (adviseCentering 계열) — **P5-d**

- `AgentRuntime.adviseCentering` 메서드 + import 3종.
- `SetupBrain`: `CenteringAdviceInput` / `CenteringAdviceSchema` / `CenteringAdvice` / 인터페이스 `adviseCentering?` 선언.
- `calibrate/types.ts`: `CenteringAdvice` 인터페이스.
- `llmConfig.ts`: `CenteringSchema` + `LlmConfigSchema.centering` + `DEFAULT_LLM_CONFIG.centering` + loadLlmConfig 머지 라인.
- **호출자 0 재확인**: `grep -rn "adviseCentering|CenteringAdvice|CenteringSchema" src/` → 0건. PtzCalibrator/platePtz 미참조(센터라이징은 순수 P제어).

### 4.1 삭제로 고아가 된 테스트 정리 (규칙3 — 내 변경이 깨뜨린 것만)
- `test/agentRuntimeCentering.test.ts` — adviseCentering 전용 파일 → `git rm`(전체 삭제).
- `test/agentRuntimeNative.test.ts` — adviseCentering 케이스 1개 + `CENTERING_JSON` + `CenteringAdviceInput` import + cfg의 `centering` 블록 제거.
- `test/preparedNoRedownscale.test.ts` — adviseCentering 대조 케이스 + `CenteringAdviceInput` import + cfg의 `centering` 블록 제거(docstring 1줄 정정).

### 4.2 아카이브 이동으로 고아가 된 테스트 경로 정정 (규칙3)
프롬프트를 **런타임에 loadPromptPair로 읽는** 테스트들이 이동으로 ENOENT가 되므로, 동일 내용 파일의 새 경로(`config/prompts/_archive/...`)로 참조만 정정(내용·동작 불변):
- `test/`의 stage1/2/3·floor_roi.yaml·ptz_centering.yaml 참조 → `_archive/` 접두 삽입(sed 일괄, 대상: agentRuntime, agentRuntimeNative, agentRuntimeFloor, agentRuntimeOccupancy, brainStages, brainJsonMode, brainRetry, preparedNoRedownscale, promptsYaml, settingsStore).
- occupancy.yaml(루트 잔존) 참조는 미변경.

## 5. 검증 결과

- **tsc(내 범위 파일):** `dbRoutes / AgentRuntime / SetupBrain / calibrate/types / llmConfig` + 내가 수정한 테스트 → **에러 0**.
  - 전체 `tsc --noEmit`는 420 에러가 나오나 **전부 devA-dbcore의 진행 중 SqliteStore 재작성**(구 메서드 삭제 후 CaptureJob/Finalizer/captureRoutes/PtzCalibrator/reviewers/index.ts 미갱신)에서 발생. 내 파일과 무관(공유 작업트리 병렬 상태). 내 파일 필터 grep 결과 0건 확인.
- **grep 死코드:** `adviseCentering|CenteringAdvice|CenteringSchema` → src/ 0건, test/ 0건.
- **config 로드:** `loadLlmConfig('config/llm.config.json')` 정상 파싱 → stage1/2/3=false, floorRoi.enabled=false, occupancy.enabled=true(prompt=occupancy.yaml), **centering 키 부재**(스키마·config 양쪽 제거로 정합).
- **축소 occupancy.yaml:** loadPromptPair·renderTemplate 정상(치환 잔여 `{{}}` 0, occupied-only·No coordinates 지시 포함).
- **vitest(자립 실행 가능 범위):**
  - `promptsYaml / brainStages / agentRuntimeNative / preparedNoRedownscale / agentRuntimeOccupancy` → **45 passed**(아카이브 경로 로드·occupancy 파싱 정상).
  - `dbRoutes.test.ts`(기존 16개) → **16 passed**(마스킹 추가 회귀 없음).

## 6. 서버 재시작 필요 (문서화 전달)

- `config/llm.config.json`은 **nodemon/tsx watch 감시 밖(`config/`)** → 토글 변경(stage off·floor off·centering 제거) 반영에 **서버 재시작 필요**.
- occupancy.yaml·아카이브 이동은 프롬프트 파일이라 다음 judge 호출 시 재로드(재시작 불요)이나, 경로 참조는 llm.config.json 경유이므로 재시작 시 일괄 반영.

## 7. 미완/후속 (내 범위 밖)

- **reviewer 배선 제거**(CaptureJob/index.ts에서 CheckpointReviewer/FloorRoiReviewer 분리, §6.5) — 다음 라운드(리더 확정).
- **AgentRuntime 잔존 메서드**(judgePreset/dedupeAndLabel/finalReport/reviewCheckpoint/finalizeCapture/recognizeFloorRoi)는 §8 리스크5대로 **미삭제**(배선만 다음 라운드에서 끊음).
- **P4 마스킹 전용 vitest**(설계 §4 검증안: password==='****', 검색어=password값 시 행 비노출, 타 테이블 무영향) — qa-tester가 신규 작성 예정. 기존 16개는 회귀 확인용.
- 전체 `tsc`/전체 vitest 그린은 devA-dbcore의 P0/P2/P3 완료 후 통합 시점에 확정 가능.
