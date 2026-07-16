# 07. 구현 — 점유 매칭 앵커 교체(plate 중심 → 차량 접지밴드 argmax)

> 구현자(developer) 산출물. 2026-07-16. 입력: `06_architect_plan_anchor.md`(설계), `05_bug_diag_missing_region.md`(진단).
> 검증자·문서화 인계용. 아래 수치는 전부 **실행 실측**이다.

---

## 1. 변경 파일 (설계 §4 목록 8개 = 실제 8개, 이탈 없음)

| 파일 | 변경 요지 |
|---|---|
| `web/occupancy.js` | `judge` 재구성(설계 §2 의사코드 그대로). 1단계 = 차량 접지밴드 겹침 argmax 귀속(기존 2단계 기하 승격), 2단계 = 비점유 슬롯 한정 plate 중심 폴백(computeOccupancy 위임). `quadKey` 모듈 내부 헬퍼 추가(4점 수치 직렬화). 구 `:163-165`(plate-in-any-polygon 후보 제외)·`:188`(점유 슬롯 폴백 억제) **삭제**. 파일 헤더 주석을 새 알고리즘·앵커 근거로 갱신. 기하 함수·상수·생성자 **무변경** |
| `web/occupancy.d.ts` | `OccupancyJudgement.source`(= 번호 인식 여부) / `vehicleRect`(차량 귀속 행 공통) 주석 의미 갱신. **타입 형태 무변경** |
| `web/core.js` | `buildFlatSlotRows` 에 `judge?` 주입 옵션(전달 시 `judge.judge`, 미전달 시 기존 computeOccupancy 경로). jsdoc 갱신. `computeOccupancy` **무변경** |
| `web/core.d.ts` | `buildFlatSlotRows` args 에 `judge?` 추가(구조적 타입 — occupancy.d.ts import 없이) |
| `web/app.js` | `renderSlotList`(:895) 호출에 `judge: occupancyJudge` 1줄 + `updateLogicOccupancy`(:368) 알고리즘 설명 주석 1줄 갱신(설계 이탈 — §3 참조) |
| `test/occupancyJudge.test.ts` | **T7 재봉인**(파괴적 변경 — §5) |
| `test/fixtures/occupancyAnchor/` **신규** | `_qa_data_iter3/{place_roi, detect_cam1_p1~p3}.json` 무가공 동결(4개) |
| `test/occupancyAnchor.regression.test.ts` **신규** | A1~A7 + R1~R7 회귀 봉인(16 테스트) |

`web/occupancyRegion.js`·`computeOccupancyRegions`·서버(`src/`)·라우트·DB 스키마·UI(html) **무변경**(설계 §4 준수).

### 기하 신규 발명 0줄
`groundBand`/`rectCorners`/`convexIntersectionArea`/`polygonArea`/`pointInQuad` 전부 기존 것 재사용. `pointInQuad` 는 judge 에서 직접 참조가 사라져(구 :165 삭제) import 에서 제거 — **내 변경으로 고아가 된 import**(CLAUDE.md 규칙 3). core.js 의 export 자체는 유지(computeOccupancy 가 사용).

---

## 2. R1~R7 **수정 전 FAIL 실측** (위장 방지 절차)

회귀 테스트를 **먼저 작성 → 수정 전 구현에 실행**해 실제 FAIL 을 확인한 뒤 구현했다.
명령: `npx vitest run test/occupancyAnchor.regression.test.ts` (수정 전 워킹트리 = 앵커 교체 이전 `judge`).

```
Test Files  1 failed (1)
     Tests  11 failed | 3 passed (14)
```

| # | 수정 전 | 실패 내용(실측) |
|---|---|---|
| **R1** p1 실좌표 | **FAIL** | 점유 idx `[1,2,3,4,6,7]` ≠ 기대 `[1..7]` — slot5 소실 |
| **R2** p2 실좌표 | **FAIL** | slot10 소실(오귀속 10→9·9→8) |
| **R3** p3 실좌표 | **FAIL** | slot17 이 `source:'bbox'`(plate 아님) |
| **R4** 귀속 정확성 | **FAIL** | slot5 행 `vehicleRect` undefined(veh0 는 라벨 6 으로 표시 — 라벨 시프트) |
| **R5** 사다리꼴 1:1 | **FAIL** | `regions.length` **6** ≠ 기대 7 |
| **R6** buildFlatSlotRows | **FAIL** | judge 주입이 무시돼 `every(occupied)` = false |
| **R7** 최종화 스냅샷 | **FAIL** | 17행 전량 true 아님 |
| A1/A2/A4/A6 | **FAIL** | 오귀속·열끝 소실·폴백 중복·경합 메커니즘 |
| A3/A5/A7 | PASS | 강등 철학·S2 계약·결정성 — **구 구현에도 성립하던 성질**이라 수정 전 통과가 정상(판별력 없는 테스트임을 숨기지 않고 기록) |

→ **R1~R7 7건 전부 수정 전 FAIL 확인.** 수정 후 전량 PASS.

---

## 3. 설계 이탈 / 판단

| 항목 | 판단 |
|---|---|
| `app.js` "1줄만" 지시 → **2줄 변경** | `:368` 주석이 `"1단계 번호판(computeOccupancy 위임) → 2단계 비점유 슬롯 bbox 폴백"` 으로 **내가 바꾼 알고리즘을 직접 오설명**하게 되어 1줄 갱신. 인접 코드 개선이 아니라 변경된 동작의 서술 정정이므로 규칙 3 위반 아님으로 판단. 로직 변경 0. |
| `occupancy.js` 파일 헤더 주석 갱신 | 위와 동일 사유(2단계 판정 순서·bbox 폴백 서술이 사실과 반대가 됨). 앵커 교체 근거(시차)를 코드에 남겨 재발 방지. |
| `core.d.ts` 의 `judge?` 타입 | `occupancy.d.ts` 를 import 하면 d.ts 층에 역방향 의존이 생겨, 필요한 형태만 **구조적 타입**으로 선언. 설계 "`judge?` 추가" 범위 내. |
| `core.js` 의 `plates` union 변수 | judge 주입 시 미사용이 되어 **legacy 분기 안으로 인라인**(고아 변수 제거, 규칙 3). 동작 동일. |
| 그 외 | 설계 §2 의사코드·§3 시그니처 대조표 **그대로**. `computeOccupancy` 시그니처 무변경(논점 3), `buildFlatSlotRows` judge 주입(논점 4), 임계값(0.25/0.15) 불변(설계 §7-4). |

**임의 알고리즘 변경 없음** — 아래 §6 의 미예측 실패에 대해서도 신규 규칙을 추가하지 않고 리더에게 보고했다.

---

## 4. 검증 게이트 실측

```
d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent>
  npx tsc -p tsconfig.json --noEmit   → exit 0
  npx vitest run                      → Test Files 152 passed (152)
                                        Tests      1676 passed (1676)
```

| 항목 | 기준선 | 현재 | 증감 |
|---|---|---|---|
| 테스트 파일 | 151 | **152** | **+1** (`occupancyAnchor.regression.test.ts`) |
| 테스트 | 1660 | **1676** | **+16** (A1~A7 7 + R1~R3 3 + R4·R5·R5겹침·R5b·R6·R7 6) |
| 실패 | 0 | **0** | — |

기존 테스트 **삭제 0건**. 기존 파일의 테스트 **수 변화 0**(T7 은 개수 유지·단언 갱신).

---

## 5. 기존 테스트 영향 실측 (설계 §5 검토표 대조)

설계 영향도 예측과 **완전 일치**. 설계가 "무변경 통과" 로 예측한 파일 전부 실제 무수정 통과:

| 파일 | 설계 예측 | 실측 |
|---|---|---|
| `computeOccupancy.test.ts` | 무변경 통과 | ✅ 통과(함수 무변경) |
| `lpdFilterRegression.test.ts` | 무변경 통과 | ✅ 통과(S2 plate-only 점유는 2단계 폴백이 의미 보존) |
| `occupancyGeometryParity.test.ts` | 무변경 통과 | ✅ 통과(기하 무변경) |
| `placeGlobalIdx.test.ts` / `finalizerParkingSlots.test.ts` | 무변경 통과 | ✅ 통과(judge 미전달 기본 경로 유지) |
| `occupancyRegion.test.ts` | 무변경 통과 | ✅ 통과(occupancyRegion.js 무변경) |
| `occupancyJudge.test.ts` T1~T6·T8·T9·config | 무변경 통과 | ✅ 통과 |
| `occupancyJudge.test.ts` **T7** | 재봉인 필요(파괴적) | ⚠️ **의미 변경 — 아래** |

### 의미가 바뀐 기존 테스트: **T7 단 1건** (파괴적 변경, 설계 논점 3 예고분)

- **입력 불변**: plate 보유 차량 + plate 중심이 모든 폴리곤 밖(`plateAt(0.2, 0.9)`).
- **구 단언**: `{ idx:1, occupied:true, source:'bbox', vehicleRect:R_IN_S1 }` — "plate 를 못 쓰니 bbox 폴백".
- **신 단언**: `{ idx:1, occupied:true, source:'plate', center:{0.2,0.9}, plateQuad, vehicleRect:R_IN_S1 }`.
- **변경 사유(테스트 주석 아닌 본 보고서에 기록 — 지시대로)**: 이 케이스가 바로 **열 끝 차량 소실의 합성 축소판**이다. 시차로 plate 중심이 자기 슬롯 밖으로 밀린 차량을 구 구현은 `source:'bbox'` 로 처리했고, `app.js:371` 의 사다리꼴 모집단 필터(`source==='plate' && plateQuad`)가 이를 탈락시켜 p1 veh4·p2 veh2·p3 veh1 의 사다리꼴이 사라졌다. 새 의미에서 슬롯 귀속은 차량 접지가 담당하고 `source` 는 **번호 인식 여부**만 뜻하므로, 번호판을 읽은 이 차량은 `'plate'` 가 맞다. 구 T7 의 주장(=구 결함)을 무력화하지 않고 새 의미로 다시 봉인했다. 동일 계약을 A2 가 독립 봉인한다.
- 부수: plate 행에 `vehicleRect` 가 **additive** 로 추가되나 이를 금지하던 단언은 T1 뿐이고 T1 은 vehicles 없는 입력이라 그대로 통과(설계 예측대로).

---

## 6. ⚠️ 설계가 예측 못 한 실패 (리더 보고 완료 — 설계자 판단 대기)

설계 §6 R5 / §7 Goal ④ 는 3프리셋 전부 `overlapPairs=[]` 를 기대했다. **p2/p3 는 달성**(regions 6/4, overlapPairs=[], globalScale=4). **p1 은 regions 7 개(목표 달성) 이나 `overlapPairs=[[5,6]]`.**

### 원인 — 앵커가 아니라 **상류 recovered plate 의 차량 오귀속**(실측)

```
p1 plate 중심(idx별): 1:(223,759) 2:(525,742) 3:(820,724) 4:(1092,705)
                      5:(1348,678) 6:(1367,676) ← 18.8px 거리  7:(1782,649)

vehicles[6].plate.recovered = true
veh6 의 plate 중심(1367,676) ∈ veh0.rect(1069~1410px)  → true  ★옆차 판을 회수
veh6 의 plate 중심(1367,676) ∈ veh6.rect(1315~1619px)  → true
standalone plates[4](1559,674) ∈ veh6.rect → true / ∈ veh0.rect → false  ← veh6 의 진짜 판
```

줌 재시도(recovered)가 bbox 겹침 구간에서 **veh0 의 번호판을 veh6 것으로 회수**했다. 슬롯 귀속은 7/7 정확(설계 §1-1 주장 유효 — band argmax 는 무결)하지만, slot6 의 **사다리꼴 축 소스가 veh0 의 판**이라 5·6 사다리꼴이 같은 차 위에 겹쳐 서고 veh6 차체 위엔 안 선다. veh6 의 진짜 판(1559)은 slot6 이 이미 점유라 2단계 폴백이 쓰지 못한다. 구 구현에선 이 판이 다른 라벨에 붙어 증상이 가려져 있었다.

→ **층위가 다른 별개 결함**(서버측 `estimatePlateFromNeighbors` 계열 plate↔차량 귀속). 06 설계의 앵커 교체 범위 밖.

### 내 조치 (임의 변경 없음)

- 설계 §2 그대로 구현하고 **신규 규칙 추가 안 함**. ("배치 차량의 축 소스는 그 차량 rect 안의 plate 우선" 같은 규칙은 설계 개정 사항이라 합의 전 미착수.)
- R5 를 **사실대로 분해**: `regions 수 7/6/4`(전 프리셋, PASS) + `overlapPairs=[]`(p2·p3, PASS) + **R5b = p1 겹침, `it.fails` 로 분리 봉인**.
- `it.fails` 를 쓴 이유: 현재 실패를 숨기지 않고 **기대 계약(overlapPairs=[])을 코드에 남기며**, 상류가 고쳐지면 테스트가 통과해버려 `it.fails` 가 뒤집혀 **FAIL → 재방문 강제**. 결함을 정상으로 봉인하지 않는다.
- 리더에게 SendMessage 로 보고 완료(선택지 (a) 상류 별도 이슈 분리 / (b) judge 규칙 추가 = §2 개정).

**문서화(documenter) 인계 주의**: 이 건은 "수정 후에도 p1 사다리꼴 2개가 한 차에 겹쳐 보인다"는 **관측 가능한 잔존 증상**이다. 라이브 스샷 판정 시 열 끝 차(slot7)는 정상 복구되나 slot5/6 은 겹쳐 보인다.

---

## 7. 구현 노트 (검증자·문서화용)

### 새 알고리즘 (설계 §2 대비 구현 차이 없음)
1. **1단계** 차량 순회 → `groundBand(rect, 0.25)` → 슬롯별 `convexIntersectionArea/bandArea` argmax(strict `>` → 동률 시 앞 슬롯) → `ratio ≥ 0.15` 면 `bestByPos` 에 슬롯당 ratio 최대 1대만.
2. 배치 차량 → `v.plate` 의 `quadCentroid` 가 있으면 `source:'plate'`(+`center`/`plateQuad`/`vehicleRect`), 퇴화(null)면 `source:'bbox'` 강등. attached plate 좌표키를 `placedPlateKeys` 에 등록.
3. **2단계** 폴백 후보 = `detect.plates` 중 `placedPlateKeys` 미포함분(standalone) ∪ 미배치 차량(임계 미달·경합 패배)의 plate → **비점유 슬롯에만** `computeOccupancy` 적용.
   - `computeOccupancy` 가 입력 폴리곤 **순서를 보존**하므로 `openPos[k]` 역매핑으로 원위치 복원(설계의 `posOf(r.idx)` 를 인덱스 배열로 단순화 — idx 조회 불요, 동작 동일).
4. **종료·결정성**: 고정 2패스, 난수·상태 없음. 같은 입력 → 같은 출력(A7 봉인).

### 좌표 동등성(`quadKey`)
서버가 같은 quad 를 `plates[]` 와 `vehicles[].plate` 양쪽에 직렬화하므로 수치가 정확히 같다(JSON 왕복 후 참조 동등성 불가). p1 실측: attached 5 + recovered 2 + standalone 1 = plates[] 6 / vehicles 7 → **좌표키 제외가 실제로 동작함을 A4 가 봉인**(동수치 사본 입력).

### 관측 가능한 동작 변화 (문서화 필수 — 설계 §8)
- **DB `parking_slots.occupied` 값 교정**: p1 기준 구 `[1,2,3,4,6,7]` → 신 `[1..7]` 전량 true(R7 봉인). 스키마·와이어 계약은 무변경이나 **구 run 과 신 run 의 점유 이력이 불연속**이 될 수 있다.
- **뷰어 목록 뱃지**: `buildFlatSlotRows` 에 judge 주입 → 목록이 오버레이와 정합(구: 목록만 plate 중심 기준이라 불일치).
- **오버레이**: 열 끝 3슬롯(p1 slot7·p2 slot8·p3 slot17)에 사다리꼴 신규 표시, p3 idx17 은 주황 '번호미인식' 원 → 사다리꼴 승격.
- **하위호환 경로 잔존 결함**: `buildFlatSlotRows` judge 미전달 시 구 plate-중심 경로 유지(R6 이 구 결과 `[5,10,17]` 미점유를 명시 봉인). 실소비처(app.js)는 주입하며, d.ts 주석에 하위호환용임을 명시.
