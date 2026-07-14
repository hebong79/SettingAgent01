# 01 설계서 — floor ROI(4점 사변형) 정점 개별 드래그 편집 전환

작성: 설계자(architect) / 대상: developer, qa-tester, documenter
범위: SettingAgent 뷰어의 ROI 편집 대상을 vpd 차량 bbox → floor ROI quad 로 전환, 4꼭짓점 개별 드래그.

## 0. 결론 요약 (경계 판단)
- 전부 프런트엔드 순수 로직 + DOM 결선. **MCP 두뇌/도구 경계와 무관**(REST·PTZ 루프 미개입). 순수 함수는 core.js(유닛테스트), DOM/state 는 app.js.
- 신규 순수 함수 3개(core.js) + 타입 3개(core.d.ts) + app.js 결선 4곳 수정. 외과적.

## 1. 단계별 계획 → 검증

1. core.js 에 순수 함수 3개 추가 → 검증: 신규 유닛테스트(§6) 통과.
2. core.d.ts 에 타입 선언 3개 추가 → 검증: `npm run typecheck`(뷰어) 통과.
3. app.js drawRoiOverlay: 선택 슬롯 floor quad 4정점 핸들 렌더(`drawQuadHandles`), 차량 rect 의 `drawHandles` 호출 제거 → 검증: 수동 동작(선택 시 floor 초록 quad 꼭짓점에 흰 핸들 4개, 차량 rect 엔 핸들 없음).
4. app.js `hitTestFloorVertex(nx,ny)` 추가(선택 슬롯 floor quad + tol → core `hitTestQuadVertex` 호출) → 검증: §6 간접(core 함수) + 수동.
5. app.js wireOverlayEditing: mousedown/mousemove/mouseup 를 floor 정점 드래그로 전환(dragState 형태 변경) → 검증: 수동(정점 드래그로 사변형 변형, 미저장 표시, 저장 후 유지).
6. orphan 처리 방침 적용(§5) → 검증: 유지 결정이면 무변경, 미사용 경고 없음 확인.

- 영향 파일: `SettingAgent/web/core.js`, `SettingAgent/web/core.d.ts`, `SettingAgent/web/app.js`, `SettingAgent/test/roiEdit.test.ts`(테스트 추가). 서버·산출물 스키마 무변경(floorRoiByPreset 기존 필드 재사용).

## 2. core.js 신규 순수 함수 (정확한 시그니처·알고리즘)

quad 는 4×`{x,y}` 정규화(0..1) 배열. 순서 불변, 인덱스 0..3 고정.

### 2.1 `hitTestQuadVertex(quad, nx, ny, tolX, tolY) -> 0|1|2|3|null`
- 알고리즘: i=0..3, `Math.abs(nx-quad[i].x) <= tolX && Math.abs(ny-quad[i].y) <= tolY` 인 **첫 번째** i 반환(없으면 null). 사각 허용범위(hitTestHandle 과 동일한 x/y 분리 tol 방식).
- 방어: `!Array.isArray(quad) || quad.length < 4` → null.
- tolX/tolY 는 호출측(app.js)에서 `HANDLE_PX/overlay.width`, `HANDLE_PX/overlay.height` 로 산출해 주입(core 는 DOM 미참조).

### 2.2 `moveQuadVertex(quad, index, ndx, ndy) -> newQuad`
- 알고리즘: 새 배열 생성, `index` 정점만 `{x: clamp01(x+ndx), y: clamp01(y+ndy)}`, 나머지 정점은 **동일 참조 복사(불변, 값 불변)**.
- clamp: 각 좌표 `Math.min(1, Math.max(0, v))` (점 단위 0..1). rect 처럼 최소 폭/역전 보정 없음 — 사변형은 정점 자유 이동이 요구사항.
- 방어: index 가 0..3 밖이거나 quad 부적합이면 원본 quad 얕은복사 반환(변형 없음).
- 불변: 원본 quad 및 나머지 정점 객체 불변(직교 정점 불변 검증 대상).

### 2.3 `updateSlotFloorRoi(artifact, slotId, key, quad) -> artifact`
- `updateSlotRoi` 미러. 대상 slot 의 `floorRoiByPreset[key]` 만 quad 로 교체(불변). slots 집합·globalIndex·기타 필드 불변.
- 구현: `slots.map(s => s.slotId===slotId ? {...s, floorRoiByPreset:{...s.floorRoiByPreset, [key]:quad}} : s)`, `{...artifact, slots}`.
- globalIndex 참조 동일성 유지(`next.globalIndex === artifact.globalIndex`).

## 3. core.d.ts 신규 타입 (추가 필요)
```ts
export function hitTestQuadVertex(
  quad: NormalizedPoint[] | null | undefined,
  nx: number, ny: number, tolX: number, tolY: number,
): 0 | 1 | 2 | 3 | null;
export function moveQuadVertex(
  quad: NormalizedPoint[], index: number, ndx: number, ndy: number,
): NormalizedPoint[];
export function updateSlotFloorRoi<T extends ArtifactLike>(
  artifact: T, slotId: string, key: string, quad: NormalizedPoint[],
): T;
```
- `SlotLike.floorRoiByPreset` 는 이미 선언됨(재사용). 반환 quad 타입은 입력부담 완화를 위해 `NormalizedPoint[]` 로 느슨하게(기존 관례 §core.d.ts 주석과 동일).

## 4. app.js 수정 지점 (외과적)

### 4.1 dragState 형태 변경 (app.js:48)
- 기존: `{ handle, slotId, key, startRect, last }`.
- 신규: `{ kind:'floorVertex', index, slotId, key, last:{nx,ny} }`. 주석도 갱신.

### 4.2 drawRoiOverlay floor 블록 (app.js:189~200)
- floor quad 그린 뒤, `selected && showFloor && fquad` 이면 `drawQuadHandles(ctx, pts)` 호출(pts=toPixelQuad 결과).
- 차량 rect 블록(app.js:180) 의 `if (selected) drawHandles(...)` **제거**(차량 rect 는 선택 시 색/굵기만 강조, 핸들 없음). 라벨/색 강조는 유지.

### 4.3 신규 `drawQuadHandles(ctx, pts)` (drawHandles 옆)
- pts(4×{px,py}) 각 점에 `HANDLE_PX` 반경 흰 사각 + 초록(#39ff14) 테두리. drawHandles 재사용 대신 **신규**(입력이 rect 4수치 vs 픽셀점 배열로 형태 상이, 테두리색도 floor 계열로 구분). ~10줄.

### 4.4 신규 `hitTestFloorVertex(nx,ny) -> 0|1|2|3|null` (hitTestHandle 옆)
- 조건 가드: `state.selectedSlotId && state.mapping && $('roi-floor').checked` 아니면 null (요구사항 #4: floor 레이어 표시 중일 때만).
- 선택 슬롯의 `floorRoiByPreset[key]`(key=현재 preset) 없으면 null.
- `tolX=HANDLE_PX/(overlay.width||frame.clientWidth||1)`, `tolY=HANDLE_PX/(overlay.height||frame.clientHeight||1)` 계산 후 `hitTestQuadVertex(quad, nx, ny, tolX, tolY)` 반환.

### 4.5 wireOverlayEditing 결선 (app.js:1017~1065)
- **mousedown**: `hitTestHandle`/`hitTestEdge`(차량) 호출 **제거**. 대신 `const vi = hitTestFloorVertex(nx, ny)`. `vi != null && state.selectedSlotId` 이면 `dragState = {kind:'floorVertex', index:vi, slotId:state.selectedSlotId, key, last:{nx,ny}}; e.preventDefault(); return;`. 정점 히트 아니면 기존 슬롯 선택/해제 로직(hitTestSlots) 그대로 유지(요구사항 #3: 클릭 선택 계속 동작).
- **mousemove**: `dragState` 있을 때 `ndx/ndy` 계산 → 대상 slot 의 `floorRoiByPreset[dragState.key]` 조회(없으면 return) → `next = moveQuadVertex(cur, dragState.index, ndx, ndy)` → `state.mapping = updateSlotFloorRoi(state.mapping, dragState.slotId, dragState.key, next)` → `dragState.last={nx,ny}` → drawRoiOverlay.
- **mouseup**: 동일(`dragState=null; markDirty(); drawRoiOverlay()`). 변경 없음.

## 5. bbox 편집 비활성 · orphan 코드 처리 방침 (CLAUDE.md #3 · 리더 확인 포인트)

내 변경으로 **미사용(orphan)** 이 되는 것: `hitTestHandle`(app.js:255), `hitTestEdge`(app.js:278), `drawHandles`(app.js:232) — mousedown/drawRoiOverlay 에서 호출 제거됨.

- **유지(삭제 안 함) 대상 (확정, 사용자 지침)**: 차량 rect 순수 함수 `resizeRect`/`clamp01Rect`/`updateSlotRoi` 및 그 유닛테스트(roiEdit.test.ts) — "기존 bbox 편집 로직은 손대지 않음". 삭제 금지.
- **app.js orphan 3함수 처리 — 리더 확인 필요(2안 제시, 조용히 선택 안 함)**:
  - (A) 유지: 삭제하지 않고 각 함수 상단에 `// [미사용] floor 정점 편집 전환으로 호출 제거됨(차량 bbox 재편집 복구 대비 보존).` 주석만 추가. 장점: 되돌리기 쉬움, 사용자 "bbox 로직 손대지 않음" 취지에 부합. 단점: 데드코드 잔존.
  - (B) 제거: hitTestHandle/hitTestEdge/drawHandles(app.js 함수) 삭제. CLAUDE.md #3 "내 변경으로 고아된 import/함수는 제거" 에 부합. 단, 이들은 app.js 내부 UI 함수(순수 로직 아님)이며 테스트 대상 아님.
  - **설계자 권고: (A) 유지 + 주석**. 근거: 사용자가 "기존 bbox 편집 로직은 손대지 않음"을 명시했고, 이 3함수는 bbox 편집 로직의 일부라 (B)가 취지와 충돌할 소지. HANDLE_PX 상수는 drawQuadHandles/hitTestFloorVertex 가 계속 사용하므로 어느 안이든 유지.
  - **리더 결정 요청**: (A)/(B) 중 택일. 미회신 시 (A) 진행.

## 6. 검증 가능한 유닛테스트 케이스 (roiEdit.test.ts 추가, vitest)

import 에 `hitTestQuadVertex, moveQuadVertex, updateSlotFloorRoi` 추가. 공용 quad:
`[{x:0.2,y:0.2},{x:0.8,y:0.2},{x:0.8,y:0.8},{x:0.2,y:0.8}]`.

### moveQuadVertex
- `move index0 (+0.1,+0.1)` → quad[0]={0.3,0.3}, quad[1..3] 값 불변(직교 정점 불변).
- `move index2 (-0.1,0)` → quad[2].x=0.7, quad[2].y 불변, 나머지 불변.
- 각 index(0..3) 이동 시 해당 정점만 바뀌는지(4케이스, 루프 또는 개별).
- clamp 상한: index1 (+0.5,0) → x=1(=clamp), 미초과.
- clamp 하한: index0 (-0.5,-0.5) → x=0,y=0.
- 불변성: 반환 배열 !== 입력 배열, 입력 quad 원본 값 불변.

### hitTestQuadVertex
- 정확히 정점 위(nx=0.2,ny=0.2, tol=0.02) → 0.
- tol 내 근접(nx=0.205,ny=0.205, tolX=tolY=0.02) → 0(히트).
- tol 밖(nx=0.3,ny=0.3, tol=0.02) → null(미스).
- 중앙(0.5,0.5) → null.
- 마지막 정점 히트(nx=0.2,ny=0.8) → 3.
- 방어: quad=null → null, 길이<4 → null.
- tolX/tolY 비대칭(tolX=0.05,tolY=0.001)일 때 x는 통과 y는 실패 → null.

### updateSlotFloorRoi
- 대상 slot floorRoiByPreset[key] 만 교체, 타 슬롯 floor 불변.
- globalIndex 참조 동일(`next.globalIndex === a.globalIndex`).
- 원본 artifact 불변(입력 slot 의 quad 원본 값 유지).
- 대상 slot 의 roiByPreset(차량) 불변(floor 만 교체).

## 7. 가정 / 미해결
- 가정: floor quad 는 항상 4점(4정점 핸들). 산출물이 4점 아닌 경우는 발생하지 않음으로 간주(방어는 length<4 → hit null 로만, 렌더는 기존 toPixelQuad 그대로).
- 가정: 현재 preset key(`presetKey(state.cam,state.preset)`)에 floor quad 없으면 편집 대상 아님(요구사항 #4) — hitTestFloorVertex 가 null 반환으로 자연 비활성.
- 미해결(리더 확인): §5 orphan (A)/(B) 택일.
- 범위 밖 명시: 변(edge) 이동·quad 전체 이동·정점 추가/삭제는 이번 범위 아님(요구사항 #2).
