# 03 검증 리포트 — 정밀수집 결과 "저장/열기"

검증자(qa-tester) · 대상: SettingAgent · 근거: `01_architect_plan.md`(§3·§4·§6·§7) + `02_developer_changes.md`.
검증 도구: `vitest run`(모킹) + `tsc --noEmit`. 외부 REST/시뮬레이터·브라우저 DOM 은 모킹/범위 밖(하단 커버리지 공백 참조).

---

## 1. 판정 요약

| 항목 | 결과 |
|------|------|
| 본 기능(save/open) 관련 스위트 | **전부 통과** (아래 §2) |
| `tsc -p tsconfig.json --noEmit` | **0 오류** (독립 재현) |
| 전체 `vitest run` | 581 통과 / **11 실패** — 11건 전부 **선행 결함**(floor_roi.yaml), 본 기능 무관(§4 사실 확인) |
| 경계면 교차 비교 | **불일치 없음** (§3) |

**결론:** 정밀수집 결과 저장/열기 기능은 유닛 레벨에서 성공 기준을 만족한다. 11건 실패는 세션 시작 시점부터 작업트리에 존재하던 `config/prompts/floor_roi.yaml` 결함이며 save/open 코드와 무관함을 사실로 확인했다(본 기능 범위 밖).

---

## 2. 실행한 스위트 (통과 그대로 기록)

명령: `npx vitest run <file>`

| 스위트 | 테스트 | 결과 |
|--------|--------|------|
| `test/saveStore.test.ts` (신규) | 14 | ✅ 통과 |
| `test/captureRoutes.test.ts` (확장) | 31 | ✅ 통과 |
| `test/checkpointFinalizer.test.ts` (확장) | 15 | ✅ 통과 |
| `test/mappingPut.test.ts` (회귀) | 5 | ✅ 통과 |
| `test/mappingDirect.test.ts` (회귀) | 2 | ✅ 통과 |
| `test/roiEdit.test.ts` (회귀) | 56 | ✅ 통과 |
| `test/config.test.ts` + `test/mappingRows.test.ts` (회귀) | 12 | ✅ 통과 |

본 기능 3스위트(saveStore/captureRoutes/checkpointFinalizer) 단독 실행 시 **60/60 통과**.

### 핵심 검증 항목별 대응(태스크 §"검증할 핵심")

1. **SaveStore 단위** — `sanitizeName`: `../etc/passwd`·`/abs`·`a\b`·`""`·`"   "`·`..`·`.`·비문자열(123) → null 차단 확인. 공백→밑줄+한글 허용(`내 결과 1`→`내_결과_1`), `.json`/`.JSON` 확장자 제거, 허용외 문자 제거(`a!@#b$-c_1`→`ab-c_1`). save→load 왕복 무손실(`toEqual`), 파일 생성+디렉터리 자동 생성, 없는/잘못된 이름 load=null, save 안전화 실패 throw, **덮어쓰기(결정 C)**(동명 재저장 시 내용 갱신 + list 1건), list mtime 내림차순, 빈 폴더 `[]`, `defaultSaveName` 포맷(`result_20260703_090507`). → 전부 통과.
2. **라우트 경계** — POST /capture/save: 유효 200 `{ok, name, slots, globalCount}` + 파일 존재, traversal name 400 `invalid name`, coverage 불일치 400 `coverage mismatch`+`missing:['a']`, 잘못된 shape 400 `invalid artifact`. GET /capture/saves 목록 shape(`{saves:[{name,savedAt}]}`). GET :name 200 artifact / 없는 이름 404 `not found` / 허용문자 0(`!!!`) 400 `invalid name`. **saveStore 미주입 시 POST /capture/save 404(미등록, 가산)** 확인. → 전부 통과.
3. **artifactSchema 공유(회귀)** — `saveMappingHandler` 가 `validateArtifactBody` 로 축약된 뒤에도 PUT `/mapping`·`/viewer/api/mapping` 응답 shape(`{ok,slots,globalCount}` / `invalid artifact` / `coverage mismatch` missing·extra) 불변. mappingPut(5)·mappingDirect(2) 통과로 회귀 없음.
4. **Finalizer 자동저장** — saveStore 주입 finalize 시 save/ 스냅샷 **1건** 생성 + 내용=`r.artifact`(`toEqual`) 확인. **미주입 시 예외 없이 finalize**(하위호환) 확인. 구현부(`Finalizer.ts:151-156`)는 `defaultSaveName()` 사용 + try/catch+`logger.warn` 격리(정본 저장은 선행 완료). → 통과.
5. **경계 shape 일치** — §3 참조.

---

## 3. 경계면 교차 비교 (핵심)

동시에 읽고 shape 대조한 지점과 결과:

| 경계 | 생산자 | 소비자 | 판정 |
|------|--------|--------|------|
| 저장 파일 내용 | `SaveStore.save` → `JSON.stringify(artifact)` (래퍼 없음) | `SaveStore.load` → `JSON.parse` as SetupArtifact | **일치** — 왕복 `toEqual` 통과. savedAt 은 파일 미포함, mtime 도출(설계 §4). |
| GET /capture/saves/:name 반환 | `saveStore.load(safe)` = 순수 SetupArtifact (`captureRoutes.ts:237`) | 프론트 `openSaved`: `state.mapping = await res.json()` → `drawRoiOverlay()` (`app.js:485-489`) | **일치** — GET /mapping(`server.ts:204-210` `repo.loadArtifact()` 그대로 반환)과 **동일 shape**. 소비자는 기존 `loadMapping`(`app.js:78`)과 완전히 같은 주입 경로 → 3종 ROI 렌더 100% 재사용. |
| POST /capture/save 검증 | `validateArtifactBody` (`artifactSchema.ts`) | server.ts saveMappingHandler + captureRoutes.save **동일 함수 공유** | **일치** — 단일 검증 소스. plate rect→quad 승격, floor 4~10점 폴리곤, coverage(globalIndex↔slots) 동일 규칙. |
| 3종 ROI shape | `SetupArtifactSchema`: `roiByPreset`(rect) / `plateRoiByPreset`(quad 4점 또는 rect 하위호환) / `floorRoiByPreset`(polygon 4~10점) | 저장 JSON == /mapping shape == state.mapping | **일치** — 스키마가 3종 모두 커버. 저장→열기 왕복 시 3종 ROI shape 보존(shape 레벨 확인). |

**필드명·타입·1-based·래퍼 불일치: 발견되지 않음.** globalIndex 1-based(`globalIdx:1`)는 finalizer 테스트에서 확인됨. 저장 JSON 에 래퍼가 없어 열기 시 언랩 불필요(설계 §4 채택안과 일치).

**요구사항 5 확인** — `init()`(`app.js:1300`)에서 `loadMapping()` 자동 호출 **제거됨**(1305행 주석으로 명시). 잔여 `loadMapping` 호출부(393 map-save 재동기화 / 749 finalize 반영 / 1077 검수탭 동기화)는 전부 사용자/ finalize 트리거로 **시작 시 미표시** 보장. (프론트는 유닛 대상 아님 — shape·호출부는 코드 레벨로 확인.)

---

## 4. 선행 결함 판정 (사실 확인)

**결론: 본 기능(save/open)과 무관한 선행 결함 확정. 본 기능 범위 밖.**

확인한 사실:

1. **실패 11건 = 3파일**: `agentRuntimeNative`(8) · `agentRuntimeFloor`(1) · `promptsYaml`(2). 모두 스택트레이스가 `yaml/dist/compose/...` → `YAMLParseError: Implicit keys need to be on a single line at line 3`.
2. **근본 원인 = `config/prompts/floor_roi.yaml` 결함(작업트리)**: 1행 `system: |` 블록 스칼라, 2행이 **1칸 들여쓰기**(` This is...`)인데 3행 `oblique angle...` 이 **0칸(컬럼1)** → 블록 스칼라가 조기 종료되어 파서가 line 3 을 새 키로 오인. 파일 콘텐츠 자체의 들여쓰기 불일치.
3. **HEAD vs 작업트리 파싱 대조**(독립 재현):
   - `git show HEAD:.../floor_roi.yaml` → **PARSE OK**
   - 현재 작업트리 파일 → **PARSE FAIL — "Implicit keys need to be on a single line at line 3, column 1"** (구현자 보고와 동일 메시지)
4. **git 상태**: `floor_roi.yaml` = ` M`(작업트리 수정, 미스테이징 — 세션 시작 시점부터 존재). `SaveStore.ts` = `??`(본 기능 신규 파일).
5. **본 기능 코드 무의존**: 실패 3파일에서 `SaveStore`/`artifactSchema`/`/capture/save`/`saveStore` import **0건**. save/open 은 YAML/프롬프트 로더를 경유하지 않음.

→ 직전 "floor ROI 가변 다각형" 작업의 미완성 산출물이며, 본 저장/열기 기능이 유발한 회귀가 아니다. **지시대로 floor_roi.yaml 은 수정하지 않았다**(별도 작업 필요). 2행 들여쓰기(1칸)를 0칸으로 맞추거나 블록 스칼라 전체를 동일 들여쓰기로 통일하면 해소될 것으로 보이나, 본 태스크 범위 밖이므로 미조치.

---

## 5. 커버리지 공백 (통과 위장 없음)

- **프론트엔드 브라우저 동작(규칙 3 수동 확인)**: `web/app.js`·`index.html`(버튼·모달·prompt·openSaved)은 vitest DOM 대상이 아니라 **유닛 미검증**. 설계 §6-7의 브라우저 시나리오(로드 시 빈 오버레이 / finalize 후 표시 / 결과 저장→파일 / 결과 열기→3종 ROI 렌더)는 **스모크 미수행**. 코드 레벨(shape·호출부 제거 확인)로만 검증. → 실서버+브라우저 스모크는 별도 필요.
- **config `saveDir` 기본값 병합**: `config.test.ts` 통과로 로딩 무회귀는 확인했으나, "saveDir 누락 config → 기본값 `save` 주입" 명시 단정 테스트는 부재(스키마 required + DEFAULT 병합 코드는 존재). 하위호환 경로 단정 커버리지 소폭 공백.
- **index.ts 결선 런타임 기동**: `tsc` 0 오류로 타입 결선은 확인. 실제 서버 부팅 시 SaveStore 주입 예외 없음(설계 §6-6)은 스모크 미수행.

---

## 6. 실패 리포트 / 재실행 루프

본 기능 관련 **실패 0건** → 구현자에게 재현·수정 요청 없음(루프 불필요). 선행 결함(floor_roi.yaml)은 범위 밖으로 명시하고 미조치.
