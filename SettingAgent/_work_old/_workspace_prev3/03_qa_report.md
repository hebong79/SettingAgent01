# 03 QA 검증 보고 — floor ROI(4점 quad) 정점 개별 드래그 크기조정

작성: 검증자(qa-tester) / 대상: developer, documenter
근거: `_workspace/01_architect_plan.md`(§6 검증 케이스), `_workspace/02_developer_changes.md`
검증 방식: vitest 유닛테스트(순수 함수) + 경계면 교차 비교(app.js 소비 코드 정적 확인) + typecheck.

## 1. 실행 명령 및 결과

| 명령 | 결과 |
|------|------|
| `npx vitest run` (전체) | **56 파일 / 411 tests 전부 PASS, 0 FAIL** |
| `npx vitest run test/roiEdit.test.ts` (대상 파일) | **55 tests PASS** (기존 32 → +23 신규 floor 케이스) |
| `npm run typecheck` (= `tsc -p tsconfig.json --noEmit`) | **exit 0** (에러 없음) |
| `npx tsc --noEmit --strict web/core.d.ts` (선언 정합) | **exit 0** |

- 회귀: 기존 410개 테스트 전부 통과 유지(차량 rect resizeRect/updateSlotRoi 등 기존 로직 무영향 확인).
- 신규 추가 후 전체 411 tests(기존 388 + 신규 23) 통과.

## 2. 추가한 테스트 (test/roiEdit.test.ts, 신규 describe 3개 / 23 케이스)

공용 quad: `[{0.2,0.2},{0.8,0.2},{0.8,0.8},{0.2,0.8}]` (설계 §6). import 에 `hitTestQuadVertex, moveQuadVertex, updateSlotFloorRoi` 추가.

### moveQuadVertex (7)
- index0 (+0.1,+0.1) → quad[0]≈{0.3,0.3}, 나머지 3정점 값 불변.
- index2 (-0.1,0) → quad[2].x=0.7, quad[2].y 불변, 나머지 불변.
- 각 index(0..3) 루프 이동 → 해당 정점만 변화, 나머지 3정점 **값·참조 모두 불변**(불변 복사 검증).
- clamp 상한: index1 (+0.5,0) → x=1, 미초과.
- clamp 하한: index0 (-0.5,-0.5) → x=0,y=0.
- 불변성: 반환 배열 !== 입력 배열, 입력 quad 배열·정점 객체 원본 값 미변형, 이동 정점은 신규 객체.
- 방어: index 범위 밖(4) → 원본 얕은복사(값 동일, 새 배열).

### hitTestQuadVertex (10)
- 정점0 정확 위치 → 0 / tol 내 근접(0.205,0.205) → 0 / tol 밖(0.3,0.3) → null / 중앙(0.5,0.5) → null.
- 마지막 정점3(0.2,0.8) → 3.
- tol 경계값(|dx|=tol 정확) → 히트(<= 판정 확인).
- tolX/tolY 비대칭(0.05/0.001): x 통과·y 실패 → null.
- 첫 매칭 우선(tol 과대여도 index 오름차순 첫 정점).
- 방어: quad=null → null / 길이<4(삼각형) → null.

### updateSlotFloorRoi (6)
- 대상 slot floorRoiByPreset[1:1]만 교체, 다른 key(1:2)는 동일 참조 유지.
- 다른 slot(f2) 동일 참조 유지, slots 길이 불변.
- globalIndex 참조 동일(`next.globalIndex === a.globalIndex`).
- 대상 slot 의 차량 roiByPreset 동일 참조(floor 만 교체).
- 원본 artifact 미변형(입력 slot quad 원본 값 유지).
- **경계면 shape**: moveQuadVertex 결과(4×{x,y})가 updateSlotFloorRoi 저장 shape과 일치(app.js mousemove 경로 재현: 저장값 === moved, length 4, 각 점 x/y 숫자).

## 3. 경계면 교차 비교 (moveQuadVertex 반환 shape ↔ app.js 소비)

app.js 정적 확인 결과 shape 전 구간 일치. 불일치 없음.

- `moveQuadVertex(cur, index, ndx, ndy)` → `4×{x,y}`.
- app.js:1078~1079 mousemove: `next = moveQuadVertex(cur, ...)` → `updateSlotFloorRoi(state.mapping, slotId, key, next)` 로 그대로 저장.
- app.js:192~194 drawRoiOverlay: `slot.floorRoiByPreset?.[key]` → `toPixelQuad(fquad, overlay.width, overlay.height)` (`{x,y}`→`{px,py}` 매핑).
- app.js:203 `drawQuadHandles(ctx, pts)` 는 `pts`(4×`{px,py}`) 소비 — toPixelQuad 출력과 일치.
- `key` 는 mousedown/mousemove/hitTestFloorVertex 모두 `presetKey(state.cam, state.preset)` 로 일관.
- 결론: `{x,y}` 정규화 배열 ↔ core 순수함수 ↔ `{px,py}` 픽셀 배열 경계에서 필드명·차수(4점)·좌표계 변환 모두 정합.

## 4. 수동 동작확인 필요 (유닛 대상 아님 — DOM 의존, 통과 위장 금지)

app.js `hitTestFloorVertex`/`drawQuadHandles`/mousedown·mousemove·mouseup 결선은 canvas/`$('roi-floor')`/`overlay`/`state` DOM·전역 의존이라 유닛테스트로 커버 불가. 아래는 뷰어 실행 후 **수동 확인 필요**(현재 미실행):

1. floor 레이어 ON + 슬롯 선택 시 해당 floor quad 4정점에 흰 사각 + 초록(#39ff14) 핸들 4개 표시.
2. 정점을 드래그하면 그 정점만 이동해 사변형이 변형(나머지 3정점 고정), 화면 사변형이 즉시 갱신.
3. 차량 bbox(rect)는 선택 시 색/굵기만 강조되고 리사이즈 핸들 없음 → **차량 bbox 편집 불가**(표시·선택만). 클릭 슬롯 선택/해제는 계속 동작.
4. floor 레이어 OFF 또는 현재 preset 에 floor quad 없는 슬롯 → 정점 드래그 비활성(hitTestFloorVertex null).
5. 정점 드래그 후 미저장 표시(markDirty) 및 저장 시 floorRoiByPreset 에 반영·재로드 후 유지.

## 5. 발견 이슈

- **구현 버그 없음.** 설계 §6 케이스 전부 구현이 만족.
- 검증 중 최초 1건 실패(`moveQuadVertex index0` `toEqual({x:0.3})`)는 **테스트 측 부동소수 오차**(0.2+0.1=0.30000000000000004)였고 구현 정상. 파일 기존 관례대로 `toBeCloseTo(_, 6)` 로 수정해 통과. developer 수정 요청 불필요.
- 설계 대비 편차(02 §5: app.js import `resizeRect`/`updateSlotRoi` 를 삭제 대신 주석 보존, orphan A안)는 **런타임/타입 무영향** 확인(typecheck exit 0, 미사용 경고 없음, 전체 테스트 통과). 차량용 순수 함수 및 그 유닛테스트는 무변경 유지.

## 6. 결론

- 순수 로직 3함수(hitTestQuadVertex / moveQuadVertex / updateSlotFloorRoi)는 설계 §6 성공 기준을 **전부 만족**하며 회귀 없음(411/411 PASS, typecheck 0).
- app.js DOM 결선은 §4 수동 항목으로 검증 이관(자동화 불가). 실기 뷰어에서 위 5개 항목 확인 후 최종 완료 처리 권고.
