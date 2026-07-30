# 03 검증 보고 — 4건 서버 정본화 + 웹 껍데기화 (독립 검증)

작성: 2026-07-28 · 워크트리 `.claude/worktrees/feat-server-promote-4/SettingAgent`
입력: `00_leader_decisions.md` · `01_architect_plan.md` · `02/02b/02c/02d_developer_changes*.md` + 실코드
원칙: **구현자·설계자 주장을 액면 그대로 믿지 않고 전부 독립 재현**했다. 못 한 것은 §5 에 못 했다고 적었다.
프로브 파일 6개는 측정 후 **전부 삭제**했고 변이 17건은 **전부 원복**했다(§1.2 재측정으로 증명).
(이전 라운드 보고는 `_workspace_prev_20260728_placedrawfix/03_qa_report.md` 에 보존돼 있다.)

> **§7 추가(리더 지시 후속)** — D-2 의 판별력 구멍 6건을 **파리티 테스트에 영구 편입**하고,
> 그 영구 파일 위에서 변이 6건을 재주입해 **전부 FAIL** 함을 실증했다. §7 참조.

---

## 0. 한 줄 결론

**7개 항목 중 6개 통과, 1개(파리티 판별력) 결함.** 구현 자체에서 **오동작은 하나도 발견되지 않았다** —
내가 만든 모든 프로브 케이스에서 web↔src 값이 일치했고, 토큰 게이트는 87개 라우트 전수에서 구멍이 0이었으며,
파일 md5 는 30개 거부·dryRun 경로 전부에서 불변이었고, DB 쓰기 호출은 0건이었다.

**그러나 봉인(파리티 테스트)의 판별력에 실측된 구멍 6개가 있다.** 지금 코드는 맞지만, 앞으로 누가
그 6개 자리를 깨뜨려도 **테스트가 green 인 채로 통과한다.** 특히 `groundBandRatio 오버라이드` 테스트는
**그 오버라이드가 무시돼도 통과한다**(공허한 테스트). 추가로 결함 **7건**(중 2 / 하 4 / 정보 1)을 보고한다.

---

## 1. 재현한 기준선 실측치

### 1.1 시작 기준선 (검증 착수 직후)

```
$ npx tsc --noEmit
TSC_EXIT=0
```
```
$ npx vitest run
 Test Files  2 failed | 272 passed (274)
      Tests  2 failed | 3436 passed (3438)
   Duration  19.69s

FAIL test/placeRoiRuntimeInvariants.test.ts > 런타임 PtzCamRoi.json — 구조 불변식(값 불단정) > 모든 주차면: 4점 + 유한 좌표
AssertionError: expected [] to have a length of 4 but got +0   (test/placeRoiRuntimeInvariants.test.ts:30:27)

FAIL test/roiDbLoad.test.ts > loadRoiIntoDb — 정상 로딩(실제 data/Place01/PtzCamRoi.json) > preset_slotidx 는 프리셋별 1-based 연속, slot_roi 는 4점 정규화(프레임 밖 점은 보존·issues 보고)
AssertionError: expected [] to have a length of 4 but got +0   (test/roiDbLoad.test.ts:104:21)
```
→ **리더 제시 수치(0 / 2 failed·3436 passed)와 정확히 일치.** 사전 실패 2건은 지시대로 **무접촉**했다.

### 1.2 종료 기준선 (변이 원복 + 프로브 삭제 후 재측정)

```
$ npx tsc --noEmit
TSC_EXIT=0
$ npx vitest run
 Test Files  2 failed | 272 passed (274)
      Tests  2 failed | 3436 passed (3438)
   Duration  17.78s
```
→ **시작 기준선과 동일.** 내 검증이 저장소에 남긴 부작용은 0이다
(`git status` 로 `test/_qa*.ts` 6개 부재 · `src/**` diff 불변 확인. 신규 3파일 md5 도 변이 전후 동일).

---

## 2. 항목별 판정

| # | 항목 | 판정 | 근거 요약 |
|---|---|---|---|
| 1 | 파리티가 진짜인가 | **결함**(구현 정상 / **봉인 구멍 6**) | 변이 17건 중 **10 검출 / 7 미검출**. 미검출 7건 중 **6건은 진짜 테스트 구멍**(프로브가 전부 잡음), 1건만 의미상 등가 |
| 2 | 웹이 정말 껍데기인가 | **통과** | 4건 전부 호출 그래프에서 소멸. `web/occupancy.js`·`occupancyRegion.js` 는 런타임 import 0 |
| 3 | 토큰 게이트의 구멍 | **통과** | 등록 라우트 **87개 전수 타격** → 403 아닌 변이 라우트 **0건**(면제 5 + `/rpc` 자체게이트만) · 잘못 막힌 읽기 **0건** |
| 4 | 파일 무변경 보장 | **통과** | md5 불변 **30 케이스**(dryRun·409·404·400·검증실패 × REST/뷰어/RPC) + 음성 대조 |
| 5 | DB 파괴 경로 부재 | **통과** | 신규 6파일 DB 심볼 0. diff 전체에서 DB 쓰기 호출 0(읽기 `getSlotSetup` 1건뿐) |
| 6 | RPC 규약 무결성 | **통과** | 카탈로그 **76** · 신규 6 전부 `http` 위임 · 오류코드 5종 실응답 확인 |
| 7 | 경계면 교차 비교 | **통과** | `frames[]` ↔ `occComputeByKey` shape 일치 · 1-based 보존 · `stringify5` 적용(`0.123456789 → 0.12346`) |

---

### 항목 1 — 파리티가 진짜인가 ★결함

구현은 정확하다. 내가 새로 만든 7개 프로브 케이스(다중카메라 · 다중 preset 키 · centering 부분 null ·
presetSlotIdx 혼재 · 2단계 폴백 사영 · groundBandRatio 민감 기하)에서 **web↔src 가 전부 일치**했다.

문제는 **봉인의 판별력**이다. 상세는 §3.

W2(투어링)는 `touringPlanParity` 에 **변이를 한 건도 넣지 않았다**(`02b` 에 그런 표가 없다 —
`viewerPtzSyncCoverage` 정규식 변이만 있다). 즉 이번에 내가 처음 측정했다.

### 항목 2 — 웹이 정말 껍데기인가 ★통과

호출 그래프 추적 결과:

| 승격된 로직 | `web/core.js` 정의 | app.js/roimaker.js import | 런타임 호출 | 판정 |
|---|---|---|---|---|
| `buildTouringPlan` | :1683 존치 | **없음**(app.js:3-71 import 블록에 부재) | 0 | 존치·미호출 ✅ |
| `computeOccupancy` | :577 존치 | 없음 | core.js 내부 호출 0 · `occupancy.js:17` 만 참조 | 존치·미호출 ✅ |
| `nextSlotId`/`insertSlotAt`/`removeSlot`/`rebuildGlobalIndex` | :799~:870 존치 | 없음(app.js:30 에 승격 주석) | `removeSlot`→`rebuildGlobalIndex` 내부 호출뿐 | 존치·미호출 ✅ |
| `OccupancyJudge`(occupancy.js) | 존치 | **모듈 자체가 import 되지 않음** | 0 | 존치·미호출 ✅ |
| `computeOccupancyRegions`(occupancyRegion.js) | 존치 | 모듈 자체 미 import | 0 | 존치·미호출 ✅ |

`web/index.html` 의 `<script type="module">` 진입점은 `app.js`(:695)·`roimaker.js`(:696) 둘뿐이고,
두 진입점에서 도달 가능한 모듈은 `core.js`·`placeDraw.js`·`roimakerCore.js`·`token.js` 다.
**`occupancy.js`·`occupancyRegion.js` 는 어느 진입점에서도 도달하지 않는다** — 테스트 전용 기준변으로 완전 격리됐다.

실제 대체 경로도 확인했다:
- `addSlot`(app.js:1484) → `mutFetch('/viewer/api/mapping/slot/add', {artifact: state.mapping, dryRun:true})` → `state.mapping = data.artifact`
- `deleteSelectedSlot`(:1521) → 동일 관용구
- `runTouringTest`(:1938) → `mutFetch('/capture/tour/start')` + 1초 `GET /capture/tour/status` 폴링. **웹에 순회 for 루프가 없다**
- `refreshOccupancy`(:526) → `mutFetch('/capture/slots/judge-occupancy', {frames, regions:true})`. `drawRoiOverlay`(:445)·`renderSlotList` 의 판정 호출은 **제거됨**(사유 주석 명시)
- `markDirty()` 가 살아 있어 **2단계 UX(추가 → Ctrl+드래그 배치 → 저장) 보존** 확인

### 항목 3 — 토큰 게이트의 구멍 ★통과

`controlToken:'T'` 로 **모든 옵셔널 의존성을 주입한** `buildServer` 를 띄우고 `printRoutes` 로 수집한
**126개 엔트리(HEAD 39 제외 → 87개)** 전부를 무토큰으로 타격했다.

```
총 라우트: 87
■ 무토큰인데 403 이 아닌 변이 라우트:
POST /capture/slots/judge-occupancy → 400
POST /capture/place-roi/validate → 400
POST /capture/autocorrect → 400
POST /capture/ground-grid/bootstrap → 400
POST /capture/detect → 400
POST /rpc → 200
■ 잘못 막힌 읽기 라우트:
(없음)
```
→ 403 이 아닌 6개는 **정확히 `READONLY_POST_PATHS` 5개 + `SELF_GATED_PATHS`(`/rpc`)** 다.
선언 밖의 누출은 **0건**. `deny-by-default` 가 실제로 작동한다.
(수집 파서 정확성은 신규 6라우트 + `GET /capture/tour/status` + `judge-occupancy` 가 목록에 실제로
들어 있음을 `toContain` 으로 별도 단정해 확인했다 — 파서가 라우트를 놓쳐서 "구멍 없음"이 된 것이 아니다.)

이번 신규 6개 변이 라우트 직접 타격(뷰어 컨텍스트 포함):
```
POST /capture/tour/start             → 무토큰 403 / 토큰 404
POST /capture/tour/stop              → 무토큰 403 / 토큰 200
POST /mapping/slot/add               → 무토큰 403 / 토큰 400
POST /mapping/slot/delete            → 무토큰 403 / 토큰 400
POST /viewer/api/mapping/slot/add    → 무토큰 403 / 토큰 400
POST /viewer/api/mapping/slot/delete → 무토큰 403 / 토큰 400
GET  /capture/tour/status            → 무토큰 200 (읽기 정상 통과)
```
RPC 평면(메서드별 자체 게이트):
```
capture.tour.start  무토큰 → -32006 invalid token
capture.tour.stop   무토큰 → -32006 invalid token
setup.slot.add      무토큰 → -32006 invalid token
setup.slot.delete   무토큰 → -32006 invalid token
capture.tour.status(읽기)     무토큰 → OK
slot.occupancy.evaluate(읽기) 무토큰 → OK
```
회귀 확인: `controlToken:''` → **403 인 변이 라우트 0건**(훅 미등록 = 현행 동작 100% 보존).

훅 등록 순서도 확인했다 — `registerControlTokenGate(app, deps.viewer)` 가 `server.ts:203` 으로
모든 라우트 등록(`:593`, `:652`, `:684` 의 `app.register` 뷰어 캡슐 포함)보다 **앞**이다.
Fastify 는 이후 생성되는 자식 컨텍스트에 부모 훅을 상속하므로 뷰어 캡슐까지 덮인다(실측이 이를 확증).

> ⚠ 리더 지시문의 "알려진 예외는 `/capture/detect` 하나뿐"은 **사실과 다르다** → 결함 **D-3**.

### 항목 4 — 파일 무변경 보장 ★통과

**실제 `Repository`(진짜 파일 IO)** 로 `data/setup_artifact.json` 의 md5 를 직접 비교했다.
8개 시나리오 × 3개 표면(헤드리스 REST / 뷰어 컨텍스트 / RPC) + 개별 4건 = **30 케이스 전부 통과**.

| 시나리오 | 상태코드 | md5 |
|---|---|---|
| `dryRun:true` add | 200 | 불변 |
| `dryRun:true` delete | 200 | 불변 |
| `dryRun:true` + 호출자 버퍼 add | 200 | 불변 |
| 없는 slotId 삭제(**가드 거부**) | **409** | 불변 |
| zod 실패(`camIdx:0`) | 400 | 불변 |
| zod 실패(`slotId:''`) | 400 | 불변 |
| 검증 실패(망가진 버퍼) | 400 | 불변 |
| coverage mismatch(globalIndex 결손 버퍼) | 400 | 불변 |
| artifact 파일 부재 | 404 | **파일 생성조차 안 함** |

**공허한 통과 방지(음성 대조)**: `dryRun` 미지정(기본 커밋) → md5 **변경됨** + `saved:true`.
즉 위의 "불변" 단정들은 "원래 아무것도 안 쓰는 코드라 당연히 불변"이 아니다.

**부분기록 없음** 확인: `slotAddHandler`(server.ts:504)/`slotDeleteHandler`(:551)는
`zod → 편집 → validateArtifactBody → (dryRun 아니면) saveArtifact` 순서이고,
모든 거부가 `saveArtifact` **도달 전**이다(`return v.body` 가 그 앞).

`stringify5` 적용도 실측했다 — `rect.x = 0.123456789` 입력 → 디스크에 `"x": 0.12346`.

> 단, `artifact` 버퍼의 **사정거리**가 문서화되지 않았다 → 결함 **D-1**.

### 항목 5 — DB 파괴 경로 부재 ★통과

정적 확인 2단계:

1. **신규 6파일 전수 grep**(`sqlite|store\.|replaceSlotSetup|upsert|writeSetupResultFiles|saveArtifact|writeFileSync|repo\.`)
   → `touringPlan.ts` · `artifactSlotEdit.ts` · `occupancyJudge.ts` · `TourJob.ts` · `tourRoutes.ts` · `controlGate.ts` **전부 0건**.
2. **`git diff main -- src/` 의 추가된 줄 전수 grep**(DELETE+INSERT 계열 9개 API 명 + 파일 writer)
   → 매칭 4건이 전부이며 내용은:
   - `const dbSlotCount = deps.sqlite ? deps.sqlite.getSlotSetup().length : null;` — **읽기 1건**(warnings 용)
   - `if (dryRun !== true) deps.repo.saveArtifact(v.artifact);` × 2 — artifact 파일만
   - 나머지 1건은 주석

`replaceSlotSetup` · `insertSlotSetupRows` · `clearSlotSetupEnrichment` · `upsertSlot*` · `upsertPlace/Camera/PresetInfo` ·
`writeSetupResultFiles` **호출 0건**. 설계 R12("파괴 경로에 아예 진입하지 않는다")는 **DB 에 한해 사실**이다.
(파일 쪽은 D-1 참조 — R12 의 문구가 파일까지 커버하는 것처럼 읽힌다.)

### 항목 6 — RPC 규약 무결성 ★통과

```
GET /rpc/catalog → count = 76, methods.length = 76
```
신규 6개 전부 `http` 위임(**로직 0줄**) — `methods.ts` diff 확인. `handler` 신설 0건.
`setup.slot.delete` 만 `requireConfirm` + `omit(p,['confirm'])` 전처리가 있는데 이는 기존 관용구다.
(설계 §4.2 가 명시한 `requireFields(p,['camIdx','presetIdx'])` 는 `setup.slot.add` 에서 생략됐다 —
라우트 zod 가 400 → `-32602` 로 같은 결과를 내므로 무해한 이탈. 실측으로 확인.)

**오류코드 실응답 실측**(내 프로브, `app.inject` 경유):
```
capture.tour.start (setup_result 없음)        → -32002 {"message":"no setup_result","data":{"httpStatus":404}}
capture.tour.start (중복 시작)                 → -32001 {"message":"tour already running","data":{"httpStatus":409}}
capture.tour.start (isBusy=렌즈 캘리브레이션)   → -32001 {"message":"카메라 점유 중(렌즈 캘리브레이션) — 잠시 후 재시도하세요"}
setup.slot.delete (slotId 부재)               → -32005 {"message":"slotId 없음: nope — 파일 무변경","data":{"httpStatus":409}}
setup.slot.add    (artifact 파일 없음)         → -32002 {"message":"no setup artifact","data":{"httpStatus":404}}
capture.tour.start/stop/status (tourJob 미주입) → -32004 {"message":"Not Found" / "Route ... not found"}
capture.tour.start(dwellMs:-1) · setup.slot.add(camIdx:0) → -32602
```
**REST 직접 호출 최종 방어선(설계 R5)도 실증**:
```
POST /capture/tour/start (isBusy true, dispatch 미경유) → 409 {"error":"busy — 다른 잡이 카메라를 사용 중입니다 (렌즈 캘리브레이션)"}
```
`test/rpcParity.test.ts` 의 양방향 고정은 살아 있다 — `known` 정적 목록(+tour 3줄)과
**T4 동적 등록 교차검사**(완전 배선 `buildServer` 에 전 위임 URL 주입 후 `isRouteNotRegistered` 판정) 둘 다 green.

### 항목 7 — 경계면 교차 비교 ★통과

| 경계 | 서버가 내는 것 | 웹이 읽는 것 | 판정 |
|---|---|---|---|
| `judge-occupancy` 응답 | `{byKey:{[key]:{rows, regions?:[{idx,scale,polygon}], overlapPairs?}}}` | `out.rows`·`out.regions`·`out.overlapPairs`(app.js:552-575) | ✅ |
| `occComputeByKey` 적재 | — | `{spaces:[{id,occupied,source,center,vehicleRect,region}]}` | 구 `updateLogicOccupancy`(main:518-547)와 **키 구성 동일** ✅ |
| 소비처 1 | — | `drawOccupancyOverlay`: `sp.occupied`·`sp.region`·`sp.center` | 무변경 ✅ |
| 소비처 2 | — | `buildFlatSlotRows({occByKey})`(core.js:701): `occByKey[key].spaces` → `Map(o.id → o.occupied)` | 무변경 ✅ |
| **1-based 인덱스** | `rows[].idx` = 입력 `floorPolygons[].idx` 그대로 통과 | `idx: Number(p.label)`, `p.label = String(sp.idx)`(PtzCamRoi 전역 1-based) | 왕복 보존 ✅ |
| `frames[]` 조립 | — | 바닥 ROI 없는 키 제외(구 `if(!floorPolys.length) return` 과 동형 · 이전 값 보존) | ✅ |
| 소수점 5자리 | `Repository.saveArtifact` → `stringify5` | — | `0.123456789 → 0.12346` 실측 ✅ |
| base64 | 이번 4건에 base64 경계 **없음** | — | 해당 없음 |

---

## 3. ★ 음성 대조 결과표 (변이 17건 · 내가 직접 주입·원복)

방식: 구현에 1줄 변이 주입 → 해당 파리티 테스트만 실행 → 결과 기록 → `finally` 로 원복.
구현자가 이미 쓴 변이(W3 4건 / W4 A~F)와 **겹치지 않는 것만** 골랐다.

### 3.1 `touringPlanParity` (W2 는 이 파리티에 변이를 넣은 적이 없다 — 판별력 최초 측정)

| # | 주입한 변이 | 결과 | 미검출 사유 / 판정 |
|---|---|---|---|
| T1 | 정렬키 순서 뒤바꿈 `camId ↔ presetId` | **DETECTED** | fixture 가 2대(cam 1·2)라 잡힌다 |
| T2 | `presetSlotIdx ?? null` → `?? 0` (1-based 규약 드리프트) | **DETECTED** | `presetSlotIdx:null` 케이스가 있다 |
| T3 | `c.zoom != null` → `c.zoom !== undefined` | **미검출** | ❌ **구멍**. `centering:{pan:1,tilt:1,zoom:null}`(부분 null) 케이스가 없다. 프로브로 즉시 검출됨 |
| T4 | 그룹키 `` `${camId}:${presetId}` `` → `` `${camId}` `` | **DETECTED** | preset 스텝 발행 시점이 갈린다 |
| T5 | 정렬 기본값 `(presetSlotIdx ?? 0)` → `?? 999` | **미검출** | ❌ **구멍**. null 과 숫자가 **섞인** 그룹이 없다(있는 건 둘 다 null). 프로브로 즉시 검출됨 |

### 3.2 `artifactSlotEditParity`

| # | 주입한 변이 | 결과 | 미검출 사유 / 판정 |
|---|---|---|---|
| S1 | `globalIdx: i + 1` → `i` (**1-based → 0-based**) | **DETECTED** | |
| S2 | clamp 상한 `base.length + 1` → `base.length` (**off-by-one**) | **DETECTED** | W4-B 는 하한만 봤다 — 상한도 봉인돼 있다 |
| S3 | `splice(pos, 0, …)` → `splice(pos, 1, …)` | **DETECTED** | |
| S4 | preset 정렬 `camIdx ↔ presetIdx` 순서 뒤바꿈 | **미검출** | ❌ **구멍**. `sampleArtifact()` 가 **단일 카메라**(1:1, 1:2)라 두 정렬이 같은 답을 낸다. 프로브(cam1p2 + cam2p1)로 즉시 검출됨 |
| S5 | `nextSlotId` 시작값 `max + 1` → `max` | **DETECTED** | "프리셋 슬롯 0개" 케이스가 `c2p5s0` 을 잡는다 |
| S6 | `roiByPreset` 키 `[0]` → `.at(-1)` | **미검출** | ❌ **구멍**. 테스트의 신규 슬롯 `roiByPreset` 이 **항상 키 1개**다. 프로브(키 2개)로 즉시 검출됨 |

### 3.3 `occupancyJudgeParity`

| # | 주입한 변이 | 결과 | 미검출 사유 / 판정 |
|---|---|---|---|
| O1 | 2단계 폴백 사영 제거 `rows[openPos[k]]` → `rows[k]` | **미검출** | ❌ **구멍(최중요)**. 모든 케이스에서 `openPos` 가 **항등 사영**이다 — 1단계가 **앞** 슬롯을 점유하고 2단계가 **뒤** 슬롯을 채우는 조합이 없다. 프로브(bbox=slot1 + standalone plate=slot2)로 즉시 검출됨 |
| O2 | 임계 `>= minBandOverlap` → `>` | **미검출** | ✅ **의미상 등가**. 부동소수 ratio 가 임계와 **정확히** 같아지는 입력이 없고 실측상 발생 확률 0. web·src 가 같은 식이라 갈릴 수 없다(구현자 tie-break 발견과 동류) |
| O3 | 슬롯당 argmax 제거(`!prev \|\| bestRatio > prev.ratio` → `!prev`) | **DETECTED** | T8 이 잡는다 |
| O4 | `groundBand(rect, groundBandRatio)` → `groundBand(rect)` (**cfg 오버라이드 무시**) | **미검출** | ❌ **구멍(악질)**. `groundBandRatio 오버라이드` 라는 **이름의 테스트가 3개** 있는데 전부 폴리곤이 rect 의 y 범위를 **완전히 덮어** ratio 가 결과에 영향을 주지 않는 기하다. 즉 **그 테스트는 오버라이드가 무시돼도 통과한다.** 프로브(폴리곤이 y 0.30~0.40 만 덮음)로 즉시 검출됨 |
| O5 | `computeOccupancy` 의 `cands.find` → `findLast`(첫 매칭 규약) | **DETECTED** | |
| O6 | 판정행 초기값 `source: null` 키 제거 | **DETECTED** | `toEqual` 이 키 존재를 본다 |

### 3.4 집계 및 "구멍"의 실증

- **17건 중 10 검출 / 7 미검출.**
- 미검출 7건 중 **6건이 진짜 테스트 구멍**이다(O2 만 의미상 등가).
- 판별 방법: 각 미검출 변이를 겨냥한 **최소 프로브 케이스**를 만들어 ①무변이 상태에서 web↔src 일치
  (= **구현은 정상**)를 확인하고 ②변이를 다시 넣었을 때 **6건 전부 DETECTED** 됨을 실행으로 확인했다.

```
T3 zoom != null → !== undefined              | 프로브: DETECTED
T5 (presetSlotIdx ?? 0) → ?? 999             | 프로브: DETECTED
S4 preset 정렬 camIdx↔presetIdx              | 프로브: DETECTED
S6 roiByPreset 키 [0] → at(-1)               | 프로브: DETECTED
O1 rows[openPos[k]] → rows[k]                | 프로브: DETECTED
O4 groundBand(rect, ratio) → groundBand(rect)| 프로브: DETECTED
```

즉 **"둘 다 같은 버그라서 통과"가 아니라 "그 자리를 건드리는 입력이 없어서 통과"** 였다.
구현은 옳고 봉인만 얕다.

---

## 4. 발견한 결함 목록

### D-1 (중) `setup.slot.add`/`delete` 의 `artifact` 버퍼가 **파일 전체를 대체**한다 — 미고지

**재현(실행 출력 그대로)**
```
파일 슬롯 수: 2 → 2 (status 200, warnings=["DB slot_setup(0) 과 artifact(2) 의 슬롯 수가 다르다 — …"])
```
파일에 슬롯 2개(`c1p1s1`,`c1p1s2`)가 있는 상태에서
`POST /mapping/slot/add {camIdx:1, presetIdx:1, artifact:<c1p1s1 만 든 버퍼>}` (dryRun 미지정)
→ 기대는 3개(2+1), 실제는 **2개**. **파일의 `c1p1s2` 가 조용히 사라졌다.**
별도 케이스: `{...ARTIFACT, createdAt:'TAMPERED'}` 를 버퍼로 넣으면 디스크의 `createdAt` 이 `TAMPERED` 가 된다.

**성격**: 리더 결정 Q3 의 설계 그대로다(`artifact` 호출자 버퍼 + `dryRun`). **코딩 버그가 아니다.**
문제는 **사정거리가 어디에도 적혀 있지 않다**는 것이다:
- 메서드 이름은 "셋업 산출물에 슬롯 엔트리 **1개 추가**"
- 카탈로그 `note` 는 "`setup_artifact.json` 만 바꾼다" — 참이지만 "**통째로** 바꿀 수 있다"는 말이 없다
- `warnings[]` 는 DB 개수 불일치만 알린다. **파일이 N슬롯 → 버퍼 M슬롯으로 대체됐다는 사실은 침묵**
- 설계서 R12 는 "이번 4건은 파괴 경로에 아예 진입하지 않는다"고 쓰여 있는데, 이는 **DB 에 한해서만** 참이다

**영향**: 웹은 항상 `dryRun:true` 라 안전하다. 위험한 건 **외부 RPC 호출자**다 —
오래된/부분적인 버퍼를 들고 `setup.slot.add` 를 부르면 그 사이의 편집이 전부 소실된다.
07-28 "검출·센터링 23→0 wipe" 와 **같은 계열의 사고**가 파일 쪽에 열려 있다.
(토큰 게이트가 켜져 있으면 무인증 호출은 막히므로 **완화되지만 제거되지는 않는다**.)

**수정 여부**: **안 함**(사양 판단 필요 — 리더 결정 Q3 의 범위).
**권고**: ①카탈로그 `note` 에 "`artifact` 를 주면 그 버퍼가 파일을 **대체**한다(부분 병합 아님)" 명시
②`warnings[]` 에 `파일(N슬롯)을 호출자 버퍼(M슬롯)로 대체했다` 추가(개수가 다를 때)
③문서화 단계에서 R12 문구를 "DB 는 구조적 무위험 / 파일은 호출자 버퍼 책임"으로 정정.

### D-2 (중) 파리티 봉인의 판별력 구멍 6건 — §3 상세

지금 코드는 옳지만 그 6개 자리는 **깨져도 green 이다.** 특히 O4 는 테스트 이름이 검증한다고
주장하는 것을 실제로는 검증하지 않는다(공허한 테스트).

**수정 여부**: **안 함**(테스트 추가는 "명백한 버그 수정"이 아니라고 판단 — 저장소를 시작 상태로 되돌렸다).
**권고**: 아래 6개 케이스를 각 파리티 파일에 추가하면 6건 전부 봉인된다. 전부 무변이 상태에서 green 임을 확인했고,
각 변이를 다시 넣으면 실패함도 확인했다.

```ts
// ── test/occupancyJudgeParity.test.ts 에 추가 ──────────────────────────
// O1: 1단계가 앞 슬롯을 먹고 2단계 폴백이 뒤 슬롯을 채운다 → openPos 사영이 항등이 아니다.
it('1단계 bbox=slot1 + 2단계 plate=slot2 (openPos 사영 봉인)', () => {
  const rows = parity(FLOORS, { plates: [plateAt(0.6, 0.2)], vehicles: [{ rect: R_IN_S1 }] });
  expect(rows.map((r) => r.source)).toEqual(['bbox', 'plate']); // 사영이 무너지면 여기서 갈린다
});

// O4: 폴리곤이 rect 의 y 범위를 **부분만** 덮어야 groundBandRatio 가 결과를 바꾼다.
//     기존 3개 오버라이드 테스트는 폴리곤이 y 를 전부 덮어 ratio 에 둔감했다.
describe('groundBandRatio 가 실제로 결과를 바꾸는 기하', () => {
  const PARTIAL = [{ idx: 1, quad: floorQuad(0.0, 0.30, 0.4, 0.40) }];
  const R = { x: 0.05, y: 0.0, w: 0.25, h: 0.35 };
  it('ratio 1.0 과 기본값이 서로 다른 답을 낸다(민감도 자체 확인)', () => {
    expect(srvJudge(PARTIAL, { vehicles: [{ rect: R }] }, { groundBandRatio: 1.0 })[0].occupied)
      .not.toBe(srvJudge(PARTIAL, { vehicles: [{ rect: R }] })[0].occupied);
  });
  it('web ↔ src 일치(ratio 1.0)', () => {
    parity(PARTIAL, { vehicles: [{ rect: R }] }, { groundBandRatio: 1.0 });
  });
});

// ── test/touringPlanParity.test.ts 에 추가 ────────────────────────────
it('centering 내부 값만 null(부분 결손)', () => {                                   // T3
  const input = { slots: [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
    centering: { pan: 1, tilt: 1, zoom: null } }] };
  expectParity(input);
  expect(srcPlan(input).skipped).toBe(1);
});
it('presetSlotIdx 가 null 과 숫자로 섞인 그룹(정렬 기본값 봉인)', () => {            // T5
  const input = { slots: [
    { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 5,    centering: { pan: 1, tilt: 1, zoom: 1 } },
    { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: null, centering: { pan: 2, tilt: 2, zoom: 2 } },
  ] };
  expectParity(input);
  expect(srcPlan(input).steps.filter((x) => x.kind === 'slot').map((x) => x.slotId)).toEqual([2, 1]);
});

// ── test/artifactSlotEditParity.test.ts 에 추가 ───────────────────────
it('다중 카메라 — preset 정렬은 camIdx 가 우선(cam1p2 < cam2p1)', () => {            // S4
  const slots = [
    { slotId: 'c1p2s1', zone: 'cam1', roiByPreset: { '1:2': { x: .1, y: .1, w: .2, h: .2 } } },
    { slotId: 'c2p1s1', zone: 'cam2', roiByPreset: { '2:1': { x: .1, y: .1, w: .2, h: .2 } } },
  ] as ParkingSlot[];
  const presets = [
    { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c1p2s1'] },
    { camIdx: 2, presetIdx: 1, label: '2:1', coveredSlotIds: ['c2p1s1'] },
  ] as Preset[];
  const s = srcRebuildGlobalIndex(slots, presets);
  expect(s).toEqual(webRebuildGlobalIndex(slots as never, presets as never));
  expect(s.map((g) => g.slotId)).toEqual(['c1p2s1', 'c2p1s1']);
});
it('roiByPreset 키가 2개인 슬롯 → **첫** 키로 preset 귀속', () => {                  // S6
  const dual = { slotId: 'c1p1s3', zone: 'cam1', roiByPreset: {
    '1:1': { x: .4, y: .4, w: .1, h: .1 }, '2:7': { x: .5, y: .5, w: .1, h: .1 } } } as ParkingSlot;
  const [w, s] = pair((a) => webInsertSlotAt(a, 2, dual as never), (a) => srcInsertSlotAt(a, 2, dual));
  expect(s).toEqual(w);
  expect(s.globalIndex!.find((g) => g.slotId === 'c1p1s3'))
    .toEqual({ globalIdx: 2, slotId: 'c1p1s3', camIdx: 1, presetIdx: 1 });
});
```

### D-3 (하) 무인증 카메라 이동 라우트는 **1개가 아니라 2개**다 — 고지 누락

리더 지시문 · 설계서 §7 Q1 · `controlGate.ts:20-24` 주석은 전부 **`POST /capture/detect` 하나**만
"읽기 선언인데 카메라를 물리 이동시킨다"는 모순으로 적고 있다. 실제로는 하나 더 있다:

```
src/rpc/methods.ts:236-244   place.align.estimate   mutating:false, requiresCamera:true
src/api/captureRoutes.ts:1113   const cur = await camera.requestImage(cam, preset);   // ← 프리셋 적용 = 물리 이동
```
`POST /capture/autocorrect` 는 `READONLY_POST_PATHS` 에 있어 **무토큰으로 카메라를 돌릴 수 있다.**
(나머지 면제 2개는 확인 결과 실제로 부작용 0 — `/capture/place-roi/validate` 는 순수 판정,
`/capture/ground-grid/bootstrap` 은 파일 읽기 + `planAutoRoi` 계산뿐이고 파일을 쓰지 않는다.)

**성격**: 이번 변경이 만든 것이 아니라 **사전 존재 계약**이다(카탈로그 `mutating:false`).
리더 Q1(a) "현행 유지"의 범위에 이것도 포함되지만, **명시되지 않아 은닉처럼 보인다.**
**수정 여부**: **안 함**(카탈로그 계약 변경은 범위 밖 — Q1(a) 결정 그대로).
**권고**: `controlGate.ts` 주석과 문서의 "알려진 한계"에 `/capture/autocorrect` 를 **함께** 적을 것.

### D-4 (하) `config/tools.config.json` 에 라이브 테스트 값이 남아 있다

```diff
-    "port": 13020,          →  "port": 13021,
-    "controlToken": ""      →  "controlToken": "LIVETEST"
```
워킹트리에 커밋되지 않은 채 남아 있다(**검증 착수 시점부터 존재** — 내가 만든 것이 아니다).
이대로 커밋되면 **배포에 토큰이 켜진 채로 나간다.** MCP(`src/mcp/server.ts:34`)는 같은 config 를
읽으므로 값이 맞으면 동작하지만, 다른 config 를 읽는 호출자는 전부 403 이 된다(설계 R4 경고 그대로).
**수정 여부**: **안 함**(마스터 소유 파일 — 판단 요청). 커밋 전 원복 여부를 결정할 것.

### D-5 (하) 순수 판정 라우트가 capture 잡 의존성에 묶여 있다

`POST /capture/slots/judge-occupancy` 는 카메라·DB·파일을 전혀 만지지 않는 순수 계산인데
`registerSlotRoutes`(captureRoutes.ts:490) → `registerCaptureRoutes` 안에 있어,
`captureJob && finalizer && sqlite && capture` **4개가 전부 주입돼야** 등록된다.
최소 헤드리스 구성에서 `slot.occupancy.evaluate` 가 `-32004 UNAVAILABLE` 로 나온다(내 프로브에서 실제 재현).
`src/index.ts` 는 항상 4개를 주입하므로 **실운영 영향은 0**이다. 설계 일관성 관점의 기록.
**수정 여부**: **안 함**(외과적 변경 원칙 — 라우트 이동은 `rpcParity` `known` 목록·T4 검사에 파급).

### D-6 (하·표시) `addSlot` 의 warnings 표시가 직전 문구에 이어붙는다

```js
// web/app.js:1512
if (msg && (data.warnings ?? []).length) msg.textContent = `${msg.textContent} — ${data.warnings.join(' / ')}`;
```
성공 시 `#map-msg` 에 새 문구를 설정하지 않으므로, `msg.textContent` 는 **직전에 남아 있던 아무 문구**다
(예: `"표시된 산출물 없음 — DB slot_setup(0) 과 …"`). 반복 호출 시 계속 길어진다.
**수정 여부**: **안 함**(문구는 UX 판단 — 마스터/설계자 소유). 1줄 수정으로 해소 가능(`msg.textContent = data.warnings.join(' / ')`).

### D-7 (정보) 테스트 부산물 `x.json` 이 워크트리 루트에 생성된다

`npx vitest run` 마다 워크트리 루트에 `x.json`(`{"createdAt":"T","items":[]}`)이 생긴다.
출처는 `test/jobFrameReset.test.ts:38,110` 의 `outFile: 'x.json'`(상대경로 → cwd).
**사전 존재**이며 이번 변경과 무관. 삭제해도 다음 실행에 재생성된다. `.gitignore` 대상 후보.

---

## 5. 검증하지 못한 항목 (정직 기록)

1. **라이브 브라우저 육안 확인 미수행.** 서버를 띄워 실제 버튼을 눌러보지 않았다. 따라서 다음은 **미검증**이다:
   - `localStorage['pa.viewerToken']` 실제 영속 + `#viewer-token` 입력 반응 (정적 문자열 단정으로만 확인)
   - 순회 중 화면이 프리셋을 따라가는지(`syncTouringPreset`), 완료 모달 문구
   - 점유 오버레이 원·사다리꼴·뱃지가 서버 판정으로도 **픽셀 동일**한지
   - 슬롯 추가 → Ctrl+드래그 배치 → 저장 2단계 UX 의 실제 체감
   대체 검증: shape 교차비교(§항목7) + 정적 봉인 + `app.inject` 상태코드. **육안이 최종 확정이다.**

2. **실제 카메라/VPD/LPD 연동 스모크 미수행.** 전부 fake 주입이다.
   `TourJob` 이 실제 PTZ 장비에서 의도한 위치로 가는지, `requestImage` 프리셋 폴백이 실기에서 동작하는지 미확정.

3. **동시성 미검증.** 순회 중 다른 잡 시작, 웹 다중 탭 동시 슬롯편집(**D-1 이 현실화되는 시나리오**),
   `dryRun` 버퍼와 파일의 경쟁 갱신 — 전부 단일 순차 호출로만 확인했다.

4. **성능(설계 R7) 미측정.** "리드로 → 데이터 변경점"으로 호출을 줄인 효과와
   `frames[]` 배치 왕복 지연을 실측하지 않았다. 프리셋 수가 많을 때의 체감은 라이브에서만 나온다.

5. **사전 실패 2건 무접촉.** `roiDbLoad`·`placeRoiRuntimeInvariants` 는 지시대로 읽지도 고치지도 않았다.
   상태 변화 없음(§1.1 = §1.2).

6. **파리티 변이는 17건이 전부다.** 전수 변이(mutation testing 완전판)를 돌린 것이 아니므로,
   §3 에서 "DETECTED" 로 나온 자리 외에도 봉인이 얕은 곳이 더 있을 수 있다.
   측정한 범위에서 6개 구멍이 나왔다는 사실 자체가 **더 있을 가능성**을 시사한다.

7. **`TourJob` 의 실패 흡수·stop 경합은 구현자 테스트(`tourJob.test.ts`)에 의존했다.**
   내가 독립 재현한 것은 라우트·RPC 표면(상태코드·오류코드)까지이고, 잡 내부 상태머신은 재검증하지 않았다.

---

## 6. 구현자·문서화 인계

- **구현자에게 재실행 요청 없음** — 실패한 테스트도, 고쳐야 할 명백한 버그도 발견하지 못했다.
  D-1·D-2 는 **리더/설계자 판단 사항**이라 반려하지 않고 보고만 한다.
- **문서화(04)에 반드시 반영할 것**:
  - D-1 의 `artifact` 버퍼 사정거리(문서에 "슬롯 1개 추가"로만 적으면 사고가 난다)
  - D-3 의 무인증 카메라 이동 라우트 **2개**(`/capture/detect` + `/capture/autocorrect`) — 은닉 금지
  - 설계서 R12 문구를 "DB 무위험 / artifact 파일은 호출자 버퍼 책임"으로 정정
  - `GET /rpc/catalog` **70 → 76** 확정(실측 `count = 76`)
- **커밋 전 확인**: D-4(`config/tools.config.json` 의 `controlToken:"LIVETEST"` · `port:13021`).

---

# 7. 봉인 영구 편입 (리더 지시 후속 · 2026-07-28)

**지시**: D-2 의 구멍 6건을 임시 프로브로 버리지 말고 대응 파리티 파일에 정식 케이스로 추가하고,
영구 파일 위에서 변이를 재주입해 FAIL 을 실증할 것. 기존 케이스 무수정. 의미상 등가 1건(O2)은 제외.

## 7.1 추가한 케이스 목록 (기존 케이스 **무수정** · 추가만)

| 파일 | 추가한 describe / it | 잡는 변이 | 왜 기존 케이스로는 못 잡았나 |
|---|---|---|---|
| `test/touringPlanParity.test.ts` | `봉인 강화(음성 대조로 발견한 구멍)` → **`centering 내부 값만 null(부분 결손) — null 과 undefined 를 구분한다`** | `c.pan/tilt/zoom != null` → `!== undefined` | 기존 `부분 결손(zoom 누락)` 은 zoom 이 **undefined** 라 두 식이 같은 답을 낸다. **명시적 null** 이어야 갈린다 |
| 〃 | **`presetSlotIdx 가 null 과 숫자로 섞인 그룹 — 정렬 기본값(0)이 순서를 결정한다`** | 정렬 tie-break `(presetSlotIdx ?? 0)` 의 기본값 변경 | 기존 `presetSlotIdx=null 동률` 은 **둘 다 null** 이라 기본값이 무엇이든 순서가 같다 |
| `test/artifactSlotEditParity.test.ts` | `봉인 강화(음성 대조로 발견한 구멍)` → **`다중 카메라 — preset 정렬은 camIdx 가 presetIdx 보다 우선(cam1p2 < cam2p1)`** | `rebuildGlobalIndex` 의 preset 정렬 `camIdx → presetIdx` 순서 뒤바꿈 | `sampleArtifact()` 가 **단일 카메라**(1:1, 1:2)라 두 정렬이 같은 답을 낸다 |
| 〃 | **`roiByPreset 키가 2개인 슬롯 — 첫 키로 preset 을 귀속한다`** | `insertSlotAt` 의 `Object.keys(roiByPreset)[0]` → 다른 키 선택 | 기존 신규 슬롯의 `roiByPreset` 키가 **항상 1개**(또는 0개)라 어느 키를 골라도 같다 |
| `test/occupancyJudgeParity.test.ts` | `봉인 강화(음성 대조로 발견한 구멍)` → **`1단계 bbox=slot1 + 2단계 plate=slot2 — openPos 사영이 항등이 아닌 조합`** | 2단계 폴백 사영 `rows[openPos[k]]` → `rows[k]` | T1~T9 는 전부 `openPos` 가 **항등 사영**이었다(1단계 점유가 없거나, 점유가 뒤 슬롯이라 `openPos[0]===0`) |
| 〃 | `groundBandRatio 가 실제로 결과를 바꾸는 기하(폴리곤이 rect y범위를 부분만 덮음)` → **`민감도 자체 확인 — ratio 1.0 과 기본값(0.25)이 서로 다른 답을 낸다`** + **`web ↔ src 일치(ratio 1.0 / 0.05 / 기본값)`** | `groundBand(rect, groundBandRatio)` → `groundBand(rect)` (cfg 오버라이드 무시) | 기존 `cfg 오버라이드` 3건은 **폴리곤이 rect 의 y 범위를 전부 덮어** 밴드의 y 위치·높이가 겹침 비율에 영향을 주지 않는 기하다 — **ratio 가 무시돼도 같은 답이 나온다** |

**합계 +7 케이스**(it 기준): touringPlan +2 · artifactSlotEdit +2 · occupancyJudge +3.
모든 it 에 **"잡는 변이"를 주석 1~2줄로 명시**했다(§9.2 규약 — 다음 사람이 이 케이스를 지워도 되는지 판단할 근거).
각 describe 머리말에 "지우면 그 변이가 green 으로 통과하게 된다"를 못 박았다.

### O4 를 별도로 다룬 이유 (리더 요건 4)

기존 3개 케이스는 이름이 `groundBandRatio 오버라이드` 인데 **그 오버라이드가 무시돼도 통과**했다 —
**이름이 거짓말을 하는 테스트**다. 지시대로 **기존 3개는 지우지 않고** 새 describe 를 추가했으며,
새 기하가 진짜로 ratio 에 민감한지를 **테스트 안에서 스스로 단정**하게 만들었다:

```ts
it('민감도 자체 확인 — ratio 1.0 과 기본값(0.25)이 서로 다른 답을 낸다', () => {
  // 이 단정이 깨지면 아래 파리티 케이스가 다시 "ratio 에 둔감한 기하"로 퇴화한 것이다.
  const wide = srvJudge(PARTIAL, { vehicles: [{ rect: R }] }, { groundBandRatio: 1.0 });
  const base = srvJudge(PARTIAL, { vehicles: [{ rect: R }] });
  expect(wide[0].occupied).not.toBe(base[0].occupied);
});
```
`PARTIAL` = 폴리곤이 y `0.30~0.40` 만 덮음 / `R` = rect y `0~0.35`.
→ ratio 1.0 이면 밴드 y `0~0.35`, 기본 0.25 면 밴드 y `0.2625~0.35` 라 겹침 비율이 실제로 갈린다.
**이 가드가 있으면 "둔감한 기하로 퇴화" 자체가 다시는 조용히 일어날 수 없다.**

## 7.2 ★ 재주입 FAIL 실증 (영구 파일 위에서 · 실행 출력 그대로)

```
T3 `c.zoom != null` → `c.zoom !== undefined`   | FAIL 1건 | centering 내부 값만 null(부분 결손) — null 과 undefined 를 구분한다
T5 정렬 기본값 `(presetSlotIdx ?? 0)` → `?? 999` | FAIL 1건 | presetSlotIdx 가 null 과 숫자로 섞인 그룹 — 정렬 기본값(0)이 순서를 결정한다
S4 preset 정렬 `camIdx↔presetIdx` 뒤바꿈        | FAIL 1건 | 다중 카메라 — preset 정렬은 camIdx 가 presetIdx 보다 우선(cam1p2 < cam2p1)
S6 roiByPreset 키 `[0]` → `.at(-1)`            | FAIL 1건 | roiByPreset 키가 2개인 슬롯 — **첫** 키로 preset 을 귀속한다
O1 폴백 사영 `rows[openPos[k]]` → `rows[k]`     | FAIL 1건 | 1단계 bbox=slot1 + 2단계 plate=slot2 — openPos 사영이 항등이 아닌 조합
O4 `groundBand(rect, ratio)` → `groundBand(rect)` | FAIL 2건 | groundBandRatio 가 실제로 결과를 바꾸는 기하 > 민감도 자체 확인 — ratio 1.0 과 기본값(0.25)이 서로 다른 답을 낸다
                                                            / groundBandRatio 가 실제로 결과를 바꾸는 기하 > web ↔ src 일치(ratio 1.0 / 0.05 / 기본값)
```

**6건 전부 FAIL.** 그리고 결정적으로 — **실패한 it 이름이 전부 이번에 추가한 케이스다.**
기존 케이스는 단 하나도 실패하지 않았다. 즉 "새 케이스가 실제로 잡는 주체"임이 이름 단위로 증명됐다
(기존 케이스가 우연히 같이 잡은 것이 아니다).

O4 만 2건인 이유: 민감도 가드와 파리티 케이스가 **둘 다** 걸린다 — 오버라이드가 무시되면
①두 ratio 가 같은 답을 내서 민감도 단정이 깨지고 ②web(오버라이드 반영) vs src(무시)가 갈린다.

**변이 원복 확인**(구현 3파일 md5 — 변이 주입 전 기록값과 동일):
```
5c28bf09e6df2c665c75eee711ca9414  src/setup/touringPlan.ts
fa2c69736933a06e0dcdb28313b5cdc4  src/setup/artifactSlotEdit.ts
7be80e71cc6edf6918cff3c07bc92a0d  src/domain/occupancyJudge.ts
```

## 7.3 회귀 확인

```
$ npx tsc --noEmit
TSC_EXIT=0

$ npx vitest run          (연속 2회 — 동일)
 Test Files  2 failed | 272 passed (274)
      Tests  2 failed | 3452 passed (3454)
```
- 사전 실패는 **여전히 2건**(`placeRoiRuntimeInvariants` · `roiDbLoad`) — 무접촉 유지.
- **회귀 0.** 실패한 테스트 파일이 늘지 않았고, 기존 단정값을 하나도 수정하지 않았다.
- 파리티 3파일 개별 실행: `touringPlanParity 19` · `artifactSlotEditParity 21` · `occupancyJudgeParity 35` = **75 passed**.

**테스트 수 증가 회계** — 기준선 3436 → **3452 (+16)**
| 출처 | 증가 | 비고 |
|---|---|---|
| **내 봉인 편입** | **+7** | touringPlan +2 · artifactSlotEdit +2 · occupancyJudge +3 |
| W4 의 D-1 가드 회귀 테스트 | +9 | `mappingSlotRoutes.test.ts` 27건 등. 리더가 별도 지시한 동시 작업 — 내가 만든 것이 아니다 |

> ⚠ 검증 중 한 번 `3 failed / 3451 passed` 가 관측됐으나 **일시적 현상**이었다.
> W4 가 `src/api/server.ts`·`test/mappingSlotRoutes.test.ts` 를 **쓰는 도중**에 내 전체 실행이 겹친 것이다.
> W4 편집 완료 후 **연속 2회 모두 `2 failed / 3452 passed`** 로 안정. 내 편입과 무관함을 확인했다.

## 7.4 제외한 1건과 그 근거 (지시대로 추가하지 않음)

**O2 — 임계 경계 `bestRatio >= minBandOverlap` → `>`.**
추가하지 않았다. 이유:
- 이 변이가 답을 바꾸려면 `convexIntersectionArea(corners, quad) / bandArea` 가 임계값
  (기본 `ON_PLACE_MIN_OVERLAP = 0.15`)과 **비트 단위로 정확히** 같아야 한다.
- 그 값은 클리핑 다각형 면적 나눗셈의 결과라 **입력을 역산해 정확한 동률을 만들 수 없다**
  (구현자가 `R_STRADDLE_TIE` 로 시도했으나 두 슬롯의 클리핑 경로가 달라 비트동일이 나오지 않았다 — `02c` 기록).
- 설령 만든다 해도 **web·src 가 같은 식**이라 두 구현이 갈릴 수 없다. 파리티(=web↔src 동일성)로는
  원리적으로 검출 불가능한 자리다.
- 즉 **통과할 수 없는 케이스를 만드는 셈**이며, 억지로 만들면 부동소수 우연에 기대는 취약한 테스트가 된다.

기존 `occupancyJudge.test.ts:97` 의 주석("부동소수상 정확 동률은 실측 발생 확률 0")과 같은 판단이며,
구현자가 `02c` 에서 tie-break `>`/`>=` 를 미검출로 정직 기록한 것과 **동일 계열**이다.

## 7.5 §3 결과표 갱신

§3 의 "미검출 7건" 중 **6건은 이제 봉인됐다.** 갱신된 상태:

| 변이 | §3 당시 | 현재 |
|---|---|---|
| T3 · T5 · S4 · S6 · O1 · O4 | 미검출(구멍) | **DETECTED**(영구 케이스로 봉인, §7.2 실증) |
| O2 | 미검출(의미상 등가) | 그대로 — **원리적 검출 불가**(§7.4) |
| 나머지 10건 | DETECTED | 그대로 |

→ **파리티 3종의 판별력: 17건 중 16 검출 / 1 원리적 불가.**
"구현은 옳고 봉인만 얕다"였던 상태에서 **봉인도 옳은 상태**로 올라왔다.

## 7.6 이번 후속 작업에서 하지 않은 것 (중복 방지 · 리더 지시대로)

- **D-1 가드 구현·회귀 테스트**: W4 담당(내 재현 케이스 인계 완료). 확인 결과 `server.ts:508-525` 에
  `rejectBufferCommit`(= `artifact` 를 `dryRun:true` 없이 주면 409)이 들어와 있고 `mappingSlotRoutes` 27건 green.
  **내가 다시 검증하지 않았다** — 리더 지시(중복 금지). 독립 재검증이 필요하면 별도 지시를 달라.
- **D-3 문서·주석 명시**: 문서화 담당. 코드 변경 없음(Q1 일관성).
- **D-4 config 원복**: 리더 본인이 처리.
