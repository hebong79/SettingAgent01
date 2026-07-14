# 02 구현 변경 요약 — 차량 ROI 박스 "변(edge) 드래그" 리사이즈

설계서 `01_architect_plan.md` 그대로 구현. 편차 없음. web/ 은 순수 JS(브라우저 ESM)라 tsc 대상 아님 → `node --check` 로 구문 검증(통과).

## 변경 파일

### 1. `web/core.js` — `resizeRect(rect, handle, ndx, ndy)`
- 위치: `switch (handle)` 블록(원 373줄), `case 'nw'` 바로 위에 4개 case 삽입.
- 추가 내용:
  ```js
  case 'n': top += ndy; break;
  case 's': bottom += ndy; break;
  case 'w': left += ndx; break;
  case 'e': right += ndx; break;
  ```
- 시그니처·반환·이후 min/abs 정규화·`clamp01Rect` 호출 전부 불변. 뒤집힘·경계·최소폭은 기존 정규화가 흡수(추가 방어코드 없음).

### 2. `web/app.js` — `hitTestEdge(nx, ny)` 신규
- 위치: `hitTestHandle` 반환부(원 275줄, `return null; }`) 바로 아래, `selectSlot` 위.
- 시그니처: `function hitTestEdge(nx, ny)` → `'n'|'s'|'e'|'w'|null`.
- `hitTestHandle` 과 동일하게 선택 슬롯 vrect(`roiByPreset[key]`), `w/h`, `tol=HANDLE_PX/w`, `tolY=HANDLE_PX/h` 산출.
- 판정: 각 변에 대해 직교거리 ≤ tol/tolY AND 평행축이 선분 범위 내(`inX = left+tol..right-tol`, `inY = top+tolY..bottom-tolY` 로 코너 구간 배제). 순서 n→s→w→e.
- 코너는 mousedown 에서 `hitTestHandle` 이 먼저 호출되고, 여기서도 inX/inY 로 코너 구간을 배제해 이중 안전.
- 얇은 박스(폭<2·tol)는 inX 항상 false → 상/하변 무히트(무해, 코너로 조작). 별도 분기 없음.

### 3. `web/app.js` — `wireOverlayEditing` mousedown (원 998줄)
- `const handle = hitTestHandle(nx, ny);` → `let handle = hitTestHandle(nx, ny);` 로 변경.
- 바로 아래 `if (!handle) handle = hitTestEdge(nx, ny);` 한 줄 추가.
- 이후 `if (handle && state.selectedSlotId)` dragState 시작 블록, 슬롯 선택/해제, mousemove/mouseup 전부 무수정(handle 값 범위만 n/s/e/w 로 확장).

## 불변 확인(설계 준수)
- 선택 슬롯 색상/굵기, `drawHandles`, `drawRoiOverlay`, `updateSlotRoi`, `markDirty`, dragState 구조, 기존 코너 로직 미변경.
- 커서 피드백((e)항)은 설계 권고대로 이번 범위 제외.

## 검증
- `node --check web/core.js` / `node --check web/app.js` → SYNTAX OK.
- resizeRect 순수함수 유닛테스트(n/s/e/w) 및 수동 동작확인은 다음 단계 qa-tester 담당.

## 영향도(간단)
- `resizeRect` 는 mousemove 에서 `dragState.handle` 를 그대로 넘기므로 case 확장만으로 변 드래그가 실시간 반영됨. 기존 코너 호출 경로 영향 없음.
- 순수 프론트엔드 캔버스 상호작용. MCP/REST/타입(@parkagent/types) 영향 없음.
