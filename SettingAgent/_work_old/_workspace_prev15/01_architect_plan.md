# 01 설계 계획 — SettingViewer VPD Ctrl+드래그 편집 & 주차면 슬롯 중간삽입

작성: 설계자(architect) · 대상: 구현자(developer)·검증자(qa-tester)·문서화(documenter)
범위: `SettingAgent/web/` (뷰어) + 신규 순수함수 유닛테스트. 서버(`src/`)는 **무변경**(기존 `/mapping` PUT 계약 재사용).

---

## 0. 핵심 사실 확인(현행 코드 정독 결과 — 구현 전 반드시 숙지)

### 0.1 저장 흐름 — "디바운스" 없음(작업지시서 표현 정정)
- 편집(floor 정점 이동, 삭제)은 `markDirty()`(app.js:373)만 호출 → `mappingDirty=true` + `#map-msg` 안내.
- 실제 영속화는 **오직** `저장` 버튼(`#map-save`) → `saveMapping()`(app.js:380) → `PUT /viewer/api/mapping` → 서버 `saveMappingHandler`(server.ts:38) → `validateArtifactBody`(zod shape + `validateCoverage`) → `repo.saveArtifact`.
- **자동저장/디바운스 타이머는 코드 어디에도 없음**(grep 확인). → 구현자는 디바운스를 새로 만들지 말 것. VPD·슬롯추가 모두 **`markDirty()` + 기존 `저장` 버튼** 패턴을 그대로 재사용한다.

### 0.2 마우스 상태머신 현행(app.js `wireOverlayEditing`, 1151~1194)
| 이벤트 | 라인 | 현재 동작 |
|---|---|---|
| `overlay.mousedown` | 1153~1170 | ① `roiHidden`/`!mapping` 가드 → return. ② `eventToNorm`(269)로 정규화 좌표. ③ `hitTestFloorVertex`(277) — **선택된 슬롯 + `roi-floor` 체크 + 현재 preset floor quad 존재** 시 정점 index. 히트+선택 시 `dragState={kind:'floorVertex',...}` 시작, `preventDefault`, return. ④ 아니면 `hitTestSlots`(vehicle rect + floor quad, 레이어 토글 반영) → `selectedSlotId` 설정(빈 곳=null 해제) → 재렌더. |
| `window.mousemove` | 1173~1185 | `dragState`(floorVertex)만 처리: 델타 → `moveQuadVertex` → `updateSlotFloorRoi` → 재렌더(실시간 미리보기). |
| `window.mouseup` | 1188~1193 | `dragState` 있으면 `dragState=null` + `markDirty()` + 재렌더. |

- `dragState`(app.js:52) 형태: `{ kind:'floorVertex', index, slotId, key, last:{nx,ny} } | null`. **kind 로 분기 확장 가능한 단일 상태 변수** → VPD는 여기에 새 kind 추가.
- 선택 표시: `drawRoiOverlay`(163). 차량 rect(177~185)는 **선택 시 색/굵기만 강조, 핸들 없음**(주석 명시). floor quad(197~209)는 선택 시 `drawQuadHandles`(241)로 4정점 핸들.

### 0.3 차량 bbox 편집 배선은 **휴면 상태로 이미 존재**
- import: `resizeRect`, `updateSlotRoi`(app.js:24~25) — `[미사용]` 주석, "재편집 복구 대비 보존".
- 순수함수(core.js): `resizeRect(rect,handle,ndx,ndy)`(378) — handle ∈ `{'n','s','e','w','nw','ne','sw','se'}` 8종, 내부에서 `clamp01Rect`. `updateSlotRoi(artifact,slotId,key,rect)`(405) — 대상 슬롯 rect만 불변 교체(globalIndex 불변).
- DOM 휴면 헬퍼(app.js): `drawHandles`(254, 4모서리), `hitTestHandle`(290, 'nw/ne/sw/se'), `hitTestEdge`(314, 'n/s/e/w'). **state·overlay 치수에 결합 → vitest 불가.**
- 즉, 요구 A는 **휴면 배선의 재활성 + Ctrl 게이팅**이며, 신규 로직은 최소.

### 0.4 도메인/스키마 계약
- `ParkingSlot`(packages/types): `{ slotId, zone, roiByPreset: Record<key,NormalizedRect>, plateRoiByPreset?, floorRoiByPreset? }`.
- `Preset`: `{ camIdx, presetIdx, label, coveredSlotIds:string[], pan?, tilt?, zoom? }`. **coveredSlotIds 순서 = 프리셋 내 위치(positionIdx) 진실**.
- `GlobalSlotIndex`: `{ globalIdx(1-based), slotId, camIdx, presetIdx }`.
- slotId 규칙(Finalizer.ts:25 / SetupOrchestrator.ts:50): `c{camIdx}p{presetIdx}s{positionIdx}`. zone 기본: `cam{camIdx}`(SetupOrchestrator.ts:144).
- 저장 검증: `SetupArtifactSchema`(artifactSchema.ts:47) + `validateCoverage`(globalIndex ↔ slots **집합 동일**). `validateCoverage`는 **순서·1..N 연속을 검사하지 않음**(집합만). 1..N 고유는 클라이언트 `validateManualIndex`(core.js:457)로만 보장.
- floor 는 `z.array(point).min(4).max(10)` — 슬롯 추가 시 floor 는 미포함(optional)이라 무관.

---

## 요구 A — VPD(차량 rect) Ctrl+드래그 편집

### A.1 모드 분기 규칙(충돌 회피 — 확정)
`overlay.mousedown` 최상단에 **Ctrl 분기**를 추가(기존 floor/선택 분기보다 우선):

```
mousedown:
  가드(roiHidden/!mapping) → return
  {nx,ny} = eventToNorm(e); key = presetKey(cam,preset)
  ── [신규] Ctrl(e.ctrlKey || e.metaKey) 이고 roi-vehicle 체크됨 ──
     1) 선택 슬롯의 현재 preset vrect 가 있으면:
          h = hitTestVpd(nx,ny)   // 8핸들/내부/null (선택 슬롯 vrect 대상)
          h ∈ 8핸들 → dragState={kind:'vpdResize', handle:h, slotId, key, last}; preventDefault; return
          h === 'in'  → dragState={kind:'vpdMove',   slotId, key, last}; preventDefault; return
     2) (선택 슬롯 vrect 밖/미선택) hitTestSlots(vehicle-only) 로 커서 아래 차량박스 탐색:
          hit → selectedSlotId=hit; 재렌더; dragState={kind:'vpdMove', slotId:hit, key, last}; preventDefault; return
     3) Ctrl 인데 빈 곳 → 아래 기존 분기로 낙하(=선택 해제)
  ── [기존] floor 정점 분기(hitTestFloorVertex) ──   // Ctrl 아닐 때만 실질 도달
  ── [기존] hitTestSlots 선택/해제 분기 ──
```

- **우선순위 확정**: `Ctrl 누름 = VPD 편집`, `Ctrl 없음 = 기존(floor 정점/선택)`. → floor 정점편집·slot 선택·plate(비편집)와 물리적으로 배타. plate 는 편집 대상 아님(렌더만).
- macOS 대응으로 `e.metaKey`도 OR(선택). Windows 주 타깃이므로 `ctrlKey` 필수, `metaKey`는 가산.

### A.2 mousemove/mouseup 확장(같은 핸들러에 kind 스위치 추가)
- `mousemove`(1173): `dragState.kind` 분기 추가
  - `'floorVertex'` → 기존 유지.
  - `'vpdResize'` → `cur = slot.roiByPreset[key]`; `next = resizeRect(cur, dragState.handle, ndx, ndy)`; `state.mapping = updateSlotRoi(state.mapping, slotId, key, next)`; `dragState.last={nx,ny}`; 재렌더.
  - `'vpdMove'` → `next = moveRect(cur, ndx, ndy)`(신규 순수함수); `updateSlotRoi`; last 갱신; 재렌더.
- `mouseup`(1188): 기존 그대로 — `dragState=null; markDirty(); drawRoiOverlay()`(kind 무관 공통). 영속화는 `저장` 버튼.

### A.3 오버레이 VPD 핸들 시각화(`drawRoiOverlay` 177~185 확장)
- 선택 슬롯 + `roi-vehicle` on 이면 vrect 위에 **8핸들**(4모서리+4변 중점) 사각형 렌더. floor quad의 선택-핸들 UX와 대칭.
- 휴면 `drawHandles`(254)를 **재활성 + 8핸들로 확장**(현재 4모서리만) 또는 신규 `drawVpdHandles(ctx,px,py,pw,ph)` 추가. → 색은 차량 강조색(`#ff4d4d`) 유지.
- (선택·가산) Ctrl 누른 채 hover 시 커서 피드백은 범위 외로 두되, `app.css .viewport canvas` 는 이미 `pointer-events:auto`(300)라 배선 문제 없음.

### A.4 신규/재사용 순수함수(core.js + core.d.ts + vitest)
| 함수 | 신규? | 시그니처 | 근거 |
|---|---|---|---|
| `resizeRect` | 재사용 | `(rect,handle,ndx,ndy) → NormalizedRect` | 8핸들 리사이즈 이미 완비(roiEdit.test 커버) |
| `updateSlotRoi` | 재사용 | `(artifact,slotId,key,rect) → artifact` | 불변 교체 완비 |
| `moveRect` | **신규** | `(rect,ndx,ndy) → NormalizedRect` | rect **평행이동**(w,h 유지, x∈[0,1−w]·y∈[0,1−h] 클램프). `clamp01Rect`는 이동에 부적합(경계서 w/h 축소) → 별도 필요 |
| `hitTestRectHandle` | **신규** | `(rect,nx,ny,tolX,tolY) → 'n'\|'s'\|'e'\|'w'\|'nw'\|'ne'\|'sw'\|'se'\|'in'\|null` | 코너>변>내부 우선순위 히트. tol 주입(DOM 비참조, `hitTestQuadVertex` 패턴). resizeRect handle 문자열과 1:1 매핑 |

- app.js 얇은 래퍼 `hitTestVpd(nx,ny)`: 선택 슬롯 vrect + `HANDLE_PX/overlay.width|height` tol 주입 → `hitTestRectHandle` 호출. (DOM/state 결합부는 app.js에만.)

### A.5 휴면 헬퍼 처리(CLAUDE.md 규칙 3 — 외과적)
- `hitTestHandle`(290)·`hitTestEdge`(314)는 신규 `hitTestRectHandle`(순수·테스트가능)로 **대체**되어 이 변경으로 고아가 됨. 주석이 "재편집 복구 대비 보존"이라 명시하므로 **이번이 그 복구 시점** → 두 함수는 제거를 권고(리더 게이트 G-3). `drawHandles`(254)는 재활성/확장하여 사용.
- 보수적 대안: 두 휴면 함수를 그대로 두고 신규 순수함수만 추가(중복 존치). 권고는 제거(중복 제거·단순함 우선), 최종 판단은 리더.

---

## 요구 B — 주차면 슬롯 추가(전역 인덱스 중간삽입)

### B.1 "중간삽입 위치" 의미 — **전역 globalIdx 기준**(확정, 근거 병기)
- 작업지시서·시스템에 이미 **수동 전역인덱스**(`applyManualGlobalIds` core.js:536 / `reorderGlobalIndex`:473) 개념이 존재 → 전역 임의 순서는 지원되는 1급 개념. `atGlobalIdx`(1-based) 위치에 신규 슬롯을 꽂고 이후 globalIdx 를 +1 밀어내는 것이 자연스러움.
- preset 내 `positionIdx`는 별개 축(coveredSlotIds 순서). 신규 슬롯은 **해당 preset coveredSlotIds 끝에 append**(positionIdx=말미) → 정합 유지. 전역 위치와 preset-내 위치는 독립(수동 매핑 시스템과 일관).
- **알려진 상호작용(문서화 필요)**: `removeSlot`(350)은 `rebuildGlobalIndex`로 전역순서를 cam→preset→position **정규순서로 재생성**한다. 따라서 insertSlotAt로 넣은 수동 전역위치는 *이후 다른 슬롯 삭제 시* 정규순서로 리셋될 수 있음. 이는 기존 한계이며 본 작업 범위 밖(영향도 분석서에 명시).

### B.2 신규 순수함수(core.js + core.d.ts + vitest)
```
// 1) 충돌회피 slotId 생성. 해당 preset 의 sN 최대치+1, 전체 slotId 집합과 충돌 없을 때까지 증가.
nextSlotId(artifact, camIdx, presetIdx) → `c{cam}p{preset}s{N}`
   - 근거: 삭제로 s2 결번 시 length+1 은 기존 s3 와 충돌 → 최대 sN 파싱 후 +1, 이후 집합 검사로 bump.

// 2) 전역 중간삽입.
insertSlotAt(artifact, atGlobalIdx, newSlot) → artifact
   전제: newSlot={slotId,zone,roiByPreset:{[key]:rect}}, key=`${cam}:${preset}`. camIdx/presetIdx 는 key 파싱 또는 인자.
   단계:
     a) newSlot.slotId 가 이미 존재 → 원본 그대로 반환(방어, no-op).
     b) slots' = [...slots, newSlot]   // slots 배열 순서는 전역순서를 결정하지 않음
     c) presets': (camIdx,presetIdx) preset 있으면 coveredSlotIds 끝에 slotId append;
        없으면 { camIdx, presetIdx, label:`${camIdx}:${presetIdx}`, coveredSlotIds:[slotId] } 신규 push
     d) base = [...globalIndex].sort(byGlobalIdx)
        pos = clamp(atGlobalIdx, 1, base.length+1) - 1
        base.splice(pos, 0, { slotId, camIdx, presetIdx })   // globalIdx 는 재부여
        globalIndex' = base.map((g,i) => ({ ...g, globalIdx:i+1 }))
     e) return { ...artifact, slots:slots', presets:presets', globalIndex:globalIndex' }
```
- `insertSlotAt`가 `rebuildGlobalIndex`를 **재사용하지 않는 이유**: rebuild는 coveredSlotIds 순으로 정규정렬 → 사용자가 지정한 전역 중간위치를 무시함. 중간삽입은 명시적 splice 가 정확. (기존 수동매핑 계열과 동일 철학.)

### B.3 신규 슬롯 기본값(리더 게이트 G-2 확인 대상)
- `slotId`: `nextSlotId(...)`.
- `zone`: `cam{camIdx}`(기존 컨벤션).
- `roiByPreset`: `{ [key]: { x:0.45, y:0.45, w:0.1, h:0.1 } }` — **화면 중앙 소형 rect**. 추가 직후 요구 A(Ctrl+드래그)로 위치·크기 조절.
- `plateRoiByPreset`/`floorRoiByPreset`: 미포함(optional). floor min4 제약 무관.
- `atGlobalIdx` 기본값: 현재 `globalIndex.length + 1`(맨 끝). 입력창에서 1..N+1 지정.

### B.4 UI(index.html) — roi-edit-bar 재사용
- `.roi-edit-bar`(index.html:113~119)에 요소 2개 추가(기존 버튼 패턴 동일):
  - `<input id="slot-insert-idx" type="number" min="1" title="삽입할 전역 인덱스(1..N+1)">`
  - `<button id="slot-add" title="현재 프리셋에 주차면 추가(전역 인덱스 중간삽입)">추가</button>`
- app.js `wire()`(1197~) 배선: `$('slot-add').addEventListener('click', addSlot)`.
- `addSlot()` 신규(app.js):
  ```
  if (!state.mapping) → #map-msg "표시된 산출물 없음" ; return
  key = presetKey(cam,preset)
  id = nextSlotId(state.mapping, cam, preset)
  rect = { x:0.45,y:0.45,w:0.1,h:0.1 }
  newSlot = { slotId:id, zone:`cam${cam}`, roiByPreset:{ [key]: rect } }
  N = (state.mapping.globalIndex??[]).length
  at = clamp(Number(#slot-insert-idx.value)||N+1, 1, N+1)
  state.mapping = insertSlotAt(state.mapping, at, newSlot)   // camIdx/presetIdx = cam/preset
  state.selectedSlotId = id; markDirty()
  drawRoiOverlay(); renderSlotList(); renderSelectionInfo()
  ```
- 추가 직후 슬롯이 선택되어 8핸들 표시 → 사용자가 Ctrl+드래그로 배치 → `저장`.

### B.5 저장(요구 A·B 공통)
- 기존 `저장`(`#map-save` → `saveMapping()` → PUT) 그대로. 신규 슬롯 포함 artifact 가 `SetupArtifactSchema`·`validateCoverage` 통과해야 함(§B.6 불변식이 보장).

### B.6 QA 불변식(insertSlotAt / nextSlotId — vitest 대상)
`insertSlotAt`:
1. **삽입 위치**: 신규 슬롯 globalIdx === clamp(atGlobalIdx). 
2. **이후 밀림**: at 이상이던 기존 slotId 들의 globalIdx 정확히 +1, at 미만은 불변.
3. **coverage**: `validateCoverage(next.globalIndex, next.slots).ok === true`(집합 동일).
4. **1..N 고유**: `validateManualIndex(next.globalIndex).ok === true`.
5. **중복 없음**: 이미 존재하는 slotId 삽입 시 no-op(원본 반환), slots 길이·globalIndex 불변.
6. **positionIdx 정합**: 대상 preset.coveredSlotIds 말미에 slotId, `buildMappingRows`의 positionIdx 가 연속.
7. **preset 부재 케이스**: 산출물에 (cam,preset) preset 없을 때 신규 preset 생성 + coveredSlotIds=[slotId].
8. **클램프**: at<1→1, at>N+1→N+1.
9. **불변성**: 원본 artifact.slots/globalIndex 미변형(참조·값).

`nextSlotId`:
10. 결번(s2 삭제) 있어도 기존 slotId 와 **충돌 없음**, 형식 `c{cam}p{preset}s{N}`.
11. 해당 preset 슬롯 0개 → s1.

`moveRect`:
12. 경계 내 평행이동(w,h 유지), 좌/상단 경계서 x/y 클램프하되 **w,h 불변**, 우/하단서 x≤1−w·y≤1−h.

`hitTestRectHandle`:
13. 코너 정확히 위→해당 코너, 변 근접(코너 제외)→변, 내부→'in', 외부→null; tol 경계값(≤) 히트; tolX/tolY 비대칭.

**DOM 배선(vitest 밖 — 수동확인 범위, QA 리포트에 명시)**:
- Ctrl+드래그 리사이즈/이동 실제 반응, 8핸들 렌더, Ctrl 없을 때 기존 floor/선택 정상, `추가` 버튼 → 슬롯 생성·선택·삽입위치 반영, `저장` 성공(슬롯/전역 카운트 증가). Play 모드(뷰어 브라우저)에서 육안 확인.

---

## 변경 파일 목록

| 파일 | 변경 | 하위호환 | 리스크 |
|---|---|---|---|
| `web/core.js` | **신규** `moveRect`, `hitTestRectHandle`, `nextSlotId`, `insertSlotAt` export | 순수 가산, 기존 export 무변경 | 낮음 |
| `web/core.d.ts` | 위 4함수 타입 선언 추가(기존 `ArtifactLike`/`NormalizedRect` 재사용) | 가산 | 낮음 |
| `web/app.js` | mousedown Ctrl 분기, mousemove/mouseup kind 스위치, `hitTestVpd` 래퍼, `drawVpdHandles`(또는 `drawHandles` 확장), `addSlot`, wire 배선, import 추가(`moveRect`/`hitTestRectHandle`/`nextSlotId`/`insertSlotAt`), `resizeRect`/`updateSlotRoi` `[미사용]`→사용. (권고) 휴면 `hitTestHandle`/`hitTestEdge` 제거 | 기존 인터랙션 보존(Ctrl 없을 때 동일) | 중 — mousedown 분기 순서·Ctrl 게이팅이 핵심 |
| `web/index.html` | `.roi-edit-bar`에 `#slot-insert-idx`·`#slot-add` 추가 | 가산 | 낮음 |
| `web/app.css` | (선택) VPD 핸들·삽입 입력 폭 스타일 소량 | 가산 | 낮음 |
| `test/*.test.ts` | `moveRect`/`hitTestRectHandle`/`nextSlotId`/`insertSlotAt` 테스트(roiEdit.test.ts 패턴, `validateCoverage`/`validateManualIndex` 교차검증) | 신규 | 낮음 |
| `src/**` | **무변경**(PUT `/mapping` 계약 재사용) | — | — |

### 시그니처 변경/추가 요약
- 추가만 있음(기존 export·서버 계약 불변). `insertSlotAt`/`removeSlot`는 동일 `artifact→artifact` 불변 패턴.

---

## MCP 도구 vs LLM 두뇌 경계
- 본 작업은 **뷰어 프런트(결정형 UI 편집)** 전용. 히트테스트·좌표변환·인덱스 재부여는 전부 **순수 결정 로직**(수치 반복·경계 클램프) → core.js 순수함수 + vitest. **LLM 두뇌 개입 없음**(맥락판단/예외추론 불필요). 경계 판단: 전량 결정형.

---

## 리더 게이트(진행 전 확인 요청)
- **G-1 (중간삽입 축)**: `atGlobalIdx`를 **전역 globalIdx 기준**으로 확정(§B.1). preset-내 positionIdx 기준 아님. 이의 없으면 이대로 진행. *(설계자 판단: 전역 기준이 기존 수동매핑 체계와 정합 — 기본 채택)*
- **G-2 (신규 슬롯 기본값)**: 기본 rect `{0.45,0.45,0.1,0.1}`(중앙 소형), zone `cam{cam}` 확정 여부. *(명백 — 이견 없으면 자체 확정)*
- **G-3 (휴면 헬퍼)**: `hitTestHandle`/`hitTestEdge`(app.js:290,314) — 순수 `hitTestRectHandle`로 대체되어 고아화. **제거 권고** vs 존치. 주석상 "재편집 복구 대비"라 제거가 규칙3에 부합하나, 데드코드 보존 원칙과 경계 → 리더 결정.
- **G-4 (macOS metaKey)**: Windows 주 타깃. `e.metaKey` OR 포함할지(가산). *(포함 권고, 미미)*

이견/추가 지시 없으면 구현자는 §A·§B 순서(core 순수함수 → vitest → app.js/html 배선 → 수동확인)로 진행.
