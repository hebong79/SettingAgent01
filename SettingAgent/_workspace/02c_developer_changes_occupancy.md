# 02c 구현 변경 내역 — W3(점유판정 서버 정본화: 포팅 + 라우트·RPC + 웹 껍데기화)

작성: 2026-07-28 · 워크트리 `.claude/worktrees/feat-server-promote-4/SettingAgent`
입력: `_workspace/00_leader_decisions.md`(우선 — 특히 **Q2 = (a) 상수 import, 값 복제 금지**) ·
`_workspace/01_architect_plan.md` §0·§3·§5(단계 7·8·9)·§5.2(O1·O2)·§6(R7·R8·R9) ·
`_workspace/02_developer_changes.md`(W1 규약 — `mutFetch`·`READONLY_POST_PATHS`) ·
`_workspace/02b_developer_changes_tour.md`(W2 규약 — `syncPtzAfterJob` 책임 인계)

범위: **W3 만**. 슬롯편집(W4)은 한 줄도 건드리지 않았다. W1·W2 산출물의 **로직은 수정하지 않았다**
(`controlGate.ts` 는 면제목록 1줄 추가 — W1 이 인계에서 명시적으로 요구한 항목이다. §4-1 참조).

---

## 1. 변경 파일 목록

### 신규(3)

| 파일 | 내용 |
|---|---|
| `src/domain/occupancyJudge.ts` | `web/occupancy.js:OccupancyJudge.judge` + `web/core.js:computeOccupancy` **자구 포팅**(순수·I/O 0). 기하 프리미티브·상수는 전부 기존 서버 모듈 재사용 — 신규 알고리즘 0줄 |
| `test/occupancyJudgeParity.test.ts` | O1 — web↔src `toEqual` 깊은 비교 **32테스트**(T1~T9 재사용 + 퇴화 12 + cfg 4 + computeOccupancy 10) |
| `test/occupancyRoutes.test.ts` | O2 — 라우트 12 + RPC 3 = **15테스트** |

### 수정(11)

| 파일 | 무엇을 | 왜 |
|---|---|---|
| `src/api/captureRoutes.ts` | zod 스키마 1개 + `POST /capture/slots/judge-occupancy` 1라우트 + `handleJudgeOccupancy` + import 3줄 | 단계 8. `registerSlotRoutes` 안(=`/capture/slots/*` 가족) |
| `src/rpc/methods.ts` | `slot.occupancy.evaluate` 1개(`http` 위임, **handler 0줄**) | 카탈로그 73 → **74** |
| `src/api/controlGate.ts` | `READONLY_POST_PATHS` 에 `/capture/slots/judge-occupancy` 1줄(주석 2줄) | **W1 인계 지시**. 읽기전용 POST(`mutating:false`)라 면제하지 않으면 W1 드리프트 테스트가 실패한다 |
| `src/capture/onPlaceFilter.ts` | `groundBand(rect)` → `groundBand(rect, ratio = GROUND_BAND_RATIO)` (기본값 동일) | 리더 결정 Q2(a) "값 복제 금지"를 지키려면 `cfg.groundBandRatio` 오버라이드에도 **이 함수를 그대로 써야** 한다. §4-2 |
| `web/app.js` | ①`OccupancyJudge`·`computeOccupancyRegions` import + 인스턴스 **삭제** ②`updateLogicOccupancy` → `async refreshOccupancy`(서버 배치 호출) ③`drawRoiOverlay`·`renderSlotList` 의 호출 **삭제** ④데이터 변경점 4곳에 호출 추가 ⑤`buildFlatSlotRows` 인자 교체 | 단계 9 본체 |
| `web/core.js` | `buildFlatSlotRows({placeRoi, detectByKey, parkingSlotsByKey, judge})` → `({placeRoi, parkingSlotsByKey, occByKey})`. 내부 판정(`judge.judge` / `computeOccupancy` 분기) → **캐시 조회** | 웹이 판정하지 않는다 |
| `web/core.d.ts` | 위 시그니처 타입 동기화 | |
| `test/placeGlobalIdx.test.ts` | `occFromDetect()` 헬퍼 신설 + 호출부 6곳 교체 | **단정값 전부 불변** |
| `test/occupancyAnchor.regression.test.ts` | R6 호출부를 "판정식으로 채운 캐시 2종" 으로 교체 + import 1개 | **단정값 불변**(전량 점유 / `[5,10,17]`) |
| `test/boundaryCrossCheck.test.ts`·`test/finalizerParkingSlots.test.ts` | `detectByKey: {}` 인자 제거(각 1줄) | 사라진 파라미터 정리 |
| `test/captureRoutesShape.test.ts`·`test/viewerPtzSyncCoverage.test.ts` | 신규 라우트 1줄씩 선언 | 두 테스트는 **새 라우트에 선언을 강제하도록 설계**돼 있다. §4-3 |

### 의도적 무변경(확인함)

`web/occupancy.js`(파리티 기준변 — **삭제 금지**) · `web/core.js:computeOccupancy`(기준변 존치, `occupancy.js` 가 여전히 쓴다) ·
`web/occupancyRegion.js`(기준변) · `src/domain/occupancyRegion.ts`·`geometry.ts`·`polygon.ts`(이미 파리티 봉인 — 재구현 0) ·
`test/rpcParity.test.ts` 의 `known` 목록(**무편집** — `/capture/slots` 접두어로 통과. 설계 근거대로) ·
`test/occupancyJudge.test.ts`·`computeOccupancy`·`occupancyRegion`·`occupancyRegionParity`·`occupancyGeometryParity`(**무수정 green**) ·
`test/roiDbLoad.test.ts`·`test/placeRoiRuntimeInvariants.test.ts`(사전 실패 2건, 무접촉) ·
`src/mcp/server.ts`(카탈로그 프록시라 수정 0) · **DB 쓰기 API 호출 0건**(`replaceSlotSetup` 계열 미호출 — 이 라우트는 `deps` 를 받지도 않는다).

---

## 2. 핵심 구현 노트

### 2.1 단계 7 — `src/domain/occupancyJudge.ts`

- **자구 포팅.** 정렬·argmax·`quadKey` 중복차단·`placedVehicles`·strict `>` tie-break·퇴화 rect 스킵·2단계 폴백 후보 조립 순서까지 웹과 1:1. 창의적 개선 0.
- **기하는 재사용**: `geometry.quadCentroid`·`geometry.area`·`polygon.pointInPolygon`·`polygon.rectCorners`·`polygon.convexIntersectionArea`·`onPlaceFilter.groundBand`. 서버에 이미 파리티 봉인된 것을 다시 쓰는 것이 정의 갈림을 막는 유일한 방법이다.
- **웹판에만 있던 퇴화 가드 2개를 로컬로 복원**(이게 포팅의 핵심 위험 지점이었다):
  - `quadCentroidOrNull` — 비4점·비수치면 `null`. `geometry.quadCentroid` 는 가드가 없어 **항상 값을 낸다** → 그대로 쓰면 퇴화 번호판이 "중심이 있는 판"으로 둔갑해 판정이 조용히 뒤집힌다.
  - `pointInQuad` — `length < 3` 선행 가드(`pointInPolygon` 은 비배열에서 throw 한다).
- `computeOccupancy` 의 반환 행은 웹과 동일하게 **미점유 시 `source` 키 자체가 없다**. `judgeOccupancy` 초기 행만 `source:null` 을 갖는다 — `toEqual` 은 키 존재를 보므로 이것이 곧 계약이다.
- 상수(`GROUND_BAND_RATIO`·`ON_PLACE_MIN_OVERLAP`)는 **import**. 리더 결정 Q2(a). `domain → capture` import 가 새로 생겼고 **순환 없음을 재확인**했다(`onPlaceFilter` 는 `domain/*` 와 `setup/plateMatch` 만 참조하며 `domain/occupancyJudge` 를 참조하지 않는다. `tsc` 0 · vitest 전량 green 이 실증).

#### 파리티 테스트의 판별력을 실측했다(공허한 green 방지)

"둘 다 같은 버그를 갖고 있어서 통과"하는 것을 배제하려고 **포팅본에 의도적 변이를 넣고** 테스트가 잡는지 확인했다.

| 변이 | 결과 |
|---|---|
| `quad.length !== 4` → `< 4`(중심 가드 완화) | **FAIL 1건** 검출 |
| `bandArea <= 0` → `< 0`(퇴화 rect 스킵 완화) | **FAIL 1건** 검출 |
| tie-break `ratio > bestRatio` → `>=` | 검출 못 함 |
| `pointInQuad` 의 `length < 3` 가드 제거 | 검출 못 함 |

뒤 2건은 **정직하게 기록한다**. 이유까지 확인했다:
- tie-break: `R_STRADDLE_TIE`(x 0.20 w 0.40)는 기하학적으로는 정확한 동률이지만 `convexIntersectionArea` 의 클리핑 경로가 두 슬롯에서 달라 **비트동일 ratio 가 나오지 않는다** → `>` 와 `>=` 가 같은 답을 낸다. 기존 `occupancyJudge.test.ts:97` 의 주석("부동소수상 정확 동률은 실측 발생 확률 0")과 같은 사실이며, 웹·서버가 **같은 식**이라 어차피 갈릴 수 없다.
- `length < 3` 가드: `pointInPolygon` 은 0·1·2점 배열에서 루프가 토글되지 않아 자연히 `false` 다(2점은 같은 선분을 양방향으로 세어 두 번 토글 → `false`). 가드는 **비배열 입력**에서만 실질 효과가 있고 그건 `Array.isArray` 쪽이 잡는다. 그래도 웹과 자구를 맞추기 위해 남겼다.

### 2.2 단계 8 — 라우트·RPC

- **경로**: `POST /capture/slots/judge-occupancy`. `rpcParity` 의 `known` 에 이미 `'/capture/slots'` 가 있어 판정식(`url.startsWith(k + '/')`)에 걸린다 → **`known` 목록 무편집으로 통과**(설계 예측 그대로). W2 가 추가한 T4 동적 등록검사도 무편집 통과했다(`registerSlotRoutes` 는 무조건 등록되며 `makeFullCtx` 가 이미 그 의존성을 주입한다).
- **stateless**: cam/preset 을 받아 서버가 검출을 다시 돌리지 않는다. `POST /capture/detect` 는 카메라를 물리 이동시키므로 끌어들이면 읽기 메서드가 카메라를 점유하게 된다. → 카메라·DB·파일 무접촉, `mutating:false`, `requiresCamera` 없음.
- **`frames[]` 배치**(R7 의 본체): 소비처 `buildFlatSlotRows` 가 전 프리셋을 한 번에 그리므로 프레임마다 왕복하면 프리셋 수만큼 요청이 난다.
- **`regions:true`**: `computeOccupancyRegions` 를 `source==='plate' && plateQuad` 행에만 적용(app.js 와 동일 모집단). `{idx,scale,polygon}[]` + `overlapPairs` 를 반환한다. 응답의 `(idx → polygon)` 사영이 곧 `buildOccupyRegionsBySlot` 의 반환 Map 이며, 그 **동일성을 테스트로 고정**했다(`fromRoute` `toEqual` `new Map(direct)`, 크기 2 를 함께 단정해 빈 Map 끼리의 공허한 통과를 막았다).
- **RPC 는 로직 0줄** — `http` 위임 1개. `app.inject` 경유 결과가 REST 응답과 `toEqual` 임을 테스트로 고정했다.
- **오류코드**: zod 실패 → 400 `invalid body` → RPC `-32602 INVALID_PARAMS`. 빈 `frames` → 200 `{byKey:{}}`. 퇴화 폴리곤 → 200 + `occupied:false`(CONFLICT 로 올리지 않는다 — 부작용이 없어 "사람 개입" 대상이 아니고, 위장 점유 생성 금지 원칙과도 일치). BUSY/CONFLICT/UNAVAILABLE/NOT_FOUND 는 **이 라우트에서 발생할 수 없다**(잡·카메라·파일·DB 를 아예 만지지 않는다) — 발생 불가능한 시나리오에 에러 처리를 넣지 않았다(CLAUDE.md §2). §5-3 에 정직하게 기록한다.

### 2.3 단계 9 — 웹 껍데기화(★ 이번 웨이브의 본체)

**문제의 정확한 형태**: `updateLogicOccupancy()` 는 `drawRoiOverlay()` 안에서 돌았다. `drawRoiOverlay()` 호출 지점은 app.js 에 **66곳**, `renderSlotList()` 는 **31곳**이고, 정밀수집·캘리브레이션·탐색 중에는 프레임 폴러가 **500ms 마다** 재렌더한다. 그대로 fetch 로 바꿨으면 초당 2회 이상 + 캔버스 리사이즈·선택 변경·마우스 드래그마다 HTTP 가 나갔을 것이다.

**해법**: 계산 시점을 **데이터 변경점**으로 옮기고, 그리기는 캐시만 읽게 했다.

| 호출 지점 | 위치 | 사유 |
|---|---|---|
| ① `runLiveDetect` | app.js:1287 (`state.detectByKey` 기록 직후, `drawRoiOverlay()` 앞) | 검출이 바뀌었다 |
| ① `deleteSelectedDetect` | app.js:1539 | 검출 박스를 지웠다(판정 입력 변경) |
| ② `loadPlaceRoi` | app.js:1118 | 바닥 ROI(판정 입력)를 새로 읽었다 |
| ③ `markPlaceDirty` | app.js:2300 | 주차면 **편집 커밋 단일 funnel** — 추가·삭제·번호변경·전체삭제·되돌리기·정점이동(드래그 **종료**) 7곳이 전부 이 함수를 거친다 |

- 설계는 "③프리셋 전환 시 캐시 없으면 1회"였으나 **불필요해졌다**: 배치가 `state.detectByKey` 의 **모든 키**를 한 번에 채우므로 프리셋을 전환해도 캐시가 이미 있다. 대신 실측으로 발견한 ①의 두 번째 지점(검출 박스 삭제)과 ③(편집 funnel)을 넣었다. §4-4.
- **적재 shape 은 현행 그대로**(`{id, occupied, source, center, vehicleRect, region}`) → `drawOccupancyOverlay`·`#roi-db` 소스 전환·슬롯목록 뱃지는 **무변경**(R8).
- `overlapPairs` 를 응답에 포함시켰기 때문에 기존 `console.warn('[OccupancyRegion] … 겹침 잔존')` **1회 가드 로직도 그대로 살아 있다**.
- 실패(비200·네트워크 예외)는 **조용히 이전 값 보존** — 기존 `if (!floorPolys.length) return`(이전 값 보존)과 같은 강등 철학. 화면의 점유를 지우지 않는다.
- 바닥 ROI 가 없는 키는 frames 에서 제외 → 기존 skip 과 동일 동작.
- 새 변이 fetch 는 **`mutFetch`**(W1 규약). `webTokenWiring` 무회귀 확인.

**`buildFlatSlotRows` 시그니처 변경의 의미**: 기존에는 `judge` 주입 여부로 "오버레이와 목록이 같은 판정기를 쓰는가"가 갈렸다(주입을 빠뜨리면 조용히 갈렸다). 이제 둘 다 `state.occComputeByKey` **하나의 캐시**를 읽으므로 그 정합이 **구조적으로 보장**된다.

### 2.4 ★ W2 인계 항목에 대한 답 — 카메라를 움직이지 않는다

W2 는 "서버 잡으로 옮기면 브라우저의 `state.ptz` 가 부패한다(`syncPtzAfterJob` 책임이 함께 따라와야 한다)"를 인계했다.

**이번 경로는 카메라를 전혀 움직이지 않는다.** 근거:
- `handleJudgeOccupancy` 는 `deps` 를 **인자로 받지도 않는다**(`req`,`reply` 뿐) → `camera`/`ICameraClient` 에 도달할 수 없다.
- 호출 그래프상 `judgeOccupancy` → `geometry`/`polygon`/`onPlaceFilter` 뿐이며 전부 순수 함수다.
- 따라서 `syncPtzAfterJob` 책임이 따라오지 않는다. `test/viewerPtzSyncCoverage.test.ts` 의 **`NO_MOVE` 표에 등재**해 이 사실을 봉인했다(근거 문구까지 함께 기록).
- 다만 ①의 호출 지점인 `runLiveDetect` 는 **그 자체가** `/capture/detect` 로 카메라를 움직이며, 기존 `syncPtzAfterJob(null)` 호출 2곳(실패/성공)을 **그대로 두었다**. `refreshOccupancy()` 는 그 동기화 **뒤**에 들어간다.

---

## 3. 실행한 명령과 실제 출력

### 3.1 타입
```
$ npx tsc --noEmit
tsc exit=0
```
(중간에 5건 실패했고 전부 고쳤다 — ①`occupancyRoutes.test.ts` 의 `ToolsConfig` 를 `domain/types.js` 에서 import(실제 위치는 `config/toolsConfig.js`) ②`occupancyAnchor` 의 `detectByKey` 문자열 인덱싱 ③같은 파일 `map((v) => …)` 암시적 any ④`placeGlobalIdx` 의 `filter(Boolean)` 이 `undefined` 를 못 좁힘 → `flatMap` 으로 교체. **숨기지 않고 기록한다.**)

### 3.2 신규 테스트
```
$ npx vitest run test/occupancyJudgeParity test/occupancyRoutes
 ✓ test/occupancyJudgeParity.test.ts (32 tests) 9ms
 ✓ test/occupancyRoutes.test.ts (15 tests) 192ms
 Test Files  2 passed (2)
      Tests  47 passed (47)
```

### 3.3 기존 점유 테스트 — **무수정 green**
```
$ npx vitest run test/occupancyJudge test/computeOccupancy test/occupancyRegion test/occupancyRegionParity test/occupancyGeometryParity
 ✓ test/occupancyJudge.test.ts (11 tests) 6ms
 ✓ test/computeOccupancy.test.ts (15 tests) 8ms
 ✓ test/occupancyRegion.test.ts (20 tests) 10ms
 ✓ test/occupancyRegionParity.test.ts (10 tests) 11ms
 ✓ test/occupancyGeometryParity.test.ts (8 tests) 11ms
 ✓ test/occupancyJudgeParity.test.ts (32 tests) 12ms
 Test Files  6 passed (6)
      Tests  96 passed (96)
```

### 3.4 W1·W2 봉인 무회귀
```
$ npx vitest run test/rpcParity test/controlGate test/webTokenWiring test/tourJob test/tourRoutes
 ✓ test/webTokenWiring.test.ts (8 tests) 4ms
 ✓ test/tourJob.test.ts (17 tests) 13ms
 ✓ test/tourRoutes.test.ts (22 tests) 152ms
 ✓ test/controlGate.test.ts (19 tests) 178ms
 ✓ test/rpcParity.test.ts (14 tests) 253ms
 Test Files  5 passed (5)
      Tests  80 passed (80)
```

### 3.5 소비 테스트 4종 — 호출부만 수정·단정값 불변
```
$ npx vitest run test/boundaryCrossCheck test/finalizerParkingSlots test/occupancyAnchor.regression test/placeGlobalIdx
 Test Files  4 passed (4)
      Tests  66 passed (66)
```

### 3.6 전체
```
$ npx vitest run
 FAIL  test/placeRoiRuntimeInvariants.test.ts > … > 모든 주차면: 4점 + 유한 좌표
 FAIL  test/roiDbLoad.test.ts > loadRoiIntoDb — 정상 로딩(…) > preset_slotidx 는 …
 Test Files  2 failed | 270 passed (272)
      Tests  2 failed | 3396 passed (3398)
   Duration  18.50s
```
실패 2건 = **사전 실패 그대로**(무접촉). 통과 수 3349 → **3396**(+47 = 신규 32+15). **회귀 0.**

중간에 내 변경으로 실패한 것은 `captureRoutesShape` 1건 + `viewerPtzSyncCoverage` 1건뿐이며, **둘 다 그 테스트의 설계된 동작**(새 라우트에 선언을 강제)이다. §4-3.

### 3.7 완료기준 4 — 카탈로그 개수
임시 테스트로 실제 `buildServer` 인스턴스에 `GET /rpc/catalog` 를 inject 해 확인하고 **삭제**했다.
```
CATALOG COUNT = 74 | count field = 74
```
73 → **74** ✔ (occupancy 1개).
※ `METHODS.length` 는 73 이다 — `system.catalog` 는 표 전체를 알아야 해서 `src/rpc/routes.ts:23` 이 런타임에 얹는다(항상 `+1`). W2 의 73 과 정합한다.

---

## 4. 설계와 달라진 점 / 설계가 예측 못 한 것

| # | 설계서 | 실제 구현 | 이유 |
|---|---|---|---|
| 1 | (언급 없음) | `src/api/controlGate.ts` 면제목록 +1줄 | W1 이 인계에서 **명시적으로 지시**한 항목. 안 넣으면 W1 드리프트 테스트가 "읽기 메서드인데 게이트 대상"으로 먼저 실패한다(그게 설계 의도다) |
| 2 | "상수·`groundBand` 를 `onPlaceFilter` 에서 import" | 그렇게 했고, **`groundBand` 에 옵셔널 `ratio` 인자를 열었다**(기본값 동일) | 서버 `groundBand` 는 상수를 내부에서 읽어 `cfg.groundBandRatio` 오버라이드를 표현할 수 없었다. 그대로 두면 밴드 계산식(2줄)을 **복제**해야 하는데 그것이 정확히 리더 결정 Q2 가 금지한 것이다. 웹판(`occupancy.js:120`)은 **이미 같은 시그니처**라 오히려 파리티가 복원됐다. 기존 호출자 3곳 무영향, `occupancyGeometryParity`(기본 ratio 비교) green |
| 3 | 응답 `regions` 를 `buildOccupyRegionsBySlot` 로 생성 | `computeOccupancyRegions`(그 함수의 내부 구현)를 직접 호출해 `{idx,scale,polygon}` + **`overlapPairs` 까지** 반환 | `buildOccupyRegionsBySlot` 은 Map 으로 접으면서 `overlapPairs` 를 버린다. 그러면 웹의 "겹침 잔존 console.warn"이 **조용히 사라진다**. 동일성은 테스트로 고정했다(응답의 idx→polygon 사영 == `buildOccupyRegionsBySlot` 반환) |
| 4 | 호출점 3곳(③ = 프리셋 전환 시 캐시 없으면 1회) | 호출점 **4곳**(①검출 도착 ①'검출박스 삭제 ②ROI 로드 ③편집 커밋 funnel), 프리셋 전환 훅은 **넣지 않음** | 배치가 전 키를 채우므로 프리셋 전환 훅은 항상 캐시 히트라 죽은 코드다. 반대로 설계가 "편집 커밋"이라 뭉뚱그린 지점은 실제로 7개 함수였고 `markPlaceDirty` 라는 **단일 funnel** 이 존재해 1줄로 전부 덮었다 |
| 5 | zod 가 quad 3점 미만을 400 으로 거른다(§3.4) | zod 는 **구조만** 본다(길이·값범위 미검사) | 퇴화 입력(비4점·`w=0`·`plates:null`) 처리는 **판정 함수가 소유한 계약**이고 웹 기준변과 파리티로 봉인돼 있다. 400 으로 막으면 그 계약에 영원히 도달할 수 없고, 브라우저가 실제로 들고 있는 데이터(퇴화 rect 를 가진 차량)가 통째로 거부된다 |

### 4.1 `rpcParity` 의 `known` 목록 — 예측대로 무편집

`'/capture/slots'` 접두어에 걸려 통과했다. **W2 가 tour 3줄을 추가해야 했던 것과 대비되는, 설계가 경로를 고른 이유가 실제로 작동한 사례**다.

### 4.2 소비 테스트 단정값을 고치지 않았다는 것의 의미

`occupancyAnchor.regression` R6 은 "판정기 주입 → 전량 점유 / 미주입 → `[5,10,17]` 미점유"를 단정한다. 파라미터가 사라졌으므로 **"어느 판정식으로 채운 캐시를 넣는가"** 로 두 경로를 재현했다 — 판정식(`OccupancyJudge` vs `computeOccupancy`)도 단정값도 그대로다. `it` 제목만 파라미터 이름을 반영해 고쳤다(제목이 사라진 인자를 가리키면 거짓말이 된다). **단정값은 한 글자도 바꾸지 않았다.**

### 4.3 선언을 강제하는 테스트 2개가 실제로 작동했다

- `captureRoutesShape.test.ts`: 라우트 (method,url) 목록·**순서** 스냅샷. 신규 라우트 1줄을 등재.
- `viewerPtzSyncCoverage.test.ts`: app.js 가 부르는 모든 라우트에 이동 여부 분류를 강제. **`NO_MOVE` 로 분류**(근거 문구 포함). W2 §4.3 이 보고한 "소문자 `fetch\(` 정규식 사각"은 이미 `[Ff]etch\(` 로 고쳐져 있어 **`mutFetch` 로 나가는 내 라우트도 자동 수집됐다** — W2 가 별건으로 올린 사각은 해소된 상태다.

---

## 5. 성능 — 요청이 몇 회에서 몇 회가 됐나

| 상황 | 변경 전(웹 로컬 계산) | 변경 후(서버 배치) |
|---|---|---|
| 오버레이 리드로 1회 | 판정 1회(현재 프리셋) — **네트워크 0** | **0회**(캐시 읽기) |
| 슬롯 목록 렌더 1회 | 판정 `1 + P`회(현재 프리셋 + `buildFlatSlotRows` 가 전 프리셋 P개) — 네트워크 0 | **0회** |
| 검출 1회 실행 | 위 두 가지가 뒤이어 발생 | **HTTP 1회**(검출된 전 프리셋을 `frames[]` 로 접음) |
| 정밀수집 중 500ms 폴링(프레임 폴러) | 초당 2회 이상 판정 | **0회** |
| ROI 편집 1회(정점 드래그) | 드래그 중 매 mousemove 리드로마다 판정 | **드래그 종료 시 1회**(`markPlaceDirty` funnel) |

핵심 수치: **판정을 유발하는 웹 코드 지점 66(drawRoiOverlay) + 31(renderSlotList) → 실제 서버 요청을 내는 지점 4개**. 그리고 그 4개조차 프리셋마다 요청하지 않고 `frames[]` **1회**로 접는다(검출 3프리셋 기준 3요청 → 1요청).

순진하게 fetch 로 치환했다면 정밀수집 중 초당 2회 + 마우스 조작마다 요청이 나갔을 것이다 — **이것을 피한 것이 이번 단계의 본체**다.

---

## 6. 검증하지 못한 항목(정직 보고)

1. **라이브 브라우저 확인 미수행.** 13021 서버를 띄워 실제로 검출을 실행하고 오버레이의 **원·사다리꼴·`(점유)/(공차)` 뱃지가 이전과 동일한지 육안 확인하지 못했다.** 대체 검증: ①web↔src `toEqual` 파리티(값 동일) ②라우트 결과 == 웹 기준변 결과 ③`regions` == `buildOccupyRegionsBySlot` ④적재 shape 무변경 + 소비처 코드 무변경. **"화면이 같은가"는 라이브에서만 최종 확정**된다(검증자 인계 1순위).
2. **지연 체감 미측정.** 검출 도착 → 오버레이 표시 사이에 HTTP 왕복 1회가 새로 들어간다(로컬호스트라 수 ms 예상이지만 실측하지 않았다). 만약 체감된다면 설계 R7 의 후퇴 경로("`regions` 만 클라 계산")가 남아 있다 — `web/occupancyRegion.js` 는 그대로 있다.
3. **오류코드 4종 중 실측한 것은 `-32602`(INVALID_PARAMS) 하나뿐이다.** BUSY(-32001)·CONFLICT(-32005)·NOT_FOUND(-32002)·UNAVAILABLE(-32004)는 이 라우트에서 **발생할 수 없다**(잡·카메라·파일·DB 미접촉, `registerSlotRoutes` 는 무조건 등록). 발생 불가능한 경로에 에러 처리를 넣지 않았고 테스트도 만들지 않았다 — 지시에 있던 항목이므로 **"미구현"이 아니라 "해당 없음"임을 명시**한다.
4. **파리티 변이 검사 4건 중 2건이 검출되지 않았다**(tie-break `>`/`>=`, `pointInQuad` 의 `length<3` 가드). §2.1 에 이유와 함께 기록했다 — 두 경우 모두 웹·서버가 같은 식이라 실제로 갈릴 수 없는 지점이다. **숨기지 않는다.**
5. **`markPlaceDirty` 경유 호출이 드물게 2회 날 수 있다**: `loadPlaceRoi` 안에서 `norm.changed`(전역번호 재부여)가 참이면 `markPlaceDirty` → refresh, 이어서 로드 경로의 refresh 로 총 2요청. 부작용 0 인 읽기라 무해하며, 중복 제거를 넣는 것은 요청하지 않은 복잡도라 하지 않았다.
6. 워크트리 루트의 정체불명 `x.json`(untracked)은 W1·W2 보고 그대로 **건드리지 않았다**.

---

## 7. 다음 웨이브(W4 슬롯편집) 인계

- 신규 **변이** 라우트(`POST /mapping/slot`·`/mapping/slot/delete`)는 `controlGate` 가 deny-by-default 로 **자동 보호**한다 → `READONLY_POST_PATHS` 는 **건드리지 말 것**(넣으면 드리프트 테스트가 실패한다).
- 경로 `/mapping/slot*` 은 `known` 의 `'/mapping'` 접두어에 걸려 `rpcParity` **무편집 통과** 예정이다(이번에 `/capture/slots` 로 같은 원리를 실증했다).
- **새 라우트를 추가하면 반드시 2곳에 선언해야 한다**(테스트가 강제한다):
  1. `test/captureRoutesShape.test.ts` 의 `EXPECTED_ORDER` — captureRoutes 소속일 때만. `/mapping/*` 은 `server.ts` 소속이라 해당 없음.
  2. `test/viewerPtzSyncCoverage.test.ts` 의 `MOVES_CAMERA`/`NO_MOVE` — **app.js 가 부르는 라우트라면 무조건**. 슬롯편집은 카메라를 움직이지 않으므로 `NO_MOVE` 가 될 것이다.
- 웹의 새 변이 fetch 는 **`mutFetch`**(W1). 카탈로그는 74 → **76** 이 목표(slot 2개).
- `src/domain/occupancyJudge.ts` ↔ `web/occupancy.js` 파리티가 이번 선례다. W4 의 `artifactSlotEdit` 포팅도 **기준변은 web**, 입력은 `test/slotInsertEdit.test.ts:16 sampleArtifact()` 재사용, `toEqual` 깊은 비교 — 그리고 **변이를 넣어 판별력을 실측**할 것(공허한 green 방지).
