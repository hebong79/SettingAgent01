# 02 구현 변경 내역 — 주차면(파일 ROI) **신규 그리기** 도구

작성: 2026-07-28 / 구현자(developer)
입력: `_workspace/01_architect_plan.md` + `_workspace/00_leader_context.md`(리더 결정 2026-07-28)

**검증 상태**: `npx tsc --noEmit` **0 에러** · `npx vitest run` **256 파일 / 3047 테스트 전량 green**
(변경 전 3005 → 신규 42 추가). `node --check web/app.js` · `node --check web/placeDraw.js` 문법 통과.

---

## 1. 파일별 변경

| 파일 | 구분 | 변경 요지 |
|---|---|---|
| `src/ground/groundModel.ts` | 수정(승인 1) | `MIN_EDGE_PX`/`MIN_AREA_PX` 에 **`export` 키워드만** 추가 + 주석 1줄. **값·로직 0 변경** |
| `src/ground/quadDiag.ts` | **신규** | quad 거부 **사유** 산출(`diagnoseQuad`). 판정은 `isUsableQuad` 위임 |
| `src/capture/placeRoi.ts` | 수정 | `PlaceRoiSkeleton` · `applyPlaceRoiUpdateEx` 추가. 기존 `applyPlaceRoiUpdate` 는 **래퍼로 보존** |
| `src/api/captureRoutes.ts` | 수정 | PUT 스키마 `create` 추가 · ENOENT+create 분기 · `mkdir` · 응답에 `applied`/`issues` · `POST /capture/place-roi/validate` 신설 |
| `web/placeDraw.js` | **신규** | 그리기 상태머신·idx 부여·정점 이동(순수, DOM 0, throw 0) |
| `web/placeDraw.d.ts` | **신규** | 위 모듈의 타입 선언(`core.d.ts` 관례) |
| `web/app.js` | 수정 | state 2필드 · mousedown 1블록 prepend · placeVertex 분기 · mousemove/mouseup 각 1블록 · 커서추적 리스너 · keydown 1핸들러 · 미리보기 렌더 1함수 · 그리기 컨트롤러 4함수 · `savePlaceRoi` 확장 · `loadPlaceRoi` 1줄 · `renderSlotList` 조건(R3) · gg 게이트/실패 문구 · 버튼 결선 |
| `web/index.html` | 수정 | `#place-draw` 버튼 · `#place-edit-vertex` 체크박스 · 거짓 서술 정정 |
| `web/app.css` | 수정 | `#overlay.place-drawing { cursor: crosshair; }` 1블록 |
| `test/placeDraw.test.ts` | **신규** | 순수 로직 11 케이스 |
| `test/placeRoiCreate.test.ts` | **신규** | `create`/`applied` 라우트 7 케이스 |
| `test/placeRoiValidate.test.ts` | **신규** | validate 라우트 + 임계값 봉인 10 케이스 |
| `test/placeDrawWiring.test.ts` | **신규** | 결선·회귀 0 구조 소스텍스트 봉인 14 케이스 |
| `test/captureRoutesShape.test.ts` | 수정 | 신규 라우트 1줄 등록(기존 게이트가 신규 라우트 등록을 강제) |
| `test/viewerPtzSyncCoverage.test.ts` | 수정 | 신규 라우트 1줄 분류(동상) |

**무변경 확인**: `project.ts` · `ground/types.ts` · `floorRoi.ts` · **`web/core.js`** · `Finalizer.ts` ·
`SqliteStore.ts` · `roiDbLoad.ts` — 한 글자도 건드리지 않았다.
(`web/core.js` 의 `hitTestQuadVertex`/`moveQuadVertex` 는 **import 재사용**만.)

---

## 2. 신규 타입·함수 시그니처

### 서버

```ts
// src/ground/quadDiag.ts
export interface QuadDiag {
  ok: boolean;                 // ← 오직 isUsableQuad(quad) 그대로. 이 파일은 판정을 만들지 않는다.
  reasons: string[];           // ok===false 일 때만 채워지는 사용자 문장.
  metrics: { minEdgePx: number; areaPx2: number; convex: boolean };
}
export function diagnoseQuad(quad: PixelQuad): QuadDiag;

// src/capture/placeRoi.ts
export interface PlaceRoiSkeleton {
  imageWidth: number; imageHeight: number;
  pan?: number; tilt?: number; zoom?: number;   // ★ 없으면 L3 부트스트랩이 "PTZ 미상" 으로 실패
}
export function applyPlaceRoiUpdateEx(
  json: unknown,
  update: { camId: unknown; presetIdx: unknown; spaces: PlaceRoiSpace[]; create?: PlaceRoiSkeleton },
): { json: unknown; applied: boolean; issues: string[] };
export function applyPlaceRoiUpdate(json, update): unknown;   // 기존 계약 보존 래퍼
```

### REST (가산 — 기존 필드·상태코드 불변)

```
PUT  /capture/place-roi
  body  : { camId, presetIdx, spaces, create?: { imageWidth, imageHeight, pan?, tilt?, zoom? } }
  resp  : { ok: true, spaceCount, applied, issues }        ← applied/issues 가 가산
  404   : placeRoiFile 미설정 / (파일 ENOENT **이면서 create 없음**)   ← 기존 계약 그대로

POST /capture/place-roi/validate     (read-only — 파일을 읽기만 하고 **쓰지 않는다**)
  body  : { camId, presetIdx, quad:[{x,y}×4](정규화), imageWidth?, imageHeight? }
  resp  : { ok, reasons[], metrics{ minEdgePx, areaPx2, convex } }
  W/H 우선순위: PtzCamRoi.json 의 해당 cam → body → 둘 다 없으면 ok:false + "이미지 크기 미상"
```

### 프런트 (`web/placeDraw.js` — 전부 순수·불변·throw 금지)

```js
beginPlaceDraw(key)                    → { key, points: [] }
addPlaceDrawPoint(draw, pt)            → { draw, full }        // 4점 초과는 무시
undoPlaceDrawPoint(draw)               → draw                  // 0개면 그대로
nextPlaceIdx(placeRoi)                 → 전체 면 수 + 1        // null/빈 → 1
appendPlaceSpace(placeRoi, key, points)→ { placeRoi, idx }     // ★ idx 를 인자로 받지 않는다
placeQuadOf(placeRoi, key, idx)        → points[] | null
movePlaceVertex(placeRoi, key, idx, vertexIndex, dx, dy) → placeRoi
```

### `web/app.js` state 추가 2필드

```js
placeDraw: null,             // { key, points:[{x,y}...] } — 그리는 중에만 non-null
placeRoiFileMissing: false,  // GET 이 404 였다(신규 주차장) → 저장 시 create 첨부
```
(설계서의 `placeDrawMsg` 는 만들지 않았다 — 기존 `#place-msg`/`setPlaceMsg` 로 충분해 상태 필드가 불필요했다.)

---

## 3. 리더 지시별 구현 위치

| 지시 | 구현 |
|---|---|
| **승인 1** export 만 | `groundModel.ts:29,31`. 값 불변은 `placeRoiValidate.test.ts` 하단 "임계값 봉인" 2케이스로 고정(8/400 상수 + 경계 19.99/20.01 갈림) |
| **승인 2** R3 | `renderSlotList` 의 `fileMode` 에 `|| placeSpaceCount() > 0` 추가 → artifact 가 있어도 파일 ROI 가 있으면 평면 목록. 오버레이(`drawFileFloorRoi`)가 이미 mapping 무관하게 파일 ROI 를 그리고 있었으므로 목록이 그 소스에 맞춰진 것 |
| **승인 3 / F-1** PTZ 필수 | `savePlaceRoi` 가 `findPresetPtz(state.cameras, cam, preset) ?? state.ptz`(뷰어 현재 PTZ)를 `create` 에 넣는다. 생성 JSON 에 pan/tilt/zoom 이 들어감을 `placeRoiCreate.test.ts` T2 가 봉인 |
| **승인 3 / F-2** 크기 실측 | `frame.naturalWidth/naturalHeight` 만 사용. 0 이면 **저장 중단** + `라이브 프레임을 먼저 시작하세요(이미지 크기 미상 — 1920×1080 을 추측하지 않습니다)`. 1920/1080 리터럴은 프런트에 없다 |
| **F-3** 거짓 성공 제거 | `applyPlaceRoiUpdateEx` 의 `applied` + 라우트 응답. 프런트는 `data.applied === false` 면 성공 문구 대신 `저장 안 됨(...)`. 테스트 T4 |
| **F-5** 가드 위치 | placeVertex 분기를 `if (state.roiHidden || !state.mapping) return;` **위**에, mousemove 처리를 `(state.mapping.slots ?? [])` **이전 return** 으로. `placeDrawWiring.test.ts` T2/T3 봉인 |
| **F-6** 거짓 서술 | `app.js:1892` → "수동 경로('면 그리기' — 캔버스 4점, placeDraw.js)와는 가산 관계다", `index.html` → "면 그리기(캔버스 4점)로 한 면씩 직접 그린다". 옛 문장이 사라졌음을 wiring T 마지막 케이스가 봉인 |
| **R2 한계 안내** | `ggPreview` 실패 문구에 `· 같은 카메라의 다른 프리셋에도 주차면을 1개 그린 뒤 저장하고 다시 시도하세요(초점 추정에 프리셋 2개 이상이 필요할 수 있습니다)` 를 **항상** 덧붙인다. 실패는 그대로 노출 |
| **저장은 명시 트리거** | `placeDrawClick` 본문에 `savePlaceRoi`·`'PUT'` 문자열이 **없다**(wiring T6). 커밋은 `markPlaceDirty` 까지 |
| **idx 반드시 부여** | ① `appendPlaceSpace` 가 idx 를 인자로 받지 않음 ② `savePlaceRoi` 가 `Number.isInteger(sp?.idx)` 아니면 **PUT 자체를 안 보냄** ③ 테스트 T3 |
| **회귀 0** | mousedown 첫 문장이 `if (state.placeDraw) { placeDrawClick(e); return; }` 단 1줄(wiring T1). 정점편집은 기본 OFF 체크박스 뒤(T3-b/T5) |

---

## 4. 계획서와 달라진 점 (전부 의도적, 사유 포함)

1. **`state.placeDrawMsg` 미도입** — 기존 `#place-msg` + `setPlaceMsg` 로 충분. 쓰이지 않을 state 필드를 만들지 않았다.
2. **`applyPlaceRoiUpdateEx` 의 `cameras` 비배열 처리** — 계획서는 언급이 없으나, 기존 `applyPlaceRoiUpdate` 가
   `cameras` 비배열을 `[]` 로 **정규화해 반환**하고 있었다. 조기 return 으로 바꾸면 그게 회귀이므로 **기존 거동을 그대로 복제**했다.
3. **`mkdir` 호출 조건** — `create` 가 있을 때만 `mkdir(dirname, {recursive:true})`. 항상 mkdir 하면
   "상위 디렉터리 부재 → 500" 을 기대하는 기존 경로의 의미가 바뀔 수 있어 신규 경로에만 국한했다.
4. **`POST .../validate` 의 `presetIdx`** — 계획서 계약대로 필수로 받되, **현재 서버에서 사용하지 않는다**
   (W/H 는 카메라 단위 값이라 preset 이 필요 없다). 계약 안정성을 위해 남겼음을 명시한다.
5. **프리셋 전환 시 그리기 취소** — 계획서에 없던 1블록(`placeDrawClick` 첫 가드). 그리는 도중 프리셋이 바뀌면
   서로 다른 화면의 좌표가 한 면에 섞인다. 조용히 이어붙이지 않고 취소 + 사유 표시로 갔다.
6. **저장 후 재로딩 문구** — 재로딩 중 `normalizeGlobalIdx` 가 번호를 재부여하면(=`placeRoiDirty`) 그 경고를
   완료 문구로 덮지 않는다(경고 은폐 방지).
7. **`ggPreview` 에 미저장 게이트 추가** — 계획서는 `renderGgSelectionInfo` 문구만 언급했으나, 문구는 덮일 수
   있어 **버튼 동작 자체**에도 dirty 가드를 넣었다(서버는 파일을 읽는다는 사실이 동작으로 드러난다).

---

## 5. 미완 · 미검증 (했다고 쓰지 않는다)

- **브라우저 실렌더 미검증 (최우선)** — 이번 작업의 본질은 캔버스 상호작용인데, 검증은 전부
  순수함수 테스트 + **소스 텍스트 봉인**이다. "코드가 그 자리에 있다" 까지만 증명했고
  **"화면에 보이는가 · 클릭이 원하는 지점에 찍히는가" 는 증명하지 않았다.** Stage 5(E1~E5) 육안 확인 필수.
- **Loop 4(L3 연결) 종단 미검증** — `ggRefSpace` 성립 조건은 코드로 확인했으나, 새로 그린 1면으로
  `POST /capture/ground-grid/bootstrap` 이 실제로 성공하는지는 **실행해 보지 않았다**.
  R2(단일 quad `focalFromVPs` f²≤0 실패) 때문에 **실패할 수 있으며 이번 범위로 해결 불가**다.
- **R1 미검증** — `frame.naturalWidth` 가 원본 해상도인지 스트림 다운스케일 크기인지 **실측 대조 안 했다**.
  다르면 저장되는 `imageWidth` 가 실제와 어긋난다(종횡비가 같으면 지면모델은 스케일 불변이라 성립하지만, 확인 전엔 단정 불가).
- **`validate` 라우트의 정규화 왕복 오차** — 교차일치 200케이스는 px→정규화→px 왕복 후 비교라
  임계값 **정확히 경계**에 놓인 quad 에서는 부동소수 차이로 갈릴 수 있다(고정 시드에서 200/200 일치했으나
  임의 시드에 대한 보장은 아니다).
- **다중 프리셋 동시 저장(R5)** — `savePlaceRoi` 는 기존대로 전 프리셋 순차 PUT 이라 다른 프리셋의 미저장
  편집도 함께 확정된다. 기존 동작이라 유지했다(바꾸면 그게 회귀).
- **데드코드 보고(삭제 안 함)** — `hitTestFloorVertex`/`floorVertex` 분기는 `!FLOOR_ROI_USE_LLM`(상수 false)
  가드 때문에 **항상 null → 도달 불가**다. CLAUDE.md §3 에 따라 존재만 보고하고 손대지 않았다.

---

## 6. 검증 로그 (원문 수치)

```
npx tsc --noEmit        → 출력 없음(0 에러)
node --check web/app.js         → OK
node --check web/placeDraw.js   → OK
npx vitest run          → Test Files 256 passed (256) / Tests 3047 passed (3047) / Duration 15.38s
  신규 파일별: placeDraw 11 · placeRoiCreate 7 · placeRoiValidate 10 · placeDrawWiring 14 = 42
  기존 회귀: placeRoiUpdate 9 · placeRoiRoutes 3 · groundGridPanelUi 18 · placeGlobalIdx 36 · groundGridRoutes 10 전부 무수정 green
```

---

# QA 수정 라운드

입력: `_workspace/03_qa_report.md`(검증자, 2026-07-28) · 조율자 지시
**검증 상태**: `npx tsc --noEmit` **0 에러** · `npx vitest run` **256 파일 / 3052 테스트 green**
(수정 전 3047 → 신규 5 추가) · **L3 골든 해시 `test/groundGrid.test.ts` 13/13 green**
`data/Place01/PtzCamRoi.json` mtime `2026-07-27 23:40:57.287637100` — **이번 라운드에서도 무접촉**(읽기만).

## D-1 (중) 파일 존재 + 대상 cam/preset 부재 → 저장 영구 불가 — **수정 완료**

### 원인
`create` 첨부 조건이 `state.placeRoiFileMissing`(GET 404) **하나뿐**이었다. 파일이 존재하면 이 값이 항상
`false` 라, 파일에 없는 cam/preset(빈 상태 ②: 주차면 0개 · `data/Place01` 의 cam2:p3 같은 신규 프리셋)에는
골격이 영원히 안 붙었다.

### 수정 (`web/app.js`)
판정 근거를 **404 하나에서 "파일에 그 키가 실재하는가" 로 옮겼다.**

```js
placeRoiFileKeys: new Set(),   // state 신규 — 파일에서 실제로 로드된 cam:preset 키 스냅샷

// loadPlaceRoi(): 파일 응답을 정규화한 직후 스냅샷을 갱신(404 면 빈 Set).
state.placeRoiFileKeys = new Set(Object.keys(norm.placeRoi));

function needsPlaceSkeleton(key) {          // 골격 필요 판정
  return state.placeRoiFileMissing || !state.placeRoiFileKeys.has(key);
}
function buildPlaceSkeleton(cam, preset) {  // 크기 미상이면 null(= 저장 거부)
  const w = frame.naturalWidth, h = frame.naturalHeight;
  if (!(w > 0 && h > 0)) return null;
  const ptz = findPresetPtz(state.cameras, cam, preset) ?? state.ptz;
  ... pan/tilt 는 유한할 때, zoom 은 **양수일 때만** 넣는다(D-5)
}
```
추가로 **안전망 1회 재시도**: 골격 없이 보낸 요청이 `applied:false` 로 오면 골격을 만들어 **딱 한 번** 재시도한다
(루프 없음 — `while` 부재를 테스트로 봉인). 사용자 추가 조작 0.

**회귀 처리(QA 가 지적한 위험)**: 골격은 `needsPlaceSkeleton(key)` 가 참일 때만 만든다. **파일에서 로드된 키에는
붙지 않으므로**, 기존 저장 경로(자동보정·목록 편집)에 "라이브 미시작 → 저장 거부" 라는 새 실패 조건이 생기지 않는다.
F-1(PTZ)·F-2(naturalWidth, 0이면 거부)는 `buildPlaceSkeleton` 한 곳에 모여 있어 **모든 골격 경로에 동일 적용**된다.

### ★ 실행 원문 — "파일 존재 + 대상 cam/preset 없음" 시나리오
임시 디렉터리에 `{"cameras":[]}` 를 쓰고 in-process 서버(`app.inject`)로 실행. 임시 러너는 실행 후 삭제.

```
[SCN-0] GET status = 200 body = {"cameras":[]}          ← 파일은 있다(404 아님) → 구 로직은 create 미첨부

[SCN-1 create 없음]  200 {"ok":true,"spaceCount":1,"appliedCount":0,"applied":false,
                          "issues":["cam1 preset1 대상 없음 — 적용하지 않음"]}
[SCN-1 파일] { "cameras": [] }                           ← 아무것도 안 들어간다(QA 재현과 동일)

[SCN-2 create 첨부]  200 {"ok":true,"spaceCount":1,"appliedCount":1,"applied":true,
                          "issues":["cam1 신규 생성(1920x1080)","cam1 preset1 신규 생성"]}
[SCN-2 파일]
{
  "cameras": [ { "camera": { "cam_id": 1, "imageWidth": 1920, "imageHeight": 1080 },
    "presets": [ { "preset_idx": 1, "pan": 19.8, "tilt": 8.7, "zoom": 1.69341,
      "parking_spaces": [ { "idx": 1, "points": [ [45.23106, 725.41486], [19.57924, 619.3585],
                                                  [287.8918, 603.92444], [364.64917, 703.28955] ] } ] } ] } ]
}
```
⇒ **`applied:true` · 파일에 실제로 기록됨 · PTZ 3종 기록됨.**

```
[SCN-4 cam1:p3]  200 {"ok":true,"spaceCount":1,"appliedCount":1,"applied":true,
                      "issues":["cam1 preset3 신규 생성"]}      ← 기존 카메라 + 파일에 없는 프리셋도 해소
```

### Loop 4 종단 재확인 (같은 파일로)
```
[SCN-3 bootstrap] 200 {"ok":true,"constants":{"camIdx":1,"imgW":1920,"imgH":1080,
  "d":4.95001296446665,"fovBaseV":34.63497772149298,"rollDeg":0,"fromPresetIdx":1,
  "bootstrapConf":0.46933580436901506, "issues":["f 공동추정 표본 1개 …","부트스트랩 표본 = 주차면 1개 …"]},
  "grid":{"thetaDeg":89.99990305324519,"colPitchM":2.5,"rowPitchM":5,"cols":7,"rows":1,
  "slotIdByCell":{"0:0":1,…,"0:6":7}}, "presets":[{"presetIdx":1,"generated":7,"fileCount":1,"matched":1,…
```
⇒ **빈 파일 → 첫 면 저장 → 부트스트랩 성공, d = 4.95001296446665**(QA·리더 실측과 **완전 일치**).
대조 측정도 함께 남긴다: 같은 프리셋 면 수 1→7 전부 `ok=true` 동일 d, `data/Place01` 전문 복사본도 `ok=true` 동일 d.

⚠️ **자기 정정**: 이 시나리오를 처음 돌렸을 때 전부 `ok:false`(f²≤0)였다. 원인은 **내 러너가 `ground` 설정에
`minDepthEdgePx` 등을 안 넣은 것**이었고 제품 결함이 아니었다. 설정을 실제 값(`minDepthEdgePx:250` 등)으로
맞추자 위 결과가 나왔다. 잘못된 중간 관측을 근거로 R2 를 확대 주장하지 않기 위해 경위를 남긴다.

### 봉인 테스트
- `test/placeRoiCreate.test.ts` — `QA D-1`(파일 존재+대상 부재: create 없음 `applied:false`/파일 무변경 → create 첨부 `applied:true`+파일 반영, 이어서 cam1:p3 도 성공)
- `test/placeDrawWiring.test.ts` — `QA D-1`(조건이 404 하나가 아님 · 1회 재시도 · `while` 부재 · 파일 로드 키에는 미첨부)

## D-2 (경) R3 부작용 — artifact 슬롯 목록 소실 — **수정 완료(병기)**

파일 평면 목록이 artifact 슬롯 목록을 **대체하지 않도록** 두 목록을 `#slot-list` 에 **병기**했다.
- 기존 mapping 렌더 코드를 `renderArtifactSlotRows(box, withHeader)` 로 **추출**(내용·`selectSlot` 클릭 동작 원문 유지, 이중구현 0).
- 파일 목록 분기 끝에서 `if (state.mapping && !state.roiHidden) renderArtifactSlotRows(box, true)` — 구분 헤더
  `— 산출물 슬롯(cam1:1) N개 —` 뒤에 이어 그린다. 슬롯이 0개면 헤더도 안 그린다.
- 기존 분기는 `renderArtifactSlotRows(box, false)` 로 같은 함수를 쓴다.
⇒ **artifact 슬롯 선택 워크플로가 목록에서 복구**된다. 봉인: `placeDrawWiring.test.ts` `QA D-2`.

## D-3 (경) 거짓 주석 — **정정 완료**
`"파일을 읽지도 쓰지도 않는다"` → **`"읽기 전용 — 파일을 쓰지 않는다(W/H 조회를 위해 PtzCamRoi.json 을 읽기는 한다)"`**.
같은 표현을 쓰던 4곳 전부 정정: `captureRoutes.ts` 라우트 주석·스키마 주석, `web/app.js:validatePlaceQuad` JSDoc,
`test/placeRoiValidate.test.ts` 헤더, `test/viewerPtzSyncCoverage.test.ts` 분류 문자열.
`grep -rn "파일 IO 0|읽지도 쓰지도" src/ test/ web/` → 관련 잔존 0건.

## D-4 (경) `spaceCount` 착시 — **응답에 `appliedCount` 추가**
`spaceCount`(요청 수)는 하위호환으로 **그대로 두고**, 실제 반영 수 `appliedCount` 를 추가했다.
```
create 없음: {"ok":true,"spaceCount":1,"appliedCount":0,"applied":false, …}
create 첨부: {"ok":true,"spaceCount":1,"appliedCount":1,"applied":true, …}
```
봉인: `placeRoiCreate.test.ts` `QA D-4`.

## D-5 (정보) `create.zoom` 400 — **회피 + 사유 노출**
`buildPlaceSkeleton` 이 `Number.isFinite(zoom) && zoom > 0` 일 때만 `zoom` 을 넣는다 → **저장 전체가 400 으로
죽지 않는다.** 대신 그 프리셋은 부트스트랩이 불가능하므로 **숨기지 않고** 저장 완료 문구에 덧붙인다:
`⚠ cam1:2 은 zoom 미상으로 기록되지 않았습니다 — 지면격자 미리보기가 실패합니다(프리셋 PTZ 확인)`.
`pan`/`tilt` 도 유한할 때만 넣는다. 봉인: `placeDrawWiring.test.ts` `QA D-5`.

## 이번 라운드에서 **못 한 것**
- **브라우저 실렌더 — 여전히 미검증.** D-2 의 병기 목록도 **소스로만 확인**했고 화면으로 보지 않았다.
  구분 헤더가 `.slot-empty` 클래스를 재사용하므로 시각적으로 구분이 약할 수 있다 — 육안 확인 시 확인 대상.
- **`frame.naturalWidth` 실측 대조** — 그대로 미실측(QA §6-2 로 SettingAgent 내 다운스케일 없음까지만 좁혀짐).
- **실카/Unity 라이브 종단** — 전부 in-process(`app.inject`)다. 브라우저에서 `savePlaceRoi` 가 실제로
  골격을 붙여 보내는지는 **코드 경로로만** 확인했다(서버 쪽 응답은 위 원문으로 실증).
- **R2 근본 해결 아님** — 이번 시나리오에서는 1면으로 성공했지만, 이는 이 quad·PTZ 조합에서의 결과다.
  다른 형상에서 f²≤0 로 실패할 가능성은 남으며 이번 범위로 해결하지 않았다(UI 행동 지시만 제공).
