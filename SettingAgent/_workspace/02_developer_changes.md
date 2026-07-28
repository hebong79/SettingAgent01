# 02 구현 결과 — 그리기 렌더 결함 수정 + ROI 초기화/전체삭제

작성: 2026-07-28 / 입력: `_workspace/01_architect_plan.md` + `_workspace/00_leader_context.md`(리더 결정 우선)
검증: `npx tsc --noEmit` **0 에러** · `npx vitest run` **256 파일 / 3075 테스트 전량 통과**(L3 골든 해시 포함)

---

## 0. 먼저 — 무엇이 실제로 화면에 그려지는지의 근거

리더 지시대로 "테스트 통과"를 동작 증명으로 삼지 않았다. **배포 소스(`web/app.js`)의 미리보기 렌더 구간을
문자열로 잘라 그대로 실행**하고, 캔버스 컨텍스트를 기록기로 바꿔 **실제 발행되는 드로잉 명령 시퀀스**를 찍었다
(복사본이 아니라 shipped 원문 48줄을 `new Function` 으로 실행).

| 점 수 | 실제 발행된 명령(폴리곤 구간) | 판정 |
|---|---|---|
| 1점 | `save → beginPath → arc → fill → stroke → fillText("1")` | 변경 전과 **동일**(회귀 0) |
| 2점 | `beginPath → moveTo → lineTo → stroke` + 점 원 2개 | 변경 전과 **동일**(열린 선 유지) |
| **3점** | `beginPath → moveTo → lineTo → lineTo → stroke` → **`save → setLineDash([4,4]) → beginPath → moveTo(p3) → lineTo(p1) → stroke → restore`** | **닫힘 예고 점선이 실제로 발행된다** ← 사용자가 체감할 유일한 시각 변화 |
| 4점 | `... → lineTo → closePath → fill → stroke` | closePath/채움 발행 확인. 다만 **이 경로는 실행 도달 불가**(아래) |
| 2점+커서 | `setLineDash([5,4]) → moveTo(마지막점) → lineTo(커서) → stroke → setLineDash([])` | 고무줄선 **그대로**(회귀 0) |

즉 **이번 수정으로 화면이 실제로 바뀌는 지점은 두 개뿐**이다:
1. **3점째 점선 닫힘 예고**(위 표에서 실행으로 확인)
2. **`#roi-floor` 강제 ON 으로 초록 파일 ROI 가 보이게 되는 것** — 이건 실행으로 확인 **못 했다**(§5 미검증).

### ★ 리더 진단 정정을 코드에 명시했다
`drawPlaceDrawOverlay` 의 `pts.length === 4` 분기에 **도달성 사실을 주석으로 박아 두었다**:
4점째 클릭은 `placeDrawClick` 에서 렌더를 거치지 않고 같은 동기 블록에서 커밋되고 `endPlaceDraw()` 가
`state.placeDraw = null` 로 만들기 때문에 **이 분기는 현재 실행되지 않는다**. `closePath()`/채움은
리더 지시대로 **방어로만** 넣었고, 사용자 체감은 3점 예고선이 만든다.

---

## 1. 파일별 변경

| 파일 | 상태 | 변경 |
|---|---|---|
| `web/placeDraw.js` | 수정 | `removePlaceSpace` import 추가 + **`clearPresetSpaces` 신규**(순수·DOM 0·throw 0) |
| `web/placeDraw.d.ts` | 수정 | `clearPresetSpaces` 선언 추가 |
| `web/index.html` | 수정 | `.roi-edit-bar` **2행 분리** + 버튼 3개(`place-clear`·`place-clear-preset`·`place-undo`). 기존 id·속성·순서 무변경 |
| `web/app.js` | 수정 | 렌더 수정 · `ensureFloorVisible` 신규 + 3곳 호출 · 신규 함수 3개 · `state.placeRoiUndo` · `renderPlaceSelectionInfo` 동기화 · `savePlaceRoi` 스냅샷 소진 · `wire()` 결선 3줄 · import 1줄 |
| `test/placeDraw.test.ts` | 수정 | `T8 clearPresetSpaces` describe 4건 추가 |
| `test/placeDrawWiring.test.ts` | 수정 | S1/S2/S3/S4 봉인 describe 추가(총 +19건) |

**무변경 목표 8파일 전부 무수정 확인**(`git status` 로 확인):
`groundModel.ts` · `project.ts` · `ground/types.ts` · `floorRoi.ts` · **`web/core.js`** · `Finalizer.ts` · `SqliteStore.ts` · `roiDbLoad.ts`.
`web/app.css` 도 이번 라운드 무수정. 서버(`src/**`) 무수정.

> ⚠️ `git diff --stat` 에는 `groundModel.ts`·`app.css`·`captureRoutes.ts` 등이 변경으로 보이는데,
> **이는 이전 라운드의 미커밋 작업분이다**. 이번 라운드에서 내가 편집한 파일은 위 표 6개뿐이다.

---

## 2. 신규 함수 시그니처

```js
// web/placeDraw.js — 순수
export function clearPresetSpaces(placeRoi: PlaceRoiMap|null|undefined, key: string): PlaceRoiMap;

// web/app.js — DOM/state
function ensureFloorVisible(): void;         // #roi-floor 강제 ON (사용자 명시 조작 직후 전용)
function clearPlaceDrawing(): void;          // #place-clear
function clearCurrentPresetSpaces(): void;   // #place-clear-preset (confirm 필수)
function undoPlaceRoi(): void;               // #place-undo
```

`clearPresetSpaces` 는 대상 키의 idx 를 **큰 것부터** 모아 `core.js` `removePlaceSpace` 로 접는다
(`removePlaceSpace` 는 지운 idx **보다 큰** 것만 당기므로 남은 대상 idx 가 흔들리지 않는다).
→ 재번호 로직 신규 구현 0, **core.js 무수정**, 전체삭제 = 기존 '삭제' n회와 동일.

---

## 3. 계약으로 봉인한 것

- **커밋 순서**: `state.placeRoi = placeRoi` → `ensureFloorVisible()` → `endPlaceDraw()`.
  `ensureFloorVisible` 이 뒤로 가면 그 프레임은 노랑도 초록도 없는 **빈 프레임**이 된다.
  코드 주석 + 테스트(S1-T3)로 둘 다 박았다.
- **`ensureFloorVisible` 은 자동 경로에 없다**: `drawRoiOverlay`·`drawFileFloorRoi`·`loadPlaceRoi` 본문에
  없음을 테스트로 봉인(S2-T2) — 폴링·렌더 루프가 사용자 토글을 마음대로 켜지 않는다.
- **정점 핸들의 `#roi-floor` 의존은 그대로**(표시 644 / 히트테스트 1373 대칭 유지, S2-T3).
- **초기화 우선순위**: 첫 분기가 `state.placeDraw`(비파괴 우선), 그리는 중 분기는 `state.placeRoi` 를
  대입하지 않고 `endPlaceDraw` 도 부르지 않는다(모드 유지). 면 삭제는 `deletePlaceSpace()` **위임**.
- **파일 접촉 0**: `clearPlaceDrawing`·`clearCurrentPresetSpaces`·`undoPlaceRoi` 본문에 `fetch` 없음(테스트 봉인).
- **되돌리기**: `state.placeRoiUndo`(전체 맵 깊은 복사) 1단계. 스냅샷 대입이 `clearPresetSpaces` 호출보다
  **앞**. `state.placeRoiBackup`(자동보정 전용)은 **한 글자도 건드리지 않는다**. `savePlaceRoi` 성공 시 소진.

---

## 4. 계획서와 달라진 점 (2건) — 둘 다 사유 있음

### D-1. `#place-clear-preset` 의 `disabled` 동기화를 **넣지 않았다**
계획서 파일별 변경 ⑤ 는 `renderPlaceSelectionInfo` 에서 `#place-undo` 와 `#place-clear-preset` **둘 다**
disabled 동기화하라고 했다. `#place-undo` 만 넣었다.

**사유(코드 확인)**: `#place-clear-preset` 의 활성 조건은 `currentFrameKey()` 에서 파생되는데,
**카메라 전환 핸들러(`$('sel-cam')` change, app.js:4940 부근)는 `renderSlotList()` 를 호출하지 않는다**
(프리셋 전환 `$('sel-preset')` 은 호출한다). 따라서 카메라를 바꾸면 버튼이 **잘못 잠긴 채 굳는다** —
"눌러도 아무 일이 없다"는, **이번 라운드가 고치고 있는 결함과 정확히 같은 부류**다.
`sel-cam` 에 `renderSlotList()` 를 추가하는 것은 범위 밖 기존 코드 수정이라 택하지 않았다.
→ 버튼은 항상 활성, 빈 프리셋 방어는 **클릭 시점 안내 문구**(`cam{c} 프리셋{p} 에는 지울 주차면이 없습니다`)로 한다.
파괴는 confirm 뒤에만 일어나므로 안전성 손실 0. 테스트로 이 결정을 봉인했다.
`#place-undo` 는 `state.placeRoiUndo` 파생이고 이를 바꾸는 세 곳(전체삭제·되돌리기·저장)이 **전부**
`renderSlotList()` 를 거치므로 staleness 가 없다 → 계획대로 동기화 유지.

### D-2. 테스트 S1-T3 의 앵커를 `lastIndexOf` 로 바꿨다
`placeDrawClick` 에는 `endPlaceDraw()` 가 두 번 나온다(상단 '프리셋 바뀜' 취소 가드 + 커밋 분기).
`indexOf` 로는 취소 가드 쪽을 집어 순서 검사가 무의미해진다(실제로 처음엔 이 때문에 빨간불이 났다).
커밋 분기의 것(마지막)을 집도록 고쳤다. **코드가 아니라 테스트 앵커의 결함**이었다.

---

## 5. 미완 · 미검증 (정직하게)

1. **`#roi-floor` 강제 ON 이 실제로 초록 면을 보이게 하는지 — 브라우저에서 확인 못 했다.**
   이게 **이번 수정의 본체**인데, 내가 댈 수 있는 근거는 "코드 경로가 그렇게 되어 있다"까지다:
   `drawFileFloorRoi` 첫 줄 `if (!$('roi-floor').checked) return;` 가 유일한 게이트이고
   `selectFloorRoi` 는 필터링을 하지 않는다 → 토글이 켜지면 그려져야 한다. **실렌더는 미확인.**
   → **마스터 육안 확인 필요 항목 1순위.**
2. **`confirm()` 다이얼로그 · 버튼 클릭 · 2행 레이아웃**은 DOM 없이 실행할 수 없어 미검증
   (id 중복 0, `.toolbar` 가 `display:flex; flex-wrap:wrap`, `.roi-edit-bar` 에 `margin-bottom:8px` 이라
   2행이 자연히 쌓인다는 CSS 확인까지만 했다. **CSS 무수정**).
3. **전체삭제 → 저장 → 재로딩 왕복**은 서버 왕복이라 미검증. 설계 근거(빈 배열 PUT 통과·`assemblePlaceRoi`
   가 빈 키를 `[]` 로 보존)는 설계자가 코드로 확인했고 나는 그것을 재확인하지 않았다.
4. **R3 이월**: 전체삭제 후 그 프리셋이 파일에서 면 0개가 되면 다음 로드에서 `placeRoiFileKeys` 에서 빠져
   `needsPlaceSkeleton = true` 가 된다 → 그 프리셋에 다시 그려 저장할 때 **라이브 프레임이 필요**하다.
   기존 신규 주차장 경로와 동일하고 실패 메시지도 이미 있다(app.js `저장 중단: 라이브 프레임을 먼저 시작하세요`).
5. **부수효과(고지된 것)**: `ensureFloorVisible` 은 artifact 슬롯 floor 히트테스트(`layers.floor`)도 켠다.
   이는 `#roi-floor` 기본값(checked) 상태와 **동일한 동작**이라 새 동작이 아니다.
6. **별건 관찰(실카 자동ROI 격자 스케일)** — 지시대로 **손대지 않았다**.

---

## QA 수정 라운드 (2026-07-28, `03_qa_report.md` 대응)

검증: `npx tsc --noEmit` **0 에러** · `npx vitest run` **256 파일 / 3079 테스트 전량 통과**(+4건, L3 골든 해시 green).
변경 파일은 **기존 3개뿐**(`web/app.js` · `web/index.html` · `test/placeDrawWiring.test.ts`).
무변경 목표 8파일 + `web/app.css` + `src/**` + `web/core.js` + `web/placeDraw.js` **추가 수정 0**.

### F-1 [중] 초기화의 면 삭제가 복구 불가 → **되돌리기 일원화로 해결**

리더 요구("1단계 스냅샷이 초기화·전체삭제 **양쪽**을 복구한다")를 충족시켰다.
스냅샷 로직을 두 벌 만들지 않으려고 헬퍼 2개로 접었다:

```js
function snapshotPlaceRoi(label): void   // 파괴 **직전** 전체 맵 깊은 복사 → state.placeRoiUndo
function sealPlaceRoiUndo(): void        // 파괴 **직후** 결과 지문(JSON) 봉인 → F-2 판정 근거
```

`clearPlaceDrawing` 의 면 삭제 분기 = `snapshotPlaceRoi(...)` → `deletePlaceSpace()` → `sealPlaceRoiUndo()`.
`clearCurrentPresetSpaces` 도 같은 헬퍼를 쓰도록 인라인 스냅샷을 교체했다(동작 동일).

**`confirm` 은 붙이지 않았다 — 사유**: ⓐ 이제 `되돌리기` 로 복구되므로 "무확인·무복구"라는 F-1 의 핵심(복구 불가)이
사라졌다. ⓑ **같은 일을 하는 기존 `삭제` 버튼은 확인을 받지 않는다** — 초기화에만 확인을 붙이면 두 버튼의 동작이
갈려 오히려 혼란스럽다(QA 가 지적한 "문구 혼동" 리스크 R4 와 같은 축). 대신 삭제 직후 문구로 복구 가능 사실을 알린다:
`주차면 #N 삭제됨(미저장) — '되돌리기' 로 복구할 수 있습니다 · '저장'을 눌러야 파일에 반영됩니다`.
버튼 title 에도 "('되돌리기' 로 복구 가능)"을 넣었다.

**기존 `삭제` 버튼(`deletePlaceSpace`)은 한 줄도 안 고쳤다** — 스냅샷은 **호출자**(초기화)가 뜬다.
`place-delete` 경로의 동작은 이전과 완전히 동일하다(회귀 0, 테스트 F-1b 로 봉인).

> 남는 사실(정직): **`삭제` 버튼으로 지운 면은 여전히 복구되지 않는다.** 리더 요구는 "초기화·전체삭제 양쪽"이었고
> `place-delete` 를 손대는 것은 범위 밖이라 그대로 뒀다. 필요하면 다음 라운드 판단 사항이다.

### F-2 [하] 되돌리기의 조용한 되감기 → **문구 + 실제 손실이 있을 때만 확인**

"문구 또는 범위 축소" 중 **문구만으로는 부족**하다고 판단했다 — 항상 뜨는 경고문은 읽히지 않고, 정작
손실이 없는 대다수 경우에도 불안을 준다. 범위 축소(프리셋 단위 undo)는 전체삭제가 **다른 프리셋의 전역번호까지**
바꾸므로 복구가 불가능해진다(설계 판단 4 의 근거 그대로).

→ **지문 대조**를 택했다. `sealPlaceRoiUndo` 가 파괴 직후 결과를 `JSON.stringify` 로 저장하고,
`undoPlaceRoi` 는 되돌리기 시점의 맵이 그 지문과 **다를 때만** 확인을 묻는다:

```
'{label}' 직전의 **전체** 주차면 상태로 되감습니다.
그 뒤에 한 편집(새로 그린 면 · 번호 수정 · 다른 프리셋 변경)도 **함께 사라집니다**.
되돌리기는 1단계뿐이라 이 작업은 다시 되돌릴 수 없습니다.
```

손실이 실제로 발생할 때만 뜨므로 경고가 무뎌지지 않는다. 지문 불일치는 **보수적**으로만 틀린다
(오탐 = 확인 한 번 더, 데이터 위험 0). 복원 메시지도 범위를 명시하도록 고쳤다(`… 직전 상태(전체 프리셋) …`),
`#place-undo` title 에도 ⚠ 고지를 넣었다. "되돌릴 전체삭제 내역이 없습니다" → "되돌릴 내역이 없습니다(초기화·전체삭제 직후에만 가능)".

### F-3 [하] 네 번째 진입점 → `selectPlaceSpace` 에 추가

목록 행 클릭 시 `ensureFloorVisible()` 을 **`drawRoiOverlay()` 앞**에 넣었다(1프레임 지연 없음).
이제 진입점은 **4/4**: 그리기 시작 · 커밋 · 정점편집 ON · 목록 선택. 테스트 S2-T1 을 4곳 검사로 확장했다.

### ★ F-1 실행 증명 — "초기화로 면 삭제 → 되돌리기 → 복구" (요청 사항)

테스트가 아니라 **배포 소스 `web/app.js` 에서 함수 정의 원문을 그대로 잘라내 실행**했다
(`snapshotPlaceRoi`·`sealPlaceRoiUndo`·`clearPlaceDrawing`·`deletePlaceSpace`·`undoPlaceRoi` 5개.
재작성·복사 없음. `core.js` `removePlaceSpace` 와 `placeDraw.js` `clearPresetSpaces` 는 실모듈 import).

```
=== 시나리오 1: 초기화로 면 삭제 → 되돌리기 → 복구 ===
[1] 삭제 전   1:1=[idx1, idx2]  1:2=[idx3]        선택=2  스냅샷=없음
[2] 초기화 클릭 → 1:1=[idx1]      1:2=[idx2]        선택=null 스냅샷=있음
    msg: 주차면 #2 삭제됨(미저장) — '되돌리기' 로 복구할 수 있습니다 · '저장'을 눌러야 파일에 반영됩니다
[3] 되돌리기   1:1=[idx1, idx2]  1:2=[idx3]        선택=null 스냅샷=없음
    msg: 되돌렸습니다: 주차면 #2 삭제 직전 상태(전체 프리셋) — 여전히 미저장 상태입니다

복구 성공(원상 일치, 좌표까지 바이트 동일)? true
1..N 순열 유지(normalizeGlobalIdx.changed === false)? true
스냅샷 소진? true
```

- 삭제 시 `1:2` 의 면이 **idx 3 → 2 로 재압축**됐다가 되돌리기로 **3 으로 정확히 복원**된다
  (프리셋 단위 undo 였다면 복구 불가능했을 지점 — 전체 맵 스냅샷 선택의 실증).

```
=== 시나리오 2: 삭제 후 다른 편집 → 되돌리기 (F-2) ===
[1] 삭제 후 다른 프리셋에 1면 추가 → 1:1=1면, 1:2=2면
[2] 되돌리기 → CONFIRM> '주차면 #1 삭제' 직전의 **전체** 주차면 상태로 되감습니다.
    조용한 손실 방지: 확인 질문 발생 = true

=== 시나리오 3: 그리는 중 초기화 (비파괴 경로 회귀) ===
    점 개수 0 / 그리기모드 유지 = true
    placeRoi 불변 = true / 스냅샷 생성 안 함 = true
    msg: 1/4 — 찍은 점을 모두 지웠습니다. 모서리를 다시 4번 클릭하세요. Esc=취소
```

시나리오 3 이 중요하다 — **비파괴 분기는 스냅샷을 만들지 않는다**(점만 지우는데 undo 스택을 소비하면
직전 삭제의 복구 기회를 조용히 날린다). 실행으로 확인했다.

### 이번 수정 라운드에서 못 본 것 (여전히 정직하게)

1. **브라우저 실렌더는 여전히 미확인.** F-3 로 진입점이 4/4 가 됐지만, "토글이 켜지면 초록 면이 실제로 뜬다"는
   코드 경로 확인까지다. QA 도 §9-1 에서 같은 한계를 적었다. **마스터 육안 1순위 유지.**
2. **`confirm()` 다이얼로그 실동작** — F-2 의 확인창은 지문 대조 로직까지만 실행 증명했고(스텁 confirm),
   실제 브라우저 모달은 못 봤다.
3. **F-2 지문의 오탐률** — `JSON.stringify` 키 순서에 의존한다. 이번 경로들(`assemblePlaceRoi`·spread)은
   키 순서를 보존하지만 **모든 편집 경로를 전수 확인하지는 않았다**. 오탐 시 결과는 "확인창이 한 번 더 뜬다"
   뿐이라 데이터 위험은 없다고 판단했으나, **전수 확인은 안 했다.**
4. QA 지적 중 **F-4(idx 없는 원소 코너케이스)·F-5(되돌리기 라벨 중복)** 는 QA 스스로 [정보] 로 분류했고
   리더 수정 지시에도 없어 **손대지 않았다**. F-5 는 실화면에 "되돌리기" 버튼이 둘(`#place-undo`/`#align-undo`)이라
   문구 구분이 필요할 수 있다 — 다음 라운드 판단 사항으로 남긴다.
5. **별건 관찰(실카 자동ROI 격자 스케일)** — 지시대로 손대지 않았다.

---

## 6. 검증 커맨드

```
cd SettingAgent
npx tsc --noEmit          # 0 에러
npx vitest run            # 256 files / 3079 tests 전량 통과(QA 수정 라운드 후)
npx vitest run test/placeDraw.test.ts test/placeDrawWiring.test.ts   # 신규 봉인만
```
