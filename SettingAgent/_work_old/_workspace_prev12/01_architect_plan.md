# 01. 설계 계획 — 정밀수집 결과 "저장/열기" 기능

작성: 설계자(architect) · 대상: SettingAgent · 원칙: 최소·외과적 변경(요청 이상 기능 금지)

---

## 0. 근거(읽은 파일과 확인 사실)

- `src/api/captureRoutes.ts` — `/capture/*` 얇은 진입점. `finalize` 라우트는 `deps.finalizer.finalize(runId)` 호출 후 `{ok, slots, globalCount}` 반환. 좌표/집계 로직 없음.
- `src/api/server.ts` — `registerCaptureRoutes`는 `captureJob && finalizer && sqlite && capture` 주입 시에만 등록(가산). `saveMappingHandler(repo, body)`가 `SetupArtifactSchema`(zod) + `validateCoverage`로 검증 후 `repo.saveArtifact`. `/mapping`(GET/PUT), `/viewer/api/mapping`(GET/PUT)가 이 핸들러 공유.
- `src/capture/Finalizer.ts` — `finalize(runId)`가 집계→(LLM)→`SetupArtifact` 조립→`repo.saveArtifact(artifact)` + `store.insertArtifactSnapshot`. **저장 대상 데이터 = 이 `artifact`(= setup_artifact.json 내용)**.
- `src/store/Repository.ts` — `setup_artifact.json` 단일 파일 read/write 담당. 생성자 `new Repository(dataDir)`, `saveArtifact/loadArtifact/path`. plate rect→quad 승격 로직 보유.
- `src/domain/types.ts` — `SetupArtifact = { presets, slots, globalIndex, createdAt, warnings?, report? }`.
- `web/app.js` — `state.roiHidden`(기본 `false`), `clearRoiDisplay()`(표시만 끔), `capStart()`가 `clearRoiDisplay()` 호출(#6), `capFinalize()`가 `roiHidden=false`+`loadMapping()`로 결과 재표시. **`init()`이 `loadMapping()` 후 `drawRoiOverlay()` → 페이지 로드 시 기존 setup_artifact 자동 출력(요구사항 5의 현행 동작)**. `downloadArtifact()`(분석 탭 JSON 내려받기, 별개).
- `web/core.js` — 순수 렌더/편집 로직(`drawRoiOverlay`는 app.js 소유). 파일 IO·fetch 없음(vitest 직접 import 대상).
- `web/index.html` — `roi-edit-bar` 툴바(삭제/저장 버튼), `roi-toggles`(표시 초기화 버튼), 모달 패턴(`cap-result-modal` 등). 정밀수집 버튼은 `precise-box`(시작/정지/최종화).
- `data/setup_artifact.json` — 저장 대상 실물. `presets[].coveredSlotIds`, `slots[].{roiByPreset, plateRoiByPreset, floorRoiByPreset}`, `globalIndex[]`.
- `config/tools.config.json` + `toolsConfig.ts` — `store: { dataDir, captureDir }`. 경로는 cwd 상대. 신규 `saveDir` 추가 지점.
- `src/index.ts` — 조립 지점. `repo`, `finalizer`, `buildServer(...)` 결선.

**결론:** "저장 대상 = 현재 화면에 반영된 SetupArtifact(setup_artifact 형태)". 파일 IO는 얇은 라우트가 아니라 **신규 `SaveStore` 클래스**(Repository 미러)가 소유. 라우트는 위임만.

---

## 1. 요구사항 해석 (모호점은 해석안 + 대안, 조용히 결정하지 않음)

### 요구사항 매핑
| # | 원문 요지 | 해석 |
|---|-----------|------|
| 1 | finalize 끝나면 JSON을 `save/`에 저장 | finalize 완료 시 **자동으로 타임스탬프 이름**으로 `save/`에 스냅샷 저장 |
| 2 | 수정 후에도 저장 가능 | "결과 저장"이 **현재 화면 상태(편집 반영된 `state.mapping`)**를 저장 |
| 3 | "결과 저장" 버튼 → 이름 입력 대화창 | 모달로 이름 입력 → `save/{name}.json` |
| 4 | "결과 열기" 버튼 → 저장 결과를 화면 출력 | `save/` 목록 모달 → 선택 → 오버레이(3종 ROI) 표시 |
| 5 | 시작 시 자동 출력 금지, 열기 시에만 출력 | 페이지 로드 시 기존 setup_artifact 미표시. finalize 또는 "열기"로만 표시 |

### ⚠ 결정 필요 A — finalize 자동저장 방식 (요구사항 1 vs 3 충돌 해소)
- **해석안 A (권장):** finalize 완료 시 서버가 **자동으로 `capture_{타임스탬프}.json`** 저장(요구사항 1). 사용자는 추가로 "결과 저장" 버튼으로 **이름 지정 저장**도 가능(요구사항 3). → 두 경로 공존.
- 대안 B: finalize는 자동저장하지 않고 "결과 저장" 버튼으로만 저장. → 요구사항 1의 "끝나면 저장"과 불일치(권장 안 함).
- 대안 C: finalize 완료 시 **곧바로 이름 입력 모달**을 띄워 사용자가 이름 지정 저장(요구사항 1+3 통합). → 매 finalize마다 모달 강제(헤드리스/자동화 흐름 방해).
- **채택 제안:** A. (리더 확인 요청 — B/C 선호 시 회신 바람.)

### ⚠ 결정 필요 B — "결과 저장" 데이터 출처 (서버 정본 vs 클라이언트 상태)
- **해석안 Y (권장):** "결과 저장"이 클라이언트 `state.mapping`(편집 반영본)을 `{name, artifact}`로 **POST**. 서버는 기존 `SetupArtifactSchema`+`validateCoverage`로 재검증 후 `save/`에 기록. → **1스텝**, "보이는 것을 그대로 저장", 편집 즉시 저장.
- 대안 X: body는 `{name}`만. 서버가 현재 `setup_artifact.json`(정본)을 복사. → 더 단순(재검증 불필요)하나 **먼저 기존 "저장"(map-save) 눌러 정본 반영 후** "결과 저장" 해야 함(2스텝). 편집 미반영 위험.
- **채택 제안:** Y. (검증 로직은 아래 §3 공유 모듈로 재사용 — 중복 없음.)

### ⚠ 결정 필요 C — 중복 파일명 정책
- 권장: **덮어쓰기**(Repository가 setup_artifact를 덮어쓰는 것과 동일 관행). 클라이언트 저장 모달은 목록(GET)으로 동일 이름 존재 시 경고 문구만 표시(차단 안 함).
- 대안: 409 Conflict 반환 후 사용자가 다른 이름. → UX 번거로움. 권장 안 함.

### 가정 (명시)
- "결과 열기"는 **`save/` 폴더의 명명된 스냅샷**을 여는 것(요구사항 4). 현재 `setup_artifact.json`(정본)을 여는 것이 아님.
- 요구사항 5의 "시작"은 **페이지 로드 및 정밀수집 시작(capStart)**. 분석 탭(`/mapping` 별도 조회)은 대상 아님(정본 분석 목적 유지).
- "결과 저장"이 저장하는 것은 **검수 탭 컨텍스트의 `state.mapping`**(현재 오버레이에 그려진 3종 ROI). 분석 탭의 수동 전역인덱스 편집은 기존 `an-manual-save`(PUT /mapping) 경로 유지(범위 밖).

---

## 2. 변경 대상 파일 목록 + 파일별 변경 요지

### 신규
| 파일 | 요지 |
|------|------|
| `src/store/SaveStore.ts` | **신규 클래스.** `save/` 폴더 소유. `sanitizeName(name)`, `save(name, artifact)`, `list()`, `load(name)`. Repository 미러(파일 IO만). 경로 traversal 방지·`.json` 강제. |
| `src/api/artifactSchema.ts` | **신규(추출).** `SetupArtifactSchema`(zod) + `validateArtifactBody(body)` 헬퍼를 server.ts에서 이 중립 모듈로 추출. server.ts·captureRoutes.ts가 공유(순환참조 회피). |
| `test/saveStore.test.ts` | 신규 유닛테스트. |

### 수정
| 파일 | 요지 |
|------|------|
| `src/api/captureRoutes.ts` | `CaptureRouteDeps`에 `saveStore?` 추가. `POST /capture/save`, `GET /capture/saves`, `GET /capture/saves/:name` 3개 라우트 등록(saveStore 주입 시). 라우트는 위임만. |
| `src/api/server.ts` | `SetupArtifactSchema`/`saveMappingHandler`가 `artifactSchema.ts`의 추출 함수 사용하도록 조정. `ApiDeps`에 `saveStore?` 추가 → `registerCaptureRoutes(...)` 호출에 전달. |
| `src/capture/Finalizer.ts` | `FinalizerDeps`에 `saveStore?` 추가. `finalize()`에서 `repo.saveArtifact` 직후 `saveStore?.save('capture_{ts}', artifact)` 자동 스냅샷(요구사항 1). |
| `src/config/toolsConfig.ts` | `StoreSchema`에 `saveDir` 추가(`z.string().min(1)`, DEFAULT `"save"`). |
| `config/tools.config.json` | `store.saveDir: "save"` 추가. |
| `src/index.ts` | `new SaveStore(tools.store.saveDir)` 생성 → `Finalizer` deps·`buildServer` deps에 주입. |
| `web/index.html` | `roi-edit-bar`에 `#result-save`("결과 저장"), `#result-open`("결과 열기") 버튼. 저장 이름 입력 모달 `#save-name-modal`, 열기 목록 모달 `#open-result-modal` 추가. |
| `web/app.js` | `init()`에서 `loadMapping()` 제거(요구사항 5, 자동표시 금지). `saveResult()`/`openResult()`/`refreshSaveList()` 함수 + 모달 결선. |
| `test/captureRoutes.test.ts` | save/list/open 라우트 케이스 추가(기존 파일 확장). |
| Finalizer 테스트(`test/checkpointFinalizer.test.ts` 등) | finalize 자동저장 케이스 추가. |
| `.gitignore` | `save/` 무시 추가(현재 상태 확인 후). |

> core.js는 **변경 불필요**(파일명 검증 권위는 서버 SaveStore). 클라이언트 저장 모달은 `.trim()`·빈값 방지만. (선택: 순수 `safeSaveName`를 core.js에 추가하고 테스트 — 최소 원칙상 보류, 리더 판단.)

---

## 3. 신규 REST 엔드포인트 계약

경로는 기존 capture 라우트와 동일하게 **절대경로 `/capture/*`**(app.js가 `/capture/status` 등을 직접 호출하는 관행 준수, `/viewer/api` 프리픽스 아님). saveStore 미주입 시 미등록(가산).

### (a) POST /capture/save — 결과 저장
- 요청 body: `{ "name": string, "artifact": SetupArtifact }`
- 검증: `name` 안전화 통과 + `validateArtifactBody(artifact)`(SetupArtifactSchema + validateCoverage).
- 200: `{ ok: true, name: "<safeName>", slots: number, globalCount: number }`
- 400: `{ error: "invalid name" }` | `{ error: "invalid artifact", detail }` | `{ error: "coverage mismatch", missing, extra }`
- (저장 파일: `save/{safeName}.json`, 덮어쓰기)

### (b) GET /capture/saves — 저장 목록
- 200: `{ saves: [{ name: string, savedAt: string(ISO, mtime) }] }` (mtime 내림차순)
- 폴더 없거나 비면: `{ saves: [] }`

### (c) GET /capture/saves/:name — 특정 결과 열기
- `:name`은 클라이언트가 `encodeURIComponent`, 서버는 안전화 검증.
- 200: `SetupArtifact`(GET /mapping과 동일 shape → 클라이언트 재사용)
- 400: `{ error: "invalid name" }`
- 404: `{ error: "not found" }`

### 파일명 안전화 규칙(SaveStore.sanitizeName)
- 허용: `[A-Za-z0-9가-힣_\-]` (+ 공백→`_` 치환). 그 외 문자 제거.
- 금지/차단: 빈 문자열, `.`/`..`, 경로 구분자(`/ \`), 절대경로 → 400.
- 항상 `.json` 확장자 강제(입력에 있으면 중복 방지 후 부여).
- 결과가 빈 문자열이면 무효(400).

---

## 4. 저장 JSON 파일 스키마

`save/{name}.json` 내용 = **`SetupArtifact` 그대로**(래퍼 없음). setup_artifact.json과 동일 구조:

```json
{
  "presets":     [{ "camIdx", "presetIdx", "label", "coveredSlotIds": [], "pan?","tilt?","zoom?" }],
  "slots":       [{ "slotId", "zone",
                    "roiByPreset": { "c:p": {x,y,w,h} },
                    "plateRoiByPreset?": { "c:p": [ {x,y}×4 ] },
                    "floorRoiByPreset?": { "c:p": [ {x,y}×4~10 ] } }],
  "globalIndex": [{ "globalIdx", "slotId", "camIdx", "presetIdx" }],
  "createdAt":   "ISO8601",
  "warnings?":   [],
  "report?":     "..."
}
```

- **선정 이유:** GET /capture/saves/:name → 그대로 `state.mapping`에 주입해 기존 렌더(3종 ROI)·편집 로직 100% 재사용. 별도 변환 불필요.
- `savedAt`은 파일에 넣지 않고 파일 **mtime**에서 도출(목록 표시용). → 파일 내용은 순수 SetupArtifact 유지.
- 대안(래퍼 `{name, savedAt, artifact}`)은 열기 시 언랩 필요 + 재사용성 저하 → 채택 안 함.

---

## 5. 프론트 UI / 상태 흐름

### 버튼 배치 (index.html)
- `roi-edit-bar` 툴바(기존 삭제/저장 옆)에 추가:
  - `<button id="result-save">결과 저장</button>`
  - `<button id="result-open">결과 열기</button>`
- 신규 모달 2개(기존 `.modal` 패턴 재사용):
  - `#save-name-modal`: 텍스트 입력 `#save-name-input` + `#save-name-confirm`/`#save-name-cancel`.
  - `#open-result-modal`: 목록 컨테이너 `#open-result-list` + `#open-result-close`.

### 상태 흐름
1. **시작 시 미표시(요구사항 5):** `init()`에서 `loadMapping()` 호출 제거 → `state.mapping = null` 유지 → `drawRoiOverlay()` 가드(`!state.mapping`)로 아무것도 안 그림. `renderSlotList()`도 `!state.mapping`이면 비표시. (분석 탭은 별도 `fetchArtifact()`로 정본 조회 — 영향 없음.)
2. **결과 저장:** `#result-save` 클릭 → `state.mapping` 없으면 "표시된 결과 없음" 안내. 있으면 `#save-name-modal` 표시 → 확인 시 `POST /capture/save {name, artifact: state.mapping}` → 성공 시 `map-msg`에 "저장됨: {name}".
3. **결과 열기:** `#result-open` 클릭 → `GET /capture/saves` → `#open-result-list`에 항목(이름·저장시각) 렌더 → 항목 클릭 → `GET /capture/saves/:name` → `state.mapping = artifact; state.roiHidden=false;` → `drawRoiOverlay()` + `renderSlotList()` + `renderSelectionInfo()`. 모달 닫기.
4. **finalize:** 기존 동작 유지(`roiHidden=false` + 표시). 서버가 자동 스냅샷 저장(요구사항 1) — 클라이언트 추가 동작 불필요.
5. **편집 후 저장(요구사항 2):** floor 정점 드래그·삭제로 `state.mapping` 변경 후 `#result-save` → 편집 반영본 저장. (기존 `map-save`(PUT /mapping)와 독립 — 정본 반영은 그쪽, save/ 스냅샷은 이쪽.)

---

## 6. 단계별 구현 순서 + 검증 기준

1. **`artifactSchema.ts` 추출** → 검증: server.ts가 이를 import하고 기존 `/mapping` PUT 관련 스위트(`captureRoutes`/`roiEdit` 등) 전부 통과. (순수 리팩터 — 동작 불변.)
2. **`SaveStore` 구현** → 검증: `saveStore.test.ts`에서 sanitizeName(traversal/한글/빈값/확장자), save→load 왕복, list 정렬, 없는 이름 load=null 통과.
3. **config `saveDir` 추가** → 검증: `loadToolsConfig()`가 `store.saveDir="save"` 로드(기존 config 테스트 통과, 기본값 병합 확인).
4. **captureRoutes 3라우트 추가** → 검증: `captureRoutes.test.ts`에서 POST 200/400(name·coverage), GET 목록, GET :name 200/404 확인. saveStore 미주입 시 라우트 미등록 확인.
5. **Finalizer 자동저장** → 검증: finalize 테스트에서 saveStore 주입 시 `save/capture_*.json` 1건 생성, 미주입 시 무변화(기존 테스트 통과).
6. **index.ts 결선** → 검증: `npm run build`(tsc) 성공, 서버 기동 시 예외 없음(동작 확인 단계).
7. **index.html 버튼·모달 + app.js 결선** → 검증: 서버 기동 후 브라우저에서 (a) 페이지 로드 시 오버레이 빈 화면(요구사항 5), (b) finalize 후 표시, (c) 결과 저장→`save/`에 파일, (d) 결과 열기→오버레이 3종 ROI 표시.
8. **전체 회귀** → 검증: `npm test` 그린 + `tsc` 무오류.

---

## 7. 유닛테스트 대상 (vitest)

- **`test/saveStore.test.ts`(신규)**
  - `sanitizeName`: `../etc/passwd`, `/abs`, `a\b`, `""`, `..` → 무효/차단. `"내 결과 1"`→`내_결과_1.json`. `"x.json"`→`x.json`(중복확장자 방지).
  - `save`+`load` 왕복: 임의 SetupArtifact 저장 후 동일 객체 로드.
  - `list`: 다건 저장 → 이름·savedAt 반환, mtime 내림차순.
  - `load` 없는 이름 → null.
  - `save` 덮어쓰기: 동명 재저장 시 내용 갱신.
- **`test/captureRoutes.test.ts`(확장)** — 임시 saveDir + SaveStore로 라우트 등록.
  - POST /capture/save 유효 → 200 + 파일 존재.
  - POST 잘못된 name(traversal) → 400.
  - POST coverage 불일치 artifact → 400.
  - GET /capture/saves → 저장 항목 목록.
  - GET /capture/saves/:name → 200 artifact / 없는 이름 404 / 잘못된 name 400.
- **Finalizer 테스트(확장)** — saveStore 주입 finalize → save 파일 1건 생성 및 내용=artifact. 미주입 시 예외 없음.
- (선택) core.js 클라이언트 검증 헬퍼 추가 시 해당 순수 함수 테스트.

**동작 확인(규칙 3):** 서버 기동 → 브라우저에서 요구사항 5개 시나리오 수동 확인(문서화에 스크린 흐름 기록).

---

## 8. 영향도 분석 (기존 기능 영향)

- **setup_artifact.json / Action·DM 계약:** 스키마 불변. save/ 는 부가 스냅샷일 뿐 정본(`data/setup_artifact.json`) 경로·형식 무변경 → **하위 에이전트 영향 없음**.
- **요구사항 5 = 의도된 동작 변경:** 페이지 로드 시 기존 자동 ROI 표시가 사라짐(열기/finalize로만 표시). 기존 사용자 기대와 다름 → 문서화에 "동작 변경" 명시 필요.
- **`store.saveDir` 신규 config:** DEFAULT `"save"` 병합 → 기존 config 파일 하위호환(누락 시 기본값).
- **Finalizer 신규 optional dep(`saveStore?`):** 미주입 경로 보존 → 기존 Finalizer 테스트 무영향.
- **captureRoutes 신규 optional dep(`saveStore?`):** 미주입 시 save 라우트 미등록(가산, 기존 라우트 불변).
- **`artifactSchema.ts` 추출:** server.ts의 `SetupArtifactSchema`/검증을 이동 — 순수 리팩터. `/mapping`(GET/PUT), `/viewer/api/mapping` 동작 불변이어야 함(회귀 테스트로 보증). **순환참조 주의:** server.ts↔captureRoutes.ts가 스키마를 직접 주고받지 않고 중립 모듈에서 import(순환 회피).
- **`save/` 폴더:** 서버 최초 저장 시 `mkdirSync(recursive)`로 생성(SaveStore). `.gitignore`에 추가 권장(현재 `.gitignore` 이미 수정 상태 — 확인).
- **1-based 인덱스·ESM(.js import):** 신규 코드 전부 준수. SaveStore는 좌표 미접촉(파일 IO만) → 인덱스 규약 무관.
- **MCP 경계:** 본 기능은 **결정형 도구 영역**(파일 저장/조회, 수치·판단 없음). LLM 두뇌 미개입.

---

## 9. 리더에게 확인 요청(진행 전)

1. **결정 A** — finalize 자동저장 방식: 권장 A(자동 타임스탬프 + 버튼 이름저장 병행) 승인? (B/C 대안 있음)
2. **결정 B** — "결과 저장" 출처: 권장 Y(클라이언트 `state.mapping` POST) 승인? (X=서버 정본 복사 대안)
3. **결정 C** — 동명 파일: 권장 덮어쓰기 승인? (409 대안)
4. 요구사항 5로 인한 **페이지 로드 시 ROI 자동표시 제거**가 의도와 일치하는지 확인.

미회신 시 A/Y/덮어쓰기 + 자동표시 제거로 진행.
