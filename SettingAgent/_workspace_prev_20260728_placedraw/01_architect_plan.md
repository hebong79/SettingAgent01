# 01 설계 계획 — 주차면(파일 ROI) **신규 그리기** 도구

작성: 2026-07-28 / 설계자(architect) / 근거: 코드 직접 확인(추측 0)
입력: `_workspace/00_leader_context.md`(D-1~D-4, Loop 1~5, Requirements)

---

## 0. 리더 결정과 충돌하거나 리더가 모르는 사실 — **먼저 보고**

지난 두 라운드처럼 숨기지 않는다. 아래 6건은 전부 코드 실측이다.

### F-1 (★ 최중요) 빈 상태의 최소 골격은 `cam_id/imageWidth/imageHeight/preset_idx` **가 아니다** — `pan/tilt/zoom` 이 반드시 필요하다

`planAutoRoi`(L3 부트스트랩)는 camerapos 를 **넘기지 않는다**:

```ts
// src/ground/autoRoiPlan.ts:250
const cams = buildGroundInputs(input.placeRoiJson, []);   // ← views = 빈 배열
...
if (ref.zoom == null || ref.tilt == null || ref.pan == null) {
  issues.push(`... PTZ(pan/tilt/zoom) 미상 — 부트스트랩 불가`);
  return { plan: null, issues };
}
```

`buildGroundInputs`(groundInputs.ts:41-51)의 PTZ 우선순위는 `ROI 파일 자체의 preset 블록 > camerapos 뷰`인데,
views 가 `[]` 이므로 **PtzCamRoi.json 의 preset 블록이 유일한 PTZ 출처**다.
실데이터도 그렇다 — `data/Place01/PtzCamRoi.json` 의 preset 블록에 `pan/tilt/zoom/fov` 가 들어 있다.

⇒ 골격에 PTZ 를 안 넣으면 **저장은 되지만 Loop 4(L3 연결)가 그 자리에서 실패**한다.
최소 골격 = `cam_id · imageWidth · imageHeight` + `preset_idx · pan · tilt · zoom`.

### F-2 (★) `imageWidth/imageHeight` 의 출처가 저장소에 **없다**

- `config/camerapos.json` 실측: `cam_id/preset_id/sname/pan/tilt/zoom` 뿐 — **이미지 크기 없음**.
- `toolsConfig` 카메라 소스 스키마에도 width/height 없음(grep 0건).
- DB `camera_info.img_w/img_h` 는 `migrateToSettingDb` 가 **PtzCamRoi 에서 파생**시킨 값 → 순환 참조, 신규 주차장엔 없음.

⇒ 실측 가능한 유일한 출처는 뷰어의 `<img id="frame">`(index.html:70)의 **`naturalWidth/naturalHeight`**
(라이브/스냅샷 프레임의 실제 디코드 크기).
라이브가 안 켜져 있으면 크기를 알 수 없다 → **1920×1080 추측 금지, 저장 거부 + 사유 표시**로 간다.
리스크 R1(§8)에 실측 확인 항목으로 올린다.

### F-3 (★) `PUT /capture/place-roi` 는 빈 상태에서 **두 군데서 막힌다**

1. **파일 부재 → 404.** `captureRoutes.ts:696` `readFile` → ENOENT → `fileErrorReply(...,'PtzCamRoi.json 없음',...)`.
2. **파일이 있어도 대상 cam/preset 이 없으면 조용한 거짓 성공.**
   `applyPlaceRoiUpdate`(placeRoi.ts:133) `if (!cam || cam.cam_id !== update.camId) return camEntry;`
   → 아무것도 안 바꾼 원본을 그대로 돌려주고, 라우트는 `{ ok: true, spaceCount: N }` 을 반환한다.
   **사용자는 저장됐다고 믿고 파일엔 아무것도 없다.** 2번이 1번보다 위험하다(무증상).

### F-4 `floorVertex` 는 사실상 **죽은 분기**다 — 정점 드래그 충돌 위험 0

`hitTestFloorVertex`(app.js:1264-1266)의 첫 줄 가드에 `!FLOOR_ROI_USE_LLM` 이 있고,
`FLOOR_ROI_USE_LLM = false`(app.js:87)는 **상수**다 → 이 함수는 **항상 null** 을 반환한다.
따라서 app.js:4303 의 `floorVertex` 진입은 현재 코드에서 도달 불가다.
⇒ 리더가 최대 리스크로 본 "정점 드래그 kind 충돌"은 실제로는 존재하지 않는다.
(단 CLAUDE.md §3 에 따라 **삭제하지 않는다** — 데드코드 존재만 보고한다.)

### F-5 편집 분기 전체가 `!state.mapping` 에서 **차단**된다 — 빈 상태 설계의 결정적 제약

app.js:4275 `if (state.roiHidden || !state.mapping) return;`
신규 주차장에는 setup artifact 가 없다 → `state.mapping === null` → **이 줄 아래 전부 inert**.
⇒ 신규 그리기·정점 드래그 분기는 **반드시 이 가드보다 위**에 놓아야 한다(검출 편집 분기가 이미 그 선례다).

### F-6 주석이 거짓말을 하고 있다

`web/index.html:171` 과 `web/app.js:1892` 가 **"수동 드로잉 경로는 그대로 유지된다 / 수동 드로잉을 쓴다"** 라고 적었지만
그 경로는 저장소에 존재하지 않는다(리더 실증과 일치). 문서화 단계에서 정정 대상으로 넘긴다.

### 무변경 목표 파일에 대한 **승인 요청 1건** (§3-C)

`src/ground/groundModel.ts` 의 `MIN_EDGE_PX` / `MIN_AREA_PX` 두 상수를 `const` → `export const` 로 **가시성만** 변경 요청.
**로직 0줄·값 0 변경.** 사유: 거부 사유 문장("변이 8px 미만" 등)을 만들려면 임계값이 필요한데,
프런트/진단 모듈에서 값을 다시 적으면 그게 곧 `isUsableQuad` 재구현이다(리더 금지 사항).
거부 시 대안은 §3-C 에 적어 뒀다.

---

## 1. 상호작용 설계 — 그리기 모드를 기존 캔버스에 끼워넣는 법

### 1-1. 4점 지정 방식: **클릭 4회** 채택 (드래그 사각형 기각)

| 근거 | 클릭 4회 | 드래그 사각형 + 정점 조정 |
|---|---|---|
| 원근 형상 | 사다리꼴을 **직접** 찍는다 | 축정렬 사각형 → 4정점 **모두** 틀려 4회 재드래그 필요(총 작업량 ↑) |
| 기존 드래그 경로 | `dragState` 를 **안 쓴다** → `mousemove`/`mouseup` 공용 경로 **무변경** | 새 kind 추가 → 공용 경로 수정 → 회귀 면적 ↑ |
| 게이트 적합성 | D-1 대로 순환 순서만 지키면 `isUsableQuad` 통과 | 사각형은 항상 통과하지만 **주차면과 안 맞음**(정합의 의미 없음) |
| 취소/되돌리기 | 점 배열 `pop()` 한 줄 | 드래그 중 상태 되감기 필요 |

기존 코드가 `mousedown` 기반이므로 **`mousedown` 시점의 좌표를 채택**한다(클릭 이벤트 미사용 — 이중 결선 방지).

### 1-2. 모드 진입/이탈 — off 일 때 기존 분기가 **1바이트도 안 바뀌는** 구조

`wireOverlayEditing()` 의 `mousedown` 핸들러 **맨 앞에 단 하나의 블록**을 prepend 한다:

```js
overlay.addEventListener('mousedown', (e) => {
  // [신규] 주차면 그리기 모드 — 진행 중일 때만 클릭을 소비하고 즉시 return.
  //       state.placeDraw 가 null 이면 아래 기존 코드는 **원문 그대로** 실행된다(회귀 0의 구조적 보장).
  if (state.placeDraw) { placeDrawClick(e); return; }

  // ↓↓↓ 여기서부터 기존 코드 원문 무수정 ↓↓↓
  const clickMode = $('cal-click-mode')?.value;
  ...
```

- 모드 진입: `#place-draw` 버튼 토글(라벨 `면 그리기` ↔ `그리기 취소`).
- **배타 게이트**: 진입 시 `#cal-click-mode !== 'off'` 면 진입 거부 + 사유 표시
  (개별 센터라이징이 클릭을 최우선 소비하므로 물리적으로 공존 불가 — 조용히 이기지 않는다).
- 이탈: 4점 완성(자동 커밋) / `Esc` / 버튼 재클릭 / 탭 전환.
- 커서: `overlay.classList.toggle('place-drawing', on)` → `crosshair`(기존 `.click-centering` 선례 그대로).

### 1-3. 상태 머신

```
state.placeDraw = null                                   … off (기존 동작 100%)
  │  [면 그리기] 클릭 (cal-click-mode==='off' 확인)
  ▼
{ key:'cam:preset', points: [] }                          … 대기 — "1/4 점을 찍으세요"
  │  mousedown                    ▲ Ctrl+Z / [되돌리기] (points.pop())
  ▼                               │
{ points: [p1] } → [p1,p2] → [p1,p2,p3] ───────────────────┘   … 진행중(미리보기 렌더)
  │  4번째 mousedown
  ▼
커밋: appendPlaceSpace(state.placeRoi, key, points)        … idx = N+1 **부여 확정(D-4)**
  → state.selectedPlaceIdx = 새 idx                        … ggRefSpace() 성립(§5)
  → state.placeDraw = null, markPlaceDirty()                … 미저장 버퍼(저장은 명시적 트리거)
  → #place-edit-vertex 자동 체크                            … Loop 2 로 자연 연결
  → validatePlaceQuad() 비동기 호출                          … isUsableQuad 판정(§3)
  │  Esc / [그리기 취소] — 어느 단계에서든
  ▼
state.placeDraw = null (points 폐기, placeRoi 무변경)
```

- **미리보기(1~3점)**: 확정 점은 노란 원 + 순번, 점 사이 폴리라인, 마지막 점→커서 고무줄선(`mousemove` 를 오버레이에만
  추가 등록 — 기존 `window` mousemove 핸들러는 `if (!dragState) return;` 로 시작하므로 **간섭 0**).
- 저장은 **절대 자동으로 하지 않는다**(Requirements). 커밋은 메모리 버퍼까지만.

### 1-4. 키보드 — 기존 keydown 과의 충돌 처리

기존 핸들러(app.js:4584)는 `if (!state.selectedDetect) return;` 이라 대부분 무해하지만,
검출이 선택된 채 그리는 중이면 `Esc` 가 **둘 다** 발동한다.
⇒ 신규 keydown 핸들러를 `wire()` 안에서 **기존 것보다 먼저** 등록하고, 소비 시 `e.stopImmediatePropagation()` 한다.

| 키 | 조건 | 동작 |
|---|---|---|
| `Esc` | `state.placeDraw` 진행 중 | 그리기 취소(폐기) · 소비 |
| `Ctrl+Z` | `state.placeDraw.points.length > 0` | 마지막 점 되돌리기 · 소비 |
| 그 외 | — | 소비 안 함(기존 핸들러로 통과) |

입력 포커스 가드(`INPUT/TEXTAREA/isContentEditable`)는 기존 핸들러 관례를 그대로 복제한다.

---

## 2. 정점 미세 조정 (Loop 2) — 히트테스트 우선순위

`floorVertex` 는 도달 불가(F-4)라 충돌이 없지만, **의도치 않은 클릭 가로채기**는 여전히 회귀다.
따라서 신규 분기는 **명시적 토글 뒤**에 둔다.

- 신규 체크박스 `#place-edit-vertex`(라벨 "정점 편집", **기본 OFF**) → OFF 면 신규 분기가 첫 줄에서 return → **변화 0**.
- 그리기 커밋 직후 자동으로 ON(Loop 1 → Loop 2 흐름 연결). 사용자가 끄면 꺼진 채로 유지.

### 히트테스트 우선순위표 (`mousedown`)

| 순위 | 분기 | 조건 | 상태 |
|---|---|---|---|
| 0 | **placeDraw 점 찍기** | `state.placeDraw` | **신규** — 최상단, 소비 후 return |
| 1 | 개별 센터라이징 | `cal-click-mode !== 'off' && !ctrl` | 기존 무변경 |
| 2 | `detResize`/`detMove`/`detVertex` | 차량/번호판 레이어 + `!ctrl` + 히트 | 기존 무변경 |
| 3 | **`placeVertex`** | `#place-edit-vertex` ON **&&** `selectedPlaceIdx != null` **&&** `#roi-floor` ON **&&** `!ctrl` **&&** 정점 히트 | **신규** — ★ `if (roiHidden \|\| !mapping) return` **바로 위**(F-5) |
| 4 | (가드) `roiHidden \|\| !mapping` → return | | 기존 무변경 |
| 5 | `vpdResize`/`vpdMove` | `ctrl` + 차량 레이어 | 기존 무변경 |
| 6 | `floorVertex` | `hitTestFloorVertex != null` (**항상 null**, F-4) | 기존 무변경(데드) |
| 7 | 슬롯 선택/해제 | | 기존 무변경 |

`Ctrl` 을 제외하는 이유: Ctrl 드래그는 기존에 VPD 편집 제스처로 예약돼 있다(app.js:4277 주석) → 물리 배타 유지.

### 드래그 처리 — 공용 `mousemove`/`mouseup` 에 최소 침습

```js
// mousemove 안, 기존 det* 분기와 같은 층에 1블록 추가(그 아래 slot 조회 코드에 닿기 전에 return).
if (dragState.kind === 'placeVertex') {
  state.placeRoi = movePlaceVertex(state.placeRoi, dragState.key, dragState.idx, dragState.index, ndx, ndy);
  dragState.last = { nx, ny };
  drawRoiOverlay();
  return;              // ← 기존 `state.mapping.slots` 접근(4342)에 도달하지 않는다.
}
```

⚠️ **중요**: 기존 `mousemove` 는 4342 에서 `state.mapping.slots` 를 무가드로 읽는다.
`state.mapping` 이 null 인 신규 주차장에서 이 줄에 닿으면 **TypeError** 다.
위 `return` 이 그 방어선이므로 **반드시 det* 분기와 같은 높이(4342 이전)** 에 넣는다.

`mouseup`(4375)은 `markDirty()`(artifact 미저장 표시)를 호출한다 — placeVertex 는 artifact 가 아니라 placeRoi 편집이므로
`wasDetect` 판정과 같은 방식으로 제외하고 대신 `markPlaceDirty()` + `validatePlaceQuad()` 를 호출한다.

---

## 3. `isUsableQuad` — 재구현 없이 거부 사유를 사용자 문장으로

### 3-A. 결정: **서버 판정을 그대로 쓴다** — 신규 read-only 라우트 `POST /capture/place-roi/validate`

- D-2 가 금지한 것은 **신규 저장 경로**다. 이 라우트는 **파일을 읽지도 쓰지도 않는다**(순수 계산) → 계약 위반 아님.
- 프런트 재구현(금지) 회피 + `web/core.js` 무변경(요구 준수) 둘 다 만족한다.
- 호출 시점은 **드래그마다가 아니라** ① 4번째 점 커밋 ② 정점 드래그 `mouseup` ③ 저장 직전 — 왕복 비용 무시 가능.
- 네트워크 실패는 **강등**: 그린 면은 유지하고 "검증 실패(네트워크) — 지면격자에서 거부될 수 있음" 표시(throw 금지).

```ts
// POST /capture/place-roi/validate  (파일 IO 0)
body: { camId: number; presetIdx: number; quad: [{x,y} ×4]; imageWidth?: number; imageHeight?: number }
resp: { ok: boolean; reasons: string[]; metrics: { minEdgePx: number; areaPx2: number; convex: boolean } }
```

- `W/H` 해석 순서: PtzCamRoi.json 의 해당 cam → 없으면 body 의 `imageWidth/imageHeight` → 둘 다 없으면
  `{ ok:false, reasons:['이미지 크기 미상 — 라이브 프레임을 먼저 시작하세요'] }`. **파일이 없어도 동작해야 한다**(Loop 5).
- **`ok` 는 오직 `isUsableQuad(quadPx)` 가 정한다**(단일 원천). `reasons` 는 `ok===false` 일 때만 붙는 부가 진단이다.

### 3-B. 사용자 문장 매핑

| 판정 | 표시 문장 |
|---|---|
| 최소 변 미달 | `변이 너무 짧습니다(최단 4.2px < 8px) — 더 크게 그리세요` |
| 최소 면적 미달 | `면적이 너무 작습니다(312px² < 400px²)` |
| 볼록/자기교차 위반 | `폴리곤이 꼬였습니다(자기교차) — 네 점을 시계 또는 반시계 **한 방향**으로 찍으세요` |
| 연속 3점 공선 | `세 점이 일직선입니다 — 사다리꼴 모양이 되게 찍으세요` |
| 통과 | `사용 가능한 주차면입니다` |

점 **순서**에 대해서는 D-1 대로 아무 제약도 걸지 않는다(순환 방향만).

### 3-C. 승인 요청과 대안

- **요청안**: `groundModel.ts` 의 `MIN_EDGE_PX`/`MIN_AREA_PX` 에 `export` 키워드만 추가(값·로직 무변경).
  신규 진단 모듈 `src/ground/quadDiag.ts` 가 그 상수를 import → 임계값 중복 0.
- **거부 시 대안**: `quadDiag.ts` 가 임계값 없이 **수치만** 산출하고(최단 변 길이, 면적, 볼록 여부),
  문장은 `사용 불가 — 최단 변 4.2px · 면적 312px² · 볼록 아님` 처럼 **판정 없이 사실만** 제시한다.
  ok/reject 는 여전히 `isUsableQuad` 가 낸다. 사용자 친절도는 떨어지지만 중복은 0이다.

---

## 4. idx 부여 + 저장

### 4-A. 결정: **끝 append (idx = N+1)** — 중간 삽입 기본값 채택 안 함

근거:
- D-3: `slot_ptz.json` · 센터링 · artifact `globalIndex` 가 전역 번호 **순서에 의존**한다.
  중간 삽입은 그 지점 이후 **모든 기존 면의 idx 를 1씩 민다** → 이미 센터링·저장된 매핑이 전부 어긋난다.
  append 는 **기존 번호를 단 하나도 건드리지 않는다**.
- 중간 배치가 필요하면 **기존 '수정' 버튼**(`editPlaceIdx` → `reindexPlaceSpace`)으로 사용자가 명시적으로 옮긴다.
  즉 `append + reindexPlaceSpace` 조합으로 중간 삽입도 **신규 로직 0줄**로 이미 커버된다.

**기존 함수 재사용 가능성 조사 결과**
| 함수 | 재사용 여부 | 근거 |
|---|---|---|
| `addSlot`/`insertSlotAt`(core.js) | **불가** | `SetupArtifact.slots`(slotId 문자열·roiByPreset) 대상. `placeRoi`(`{'cam:preset': [{idx,points}]}`)와 타입·구조가 다르다 |
| `reindexPlaceSpace` | **가능·재사용** | 커밋 후 번호 이동에 그대로 씀 |
| `removePlaceSpace` | **가능·무변경** | 그린 면 삭제도 기존 '삭제' 버튼이 그대로 처리(idx 재압축 포함) |
| `normalizeGlobalIdx` | **가능·무변경** | append 로 만든 1..N 은 이미 순열 → `changed:false`(멱등 확인됨, core.js:656) |

### 4-B. D-4 보장 지점 — idx 없는 면이 **만들어질 수 없게** 한다

```js
// web/placeDraw.js — idx 를 인자로 받지 않는다(시그니처로 강제).
export function appendPlaceSpace(placeRoi, key, points) {
  const map = placeRoi ?? {};
  const idx = nextPlaceIdx(map);            // = 전체 면 수 + 1 (빈 상태면 1)
  const next = { ...map, [key]: [...(map[key] ?? []), { idx, points }] };
  return { placeRoi: next, idx };
}
```

3중 보장:
1. **생성 시점**: 위 함수가 idx 를 항상 계산해 넣는다. 호출자가 누락시킬 방법이 없다.
2. **저장 직전**: `savePlaceRoi()` 에 가드 추가 — 어떤 space 라도 `Number.isInteger(idx)` 가 아니면
   **PUT 을 보내지 않고** 중단 + 사유 표시(`applyPlaceRoiUpdate` 통째 교체로 raw 에서 지워지는 QA-F 결함 차단).
3. **테스트 봉인**: §7 Stage 3 T3.

### 4-C. 저장 — 기존 `PUT /capture/place-roi` 재사용 (D-2), 단 **확장 필요**

신규 라우트는 만들지 않는다. 다만 F-3 때문에 **기존 라우트를 확장하지 않으면 Loop 5 는 원리적으로 불가능**하다.
확장은 전부 **가산·옵셔널**이라 기존 호출자(자동보정 `alignApply`, 목록 `savePlaceRoi`, `groundGridRoutes` apply 루프)는 무변경이다.

```ts
// src/capture/placeRoi.ts — 기존 시그니처는 그대로 두고 확장판을 별도 export(호출부 3곳 무수정).
export interface PlaceRoiSkeleton {
  imageWidth: number; imageHeight: number;
  pan?: number; tilt?: number; zoom?: number;   // ★ F-1 — 없으면 L3 부트스트랩 불가
}
export function applyPlaceRoiUpdateEx(
  json: unknown,
  update: { camId: unknown; presetIdx: unknown; spaces: PlaceRoiSpace[]; create?: PlaceRoiSkeleton },
): { json: unknown; applied: boolean; issues: string[] };

/** 기존 계약 보존 래퍼 — 반환값·동작 100% 동일. */
export function applyPlaceRoiUpdate(json, update): unknown;   // = applyPlaceRoiUpdateEx(json, update).json
```

`create` 동작(있을 때만):
- `json` 이 객체가 아니거나 `cameras` 가 없으면 → `{ cameras: [] }` 에서 시작.
- `cam_id === camId` 인 카메라가 없으면 → `{ camera: { cam_id, imageWidth, imageHeight }, presets: [] }` 추가.
- `preset_idx === presetIdx` 가 없으면 → `{ preset_idx, pan, tilt, zoom, parking_spaces: [] }` 추가(PTZ 는 있는 값만).
- **카메라·프리셋이 이미 있으면 `create` 는 아무것도 하지 않는다**(기존 메타 덮어쓰기 금지 — imageWidth 보존).
- `applied` = 실제로 대상 프리셋의 `parking_spaces` 를 교체했는가. **F-3-2 의 조용한 거짓 성공을 이 플래그가 없앤다.**

라우트(`captureRoutes.ts`):
```ts
const PlaceRoiPutSchema = z.object({
  camId: ..., presetIdx: ..., spaces: ...,
  create: z.object({ imageWidth: z.number().positive(), imageHeight: z.number().positive(),
                     pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().positive().optional() }).optional(),
});
// readFile ENOENT + create 있음  → raw = '{"cameras":[]}' 로 진행(파일 신규 생성)
// readFile ENOENT + create 없음  → 기존 그대로 404 (기존 테스트 green 유지)
// write 전에 mkdir(dirname, { recursive: true })  ← 기존 테스트가 'nope/PtzCamRoi.json' 처럼 상위 디렉터리 부재를 씀
// 응답: { ok: true, spaceCount, applied, issues }   ← 가산 필드(기존 필드 불변)
```
직렬화는 기존대로 `stringify5(next, 2)` — 소수 5자리 규약 자동 준수.

### 4-D. 클라이언트 저장 흐름

`savePlaceRoi()`(app.js:2175)를 최소 수정:
1. idx 가드(§4-B-2).
2. 각 프리셋 PUT body 에 `create` 를 **필요할 때만** 첨부:
   `state.placeRoiFileMissing === true`(GET 이 404 였다) **또는** 그리기로 새로 만든 키일 때.
   `create` 값 = `{ imageWidth: frame.naturalWidth, imageHeight: frame.naturalHeight, ...findPresetPtz(state.cameras, cam, preset) }`.
   `findPresetPtz` 는 app.js 가 **이미 import** 중(line 27) — 신규 의존 0.
3. `naturalWidth` 가 0 이면 저장 중단 + `라이브 프레임을 먼저 시작하세요(이미지 크기 미상)`.
4. 응답의 `applied === false` 면 성공 문구 대신 경고 문구(F-3-2 가시화).
5. 저장 성공 후 `state.placeRoiLoaded = false; await loadPlaceRoi();` — **파일 왕복 재로딩으로 좌표·idx 일치를 눈으로 확인**(Loop 3).

---

## 5. L3 연결 (Loop 4) — 실제로 기준 면이 되는가

`ggRefSpace()`(app.js:1915-1925)는 `state.placeRoi` 를 순회해 `s.idx === state.selectedPlaceIdx` 를 찾는다.
⇒ 커밋 시 `state.selectedPlaceIdx = 새 idx` 를 설정하면 **조건 성립**(`points.length === 4` 도 만족).
`renderPlaceSelectionInfo()` → `renderGgSelectionInfo()` 가 이미 연쇄 호출되므로 `#gg-preview` 잠금도 자동 해제된다.

**단, 저장 전에는 미리보기가 실패한다.** `POST /capture/ground-grid/bootstrap` 은
`readFile(placeRoiFile)`(groundGridRoutes.ts:87) → `planAutoRoi` 가 **파일에서** cam/preset/PTZ 를 찾는다.
메모리 버퍼는 서버가 볼 수 없다. ⇒ **정본 순서: 그리기 → 저장 → 재로딩 → 미리보기.**
`renderGgSelectionInfo()` 에 게이트 문구 1줄 추가: `state.placeRoiDirty` 면
`미저장 편집이 있습니다 — '저장' 후 미리보기하세요(서버는 파일을 읽습니다)`.

---

## 6. 파일별 변경 계획

| 파일 | 구분 | 변경 |
|---|---|---|
| `web/placeDraw.js` | **신규** | 순수 로직 전량(DOM 접근 0) — 상태머신 + append + 정점. node 환경 vitest 직접 검증 대상 |
| `web/app.js` | 수정 | state 3필드 · mousedown 최상단 1블록 · placeVertex 분기 1블록 · mousemove/mouseup 각 1블록 · keydown 1핸들러 · 미리보기 렌더 함수 1개 · `savePlaceRoi` 확장 · 버튼 결선 |
| `web/index.html` | 수정 | `#place-draw` 버튼 · `#place-edit-vertex` 체크박스(주차면 목록·편집 바에 추가) |
| `web/app.css` | 수정 | `.place-drawing { cursor: crosshair; }` (`.click-centering` 선례 복제) |
| `src/capture/placeRoi.ts` | 수정 | `applyPlaceRoiUpdateEx` + `PlaceRoiSkeleton` 추가, 기존 `applyPlaceRoiUpdate` 는 래퍼로 보존 |
| `src/api/captureRoutes.ts` | 수정 | PUT 스키마 `create` · ENOENT+create 분기 · `mkdir` · `applied` 필드 · validate 라우트 등록 |
| `src/ground/quadDiag.ts` | **신규** | 거부 사유 진단(verdict 는 `isUsableQuad` 위임) |
| `src/ground/groundModel.ts` | **승인 필요** | `export` 키워드 2개만(§3-C). 거부 시 미변경 |
| `test/placeDraw.test.ts` 외 4종 | **신규** | §7 |

**무변경 유지 확인**: `project.ts` · `ground/types.ts` · `floorRoi.ts` · **`web/core.js`** · `Finalizer.ts` ·
`SqliteStore.ts` · `roiDbLoad.ts` — 전부 손대지 않는다.
(`web/core.js` 의 `hitTestQuadVertex`/`moveQuadVertex` 는 **import 해서 재사용**만 한다 — 수정 0.)

### 신규 시그니처 (web/placeDraw.js — 전부 순수·불변·throw 금지)

```js
export function beginPlaceDraw(key)                     // → { key, points: [] }
export function addPlaceDrawPoint(draw, pt)             // → { draw, full }  (4점 초과 무시)
export function undoPlaceDrawPoint(draw)                // → draw (points.pop, 0개면 그대로)
export function nextPlaceIdx(placeRoi)                  // → 전체 면 수 + 1 (null/빈 → 1)
export function appendPlaceSpace(placeRoi, key, points) // → { placeRoi, idx }  ★ idx 필수 부여
export function placeQuadOf(placeRoi, key, idx)         // → points[]|null (히트테스트/검증 조회)
export function movePlaceVertex(placeRoi, key, idx, vertexIndex, dx, dy)  // → placeRoi (core.moveQuadVertex 위임)
```

### state 추가 (app.js)

```js
placeDraw: null,             // { key, points:[{x,y}...] } — 그리기 진행 중에만 non-null
placeRoiFileMissing: false,  // GET /capture/place-roi 가 404 였다(= 신규 주차장) → 저장 시 create 첨부
placeDrawMsg: '',            // 검증 결과 문구(#place-msg 재사용)
```
`loadPlaceRoi()`(app.js:977)의 `if (!res.ok) return;` 을
`if (!res.ok) { state.placeRoiFileMissing = res.status === 404; return; }` 로 확장(1줄, 렌더 영향 0).

---

## 7. 단계 분할 — 각 단계의 검증 가능한 완료 조건

### Stage 1 — 서버: 빈 상태 해소 (Loop 5 의 전제)
1. `applyPlaceRoiUpdateEx` + 래퍼 → **검증**: 기존 `test/placeRoiUpdate.test.ts` **무수정 전량 green**.
2. PUT `create` 배선 + `mkdir` + `applied` → **검증(신규 `test/placeRoiCreate.test.ts`)**
   - T1 파일 부재 + `create` → 201/200, **파일이 생성**되고 GET 이 그 JSON 을 돌려준다.
   - T2 생성된 JSON 에 `cam_id/imageWidth/imageHeight` **및 `preset_idx/pan/tilt/zoom`** 이 있다(F-1 봉인).
   - T3 파일 부재 + `create` 없음 → **여전히 404**(`test/placeRoiRoutes.test.ts` 기존 케이스 green).
   - T4 cam 불일치 + `create` 없음 → `applied === false`(조용한 거짓 성공 제거, F-3-2 봉인).
   - T5 기존 카메라에 `create` 를 보내도 `imageWidth` 가 **덮이지 않는다**.
   - T6 왕복: PUT 한 정규화 좌표 → GET → `normalizePtzCamRoi` → 원 좌표와 오차 ≤ 1e-5(`stringify5` 규약).

### Stage 2 — 서버: quad 검증 라우트
1. `quadDiag.ts` + `POST /capture/place-roi/validate` → **검증(신규 `test/placeRoiValidate.test.ts`)**
   - T1 정상 사다리꼴 → `ok:true`, `reasons: []`.
   - T2 bowtie(자기교차) → `ok:false` + 자기교차 사유 포함.
   - T3 4px 변 / 100px² 면적 → 각각 해당 사유.
   - T4 **교차 검증**: 무작위(고정 시드) quad 200개에 대해 `resp.ok === isUsableQuad(quadPx)` 가 **100% 일치**
     (재구현이 아님을 테스트로 증명).
   - T5 PtzCamRoi.json 부재 + body 의 `imageWidth/imageHeight` 만으로 동작(Loop 5 필수).

### Stage 3 — 프런트 순수 로직
1. `web/placeDraw.js` → **검증(신규 `test/placeDraw.test.ts`, node 환경)**
   - T1 `beginPlaceDraw` → 3점까지 `full:false`, 4점째 `full:true`, 5번째 클릭은 무시.
   - T2 `undoPlaceDrawPoint` 로 0개까지 되감기, 빈 상태에서 호출해도 throw 없음.
   - T3 **`appendPlaceSpace` 결과의 모든 space 가 정수 idx 를 갖는다**(D-4 봉인).
   - T4 **기존 면의 idx·순서·좌표가 단 하나도 변하지 않는다**(D-3 봉인) — 실데이터
     `data/Place01/PtzCamRoi.json`(전역 1..23)에 1면 추가 → 기존 1..23 전부 동일, 신규 = 24.
   - T5 `placeRoi = null`(빈 주차장) → 첫 면 idx = **1**, 키가 새로 생김.
   - T6 `normalizeGlobalIdx(append 결과).changed === false`(멱등 — 저장 시 재부여가 안 일어난다).
   - T7 `movePlaceVertex` 불변성(원본 객체 미변형) + 5자리 반올림 후 결정론.

### Stage 4 — 결선(app.js/index.html/css)
1. 버튼·상태머신·오버레이·키보드·히트테스트 삽입 → **검증(신규 `test/placeDrawWiring.test.ts`,
   소스텍스트 봉인 — 선례 `test/groundGridPanelUi.test.ts`)**
   - T1 `mousedown` 핸들러 본문의 **첫 문장**이 `if (state.placeDraw)` 분기다(회귀 0 구조 봉인).
   - T2 `placeVertex` 분기가 `if (state.roiHidden || !state.mapping) return;` **이전**에 있다(F-5 봉인).
   - T3 `mousemove` 의 `placeVertex` 처리가 `state.mapping.slots` 접근 **이전**에 `return` 한다(TypeError 방어 봉인).
   - T4 `#place-draw` · `#place-edit-vertex` 가 index.html 에 있고 `wire()` 에서 결선된다.
   - T5 `#place-edit-vertex` 의 기본값이 **unchecked** 다(기본 OFF 봉인).
   - T6 그리기 커밋 경로에 `savePlaceRoi`/`fetch(... 'PUT')` 이 **없다**(자동 저장 금지 봉인).
   - T7 `savePlaceRoi` 본문에 idx 가드와 `applied` 확인이 있다.
2. **검증**: `npx tsc --noEmit` 0 에러 + `npx vitest run` 전량 green(L3 골든 해시 포함).

### Stage 5 — 종단(리더 라이브, 브라우저 육안)
- E1 **빈 상태**: 임시 `dataDir`(PtzCamRoi.json 없음)로 기동 → 목록 비어 있음 → 면 그리기 → 커밋 → 저장
  → 파일이 **생성**되고 재로딩 후 초록 ROI 가 같은 자리에 보인다(Loop 5 ✅).
- E2 **정점 조정**: 4정점 드래그로 모서리 정렬 → 저장 → 재로딩 좌표 일치(Loop 2·3 ✅).
- E3 **기존 면 불변**: 실데이터에서 1면 추가·저장 → 기존 1..23 의 좌표·idx 가 파일 diff 상 무변경(Loop 3 ✅).
- E4 **L3 연결**: 새 면 선택 → `#gg-preview` 활성 → 미리보기 성공(Loop 4 ✅ / 실패 시 R2 확인).
- E5 **회귀 0**: 그리기 OFF 상태에서 기존 편집(검출 박스·Ctrl VPD·선택/해제)이 이전과 동일.

---

## 8. 리스크

| # | 리스크 | 근거 | 대응 |
|---|---|---|---|
| **R1** | `frame.naturalWidth` 가 원본 해상도가 아니라 **스트림 다운스케일 크기**일 수 있다 | 이미지 크기의 다른 출처가 저장소에 없다(F-2) | 종횡비가 같으면 지면모델은 스케일 불변(f 가 imgH 에서 유도)이라 성립. **Stage 5 에서 리더가 실측 대조**(실카 1920×1080 vs naturalWidth). 불일치 시 수동 입력 필드 추가 |
| **R2** | 수동으로 그린 **단일 quad** 로 `focalFromVPs` 가 실패해 L3 부트스트랩이 안 될 수 있다 | 직전 QA 결함 4(cam1 preset3 실패). 폴백 `pooled fovBaseV` 는 **같은 카메라의 다른 프리셋**을 요구 → 신규 주차장(1면뿐)에는 없다 | 이번 범위에서 **해결 불가**. 실패 시 기존 강등 문구가 정직하게 뜬다. Loop 4 실패 가능성을 리더에게 미리 고지 |
| **R3** | artifact 가 있고 `roiHidden=false` 면 `renderSlotList` 가 mapping 분기로 가서 **새 면이 목록에 안 보인다** | app.js:1172 `fileMode = !FLOOR_ROI_USE_LLM && (roiHidden \|\| !mapping)` | 기존 결함(범위 밖). 오버레이·선택은 정상 동작. 범위 확대 여부 **리더 판단 요청** |
| **R4** | 브라우저 실렌더 **7라운드 연속 미검증** | 이월 항목 | 이번 작업은 본질이 캔버스 상호작용 → 소스텍스트 봉인으로는 "보이는가"를 못 증명. **마스터 육안 확인 필수**로 전제 |
| **R5** | `savePlaceRoi` 는 **전 프리셋 순차 PUT** 이라 다른 프리셋의 미저장 편집까지 함께 확정된다 | app.js:2181 기존 동작 | 기존 동작 유지(변경하면 그게 회귀). 저장 문구에 대상 프리셋 수를 이미 표시 중 |

---

## 9. 리더 확인 요청 (진행 전)

1. **`groundModel.ts` 의 `export` 2개 추가 승인 여부**(§3-C). 거부 시 대안으로 진행.
2. **R3(목록 표시 조건)을 이번 범위에 넣을지** — 기본은 범위 밖으로 두고 손대지 않는다.
3. **F-1/F-2 확인**: 골격에 PTZ 포함 + 이미지 크기를 `frame.naturalWidth` 에서 취하는 설계에 동의하는지.
   (동의하지 않으면 이미지 크기의 다른 출처가 필요한데, 조사 결과 저장소에 없다.)
