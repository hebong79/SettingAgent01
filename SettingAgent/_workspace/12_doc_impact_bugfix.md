# 12. 영향도 분석 — 점유판정 시차앵커(1층) + plate→vehicle 판배정(2층) 수정

> documenter 산출물. 2026-07-16 20:39.
> 05~11 문서를 베끼지 않고 **최종 구현 기준**으로 `grep`/`Read`/`git diff` 로 직접 재검증했다. 사실이 문서 서술과 어긋나면 코드를 신뢰하고 아래 각 절에 명시한다(어긋난 곳 없음 — 결론에서 재확인).

---

## 1. `web/occupancy.js` `OccupancyJudge.judge` 의미론 변경의 파급

### 1-1. 직접 소비처 (실물 확인)

| 소비처 | 확인 방법 | 영향 |
|---|---|---|
| `web/app.js:369` `updateLogicOccupancy` | `grep -n "occupancyJudge.judge" web/app.js` | 뷰어 오버레이(원/사다리꼴) 소스. 열 끝 슬롯 신규 표시, 오귀속 소멸 |
| `web/app.js:895-899` `renderSlotList` → `buildFlatSlotRows({..., judge: occupancyJudge})` | `git diff web/app.js` L899 | 슬롯 목록 뱃지가 오버레이와 **같은 판정기**로 정합(과거엔 목록만 구 `computeOccupancy` 를 썼음) |
| `web/app.js:1961-1967` `buildFinalizeOccupancy` → `capFinalize()`(1988행) | `Read` 로 확인 — `state.occComputeByKey[key].spaces[].occupied` 를 그대로 `{idx,occupied}` 로 투영해 `POST /capture/finalize` 전송 | **최종화 시 서버 DB(`parking_slots.occupied`)에 기록되는 값이 교정된다.** 와이어 계약(`{idx,occupied}`)·서버 스키마는 무변경이지만 **값 자체가 달라지는 관측 가능한 동작 변화**다(R7 봉인: p1/p2/p3 17행 전량 true, 구현 전엔 slot5·10·17 이 false) |

### 1-2. `buildFlatSlotRows` 의존성 주입 경로 (`web/core.js:598`)

`core.js` → `occupancy.js` 역방향 import 를 피하려 `judge?` 를 **구조적 타입**으로 주입받는다(`web/core.d.ts` diff 확인 — `judge?: { judge(...): ... }`). 실물 소비처는 `web/app.js:899` 한 곳뿐이며 실제로 `judge: occupancyJudge` 를 넘긴다. `judge` 미전달 시 구 `computeOccupancy`(plate 중심) 경로로 **하위호환 유지**되며, 이 경로는 여전히 시차 오귀속 결함을 담고 있다(R6 이 `legacy.filter(...).map(...)` 로 `[5,10,17]` 미점유를 명시 봉인 — 하위호환 경로의 결함 잔존이 **테스트로 못박혀 있다**).

`buildFlatSlotRows` 를 소비하는 테스트 3벌을 실물 확인:
- `test/placeGlobalIdx.test.ts` — `judge` 를 넘기지 않는 호출만 존재(299/310/320/334행 등) → 전부 **기본(하위호환) 경로**를 검증 → 이번 변경으로 회귀 위험 없음(computeOccupancy 자체 무변경).
- `test/finalizerParkingSlots.test.ts:313` — 마찬가지로 `judge` 미전달 → 무영향.
- `test/occupancyAnchor.regression.test.ts` R6 — `judge` 주입 경로와 미전달 경로를 **동시에** 봉인(신규).

### 1-3. `computeOccupancy(floorPolygons, plates)` 자체 — 무변경 확인

`git diff web/core.js` 로 재확인: 함수 시그니처·판정 로직(`pointInQuad`) 은 그대로이며, occupied 매칭 시 반환 행에 `plateQuad` 필드가 추가된 것뿐이다(이 필드는 **직전 세션**(사다리꼴 표시 기능)에서 이미 도입된 것으로, 본 세션의 `git diff` 범위(`+32/-24`, computeOccupancy 부분은 `+7/-5`)에 포함되어 있으나 코드 서술상 사다리꼴 기능과 공유되는 additive 필드다. `test/computeOccupancy.test.ts`는 이 필드를 이미 전제하고 있어 본 세션 기준 무변경 통과). `test/lpdFilterRegression.test.ts` 도 이 함수를 직접 호출해 필터 불변·S2(plate-only 점유 유지) 계약을 주장하는데, 함수가 안 바뀌었으므로 **무수정 통과**(vitest 재실행으로 확인).

---

## 2. `src/setup/plateMatch.ts` 소비처 전부 + `src/capture/detectPipeline.ts` 소비처

`grep -rn "matchPlatesToSlots" src/` 로 전수 확인(코드 내 호출 3곳 + 주석 참조 1곳):

| 소비처 | 실물 위치 | 영향 |
|---|---|---|
| `src/capture/detectPipeline.ts:288` `runDetect` | 검출 파이프라인 본 호출 — base 매칭 결과(`matched`)가 줌 재시도 진입 여부를 결정 | 그리디 배정으로 **재시도 진입 차량 수가 감소**(p1: veh6 재시도 소멸, p2: veh5 재시도 소멸 → 카메라 왕복 각 −1회). 재시도 루프 내부에는 별도로 `DUP_EPS=0.03` 중복 가드가 추가됨(§3 참조) |
| `src/capture/onPlaceFilter.ts:82` `filterPlatesOnPlace`(A)귀속 분기 | `detectPipeline.ts:295` 주석 "동일 입력·동일 결과" 를 실물 확인 — `detectPipeline` 이 필터링 전 `matchPlatesToSlots` 를 1회, `filterPlatesOnPlace` 내부가 **같은 함수를 결정적으로 재호출**해 동일 결과를 얻는다(부작용 없는 순수 함수라 이중 호출이 안전) | attached 판 집합이 달라진다(그리디는 폐기하지 않으므로 attached 는 **증가만 가능**). (B) 주차면 분기가 하한을 보장해 `kept` 는 이론상 비단조지만(구버전 attached 판이 그리디에서 미배정+폴리곤 밖이면 신규 드롭 가능), **동결 실측 데이터에는 해당 케이스가 없다**(09 설계 §6, 미확인 리스크로 명시) |
| `src/setup/SetupOrchestrator.ts:218` `detectPlates` | `Read` 로 확인 — `matchPlatesToSlots(built, plates)` 결과를 셋업 아티팩트에 저장, 실패해도 셋업을 막지 않음(`warnings.push`, throw 없음) | **DB/셋업 아티팩트에 저장되는 슬롯별 번호판 prior 좌표가 교정된다**(관측 가능한 동작 변화). 스키마·경로 무변경. 파생 데이터이므로 **마이그레이션은 불요**하나, 구 아티팩트는 구 오배정을 담고 있을 수 있어 **배포 후 셋업 1회 재실행이 운영 절차로 권장**된다(미수행 — §알려진 제약 참조) |
| `src/capture/Aggregator.ts:276` | `git diff` 로 확인 — **주석 1줄만 변경**(코드 동일) | 코드 영향 **0**. 다만 이 줄이 구현하는 규칙("번호판 대표 중심 ∈ vehicle 대표 ROI + 겹침 최대")은 이제 `plateMatch.ts` 의 그리디와 **다른 규칙**이 됐다(독립 복제 구현이 갈라짐) — 캡처 클러스터링 경로의 별도 이슈로 문서화됨, 코드 미착수 |

`DetectPlate`/`DetectVehicle`/`DetectResult` 응답 shape 는 `git diff` 확인상 필드 추가·삭제가 없어(값만 바뀜) **와이어 계약 무변경**.

---

## 3. `src/capture/detectPipeline.ts` 중복 가드의 파급

`git diff` 로 확인한 변경은 함수 시그니처를 건드리지 않는 내부 로직 추가(`center`/`quadBoundingRect` import, `DUP_EPS` 모듈 상수, 재시도 루프 내 거리 검사)뿐이다.

- **루프 상한 불변**: 가드가 발동해도 `continue` 로 다음 `zoomFactor` 를 시도할 뿐 `requestImage` 호출 횟수 상한(`zoomFactors.length=4` + base 1회 = 5회)은 그대로다 — `test/detectPipeline.test.ts` G1 이 "5회, plate undefined" 로 이를 직접 봉인.
- **가드 발동 시 실패 모드**: `plate:undefined` → 1층 `OccupancyJudge` 가 `source:'bbox'` 로 강등(점유 자체는 접지밴드가 유지, 사다리꼴만 미생성) — 05 원결함(점유+사다리꼴 동시 소실)으로의 회귀가 **아니다**. 옆차 판으로 만든 틀린 사다리꼴보다 나은 실패 모드.
- 기존 `detectPipeline.test.ts` 31건은 가드 조건(이미 배정된 판과 ε 이내)에 해당하는 시나리오가 없어 **무수정 통과**(vitest 재실행 확인: 152 files 전체 그린).

---

## 4. 기존 테스트 영향 실측 (의미 변경분)

### 4-1. `test/occupancyJudge.test.ts` T7 — 파괴적 의미 변경

`grep -n "T7" test/occupancyJudge.test.ts` → 117행 1건. `Read` 로 확인한 현재 단언: "plate 중심이 모든 폴리곤 밖인 plate 보유 차량 → 접지 슬롯 점유 + `source:'plate'`". 구현 전에는 이 케이스가 `source:'bbox'` 였다(1층 §2-3 참조). **테스트 개수 변화 없음**(같은 자리 재봉인) — `git diff test/occupancyJudge.test.ts` 는 `+14/-... ` 규모의 국소 diff로 확인됨.

### 4-2. `test/lpdFilterRegression.test.ts:325` — 서술 유효범위 축소 (테스트 코드 무수정)

`Read` 로 325행 부근을 확인: "상류 `matchPlatesToSlots`: 검출 1건 단위 경쟁 → 진 번호판은 **드롭**된다" 는 서술이 있고, 그 아래(332행경) 는 단일 차량(PARKED) 픽스처로 TRUE/NOISE 완전포함 동률에서 TRUE 유지·NOISE 드롭을 봉인한다.

**의미 변화**: 그리디 배정 후 이 서술은 "**차선 후보 슬롯이 없을 때만** 드롭"으로 좁아졌다 — 다중 슬롯 동률에서는 이제 드롭이 아니라 차선 배정이 된다(2층 수정의 본체). 그 픽스처는 슬롯이 1개뿐이라(차선 후보 없음) 서술이 **여전히 참**이므로 재봉인이 불요했다. 이 축소된 유효범위는 **테스트 코드가 아니라 서술의 함의**만 바뀐 것이며, 새로 생긴 성질(다중 슬롯 차선 폴백)은 `plateMatch.test.ts` N4 가 **별도로** 봉인한다. `npx vitest run test/lpdFilterRegression.test.ts` 재실행으로 **무수정 통과**를 재확인했다.

### 4-3. 그 외

`test/computeOccupancy.test.ts`·`test/occupancyGeometryParity.test.ts`·`test/placeGlobalIdx.test.ts`·`test/finalizerParkingSlots.test.ts`·`test/occupancyRegion.test.ts`·`test/onPlaceFilter.test.ts`·`plateMatch.test.ts` 기존 4건·`detectPipeline.test.ts` 기존 31건 — 전부 **무수정 통과**(전체 게이트 `152 files / 1686 tests` 로 일괄 재확인, 개별 파일 삭제·스킵 0건).

---

## 5. 성능

| 변경 | 복잡도 | 실측/판단 |
|---|---|---|
| `OccupancyJudge.judge` 1단계 승격 | O(V·S·k) (V=차량, S=슬롯, k≤8 클립 정점) | 기존 2단계 폴백과 **동일 차수**(기하 재사용, 신규 알고리즘 없음). 프리셋당 V,S ≤ ~30 → 마이크로초 대, 3fps 렌더 루프 무풍 |
| `matchPlatesToSlots` 전역 그리디 | O(P·S) 쌍 생성 + O(K log K) 정렬(K≤P·S≤~1600) | 기존 O(P·S) 판별 argmax 와 실질 동급. on-demand 호출(검출·셋업)이라 저빈도 |
| `detectPipeline` 재시도 가드 | O(재시도 횟수) 상수 비교 추가 | 무시 가능. 카메라 호출 수는 **감소 또는 동일**(재시도 진입 차량 감소분 − 가드로 인한 추가 호출 0) |

전체적으로 성능 저하 요인 없음 — 오히려 재시도 감소로 카메라 왕복이 줄어드는 방향.

---

## 6. 앞선 사다리꼴 기능(`web/occupancyRegion.js`)과의 상호작용 — 무변경 확인

`git diff --stat` 결과 `web/occupancyRegion.js`·`web/occupancyRegion.d.ts`·`test/occupancyRegion.test.ts` 는 **modified(M) 목록에 없음**(untracked 상태로, 이전 세션에서 만들어진 뒤 이번 세션 동안 손대지 않았음). `web/app.js` 의 `computeOccupancyRegions` 호출부(369-380행대)도 이번 세션 diff 에 포함돼 있으나, 이는 **1층 앵커 교체로 인해 사다리꼴 모집단(plate 점유 행)이 바뀐 결과를 그대로 흘려보내는 배선**일 뿐 `occupancyRegion.js` 내부 알고리즘(`plateAxes`/`buildTrapezoid`/`clampToUnit`) 은 호출되지 않고 변경도 없다.

상호작용은 **입력 모집단 확대**로 요약된다: 1층 수정 전에는 `rows.filter(o => o.source==='plate' && o.plateQuad)` 가 열 끝 소실분만큼 적은 모집단을 냈고(p1 6/7), 수정 후에는 전량(7/7)을 낸다 — R5(신규 회귀 테스트)가 이를 `regions.length` 로 직접 봉인한다. 2층 수정은 이 모집단의 **원소 중 하나(veh6 슬롯6)의 `plateQuad` 값 자체를 교정**해 겹침(overlapPairs)을 없앴다(R5b). `computeOccupancyRegions` 함수 자체의 겹침 회피 이진탐색·클램프 로직은 이번 세션에서 **한 줄도 수정되지 않았다**.

---

## 7. 결론 — 어긋난 점 유무

앞선 05~11 보고서의 영향도 서술을 코드로 재검증한 결과 **어긋난 부분은 발견되지 않았다.** 소비처 목록(`buildFlatSlotRows` 3개 테스트, `matchPlatesToSlots` 3개 실호출 + 1개 주석, `DUP_EPS` 가드 위치, `Aggregator.ts:276` 주석 전용 변경, T7/lpdFilterRegression:325 의미 변경 범위, `occupancyRegion.js` 무변경)는 전부 `grep`/`Read`/`git diff`/vitest 재실행으로 실물 대조를 마쳤다.

**핵심 결론**:
1. 두 층 모두 **와이어 계약·DB 스키마·라우트 무변경**이지만 **기록되는 값 자체가 교정**된다 — DB `parking_slots.occupied`(1층, `buildFinalizeOccupancy` 경로 실물 확인) 및 셋업 아티팩트의 번호판 prior 좌표(2층, `SetupOrchestrator.ts:218`)가 그 대상. 두 값 모두 배포 시점 이후에는 셋업/최종화 재실행 전까지 구 결함을 담은 상태로 남는다.
2. `buildFlatSlotRows` 의 `judge` 미주입(하위호환) 경로는 **의도적으로 구 결함을 유지**한다(R6 이 이를 테스트로 못박음) — 향후 신규 소비처를 추가할 때 이 경로를 쓰면 회귀가 재발할 수 있음을 주의해야 한다.
3. 성능·기존 테스트·사다리꼴 기능 어느 쪽에도 부정적 영향이 실측되지 않았다(전량 무수정 통과, 152 files/1686 tests, tsc exit 0 — documenter 독립 재실행 포함 3회 재현).
