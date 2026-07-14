# 04 영향도 분석 — 정밀수집 결과 "저장/열기"

문서화·영향도 분석가(documenter) · 대상: SettingAgent · 작성: 2026-07-03 18:30:52
근거: `01_architect_plan.md` + `02_developer_changes.md` + `03_qa_report.md` + 실제 변경 소스(SaveStore.ts / artifactSchema.ts / captureRoutes.ts / Finalizer.ts / app.js).
최종 문서: `SettingAgent/docs/20260703_183052_정밀수집_결과저장_열기.md`.

---

## 1. 하위 소비자(ActionAgent / DMAgent / @parkagent/types) 영향

**영향 없음(무변경).**

- 저장 파일(`save/*.json`)은 정본 산출물 `data/setup_artifact.json`과 **동일한 순수 `SetupArtifact` 구조**(래퍼 없음)이며, 정본 파일의 경로·형식·쓰기 흐름은 전혀 변경되지 않았다. `save/`는 **부가 스냅샷**일 뿐이다.
- `@parkagent/types` / `src/domain/types.ts`의 `SetupArtifact`·`SlotState`·`ParkingEvent` 등 공유 도메인 타입은 **필드 추가/삭제/타입 변경 없음**. `artifactSchema.ts`는 기존 server.ts 인라인 스키마를 **위치만 이동**(추출)한 것으로 검증 규칙 자체는 불변이다.
- 따라서 setup_artifact를 소비하는 ActionAgent(주차 액션)·DMAgent(대화/상태) 계약은 이 변경에 **무영향**이다.

> setup_artifact shape 불변 확인: `SetupArtifactSchema`의 필드(presets/slots/globalIndex/createdAt/warnings?/report?)와 3종 ROI(roiByPreset·plateRoiByPreset·floorRoiByPreset)는 기존과 동일. 저장/열기 왕복 `toEqual` 통과로 무손실 확인(QA §3).

## 2. 기존 `/mapping` · `/capture` 흐름 영향

- **PUT `/mapping`·`/viewer/api/mapping`(회귀 주의점)**: `saveMappingHandler`가 인라인 검증 로직을 제거하고 `artifactSchema.validateArtifactBody`로 축약되었다. 응답 shape(`{ok,slots,globalCount}` / `invalid artifact` / `coverage mismatch` missing·extra)는 **불변**이며 회귀 테스트(mappingPut 5 / mappingDirect 2)로 보증됨.
- **GET `/mapping`**: 무변경. 저장 파일과 동일 shape을 반환하므로 프론트 `openSaved`는 기존 `loadMapping`과 같은 주입 경로를 쓴다.
- **`/capture/*`**: 기존 라우트(status/finalize 등) 불변. save/saves/saves/:name 3종이 **가산**(saveStore 주입 시에만 등록).
- **순환참조 회피**: server.ts↔captureRoutes.ts가 스키마를 직접 주고받지 않고 중립 모듈 `artifactSchema.ts`에서 import — 순환 없음(tsc 0 오류).

## 3. 동작 변경(사용자 인지 필요) ⚠

**요구사항 5로 페이지 로드 시 ROI 자동 표시가 제거되었다 — 의도된 UX 변경.**

- 변경 전: `app.js init()`이 `loadMapping()`을 호출해 페이지 로드 시 기존 `setup_artifact`의 3종 ROI가 자동 표시됨.
- 변경 후: `init()`에서 해당 호출 제거(1305행 주석 명시) → 로드 시 `state.mapping=null`, **오버레이 빈 화면**. ROI는 **finalize 또는 "결과 열기"로만** 표시된다.
- 영향: 기존 사용자가 "페이지 열면 마지막 결과가 보이던" 동작을 기대하면 혼란 가능. 문서에 명시함. (분석 탭의 정본 조회는 별도 경로로 영향 없음.)

## 4. 하위호환 — 옵셔널 의존성

- **`Finalizer.saveStore?`**: 미주입 시 자동 스냅샷을 건너뛰고 finalize는 정상 완료(예외 없음). QA §2-4로 확인. 자동 저장 실패도 try/catch+`logger.warn`으로 격리되어 정본 저장(선행 완료)에 영향 없음.
- **captureRoutes `saveStore?`**: 미주입 시 3라우트 미등록 → POST `/capture/save`는 404. 기존 라우트 불변(가산). QA §2-2로 확인.
- **`store.saveDir` config**: DEFAULT `"save"` 병합으로 기존 config 파일에 `saveDir` 누락 시 기본값 주입 → 하위호환. (단, "누락→기본값 주입" 명시 단정 테스트는 부재 — §7 참조.)

## 5. 신규 산출물 · 런타임 부수효과

- **`SettingAgent/save/` 폴더**: 서버 최초 저장 시 `mkdirSync(recursive)`로 생성. `.gitignore`(프로젝트 루트)에 `SettingAgent/save/` 추가되어 런타임 스냅샷은 커밋 제외.
- **디스크 증가**: finalize마다 자동 스냅샷 1건 누적(정리·보존 정책 없음 — 현재 요구 범위 밖). 향후 누적량이 커질 수 있음(확인 필요 항목).
- **파일명 보안**: `sanitizeName`이 경로 traversal(`../`, 절대경로, 경로 구분자)·빈값·`.`/`..`를 차단하고 `.json`을 강제. 서버가 권위를 가지므로 클라이언트 우회 불가.

## 6. 선행 결함(본 기능 무관, 별도 처리 필요) ⚠

**통과 위장 없음.** 전체 `vitest run`: **581 통과 / 11 실패**.

- 실패 11건 = 3파일: `agentRuntimeNative`(8) · `agentRuntimeFloor`(1) · `promptsYaml`(2). 스택트레이스 전부 `YAMLParseError: Implicit keys need to be on a single line at line 3`.
- 근본 원인: `config/prompts/floor_roi.yaml`의 블록 스칼라 들여쓰기 불일치(2행 1칸 / 3행 0칸). 세션 시작 시점부터 작업트리에 `M`으로 존재(직전 "floor ROI 가변 다각형" 작업의 미완성 산출물). `git show HEAD:...floor_roi.yaml`은 정상 파싱, 작업트리 파일은 파싱 실패(독립 재현, QA §4).
- 무관 확인: 실패 3파일에서 `SaveStore`/`artifactSchema`/`/capture/save`/`saveStore` import 0건. save/open은 YAML 로더를 경유하지 않음.
- **조치 필요**: 본 태스크 범위 밖으로 미조치. floor_roi.yaml 블록 스칼라 들여쓰기 통일이 별도 작업으로 요구됨.

## 7. 잔여 커버리지 공백(사실 기록)

- **프론트 브라우저 스모크 미수행**(규칙 3 수동 확인): app.js·index.html의 버튼·모달·prompt·openSaved는 vitest DOM 대상 아님. 코드 레벨(shape·호출부 제거)로만 확인. 실서버+브라우저 시나리오(로드 시 빈 오버레이 / finalize 후 표시 / 저장→파일 / 열기→3종 ROI) 별도 필요.
- **config `saveDir` 누락→기본값 주입** 명시 단정 테스트 부재.
- **index.ts 결선 런타임 기동** 스모크 미수행(타입 결선은 tsc 0 오류로 확인).

## 8. 영향 받는 파일 목록(구체)

**신규**: `src/store/SaveStore.ts` · `src/api/artifactSchema.ts` · `test/saveStore.test.ts`
**수정(소스)**: `src/api/server.ts` · `src/api/captureRoutes.ts` · `src/capture/Finalizer.ts` · `src/config/toolsConfig.ts` · `src/index.ts` · `config/tools.config.json` · `web/index.html` · `web/app.js` · `.gitignore`(루트)
**수정(테스트)**: `test/captureRoutes.test.ts` · `test/checkpointFinalizer.test.ts`
**영향 없음(shape 불변 확인)**: `src/domain/types.ts` · `@parkagent/types` · `data/setup_artifact.json` 소비자(ActionAgent/DMAgent) · GET `/mapping`
**본 기능 무관(선행 결함)**: `config/prompts/floor_roi.yaml` 및 그에 의존하는 `agentRuntimeNative`/`agentRuntimeFloor`/`promptsYaml`
