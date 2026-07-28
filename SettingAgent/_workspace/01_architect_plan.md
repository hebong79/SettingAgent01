# 01 설계 계획 — 그리기 렌더 결함 수정 + ROI 초기화/전체삭제

작성: 2026-07-28 / 입력: `_workspace/00_leader_context.md`(단일 출처) · `_workspace_prev_20260728_placedraw/01~04` · `docs/20260728_124910_주차면_신규그리기_도구.md`
근거: 아래 모든 판단은 `web/app.js`·`web/core.js`·`web/placeDraw.js`·`web/index.html`·`src/capture/placeRoi.ts`·`src/api/captureRoutes.ts` **실코드 확인**에서 나왔다. 추측 없음.

---

## ★ 리더 진단과 충돌하는 사실 1건 — 먼저 보고

**원인 1(`closePath()` 누락)은 실재하지만, 마스터가 본 증상의 원인이 아니다.**

근거(app.js:2325-2354 `placeDrawClick`):

```js
const { draw, full } = addPlaceDrawPoint(state.placeDraw, { x: nx, y: ny });
state.placeDraw = draw;
if (!full) { … drawRoiOverlay(); return; }   // ← 렌더는 여기(1~3점)에서만 일어난다
const { placeRoi, idx } = appendPlaceSpace(…); // 4점째는 같은 클릭 안에서 즉시 커밋
state.placeRoi = placeRoi;
…
endPlaceDraw();                                // state.placeDraw = null → 그 뒤 drawRoiOverlay()
```

4점째 클릭은 **렌더를 거치지 않고 같은 동기 블록에서 커밋되고 `state.placeDraw` 가 null 이 된다.**
즉 `drawPlaceDrawOverlay` 가 `pts.length === 4` 로 호출되는 경로는 **현재 존재하지 않는다**(mousemove 도 `if (!state.placeDraw) return`).
→ `closePath()` 만 넣으면 **화면은 1픽셀도 변하지 않는다.**

마스터가 실제로 본 것:
- 1~3점 단계에서 **변 2개 + 고무줄선**만 보인다(닫힘 예고 없음) → "사각형이 안 그려진다"
- 4점째에 보여야 할 **초록 파일 ROI 가 `#roi-floor` 게이트(app.js:611)에 막혀 안 보인다** → "찍어도 아무 일이 없다"

**따라서 실제 원인은 ②(토글 게이트) + ①의 변형(닫힘 예고 부재)이다.** 설계는 리더 지시(원인 1·2 둘 다 수정)를 따르되,
`closePath()` 를 **실제로 보이게** 만드는 최소 수단을 함께 넣는다 — **3점째에 p3→p1 닫힘 예고선**(점선).
커밋 계약(4점째 즉시 커밋)은 **바꾸지 않는다**(5번째 확인 클릭 요구는 UX 변경이자 범위 밖).

> 리더 판단 요청 1: 위 해석을 승인하는가. 반대안은 "커밋을 4점째 → 별도 확인 버튼으로 지연"이며 이는 범위 확대라 권하지 않는다.

---

## 확인된 코드 사실(설계 근거)

| # | 사실 | 근거 |
|---|---|---|
| F1 | `drawFileFloorRoi` 첫 줄이 `#roi-floor` 게이트. `FLOOR_ROI_USE_LLM` 는 **상수 false**(app.js:95) → LLM 분기(484행)는 사실상 죽은 경로 | app.js:610-612, 95 |
| F2 | 정점 핸들(app.js:644)·정점 히트테스트(app.js:1373)가 **둘 다** `#roi-floor` 를 요구 → 표시와 편집이 이미 대칭 | app.js:644, 1373 |
| F3 | `#roi-floor` 를 켜면 **부수효과 1건**: 슬롯 히트테스트 `layers.floor`(app.js:4629)가 켜진다. 대상은 artifact 슬롯의 `floorRoiByPreset` 뿐 | app.js:4629, core.js:783-796 |
| F4 | 선례: `ggPreview` 가 `$('roi-auto').checked = true`(app.js:2129)로 강제 ON | app.js:2129 |
| F5 | `removePlaceSpace`(core.js:682)는 삭제 후 **전역 1..N 을 항상 재압축**한다. `assemblePlaceRoi` 는 **빈 프리셋 키를 `[]` 로 보존** | core.js:682-688, 616-627 |
| F6 | `normalizeGlobalIdx`(core.js:640)는 idx 집합이 1..N 순열이 **아니면 무조건 재부여**한다 → **파일에 구멍을 저장해도 다음 로드에서 강제로 메워진다** | core.js:640-658 |
| F7 | `PlaceRoiPutSchema.spaces` 는 `z.array(...)`(min 없음) → **빈 배열 PUT 이 통과**한다. `applyPlaceRoiUpdateEx` 는 대상 프리셋 `parking_spaces` 를 통째 교체 → 빈 배열 = 파일에서 그 프리셋 면 전멸 | captureRoutes.ts:130-138, placeRoi.ts:216-219 |
| F8 | `savePlaceRoi` 는 `Object.keys(state.placeRoi)` 전부를 순차 PUT → 비운 키도 `[]` 로 저장된다(F5 덕분에 키가 남아 있음) | app.js:2392-2410 |
| F9 | 되돌리기 선례 `state.placeRoiBackup` 은 **프리셋 1개 단위**(`{key, spaces}`)이고 자동보정 전용 | app.js:2591, 2603-2613 |
| F10 | `renderPlaceSelectionInfo` 는 `selectedPlaceIdx == null` 이면 **조기 return** 한다 → 새 버튼 상태 동기화는 그 위에 둬야 한다 | app.js:2224-2237 |
| F11 | 파일에 면 0개인 프리셋은 `normalizePtzCamRoi` 가 `byPreset` 에 넣지 않는다 → 다음 로드에서 `placeRoiFileKeys` 에서 빠지고 `needsPlaceSkeleton` 이 true 가 된다 | core.js:528, app.js:1051, 2486-2488 |

---

## (1) 렌더 결함 수정

### 1-A `drawPlaceDrawOverlay`(app.js:641-681) — 닫힘 표시

교체 대상은 655-659 블록 하나뿐. 나머지(점 원·번호·고무줄선)는 **손대지 않는다**.

```js
if (pts.length > 1) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
  if (pts.length === 4) {
    // 4점 완성 = 닫힌 사각형(변 4개) + 반투명 채움. 현재 커밋이 같은 클릭에서 일어나 이 상태는
    // 렌더까지 살아남지 않지만(설계서 ★), 상태가 화면에 나오면 반드시 '면'으로 보여야 한다.
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 214, 10, 0.18)';
    ctx.fill();
  }
  ctx.stroke();
}
// 3점 = 닫힘 예고. 마지막 점→첫 점을 점선으로 그려 '지금 한 번 더 찍으면 이 사각형' 을 보이게 한다.
if (pts.length === 3) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[2].px, pts[2].py);
  ctx.lineTo(pts[0].px, pts[0].py);
  ctx.stroke();
  ctx.restore();
}
```

- 1~2점 표시는 **완전히 그대로**(열린 선 유지) — 구분 요구 충족.
- `ctx.save()/restore()` 중첩은 기존 바깥 `save/restore`(652·680) 안에서만 일어나므로 다른 레이어에 누설 0.

### 1-B `#roi-floor` 강제 ON — 3개 진입점

전부 **사용자 명시 조작 직후**에만 켠다(자동 폴링·렌더 루프에서는 절대 켜지 않는다 — F4 선례와 동일 성격).

| 위치 | 삽입 지점 | 이유 |
|---|---|---|
| `togglePlaceDraw`(시작 분기, app.js:2312-2318) | `state.placeDraw = beginPlaceDraw(...)` 직후, **`drawRoiOverlay()` 앞** | 기존 면이 보여야 어디에 그릴지 안다(리더 지시) |
| `placeDrawClick`(커밋 분기, app.js:2343-2350) | `state.placeRoi = placeRoi;` 직후, **`endPlaceDraw()` 앞** | 커밋 연속성(아래 1-C) |
| `place-edit-vertex` change 핸들러(app.js:4915) | 체크가 **켜질 때만** | 토글을 켰는데 핸들이 안 나오는 '조용한 무반응' 제거 |

공통 헬퍼(신규, app.js 지역 함수):

```js
/** 바닥 표시 토글을 켠다(사용자 명시 조작 직후에만 호출 — ggPreview 의 roi-auto 강제 ON 과 같은 규약). */
function ensureFloorVisible() {
  const el = $('roi-floor');
  if (el && !el.checked) el.checked = true;
}
```

### 1-C 커밋 순간 연속성 — 코드 레벨 순서

지금도 **비는 프레임은 없다**: `endPlaceDraw()` 안의 `drawRoiOverlay()` 한 번이 `clearRect` → 초록 파일 ROI(443행) → 노랑 미리보기(446행, 이때 `state.placeDraw` 는 이미 null) 를 **같은 프레임에** 처리한다. 문제는 타이밍이 아니라 **초록이 토글에 막히는 것**이다(F1).

확정 순서(`placeDrawClick` 커밋 분기):

```
1) state.placeRoi = placeRoi;          // 초록 소스 확보
2) state.selectedPlaceIdx = idx;       // (기존)
3) #place-gidx 값 세팅                 // (기존)
4) #place-edit-vertex = true           // (기존)
5) ensureFloorVisible();               // ★ 신규 — 반드시 6) 앞
6) endPlaceDraw();                     // state.placeDraw=null → drawRoiOverlay() 1회
7) markPlaceDirty(...) / renderSlotList() / validatePlaceQuad()   // (기존)
```

5)가 6) **뒤**에 오면 그 프레임은 노랑도 초록도 없는 **빈 프레임**이 된다 → 순서가 계약이다(테스트로 봉인, 아래 S1-T3).

### 1-D 정점 핸들의 `#roi-floor` 의존 — **그대로 둔다**

근거:
1. **표시(644)와 히트(1373)가 이미 대칭**(F2). 한쪽만 떼면 "안 보이는 사각형의 정점을 드래그하는" 상태가 생긴다 — 보이지 않는 것을 편집시키는 게 더 나쁜 결함이다.
2. 의존을 떼는 대신 **무반응을 없애는 쪽**으로 푼다: 그리기 시작·커밋·정점편집 ON 이라는 **세 진입점 전부에서 토글을 켠다**(1-B). 사용자가 그 뒤 스스로 바닥을 끄면 그건 "숨기고 싶다"는 명시 의사다.
3. 회귀 최소 — 두 조건식(644·1373) 무수정.

**부수효과 고지(F3)**: `#roi-floor` 를 켜면 artifact 슬롯의 floor quad 히트테스트가 함께 켜진다. 발생 조건은 "사용자가 바닥을 끈 상태 + artifact 존재 + 그 프리셋에 `floorRoiByPreset` 보유" 이며, 이때의 동작은 **바닥 토글 기본값(checked) 상태와 완전히 동일**하다(index.html:41). 새 동작을 만들지 않고 기본 상태로 되돌리는 것이므로 회귀로 보지 않는다. 문서에 명시한다.

---

## (2) 초기화 — `#place-clear`

### 동작 정의(우선순위 확정)

```
if (state.placeDraw)  → 찍은 점 전부 삭제. 그리기 모드는 **유지**(points=[], 메시지 '1/4').
else if (selectedPlaceIdx != null) → 선택 면 삭제(= 기존 deletePlaceSpace 에 위임).
else → '지울 점도, 선택된 주차면도 없습니다' 안내 후 무동작.
```

- **우선순위: 그리는 중 > 선택 면.** 근거: 그리기 중 '초기화'의 사용자 의도는 100% "지금 찍은 점 다시"다. 이때 커밋된 면을 지우면 **되돌릴 수 없는 파괴가 오조작으로 일어난다**(비파괴 분기를 항상 앞에).
- **그리기 모드 유지**(종료 아님) 근거: 취소는 이미 `Esc`/`면 그리기` 재클릭 두 경로가 있다(app.js:4922, 2302). 초기화까지 모드를 끄면 세 번째 취소 버튼이 되고, "다시 찍겠다"는 사용자는 매번 '면 그리기'를 다시 눌러야 한다.
- 메모리까지만. `state.placeRoi` 변경 분기는 `deletePlaceSpace` 를 **호출**하므로 파일 접촉 0 이 구조적으로 보장된다.

### `place-delete` 와의 역할 중복 — **별도 버튼 유지 + 삭제 로직 위임**

- 통합(삭제 버튼 흡수)은 **반대**: `place-delete` 는 `renderPlaceSelectionInfo` 의 disabled 동기화(app.js:2226,2235)·기존 결선(4939)·기존 문서에 물려 있고, 직전 라운드 D-2(목록 UI 회귀)와 같은 부류의 사고가 나기 쉽다. 제거는 범위 밖이다.
- 대신 **삭제 구현을 하나로 유지**: 초기화의 면 삭제 분기는 새 로직을 쓰지 않고 `deletePlaceSpace()` 를 그대로 호출한다 → 코드 중복 0, 동작 차이 0.
- 혼동은 **배치와 문구**로 없앤다((4) 참조): `초기화` 는 '그리기' 줄에, `삭제` 는 '목록 편집' 줄에 둔다.

```js
/** '초기화': 그리는 중이면 찍은 점만 비우고(모드 유지), 아니면 선택 면 삭제(deletePlaceSpace 위임). 파일 접촉 0. */
function clearPlaceDrawing() { … }
```

---

## (3) 전체 삭제 — `#place-clear-preset`

### 범위: **현재 프리셋(`currentFrameKey()`) 1개만.**

- 버튼 문구: **`이 프리셋 전체삭제`**
- title: `현재 화면의 cam:preset 주차면만 목록에서 전부 지웁니다. 다른 프리셋·다른 카메라는 그대로. 파일은 '저장'을 눌러야 바뀝니다.`
- confirm 문(범위·부작용·되돌리기를 전부 문장으로):

```
cam{c} 프리셋{p} 의 주차면 {n}개를 목록에서 전부 지웁니다.
· 다른 프리셋·다른 카메라의 주차면은 그대로입니다.
· 파일(PtzCamRoi.json)은 아직 바뀌지 않습니다 — '저장'을 눌러야 반영됩니다.
· 저장 전에는 '되돌리기' 로 복구할 수 있습니다.
★ 남은 주차면의 전역번호가 1..N 으로 다시 매겨집니다. 저장 후에는 'ROI 파일 로딩' 으로
   DB(slot_setup)를 재구성해야 검출·점유·센터라이징 귀속이 맞습니다.
진행할까요?
```

### idx 정합 — **재부여(구멍 없음). 코드로 확정.**

- **'구멍을 둔다'는 선택지가 존재하지 않는다.** `normalizeGlobalIdx`(F6)가 idx 집합이 1..N 순열이 아니면 **무조건** 재부여하므로, 구멍 뚫린 파일을 저장해도 다음 로드에서 메워지고 오히려 `placeRoiDirty=true` 로 "재부여됨(미저장)" 상태가 된다. 구멍은 **유지가 불가능**하다.
- `removePlaceSpace`(F5)는 이미 전역 재압축이다 → **전체삭제 = 기존 '삭제' 를 n회 한 것과 같다.** 새 위험 클래스가 아니다(전역번호 이동은 기존 '삭제'/'수정' 버튼이 이미 하는 일).
- 외부 참조(`slot_ptz.json`·DB `slot_setup.slot_idx`·artifact `globalIndex`)와의 어긋남은 **저장 후 'ROI 파일 로딩'(runLoadRoiToDb) 재구성으로 수렴**한다 — 기존 `ggApply` 가 쓰는 것과 같은 수습 경로다. 확인문에 명시(위).
- `applyPlaceRoiUpdate` 통째 교체(F7)와도 정합: 비운 프리셋은 `[]`, 다른 프리셋은 새 idx 로 전량 PUT 된다(F8) → 파일 전체가 한 번에 1..N 으로 맞는다.

### 구현 — 순수함수 1개(신규), core.js 무수정

`web/placeDraw.js` 에 추가(이미 `core.js` 의 `moveQuadVertex` 를 import 하는 파일이라 의존 방향 동일):

```js
import { moveQuadVertex, removePlaceSpace } from './core.js';

/**
 * 한 프리셋(key)의 주차면을 전부 제거(불변). 전역 재압축은 core.js `removePlaceSpace` 에 **전량 위임**한다.
 * 큰 idx 부터 지운다 — removePlaceSpace 는 지운 idx **보다 큰** 것만 당기므로 남은 대상 idx 가 흔들리지 않는다.
 * 대상 키가 없거나 비어 있으면 원본 그대로(throw 금지).
 */
export function clearPresetSpaces(placeRoi, key) {
  const idxs = ((placeRoi ?? {})[key] ?? []).map((sp) => sp?.idx).filter(Number.isInteger).sort((a, b) => b - a);
  return idxs.reduce((map, idx) => removePlaceSpace(map, idx), placeRoi ?? {});
}
```

- 결정론: 입력 순서만으로 결과가 정해진다(정렬 기준 고정, Object.keys 순회는 `flattenPlaceRoi` 가 cam→preset 정렬로 이미 고정).
- `round5`/`stringify5`: 좌표를 **만들지 않으므로** 새 반올림 지점이 없다(기존 값 그대로 재조립).

### 되돌리기 — **스냅샷 보관.** 파일 재로딩은 쓰지 않는다.

근거:
1. `loadPlaceRoi` 는 `placeRoiLoaded` 가드·네트워크 의존이라 **결정론적이지 않다**(오프라인·404 면 복구 실패).
2. 재로딩은 파일 상태로 되감으므로 **같은 세션의 다른 미저장 편집(새로 그린 면·번호 수정)까지 날린다** → 되돌리기가 더 큰 파괴가 된다.
3. 전체삭제는 **다른 프리셋의 idx 까지 바꾼다**(F5) → 프리셋 단위 스냅샷(`state.placeRoiBackup`, F9)으로는 복구 불가.

→ **`state.placeRoiUndo` 신설**(전체 맵 깊은 복사). `placeRoiBackup`(자동보정 전용)과 **절대 공유하지 않는다**.

```js
state.placeRoiUndo = null; // { label, placeRoi } — '이 프리셋 전체삭제' 직전 전체 스냅샷. '저장' 성공 시 소진.
```

- 채우는 곳: `clearPresetSpaces` 호출 **직전** (`JSON.parse(JSON.stringify(state.placeRoi))`, `alignRun` 선례와 동일 관용구).
- 소진: `savePlaceRoi` 성공 직후(`state.placeRoiDirty = false` 줄 옆) — 저장되면 되돌릴 대상이 아니다(`alignApply` 선례).
- 복원: `undoPlaceRoi()` — `state.placeRoi = snap.placeRoi; state.placeRoiUndo = null; state.selectedPlaceIdx = null; markPlaceDirty(...)` + `renderSlotList()` + `drawRoiOverlay()`.
- 스냅샷은 **1단계만**(다중 undo 스택 금지 — 요청 범위 밖).

### 선택 상태 처리

전체삭제 후 `state.selectedPlaceIdx = null`. 근거: 남은 면들의 idx 가 이동하므로(F5) 옛 번호를 유지하면 **엉뚱한 면이 선택된 것처럼 보인다**. 재매핑 로직을 새로 만드는 것보다 해제가 정확하고 단순하다(`deletePlaceSpace` 도 null 로 둔다 — app.js:2281 동일 규약).

---

## (4) UI 배치 — 한 줄 6버튼 → **의미 단위 2줄**

현재(index.html:156-165) `.roi-edit-bar` 한 줄에 그리기·정점편집·선택정보·번호·수정·삭제·저장·열기가 섞여 있다. 여기에 3개를 더 붙이면 읽을 수 없다.
**섹션(`주차면 목록 · 편집`)은 그대로 두고 `.roi-edit-bar` 를 2개로 쪼갠다**(둘 다 같은 클래스 → CSS 무변경, flex-wrap 그대로).

```
[1행 — 그리기]   면 그리기 │ ☑정점 편집 │ 초기화 │ <선택 정보>
[2행 — 목록/파일] [번호] 수정 │ 삭제 │ 이 프리셋 전체삭제 │ 되돌리기 │ 저장 │ 열기
```

원칙:
- **행이 곧 범위다.** 1행 = 지금 그리는 것(비파괴). 2행 = 목록·파일(파괴 있음).
- **파괴 강도 오름차순 좌→우**: 삭제(1면) → 전체삭제(1프리셋) → 되돌리기(복구) → 저장(확정).
- `되돌리기` 는 `전체삭제` **바로 옆**(무엇을 되돌리는지 위치로 말한다). 스냅샷 없으면 `disabled`.
- 문구 중복 회피: `초기화`(그리기 줄, 점 지우개) vs `삭제`(면 1개) vs `이 프리셋 전체삭제`(범위 명시). 셋 다 title 로 범위를 다시 쓴다.
- 기존 id·핸들러·순서는 **하나도 바꾸지 않는다**(같은 id 가 어느 행에 있든 `$()` 조회는 동일) → 결선 회귀 0.
- CSS 무변경(`.danger` 같은 신규 클래스 도입하지 않음 — 문구·확인문으로 충분하고 파일 수를 줄인다).

신규 id: `place-clear` · `place-clear-preset` · `place-undo`.

---

## 파일별 변경 계획

| 파일 | 변경 | 비고 |
|---|---|---|
| `web/app.js` | ① `drawPlaceDrawOverlay` 655-659 교체 + 3점 닫힘 예고 ② `ensureFloorVisible()` 신규 + 3곳 호출 ③ `clearPlaceDrawing()`·`clearCurrentPresetSpaces()`·`undoPlaceRoi()` 신규 ④ `state.placeRoiUndo` 필드 ⑤ `renderPlaceSelectionInfo` **맨 앞**에 `#place-undo`/`#place-clear-preset` disabled 동기화(F10 — 조기 return 위) ⑥ `savePlaceRoi` 성공 시 스냅샷 소진 1줄 ⑦ `wire()` 결선 3줄 ⑧ import 에 `clearPresetSpaces` 추가 | 유일한 대형 수정 파일 |
| `web/index.html` | `.roi-edit-bar` 2행 분리 + 버튼 3개 추가 | 기존 id·속성 무변경 |
| `web/placeDraw.js` | `clearPresetSpaces` 추가(+ `removePlaceSpace` import) | 순수·DOM 0·throw 0 |
| `web/placeDraw.d.ts` | `clearPresetSpaces` 선언 추가 | tsc 0에러 유지 |
| `test/placeDraw.test.ts` | `clearPresetSpaces` 순수 테스트 describe 추가 | |
| `test/placeDrawWiring.test.ts` | 렌더·순서·결선 소스텍스트 봉인 describe 추가 | |

**무변경 목표 8파일 전부 무수정**: `groundModel.ts`·`project.ts`·`ground/types.ts`·`floorRoi.ts`·**`web/core.js`**·`Finalizer.ts`·`SqliteStore.ts`·`roiDbLoad.ts`.
(`core.js` 의 `removePlaceSpace` 는 **호출만** 한다 — 수정 0.)
`web/app.css` 무변경. 서버(`src/**`) 무변경 — 빈 배열 PUT 이 이미 통과한다(F7).

## 신규 함수 시그니처

```js
// web/placeDraw.js (순수)
export function clearPresetSpaces(placeRoi: PlaceRoiMap|null, key: string): PlaceRoiMap;

// web/app.js (DOM/state)
function ensureFloorVisible(): void;
function clearPlaceDrawing(): void;        // #place-clear
function clearCurrentPresetSpaces(): void; // #place-clear-preset (confirm 필수)
function undoPlaceRoi(): void;             // #place-undo
```

## 상태 전이

```
[대기]  --면 그리기--> [그리는중 0점]   (ensureFloorVisible)
[그리는중 n<4] --클릭--> [그리는중 n+1]
[그리는중 3점] --클릭--> (appendPlaceSpace → ensureFloorVisible → endPlaceDraw) --> [대기, 면 선택됨]
[그리는중 n] --초기화--> [그리는중 0점]        ← 모드 유지, placeRoi 불변
[그리는중 n] --Esc/취소--> [대기]              ← 기존 그대로
[대기, 면 선택됨] --초기화--> deletePlaceSpace() --> [대기, 선택 없음]  (dirty)
[대기] --전체삭제(confirm OK)--> 스냅샷 저장 → clearPresetSpaces → [대기, 선택 없음] (dirty, undo 가능)
[undo 가능] --되돌리기--> 스냅샷 복원 → [대기, 선택 없음] (dirty, undo 소진)
[dirty] --저장 성공--> dirty=false, undo 소진
```

---

## (5) 단계 분할 · 완료 조건 (Loop 1~5 대응)

### S1 — 닫힘 렌더 + 커밋 연속성 (Loop 1)
구현: 1-A, 1-C 순서 확정.
- **S1-T1**(순수/텍스트): `drawPlaceDrawOverlay` 본문에 `closePath()` 가 있고 `pts.length === 4` 조건 뒤에 있다.
- **S1-T2**: 같은 본문에 `pts.length === 3` 닫힘 예고(`setLineDash` + `pts[0]` 복귀)가 있다.
- **S1-T3**(순서 봉인): `placeDrawClick` 본문에서 `ensureFloorVisible` 의 인덱스 < `endPlaceDraw` 의 인덱스, 그리고 `state.placeRoi = placeRoi` 인덱스 < `ensureFloorVisible` 인덱스.
- **S1-T4**(회귀): 1~2점 경로 코드(`pts.length > 1` 폴리라인·고무줄선·점 원 루프)가 그대로 남아 있다.
- **육안(리더 sharp)**: 3점에서 닫힘 예고 점선이 보이고, 4점째에 **초록 면 + 라벨**이 즉시 나타나며 중간에 아무것도 없는 프레임이 없다.

### S2 — `#roi-floor` 강제 ON (Loop 2)
- **S2-T1**: `togglePlaceDraw` 시작 분기·`placeDrawClick` 커밋 분기·`place-edit-vertex` change 결선 **세 곳 모두** `ensureFloorVisible` 을 호출한다.
- **S2-T2**: `ensureFloorVisible` 이 `drawRoiOverlay`·폴링 함수 본문에는 **없다**(자동 ON 금지 봉인).
- **S2-T3**: `drawPlaceDrawOverlay`(644) / `hitTestPlaceVertex`(1373) 의 `roi-floor` 조건이 **그대로 남아 있다**(1-D 판단 봉인).
- **육안**: 바닥 토글을 끈 상태에서 '면 그리기' 를 누르면 토글이 켜지고 기존 초록 면이 나타난다.

### S3 — 초기화 (Loop 3)
- **S3-T1**: `clearPlaceDrawing` 본문의 **첫 분기가 `state.placeDraw`** 다(비파괴 우선 봉인).
- **S3-T2**: 그리는 중 분기가 `state.placeRoi` 를 대입하지 않는다(문자열 부재 검사) + `beginPlaceDraw`/points 리셋으로 **모드를 유지**한다(`endPlaceDraw` 호출 없음).
- **S3-T3**: 면 삭제 분기가 `deletePlaceSpace()` 를 호출한다(중복 구현 0).
- **S3-T4**: 본문에 `fetch` 가 없다(파일 접촉 0).
- **육안**: 그리는 중 초기화 → 노란 점만 사라지고 검출/자동ROI/초록 면은 그대로. 선택 상태 초기화 → 그 면만 사라진다.

### S4 — 전체삭제 + 되돌리기 (Loop 4)
- **S4-T1**(순수): `clearPresetSpaces` — 대상 프리셋만 비고 다른 프리셋 면의 **좌표 불변**, 남은 전역 idx 가 정확히 1..N 연속, **키는 `[]` 로 남는다**.
- **S4-T2**(순수): 없는 키·빈 맵·null·idx 없는 원소 혼입에서 throw 0, 원본 미변형(입력 객체 동일성 확인).
- **S4-T3**(순수): 결과가 `normalizeGlobalIdx(...).changed === false` 를 만족한다(재부여 필요 없는 상태 = 정합 증명).
- **S4-T4**(텍스트): `clearCurrentPresetSpaces` 에 `confirm(` 이 있고, 확인문에 `프리셋`·`저장`·`되돌리기` 문자열이 있다. `fetch` 없음.
- **S4-T5**(텍스트): 스냅샷 대입이 `clearPresetSpaces` 호출보다 **앞**에 있고, `state.placeRoiUndo` 를 쓰며 `state.placeRoiBackup` 은 **건드리지 않는다**.
- **S4-T6**(텍스트): `savePlaceRoi` 안에 `state.placeRoiUndo = null` 이 있다(저장 후 소진).
- **육안**: 전체삭제 → 현재 프리셋 초록 면 전멸, 다른 프리셋 전환하면 그대로 있음, 목록 번호가 1..N 연속. 되돌리기 → 원상복구. 그 뒤 저장 → 재로딩 후에도 "재부여됨(미저장)" 경고가 뜨지 않는다.

### S5 — 회귀 (Loop 5)
- `tsc --noEmit` 0에러 · `vitest run` 전량 통과(L3 골든 해시 포함).
- **S5-T1**: 기존 `placeDrawWiring` T1~T10·QA D-1/D-2/D-5 전부 그대로 통과(특히 **D-2 목록 병기**).
- **S5-T2**: `test/viewerDisplayReset.test.ts:55`(‘resetOverlayDisplay 본문에 `'roi-floor'` 없음’) 유지 — `ensureFloorVisible` 을 그 함수에 넣지 않는다.
- **S5-T3**(텍스트): 그리기 off(`state.placeDraw === null`) 시 캔버스 경로 변화 0 — `drawPlaceDrawOverlay` 의 `if (!draw || draw.key !== key) return;` 조기 return 이 유지된다.
- **육안**: 그리기·초기화·전체삭제를 한 번도 쓰지 않은 세션에서 화면·목록이 이전과 동일.

---

## 리스크

| # | 리스크 | 대응 |
|---|---|---|
| R1 | `#roi-floor` 강제 ON 의 부수효과(F3, artifact 슬롯 floor 히트테스트) | 기본값(checked) 상태와 동일한 동작으로 되돌리는 것뿐. 사용자 명시 조작 직후에만 호출. 문서 명시 |
| R2 | 전체삭제 후 다른 프리셋의 전역번호 이동 → DB·`slot_ptz.json`·artifact 귀속 어긋남 | 기존 '삭제' 와 동일 성질(F5). 확인문에 "저장 후 'ROI 파일 로딩' 필요" 명시 |
| R3 | 전체삭제 후 그 프리셋이 파일에서 면 0개가 되면 다음 로드에서 `placeRoiFileKeys` 에서 빠져 `needsPlaceSkeleton=true`(F11) → 그 프리셋에 다시 그려 저장할 때 **라이브 프레임이 필요**해진다 | 기존 신규 주차장 경로와 동일하며 실패 메시지도 이미 있다(app.js:2416). 문서에 기록 |
| R4 | `초기화`/`삭제`/`전체삭제` 문구 혼동 | 행 분리 + 범위 명시 문구 + title 3중 |
| R5 | 스냅샷 깊은 복사(JSON round-trip) 비용 | 면 수백 개 규모라 무시 가능. `alignRun` 선례와 동일 관용구 |
| R6 | 4점 미리보기 경로가 실렌더로 도달하지 않음(★ 충돌 보고) | 3점 닫힘 예고로 사용자 체감 확보. `closePath` 는 리더 지시대로 넣되 주석에 도달성 사실 기록 |

## 미해결 / 리더 판단 요청

1. **★ 원인 1 해석** — 4점 미리보기 미도달 사실 승인 + "3점 닫힘 예고" 채택 여부.
2. **초기화와 삭제 병존** — 별도 버튼 유지(삭제 로직 위임) 안을 승인하는가. 대안(삭제 버튼 흡수)은 D-2 부류 회귀 위험으로 비권장.
3. **전체삭제 범위** — '현재 프리셋'을 `currentFrameKey()`(수집 중이면 순환 프레임)로 잡는다. 라이브 선택(`state.cam/preset`)이 아니라 **화면에 보이는 프레임** 기준이며, `drawFileFloorRoi` 가 그리는 대상과 동일하다("보이는 것을 지운다"). 이견 있으면 지시 바람.
4. 되돌리기 **1단계 한정**(다중 undo 없음) 확정 여부.
