# 02 구현 변경 노트 — 정밀수집 결과 "저장/열기"

구현자(developer) · 대상: SettingAgent · 설계서: `_workspace/01_architect_plan.md` + 리더 확정(A/Y/덮어쓰기 + 자동표시 제거).

검증: `tsc --noEmit` 0. 신규·확장 테스트 스위트(saveStore/captureRoutes/checkpointFinalizer/mappingPut/roiEdit/mappingDirect) **123 통과**. (전체 `vitest run`의 11 실패는 본 기능과 무관한 선행 결함 — 아래 §7 참조.)

---

## 1. 리더 확정 결정 반영

| 결정 | 반영 |
|------|------|
| A = 자동+수동 병행 | finalize 완료 시 `result_YYYYMMDD_HHMMSS` 로 자동 저장(`Finalizer` → `SaveStore.save`). "결과 저장" 버튼은 `window.prompt` 로 이름 입력 후 저장. |
| B = 클라이언트 현재 상태 POST | "결과 저장"이 현재 화면 `state.mapping`(편집 반영본)을 `{name, artifact}` 로 `POST /capture/save`. 서버가 `validateArtifactBody`(shape+coverage) 재검증. |
| C = 덮어쓰기 | `SaveStore.save` 가 동명 파일을 그대로 덮어씀(`writeFileSync`). |
| 요구사항 5 | `app.js init()` 의 `loadMapping()` 자동 호출 제거 → 로드 시 `state.mapping=null`, 오버레이 빈 화면. "결과 열기"·finalize 로만 표시. |

이름 입력은 설계서의 `#save-name-modal` 대신 리더 지시("이름 입력 대화창(prompt)") 및 태스크 문구("이름 prompt")에 따라 **`window.prompt`** 를 사용했다. 열기 목록은 다건 선택이 필요해 모달(`#open-result-modal`)로 구현. → 모달 1개만 추가(HTML 표면 최소화).

---

## 2. 파일별 변경

### 신규
- **`src/store/SaveStore.ts`** — `save/` 폴더 파일 IO 소유(Repository 미러). 메서드:
  - `sanitizeName(input)`: `[A-Za-z0-9가-힣_-]` 허용(+공백→`_`), 그 외 제거. 빈값·`.`·`..`·경로구분자(`/ \`) 차단(null). 입력의 `.json` 제거(중복확장자 방지). 반환은 확장자 없는 안전 base 이름.
  - `save(name, artifact)`: `save/{safe}.json` 기록(디렉터리 자동 생성, 덮어쓰기). 안전화 실패 시 throw.
  - `list()`: `.json` 파일 → `{name, savedAt(mtime ISO)}` mtime 내림차순. 폴더 없으면 `[]`.
  - `load(name)`: 안전화 실패·파일 없음 → null.
  - `defaultSaveName(date?)`(export 함수): `result_YYYYMMDD_HHMMSS`(로컬 시각).
- **`src/api/artifactSchema.ts`** — server.ts 에서 추출한 중립 모듈(순환참조 회피). `SetupArtifactSchema`(zod) + `validateArtifactBody(body)` 헬퍼. 결과 `{ok:true, artifact}` 또는 `{ok:false, code, body}`(invalid artifact | coverage mismatch). plate rect→quad 승격 포함. server.ts·captureRoutes.ts 공유.

### 수정
- **`src/api/server.ts`** — 인라인 `SetupArtifactSchema`/plate 승격/coverage 로직을 제거하고 `validateArtifactBody` 사용으로 `saveMappingHandler` 축약(동작·응답 shape 불변). `ApiDeps.saveStore?` 추가 → `registerCaptureRoutes` 호출에 전달. 고아 import(`validateCoverage`/`rectToQuad`/`NormalizedQuad`/`NormalizedRect`/`SetupArtifact`) 제거.
- **`src/api/captureRoutes.ts`** — `CaptureRouteDeps.saveStore?` 추가. saveStore 주입 시에만 3라우트 등록(가산, 위임만).
- **`src/capture/Finalizer.ts`** — `FinalizerDeps.saveStore?` 추가. `saveArtifact`+snapshot 직후 `saveStore.save(defaultSaveName(), artifact)` 자동 스냅샷. 실패는 try/catch + `logger.warn`(정본 저장은 이미 완료 → 격리).
- **`src/config/toolsConfig.ts`** — `StoreSchema.saveDir`(`z.string().min(1)`) + DEFAULT `store.saveDir='save'`. 기존 config 병합으로 하위호환(누락 시 기본값).
- **`config/tools.config.json`** — `store.saveDir: "save"` 추가.
- **`src/index.ts`** — `new SaveStore(tools.store.saveDir)` → Finalizer·buildServer deps 주입.
- **`web/index.html`** — `roi-edit-bar` 에 `#result-save`/`#result-open` 버튼. `#open-result-modal`(목록 `#open-result-list` + 닫기) 추가.
- **`web/app.js`** — `init()` 의 `loadMapping()` 제거. `saveResult()`(prompt→POST)/`openResult()`(목록 조회)/`renderSaveList()`/`openSaved()`(state.mapping 주입 후 기존 렌더 재사용) 추가 + 버튼 결선.
- **`.gitignore`**(프로젝트 루트) — `SettingAgent/save/` 무시 추가(런타임 스냅샷 커밋 제외).

### 테스트
- **`test/saveStore.test.ts`**(신규) — sanitizeName(traversal/한글/빈값/확장자/허용외), save→load 왕복, 파일 생성, 없는/잘못된 이름 load=null, save throw, 덮어쓰기, list 정렬, 빈 폴더, `defaultSaveName` 포맷.
- **`test/captureRoutes.test.ts`**(확장) — 임시 saveDir+SaveStore 서버로 POST 200/400(name·coverage·shape), GET 목록, GET :name 200/404/400, saveStore 미주입 시 404(미등록).
- **`test/checkpointFinalizer.test.ts`**(확장) — saveStore 주입 finalize → save 1건(내용=artifact), 미주입 시 예외 없이 finalize.

`web/core.js` 는 변경하지 않았다(파일명 검증 권위=서버 SaveStore, 열기 결과는 기존 렌더 로직 재사용). 설계서의 선택적 `safeSaveName` 는 최소 원칙상 미추가.

---

## 3. 신규 REST 엔드포인트

`/capture/*` 아래 등록(saveStore 주입 시). 미주입 시 미등록(가산).

| 메서드·경로 | 요청 | 성공 | 실패 |
|-------------|------|------|------|
| `POST /capture/save` | `{name, artifact}` | 200 `{ok:true, name, slots, globalCount}` | 400 `{error:"invalid name"}` / `{error:"invalid artifact", detail}` / `{error:"coverage mismatch", missing, extra}` |
| `GET /capture/saves` | — | 200 `{saves:[{name, savedAt}]}`(mtime 내림차순, 없으면 `[]`) | — |
| `GET /capture/saves/:name` | `:name`=encodeURIComponent | 200 `SetupArtifact`(GET /mapping 동일 shape) | 400 `{error:"invalid name"}` / 404 `{error:"not found"}` |

---

## 4. 저장 JSON 스키마

`save/{name}.json` = **`SetupArtifact` 그대로**(래퍼 없음, `data/setup_artifact.json` 과 동일 구조). `savedAt` 은 파일에 넣지 않고 mtime 에서 도출. → 열기 시 `state.mapping` 직접 주입, 기존 3종 ROI(차량 rect·번호판 quad·바닥 polygon) 렌더 100% 재사용.

---

## 5. 프론트 흐름

1. **로드**: `state.mapping=null` 유지 → 오버레이 빈 화면(요구사항 5).
2. **결과 저장**: `#result-save` → `state.mapping` 없으면 안내. 있으면 `window.prompt` 이름 → `POST /capture/save {name, artifact: state.mapping}` → `map-msg` 결과 표기(coverage mismatch 별도 문구).
3. **결과 열기**: `#result-open` → `GET /capture/saves` → 모달 목록(이름·저장시각) → 클릭 → `GET /capture/saves/:name` → `state.mapping` 주입, `roiHidden=false` → `drawRoiOverlay`/`renderSlotList`/`renderSelectionInfo` → 모달 닫기.
4. **finalize**: 기존 표시 동작 유지. 서버가 자동 스냅샷(요구사항 1) — 프론트 추가 동작 없음.
5. **편집 후 저장**: floor 정점 드래그/삭제로 `state.mapping` 변경 후 `#result-save` → 편집 반영본 저장(기존 `map-save`(PUT /mapping)와 독립).

---

## 6. 자체 검증

- `npx tsc -p tsconfig.json --noEmit` → 0 오류.
- `vitest run` 대상 스위트: saveStore(신규)·captureRoutes(확장)·checkpointFinalizer(확장)·mappingPut·roiEdit·mappingDirect 전부 그린(123 통과).
- 회귀: `saveMappingHandler` 리팩터 후 PUT `/mapping`·`/viewer/api/mapping` 응답 shape(`{ok,slots,globalCount}` / `invalid artifact` / `coverage mismatch` missing·extra) 불변 확인(mappingPut·mappingDirect 통과).

---

## 7. 설계 대비 차이 · 발견 사항

- **이름 입력 UI**: 설계서 `#save-name-modal`(모달) → 리더 지시대로 `window.prompt` 로 단순화. 열기만 모달. (동작·계약 동일, HTML 표면 축소.)
- **자동 스냅샷 이름**: 설계서 `capture_{ts}` → 리더 결정 A 의 `result_YYYYMMDD_HHMMSS` 채택.
- **⚠ 선행 결함(본 기능 무관)**: 전체 `vitest run` 시 `agentRuntimeFloor`·`agentRuntimeNative`·`promptsYaml` 3파일 11건 실패. 원인은 작업트리에 이미 수정돼 있던 **`config/prompts/floor_roi.yaml` 의 YAMLParseError**("Implicit keys need to be on a single line", line 3) — 직전 "floor ROI 가변 다각형" 작업의 미완성 산출물이다(세션 시작 시점 git status 에 이미 `M` 으로 존재. HEAD 버전은 정상 파싱됨). 본 저장/열기 기능과 무관하며, 외과적 변경 원칙상(다른 기능의 진행 중 파일) 수정하지 않았다. **리더/검증자 확인 요망** — floor_roi.yaml 은 별도 처리 필요.
