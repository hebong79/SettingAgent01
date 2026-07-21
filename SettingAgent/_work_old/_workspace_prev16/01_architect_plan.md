# 설계 계획 — 결과 저장/열기: 서버 save/ → OS 네이티브 파일 대화상자(클라이언트 로컬)

- 작성: 설계자(architect)
- 대상: SettingAgent / SettingViewer 웹 뷰어(`web/`)
- 요청: '결과 저장'·'결과 열기' 버튼을 서버 `save/` 폴더 대신 **클라이언트(내 PC) 로컬 파일**을 다루는 OS 네이티브 파일 대화상자로 전환
- 리더 확정: 저장위치=클라이언트 로컬(File System Access API) · 저장=네이티브 저장 대화상자에서 파일명 입력 후 `state.mapping` JSON write · 열기=네이티브 열기 대화상자로 로컬 JSON 선택→화면 반영

---

## 0. 핵심 판단 요약

- 이 변경은 **전적으로 SettingViewer 프론트엔드(브라우저 DOM + File System Access API)**다. MCP 도구/LLM 두뇌 경계 판단은 해당 없음(실시간 수치루프도, 맥락판단도 아님). 대신 하네스 컨벤션 적용: **순수 로직은 `core.js`(vitest 검증)**, **DOM·File API 배선은 `app.js`**.
- 서버측(`/capture/save`, `/capture/saves`, `SaveStore`, finalize 자동 스냅샷)은 **삭제하지 않는다**. finalize 자동저장은 `SaveStore`를 계속 쓰므로 `SaveStore`는 살아있다. 뷰어에서만 미사용화되는 3개 REST 라우트는 "뷰어 미사용"으로 명시만 한다(요청받지 않은 서버 데드코드 제거 금지 — CLAUDE.md §3).
- 신규 순수함수 2개(`parseLoadedArtifact`, `defaultResultFilename`)만 추가한다. 그 이상의 추상화/유연성은 넣지 않는다(§2 단순함).

---

## 1. 현행 동작(제거·대체 대상) 정리

`web/app.js`
- `saveResult()`(413~443): `window.prompt` 이름 → `POST /capture/save {name, artifact: state.mapping}`. **→ 로컬 파일 저장으로 전면 교체.**
- `openResult()`(446~457): `GET /capture/saves` → 모달 목록 표시. **→ 로컬 파일 열기로 전면 교체.**
- `renderSaveList(saves)`(460~473): 서버 목록 렌더. **→ 고아(제거).**
- `openSaved(name)`(477~496): `GET /capture/saves/:name` → `state.mapping` 주입 → `drawRoiOverlay/renderSlotList/renderSelectionInfo`. **→ fetch 부분 제거, 후반 렌더 재사용 부분은 공유 헬퍼로 추출.**
- 버튼 배선(1294~1298): `result-save`→saveResult, `result-open`→openResult, `open-result-close`→모달 닫기. **→ 모달 닫기 배선은 고아(제거).**

`web/index.html`
- `#result-save`/`#result-open` 버튼(119~120): **유지**(핸들러 내용만 교체). title 문구는 "save/" 표현 제거로 갱신.
- `#open-result-modal`(237~245, `#open-result-list`·`#open-result-close`): 서버 목록 모달. **→ 고아(제거).**

`web/core.js` / `core.d.ts`: 저장/열기 관련 순수함수 없음 → **신규 2개 추가.**

---

## 2. 신규 순수 로직(`web/core.js` + `core.d.ts`, vitest 대상)

### 2.1 `parseLoadedArtifact(text)` — 로드 텍스트 파싱·형태검증

```js
/**
 * 로컬에서 읽은 JSON 텍스트를 파싱·최소형태검증. SetupArtifact 최소 형태
 * (presets/slots/globalIndex 배열 존재)만 확인한다(analyzeArtifact 관용도와 정합).
 * → { ok:true, artifact } | { ok:false, error }.
 */
export function parseLoadedArtifact(text) {
  let obj;
  try { obj = JSON.parse(text); }
  catch { return { ok: false, error: '올바른 JSON 파일이 아닙니다(파싱 실패)' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '형식 오류: 최상위가 객체가 아닙니다' };
  }
  if (!Array.isArray(obj.presets) || !Array.isArray(obj.slots) || !Array.isArray(obj.globalIndex)) {
    return { ok: false, error: '형식 오류: presets/slots/globalIndex 배열이 필요합니다' };
  }
  return { ok: true, artifact: obj };
}
```

- **검증 깊이 결정**: 최소 형태(3개 배열 존재)만. 슬롯 내부 `roiByPreset`/`slotId` 깊은검증은 **하지 않는다**(비목표). 근거: (a) 클라이언트는 브라우저라 서버 zod(`artifactSchema.ts`)를 직접 import 불가. (b) 화면 렌더(`analyzeArtifact`, `drawRoiOverlay`)가 이미 필드 부재를 `?? []`/`?? {}`로 관용 처리한다. (c) 최소·단순 원칙. 깊은검증이 필요하면 게이트 Q3 참조.
- **검증**: 정상 artifact→`ok:true, artifact 동일객체`; 깨진 JSON→`ok:false`; 배열/숫자/문자열 최상위→`ok:false`; `presets` 등 배열 누락→`ok:false`; 빈 문자열→`ok:false`.

### 2.2 `defaultResultFilename(date = new Date())` — 제안 파일명

```js
/** 저장 대화상자 제안 파일명. setup_YYYYMMDD_HHmmss.json (로컬시각). date 주입으로 테스트. */
export function defaultResultFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `setup_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`;
}
```

- 서버 `SaveStore.defaultSaveName`(`result_...`)과 별개 함수(프리픽스 `setup_`, 확장자 `.json` 포함). 서버 함수 재사용 불가(브라우저·확장자 정책 상이) → 뷰어 전용 순수함수.
- **검증**: 고정 Date 주입 시 정확한 문자열; 정규식 `^setup_\d{8}_\d{6}\.json$` 매칭.

### 2.3 `core.d.ts` 선언 추가

```ts
export function parseLoadedArtifact(
  text: string,
): { ok: true; artifact: ArtifactLike } | { ok: false; error: string };
export function defaultResultFilename(date?: Date): string;
```

---

## 3. DOM·File API 배선(`web/app.js`, vitest 밖 — 수동확인)

### 3.1 import 갱신
`./core.js` import 목록에 `parseLoadedArtifact`, `defaultResultFilename` 추가.

### 3.2 파일 IO 헬퍼 2개(File System Access API + 폴백)

**저장 헬퍼** `saveJsonToFile(suggestedName, text)`:
1. `window.showSaveFilePicker` 존재 시:
   - `const h = await showSaveFilePicker({ suggestedName, types:[{ description:'JSON', accept:{'application/json':['.json']} }] })`
   - `const w = await h.createWritable(); await w.write(text); await w.close();` → 성공(파일명 `h.name` 반환).
   - `catch (e)`: `e.name === 'AbortError'` → 취소(조용히 null 반환). 그 외 rethrow.
2. 미지원(폴백): `Blob([text], {type:'application/json'})` → `URL.createObjectURL` → 임시 `<a download=suggestedName>` 클릭 → `revokeObjectURL`. (다운로드 폴더로 저장, 취소 개념 없음.)

**열기 헬퍼** `pickAndReadJsonFile()` → `Promise<string|null>`(취소=null):
1. `window.showOpenFilePicker` 존재 시:
   - `const [h] = await showOpenFilePicker({ types:[{ description:'JSON', accept:{'application/json':['.json']} }], multiple:false })`
   - `const f = await h.getFile(); return await f.text();`
   - `catch AbortError` → null.
2. 미지원(폴백): 동적 `<input type="file" accept=".json,application/json">` → `change` 이벤트에서 `files[0].text()` → 텍스트 resolve. (취소는 브라우저가 이벤트를 안 주므로 미해결 Promise가 되지 않도록 1회성 입력을 사용하고, 취소 시 아무 동작 없음으로 둔다.)

> 열기 방식 대안은 게이트 Q1 참조(showOpenFilePicker 우선 vs input[type=file] 단일).

### 3.3 `saveResult()` 재작성(교체)
```
1) state.mapping 없으면 map-msg = '표시된 결과 없음 — 최종화 또는 결과 열기 후 저장하세요' (기존 메시지 유지) → return
2) const name = defaultResultFilename()
3) const text = JSON.stringify(state.mapping, null, 2)
4) const saved = await saveJsonToFile(name, text)
5) saved 취소(null) → 조용히 return
6) 성공 → map-msg = `저장됨: ${saved}` (폴백 다운로드도 동일 메시지)
7) catch → map-msg = `저장 실패: ${err}`
```
- **하위호환**: `state.mapping` shape 불변, `POST /capture/save` 미사용(서버 라우트는 잔존).

### 3.4 `openResult()` 재작성(교체)
```
1) const text = await pickAndReadJsonFile()
2) text == null(취소) → 조용히 return
3) const r = parseLoadedArtifact(text)
4) r.ok === false → map-msg = `열기 실패: ${r.error}` → return
5) applyLoadedMapping(r.artifact, '로컬 파일')   // §3.5 공유 헬퍼
6) catch(File API 오류) → map-msg = `열기 실패: ${err}`
```

### 3.5 `applyLoadedMapping(artifact, label)` — openSaved 렌더 재사용부 추출
```
state.mapping = artifact;
state.roiHidden = false;
state.selectedSlotId = null;
drawRoiOverlay();
renderSlotList();
renderSelectionInfo();
const msg = $('map-msg'); if (msg) msg.textContent = `열림: ${label}`;
```
- `openSaved`의 후반 렌더 로직(489~492)을 그대로 추출. 모달 hide(`$('open-result-modal').hidden = true`)는 모달 제거로 불필요 → 제외.

### 3.6 고아 제거
- `renderSaveList`, `openSaved` 함수 삭제(서버 열기 흐름 대체됨 → 직접 고아).
- 배선 `$('open-result-close').addEventListener(...)`(1296~1298) 삭제.
- import 변화 없음(제거 함수는 core 아님).

---

## 4. `web/index.html` 변경

- `#open-result-modal` 블록(237~245) **삭제**(고아).
- `#result-save` title: `현재 화면 결과를 이름 지정해 save/ 에 저장` → `현재 결과를 로컬 JSON 파일로 저장`.
- `#result-open` title: `save/ 에 저장된 결과 열기` → `로컬 JSON 파일에서 결과 열기`.
- `#result-save`/`#result-open` 버튼 요소 자체는 유지.

---

## 5. 단계별 실행 계획 + 검증

```
1. core.js 에 parseLoadedArtifact/defaultResultFilename 추가 + core.d.ts 선언
   → 검증: test/parseLoadedArtifact.test.ts (신규) 통과 — 정상/깨진JSON/비객체/배열누락/빈값 + 파일명 형식.
2. app.js: import 갱신 + saveJsonToFile/pickAndReadJsonFile/applyLoadedMapping 추가
   → 검증: 기존 vitest(core 대상) 무회귀. tsc/lint 무오류(app.js 는 JS라 tsc 대상 아님 — core.d.ts typecheck만).
3. app.js: saveResult/openResult 재작성, renderSaveList/openSaved/open-result-close 배선 제거
   → 검증: 코드 레벨 — result-save/result-open 배선이 새 핸들러를 가리키고, open-result-* 참조가 남지 않음(grep 0건).
4. index.html: #open-result-modal 삭제, 버튼 title 갱신
   → 검증: open-result-modal/open-result-list/open-result-close 참조 grep 0건(html+js).
5. 회귀: SettingAgent vitest 전체(선행 결함 제외) 통과, core.d.ts typecheck 0오류.
   → 검증: qa-tester 실행. 신규 순수테스트 green + analyzeArtifact/roiEdit 등 기존 green 유지.
6. 수동 스모크(브라우저): §7 체크리스트.
```

---

## 6. 영향 파일 목록 / 시그니처(구현자·문서화 전달)

| 파일 | 변경 | 시그니처/요지 |
|------|------|--------------|
| `web/core.js` | 추가 | `parseLoadedArtifact(text)`, `defaultResultFilename(date?)` (순수) |
| `web/core.d.ts` | 추가 | 위 2함수 선언 |
| `web/app.js` | 수정 | import 2개 추가; `saveJsonToFile`/`pickAndReadJsonFile`/`applyLoadedMapping` 추가; `saveResult`/`openResult` 재작성; `renderSaveList`/`openSaved` 삭제; `open-result-close` 배선 삭제 |
| `web/index.html` | 수정 | `#open-result-modal` 삭제; `#result-save`/`#result-open` title 갱신 |
| `test/parseLoadedArtifact.test.ts` | 신규 | parseLoadedArtifact + defaultResultFilename vitest |

**미변경(뷰어 미사용화만 명시, 삭제 금지)**: `src/api/captureRoutes.ts`(`/capture/save`·`/capture/saves`·`/capture/saves/:name`), `src/store/SaveStore.ts`(finalize 자동저장이 계속 사용), `src/capture/Finalizer.ts`, `src/api/artifactSchema.ts`, `config/tools.config.json`(`store.saveDir`). → 문서화 담당은 "뷰어에서 미사용화됨(서버 자동 스냅샷은 유지)"으로 영향도에 기록.

---

## 7. QA 검증 불변식 + 수동확인 범위

### vitest(순수) — `test/parseLoadedArtifact.test.ts`
- `parseLoadedArtifact`: (a)정상 SetupArtifact→`ok:true`, `artifact.slots` 보존; (b)`'{'`·`'not json'` 깨진 JSON→`ok:false`; (c)`'[]'`(배열)·`'42'`(숫자)·`'"x"'`(문자열)→`ok:false`; (d)`{presets:[],slots:[]}`(globalIndex 누락)→`ok:false`; (e)`''`(빈값)→`ok:false`.
- `defaultResultFilename`: 고정 `new Date(2026,6,3,18,30,52)` 주입→`'setup_20260703_183052.json'`; 무인자→정규식 `^setup_\d{8}_\d{6}\.json$` 매칭.

### vitest 밖(수동 스모크 — 커버리지 공백 명시)
- **DOM·File System Access API 배선은 vitest 대상 아님**(showSaveFilePicker/showOpenFilePicker/`<input type=file>`/`<a download>`은 브라우저 전용). app.js 핸들러는 코드 레벨로만 확인.
- 수동 체크리스트(실서버+Chromium):
  1. 결과 없음 상태에서 '결과 저장' → "표시된 결과 없음" 안내(저장 대화상자 안 뜸).
  2. finalize/열기로 결과 표시 후 '결과 저장' → 네이티브 저장 대화상자, 제안명 `setup_YYYYMMDD_HHmmss.json`, 저장 후 map-msg="저장됨: {파일명}".
  3. 저장 대화상자 취소 → 조용히 무동작(에러 메시지 없음).
  4. '결과 열기' → 네이티브 열기 대화상자 → 방금 저장한 JSON 선택 → 3종 ROI 오버레이 + 슬롯목록 표시, map-msg="열림: 로컬 파일".
  5. 깨진/형태불량 JSON 선택 → map-msg="열기 실패: ..." (화면 유지).
  6. 열기 대화상자 취소 → 무동작.
  7. 폴백 경로: Firefox/Safari(비Chromium) → 저장은 다운로드 폴더로 내려받기, 열기는 `<input type=file>` 대화상자.

---

## 8. 리스크 / 하위호환

- **File System Access API 지원범위**: Chromium(Chrome/Edge)만. `showSaveFilePicker`/`showOpenFilePicker`는 **보안 컨텍스트(https 또는 localhost)** 필요. dev는 localhost이므로 OK. 비지원 브라우저는 폴백 경로로 자동 강등(기능 유지, UX만 차이).
- **폴백 저장의 한계**: `<a download>`는 저장 폴더 지정 불가(브라우저 기본 다운로드 폴더), 파일명만 제안. 수용(리더 확정 폴백).
- **취소 UX**: showSaveFilePicker/showOpenFilePicker 취소는 `AbortError` → 무시. input[type=file] 취소는 이벤트 없음 → 무동작.
- **하위호환**: `state.mapping`(SetupArtifact) shape·기존 렌더/편집 로직 불변. 서버 REST/자동 스냅샷 불변(뷰어만 로컬 경로 사용). 로컬 저장 파일은 순수 SetupArtifact JSON이라 서버 `save/` 파일 및 `data/setup_artifact.json`과 상호 호환(열기 시 동일 렌더).
- **보안**: 로컬 파일 신뢰 불가 → `parseLoadedArtifact` 최소검증으로 크래시 방지(깨진 JSON/형태불량 차단). 깊은 필드 검증은 비목표(게이트 Q3).

---

## 9. 미해결/게이트(리더 확인 요청)

- **Q1(열기 방식)**: '결과 열기'를 (A) `showOpenFilePicker` 우선 + `<input type=file>` 폴백(저장과 대칭) 로 갈지, (B) `<input type=file>` 단일(모든 브라우저 지원·최소·단순, 기능탐지 불필요)로 갈지. **설계자 권고: 저장은 A 필요(파일명 입력 대화상자는 showSaveFilePicker만 제공), 열기는 (B)로도 네이티브 대화상자가 충분** — 최소·단순 원칙상 열기=B 권고. 기본안은 A로 대칭 배치했으니 리더가 B 선호 시 §3.2 열기 헬퍼를 input 단일로 축소.
- **Q2(모달 완전 제거 vs 재활용)**: `#open-result-modal`은 서버 목록 전용이라 제거안으로 설계함. 만약 향후 서버 `save/` 목록 열기도 병행 보존(로컬+서버 둘 다)을 원하면 모달을 남겨야 함 → 현재는 "로컬로 대체" 확정으로 간주해 제거. 이견 시 게이트.
- **Q3(검증 깊이)**: `parseLoadedArtifact`를 최소형태(3배열)만 검증. 슬롯/ROI 깊은검증까지 원하면 범위 확대(추가 함수·테스트 필요). 현재는 최소로 확정.

---

## 10. 변경 파일 체크리스트(구현자용)

- [ ] `web/core.js` — `parseLoadedArtifact`, `defaultResultFilename` 추가
- [ ] `web/core.d.ts` — 두 함수 선언 추가
- [ ] `web/app.js` — import 2개 추가 / `saveJsonToFile`·`pickAndReadJsonFile`·`applyLoadedMapping` 추가 / `saveResult`·`openResult` 재작성 / `renderSaveList`·`openSaved` 삭제 / `open-result-close` 배선 삭제
- [ ] `web/index.html` — `#open-result-modal` 삭제 / `#result-save`·`#result-open` title 갱신
- [ ] `test/parseLoadedArtifact.test.ts` — 신규 vitest
- [ ] (검증) SettingAgent vitest 무회귀 + 신규 그린 / core.d.ts typecheck 0오류
- [ ] (문서) 서버 `/capture/*` 3라우트 "뷰어 미사용화"·`SaveStore` finalize 자동저장 잔존 명시
