# 03 QA 검증 보고 — 주차면(파일 ROI) **신규 그리기** 도구

작성: 2026-07-28 / 검증자(qa-tester)
입력: `00_leader_context.md` · `01_architect_plan.md` · `02_developer_changes.md` + 변경 소스 전량
방법: **구현자 테스트를 신뢰하지 않고 독립 재현** — 임시 테스트 `test/_qaIndependent.test.ts`(12케이스) 자체 작성·실행 후 삭제.
`data/` 실파일 **무접촉**(증명은 §7).

---

## 0. 종합 판정

**조건부 통과.** 리더 지시 사항(승인 1~3 · F-3 · F-5 · F-6 · R2 · 승인 2/R3)은 **전부 구현·검증됐고**,
회귀 0 은 **git diff 수준에서 구조적으로 증명**됐다. Loop 4(L3 종단)는 검증자가 **구현 코드 경로로 실제 실행해 성공**시켰다.

다만 **결함 1건(D-1, 중)** 이 남는다 — *파일은 존재하는데 그리려는 cam/preset 이 파일에 없는* 경우
프런트가 `create` 를 붙이지 않아 **저장이 영구히 불가능**하다. F-3 덕분에 "조용히" 실패하진 않지만
사용자가 UI 로 빠져나올 방법이 없다.

**미검증(위장 금지)**: 브라우저 실렌더 · `frame.naturalWidth` 실측 대조는 **검증자도 못 했다**(§6).

---

## 1. 회귀 검증 (G) — 실행 원문

```
$ npx tsc --noEmit
(출력 없음)   exit 0

$ npx vitest run
 Test Files  256 passed (256)
      Tests  3047 passed (3047)
   Start at  11:53:42
   Duration  16.78s

$ npx vitest run test/groundGrid.test.ts        ← L3 골든 해시
 ✓ test/groundGrid.test.ts (13 tests) 20ms
 Test Files  1 passed (1) / Tests 13 passed (13)
   봉인 해시: 3b5656b37cf57c4fd00ffa73c5d5d5ea53308c19c1eb60d0b14240f402ea0a73  → green

$ npx vitest run test/_qaIndependent.test.ts    ← 검증자 자체 작성(삭제 완료)
 Test Files  1 passed (1) / Tests 12 passed (12)
```

**L3 골든 해시 green.** 구현자 신고 수치(256/3047)와 **완전 일치** — 과장 없음.

---

## 2. Requirements 항목별 판정표

| # | 항목 | 판정 | 근거(독립 확인) |
|---|---|---|---|
| R-1 | **★ 기존 동작 회귀 0** (그리기 off 시 캔버스 상호작용 동일) | **통과(강)** | §3 |
| R-2 | 드래그 kind 충돌 검토 | 통과 | 신규 `placeVertex` 는 `#place-edit-vertex`(기본 unchecked) 뒤. `hitTestPlaceVertex` 첫 줄이 `if (!$('place-edit-vertex')?.checked) return null;` → OFF 면 null. `floorVertex` 는 `!FLOOR_ROI_USE_LLM`(상수 false) 로 도달 불가(F-4 재확인) |
| R-3 | **빈 파일/파일 부재에서 시작 가능** | **통과(파일 부재)** / **결함(파일 존재+대상 부재)** | §4-B / **D-1** |
| R-4 | Esc 취소 · 되돌리기 | 통과 | `wire()` 안에서 기존 keydown **보다 먼저** 등록 + `stopImmediatePropagation()`. Esc=취소 / Ctrl+Z=1점 되돌리기. `if (!state.placeDraw) return;` 로 평상시 통과 |
| R-5 | **저장은 명시적 트리거** | 통과 | `placeDrawClick` 본문에 `savePlaceRoi`·`'PUT'`·`fetch(...)` 문자열 없음(직접 grep). 커밋은 `markPlaceDirty()` 까지 |
| R-6 | 결정론 · round5 · throw 금지 · 순회 순서 고정 | 통과 | 자체 테스트 F2. `0.123456789 → 0.12346` 5자리, 2회 호출 결과 `toEqual`. `movePlaceVertex(null,…)` → `null` 반환(throw 0). `appendPlaceSpace` 는 `{...map, [key]:…}` 로 기존 키 순서 보존 |
| R-7 | **무변경 목표 파일** | **통과** | §5 |
| R-8 | 기존 테스트 유지 · tsc 0 · vitest 전량 | 통과 | §1 |
| R-9 | 범위 밖 리팩토링 금지 | 통과 | app.js 삭제 라인 = 6줄(전부 자기 변경분의 확장). `wireOverlayEditing` 삭제 = **1줄**(§3) |
| 승인1 | `groundModel.ts` = `export` 2개뿐, 값 8/400 불변 | **통과** | §5 |
| 승인2 | R3 — artifact 존재 시 새 면 목록 노출 | **통과(단, 부작용 D-2)** | §4-D |
| 승인3/F-1 | 골격에 pan/tilt/zoom 기록 | **통과** | §4-B |
| 승인3/F-2 | `naturalWidth` 출처 · 0이면 저장 거부 · 1920/1080 추측 금지 | **통과** | §4-C |
| F-3 | 조용한 거짓 성공 제거 | **통과** | §4-E |
| F-5 | placeVertex 가 `!state.mapping` 가드 위 / mousemove 조기 return | **통과(정적)** — 동적 실행은 §6-1 | §3-2 |
| F-6 | 거짓 서술 정정 | 통과 | `grep -rn "수동 드로잉" web/ src/` → **web/·index.html 0건**. 남은 1건은 `autoRoiPlan.ts:306` 의 사용자 안내문("이 프리셋은 수동 드로잉을 쓴다")인데 **이제는 참**이다(면 그리기가 실재) |
| R2 한계 | 실패 시 행동 지시 노출 | 통과 | `ggPreview` 실패 문구에 "같은 카메라의 다른 프리셋에도 주차면을 1개 그린 뒤…" 를 **항상** 덧붙임 |
| D-4 | 신규 면 idx 보장(QA-F 재생산 방지) | **통과(3중)** | §4-F |

---

## 3. ★ 회귀 0 — 소스 텍스트가 아니라 `git diff` 로 증명

구현자는 "1블록 prepend" 라고 주장했다. **`git diff` 의 삭제(`-`) 라인을 전수 조사**해 독립 확인했다.

### 3-1. `wireOverlayEditing()` 전체에서 삭제된 라인 = **단 1줄**

```
$ git diff HEAD -U2 -- web/app.js | grep "^-" (파일헤더 제외)
…
@@ -3983,4 +4464,8 @@ function wireOverlayEditing() {     ← 삭제 0 (순수 prepend)
@@ -4024,4 +4509,15 @@ function wireOverlayEditing() {     ← 삭제 0 (placeVertex 분기 삽입)
@@ -4067,4 +4563,12 @@ function wireOverlayEditing() {     ← 삭제 0 (오버레이 mousemove 커서 리스너)
@@ -4091,4 +4595,12 @@ function wireOverlayEditing() {     ← 삭제 0 (mousemove placeVertex)
@@ -4127,6 +4639,13 @@ function wireOverlayEditing() {     ← 삭제 1
-    if (!wasDetect) markDirty();
```

그 1줄의 대체는 **기존 kind 에 대해 의미 동일**하다:

```js
const wasPlace = dragState.kind === 'placeVertex';
…
if (wasPlace) { markPlaceDirty(…); void validatePlaceQuad(…); }
else if (!wasDetect) markDirty();          // ← placeVertex 가 아니면 원문과 동일한 조건·동일한 호출
```

⇒ **mousedown 핸들러는 삭제 0의 순수 prepend**이고, off 경로(`state.placeDraw === null`)에서
실행되는 코드는 **바이트 단위로 원문 그대로**다. 구조적 보장 주장은 **사실**이다.

### 3-2. F-5 가드 위치 — 실제 줄번호로 확인

| 위치 | 내용 |
|---|---|
| `app.js:4468` | `if (state.placeDraw) { placeDrawClick(e); return; }` ← mousedown 본문 **첫 문장** |
| `app.js:4514–4521` | `placeVertex` 분기 |
| `app.js:4522` | `if (state.roiHidden || !state.mapping) return;` ← **분기보다 아래** ✅ |
| `app.js:4599` | `if (dragState.kind === 'placeVertex') { … return; }` |
| `app.js:4605` | `const slot = (state.mapping.slots ?? [])…` ← **return 보다 아래** ✅ |

추가로 **4468–4521 구간에 `state.mapping` 역참조가 한 건도 없음**을 grep 으로 확인했다
(`state.mapping` 최초 등장이 4522). mousemove 도 4569–4599 구간에 mapping 역참조 0.
⇒ `state.mapping === null` 에서 신규 분기가 **TypeError 를 낼 경로가 정적으로 존재하지 않는다.**

### 3-3. 렌더 경로도 가드 위 (놓치기 쉬운 지점 — 통과)

`drawRoiOverlay()` 는 `app.js:452` 에서 `if (state.roiHidden || !state.mapping) return;` 하는데,
`drawPlaceDrawOverlay(ctx)` 호출은 **:446**(가드 이전)이다.
⇒ mapping 이 없는 신규 주차장에서도 **그리기 미리보기·정점 핸들이 렌더된다.** (설계 누락 없음)

---

## 4. (B)~(F) 실행 결과

### 4-A. 검증자 자체 테스트 12케이스 — 전부 green

`QA-B1/B2/B3` · `QA-B'1/B'2` · `QA-C1` · `QA-A1/A2` · `QA-F1/F2/F3` · `QA-D1`.

### 4-B. (B) ★ 빈 상태 — 파일 부재에서 첫 면 저장 전 경로 **실행 성공**

임시 디렉터리 `qa-empty-*/deep/nested/PtzCamRoi.json`(**상위 2단 부재**)에
`web/placeDraw.js` 의 `appendPlaceSpace(null, '1:1', quad)` 로 만든 첫 면(→ **idx 1**)을 PUT.

- `200 { ok:true, applied:true, spaceCount:1 }`, **`mkdir -p` 로 파일 생성됨**
- 생성 JSON 의 `preset` 에 **`pan`/`tilt`/`zoom` 이 실제로 기록**됨 → **F-1 충족**
- `camera.imageWidth/Height` = `create` 값 그대로
- 서버 `normalizePtzCamRoi` + 프런트 `web/core.js normalizePtzCamRoi` **양쪽 다 정상 파싱**,
  정규화 왕복 오차 **≤ 1e-5**

**Loop 4(L3 연결)를 구현 코드 경로로 실제 실행** — `POST /capture/ground-grid/bootstrap` 원문:

```
[QA-B2 bootstrap] 200 {"ok":true,"constants":{"camIdx":1,"imgW":1920,"imgH":1080,
  "d":4.95001296446665,"fovBaseV":34.63497772149298,"rollDeg":0,"fromPresetIdx":1,
  "bootstrapConf":0.46933580436901506,
  "issues":["f 공동추정 표본 1개 — 프리셋 간 교차검증 불가",
            "부트스트랩 표본 = 주차면 1개 — 프리셋 간 f 교차검증 불가(카메라 상수 정확도는 이 1면에 전적으로 의존)"]},
  "grid":{"camIdx":1,"originM":{...},"thetaDeg":89.99990305324519,…}}
```

⇒ **d = 4.95001296446665** 로 리더 실측(preset 1: `d=4.9500`)과 일치.
**"1면만 그려도 L3 부트스트랩이 된다" 는 구현 코드 경로에서 성립한다.**
경고 2건은 정직하게 노출된다(위장 없음).

**F-1 대조군**도 실행 — `create` 에서 pan/tilt/zoom 을 빼면:
```
[QA-B3 no-ptz] {"ok":false,"error":"부트스트랩 실패",
  "issues":["cam1 preset1: PTZ(pan/tilt/zoom) 미상 — 부트스트랩 불가"]}
```
⇒ 설계자 F-1 주장(PTZ 없으면 그 자리에서 실패)이 **재현됨**. 골격에 PTZ 를 넣은 것은 필수 조치였다.

### 4-C. (F-2) `imageWidth/imageHeight` 출처

- `savePlaceRoi` 는 `frame.naturalWidth/naturalHeight` **만** 사용(app.js:2386-2387).
- `> 0` 이 아니면 **PUT 을 보내지 않고 중단**(app.js:2392-2395).
- `grep -n "1920\|1080" web/app.js web/placeDraw.js web/index.html` → **1건**,
  그것도 거부 **문구** 안(`…1920×1080 을 추측하지 않습니다`)이며 **값으로 쓰이는 리터럴은 0건**. ✅

### 4-D. (D) R3 — artifact 존재 시 새 면 노출 **통과**

소스에서 조건식을 뽑아 그대로 평가:
```
[QA-D1] fileMode = !FLOOR_ROI_USE_LLM && (state.roiHidden || !state.mapping || placeSpaceCount() > 0)
  evalFileMode(roiHidden=false, mapping={slots:[]}, spaceCount=1) === true    ← 새 면이 목록에 뜬다
  evalFileMode(roiHidden=false, mapping={slots:[]}, spaceCount=0) === false   ← 파일 ROI 0개면 기존 분기 유지
```
그 분기가 쓰는 행 생성기도 실제 호출해 확인:
```
[QA-D1] rows = [{"i":1,"k":"1:1"},{"i":2,"k":"1:2"}]     ← 신규 idx 2 가 행으로 나오고 cam/preset/key 로 선택 가능
```
행 클릭 → `selectPlaceSpace(r)` → `state.selectedPlaceIdx` → `ggRefSpace()` 성립 경로 확인.
⇒ **Loop 4 의 필요조건(선택 가능)이 artifact 존재 환경에서 성립한다.**

### 4-E. (C) F-3 조용한 거짓 성공 — **재현 불가 = 고쳐졌다**

```
[QA-C1] {"ok":true,"spaceCount":1,"applied":false,"issues":["cam1 preset99 대상 없음 — 적용하지 않음"]}
```
- 고치기 전 동작(`ok:true` + `spaceCount` 만)은 **재현되지 않는다** — `applied:false` 가 항상 동반.
- 기존 면(`idx:1`)은 파일에서 **파괴되지 않음** 확인.
- UI: `savePlaceRoi` 가 `if (data.applied === false)` 에서 성공 문구 대신
  `저장 안 됨(cam…): 대상 없음…` 을 띄우고 **즉시 return**(app.js:2412-2415) → 성공 문구 미표시 ✅

⚠️ 다만 `spaceCount` 는 여전히 **요청한 개수**를 그대로 돌려준다(적용 개수가 아님).
`applied` 를 안 보는 제3의 클라이언트가 생기면 같은 착시가 재발한다 — **계약 주석에 명시 권장**(경).

### 4-F. (F) 경계면 교차 — 전역 idx 1..N 순열

실데이터와 동형인 픽스처(`test/fixtures/groundGrid.PtzCamRoi.json`, cam1 p1-3 + cam2 p1-2)로
**프런트 로드 경로 그대로** 재현: `GET` → `core.js normalizePtzCamRoi` → `normalizeGlobalIdx`.

```
[QA-F1] 기존 면 수 N = 23 · keys = 1:1,1:2,1:3,2:1,2:2
```
- 신규 면 idx = **24** (= N+1, 끝 append)
- 기존 23면의 `idx`·`points` **전부 `toEqual` 동일** (하나도 안 흔들림) ✅
- 전역 집합 = `[1..24]` **완전 순열** ✅
- `normalizeGlobalIdx(after).changed === false` → 저장 시 재부여 안 일어남(멱등) ✅
- **전 프리셋 순차 PUT → 파일 raw → 재파싱** 왕복 후에도 순열 동일, 좌표 오차 ≤ 1e-5 ✅

추가로 **검증자가 스스로 의심한 충돌 경로**를 따로 테스트(`QA-F3`):
`nextPlaceIdx` 가 "총 개수 + 1" 이므로 **중간 삭제로 번호가 성기면 중복 idx 가 난다.**
→ `removePlaceSpace` 가 재압축하는지 실행 확인:
```
[QA-F3] 삭제 후 idx = [1,2]          ← {1,2,3} 에서 2 삭제 → 재압축됨
[QA-F3] append 후 idx = [1,2,3] 신규 = 3
[QA-F3] reindex 후 append idx = [1,2,3,4]
```
⇒ 중복 없음. **단 이 안전성은 `removePlaceSpace`/`normalizeGlobalIdx` 의 1..N 불변식에 의존한다**
(외부에서 성긴 idx 를 주입하면 깨진다). 현재 코드 경로에는 그런 주입구가 없다.

### 4-G. `isUsableQuad` 재구현 없음 — **다른 시드로 재현**

구현자는 고정 시드 1개 × 200케이스를 썼다. 검증자는 **시드 5종(1 / 777 / 123456789 / 2026 / 999983) × 400 = 2000 케이스**,
스케일을 `10^-3 ~ 10^-0.3` 로 로그 분포시켜 **임계 근처를 의도적으로 많이** 뽑았다.

```
[QA-A1] 2000 케이스 · ok=194 · mismatch=0
```

구현자 자가신고 4(임계 경계 부동소수)를 정면으로 겨냥한 **경계 스윕**도 추가 —
정사각형 한 변을 7.80px→20.40px 로 0.01px 씩(총 1261 케이스, 변 8px 경계와 면적 400px²(=변 20px) 경계를 모두 관통):

```
[QA-A2] 경계 스윕 mismatch= 0
```

⇒ **정규화 왕복 후에도 판정 불일치 0.** 자가신고 4는 **실측상 문제 없음**으로 강등한다
(원리적 가능성은 남지만 관측되지 않았다). `quadDiag.ts` 는 `ok = isUsableQuad(quad)` 를
그대로 대입할 뿐 재계산하지 않으며, 임계값도 `groundModel.js` 에서 import 한다(숫자 중복 0) — 소스로 확인.

---

## 5. 무변경 목표 파일 · 승인 1 — 독립 확인

```
$ git diff --numstat HEAD -- <각 파일>
src/ground/project.ts     -> NO_CHANGE
src/ground/types.ts       -> NO_CHANGE
src/capture/floorRoi.ts   -> NO_CHANGE
web/core.js               -> NO_CHANGE
src/capture/Finalizer.ts  -> NO_CHANGE
src/capture/SqliteStore.ts-> NO_CHANGE
src/capture/roiDbLoad.ts  -> NO_CHANGE
```
(구현자·설계자 문서의 `project.ts`/`roiDbLoad.ts` 경로 표기는 실제와 다르다 —
실제는 `src/ground/project.ts`·`src/capture/roiDbLoad.ts`. 실경로로 재확인했고 **전부 무변경**.)

**승인 1 — `groundModel.ts` diff 전문:**
```diff
-/** quad 최소 변 길이(px). … */
-const MIN_EDGE_PX = 8;
-/** quad 최소 면적(px²). … */
-const MIN_AREA_PX = 400;
+/** quad 최소 변 길이(px). … (거부 사유 문장용으로 quadDiag 가 참조 — 값 불변) */
+export const MIN_EDGE_PX = 8;
+/** quad 최소 면적(px²). … (거부 사유 문장용으로 quadDiag 가 참조 — 값 불변) */
+export const MIN_AREA_PX = 400;
```
⇒ **`export` 키워드 2개 + 주석 꼬리표뿐. 값 8/400 불변, 로직 0 변경.** 승인 범위 정확히 준수 ✅

---

## 6. ★ 못 한 검증 (위장하지 않는다)

1. **브라우저 실렌더 — 검증자도 못 했다.**
   저장소에 `web/app.js` 를 jsdom 으로 기동하는 하네스가 없다(jsdom 사용 테스트는 `lensCalibUi.test.ts` 1건뿐이며
   app.js 를 실행하지 않는다). 하네스를 새로 만드는 것은 범위 밖 리팩토링이라 하지 않았다.
   ⇒ "클릭이 원하는 지점에 찍히는가 · 노란 점/고무줄선이 보이는가 · 커서가 crosshair 로 바뀌는가" 는
   **여전히 미증명**이다. **마스터 육안 확인 필수**(Stage 5 E1~E5).
   단 §3-2/§3-3 의 정적 분석으로 **TypeError·렌더 누락 경로는 없음**까지는 좁혔다.

2. **`frame.naturalWidth` 실측 대조 — 부분적으로만 좁혔다(자가신고 3).**
   코드 추적 결과: `frame.src = /viewer/api/stream?...` → 스트림 어댑터.
   `grep -rn "resize(" src/api src/capture` → **스트림 경로에 리사이즈 0건**
   (`sharp(...).resize(...)` 는 프레임 정합 계산용 1곳뿐, 표시 경로 아님).
   `RtspFfmpegAdapter` 의 필터도 `-vf fps=N` 뿐 — **스케일 필터 없음.**
   ⇒ **SettingAgent 는 다운스케일을 하지 않는다.** 남은 위험은 *RTSP URL 자체가 서브스트림*인 경우이며
   이는 코드로 판정 불가 — **실카 라이브에서 `frame.naturalWidth` vs 카메라 설정 해상도 대조 필요.**
   (종횡비만 같으면 지면모델은 스케일 불변이라 성립한다는 설계자 논거는 유효.)

3. **실카메라·Unity 라이브 종단 미실행.** 전부 `app.inject`(in-process) 기반이다.

---

## 7. `data/` 실파일 무접촉 증명

```
$ ls -l --time-style=full-iso data/Place01/
-rw-r--r-- … 13499 2026-07-27 23:40:57.287637100 +0900 PtzCamRoi.json
$ date
Tue Jul 28 12:06:34 2026
```
mtime 이 **본 검증 세션 시작(07-28 11:53) 이전**이다 — 전체 vitest 실행과 검증자 테스트 12케이스 어디서도
쓰이지 않았다. 검증자 테스트는 전부 `mkdtempSync(tmpdir())` + 읽기전용 픽스처만 사용했다.
임시 테스트 파일 `test/_qaIndependent.test.ts` 는 **삭제 완료**(`git status test/` 에 미출현).

---

## 8. 결함 목록

### D-1 (중) 파일은 있는데 **대상 cam/preset 이 파일에 없으면 영구히 저장 불가**

**재현**(`QA-B'1`, 실행 원문):
```
PtzCamRoi.json = {"cameras":[]}   (또는 cam1만 있고 cam2:preset3 을 그리는 경우)
PUT /capture/place-roi { camId:1, presetIdx:1, spaces:[…] }      ← 프런트가 보내는 그대로
→ 200 {"ok":true,"spaceCount":1,"applied":false,"issues":["cam1 preset1 대상 없음 — 적용하지 않음"]}
→ 파일 cameras = []   (아무것도 안 들어감)
```
**원인**: `savePlaceRoi` 가 `create` 를 붙이는 조건이 `state.placeRoiFileMissing`(= GET 이 **404**) **뿐**이다(app.js:2391).
파일이 존재하면 `placeRoiFileMissing === false` 라 `create` 가 영원히 안 붙는다.

**서버는 능력이 있다**(`QA-B'2`): 같은 요청에 `create` 만 붙이면 `applied:true` + 카메라 골격 생성 성공.
**막는 것은 프런트 게이트 한 줄이다.**

**영향**:
- 리더가 정의한 빈 상태 2종 중 **"주차면 0개(파일은 존재)"** 가 커버되지 않는다.
- 기존 주차장에서 **파일에 없는 새 프리셋/새 카메라**에 면을 그리는 시나리오도 막힌다
  (예: `data/Place01` 은 cam1 p1-3 · cam2 p1-2 → cam2:p3 에 그리면 저장 실패).
- F-3 덕분에 조용하진 않다(`저장 안 됨` 표시). 그러나 사용자에게 **탈출구가 없다**.

**권고 수정(1줄급)**: `create` 첨부 조건을 `placeRoiFileMissing` **또는 `applied===false` 재시도**로 확장하거나,
더 단순하게 **`create` 를 항상 첨부**한다 — 서버 `create` 는 카메라·프리셋이 **이미 있으면 무동작**이며
(`QA-B'2`/구현자 T5 로 `imageWidth` 미덮어쓰기 확인됨) `naturalWidth>0` 가드도 이미 있으므로 부작용이 없다.
단 그 경우 "라이브 미시작이면 저장 거부" 가 **모든 저장**에 적용되므로, 가드를 `create` 첨부 시점에만
적용하도록 함께 조정해야 한다(현재 구조 그대로면 기존 저장 경로에 새 실패 조건이 생겨 회귀).

### D-2 (경, 리더 승인 범위 내) R3 로 인해 **artifact 슬롯 목록이 파일 목록으로 대체**된다

`fileMode` 에 `|| placeSpaceCount() > 0` 이 들어가면서, **artifact 가 있고 파일 ROI 도 있는 현재 Unity 환경**
(`data/Place01` = 23면)에서는 `#slot-list` 가 **항상** 파일 평면 목록이 된다.
기존에는 그 조건에서 `mapping.slots`(slotId 기준) 목록이 떴다.
⇒ 목록에서의 **artifact 슬롯 선택(`selectSlot`)이 사라진다**(캔버스 클릭 선택은 남음).
리더 승인 2가 목적 달성의 필요조건으로 명시했으므로 **결함이 아니라 의도된 거동**이지만,
"회귀 0" 은 **캔버스 상호작용에 한정**된 것이며 **목록 UI 는 바뀌었다**는 사실을 기록한다.

### D-3 (경) `POST /capture/place-roi/validate` 주석이 사실과 다르다

`captureRoutes.ts` 주석: *"파일을 **읽지도** 쓰지도 않는다"* — 실제로는 W/H 를 얻으려
`readFile(deps.placeRoiFile)` 를 **한다**(try/catch 로 강등). 쓰지 않는 것만 맞다.
설계서 §3-A 의 "파일 IO 0" 서술도 동일하게 부정확하다.
**F-6(거짓 주석)과 같은 종류의 결함**이므로 문구를 "읽기 전용(쓰지 않는다)" 로 정정할 것.

### D-4 (경) `spaceCount` 는 적용 개수가 아니다

§4-E 참조. `applied` 를 보지 않는 클라이언트에게는 착시가 그대로 남는다. 계약 주석 명시 권장.

### D-5 (정보) `create.zoom` 은 `z.number().positive()` — `zoom<=0` 이면 400

`state.ptz.zoom` 초깃값은 1이라 실무상 문제없다. 다만 소스가 zoom 0을 보고하면
**저장 전체가 400** 으로 죽고 문구는 `저장 실패(...): 400` 이라 원인 추적이 어렵다.

---

## 9. 구현자 자가신고 4건 — 검증자 판정

| # | 자가신고 | 판정 |
|---|---|---|
| 1 | 브라우저 실렌더 미검증 | **유효 · 검증자도 못 함**(§6-1). 정적으로 TypeError·렌더 누락 없음까지만 좁힘. 육안 확인 필수 |
| 2 | Loop 4 종단 미실행 | **해소** — 검증자가 구현 코드 경로로 실행해 **성공**(§4-B, `d=4.95001296446665`). 리더 실측과 일치 |
| 3 | `naturalWidth` 원본 여부 미실측 | **부분 해소**(§6-2) — SettingAgent 경로에 다운스케일 없음 확인. RTSP 서브스트림 위험만 잔존 |
| 4 | 200케이스 임계 경계 부동소수 | **실측상 문제 없음** — 시드 5종 2000케이스 + 경계 스윕 1261케이스에서 **mismatch 0**(§4-G) |

---

## 10. 구현자에게 요구하는 조치

1. **D-1 수정 필수** — 이 라운드의 존재 이유(빈 상태 부트스트랩)가 절반만 충족된다. 수정 후 재검증 요청.
   회귀 위험(모든 저장에 `naturalWidth` 가드가 걸리는 문제)을 함께 처리할 것.
2. **D-3 주석 정정**(F-6 재발 방지 차원에서 반드시).
3. D-2 는 문서화 단계에서 **"목록 UI 거동 변경"** 으로 영향도 보고에 명시.
4. D-4/D-5 는 판단에 맡긴다(수정 불요 가능).

수정 후 재검증 시 최소 재실행 항목: `npx tsc --noEmit` · `npx vitest run` ·
본 보고 §4-B/§4-D/§4-E 시나리오 + **파일 존재 + 대상 cam/preset 부재에서 저장 성공** 신규 케이스.
