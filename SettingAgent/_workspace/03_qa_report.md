# 03 검증 보고 — 그리기 렌더 결함 수정 + ROI 초기화/전체삭제

작성: 2026-07-28 / 입력: `00_leader_context.md` · `01_architect_plan.md` · `02_developer_changes.md` + 배포 소스
검증자 원칙: **구현자·설계자 주장을 액면 그대로 믿지 않고 전부 독립 재현**했다. 못 한 것은 §7 에 못 했다고 적었다.

---

## 0. 한 줄 결론

**본체 수정(`#roi-floor` 강제 ON)은 코드 경로 전수 확인으로 "게이트가 그 하나뿐"임이 확정됐고, 3점 닫힘 예고와
전역 idx 정합은 실행으로 증명됐다. 그러나 "실제로 화면에 초록 면이 뜬다"는 여전히 미증명이다(브라우저 없음).**
추가로 **결함 2건(중 1 / 하 1)** 과 잔여 갭 2건을 찾았다. 회귀는 발견되지 않았다.

---

## 1. Requirements 판정표

| # | 요구 | 판정 | 근거 |
|---|---|---|---|
| R-1 | 기존 동작 회귀 0 — 그리기 off 면 캔버스 완전 동일 | ✅ **실행 증명** | 배포 원문 실행: 그리기 off 3케이스 전부 **발행 명령 0건**(§5-E) |
| R-1b | 목록 UI 포함(D-2 재발 금지) | ✅ | `renderSlotList` 병기 분기(app.js:1319-1321) 무변경 + 봉인 테스트 green |
| R-2 | 저장은 명시적 트리거 — 초기화·전체삭제가 파일 무접촉 | ✅ | 세 함수 본문 `fetch` 0(코드 확인) + `data/Place01/PtzCamRoi.json` mtime `13:16:30` = 라운드 편집(13:35~) **이전**, 해시 `67a09455b07e48e7a5fb78c494a0c63c` |
| R-3 | 신규 면 idx 보장 · 결정론 · round5/stringify5 · throw 금지 · 순회 순서 고정 | ✅ **실행 증명** | 랜덤 500 케이스 전부 1..N 순열 유지, throw 0(§5-C) |
| R-4 | 무변경 목표 8파일 | ⚠️ **7/8 무변경, `groundModel.ts` 는 이전 라운드분** | 아래 별도 판정 |
| R-5 | L3 골든 해시 포함 기존 테스트 유지 · tsc 0 · vitest 전량 | ✅ | `tsc --noEmit` exit 0 · **256 files / 3075 tests passed** · 골든 해시 개별 green |
| R-6 | 범위 밖 리팩토링 금지 | ✅ | `core.js` 무수정(호출만), `app.css` 무수정, `src/**` 무수정 |
| R-7 | CLAUDE.md 5대 규칙 | ⚠️ 규칙3(동작 확인)만 미충족 — 브라우저 실렌더 미확인(§7) | |

### R-4 상세 — `groundModel.ts` 는 이번 라운드 변경이 아니다(구현자 주장 검증 결과: **사실**)

`git status` 만 보면 `groundModel.ts`·`app.css`·`captureRoutes.ts`·`placeRoi.ts` 등이 변경으로 나오지만
**전부 이전 라운드 미커밋분**이다. 두 가지 독립 근거로 확인했다.

1. **내용**: `groundModel.ts` 의 diff 는 `MIN_EDGE_PX`/`MIN_AREA_PX` 를 `export` 로 바꾼 것뿐(**값 불변**),
   `app.css` 는 `.gg-warn`/`.gg-help`/`#overlay.place-drawing` — 전부 지면격자·그리기 라운드 산물. 이번 주제와 무관.
2. **시각**: 이번 라운드 편집 파일 mtime 은 13:35~13:44 인데, 위 파일들은 11:36~12:14 다.

```
placeDraw.js 13:35:39 / index.html 13:36:02 / placeDraw.test.ts 13:38:10 / app.js 13:44:02 / placeDrawWiring.test.ts 13:44:14
--- 경계 ---
groundModel.ts 11:36:50 / placeRoi.ts 11:37:33 / app.css 11:39:46 / captureRoutes.ts 12:14:59 / core.js 07-27 13:16
```

무변경 목표 중 `project.ts`·`ground/types.ts`·`floorRoi.ts`·**`web/core.js`**·`Finalizer.ts`·`SqliteStore.ts`·`roiDbLoad.ts`
**7개는 git 상 완전 무변경**이다. `web/app.css` 도 이번 라운드 무수정.

---

## 2. (A) ★ 본체 수정이 실제로 성립하는가 — `#roi-floor` 강제 ON

구현자가 **1순위 미확인**으로 신고한 항목. **코드로는 전수 확인했고, 화면으로는 확인 못 했다.**

### A-1. `drawFileFloorRoi` 의 게이트가 정말 첫 줄 하나뿐인가 — **사실상 그렇다(게이트 2개, 두 번째는 죽은 조건)**

```js
614 function drawFileFloorRoi(ctx) {
615   if (!$('roi-floor').checked) return;   // 게이트 1
616   if (FLOOR_ROI_USE_LLM) return;         // 게이트 2 ← const FLOOR_ROI_USE_LLM = false (app.js:96) → 항상 통과
617   const key = currentFrameKey();
618   const { polygons } = selectFloorRoi({ useLlm:false, placeRoi: state.placeRoi, key });
624   for (const poly of polygons) { … fill/stroke/fillText … }   // 조건 분기 없음
```

- **617 이후에는 초록 면을 막는 조건이 하나도 없다.** `selectFloorRoi`(core.js:542-554)는 필터링을 하지 않고
  `placeRoi[key]` 를 그대로 매핑한다(리더·설계자 진술 **독립 확인**).
- **호출 위치도 안전**: `drawRoiOverlay` 는 447행에서 `drawFileFloorRoi` 를 부르고, `state.roiHidden || !state.mapping`
  조기 return 은 **457행**이다 → 수집 중·artifact 없음에도 초록 면은 그려진다.
- **`resetOverlayDisplay`(app.js:175-189)가 `#roi-floor` 를 끄지 않는다**는 것도 확인(S5-T2 봉인과 일치).
  즉 강제 ON 이 직후에 되꺼지는 경로가 없다.

→ **"토글만 켜지면 반드시 그려진다"는 코드 수준에서 확정.** 남은 미지수는 오직 브라우저 실렌더(§7).

### A-2. 세 진입점 전부에 들어갔는가 — **3/3 확인**

| 진입점 | 위치 | 상태 |
|---|---|---|
| 그리기 시작 `togglePlaceDraw` | app.js:2428 | ✅ |
| 커밋 `placeDrawClick` | app.js:2468 | ✅ |
| 정점편집 ON `place-edit-vertex` change | app.js:5037 (`if (e.target?.checked)`) | ✅ |

`ensureFloorVisible`(2399-2402)는 `el.checked = true` 만 하고 change 이벤트를 쏘지 않는다. `#roi-floor` 의
change 리스너는 `drawRoiOverlay` 하나뿐(app.js:4973)이고 세 호출자가 모두 직접 `drawRoiOverlay()` 를 부르므로
**누락 없음**.

### A-3. 토글 설정이 렌더보다 먼저인가 — **3/3 먼저**

```
togglePlaceDraw : ensureFloorVisible(2428)  <  drawRoiOverlay(2433)          ✅
placeDrawClick  : state.placeRoi=(2459) < ensureFloorVisible(2468) < endPlaceDraw(2469→drawRoiOverlay)  ✅
place-edit-vertex: ensureFloorVisible(5037) < drawRoiOverlay(5038)           ✅
```

**1프레임 지연 경로 없음.**

### A-4. ★ 잔여 갭 — **네 번째 진입점이 비어 있다**(결함 F-3, 하)

`selectPlaceSpace`(app.js:2275-2287, 목록 행 클릭)에는 `ensureFloorVisible` 이 **없다**.
바닥 토글이 꺼진 상태에서 목록에서 면을 선택하면 하이라이트도 정점 핸들도 나오지 않아 **여전히 "조용한 무반응"** 이다.
리더 지시는 3개 진입점이었으므로 **요구 위반은 아니지만, 이번 라운드가 제거하려는 결함 부류가 한 곳 남아 있다.**

---

## 3. (B) 3점 닫힘 예고 + 4점 경로 도달성 — 독립 재현 완료

구현자 방식을 그대로 믿지 않고 **별도 하네스**를 새로 짜서 배포 원문 `drawPlaceDrawOverlay`(60줄)를
`new Function` 으로 실행하고, **변경 전 baseline(추가 블록만 제거한 재구성본)** 과 명령 시퀀스를 대조했다.

실행 명령: `node qa_render.mjs`

```
1점 시퀀스 동일: YES(회귀0)
2점 시퀀스 동일: YES(회귀0)
2점+커서 시퀀스 동일: YES(회귀0)
3점 닫힘예고 setLineDash([4,4]) 발행: YES
3점 moveTo(p3)→lineTo(p1)→stroke 발행: YES
3점 예고선이 save/restore 로 감싸짐(누설 0): YES
4점 closePath+fill 발행(방어 코드): YES
3점 예고선 좌표: setLineDash([4,4]) → beginPath() → moveTo(300,100) → lineTo(100,100) → stroke()
```

3점 실제 시퀀스(원문):

```
save → strokeStyle=#ffd60a → lineWidth=2 → beginPath → moveTo(100,100) → lineTo(200,150) → lineTo(300,100) → stroke
→ save → setLineDash([4,4]) → beginPath → moveTo(300,100) → lineTo(100,100) → stroke → restore
→ [점 원 3개 + 번호 1,2,3] → restore
```

- **p3(300,100) → p1(100,100)** 로 정확히 되돌아간다 = 닫힘 예고 성립.
- `save/restore` 짝이 맞아 `setLineDash` 가 뒤 레이어로 새지 않는다.
- **1점·2점·2점+커서 시퀀스가 baseline 과 바이트 단위로 동일** → 회귀 0.

### 4점 경로 도달성 — **도달 불가 확정(리더 정정 사항 독립 확인)**

```
app.js:4660  overlay mousedown → if (state.placeDraw) { placeDrawClick(e); return; }
app.js:2449  const { draw, full } = addPlaceDrawPoint(...);  full=true 면
app.js:2456-2469  같은 동기 블록에서 appendPlaceSpace → … → endPlaceDraw()  (state.placeDraw = null)
app.js:4760  overlay mousemove → if (!state.placeDraw) return;
```

`placeDrawClick` 은 `state.placeDraw` 가 있을 때만 호출되고, 4점째 분기에는 **`drawRoiOverlay()` 호출이 없다**
(`if (!full)` 분기에만 있다). 커밋과 null 화가 같은 동기 블록 안이라 그 사이에 렌더가 끼어들 수 없다.
→ **`pts.length === 4` 분기는 실행되지 않는다.** `closePath()`/채움은 방어 코드이며, 실제 화면 변화는
**3점 예고선 하나뿐**이라는 설계자·구현자 진술이 맞다. 코드 주석에도 이 사실이 박혀 있다(app.js:664-666).

---

## 4. (C) 초기화 / 전체삭제

### C-1 초기화(`#place-clear`) — 우선순위·위임 ✅

```js
2323 function clearPlaceDrawing() {
2324   if (state.placeDraw) { … beginPlaceDraw(state.placeDraw.key) … return; }  // ① 비파괴 우선
2331   if (state.selectedPlaceIdx != null) { deletePlaceSpace(); return; }       // ② 위임
2335   setPlaceMsg('지울 점도, 선택된 주차면도 없습니다');
```

- **우선순위 그리는 중 > 선택 면** ✅ (첫 분기가 `state.placeDraw`)
- **그리기 모드 유지** ✅ (`endPlaceDraw` 미호출, `beginPlaceDraw` 로 0점 재개, `state.placeRoi` 대입 없음)
- **구현 중복 0** ✅ — 면 삭제는 `deletePlaceSpace()` 호출 한 줄. 본문에 `removePlaceSpace`·`fetch` 없음.

### C-2 전체삭제(`#place-clear-preset`) — 범위·확인·문구 ✅

- 범위 = `currentFrameKey()` (app.js:2345) — `drawFileFloorRoi`(617)와 **같은 기준** ✅
- `if (!ok) return;`(2361)이 **모든 변경보다 앞** → confirm 취소 시 상태 변화 0 ✅
- 버튼 문구 `이 프리셋 전체삭제` · title `…다른 프리셋·다른 카메라는 그대로…` · 확인문에 범위/미저장/되돌리기/재번호 전부 명시 ✅
- **다른 프리셋이 안 지워지는지** → 실행 확인(아래 C-3) ✅

### C-3 ★ 전역 idx 정합 — **실행으로 증명**

실행 명령: `node qa_clear.mjs` (`web/placeDraw.js` · `web/core.js` 직접 import)

```
입력 : 1:1=[1,2,3] 1:2=[4,5] 2:1=[6,7,8]
출력 : 1:1=[1,2,3] 1:2=[]    2:1=[4,5,6]

PASS  대상 키가 빈 배열로 남는다
PASS  남은 idx 가 1..N 순열
PASS  normalizeGlobalIdx.changed === false(재부여 불필요)
PASS  원본 미변형
PASS  다른 프리셋 좌표 불변
PASS  좌표↔번호 대응 유지(원 idx6,7,8 → 새 4,5,6)
PASS  없는 키 → throw 0, 내용 동일
PASS  null / undefined 입력 → throw 0
PASS  idx 없는 원소 혼입 → throw 0
PASS  유일 프리셋 전체삭제 → 전 맵 비고 키 유지
PASS  랜덤 500 케이스 전부 1..N 순열 유지 + 대상키 비움 (실패 0)
총 실패: 0
```

**"큰 idx 부터 접는다"가 실제로 필수인지도 대조 실험으로 확인**했다 — 작은 idx 부터 접으면 깨진다:

```
[대조] 작은 idx부터 접었을 때: 1:1=[1,2,3] 1:2=[4] 2:1=[5,6] → 대상키 비움? false
```

즉 `sort((a,b) => b - a)` 는 장식이 아니라 **정확성 조건**이다. 설계 근거가 실증됐다.

### C-4 되돌리기 — **전체삭제만 복구된다. 초기화는 복구되지 않는다** ⚠️ (결함 F-1)

| | 스냅샷 저장 | 되돌리기 복구 |
|---|---|---|
| 전체삭제 `clearCurrentPresetSpaces` | ✅ `state.placeRoiUndo`(전체 맵 깊은 복사, 변경 **앞**) | ✅ |
| 초기화 — 그리는 중 분기 | 불필요(비파괴) | — |
| **초기화 — 선택 면 삭제 분기** | ❌ **없음**(`deletePlaceSpace` 는 스냅샷을 남기지 않는다) | ❌ **복구 불가** |

QA 과제 (C)의 "1단계 스냅샷이 초기화·전체삭제 **양쪽 모두** 복구하는가" → **아니오.** 상세는 §6 F-1.

**`placeRoiBackup` 과의 분리는 ✅**: `undoPlaceRoi`(2377-2389)는 `placeRoiUndo` 만, `alignUndo`(2723-2733)는
`placeRoiBackup` 만 만진다. 교차 참조 0. 버튼도 `#place-undo` / `#align-undo` 로 별개이며 index.html id 중복 0.
소진 지점도 분리: `savePlaceRoi`(2581) → `placeRoiUndo=null`, `alignApply`(2752) → `placeRoiBackup=null`.

`#place-undo` disabled 동기화(2253-2254)는 `renderPlaceSelectionInfo` **조기 return 위**에 있고,
`renderSlotList` 의 **도달 가능한 모든 return 경로가 그것을 호출**함을 확인했다
(1325행 `if (!state.mapping) return;` 은 `fileMode` 계산상 도달 불가 — `FLOOR_ROI_USE_LLM=false` 이므로
`fileMode=false` 가 되려면 `state.mapping` 이 truthy 여야 한다). → **stale 없음.**

### C-5 저장 전 파일 무변경 ✅ + 저장 왕복 성립(구현자 §5-3 미검증분 **해소**)

- 세 함수(`clearPlaceDrawing`·`clearCurrentPresetSpaces`·`undoPlaceRoi`) 본문에 `fetch` 0.
- `data/Place01/PtzCamRoi.json` mtime `2026-07-28 13:16:30` — 라운드 코드 편집(13:35~)·본 검증(13:48~) **이전**. 무변경.

구현자가 "서버 왕복이라 미검증"이라 한 부분을 **임시 테스트로 실행 확인**했다(검증 후 삭제 완료):

```
✓ 빈 배열 PUT 이 적용되고 대상 프리셋만 비고 다른 프리셋은 남는다   (applied === true)
✓ savePlaceRoi 순회 전체 PUT 후 재로딩 결과가 1..N 정합
  [QA] 재로딩 byPreset keys = [ '1:2' ]  idx = [ 1 ]
```

- `PlaceRoiPutSchema.spaces` 는 `z.array(...)`(min 없음) → **빈 배열 통과** ✅ (설계 F7 확인)
- `applyPlaceRoiUpdateEx` 는 대상 preset 매칭 시 `applied = true` 를 세우므로 **빈 배열도 적용된다** ✅
- **R3 이월 사실도 실행으로 확정**: 면 0개가 된 프리셋은 재로딩 시 `byPreset` 에서 **빠진다**(`keys=['1:2']`).
  → 그 프리셋에 다시 그려 저장할 때 `needsPlaceSkeleton=true` → **라이브 프레임 필요**. 문서화 필수.

---

## 5. (D) 구현자 자가신고 판정

### D-1. `#place-clear-preset` disabled 동기화 생략 — **사유는 사실. 대안도 안전하다. 승인.**

주장 검증(코드 원문):

```js
4940 $('sel-cam').addEventListener('change', (e) => {
       … renderDetectSelection(); renderPresetSelect(); drawRoiOverlay();
         renderSelectionInfo(); gotoPreset(); reconnectLiveIfActive();   ← renderSlotList() 없음
4952 $('sel-preset').addEventListener('change', (e) => {
       … renderSlotList(); …                                            ← 있음
```

**구현자 진술 그대로다.** `#place-clear-preset` 의 활성 조건은 `currentFrameKey()` 파생인데
카메라 전환 경로에 `renderSlotList()` 가 없으므로, disabled 동기화를 넣었다면 카메라 전환 후 버튼이
**잘못 잠긴 채 굳는다** — 이번 라운드가 고치는 "조용한 무반응"과 정확히 같은 부류다.

대안(항상 활성 + 클릭 시점 안내)의 안전성:
- 빈 프리셋이면 `confirm` 이전에 안내 문구만 내고 **return**(2348-2351) → 파괴 0
- 파괴는 `confirm` **뒤에만**(2361 `if (!ok) return;`) → 오조작 방어는 disabled 없이도 성립
→ **안전. 판정 승인.** (`sel-cam` 에 `renderSlotList()` 를 넣는 범위 밖 수정을 피한 것도 타당.)

### D-2. 테스트 앵커 `lastIndexOf` — **봉인 약화 아님. 오히려 fail-safe.**

`placeDrawClick` 본문에 `endPlaceDraw()` 가 2회(취소 가드 2444 / 커밋 2469) 나오므로 `indexOf` 는 취소 가드를
집어 순서 검사가 무의미해진다. `lastIndexOf` 는 커밋 분기를 정확히 집는다. 약화 시나리오를 역으로 점검했다:

- 커밋 분기의 `endPlaceDraw()` 가 사라지면 → `end` 가 취소 가드(앞쪽) 인덱스로 떨어져 `ensure < end` **FAIL** ✅
- `ensureFloorVisible()` 이 커밋 분기에서 빠지고 앞쪽으로 가면 → `assign < ensure` **FAIL** ✅

**두 방향 모두 red 로 떨어진다.** 봉인 유지.

---

## 6. 발견 결함

### F-1 [중] `초기화` 가 선택 면을 **confirm 없이 즉시 삭제**하고 **되돌릴 수 없다**

- 재현: 그리기 모드 아님 + 목록에서 면 선택 → `초기화` 클릭 → `deletePlaceSpace()` 즉시 실행
  (app.js:2331-2333). 스냅샷을 남기지 않으므로 바로 옆 `되돌리기` 버튼을 눌러도
  `'되돌릴 전체삭제 내역이 없습니다'` 만 뜬다.
- 기대: '초기화'라는 비파괴적 이름과 "되돌리기 버튼이 바로 옆에 있다"는 배치가 복구 가능성을 암시한다.
- 실제: 복구 불가(파일 저장 전이므로 세션 재로딩으로는 복구되나, 그러면 다른 미저장 편집이 전부 날아간다).
- 심각도 **중** — 데이터 파괴가 무확인·무복구로 일어난다. 다만 기존 `삭제` 버튼과 **동일 성질**이라
  회귀는 아니고, 설계·리더 결정(판단 2: `deletePlaceSpace` 위임)을 그대로 따른 결과다.
- 권고(택1, 전부 소규모): ⓐ `deletePlaceSpace` 진입 시에도 `placeRoiUndo` 스냅샷을 남긴다(되돌리기 일원화),
  ⓑ 초기화의 면 삭제 분기에만 confirm 을 붙인다, ⓒ 최소 조치로 title/문구에 "되돌릴 수 없습니다" 명시.

### F-2 [하] `되돌리기` 가 전체삭제 **이후의 편집까지 조용히 되감는다**

- 재현: 전체삭제 → 다른 프리셋에 면을 새로 그림(또는 번호 수정) → `되돌리기`.
- `state.placeRoi = snap.placeRoi`(2383)가 **전체 맵 통째 교체**라 그 사이 편집이 경고 없이 사라진다.
- 1단계 전체 맵 undo 의 구조적 성질이며 설계 판단 4(리더 승인)의 범위 안이지만,
  **버튼 title·복원 메시지 어디에도 이 사실이 없다.** 심각도 **하** — 문구 보강 권고.

### F-3 [하] `#roi-floor` 강제 ON 의 **네 번째 진입점 누락** — 목록에서 면 선택

- `selectPlaceSpace`(2275-2287)에 `ensureFloorVisible` 없음. 바닥 토글이 꺼진 상태에서 목록 행을 클릭하면
  선택 하이라이트·정점 핸들이 **전부 안 보인다**(표시 644 · 히트테스트 1396 둘 다 `#roi-floor` 요구).
- 리더 지시는 3개 진입점이므로 **요구 위반 아님**. 다만 이번 라운드가 제거하려는 결함 부류가 한 곳 남았다.

### F-4 [정보] 코너케이스 — idx 없는 원소가 섞이면 전체삭제가 그 프리셋을 완전히 비우지 못한다

```
입력  1:1=[{idx 없음}, {idx:1}]  1:2=[{idx:2}]   → clearPresetSpaces(_, '1:1')
출력  1:1=[1]  1:2=[2]      ← idx 없는 원소가 살아남아 재번호로 idx 1 을 받는다
```

`clearPresetSpaces` 가 `Number.isInteger(idx)` 로 필터하기 때문. **실현 가능성은 사실상 0**이다 —
`normalizePtzCamRoi` 가 idx 없는 면을 로드 단계에서 떨구고, `savePlaceRoi`(2519-2525)에 idx 가드도 있다.
throw 0·미붕괴는 확인됐으므로 **결함이 아니라 기록**으로 남긴다.

### F-5 [정보] `되돌리기` 라벨 중복

`#place-undo`(주차면 목록·편집)와 `#align-undo`(자동보정, index.html:339)가 **같은 문구 "되돌리기"** 다.
섹션이 달라 id 충돌·동작 혼선은 없지만 화면에 같은 이름 버튼이 둘이다. 문구 구분 권고(정보).

---

## 7. (E) 회귀 — 그리기 off 시 완전 동일

실행 명령: `node qa_off.mjs` (배포 원문 `drawPlaceDrawOverlay` 실행, 캔버스 명령 계수)

```
그리기off + 정점편집off                    : 발행 명령 0건 (캔버스 변화 0)
그리기off + 정점편집on + 선택없음          : 발행 명령 0건 (캔버스 변화 0)
그리기off + 정점편집on + 선택있음(바닥off) : 발행 명령 0건 (캔버스 변화 0)
```

- **캔버스 경로**: `mousedown` 은 `if (state.placeDraw) { placeDrawClick(e); return; }`(4660) 한 줄이 앞에 붙었을 뿐
  null 이면 아래 기존 코드가 원문 그대로 실행된다. `mousemove` 는 `if (!state.placeDraw) return;`(4760)로 시작하는
  **별도 리스너**라 기존 `window` mousemove(`if (!dragState) return;`)와 간섭 0. `mouseup` 미변경.
  (※ 이 두 줄은 **이전 라운드** 산물이며 이번 라운드는 손대지 않았다.)
- **목록 UI**: `renderSlotList`(1284-1335) 이번 라운드 변경 0. 병기 분기(1321) 유지 + 봉인 테스트 green.
- **`git diff --numstat` 독립 확인**: 무변경 목표 7/8 완전 무변경, `groundModel.ts` 는 이전 라운드분(§1 R-4),
  `app.css` 이번 라운드 무수정, `src/**` 이번 라운드 무수정.

---

## 8. (F) 회귀 테스트 — 직접 실행 결과 원문

```
$ npx tsc --noEmit
(출력 없음) exit 0

$ npx vitest run
 Test Files  256 passed (256)
      Tests  3075 passed (3075)
   Start at  13:48:47
   Duration  14.82s (transform 8.74s, collect 47.03s, tests 29.37s, prepare 24.84s)

$ npx vitest run test/groundGrid.test.ts test/placeDraw.test.ts test/placeDrawWiring.test.ts test/viewerDisplayReset.test.ts
 ✓ test/viewerDisplayReset.test.ts (8 tests)     ← S5-T2(resetOverlayDisplay 에 roi-floor 없음) green
 ✓ test/placeDrawWiring.test.ts (36 tests)
 ✓ test/placeDraw.test.ts (15 tests)
 ✓ test/groundGrid.test.ts (13 tests)
 Test Files  4 passed (4)
      Tests  72 passed (72)

$ npx vitest run test/groundGrid.test.ts -t "골든"
 ✓ test/groundGrid.test.ts > 골든 해시 (결정론 CI 봉인) > 실데이터 cam1 preset1 격자+quad 의 sha256(stringify5) 고정
 Tests  1 passed | 12 skipped (13)
```

**L3 골든 해시 green 명시.** 구현자 보고 수치(256/3075)와 일치.

---

## 9. ★ 못 한 검증 (정직하게)

1. **브라우저 실렌더 — 못 했다.** 이번 라운드의 **본체**가 그것이다. 내가 댄 근거는
   "게이트가 `#roi-floor` 하나뿐이고, 그 뒤에 초록 면을 막는 조건이 없으며, 강제 ON 이 렌더보다 먼저다"
   라는 **코드 전수 확인**까지다. 실제 픽셀은 보지 못했다. → **마스터 육안 1순위 유지.**
2. **3점 예고 점선이 사용자 눈에 "닫힘"으로 읽히는가** — 캔버스 명령 발행은 증명했지만
   시인성(점선 4/4px, 노랑 #ffd60a, 배경 대비)은 화면 없이 판단 불가.
3. **`confirm()` 다이얼로그 실동작 · 버튼 클릭 · 2행 레이아웃 줄바꿈** — DOM 없이 실행 불가. 미검증.
   (id 중복 0 · 결선 존재 · title/문구는 텍스트로 확인.)
4. **실서버 왕복(PUT → 파일 쓰기 → GET 재로딩)** — 서버를 띄우지 않았다.
   대신 `applyPlaceRoiUpdateEx` + `normalizePtzCamRoi` 를 **직접 실행**해 빈 배열 PUT 성립과
   재로딩 정합·R3 이월 사실까지 확인했다(§4 C-5). HTTP 계층·파일 I/O 는 미검증.
5. **별건 관찰(실카 자동ROI 격자 스케일)** — 지시대로 손대지 않았다.

---

## 10. 최종 판정

| 항목 | 판정 |
|---|---|
| (A) `#roi-floor` 강제 ON 본체 | **코드로 성립 확정 / 화면 미확인** — 게이트 1개, 3진입점 전부, 순서 전부 선행 |
| (B) 3점 닫힘 예고 · 4점 도달 불가 | ✅ **독립 실행 재현 완료**, 1·2점 회귀 0 |
| (C) 초기화 / 전체삭제 / idx 정합 | ✅ 실행 증명(랜덤 500 포함). 단 **되돌리기는 전체삭제만 복구**(F-1) |
| (D) 자가신고 D-1 · D-2 | ✅ **둘 다 사실. 승인** |
| (E) 회귀 | ✅ 캔버스 0건 · 목록 UI 무변경 · 무변경 목표 7/8 + 1건은 이전 라운드분 |
| (F) tsc / vitest / 골든 해시 | ✅ 0 에러 · 256 files / 3075 tests · 골든 green |

**병합 가능 판정: 조건부 승인.** 기능·정합·회귀는 통과했다. 남은 것은
(ㄱ) **마스터 육안으로 초록 면 표시 확인**(본체), (ㄴ) **F-1 처리 방침 결정**(문구 보강만으로도 가능),
(ㄷ) F-2·F-3·R3 을 문서에 명시. F-1~F-3 은 모두 **이번 라운드가 만든 새 위험이 아니라 기존 성질의 노출**이다.

### 검증에 쓴 임시 산출물

- `qa_render.mjs` · `qa_clear.mjs` · `qa_off.mjs` — scratchpad(프로젝트 외부). 저장소 무오염.
- `test/__qa_tmp_emptyput.test.ts` — 검증 후 **삭제 완료**(`git status -- SettingAgent/test` 로 잔존 0 확인).
- `data/` **무접촉** — `PtzCamRoi.json` mtime `13:16:30` 불변, md5 `67a09455b07e48e7a5fb78c494a0c63c`.
