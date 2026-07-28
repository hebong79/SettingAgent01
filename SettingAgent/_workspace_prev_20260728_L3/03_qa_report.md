# 03 검증 보고 — L3: 주차면 1개 드로잉 → 전 프리셋 바닥 ROI 자동 생성

작성: 2026-07-27 / 검증자(qa-tester) / 입력: `00_leader_context.md` · `01_architect_plan.md` · `02_developer_changes.md` + 소스 직접 확인 + **직접 실행**

> 원칙: 구현자·설계자의 주장을 액면 그대로 옮기지 않았다. **모든 수치는 내가 실행한 결과 원문**이다.
> 못 한 검증은 "못 했다"고 적었다.

---

## 0. 결론 3줄

1. **핵심 파이프라인은 동작한다.** `tsc --noEmit` 0에러, `vitest run` **248파일 / 2936테스트 전량 green** — 내가 직접 재실행해 확인했다. R-4(순서 보존·개수 불일치 거부), 결정론, 강등(정상 타입 범위 내 throw 0), D-2 무변경 8파일은 **깨뜨리는 입력으로 시험해 전부 통과**했다.
2. **★ 발견 결함 1 (중대·CI):** 골든 해시 테스트가 **커밋되지 않은 워킹트리 상태**의 `data/Place01/PtzCamRoi.json` 에 봉인돼 있다. HEAD 커밋 상태의 그 파일로 되돌리면 **2개 테스트가 즉시 red** 다. 즉 Requirements 의 "골든 해시 CI 봉인"은 **현재 성립하지 않는다**.
3. **★ (C) 판정 = 구현자 주장이 맞다. 그리고 더 나쁘다.** "1면 → 카메라의 모든 열"은 **정보 한계**가 맞다(독립 재측정으로 확인). 추가로, 구현자가 제시한 대안("열마다 1면씩 그리면 된다")조차 **cam1 preset3 에서는 부트스트랩 자체가 실패**하고, **실데이터에서 교차 프리셋 이식으로 실제 적용된 프리셋은 0건**이다.

---

## 1. 실행한 명령과 원문 결과 (E — 회귀)

```
$ npx tsc --noEmit
(출력 없음) → 0 error

$ npx vitest run
 Test Files  248 passed (248)
      Tests  2936 passed (2936)
   Duration  15.43s
```

구현자 보고(§6)와 **일치**한다. 회귀 0. 검증용 임시 테스트는 전부 삭제했고 삭제 후 위 수치를 **재확인**했다(`git status test/` 잔여 0).

---

## 2. Requirements 항목별 판정표 (A)

| # | Requirements 항목 | 판정 | 근거(내가 실행/확인한 것) |
|---|---|---|---|
| R1 | 정본 충돌 결정 + 문서화 | ✅ 충족 | 리더 D-1 = "격자 → PtzCamRoi.json → slot_setup". `git diff --numstat` 로 `Finalizer.ts`/`SqliteStore.ts`/`roiDbLoad.ts` **무변경** 확인. 신규 DB 쓰기 0줄. 라우트가 기존 `applyPlaceRoiUpdate` 재사용 |
| R2-a | RANSAC 금지 (최소제곱+median) | ✅ 충족 | `groundGrid.ts` 는 `median`/`circularMedian`(벡터합 원형평균 → 반주기 감기 → median, 닫힌 형태)만 사용. 랜덤 표집·`Math.random` 0건 |
| R2-b | 순회 순서 고정 / Map 삽입순서 의존 금지 | ✅ 충족 (코드+실험) | `sortedCells()` 가 `Object.entries` 후 `row asc → col asc` 로 **재정렬**한다(`groundGrid.ts:84-93`). `matchByIoU` 도 `iou desc → fileI → autoI` 로 동률 고정 후 `fileI asc` 재정렬. **실험**: 입력 JSON 의 preset 배열을 역순(3,2,1)으로 뒤집어도 preset1 결과 동일 — pairs `1,2,3,4,5,6,7`, avgIoU `0.99998`, grid theta `89.99990305324519` 동일 |
| R2-c | round5 / stringify5 (TEXT writer 누락 0) | ✅ 충족 (실측) | 신규 파일 writer 는 2곳뿐: `gridStore.writeGroundGridFile`(`stringify5(data,2)`), `groundGridRoutes.apply`(`stringify5(placeRoiJson,2)`). **실측**: apply 실행 후 두 파일을 정규식 `-?\d+\.\d{6,}` 로 전수 검사 → **6자리 이상 소수 0개 / 0개** |
| R2-d | 골든 해시 CI 봉인 | ❌ **미충족** | **결함 1** 참조. 봉인 대상이 커밋되지 않은 워킹트리 파일이다 |
| R2-e | 결정론(같은 입력 → 같은 출력) | ✅ 충족 (실측) | 동일 입력 2회 `sha256(stringify5(plan))` = `ac7670141e5b840c4096b038441ab08157bf3c506892f5873b199772c8c159d5` **완전 일치** |
| R3 | 운영 중 자동 재추정 금지 | ✅ 충족 | 라우트는 명시적 POST 만. `confirm: z.literal(true)` 없으면 400. `index.ts`/`server.ts` 어디에도 부팅·주기 호출 없음(`registerGroundGridRoutes` 는 등록만) |
| R4 | 강등 철학: throw 금지 → null + issues | ⚠️ **부분 충족** | **타입 유효 범위에서는 throw 0건**(아래 상세). 단 라우트의 `JSON.parse` 는 try 밖 → **손상 JSON 파일에서 500 throw**(결함 2) |
| R5 | `web/core.js` ↔ `project.ts` 파리티 규약 유지 | ✅ 충족 | `web/core.js` `git diff` **무변경**. 신규 코드는 `projectToPixel`/`backprojectToGround` 만 호출(신규 투영 수학 0줄) |
| R6 | 수동 드로잉 경로 유지(제거 금지) | ✅ 충족 | `git diff --numstat web/app.js` = **187 insertions / 0 deletions**. 기존 편집 UI·`PUT /capture/place-roi` 전부 무변경. 신규 패널은 별도 `<section>` 가산 |
| R7 | `replaceSlotSetup` DELETE+INSERT 취약성 가드 | ✅ 충족(원천 회피) | `replaceSlotSetup` 호출자 증가 0. `Finalizer.ts` 무변경. 자동 격자가 DB 에 직접 쓰지 않으므로 노출면 증가 0 |
| R8 | 불규칙 배치(사선주차) 범위 밖 명시 + 수동 유지 | ✅ 충족 | `groundGrid.ts` 상단 ★★, `web/index.html` 패널 주석·안내문, `02_developer_changes.md` §7-6 에 명시 |
| R9 | CLAUDE.md 5대 규칙 | ⚠️ 부분 | 설계·유닛테스트·한글문서·영향도는 충족. **동작 확인(규칙 3)은 브라우저 실렌더 미수행** — (B)1 참조 |
| D-2 | 지정 8파일 변경 0줄 | ✅ **충족(독립 확인)** | 아래 표 |

### D-2 독립 확인 (`git diff --numstat`)

```
SettingAgent/src/ground/groundModel.ts   => NO_CHANGE
SettingAgent/src/ground/project.ts       => NO_CHANGE
SettingAgent/src/ground/types.ts         => NO_CHANGE
SettingAgent/src/capture/floorRoi.ts     => NO_CHANGE
SettingAgent/src/capture/Finalizer.ts    => NO_CHANGE
SettingAgent/src/capture/SqliteStore.ts  => NO_CHANGE
SettingAgent/src/capture/roiDbLoad.ts    => NO_CHANGE
SettingAgent/web/core.js                 => NO_CHANGE
```
**8/8 전부 무변경.** 구현자 주장 그대로다.

### R4 강등 철학 — 퇴화 입력으로 **실제 호출**한 결과

코드 읽기로 끝내지 않고 신규 공개함수 12종에 퇴화 입력을 넣어 **94회 실호출**했다.

- **타입이 허용하는 퇴화 입력 → throw 0건** (전부 `null` 또는 `{grid:null, issues}` 반환):
  `canonicalizeQuad(4점 중복)`, `canonicalizeQuad(4점 공선)`, `bootstrapCameraConstants(퇴화 quad)`,
  `bootstrapCameraConstants(imgW=0)`, `groundFrameOf(n=[0,0,0])`, `groundFrameOf(n=[0,0,1] 수직하방)`,
  `groundFrameOf(d=0)`, `groundFrameOf(model, panDeg=null/NaN)`,
  `planAutoRoi(placeRoiJson = null/undefined/{}/[]/NaN/-1/'x')`, `planAutoRoi(cols=0)`,
  `planAutoRoi(quadNorm 3점)`, `planAutoRoi(cam 999)`, `planAutoRoi(cols=200,rows=50)`
- **throw 32건은 전부 TS 시그니처가 금지한 입력**(`null`/`undefined`/원시값을 `GroundGrid`·`GroundModel`·`PixelQuad` 자리에 주입).
  예: `gridToPixelQuads(null, …)` → `Cannot read properties of null (reading 'slotIdByCell')`.
  이는 타입 계약 위반 호출이라 **규약 위반으로 세지 않았다**. 다만 `planAutoRoi` 만 `placeRoiJson: unknown` 으로
  외부 입력을 받고 **그 경로는 완전히 방어돼 있다**(위 목록).

→ **판정: 충족.** 단 아래 결함 2(라우트 `JSON.parse`)는 별개다.

### R-4 (슬롯 순서 보존 · 개수 불일치 거부) — **깨뜨리는 입력으로 시험**

`cam1 preset1`(파일 7슬롯)에 `cols` 를 일부러 틀리게 주입:

```
cols=1  preset1: gen=1  file=7 matched=1 applicable=false unmatchedFile=[2,3,4,5,6,7]
cols=3  preset1: gen=3  file=7 matched=3 applicable=false unmatchedFile=[4,5,6,7]
cols=7  preset1: gen=7  file=7 matched=7 applicable=true  unmatchedFile=[]   avgIoU=1.0000
cols=10 preset1: gen=10 file=7 matched=7 applicable=true  unmatchedFile=[]   unmatchedAuto=3
```
- 개수 부족 → **적용 거부**(`applicable=false`) + 미매칭 슬롯 번호를 issues 에 노출. ✅
- 라우트에서 `presets:[1,2,3]` 로 시도 → `{"ok":false,"error":"적용 거부(R-4): preset 2,3"}`, **파일 무변경 true**, `ground_grid.json` **미생성**. 부분 적용 없음. ✅
- 순서 보존: 파일 idx `1,2,3,4,5,6,7` → pairs slotIdx `1,2,3,4,5,6,7` (IoU `0.99999 0.99999 0.99999 0.99998 0.99997 0.99996 0.99995`).
  `fileSpaces` 를 **역순으로 주입**해도 출력 idx 가 입력 순서 그대로 `7,6,5,4,3,2,1` — 즉 파일 순서를 **재정렬하지 않고 보존**한다. ✅
- 좌표는 실제로 교체된다: 첫 슬롯 pt0 `{x:0.023557843749999998,…}` → `{x:0.023558076260006663,…}`.

---

## 3. 발견한 결함

### ★ 결함 1 (심각도: **중** — CI/재현성) — 골든 해시가 **커밋되지 않은 파일**에 봉인돼 있다

`test/groundGrid.test.ts:178`(골든 해시)과 `test/groundGridRoutes.test.ts:162`(apply diff 국한)는 둘 다
`data/Place01/PtzCamRoi.json` 을 **워킹트리에서 직접 읽는다**. 그런데 그 파일은 현재 **uncommitted 수정 상태**다
(`git diff --stat`: `109 insertions(+), 109 deletions(-)`, 마지막 커밋은 2026-07-22 `1e992e4`).

**실험**: HEAD 커밋 버전으로 되돌리고 실행 →
```
× 골든 해시 (결정론 CI 봉인) > 실데이터 cam1 preset1 격자+quad 의 sha256(stringify5) 고정
× POST /capture/ground-grid/apply > ★ 성공: 대상 프리셋만 갱신되고 idx·순서가 보존된다(다른 프리셋 불변)
 Test Files  2 failed (2)
      Tests  2 failed | 19 passed (21)
```
(검증 후 워킹트리 파일은 원상 복구했다 — `git diff --stat` 이 검증 전후 동일한 `109/109` 임을 확인.)

- 워킹트리 diff 는 **정밀도 절삭뿐**이다(`45.2310562 → 45.23106`, `20.0999985 → 20.1`). `stringify5` 가 남긴 흔적으로,
  기존 `PUT /capture/place-roi`(`captureRoutes.ts:698`)도 같은 방식으로 **파일 전체를 5자리로 재기록**하므로
  이 자체는 기존 규약이고 신규 결함이 아니다.
- **문제는 봉인 대상이다.** 설계서 §7 Loop2-4 는 *"고정 입력(커밋된 fixture)"* 를 요구했는데, 구현은
  **운영 중 apply 라우트가 스스로 덮어쓰는 살아 있는 데이터 파일**을 읽는다. 즉 이 기능을 한 번 쓰면
  자기 골든 테스트가 깨진다(**self-invalidating seal**).
- **사용자 영향**: 깨끗한 체크아웃/CI 에서 red. 그리고 운영자가 자동 ROI 를 실제로 적용하면 red.
- **권고**: (a) 최소 조치 — `data/Place01/PtzCamRoi.json` 을 변경분과 **함께 커밋**한다.
  (b) 근본 조치 — `test/fixtures/` 에 **불변 fixture** 를 커밋하고 골든 해시는 그것만 읽는다(운영 데이터 비의존).

### 결함 2 (심각도: **하**) — 라우트의 `JSON.parse` 가 try 밖 → 손상 파일에서 500 throw

`groundGridRoutes.ts:71`, `:108` 이 `JSON.parse(raw)` 를 try/catch **밖**에서 호출한다.

**실험**(손상된 `PtzCamRoi.json` 주입):
```
/capture/ground-grid/bootstrap → status=500 {"statusCode":500,"error":"Internal Server Error","message":"Expected property name or '}' in JSON at position 2 …"}
/capture/ground-grid/apply     → status=500 (동일)
```
기존 동종 라우트(`captureRoutes.ts:695-702`)는 `JSON.parse` 를 try 안에 두고 `fileErrorReply` 로 강등한다.
→ **저장소 관례에서 이탈**했고 Requirements 의 "throw 금지 → `{ok:false,error}`" 를 어긴다.
**권고**: `JSON.parse` 를 기존 try 블록 안으로 옮긴다(2줄).

### 결함 3 (심각도: **하** — 잠재) — `buildApplySpaces` 가 빈 배열을 반환할 수 있다(R-5 가드가 호출자에만 있음)

`applicable=true` 인 plan 에 `fileSpaces=[]` 를 주면 `buildApplySpaces` 는 `null` 이 아니라 **`len=0`** 을 돌려준다(실측).
현재 라우트가 `if (!spaces || spaces.length === 0)` 로 막고 있어 **실사용 위험은 없다**. 다만 R-5(wipe 가드)가
순수함수 자체에는 없어, 다른 호출자가 생기면 `PtzCamRoi.json` 을 비울 수 있다.
**권고**: `buildApplySpaces` 가 빈 결과일 때 `null` 을 반환하도록 방어(1줄).

---

## 4. (B) 구현자 자가신고 4건 — 독립 재현·판정

### B-1. 브라우저 실렌더 미확인 (`#roi-auto` off 시 픽셀 동일성 포함)
**판정: 신고 사실이며, 나도 브라우저 렌더는 못 했다(한계 명시).**
- **못 한 것**: sharp 스크린샷 pre/post 픽셀 대조. Unity 라이브 프레임이 필요하고 이 환경에 없다. 주황/초록 겹쳐보기 육안도 못 했다.
- **대신 한 정적 검증(강함)**: `git diff --numstat web/app.js` = **187 insertions / 0 deletions**. 즉 **기존 줄이 단 하나도 수정·삭제되지 않았다**.
  렌더 경로 삽입은 `drawRoiOverlay` 안의 `drawAutoRoi(ctx);` **1줄뿐**이고, 그 함수 첫 줄이
  `if (!$('roi-auto')?.checked || !state.autoRoi) return;` 이다. `web/index.html` 의 `<input id="roi-auto" type="checkbox" />` 는
  `checked` 속성이 **없다**(기본 off). `web/app.css` 변경은 셀렉터 1개 추가(`.gg-help`)로 기존 규칙 본문 무변경.
- **심각도**: 낮음. 픽셀 동일성은 코드 구조상 성립할 수밖에 없다(추가된 유일한 호출이 무조건 early-return).
  **그러나 "확인했다"고 쓰지는 않는다** — 스샷 대조는 여전히 미수행이며 CLAUDE.md 규칙 3(동작 확인)의 미완 항목이다.

### B-2. `allowNew` 가 라우트엔 있고 UI 엔 없음
**판정: 사실. 확인함.**
- `groundGridRoutes.ts:44` `allowNew: z.boolean().default(false)` 존재. `grep -n "allowNew" web/app.js` → **0건**.
- **실험**: 라우트로 `allowNew:true, cols:10` 호출 → `{"ok":true,…,"appended":3}`, 파일 preset1 idx 가
  `1,2,3,4,5,6,7,24,25,26` 이 됐다(다른 프리셋 `8..11`,`12,13`, cam2 `14..19` 는 불변).
- **전역 idx 안전성 교차 확인**: `normalizeGlobalIdx`(`placeRoi.ts:92`)는 전체 idx 집합이 1..N 고유 순열이면
  **무변경 반환**한다. append 후 집합은 {1..26}, N=26 → 순열 유지 → **재번호 없음**. 구현자 주장대로
  `slot_ptz.json`·센터링·artifact `globalIndex` 는 어긋나지 않는다. ✅
  (단 번호가 물리적 인접 순서와 어긋난다 — 신규 3면이 24,25,26 으로 cam2 뒤에 붙는다. 기능 결함은 아니나 운영 혼동 요인.)
- **사용자 영향**: 웹에서는 **기존 슬롯 좌표 교체만** 가능. "백지 주차장에 1면 그려 7면 생성"은 UI 로 불가.
  **심각도: 중** — Goal 문구("1개만 그리면 전 슬롯이 자동 생성")를 웹에서 체감할 수 없다.

### B-3. `rows > 1` 은 맞물린 배치에서만 유효
**판정: 사실. 확인함.** cam1 preset1 실측:
```
rows=1: gen=7  matched=7 avgIoU=0.99998 applicable=true  unmatchedAuto=0
rows=2: gen=14 matched=7 avgIoU=0.99998 applicable=true  unmatchedAuto=7
rows=3: gen=21 matched=7 avgIoU=0.99998 applicable=true  unmatchedAuto=14
```
추가 행이 만든 quad 는 **아무것과도 매칭되지 않는다**(주차통로 위에 그려진다). `allowNew=false` 기본에서는
전부 버려지고 issues 로 노출되므로 **안전**하다. 심각도: 낮음 — **단 B-2 의 `allowNew` 를 UI 에 노출하면
`rows>1` + `allowNew` 조합이 통로 위에 가짜 슬롯을 파일에 써넣는다.** 두 항목은 **함께** 다뤄야 한다.

### B-4. `upsertCameraGrids` 가 카메라 격자를 통째 교체
**판정: 사실(코드 확정). 실데이터 재현은 부분적으로만 가능했다.**
- `gridStore.ts:67-73`: `file.cameras.filter(c => c.camIdx !== entry.camIdx)` 후 `entry` 를 붙인다 →
  같은 카메라의 **기존 `grids` 배열 전체 + `constants` 까지** 교체된다(구현자가 `constants` 는 언급하지 않았다).
- **실험**: cam1 preset1 로 apply(성공) → `grids 수: 1, theta:[89.9999], appliedPresets:[[1]]`.
  이어 **두 번째 열**(cam1 preset3)로 apply 시도 → `{"ok":false,"error":"부트스트랩 실패"}` 라 **교체를 재현하지 못했다**
  (결함 4 참조). 따라서 교체 동작은 **코드 근거로만** 확정했고 종단 재현은 못 했다.
- **사용자 영향**: `ground_grid.json` 은 추적성/이력 파일일 뿐 ROI 자체는 `PtzCamRoi.json` 에 누적되므로
  **데이터 파괴는 없다**. **심각도: 낮음.** 다만 (C) 결론상 "카메라당 격자 N개"가 **필수 사용 패턴**이 되므로
  이 제한은 설계 의도와 정면으로 충돌한다 → 별건 처리 권고에 동의.

---

## 5. ★ (C) 전제 파괴 발견의 독립 검증 — 가장 중요

`data/Place01/PtzCamRoi.json` 에서 **내가 직접 재측정**했다(구현자 수치를 옮기지 않음).

### 5-1. 실측 원문

```
### cam1
  preset1 pan=19.8    tilt=8.7  zoom=1.69341 slots=7 | 열중심(a,b)=(26.2760, 9.6330) | theta=90.0000 | d=4.9500
     셀스팬(a×b): 5.000x2.500 (전 7셀 동일)
     셀중심 b: 2.133 4.633 7.133 9.633 12.133 14.633 17.133      ← 피치 2.500 정확
  preset2 pan=41.5    tilt=20.1 zoom=1.57991 slots=4 | 열중심(a,b)=(10.6860, 9.7010) | theta=90.0000 | d=4.9500
     셀스팬(a×b): 5.000x2.500 (전 4셀 동일)
     셀중심 b: 5.951 8.451 10.951 13.451                          ← 피치 2.500 정확
  preset3 pan=90.10001 tilt=35.8 zoom=1 slots=2 | 열중심(a,b)=(-0.0140, 8.3750) | theta=0.0000 | d=4.9500
     셀스팬(a×b): 2.500x5.000  ← 축 뒤집힘
### cam2
  preset1 pan=113.8 tilt=10 slots=6 | theta=0.0000  셀스팬 2.500x5.000  셀중심 a: -17.368 … -4.868 (피치 2.5)
  preset2 pan=139   tilt=17 slots=4 | theta=90.0000 셀스팬 5.000x2.500  셀중심 b: 7.151 … 14.651 (피치 2.5)
```
```
p1-p2: Δa=15.5900 Δb=-0.0680 | Δa/rowPitch=3.1180  | Δtheta=-0.0000
p1-p3: Δa=26.2900 Δb= 1.2580 | Δa/rowPitch=5.2580  | Δtheta=90.0000
p2-p3: Δa=10.7000 Δb= 1.3260 | Δa/rowPitch=2.1400  | Δtheta=90.0000
theta: p1=89.99998669256314  p2=89.99999379540674  p3=0
```

### 5-2. 판정: **정보 한계가 맞다.** 구현 한계·모델링 한계가 아니다.

구현자 주장 **전부 재현됨**. 그리고 내가 찾은 **추가 증거 2건**이 결론을 더 강하게 만든다:

1. **행 간격 비정수배 재확인**: `Δa(p1,p2) = 15.5900 m = 3.1180 × rowPitch(5.0)`. 정수배 아님(주차통로). 구현자 수치와 소수점까지 일치.
2. **★ 추가 증거 A — 열 위상까지 어긋난다.** 행 간격만 문제가 아니다.
   p1 의 슬롯 중심 b = `2.133 + 2.5k`, p2 는 `5.951 + 2.5k`. **b 축 위상차 = `5.951 − 2.133 = 3.818 → mod 2.5 = 1.318 m`**
   (슬롯 폭의 0.527배). 즉 두 열은 **행 방향으로도, 열 방향으로도** 정수배가 아니다.
   → 설령 rowPitch 를 자유 파라미터로 풀어도(격자 모델을 확장해도) 두 번째 열의 **열 위상 1.318m** 은
   첫 번째 열의 드로잉 어디에도 나타나지 않는다.
3. **★ 추가 증거 B — cam2 도 똑같이 깨진다.** 구현자는 cam1 만 보고했다. cam2 도 `preset1 theta=0` / `preset2 theta=90`
   으로 **90° 다른 두 열**이다. 즉 이 데이터셋의 **2개 카메라 전부**에서 단일 격자 가정이 깨진다.
   구현자 보고는 과장이 아니라 **과소 보고**였다.

**원리 논증**: 입력은 quad 1개(픽셀 4점) + 그 프리셋의 PTZ 다.
여기서 결정되는 것은 ① 지면 평면(n,d) ② 초점거리/카메라 상수 ③ **그 셀 1개의 위치·방위** 뿐이다.
다른 열의 위상(a,b 오프셋)과 방위(θ)는 **입력의 어떤 함수로도 표현되지 않는다** — 관측되지 않은 세계의 자유 파라미터다.
이를 메우는 유일한 길은 "주차장 전체가 하나의 균일 격자"라는 **추가 가정**인데, 실측이 그 가정을 **반증한다**
(비정수배 행 간격 3.118, 열 위상차 1.318m, 90° 방위 차). 다른 알고리즘·다른 모델을 써도 마찬가지다.
→ **정보 한계 확정.** Goal 문구는 구현자 제안대로 수정해야 한다:
> ✅ **주차면 1개 → 그 주차열**, ❌ 주차면 1개 → 카메라의 모든 주차열

### 5-3. ★ 그런데 대안("열마다 1면씩")도 실데이터에서 완전하지 않다 — **결함 4**

구현자는 "열마다 1면씩 그리면 된다"를 대안으로 제시했다. **직접 시험했다**(각 프리셋의 첫 슬롯을 기준면으로,
`cols`=그 프리셋의 파일 슬롯 수):

| cam | preset | 파일 슬롯 | 결과 |
|---|---|---|---|
| 1 | 1 | 7 | ✅ `matched=7/7 avgIoU=0.99998 applicable=true` (colStart=0) |
| 1 | 2 | 4 | ✅ `matched=4/4 avgIoU=1.00000 applicable=true` (colStart=0) |
| 1 | 3 | 2 | ❌ **`plan NULL` — 부트스트랩 실패** |
| 2 | 1 | 6 | ⚠️ colStart=0 → `matched=1/6 applicable=false`. **colStart=-5 → `matched=6/6 avgIoU=0.99999 applicable=true`** |
| 2 | 2 | 4 | ✅ `matched=4/4 avgIoU=1.00000 applicable=true` (colStart=0) |

**결함 4 (심각도: 중) — cam1 preset3 은 어떤 기준면으로도 부트스트랩되지 않는다.**
원인을 파고들었다: 두 슬롯 모두 `isUsableQuad=true`, `estimateGroundVPs` 성공(`edgePxA=607.8/edgePxB=801.8`,
`381.0/328.6`)인데 **`focalFromVPs` 가 `null`**(직교 소실점 제약 `f² ≤ 0`)을 돌려준다 → `bootstrapCameraConstants` → `null`.
즉 (C) 결론이 요구하는 "열마다 1면"조차 **이 열에서는 수행 불가**하고, 사용자는
`"부트스트랩 실패(퇴화 quad / 직교 소실점 제약 위반 / 지평선 위) — 기준 주차면을 다시 그려라"` 만 본다
(강등은 정직하다 — 조용히 틀린 ROI 를 만들지 않는다 ✅). **하지만 "다시 그려라"로 해결되지 않는다**:
파일에 이미 있는 두 quad 모두 실패한다.

**결함 5 (심각도: 하 — UX) — `colStart` 기본값 0 이 방향에 따라 실패한다.**
기준면이 열의 어느 쪽 끝인지에 따라 확장 방향이 반대일 수 있다(cam2 preset1). 사용자는 `applicable=false` 만 보고
`colStart` 를 수동 스윕해야 한다. 안전 실패이므로 데이터 위험은 없다.

### 5-4. ★ "교차 프리셋 이식"의 실제 산출 = **0건**

구현자는 §2 에서 *"교차 프리셋 이식은 실증됐다 — preset2 프레임 안에 preset1 의 슬롯 #4·5·6 이 들어온다"* 고 썼다.
**투영이 들어오는 것은 맞지만, 적용되지는 않는다**: preset2 의 파일 슬롯(8,9,10,11)은 **다른 열**이라
매칭 IoU < 0.3 → `unmatchedFile=[8,9,10,11]` → **`applicable=false`(적용 거부)**. 모든 `cols` 값(1/3/7/10)에서 동일.

```
cols=7 preset2: gen=7 file=4 matched=0 applicable=false unmatchedFile=[8,9,10,11] unmatchedAuto=7
cols=7 preset3: gen=7 file=2 matched=0 applicable=false unmatchedFile=[12,13]     unmatchedAuto=7
```
→ **실데이터에서 "1 드로잉 → 여러 프리셋" 이 실제로 성사된 사례는 0건**이다.
성사되는 것은 **1 드로잉 → 그 프리셋의 그 열 전 슬롯**뿐이다.
아키텍처상 교차 프리셋 이식은 지원되나 **이 데이터셋으로는 실증되지 않았다**.
문서화 단계는 이것을 흐리게 쓰면 안 된다.

---

## 6. (D) 경계면 교차 비교 — 라우트 ↔ 순수함수 ↔ 파일 IO

| 경계 | 규약 | 판정 |
|---|---|---|
| 라우트 body `quad` ↔ `planAutoRoi.quadNorm` | **정규화 0..1** | ✅ 일치. `QuadSchema`(x,y number ×4) → `AutoRoiPlanInput.quadNorm: NormalizedPoint[]` |
| `quadNorm` ↔ 내부 픽셀 | `toPixelQuad(pts, cam.imgW, cam.imgH)` | ✅ 단일 지점. imgW/imgH 는 `buildGroundInputs` 가 `camera.imageWidth/Height` 에서 도출 — 순수함수가 자체 조달하므로 라우트가 잘못 넘길 여지 없음 |
| 응답 `pairs[].quadNorm` ↔ `applyPlaceRoiUpdate` 입력 | **정규화 0..1** | ✅ `toNorm(q, imgW, imgH)` 로 되돌린 뒤 `PlaceRoiSpace.points` 로 전달. 기존 `PUT /capture/place-roi` 와 **같은 함수**(`applyPlaceRoiUpdate`)를 재사용하므로 픽셀 역변환 규약 일치 |
| 슬롯 인덱스 | **1-based 전역 idx** | ✅ `pairs[].slotIdx` = 파일 `sp.idx`(1-based). `grid.slotIdByCell` 값은 **격자 로컬 순번**으로 의미가 다르며 주석에 명시돼 있고 적용 경로에서 쓰이지 않는다(혼동 소지는 있으나 실 오류 없음) |
| 슬롯 순서 | 파일 배열 순서 보존 | ✅ **실험 확인**(§2 R-4). `buildApplySpaces` 가 `fileSpaces.map` 으로 순서 그대로 매핑 |
| `presetIdx` | 1-based | ✅ 라우트 `z.number().int().positive()`, `byPreset` 키 `${camIdx}:${presetIdx}` — 기존 `normalizePtzCamRoi` 규약과 동일 |
| 파일 쓰기 정밀도 | `stringify5` | ✅ 실측 6자리+ 0개(두 파일 모두) |
| DB 경계 | 자동 격자는 DB 직접 쓰기 **금지** | ✅ 신규 코드에 `SqliteStore`/`replaceSlotSetup` 참조 0건 |
| `web/app.js` ↔ 라우트 | `allowNew` | ❌ **UI 미노출**(B-2). 계약 불일치는 아니지만 기능 도달 불가 |

**경계면 불일치 0건.** 이 저장소의 과거 실패 패턴(정규화/픽셀 혼동, 0/1-based 혼동)은 재현되지 않았다.

---

## 7. 못 한 검증 (한계 명시 — 위장 없음)

1. **브라우저 실렌더 / sharp 스샷 pre-post 픽셀 대조** — Unity 라이브 프레임 부재. `#roi-auto` off 픽셀 동일성은
   정적(0 deletions + early-return)으로만 논증했다.
2. **주황(자동) vs 초록(파일) 겹쳐보기 육안 확인** — 동일 사유로 미수행.
3. **실카 데이터 검증** — 전 수치가 Unity 시뮬레이터 데이터(`data/Place01/PtzCamRoi.json`)다. IoU 0.99998~1.00000,
   홀드아웃 편차 0.00% 는 **파이프라인 수학이 무손실**이라는 뜻일 뿐 실카 정확도가 아니다.
   실카 위험(roll≠0 · PTZ 보고 바이어스 · 광학중심≠회전축)은 미검증 상태 그대로다.
4. **B-4(격자 통째 교체) 종단 재현** — 두 번째 열 부트스트랩이 결함 4로 실패해 코드 근거로만 확정.
5. **외부 서비스 스모크**(Unity RPC 등) — 미가동. 이번 변경은 카메라를 호출하지 않으므로(`viewerPtzSyncCoverage`
   `NO_MOVE` 분류가 맞다) 영향 없음으로 판단하나, **실서버 종단 실행은 하지 않았다**.

---

## 8. 구현자에게 (수정 요청 — 재실행 루프)

| 우선 | 항목 | 조치 |
|---|---|---|
| 1 | **결함 1** 골든 해시 봉인 | `data/Place01/PtzCamRoi.json` 을 변경분과 함께 커밋(최소) / `test/fixtures/` 불변 fixture 분리(근본). **현재 CI red 상태다** |
| 2 | **결함 4** cam1 preset3 부트스트랩 불가 | 원인 = `focalFromVPs` f²≤0. 대안 경로(예: 같은 카메라의 성공 프리셋에서 얻은 `fovBaseV` 재사용) 검토 또는 **명시적 한계로 문서화**. 지금은 "다시 그려라"가 거짓 안내다 |
| 3 | **결함 2** 라우트 `JSON.parse` | try 블록 안으로 이동(2줄). 기존 `captureRoutes.ts:696` 관례와 정합 |
| 4 | **결함 3** `buildApplySpaces` 빈 배열 | 빈 결과 시 `null` 반환(1줄). R-5 를 순수함수에도 |
| 5 | B-2 + B-3 조합 위험 | `allowNew` 를 UI 에 노출한다면 **반드시 `rows=1` 강제 또는 경고**와 함께. 지금 상태(UI 미노출)가 더 안전하다 |

## 9. 문서화에게

- **§5(C 결론)이 최우선 문서화 대상**이다. 특히 §5-4 — "교차 프리셋 이식 실증 0건"을 반드시 명시할 것.
  구현자 §2 의 "교차 프리셋 이식은 실증됐다"는 **투영이 닿는다**는 뜻이지 **적용된다**는 뜻이 아니다.
- 실제 성립하는 명제(내 실측 기준): **"주차면 1개 → 그 프리셋 · 그 주차열의 전 슬롯"**.
  현 데이터 5개 (cam,preset) 중 성공 4 / 실패 1(cam1 preset3).
- 결함 1(골든 해시)·결함 4(preset3)는 문서에 **알려진 제약**으로 남길 것.
- 신규 설정 키 `store.groundGridFile`(default `Place01/ground_grid.json`, 하위호환 有) 확인함.
