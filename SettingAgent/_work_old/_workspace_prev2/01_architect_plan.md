# 01 설계서 — 차량 ROI 박스 "변(edge) 드래그" 리사이즈

## 요구 요약
선택 슬롯의 차량 ROI 박스에서 **4개 변(n/s/w/e)** 라인 근처를 클릭·드래그하면 그 변만 이동해 크기 조절. 코너(nw/ne/sw/se)는 기존대로 대각 2변 동시 이동이며 **코너 히트가 변보다 우선**. 선택 슬롯에서만 동작. 최소 변경.

## MCP 경계 판단
순수 프론트엔드 UI 상호작용(캔버스 마우스). LLM 두뇌·MCP 도구·REST 무관. `resizeRect`는 결정형 순수 함수 확장, 히트테스트는 뷰 로직. 외부 호출·타임아웃·백오프 해당 없음.

## 영향 파일/함수
| 파일 | 함수 | 변경 |
|------|------|------|
| `web/core.js` | `resizeRect(rect, handle, ndx, ndy)` (368줄) | switch 에 `n`/`s`/`e`/`w` case 4개 추가. 기존 nw/ne/sw/se·정규화·clamp 로직 불변. |
| `web/app.js` | `hitTestEdge(nx, ny)` **신규**(hitTestHandle 아래, ~275줄) | 변 근접 판정. 코너는 hitTestHandle 이 이미 처리하므로 여기선 코너 제외. |
| `web/app.js` | `wireOverlayEditing` mousedown (994줄) | `hitTestHandle` 우선, null 이면 `hitTestEdge` 시도. dragState 시작 로직 공유. |
| `test/roiEdit.test.ts` | `describe('clamp01Rect / resizeRect')` (150줄) | n/s/e/w 케이스 추가. |

`resizeRect` 반환/시그니처·`updateSlotRoi`·`drawRoiOverlay`·`markDirty`·`drawHandles`·색상 로직(175~180줄)은 **불변**. dragState 구조(`{handle, slotId, key, startRect, last}`) 그대로 재사용 — mousemove(1018줄)/mouseup(1033줄)은 handle 값만 `n/s/e/w`로 넓어질 뿐 수정 불필요.

## (b) core.js resizeRect — n/s/e/w 케이스 수식
좌표계: `left=x, top=y, right=x+w, bottom=y+h`. 델타(ndx,ndy)는 마우스 이동 정규화 델타.
- **n(상변)**: `top += ndy;`  (위/아래 이동 → 높이 변화, 폭 불변)
- **s(하변)**: `bottom += ndy;`
- **w(좌변)**: `left += ndx;`
- **e(우변)**: `right += ndx;`

기존 nw/ne/sw/se 라인 바로 위에 삽입:
```js
case 'n': top += ndy; break;
case 's': bottom += ndy; break;
case 'w': left += ndx; break;
case 'e': right += ndx; break;
```
이후 기존 `Math.min/abs` 정규화 + `clamp01Rect` 가 뒤집힘·경계·최소폭을 그대로 흡수한다(추가 코드 불필요). 예: n 변을 아래로 크게 끌어 `top>bottom` 이 되면 min/abs 로 정규화되어 위/아래가 스왑, clamp 의 MIN(0.001)로 붕괴 방지.

## (c) app.js 변 히트테스트 알고리즘 (hitTestEdge)
전제·좌표계는 `hitTestHandle`(255줄)과 동일: 선택 슬롯 존재, key=presetKey, vrect=roiByPreset[key], `tol=HANDLE_PX/w`(x), `tolY=HANDLE_PX/h`(y). HANDLE_PX=8.

판정(각 변은 "직교 거리 ≤ tol AND 평행축 선분 범위 내"):
```
left=x, right=x+w, top=y, bottom=y+h
// 코너 제외: 선분 범위를 코너 tol 만큼 안쪽으로 좁힘(코너는 hitTestHandle 담당)
inX = nx >= left + tol  && nx <= right - tol
inY = ny >= top  + tolY && ny <= bottom - tolY
if (Math.abs(ny - top)    <= tolY && inX) return 'n'
if (Math.abs(ny - bottom) <= tolY && inX) return 's'
if (Math.abs(nx - left)   <= tol  && inY) return 'w'
if (Math.abs(nx - right)  <= tol  && inY) return 'e'
return null
```
- **직교 근접**: 예 n 변은 `|ny-top|≤tolY`(변까지 수직 거리) AND `inX`(가로 선분 범위 내).
- **코너 제외**: `inX/inY`에서 양끝을 tol/tolY 안쪽으로 좁혀, 코너 히트박스와 겹치는 구간을 변 판정에서 배제 → 코너 우선순위 보장(호출 순서와 이중 안전).
- **얇은 박스 방어**: `right-tol < left+tol`(폭 < 2·tol) 이면 inX가 항상 false → 상/하변 히트 안 됨(무해, 코너로 조작). 별도 분기 불필요.

## (d) mousedown 결선 변경 (994줄)
현재 `hitTestHandle` 만 검사. 변 히트를 코너 다음 우선순위로 추가. 코너·변 모두 dragState 시작 코드가 동일하므로 handle 변수만 합친다:
```js
const key = presetKey(state.cam, state.preset);
let handle = hitTestHandle(nx, ny);          // 코너 우선
if (!handle) handle = hitTestEdge(nx, ny);   // 없으면 변
if (handle && state.selectedSlotId) {
  const slot = (state.mapping.slots ?? []).find((s) => s.slotId === state.selectedSlotId);
  const startRect = slot?.roiByPreset?.[key];
  if (startRect) {
    dragState = { handle, slotId: state.selectedSlotId, key, startRect: { ...startRect }, last: { nx, ny } };
    e.preventDefault();
    return;
  }
}
```
`const handle =` → `let handle =` 로만 바꾸고 한 줄 추가. 이후 슬롯 선택/해제 로직(1008~1014줄) 불변.

## (e) 커서 피드백 — 선택(권장: 미적용)
정확한 커서(n/s→`ns-resize`, e/w→`ew-resize`, 코너→`nwse/nesw-resize`)는 별도 mousemove 핸들러 추가가 필요해 범위·줄수 증가. 요구 3(최소 변경)에 따라 **이번 범위에서 제외**. 필요 시 후속으로 hover 시 `overlay.style.cursor` 갱신하는 6~8줄 추가 가능(리더 확인 후). 미적용해도 기능 완결.

## (f) 성공 기준 — 유닛테스트 (test/roiEdit.test.ts, `resizeRect` describe에 추가)
resizeRect 는 순수 함수라 vitest로 완전 검증 가능. app.js 히트테스트는 DOM 의존(overlay)로 유닛 대상 아님 → 수동 동작확인.

resizeRect 케이스 (기준 rect `{x:0.4,y:0.4,w:0.2,h:0.2}`, left=0.4/top=0.4/right=0.6/bottom=0.6):
1. **n +0.1(하향)**: `resizeRect(r,'n',0,0.1)` → y=0.5, h=0.1, x=0.4, w=0.2. (상변만 내려가 높이 감소)
2. **n -0.1(상향)**: → y=0.3, h=0.3. (높이 증가)
3. **s +0.1**: `('s',0,0.1)` → y=0.4, h=0.3. (하변 내려가 높이 증가)
4. **w -0.1**: `('w',-0.1,0)` → x=0.3, w=0.3. (좌변 왼쪽 → 폭 증가)
5. **e +0.1**: `('e',0.1,0)` → x=0.4, w=0.3. (우변 오른쪽 → 폭 증가)
6. **직교축 불변**: n/s 는 x·w 불변, e/w 는 y·h 불변 확인(각 케이스 assert에 포함).
7. **clamp 경계**: `resizeRect({x:0.9,y:0.9,w:0.05,h:0.05},'e',0.5,0)` → `x+w ≤ 1`.
8. **뒤집힘 정규화**: `resizeRect({x:0.4,y:0.4,w:0.2,h:0.2},'n',0,0.5)` → top(0.9)>bottom(0.6) 스왑, `w>0 && h>0`, y≈0.6.

동작확인(수동, Play 상응): 슬롯 선택 → 각 변 라인 드래그 시 해당 변만 이동, 코너 드래그는 기존대로 2변 이동, 코너 근처는 코너 우선.

## 미해결/가정
- **가정**: 요구 4의 "변 히트테스트는 app.js" 에 따라 `hitTestEdge`를 app.js에 신규 배치(순수 core.js 이전 안 함). resizeRect 순수 로직만 core.js.
- **가정**: 커서 피드백은 (e) 권고대로 이번 범위 제외. 리더가 원하면 확장.
- 충돌 없음: 색상/핸들 렌더(175~180줄)·dragState·mousemove/up 은 건드리지 않음.
