# QA 검증 리포트 — 결과 저장/열기: 서버 save/ → OS 네이티브 로컬 파일 대화상자

- 작성: 검증자(qa-tester)
- 대상: `web/core.js`(parseLoadedArtifact/defaultResultFilename), `web/core.d.ts`, `web/app.js`, `web/index.html`
- 근거: `_workspace/01_architect_plan.md` §7 불변식 + `_workspace/02_developer_changes.md` §9 QA 포인트

---

## 1. 실행 결과 (그대로)

| 항목 | 명령 | 결과 |
|------|------|------|
| 전체 vitest | `npx vitest run` | **76 files / 683 tests 전부 PASS** |
| 신규(구현자) | `test/parseLoadedArtifact.test.ts` | 7 PASS |
| 신규(QA 보강) | `test/parseLoadedArtifact.qa.test.ts` | 16 PASS |
| 타입체크 | `npx tsc -p tsconfig.json --noEmit` | **EXIT 0** (오류 0) |

- 구현자 보고 baseline(75 files / 667 tests) + QA 보강 파일 1개(16 tests) = **76 files / 683 tests**. 회귀 0.

---

## 2. 작성한 테스트 (QA 보강)

`test/parseLoadedArtifact.qa.test.ts` — 구현자 7케이스가 못 덮는 경계면을 보강(구현 소스 무수정, 블랙박스):

### parseLoadedArtifact (11 케이스)
- 최상위 `null`(`'null'`) → ok:false, "최상위가 객체가 아닙니다" — **구현자 케이스 누락분 보강**.
- 최상위 배열(`'[]'`) → ok:false, 객체아님 error 문구 확인(Array.isArray 가드).
- `presets` 개별 누락 / `slots` 개별 누락 → 각각 ok:false — **구현자는 globalIndex 누락만 커버, 나머지 2키 보강**.
- `globalIndex` 가 객체(`{}`, 비배열) → ok:false — **과도한 관용 차단(핵심 3키 배열 강제) 검증**.
- `presets` 가 객체(비배열) → ok:false.
- `slots` 가 `null` → ok:false.
- 공백만(`'   '`, `'\n\t'`) → ok:false(JSON.parse 실패) — **구현자는 `''` 만 커버, 공백 보강**.
- 빈 배열 3키(`{presets:[],slots:[],globalIndex:[]}`) → ok:true — 최소형태가 과엄격이 아님을 반증.
- 정상 artifact → 원형 보존(toEqual) + 추가 최상위 필드(createdAt/warnings) 통과·보존.

### defaultResultFilename (5 케이스)
- 제로패딩: `new Date(2026,0,5,4,3,9)` → `'setup_20260105_040309.json'`(월/일/시/분/초 한 자리→2자리) — **핵심 보강**.
- 자정·초 0: `new Date(2025,11,1,0,0,0)` → `'setup_20251201_000000.json'`.
- 두 자리 경계: `new Date(2024,11,31,23,59,59)` → `'setup_20241231_235959.json'`.
- 주입 date 결정성: 동일 입력 → 동일 출력(멱등) + 고정 기대 문자열.
- 무인자 → `^setup_\d{8}_\d{6}\.json$`.

---

## 3. 불변식 커버리지 체크리스트

### parseLoadedArtifact
- [x] 정상(3배열) → ok:true, artifact 원형 보존 (dev#1 + qa)
- [x] 깨진 JSON(문법오류 `'{'`, `'not json'`) → ok:false, 한글 error (dev#2)
- [x] 비객체 — 문자열 `'"x"'` / 숫자 `'42'` / 배열 `'[]'` / **null `'null'`** → ok:false (dev#3 + qa null)
- [x] 형태불량 — **presets 누락 / slots 누락 / globalIndex 누락** 각각 → ok:false (dev#4 globalIndex + qa presets·slots)
- [x] 형태불량 — 배열 아님(객체/null 타입) presets{} / globalIndex{} / slots=null → ok:false (qa)
- [x] 빈 문자열 `''` / **공백 `'   '`,`'\n\t'`** → ok:false (dev#5 + qa)
- [x] 과도한 관용 아님 — 핵심 3키 배열 강제(비배열 객체 거부) 확인 (qa)

### defaultResultFilename
- [x] 형식 정규식 `^setup_\d{8}_\d{6}\.json$` (dev#2 + qa)
- [x] 고정 Date 주입 결정적 출력 `'setup_20260703_183052.json'` (dev#1 + qa 멱등)
- [x] **제로패딩(월/일/시/분/초 한 자리 → 2자리)** (qa 3케이스)

---

## 4. 경계면 교차 비교 (순수로직 ↔ 소비측 app.js)

`core.js` 순수함수 출력 shape 과 `app.js` 소비 코드를 대조 확인:

- `parseLoadedArtifact` 반환 `{ok:true, artifact}` | `{ok:false, error}` ↔ `openResult`(app.js:504-509): `if(!r.ok){ ...r.error }` 후 `applyLoadedMapping(r.artifact,...)`. **필드명(ok/error/artifact) 정합, 불일치 없음**.
- `defaultResultFilename()` 반환 문자열 ↔ `saveResult`(app.js:487): `name=defaultResultFilename()` → `saveJsonToFile(name, ...)` → `suggestedName` 으로 사용. **정합**.
- `saveJsonToFile` 반환 `string|null`(취소) ↔ `saveResult`(app.js:490-491): `if(saved==null) return`. **취소=null 규약 일치**.
- `pickAndReadJsonFile` 반환 `string|null`(취소) ↔ `openResult`(app.js:502-503): `if(text==null) return`. **정합**.
- `core.d.ts`(248-251) 선언 ↔ `core.js`(737-760) 구현 시그니처 1:1 일치, tsc EXIT 0 으로 확인.

---

## 5. Q2 고아 제거 정합성 (정적 확인)

`web/` 전체 grep 결과 — 삭제 대상 잔존 참조 **0건**:

| 심볼 | 잔존 참조 | 판정 |
|------|-----------|------|
| `renderSaveList` | 0 | OK(삭제됨) |
| `openSaved` | 0 | OK(삭제됨) |
| `open-result`(open-result-modal/list/close) | 0 | OK(모달·배선 삭제됨) |
| `save-item` | 0 | OK |

- `web/index.html`: `#open-result-modal` 블록 없음. 잔존 모달은 `cap-result-modal`·`floor-llm-warn-modal`(무관, 유지 대상). `#result-save`/`#result-open` 버튼 유지 + title 갱신 확인("현재 결과를 로컬 JSON 파일로 저장"/"로컬 JSON 파일에서 결과 열기").
- `web/app.js`: 배선 `result-save→saveResult`, `result-open→openResult`(app.js:1311-1312) 확인. 삭제 함수/모달 참조 0. import 는 `parseLoadedArtifact`/`defaultResultFilename` 2개 추가만.
- tsc EXIT 0 → 타입 레벨에서도 dangling 참조 없음.

---

## 6. DOM·File System Access API 미커버 항목 (수동 스모크 필요 — 통과 위장 금지)

아래 브라우저 전용 배선은 **jsdom 없이 vitest 밖**이라 자동 검증 불가. 코드 레벨(정적)로만 확인함. **실제 동작은 Chromium(localhost) 육안 스모크 필요**:

| # | 시나리오 | 확인 포인트 | 상태 |
|---|----------|-------------|------|
| 1 | 결과 없음 → '결과 저장' | "표시된 결과 없음" 안내, 대화상자 안 뜸 | 미검증(수동) |
| 2 | 결과 표시 후 '결과 저장' | 네이티브 저장 대화상자, 제안명 `setup_YYYYMMDD_HHmmss.json`, "저장됨: {파일명}" | 미검증(수동) |
| 3 | 저장 대화상자 취소 | AbortError→null, 조용히 무동작 | 미검증(수동) |
| 4 | '결과 열기' → JSON 선택 | input[type=file] 대화상자 → 3종 ROI 오버레이+슬롯목록, "열림: 로컬 파일" | 미검증(수동) |
| 5 | 깨진/형태불량 JSON 선택 | "열기 실패: ...", 화면 유지 (parseLoadedArtifact 로직 자체는 vitest 커버) | 로직만 검증·배선 수동 |
| 6 | 열기 대화상자 취소 | 무동작(change 이벤트 없음) | 미검증(수동) |
| 7 | 폴백(비Chromium) | 저장=`<a download>` 다운로드 폴더, 열기=input 동일 경로 | 미검증(수동) |

- **외부 서비스 스모크**: 이 변경은 Unity/VPD/LPD/LPR/VLA REST 를 호출하지 않는 순수 로컬 파일 IO → 외부 서비스 기동 불필요. 단, 시나리오 2·4 의 "결과 표시" 전제(finalize 또는 열기)는 별도 필요.

---

## 7. 발견 결함 / 누락

- **결함**: 없음. 구현 소스(core.js/app.js/index.html)에서 불변식 위반·경계면 불일치 미발견. 구현자 7케이스 전부 유효.
- **구현자 커버리지 gap(결함 아님, QA 보강으로 해소)**: parseLoadedArtifact 의 최상위 null·presets/slots 개별 누락·비배열 객체키·공백, defaultResultFilename 제로패딩이 dev 테스트에 없었음 → `parseLoadedArtifact.qa.test.ts` 16케이스로 보강 완료.
- **커버리지 공백(구조적, 삭제·위장 금지 명시)**: §6 DOM·File System Access API 배선 7종은 vitest(node 환경, jsdom 미사용) 밖 → **브라우저 육안 스모크 미수행 상태로 잔존**. 자동화하려면 Playwright 등 브라우저 e2e 필요(현 범위 밖).

---

## 8. 종합 판정

- 순수로직 불변식(parseLoadedArtifact/defaultResultFilename): **전부 PASS** — 구현자 7 + QA 보강 16 = 23케이스 green.
- 회귀: 기존 core/analyzeArtifact/roiEdit 등 전체 **683 tests green**, tsc EXIT 0.
- Q2 고아 제거: 잔존 참조 **0건**(정적 확인 완료).
- 잔여: §6 브라우저 배선 수동 스모크 7종 **미수행(육안 필요)** — 통과로 위장하지 않고 미검증으로 명시.
