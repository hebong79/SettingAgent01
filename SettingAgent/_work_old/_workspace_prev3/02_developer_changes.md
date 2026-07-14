# 02 구현 변경 요약 — floor ROI(4점 사변형) 정점 개별 드래그 편집 전환

작성: 구현자(developer) / 대상: qa-tester, documenter
근거 설계서: `_workspace/01_architect_plan.md`

## 변경 파일 목록
- `SettingAgent/web/core.js` — 순수 함수 3개 추가.
- `SettingAgent/web/core.d.ts` — 타입 선언 3개 추가.
- `SettingAgent/web/app.js` — import·dragState·drawRoiOverlay·핸들/히트테스트·wireOverlayEditing 결선 전환 + orphan 주석.

테스트 파일은 만들지 않음(qa-tester 담당).

## 1. core.js (§2 준수)

`updateSlotRoi` 바로 아래에 floor 편집 순수 함수 3개 신규 추가(차량용 resizeRect/clamp01Rect/updateSlotRoi 무변경, 삭제 없음).

### `hitTestQuadVertex(quad, nx, ny, tolX, tolY) -> 0|1|2|3|null`
- 방어: `!Array.isArray(quad) || quad.length < 4` → null.
- i=0..3 루프, `Math.abs(nx-quad[i].x) <= tolX && Math.abs(ny-quad[i].y) <= tolY` 인 **첫** i 반환, 없으면 null.
- DOM 미참조(tolX/tolY 는 호출측 주입).

### `moveQuadVertex(quad, index, ndx, ndy) -> newQuad`
- 방어: quad 부적합/index 0..3 밖 → `quad.slice()`(배열이면) 또는 원본 반환(변형 없음).
- `quad.map((p,i) => i===index ? {x:clamp01(p.x+ndx), y:clamp01(p.y+ndy)} : p)`. clamp01 = `Math.min(1,Math.max(0,v))` (점 단위 0..1).
- 새 배열 반환(불변). 나머지 정점은 동일 객체 참조 복사 → 직교 정점 값·참조 불변.
- rect 처럼 역전/최소폭 보정 없음(사변형 정점 자유 이동이 요구사항, 설계 §2.2).

### `updateSlotFloorRoi(artifact, slotId, key, quad) -> artifact`
- `updateSlotRoi` 미러: `slots.map(s => s.slotId===slotId ? {...s, floorRoiByPreset:{...s.floorRoiByPreset,[key]:quad}} : s)`, `{...artifact, slots}`.
- slots 집합·globalIndex 참조 동일성 유지(교체 대상 slot 만 신규 객체).

## 2. core.d.ts (§3 준수)
`updateSlotRoi` 선언 아래에 3함수 타입 추가. 설계서 시그니처 그대로:
- `hitTestQuadVertex(...): 0|1|2|3|null`
- `moveQuadVertex(...): NormalizedPoint[]`
- `updateSlotFloorRoi<T extends ArtifactLike>(...): T`
- 기존 `SlotLike.floorRoiByPreset`(NormalizedPoint[] | NormalizedQuad) 재사용. `npx tsc --noEmit --strict web/core.d.ts` 통과.

## 3. app.js (§4 준수)

### 3.1 import (app.js 상단)
- `hitTestQuadVertex, moveQuadVertex, updateSlotFloorRoi` 추가.
- `resizeRect, updateSlotRoi` 는 이제 app.js 에서 미사용(차량 드래그 핸들러가 floor 로 대체됨). **삭제하지 않고** 각 줄에 `// [미사용] 차량 bbox 편집 비활성 — 재편집 복구 대비 보존.` 주석 부착(A안 취지 일관성). — 설계 대비 편차: §5 A안은 app.js 3함수(hitTestHandle/hitTestEdge/drawHandles) 보존만 명시했으나, 이 두 import 도 동일 변경으로 고아가 되어 같은 방침(보존+주석)으로 처리. 근거: 재편집 복구 시 import 재추가 부담 제거, 차량 편집 경로를 하나의 보존 번들로 유지.

### 3.2 dragState (app.js:46~48)
- 주석 갱신: `// { kind:'floorVertex', index, slotId, key, last:{nx,ny} } | null`. 상단 주석 "크기 조정 핸들 드래그 상태" → "floor quad 정점 드래그 상태". HANDLE_PX 무변경.

### 3.3 drawRoiOverlay (차량 rect 블록 / floor 블록)
- 차량 rect: `if (selected) drawHandles(...)` 호출 **제거** → `// 차량 rect 는 선택 시 색/굵기만 강조(핸들·리사이즈 없음 — floor quad 로 편집 전환).` 주석 대체. 색(#ff4d4d)·굵기(4)·라벨 강조는 유지.
- floor 블록: quad stroke 직후 `if (selected) drawQuadHandles(ctx, pts);` 추가(pts=toPixelQuad 결과).

### 3.4 drawQuadHandles(ctx, pts) 신규 (drawHandles 위)
- pts 4×{px,py} 각 점에 HANDLE_PX 반경 흰 사각 fill + 초록(#39ff14) 테두리. drawHandles(차량, #ff4d4d 테두리·rect 수치 입력)와 형태·색 상이하여 신규 함수(설계 §4.3).

### 3.5 hitTestFloorVertex(nx,ny) 신규 (hitTestHandle 위)
- 가드: `state.selectedSlotId && state.mapping && $('roi-floor').checked` 아니면 null(요구사항 #4, floor 레이어 표시 중일 때만).
- 선택 슬롯 `floorRoiByPreset[key]`(key=현재 preset) 없으면 null.
- `tolX=HANDLE_PX/(overlay.width||frame.clientWidth||1)`, `tolY=HANDLE_PX/(overlay.height||frame.clientHeight||1)` → `hitTestQuadVertex(quad,nx,ny,tolX,tolY)` 반환.

### 3.6 orphan 처리(A안 확정)
- `drawHandles`, `hitTestHandle`, `hitTestEdge`(app.js 차량용 UI 함수) **삭제 안 함**. 각 상단에 `// [미사용] 차량 bbox 편집 비활성 — floor 정점 편집 전환으로 호출 제거됨(차량 bbox 재편집 복구 대비 보존).` 주석 추가.

### 3.7 wireOverlayEditing (§4.5)
- **mousedown**: `hitTestHandle`/`hitTestEdge`(차량) 호출 제거. `const vi = hitTestFloorVertex(nx,ny)`; `vi != null && state.selectedSlotId` 이면 `dragState = {kind:'floorVertex', index:vi, slotId:state.selectedSlotId, key, last:{nx,ny}}; e.preventDefault(); return;`. 미히트 시 기존 `hitTestSlots` 선택/해제 로직 그대로 유지(요구사항 #3).
- **mousemove**: `cur = slot.floorRoiByPreset[dragState.key]`(없으면 return) → `next = moveQuadVertex(cur, dragState.index, ndx, ndy)` → `state.mapping = updateSlotFloorRoi(state.mapping, dragState.slotId, dragState.key, next)` → `dragState.last={nx,ny}` → drawRoiOverlay. (차량 resizeRect/updateSlotRoi 경로 → floor 경로 대체.)
- **mouseup**: 변경 없음(`dragState=null; markDirty(); drawRoiOverlay()`). 주석만 "정점 이동 확정" 으로 갱신.

## 4. 검증(구현자 단계)
- `node --check web/core.js` / `node --check web/app.js` → SYNTAX OK.
- `npx tsc --noEmit --strict web/core.d.ts` → exit 0.
- 유닛테스트·typecheck(전체)·수동 동작 확인은 qa-tester 담당(설계 §6 케이스: moveQuadVertex/hitTestQuadVertex/updateSlotFloorRoi).

## 5. 설계 대비 편차 요약
1. (편차) app.js import `resizeRect`/`updateSlotRoi` 를 삭제 대신 주석 보존 처리 — §5 A안 취지(차량 편집 경로 보존) 일관성. 상기 3.1 근거.
   - 그 외 모든 구현은 설계서 §2~§5 를 그대로 따름. 서버·산출물 스키마 무변경(floorRoiByPreset 기존 필드 재사용).
