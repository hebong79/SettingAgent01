# 01 설계 계획 — L3 후속: 미리보기 UX · `PtzCamRoi_auto.json` 분리 · 승인 시 slot_setup 전량 재구성

작성: 2026-07-28 / 설계자(architect) / **개정 1**: 리더 판단(Q1 대안 B 채택 · D-1' 철회 · D-2' 폐기) 반영
입력: `_workspace/00_leader_context.md` + 리더 개정 지시 + `_workspace_prev_20260728_L3/01~03` + **코드 직접 확인**

> 규칙: 모든 단정은 **읽은 코드의 파일:줄**로 근거를 댄다. 확인 못 한 것은 "미확인"이라 적는다.

---

## 0. 개정 요지 (리더 판단 반영)

### 0-1. 확정 구조

```
[미리보기]  POST /capture/ground-grid/bootstrap        부작용 0 (파일도 DB도 안 건드림)
    ↓  결과 확인 체크
[승인]      POST /capture/ground-grid/apply            ★ 파괴적 — confirm 필수
    ├ S1 계획 산출 + 기존 R-4/R-5 게이트
    ├ S2 파괴 방지 게이트 G1~G4  ← **DB 접근 전, 파일 계층에서만 판정**
    ├ S3 PtzCamRoi_auto.json 기록      (감사 기록 · 승인 후에도 삭제하지 않는다)
    ├ S4 PtzCamRoi.json → PtzCamRoi.<ts>.bak.json 백업
    └ S5 PtzCamRoi.json 갱신(promote)
    ↓  웹이 연쇄 호출
[재구성]    POST /capture/slots/load-roi (기존 라우트, 무변경)
            → loadRoiIntoDb(placeRoiFile) → replaceSlotSetup → slot_setup 전량 재구성
```

### 0-2. 폐기·삭제된 것 (개정 전 계획서에서 제거)

| 항목 | 처분 | 사유 |
|---|---|---|
| 소스 선택 스위치 · `roi_source.json` | **폐기** | 정본 경로가 하나뿐이므로 선택할 것이 없다 |
| `resolvePlaceRoiSource` / `RoiSourceState` / `GET·POST /capture/roi-source` | **폐기** | 위와 동일 |
| 읽기 지점 P0/P1 분할 | **폐기** | 갈라짐이 0이므로 분할 자체가 소멸(§3) |
| `Finalizer.ts` 옵셔널 dep(`roiSourceResolver`) | **철회 — 무변경** | finalize 는 계속 `PtzCamRoi.json` 만 읽고, 그 파일이 승인분을 담는다 |
| `src/api/captureRoutes.ts` 변경(`source` body 등) | **철회 — 무변경** | 승인 후 기존 `load-roi` 라우트를 **그대로** 호출 |
| 별도 버튼 `자동 ROI로 DB 재구성` | **폐기** | 승인 1회가 재구성까지 수행 |
| `_auto` 기저 누적 / `baseManualMtime` 드리프트 경고 | **폐기** | 기저가 항상 `PtzCamRoi.json` 이 되어 드리프트가 원천 소멸(§2-4) |

### 0-3. 유지되는 분석 (리더 지시대로 버리지 않음)

- §3 읽기 지점 **13곳 전수 목록** → "왜 한 곳도 안 건드려도 되는가"의 근거로 재배치
- §2-2 `_auto` 스키마 + `normalizePtzCamRoi`/`applyPlaceRoiUpdate` 호환 근거
- §4-2 파괴 게이트 G1~G4
- §4-4 되돌리기의 정확한 성질(`slot_roi` 한정 참)
- §1 미리보기 UX 전체 + 동기화 구멍(리더 1줄 방어 승인)

---

## 1. (1) 미리보기 UX

### 1-1. 확인한 사실

| 항목 | 근거 |
|---|---|
| `gg-apply` 에는 게이트가 있다 | `web/app.js:1920` `apply.disabled = !($('gg-confirm')?.checked && state.autoRoi)` |
| `gg-preview` 에는 게이트가 **없다** | `web/index.html:186` 에 `disabled` 속성 없음, `app.js` 내 `gg-preview` disabled 대입 **0건**(grep) |
| 미선택 시 즉시 return | `app.js:1962-1966` — `setGgMsg(...)` 후 return. 캔버스·표 무변경 → **눈에는 완전 무반응** |
| `#gg-msg` 는 눈에 안 띈다 | `index.html:190` `class="map-msg"` — 강조 스타일 없음 |
| 리스너 배선 정상 | `app.js:4515-4517` |
| `ggRefSpace()` 입력 | `app.js:1899-1909` — `state.selectedPlaceIdx` + `state.placeRoi`. 4점 폴리곤 아니면 null |

### 1-2. ★ 선택 상태 → 버튼 동기화 경로 (전수 추적 결과)

```
renderGgSelectionInfo()  ← 호출자 4곳
  ├─ renderPlaceSelectionInfo()      app.js:2060, 2065   ← 유일한 상시 경로
  ├─ ggPreview()                     app.js:1979, 1997
  └─ #gg-confirm change 리스너        app.js:4517
renderPlaceSelectionInfo()  ← 호출자 1곳
  └─ renderSlotList()                app.js:1196   ★ fileMode/finalized 분기 **안쪽**
```

**경로 A(정상).** `selectPlaceSpace`(`:2074`) → `renderSlotList()`(`:2085`) → `renderPlaceSelectionInfo()`(`:1196`) → `renderGgSelectionInfo()`. 목록 행 클릭은 동기화된다. `editPlaceIdx`(`:2103`)·`deletePlaceSpace`(`:2113`)·`openPlaceRoi`(`:2173`)·`loadPlaceRoi`(`:993`)도 같은 경로로 커버.

**경로 B(★ 구멍 — 리더 1줄 방어 승인).**
```js
// app.js:1171-1198
const finalized = !!(state.parkingSlotsByKey && Object.keys(...).length);
const fileMode  = !FLOOR_ROI_USE_LLM && (state.roiHidden || !state.mapping);
if (finalized || fileMode) { … renderPlaceSelectionInfo(); return; }   // ← 여기서만 호출
if (!state.mapping) return;                                            // app.js:1199~
…  // mapping.slots 분기 — renderPlaceSelectionInfo() 호출 **없음**
```
`FLOOR_ROI_USE_LLM=false` 이므로 `fileMode = state.roiHidden || !state.mapping`.
→ `state.mapping` 이 있고 `roiHidden=false` 이고 `parkingSlotsByKey` 가 비어 있으면 else 분기로 빠져 **gg 패널이 갱신되지 않는다.**
→ 게이트만 넣고 이걸 안 막으면 **버튼이 회색으로 굳는 더 나쁜 무반응**이 된다.
※ 이 분기에 실제 도달하는 조건(`state.mapping` 이 채워지는 경로)은 **미확인**. 도달 여부와 무관하게 막는다(비용 1줄).

### 1-3. 수정 설계

**1-A. `renderGgSelectionInfo()` 에 preview 게이트 추가** (`app.js:1912-1921`)
```js
function renderGgSelectionInfo() {
  const info = $('gg-sel-info');
  if (!info) return;
  const ref = ggRefSpace();
  info.textContent = ref ? `기준 주차면: #${…}` : '기준 주차면 미선택';
  const prev = $('gg-preview');
  if (prev) prev.disabled = !ref;                    // ★ 신규 — gg-apply(:1920) 와 같은 규약
  setGgGate(ref ? '' : '기준 주차면을 주차면 목록에서 먼저 선택하세요(4점 폴리곤 1개)'); // ★ 신규
  const apply = $('gg-apply');
  if (apply) apply.disabled = !($('gg-confirm')?.checked && state.autoRoi);
}
```
- `setGgGate(text)`: `text` 가 있으면 `#gg-msg` 에 문구 + `.gg-warn` 부여, 비면 **`.gg-warn` 만 해제하고 텍스트는 건드리지 않는다**(미리보기 성공 문구가 지워지면 안 됨).
- `ggPreview()` 의 기존 early-return(`:1962-1966`)은 **그대로 둔다**(이중 방어. 외과적 — 삭제 금지).

**1-B. 구멍 B 봉합(리더 승인)** — `renderSlotList()` **말미**(else 분기 종료 직전)에 `renderPlaceSelectionInfo();` 1줄 추가.
- `if (finalized || fileMode)` 분기는 `return` 으로 빠지므로 **이중 호출 없음** → fileMode 동작 완전 동일(회귀 0).
- else 분기에서 `place-sel-info` 텍스트와 `place-delete.disabled` 도 갱신된다 — 기존에 갱신 안 되던 것이 갱신되는 **동작 변경**이며, 두 값 모두 `state.selectedPlaceIdx` 하나로 결정되므로 잘못된 상태가 될 수 없다.
- 기각한 대안: 호출을 함수 최상단으로 **이동** — fileMode 분기의 렌더 순서가 바뀐다(불필요한 변경).

**1-C. `#gg-msg` 강조** — `index.html:190` 무변경. `web/app.css` 에 `.gg-warn` 셀렉터 **1개 추가**(경고색 + 볼드). 선례: 직전 라운드 `.gg-help`(`02_developer_changes.md` §5-9). 기존 `.map-msg` 규칙 본문 무변경.

**1-D. `index.html:186` 에 `disabled` 초기 속성** — 최초 로드(선택 없음)와 JS 상태 일치. `gg-apply`(`:188`)가 이미 같은 방식.

### 1-4. 정적 봉인 테스트 — `test/groundGridPanelUi.test.ts` (신규)

선례 `test/dbViewSourceSwitch.test.ts` 의 `functionBody(src,name)` 파서를 **복사**해 쓴다(공용 유틸 추출은 요청 범위 밖).

| # | 봉인 | 잡는 회귀 |
|---|---|---|
| T1 | `renderGgSelectionInfo` 본문이 `gg-preview` 의 `disabled` 에 대입 | 게이트 제거 |
| T2 | 그 조건이 `ggRefSpace()` 결과(`!ref`) | 잘못된 조건 대체 |
| T3 | `index.html` `<button id="gg-preview"` 에 `disabled` 속성 | 초기 상태 불일치 |
| T4 | `renderPlaceSelectionInfo` 가 `renderGgSelectionInfo()` 호출 | 사슬 절단 |
| T5 | `selectPlaceSpace` 가 `renderSlotList()` 호출 | 경로 A 절단 |
| T6 | **`renderSlotList` 본문에 `renderPlaceSelectionInfo()` 가 2회 이상** | 구멍 B 재발 |
| T7 | `ggPreview` 미선택 early-return 이 안내 문구를 남긴다 | 조용한 무반응 재발 |
| T8 | `web/app.css` 에 `.gg-warn` 존재 | 강조 소실 |

---

## 2. (2) `PtzCamRoi_auto.json` 분리

### 2-1. 경로 — config 신규 키 없이 `store.placeRoiFile` 에서 파생

```ts
// src/capture/placeRoiPaths.ts (신규 ~35줄, 순수)
/** `…/PtzCamRoi.json` → `…/PtzCamRoi_auto.json`. 확장자 없으면 뒤에 `_auto`. */
export function autoPlaceRoiPathOf(manualFile: string): string;
/** `…/PtzCamRoi.json` + ISO → `…/PtzCamRoi.20260728T101530Z.bak.json`. 파일명 안전 문자만. */
export function backupPlaceRoiPathOf(manualFile: string, iso: string): string;
```

**파생을 택한 근거(신규 config 키 기각):**
1. 세 파일은 **반드시 같은 짝**이어야 한다. 독립 설정 가능하면 "manual=PlaceA / auto=PlaceB" 같은 잘못된 짝이 만들어지고, 그 오류는 **promote 시점(= 정본 덮어쓰기)** 에야 드러난다. 파괴적이다.
2. `store.groundGridFile` 이 신규 키인 것과 모순 아님 — 그것은 **다른 개념의 저작물**(격자)이라 독립 경로가 옳고, `_auto`/`.bak` 는 **정본의 파생 쌍**이다.
3. 설정 키 0 → 하위호환 고민 0, 배포 시 config 갱신 불요.

**반론(정직):** 운영자가 auto/bak 위치를 옮길 수 없다. 그럴 필요의 근거를 찾지 못했다 → 추측성 유연성 금지(CLAUDE.md §2).

### 2-2. 구조 — 수동과 동일 스키마 + 최상위 메타 1키 (개정 전 분석 유지)

```jsonc
{
  "_auto": {                                  // ★ 신규 최상위 키. cameras 구조는 손대지 않는다.
    "version": 1,
    "meta": {                                 // 이번 승인
      "generatedAt": "2026-07-28T…",
      "source": "ground-grid/apply",
      "camIdx": 1,
      "refSpaceIdx": 3,                       // 기준 주차면 전역 idx(추적성)
      "appliedPresets": [1],
      "constants": { …CameraGroundConstants… },
      "grid":      { …GroundGrid… },
      "backupFile": "PtzCamRoi.20260728T101530Z.bak.json"
    },
    "history": [ { "generatedAt": …, "camIdx": …, "appliedPresets": […], "refSpaceIdx": … } ]
  },
  "cameras": [ … 수동 파일과 100% 동일 구조 … ]
}
```

**`normalizePtzCamRoi` 호환 보장 (코드 구조상 성립 — 방어 코드 불요):**
- `normalizePtzCamRoi` 는 `root.cameras` **만** 읽는다(`placeRoi.ts:36-37`). 최상위 키가 더 있어도 **무시된다**.
- `applyPlaceRoiUpdate` 는 `return { ...root, cameras: nextCameras }`(`placeRoi.ts:149`) → **`_auto` 메타 자동 보존**. 병합 코드 불필요.
- `roiDbLoad.buildCameras`/`buildPresetsFromRoi`/`roiToCameraViews` 도 `cameras` 만 읽는다(`roiDbLoad.ts:24,61,117`) → 재구성 경로 무손상.
- **봉인 테스트**: `normalizePtzCamRoi(autoJson)` 결과가 `_auto` 키를 제거한 동일 JSON 의 결과와 **deep-equal**.

**★ promote 되는 `PtzCamRoi.json` 에는 `_auto` 를 넣지 않는다.** 정본은 사람이 그린 파일의 형식을 유지한다(뷰어 `web/core.js` 파리티·`GET /capture/place-roi` raw 서빙 계약 불변). `_auto` 메타는 `_auto.json` 에만 산다. → **정본 파일 스키마 변경 0**.

**메타를 넣는 이유:** 리더가 `_auto.json` 을 **삭제하지 않는 감사 기록**으로 확정했다. 파일만 남기면 *언제·어느 면 기준으로·어떤 격자로* 만들어졌는지 알 수 없어 감사 기능을 못 한다. `history` 는 여러 주차열을 나눠 승인하는 실사용(직전 라운드 §2 다중 격자)에서 이력을 잇는다.
**넣지 않는 것:** 픽셀 quad·IoU·pairs(응답으로 충분, 파일 폭증).

### 2-3. apply 라우트 개정 (`groundGridRoutes.ts:99-183`)

| 현재 | 개정 후 |
|---|---|
| bootstrap 라우트(`:61-86`) | **무변경**(읽기 전용·부작용 0) |
| `readFile(deps.placeRoiFile)` 로 기저 로드 | **무변경** — 기저는 **항상 `PtzCamRoi.json`**(§2-4) |
| — | **S2 게이트 G1~G4**(§4-2) — 파일 계층, DB 접근 없음 |
| — | **S3** `_auto.json` 기록(`stringify5(…,2)`, `history` 누적) |
| — | **S4** `PtzCamRoi.<ts>.bak.json` 백업 |
| `writeFile(deps.placeRoiFile, stringify5(…))`(`:162`) | **S5 유지** — 단 S4 성공 후에만 |
| `ground_grid.json` 쓰기(`:163-177`) | **무변경**(단 try 분리 — §5 S5.5) |
| 응답 | `+ autoFile`, `+ backupFile`, 거부 시 `+ detail` |

**쓰기 순서 근거:** `_auto` → `.bak` → 정본. 정본을 마지막에 쓰므로 **앞 단계가 실패하면 정본은 손상되지 않는다**(§5 롤백표).

### 2-4. 기저(base) — **항상 `PtzCamRoi.json`** (개정으로 단순화)

승인이 정본을 갱신하므로 **직전 승인분이 이미 정본에 들어 있다**. 따라서 다음 승인의 기저를 정본으로 잡으면 자동으로 누적된다.
→ 개정 전 계획의 "`_auto` 우선 기저 + `baseManualMtime` 드리프트 경고"가 **통째로 불필요**해졌다(대안 B 채택의 부수 이득).
→ 사람이 정본을 수동 편집해도 다음 승인이 그 편집을 기저로 삼는다 = **사람이 항상 이긴다(R-2)** 가 자연히 성립.

### 2-5. `_auto.json` 부재 시 동작 — **정상 부재**

| 상황 | 동작 |
|---|---|
| 승인 전(파일 없음) | 완전 정상. 경고 없음 |
| 승인 시 부재 | 새로 생성(`history: []` 에서 시작) |
| 손상(파싱 실패) | **`history` 만 포기**하고 새로 시작 + `issues` 1건. **승인은 계속한다** — 감사 기록 손상이 정본 갱신을 막을 이유가 없다. throw 금지(`gridStore.ts:46-55` 패턴) |

---

## 3. 읽기 지점 13곳 — **왜 한 곳도 안 건드려도 되는가** (리더 지시로 유지)

`grep(placeRoiFile|loadNormalizedPlaceRoi|normalizePtzCamRoi)` 전수 + 호출 사슬 추적 결과.

| # | 읽기 지점 | 파일:줄 | 산출 |
|---|---|---|---|
| A | `Finalizer.persistSlotSetupFromPlace` ← `loadNormalizedPlaceRoi` | `Finalizer.ts:210,247-301` | **`slot_setup` 전량 교체**(`replaceSlotSetup`, `:300`) |
| B | `Finalizer.buildGroundModelMap` | `Finalizer.ts:311` | 지면모델 → `slot3d_front_center` |
| C | `roiDbLoad.loadRoiIntoDb` ← `POST /capture/slots/load-roi` | `roiDbLoad.ts:228-233` / `captureRoutes.ts:463` | **`slot_setup` 전량 재구성** |
| D | `frontCenterBuild.buildSlotFrontCenters` | `frontCenterBuild.ts:54` / `captureRoutes.ts:499` | `slot3d_front_center` |
| E | `roiToCameraViews`(camerapos 재생성) | `captureRoutes.ts:478` | `camerapos.json` |
| F | `GET /capture/place-roi` | `captureRoutes.ts:670-682` | 웹 `state.placeRoi`(초록 오버레이·주차면 목록·gg 기준면) |
| G | `PUT /capture/place-roi` | `captureRoutes.ts:686-702` | 수동 편집 저장 |
| H | `loadSetupTargetsFromRoi`(`/capture/start` 대상) | `captureRoutes.ts:263-267` / `roiDbLoad.ts:95` | 수집 순회 프리셋 |
| I | `GET /capture/ground-model` | `captureRoutes.ts:590-610, 750-777` | 지면모델(육면체 렌더 근거) |
| J | `cuboidContext.makeCuboidContextResolver` | `cuboidContext.ts:32-52` | 육면체 문맥 |
| K | `CaptureJob` 모드A 필터 | `CaptureJob.ts:243` | "주차면 위 차량만 검출" |
| L | `detectPipeline.loadDetectCfg` | `detectPipeline.ts:178-188` / `captureRoutes.ts:949` | 검출 설정 |
| M | `migrateToSettingDb.ts`(1회성 CLI) | `migrateToSettingDb.ts:65` | 최초 이관 |

> **13곳 전부 `PtzCamRoi.json` **하나**를 읽는다. 승인이 그 파일을 갱신하므로 13곳이 자동으로 같은 소스를 본다.**
> **소스 갈라짐 = 0. 읽기 지점 코드 변경 = 0. `Finalizer.ts` 변경 = 0.**
> 특히 **A**: finalize 가 계속 `PtzCamRoi.json` 만 읽고 그 파일이 승인분을 담고 있으므로, **리더 D-2' 가 우려한 "다음 finalize 의 전량 교체로 자동 결과가 소멸" 이 원천적으로 발생하지 않는다.**
> 배선 실태(개정 전 위험 근거였던 것): A·B·J·K 와 서버 deps 는 `index.ts:69/79/86/132` 에서 **부팅 시 경로 문자열이 생성자에 박힌다**. 개정 구조는 그 문자열을 바꾸지 않으므로 **이 배선을 손댈 이유가 사라졌다.**

---

## 4. (4) 승인 → `slot_setup` 전량 재구성

### 4-1. 기존 경로 재사용 — 서버 신규 DB 코드 0줄

승인 성공 후 **웹이 기존 라우트 `POST /capture/slots/load-roi` 를 그대로 호출**한다.

- `groundGridRoutes.ts` 는 **DB 를 전혀 모른다**(현 설계 원칙 유지 — `SqliteStore` import 0건).
- `roiDbLoad.ts` **변경 0줄**. `RoiDbLoadOptions.placeRoiFile`(`:210`)은 이미 파라미터지만 **바꿀 필요조차 없다** — 정본 경로 그대로다.
- `replaceSlotSetup` **호출자 증가 0**(`roiDbLoad.ts:319` / `Finalizer.ts:300` 그대로 2곳).
- `captureRoutes.ts` **변경 0줄**. 기존 핸들러(`:447-512`)의 부수처리(camerapos 재생성 `:478`, front-center `:499`)를 **공짜로 얻는다**.
- 기존 회귀 테스트 `test/captureLoadRoiRoutes.test.ts`(12테스트) **수정 0줄**로 green 이어야 한다 — 수정이 필요하면 **회귀이므로 중단·보고**.

**웹 구현(중복 금지):** 현재 `loadRoiToDb()`(`app.js:2833-2856`)는 `confirm()` + 본문이다.
→ 본문을 `runLoadRoiToDb()` 로 **추출**하고 `loadRoiToDb()` = `confirm()` + `runLoadRoiToDb()`.
→ `ggApply()` 는 자체 확인(§4-3) 후 `runLoadRoiToDb()` 호출. **60줄 복사 금지, 기존 후처리 순서(`resetOverlayDisplay → loadCameras → loadPlaceRoi → loadGroundModel → loadParkingSlots → 렌더`) 완전 재사용.**

### 4-2. 파괴 방지 게이트 — **DB 접근 전, 파일 계층에서만 판정** (유지)

**S1(기존, `groundGridRoutes.ts:123-136`)**: 대상 프리셋 부재 → 거부 / `applicable=false` 1건이라도 있으면 **전량 중단**(부분 적용 금지) / `buildApplySpaces` 빈 결과 → 거부.

**S2(신규) — 순수 판정 함수** `assertAutoPromoteSafe(nextJson, currentJson): { ok:true } | { ok:false, error, detail }` (`src/ground/autoRoiPlan.ts` 에 가산 — 이미 `normalizePtzCamRoi` 를 쓴다):

| ID | 조건 | 판정 | 근거 |
|---|---|---|---|
| **G1** | promote 대상 JSON 의 `normalizePtzCamRoi().byPreset.size === 0` | **거부** | 유효 주차면 0 = 정본 파괴 |
| **G2** | 대상 전역 idx 집합이 **현재 정본의 idx 집합을 포함하지 않음(⊉)** | **거부** | `allowNew=false` 경로는 좌표 교체만 하므로 상위집합이어야 한다. 아니면 슬롯이 사라졌다는 뜻 |
| **G3** | 대상 슬롯 총수 `<` 현재 정본 슬롯 총수 | **거부** | 감소는 파괴. G2 로 대체로 함의되나 프리셋 단위 누락을 독립으로 잡는다 |
| **G4** | 대상 슬롯 총수 `=== 0` | **거부** | G1 중복이나 명시적으로 남긴다 |

- 판정 입력은 **파일 2개의 메모리 JSON 뿐**. DB 조회 0, 쓰기 0 → 리더 요건("DB 접근 전 차단") 충족이며 `groundGridRoutes` 에 store dep 이 생기지 않는다.
- 거부 응답: `409 { ok:false, error, detail:{ nextSlots, currentSlots, missingIdx:[…] }, issues }` — **사유가 숫자로 보이게**.
- 거부 시 **`_auto.json` 도 쓰지 않는다.** 근거: 거부된 산출물을 감사 기록으로 남기면 "무엇이 실제 적용됐나"라는 기록의 의미가 흐려진다. 감사 기록은 **적용된 것만** 담는다.

**S6(DB 계층, 기존)**: `loadRoiIntoDb` 의 기존 거부 5종이 그대로 남는다 — 파일 없음(`:228`) / 파싱 실패(`:233`) / `byPreset.size===0`(`:242`) / `slots.length===0`(`:247`) / FK 부모 있는 슬롯 0건(`:315`). **전부 `replaceSlotSetup` 호출 전에 판정하며 DB 무변경**(`roiDbLoad.ts:7-9` 안전 규약).

### 4-3. 승인 버튼 UX — 확인 단계 **필수**

리더 지시: 파괴 성질을 **UI 에서 사용자가 읽을 문장으로** 명시한다.

```
[지면 격자 패널]
  [기준 주차면: #3 (cam1 preset1)] [열 7] [행 1] [열시작 0]
  [미리보기]  ← 미선택이면 disabled(§1)
  [☑ 결과 확인함]  [승인 후 적용]  ← 체크 + 미리보기 결과 있어야 활성(기존 :1920)
```

`ggApply()` 진입 시 `confirm()`:
```
자동 ROI 를 적용합니다.

1) PtzCamRoi_auto.json 에 자동 산출분을 기록합니다.
2) PtzCamRoi.json 을 백업(.bak)한 뒤 갱신합니다.
3) DB slot_setup 을 전량 재구성합니다.

★ 3)에서 기존 검출(VPD/LPD)·점유영역·센터라이징(PTZ)은 모두 사라집니다.
   나중에 백업으로 되돌려도 주차면 좌표만 복구되고, 검출·점유·센터링은 복구되지 않습니다
   (재수집·재센터링이 필요합니다).

진행할까요?
```
- 문구 근거: 기존 `app.js:2834` 확인문 + `index.html:218` 툴팁("되돌릴 수 없음")과 같은 규약. **한 걸음 더 나가 "무엇이 복구되고 무엇이 안 되는가"를 분리해 적는다**(§4-4 가 문서에만 있으면 안 된다는 리더 지시).
- `index.html:188` `gg-apply` 툴팁도 3단계 + 파괴 경고로 갱신.
- 성공 메시지: 적용 프리셋 · 슬롯 수 · **`.bak` 파일명** · `_auto.json` 기록 여부를 `#gg-msg` 에 표시.

### 4-4. 되돌리는 절차 — 정확한 성질 (유지 + UI 노출 강제)

| 계층 | 되돌리는 법 | 완전한가 |
|---|---|---|
| `PtzCamRoi.json` | `PtzCamRoi.<ts>.bak.json` 을 복사해 덮어쓴다(운영자 수동 — 신규 라우트 0) | ✅ 완전(바이트 단위) |
| `PtzCamRoi_auto.json` | 그대로 **둔다** — 리더 확정: 감사 기록 | — |
| `slot_setup.slot_roi`(기하) | 복원된 정본으로 `ROI 파일 로딩` 재실행 | ✅ 완전 — `buildSlots`(`roiDbLoad.ts:163-197`)가 파일에서 결정론적으로 재생성 |
| `slot_setup` 검출/점유/센터링 컬럼 | **복구 불가** | ❌ — `replaceSlotSetup` DELETE+INSERT, `buildSlots` 가 `null/0` 으로 채운다(`roiDbLoad.ts:183-190`) |

> **결론: "수동 소스로 재구성 = 원상복구" 는 `slot_roi` 에 한해 참이고, 검출·점유·센터링에 대해서는 거짓이다.**
> 이 손실은 **기존 `ROI 파일 로딩` 버튼과 완전히 동일한 성질**이며(툴팁 `index.html:218` 이 이미 경고), **이번 변경이 손실 면적을 늘리지 않는다.**
> **DB 백업은 도입하지 않는다**(리더 Q3 확정 — 범위 확대 금지 · `SqliteStore.ts` 무변경 · 신규 파괴 경로 0).
> **정직성 강제**: 위 사실을 §4-3 확인 문구로 **UI 에 노출**한다. 문서에만 적고 숨기지 않는다.
> **`.bak` 누적 정리 정책 없음** — 파일이 계속 쌓인다. 이번 범위 밖이며 문서에 명시(수동 정리).

---

## 5. ★ 단계별 실패 시 롤백 범위 (리더 지시 3)

| 단계 | 실패 시 | `_auto.json` | `PtzCamRoi.json` | `.bak` | `ground_grid.json` | `slot_setup` |
|---|---|---|---|---|---|---|
| **S1** 계획/R-4·R-5 게이트 | 200 `{ok:false, error:'적용 거부(R-4)'}` | 무변경 | **무변경** | 미생성 | 무변경 | **무변경** |
| **S2** 게이트 G1~G4 | 409 + detail | **무변경**(거부분은 기록 안 함) | **무변경** | 미생성 | 무변경 | **무변경** |
| **S3** `_auto.json` 쓰기 | 500 `자동 파일 쓰기 실패` | 부분/무 | **무변경** | 미생성 | 무변경 | **무변경** |
| **S4** `.bak` 백업 | 500 `백업 실패 — 정본 무변경` | 기록됨 | **무변경** | 미생성 | 무변경 | **무변경** |
| **S5** 정본 갱신 | 500 + **`.bak` 에서 자동 복원 시도** | 기록됨 | 복원됨(복원 실패 시 `.bak` 경로를 응답에 명시) | 존재 | 무변경 | **무변경** |
| **S5.5** `ground_grid.json` 쓰기 | `ok:true` + `issues` 강등 | 기록됨 | **갱신됨** | 존재 | 실패 | (S6 진행) |
| **S6** `load-roi` 재구성 | 409 (기존 규약) | 기록됨 | **갱신됨** | 존재 | 갱신됨 | **무변경**(`loadRoiIntoDb` 보장) |

**S6 실패의 성질(정직하게):** 파일 정본은 앞서가고 DB 는 뒤처진 상태다. **이는 안전한 실패 모드**다 — 사용자가 `ROI 파일 로딩` 버튼을 누르면 수렴하고, 그때까지 DB 는 직전 정상값을 유지한다. 웹은 이 상태를 `#gg-msg` 에 명시한다: `파일은 갱신됐으나 DB 재구성 실패 — 'ROI 파일 로딩' 으로 재시도하세요(현재 DB 는 이전 상태 유지)`.
**S5.5 를 강등으로 둔 이유:** `ground_grid.json` 은 추적성 파일이고, 이것 때문에 이미 성공한 정본 갱신을 되돌리는 것이 더 위험하다. 현재 코드는 정본 쓰기와 같은 try 안에 있으므로(`:161-181`) **try 를 분리**한다.

---

## 6. 단계 분할 + 검증 가능한 완료 조건

### Loop 1 — 미리보기 UX (§1)
1. `renderGgSelectionInfo` 게이트 + `setGgGate` + `.gg-warn` + `index.html` `disabled` + `renderSlotList` 말미 1줄.
2. **완료 조건**: `groundGridPanelUi.test.ts` **T1~T8 green** · `vitest run` 전량 green · `tsc --noEmit` 0 · `git diff --numstat web/app.js` **삭제 0줄**(가산만).
3. **미검증 명시**: 브라우저 실렌더 → Loop 5.

### Loop 2 — `_auto.json` 분리 + 백업·promote (§2, §5 S3~S5)
1. `placeRoiPaths.ts` + apply 라우트 S3/S4/S5 + `_auto` 메타·history + try 분리.
2. **완료 조건**
   - `_auto.json` 생성 + `normalizePtzCamRoi(auto)` 가 `_auto` 키 제거본과 **deep-equal**
   - promote 된 `PtzCamRoi.json` 에 **`_auto` 키가 없다**(정본 스키마 불변)
   - `.bak` 파일이 생성되고 **승인 직전 정본과 바이트 완전 동일**
   - 두 파일 전 수치 소수 **5자리 이하**(정규식 `-?\d+\.\d{6,}` 0건)
   - 결정론: 같은 입력 2회 → `cameras` 부분 문자열 동일(`generatedAt`·`backupFile` 제외)
   - 누적: preset1 승인 → preset3 승인 후 **두 프리셋 좌표가 모두 정본에 남는다** + `_auto.history` 2건
   - S4 실패 주입(백업 경로 쓰기 불가) → **정본 바이트 무변경**
   - 직전 라운드 골든 해시 테스트 **무변경 green**

### Loop 3 — 파괴 게이트 (§4-2)
1. `assertAutoPromoteSafe` + apply 라우트 S2 배선.
2. **완료 조건**
   - G1·G2·G3·G4 각각 **409 + `PtzCamRoi.json`/`_auto.json` 바이트 무변경 + `.bak` 미생성**
   - 정상 입력은 전부 통과(현 실데이터 5개 (cam,preset) 조합)
   - 순수함수 유닛테스트(라우트 없이): idx 집합 ⊉ / 개수 감소 / 0건 / 정상 4케이스
   - `detail.missingIdx` 가 실제 사라진 idx 를 정확히 보고

### Loop 4 — 승인 연쇄 + 재구성 (§4-1, §4-3)
1. `runLoadRoiToDb()` 추출 + `ggApply()` 확인 문구·연쇄·메시지.
2. **완료 조건**
   - ★ `test/captureLoadRoiRoutes.test.ts` **수정 0줄 green**(수정 필요 시 회귀 — 중단·보고)
   - ★ `git diff --numstat` 에서 `roiDbLoad.ts` · `Finalizer.ts` · `SqliteStore.ts` · `captureRoutes.ts` · `toolsConfig.ts` **NO_CHANGE**
   - `replaceSlotSetup` 호출자 **정적 검사**: 저장소 전체 grep 결과 **2곳 유지**(`roiDbLoad.ts:319`, `Finalizer.ts:300`)
   - 재구성 후 `slot_setup` 행 수·`slot_id` 순서·`preset_slotidx` 가 **정본 파일과 1:1 일치**
   - 되돌리기 실증: `.bak` 복원 → `ROI 파일 로딩` → `slot_roi` 가 승인 전과 **동일**(검출 컬럼은 null — 문서·UI 문구대로)
   - 정적 봉인: `ggApply` 본문에 확인 문구(파괴 경고 문자열)와 `runLoadRoiToDb()` 호출이 있다
   - S6 실패 주입 → `#gg-msg` 가 "파일은 갱신, DB 는 이전 상태 유지" 를 안내(정적 봉인)

### Loop 5 — 리더 종단 확인 (라이브 13020)
- 미리보기 버튼 비활성/활성 육안 · 선택 전환 즉시 반응
- 승인 → `_auto.json` 생성 · `.bak` 생성 · 정본 갱신 · `GET /capture/slots` 행 수·좌표 확인
- `.bak` 복원 → `ROI 파일 로딩` → 원상복구 확인(`slot_roi` 한정)
- **sharp 스샷**: `#roi-auto` off 상태가 변경 전과 픽셀 동일 — **직전 2라운드 연속 미수행 항목**, 이번에 처리 요청

---

## 7. 파일별 변경 계획 (구현자 인계)

| 파일 | 구분 | 내용 | Loop |
|---|---|---|---|
| `src/capture/placeRoiPaths.ts` | **신규** ~35줄 | `autoPlaceRoiPathOf` / `backupPlaceRoiPathOf`(순수) | 2 |
| `src/ground/autoRoiPlan.ts` | **가산** ~40줄 | `assertAutoPromoteSafe`(순수 게이트 G1~G4) | 3 |
| `src/api/groundGridRoutes.ts` | **수정** | apply 에 S2 게이트 · S3 `_auto` 기록 · S4 백업 · S5 순서 보장 · try 분리 · 응답 필드. **bootstrap 무변경** | 2,3 |
| `web/app.js` | **가산** | preview 게이트 · `setGgGate` · `renderSlotList` 1줄 · `runLoadRoiToDb()` 추출 · `ggApply` 확인문구·연쇄·메시지 | 1,4 |
| `web/index.html` | **가산** | `gg-preview disabled` · `gg-apply` 툴팁 갱신 · 패널 안내문에 3단계 명시 | 1,4 |
| `web/app.css` | **가산** | `.gg-warn` 셀렉터 1개(기존 규칙 본문 무변경) | 1 |
| `test/groundGridPanelUi.test.ts` | **신규** | T1~T8 정적 봉인 | 1 |
| `test/placeRoiPaths.test.ts` | **신규** | 경로 파생(확장자 유무·구분자·타임스탬프 안전문자) | 2 |
| `test/groundGridPromote.test.ts` | **신규** | `_auto` 기록·백업·promote·롤백 매트릭스(§5)·게이트 G1~G4 | 2,3 |
| `test/groundGridRoutes.test.ts` | **수정** | 개정 흐름 반영(정본이 갱신되는 것이 **정상**으로 바뀜) | 2 |
| **변경 0줄** | | `Finalizer.ts` · `SqliteStore.ts` · `roiDbLoad.ts` · `captureRoutes.ts` · `toolsConfig.ts` · `placeRoi.ts` · `groundModel.ts` · `project.ts` · `ground/types.ts` · `floorRoi.ts` · `web/core.js` · `index.ts` · `server.ts` | — |
| **수정 0줄(회귀 판정선)** | | `test/captureLoadRoiRoutes.test.ts` — 수정이 필요하면 **회귀. 중단·보고** | — |

**리더 Requirements 대조:** `Finalizer.ts`/`SqliteStore.ts` **무변경**(사전보고 불요) · `groundModel.ts`/`project.ts`/`ground/types.ts`/`floorRoi.ts`/`web/core.js` **무변경** · 신규 config 키 **0** · `replaceSlotSetup` 호출자 **증가 0** · 직전 L3 테스트(골든 해시 포함) **유지** · 결정론·`round5`/`stringify5`·throw 금지(→ null + issues)·순회 순서 고정 **유지**.

---

## 8. 리스크 · 미확인

| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | **승인이 정본을 덮는다** — 되돌리기가 `.bak` 수동 복사에 의존 | 오조작 시 수동 복구 필요 | S4 백업 필수화(백업 실패 = 정본 무변경) · `.bak` 경로를 응답·`#gg-msg` 에 노출 · confirm 3단계 문구 |
| R2 | 검출·점유·센터링 소실 | 재수집·재센터링 필요 | 기존 `ROI 파일 로딩` 과 동일 성질(면적 증가 0) · **confirm 문구로 UI 노출**(§4-3) |
| R3 | `.bak` 무한 누적 | 디스크 | 정리 정책 없음 — 문서에 명시(범위 밖) |
| R4 | S6 실패 시 파일·DB 불일치 | 일시적 | 안전 실패 모드(§5) · 재시도로 수렴 · 안내 문구 |
| R5 | `renderSlotList` else 분기 1줄 추가 | 기존 미갱신 → 갱신 | 영향 대상은 `place-sel-info` 텍스트 + `place-delete.disabled` 뿐 |
| R6 | `_auto.json` 손상 시 history 유실 | 감사 이력 일부 | 승인은 계속(§2-5) + issues 노출 |
| R7 | 다중 클라이언트 동시 승인(read-modify-write 경합) | 갱신 유실 | 기존 `PUT /capture/place-roi`(`captureRoutes.ts:696-698`)와 **동일 성질 — 면적 증가 0**. 잠금 미도입(범위 밖) |
| R8 | 브라우저 실렌더 **3라운드 연속 미검증** | UI 결함 누적 | Loop 5 sharp 스샷 요청 |
| R9 | `allowNew` UI 노출(후속 예정) | G2 상위집합 가정은 **유지**(append 는 상위집합) | 개정 구조에는 갈라짐이 없으므로 **조건부 무해에 아키텍처가 걸려 있지 않다** — 리더 지적 해소 |

**미확인 (구현자가 확인할 것)**
1. `renderSlotList` else 분기(`app.js:1199~`)에 **실제로 도달하는 조건** — `state.mapping` 이 채워지는 경로를 추적하지 않았다. 도달한다면 §1-2 는 **현재도 활성 버그**다.
2. `data/Place01/ground_grid.json` 은 **아직 없다**(`ls` 확인) — 운영에서 apply 가 한 번도 실행된 적 없다 → 마이그레이션 불요.
3. `stringify5(…, 2)` 가 `_auto` 중첩 메타의 수치까지 5자리로 접는지 실행 확인.
4. `.bak`/`_auto` 파일이 `data/Place01/` 에 생긴다. 그 디렉터리를 훑는 코드는 없으나(경로를 직접 받는다 — grep 확인) **배포 스크립트·백업 도구는 미확인**.

---

## 9. 리더 판단 반영 확인 (Q1~Q3)

| Q | 리더 판단 | 반영 위치 |
|---|---|---|
| Q1 | **대안 B 채택. D-1' 철회, D-2' 폐기** | §0-1 확정 구조 · §0-2 폐기 목록 · §3 "한 곳도 안 건드림" 근거 |
| Q2 | **소멸**(13곳 목록은 유지) | §3 을 근거 절로 재배치 |
| Q3 | **파일 `.bak` 필수 / DB 백업 없음 / 정직성은 UI 강제** | §2-3 S4 · §4-3 confirm 문구 · §4-4 · §5 롤백표 |
| 추가 | `renderSlotList` 1줄 방어 **승인** | §1-3 1-B · T6 봉인 |

**남은 판단 요청 없음.** 구현자는 Loop 1 부터 순서대로 진행하면 된다.
