# 구현 변경 노트 — 결과 저장/열기: 서버 save/ → OS 네이티브 로컬 파일 대화상자

- 작성: 구현자(developer)
- 근거: `_workspace/01_architect_plan.md` + 리더 게이트 확정(Q1/Q2/Q3)
- 대상: SettingViewer 프론트엔드(`web/`) + 신규 순수테스트

---

## 1. 변경 파일별 요지

| 파일 | 변경 | 요지 |
|------|------|------|
| `web/core.js` | 추가 | 순수함수 `parseLoadedArtifact`, `defaultResultFilename` 2개(파일 말미, createStreamLoop 뒤) |
| `web/core.d.ts` | 추가 | 위 2함수 타입 선언 |
| `web/app.js` | 수정 | import 2개 추가 / 파일 IO 헬퍼 2개 + 공유 렌더 헬퍼 1개 추가 / `saveResult`·`openResult` 재작성 / `renderSaveList`·`openSaved` 삭제 / `open-result-close` 배선 삭제 |
| `web/index.html` | 수정 | `#open-result-modal` 블록 삭제 / `#result-save`·`#result-open` title 갱신 |
| `test/parseLoadedArtifact.test.ts` | 신규 | 순수함수 2개 vitest(7 케이스) |

---

## 2. 신규 함수 시그니처

`web/core.js`(+ `core.d.ts` 선언):

```ts
parseLoadedArtifact(text: string):
  { ok: true; artifact: ArtifactLike } | { ok: false; error: string };
defaultResultFilename(date?: Date): string;   // setup_YYYYMMDD_HHmmss.json (로컬시각)
```

- `parseLoadedArtifact`: JSON.parse 실패 / 비객체(배열·숫자·문자열 포함) / `presets`·`slots`·`globalIndex` 배열 누락 시 `ok:false` + 한글 error. 정상 시 파싱 객체를 `artifact` 로 반환. **최소 형태(3배열 존재)만 검증**(리더 Q3 확정 — 슬롯/ROI 깊은검증 안 함).
- `defaultResultFilename`: `date` 주입 가능(테스트용), 기본 `new Date()`. `getMonth()+1` 등 로컬시각.

`web/app.js`(비순수, vitest 밖):

```js
async saveJsonToFile(suggestedName, text): Promise<string|null>  // 저장 파일명 | null(취소)
function pickAndReadJsonFile(): Promise<string|null>             // 파일 텍스트 | null(취소)
function applyLoadedMapping(artifact, label): void               // state 주입 + 3종 렌더 재사용
```

---

## 3. saveResult / openResult 재작성

### saveResult
1. `state.mapping` 없으면 `map-msg`="표시된 결과 없음 — 최종화 또는 결과 열기 후 저장하세요"(기존 메시지 유지) → return.
2. `name = defaultResultFilename()`, `text = JSON.stringify(state.mapping, null, 2)`.
3. `saveJsonToFile(name, text)` → 반환 null(취소) 조용히 return, 성공 시 `map-msg`="저장됨: {파일명}".
4. try/catch → 파일오류 시 `map-msg`="저장 실패: {err}".

### openResult
1. `pickAndReadJsonFile()` → null(취소) 조용히 return.
2. `parseLoadedArtifact(text)` → `ok:false` 시 `map-msg`="열기 실패: {error}" return.
3. `applyLoadedMapping(r.artifact, '로컬 파일')` → 성공 시 `map-msg`="열림: 로컬 파일".
4. try/catch(File API 오류) → `map-msg`="열기 실패: {err}".

---

## 4. 파일 IO 방식(리더 게이트 반영)

- **Q1 저장** = `showSaveFilePicker`(File System Access API, `suggestedName` + JSON types) → `createWritable().write().close()`. **미지원**(`typeof window.showSaveFilePicker !== 'function'`)이면 `Blob([text],{type:'application/json'})` + `URL.createObjectURL` + 임시 `<a download>` 클릭 + `revokeObjectURL` 폴백(다운로드 폴더로 저장).
- **Q1 열기** = 동적 `input[type=file] accept=".json,application/json"` 단일 사용(모든 브라우저 호환·최소). `showOpenFilePicker` 는 쓰지 않음(리더 확정 B안). change 이벤트에서 `file.text()` resolve.
- **취소 처리**:
  - 저장 `showSaveFilePicker` 취소 → `AbortError` 캐치 후 `null` 반환(조용히 무동작). 그 외 오류는 rethrow → `saveResult` catch 에서 메시지.
  - 열기 `input[type=file]` 취소 → 브라우저가 change 이벤트를 주지 않음 → Promise 미해결(부작용 없음, 1회성 input). 파일 선택 후 `files[0]` 부재 방어로 `resolve(null)`.
- **폴백 저장은 취소 개념 없음** → 항상 파일명 반환("저장됨" 메시지). 계획 §3.2/§8과 일치.

---

## 5. 고아 제거 목록(자기 변경으로 미사용화된 것만, CLAUDE.md §3)

- `web/app.js`: `renderSaveList()`, `openSaved()` 함수 삭제(서버 열기 흐름 대체됨).
- `web/app.js`: `$('open-result-close')` 배선 삭제(모달 제거로 대상 없음).
- `web/index.html`: `#open-result-modal`(+ `#open-result-list`, `#open-result-close`) 마크업 삭제.
- import 변화: core 함수 제거 없음(제거 함수들은 core 아님) → import 목록은 2개 추가만.
- 검증: `web/` 전체에서 `open-result | renderSaveList | openSaved | save-item` grep 0건.

---

## 6. 서버측 미사용화(삭제 금지 — 계획 §0·§6 준수)

뷰어가 더 이상 호출하지 않으나 **서버 코드·라우트는 그대로 유지**(요청받지 않은 서버 데드코드 제거 금지):

- `src/api/captureRoutes.ts`: `POST /capture/save`, `GET /capture/saves`, `GET /capture/saves/:name` — **뷰어 미사용화**(잔존).
- `src/store/SaveStore.ts`: `Finalizer` 의 finalize 자동 스냅샷이 계속 사용 → 살아있음.
- `src/capture/Finalizer.ts`, `src/api/artifactSchema.ts`, `config/tools.config.json`(`store.saveDir`) — 무변경.
- 로컬 저장 파일은 순수 `SetupArtifact` JSON → 서버 `save/*` 파일·`data/setup_artifact.json` 과 상호 호환(열기 시 동일 렌더).

---

## 7. 계획 대비 편차

- 없음. 계획 §2~§4 및 리더 게이트(Q1=열기 input 단일 / Q2=모달 제거 / Q3=최소검증)를 그대로 구현. 설계 결함 발견 없음.
- `app.css` 는 손대지 않음(모달 전용 클래스는 `.modal`/`.modal-box` 공용 — 다른 모달이 사용, 삭제 시 회귀 위험). `.save-item` 규칙은 원래 없었으므로 CSS 변경 불필요.

---

## 8. 검증 결과

- `npx tsc -p tsconfig.json --noEmit` → **EXIT 0**(core.d.ts 신규 선언 포함 타입 무오류).
- `npx vitest run` → **75 files / 667 tests 전부 green**(신규 `parseLoadedArtifact.test.ts` 7 케이스 포함, 무회귀).

---

## 9. QA 검증 포인트

### vitest(순수, 자동)
- `parseLoadedArtifact`: 정상→`ok:true`(`slots`/`globalIndex` 보존), `'{'`·`'not json'`→false, `'[]'`·`'42'`·`'"x"'`→false, `{presets,slots}`(globalIndex 누락)→false, `''`→false.
- `defaultResultFilename`: `new Date(2026,6,3,18,30,52)`→`'setup_20260703_183052.json'`, 무인자→`^setup_\d{8}_\d{6}\.json$`.

### 수동 스모크(vitest 밖 — 커버리지 공백 명시)
- **DOM·File System Access API 배선은 vitest 대상 아님**(`showSaveFilePicker`/`input[type=file]`/`<a download>` 브라우저 전용). `saveResult`/`openResult`/`saveJsonToFile`/`pickAndReadJsonFile`/`applyLoadedMapping` 은 코드 레벨로만 확인됨.
- **외부 서비스 미기동 누락 명시**: 이 변경은 Unity/VPD/LPD/LPR/VLA REST 를 호출하지 않음(순수 로컬 파일 IO). 따라서 외부 서비스 기동 없이도 브라우저 스모크만으로 충분하나, "결과 표시" 전제(finalize 또는 열기)는 별도로 필요.
- 브라우저 수동 체크리스트(계획 §7): (1) 결과 없음→"표시된 결과 없음"(대화상자 안 뜸), (2) 결과 표시 후 저장→제안명 `setup_...json`·"저장됨:{파일명}", (3) 저장 취소→무동작, (4) 열기→JSON 선택→3종 ROI+슬롯목록·"열림: 로컬 파일", (5) 깨진 JSON→"열기 실패: ..."(화면 유지), (6) 열기 취소→무동작, (7) 폴백: 비Chromium(showSaveFilePicker 미지원)→저장은 다운로드 폴더 내려받기, 열기는 input 대화상자(모든 브라우저 동일 경로).
