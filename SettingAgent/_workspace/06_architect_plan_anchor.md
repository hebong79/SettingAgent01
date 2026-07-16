# 06. 설계 — 점유 매칭 앵커 교체: plate 중심 → 차량 접지밴드 argmax (버그 근본 수정)

> 설계자(architect) 산출물. 2026-07-16.
> 사실 근거: `05_bug_diag_missing_region.md`(실측 진단) + **본 설계 단계에서 실행한 추가 실측**(§1-1, 아래 로그는 실제 실행 결과다).
> 실행 모드: **B. goal/loop** — 성공 기준이 관찰형(3프리셋 점유수·오귀속·사다리꼴 1:1).

---

## 0. 근본 원인 재확인과 수정 목표

`web/core.js:480` — plate↔슬롯 매칭이 "번호판 중심점 ∈ 바닥 폴리곤" 단 하나다. 번호판은 지면 위(~0.5m)에 떠 있고 바닥 ROI 는 지면 발자국이라, 시차로 plate 중심이 항상 화면 위(원경)로 10~33px 밀린다. 원경 폴리곤 y두께(27~37px)가 이를 못 흡수해 **열 중간 차는 이웃 슬롯 오귀속**(p1 5→6·6→7, p2 10→9·9→8, p3 15→16), **열 끝 차는 받아줄 슬롯이 없어 소실**(p1 slot7, p2 slot8, p3 slot17)된다. 여기에 `occupancy.js:165/188` 의 폴백 제외 조건이 구제까지 막는다(진단 §5).

**수정 목표**: 슬롯 귀속의 앵커를 번호판(공중)에서 **차량 접지밴드(지면 동일 평면 → 시차 0)** 로 옮기고, plate 는 **번호 인식 여부 표시 + 사다리꼴 축 제공** 역할로 재정의한다. 성공 기준: 3프리셋 전부 점유 슬롯 수 = 실제 차량 수(7/6/4), 오귀속 0, 사다리꼴 = plate 보유 차량과 1:1.

---

## 1. 논점 결정 (1~8, 각각 근거 명시)

### 논점 1 — 앵커 정의: **접지밴드 겹침 argmax 로 통합** (접지중심 단일점 기각)

**결정**: 기존 `occupancy.js` 2단계(bbox 폴백)가 이미 쓰는 **접지밴드(bbox 하단 25%) × 슬롯 폴리곤 겹침비 argmax**(`groundBand`/`rectCorners`/`convexIntersectionArea`, 임계 `ON_PLACE_MIN_OVERLAP=0.15`)를 **1단계 주 매칭기로 승격**한다. 접지중심 `(x+w/2, y+h)` 단일점 + `pointInQuad` 는 기각.

**근거(본 설계 단계 실측 — `_qa_data_iter3` 라이브 픽스처에 뷰어 실물 모듈을 그대로 물려 실행)**:

| 프리셋 | 차량 | band argmax 슬롯(ratio, 2위) | 접지중심 pointInQuad | plate중심(현행) |
|---|---|---|---|---|
| p1 | veh0 | **5** (0.765, 2위 6=0.130) | 5 | 6 ★오귀속 |
| p1 | veh1 | **1** (0.940) | **null ← 진단 13/16 의 불일치 1** | 1 |
| p1 | veh2~3,5 | 4/3/2 (0.86~0.97) | 일치 | 일치 |
| p1 | veh4(열끝) | **7** (0.644, 2위 6=0.193) | 7 | **null ★소실** |
| p1 | veh6 | **6** (0.803) | 6 | 7 ★오귀속 |
| p2 | veh0,3,4 | 13/12/11 (0.77~0.82) | 일치 | 일치 |
| p2 | veh1 | **10** (0.649, 2위 11=0.199) | 10 | 9 ★오귀속 |
| p2 | veh2(열끝) | **8** (0.640) | 8 | **null ★소실** |
| p2 | veh5 | **9** (0.853) | 9 | 8 ★오귀속 |
| p3 | veh0 | **15** (0.686, 2위 14=0.288) | 15 | 15 |
| p3 | veh1(열끝) | **17** (0.647, 2위 16=0.269) | 17 | **null ★소실** |
| p3 | veh2 | **14** (0.560) | **null ← 불일치 2** | 14 |
| p3 | veh3 | **16** (0.558, 2위 15=0.353) | **15 ← 불일치 3(오귀속)** | 16 |

- **band argmax: 17대 전부(7/6/4) 자기 슬롯 정확 귀속. 점유 집합 = [1..7]/[8..13]/[14..17] 완전 일치.**
- 진단의 "16대 중 13대"는 **접지중심 pointInQuad** 기준이었고, 불일치 3건(p1 veh1·p3 veh2 = 폴리곤 밖, p3 veh3 = 15 오귀속)은 **argmax 가 전부 교정**한다 — 겹침 최대 슬롯 선택은 점 포함을 요구하지 않아 경계 0~37px 이탈에 강건하다. → **argmax 가 단일점 방식을 엄격 우세**.
- 승자 ratio 최솟값 0.558(임계 0.15 의 3.7배), 1·2위 최소 격차 0.205(p3 veh3) — 여유 충분.
- **코드가 줄어든다**(규칙 2): 신규 기하 0줄. 기존 2단계 argmax 루프가 1단계로 승격되고, plate-중심 1단계와 폴백 제외 조건(`occupancy.js:163-165`)·점유 억제 조건(`:188`) — 진단 §5-③ 의 구제 실패 지점 둘 — 이 **삭제**된다. 진단의 D(폴백 정합)는 별도 완화가 아니라 **통합으로 소멸**한다.

**`source` 재정의**: 슬롯 귀속은 차량 접지가 담당한다. `source` 는 **번호 인식 여부 플래그**가 된다 — `'plate'` = 귀속 차량이 번호판 보유(사다리꼴 축 제공) 또는 폴백 plate 매칭, `'bbox'` = 차량 귀속됐으나 번호판 미인식, `null` = 빈 슬롯.

### 논점 2 — standalone plate: **비점유 슬롯 한정 plate-중심 폴백으로 유지** (기능 축소 기각)

**결정**: 차량에 귀속 안 된 plate 는 **2단계 폴백**으로 기존 `computeOccupancy`(plate 중심 pointInQuad)를 **1단계에서 비점유로 남은 슬롯에만** 적용한다. 후보 = `detect.plates` 중 **배치된 차량의 attached plate 를 좌표 동등성으로 제외**한 것 ∪ **미배치 차량**(1단계 탈락)의 plate.

**근거**:
- **standalone plate 는 실데이터에 실재한다**: p1 라이브 픽스처의 `plates[]` 6장 중 1장(quad TL x≈0.8007)은 어느 `vehicles[].plate` 와도 불일치 — 차량 미귀속 검출이 실제 발생한다. 또 서버 `onPlaceFilter.ts` (B)항과 `lpdFilterRegression.test.ts S2` 가 "VPD 가 주차차를 놓쳐도 폴리곤 안 번호판이 점유를 유지한다"를 명시 봉인하고 있다 — (a) 매칭 제외는 이 계약 회귀다.
- 폴백을 **비점유 슬롯 한정**으로 좁히면 현행 결함(시차 오귀속)의 발현 면적이 엄격히 줄어든다: 실차가 있는 슬롯은 1단계가 먼저 점유하므로, 이웃 차 plate 가 새어 들어와도 무시된다. 잔존 위험은 §9 참조.
- attached plate 중복 제거는 **좌표 동등성**(quad 4점 수치 직렬화 키)으로 한다 — 서버가 같은 quad 를 `plates[]` 와 `vehicles[].plate` 양쪽에 직렬화하므로 수치가 정확히 같다(참조 동등성은 JSON 왕복으로 불가). recovered plate(줌 재시도 복원분)는 `plates[]` 에 없어 중복 자체가 없다(p1 실측: attached 5 + recovered 2 + standalone 1).
- 미배치 차량의 plate 를 폴백에 포함하는 이유: 임계 0.15 미달·argmax 경합 패배 차량도 plate 중심이 슬롯 안이면 현행처럼 점유를 만든다 — 기존에 맞던 케이스의 회귀 방지(논점 8).

### 논점 3 — `computeOccupancy` 시그니처: **무변경** (파괴적 변경 없음)

**결정**: `computeOccupancy(floorPolygons, plates)` 는 시그니처·의미 모두 그대로 두고 **폴백 매칭기로 강등**한다. 진단 §6-A 가 언급한 "`detect{vehicles,plates}` 로 시그니처 변경"은 채택하지 않는다 — 차량 매칭은 `OccupancyJudge` 가 이미 소유한 기하로 judge 내부에서 수행하면 되고, computeOccupancy 를 바꾸면 소비처 4곳·테스트 3벌이 파괴되는 반면 이 안은 **0곳** 파괴다.

| 소비처 | 영향 |
|---|---|
| `occupancy.js:149` judge 1단계 | judge 재구성으로 호출 위치가 2단계 폴백으로 이동(같은 함수·같은 계약) |
| `core.js:608 buildFlatSlotRows` | 논점 4 참조 — judge 주입 옵션 추가, 기본 경로는 현행 유지 |
| `test/computeOccupancy.test.ts` | **무변경 통과** (함수 무변경) |
| `test/lpdFilterRegression.test.ts` | **무변경 통과** — 이 테스트의 주장(필터 불변·S2 plate-only 점유)은 computeOccupancy 직접 호출 기준이며 함수가 안 바뀐다 |
| `test/occupancyJudge.test.ts` | **T7 만 의미 변경으로 갱신 필요**(파괴적 — 아래 명시), 나머지 T1~T6·T8·T9·config 는 무변경 통과(§6 검토표) |

**파괴적 변경은 `OccupancyJudge.judge` 의 *의미* 하나다(시그니처·행 shape 는 무변경)**: 귀속 기준이 plate 중심 → 차량 접지로 바뀌므로, "plate 보유 차량 + plate 중심이 폴리곤 밖"(구 T7)이 `source:'bbox'` → **`source:'plate'`(vehicleRect 동반)** 로 바뀐다. 이것이 바로 p1 열끝 차(veh4) 수정의 본체이며, 숨기지 않고 T7 을 새 의미로 다시 봉인한다. 또 plate 행에 `vehicleRect` 가 **추가로** 붙는다(additive — 기존 단언 중 이를 금지하는 것은 T1 뿐인데 T1 은 vehicles 없는 입력이라 그대로 통과).

### 논점 4 — 서버/DB 계약: **스키마 무변경, 기록 값은 교정됨(관측 가능한 동작 변화)**

- `app.js buildFinalizeOccupancy(:1961)` 는 계속 `{idx, occupied}` 만 보낸다 — **와이어 계약·서버·DB 스키마 변경 없음**.
- 그러나 **값의 의미론이 교정**된다: 현행은 p1 에서 `[1,2,3,4,6,7]`(slot5 누락, 라벨 시프트) 을 DB `parking_slots.occupied` 에 기록했다. 수정 후 `[1..7]` 전량 true. **이는 버그 교정이지만 최종화 결과 DB 값이 달라지는 관측 가능한 변화다** — 기존 run 과 신규 run 의 점유 이력이 불연속이 될 수 있음을 문서화(documenter)에 명시한다.
- `buildFlatSlotRows`(뷰어 평면 목록)도 동일 판정기를 써야 목록 뱃지와 오버레이가 정합한다. core.js 가 occupancy.js 를 import 하면 역방향 순환(occupancy.js→core.js)이 생기므로, **의존성 주입**으로 푼다: `buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey, judge? })` — `judge`(OccupancyJudge 인스턴스) 전달 시 `judge.judge(floorPolys, detect)` 로 점유 산출, 미전달 시 기존 computeOccupancy 경로(하위호환 — `placeGlobalIdx.test.ts`/`finalizerParkingSlots.test.ts` 무변경 통과). app.js:895 호출부에 `judge: occupancyJudge` 한 줄 추가.

### 논점 5 — 사다리꼴 접속: **자연 연결, 배선 무변경**

1단계에서 슬롯을 차지한 차량의 `v.plate.quad` 를 그 행의 `plateQuad` 로 싣는다(`vehicles[].plate` 연결이 이미 존재). `app.js updateLogicOccupancy(:371-372)` 의 모집단 필터 `source==='plate' && plateQuad` 는 **그대로** 유효하다 — 사다리꼴 축은 여전히 그 차량의 plate quad 에서 나온다(R3 유지). 소실됐던 열끝 3대가 모집단에 들어오므로 사다리꼴이 차량과 1:1 이 된다. `computeOccupancyRegions`/`plateAxes`/`drawOccupancyOverlay` 무변경(진단이 무결 확인).

### 논점 6 — 다:다 규칙: **차량당 argmax 슬롯 1개 + 슬롯당 argmax 차량 1대 (기존 규칙 계승)**

- 차량은 자기 **최대 겹침 슬롯 1개에만** 지원(strict `>` 비교 → 동률 시 배열 앞 슬롯, 기존 tie-break 그대로) — 한 차량이 두 슬롯을 점유하는 일은 구조적으로 불가.
- 슬롯은 지원 차량 중 **ratio 최대 1대**만 채택(`bestByPos` argmax, strict `>` → 동률 시 먼저 온 차량, 기존과 동일). 경합 패자는 "미배치"로 남고 그 plate 는 2단계 폴백 후보가 된다.
- 결정성: 입력 순서 고정(vehicles 배열 순·floorPolygons 배열 순) + strict 비교 tie-break — 같은 입력이면 항상 같은 출력. 난수·상태 없음.

### 논점 7 — `source='bbox'` 의 새 의미: **"차량 접지 귀속 + 번호판 미인식"**

통합 후 bbox 폴백이라는 별도 단계는 없다 — 1단계가 차량을 귀속시키고 plate 유무가 source 를 가른다. 기존 "bbox 폴백" 과 실질 동의어이며(차량은 잡혔는데 번호를 못 읽음), **사다리꼴 미생성 규칙 유지**(축 소스인 plate quad 가 없음 — 01 설계 §2-5 그대로), 주황 원 + '번호미인식' 표시 유지. plate quad 가 퇴화(quadCentroid null)면 'bbox' 로 강등(강등 철학, throw 금지).

### 논점 8 — 회귀 위험: **실측으로 소거 + 실좌표 픽스처 봉인**

- "16대 중 13대"의 불일치 3대는 §1-1 실측으로 원인·교정을 확정했다(접지중심 단일점의 경계 이탈 — argmax 채택으로 소거). **이 설계의 최대 리스크는 설계 단계에서 이미 해소 확인됨.**
- 기존에 맞던 11건(plate 중심이 자기 슬롯에 든 케이스): argmax 도 전부 동일 슬롯(§1-1 교차표) — 회귀 0.
- 차량 bbox 가 이웃 슬롯에 크게 걸치는 경우: 실측 최대 2위 ratio 0.353(p3 veh3) 에서도 argmax 가 정답 유지. 차량당 슬롯 1개 규칙이 이중 점유를 차단.
- 차량 미검출 + plate 만 검출: 2단계 폴백이 현행과 동일하게 구제(논점 2, S2 계약 유지).
- 잔존 회귀 가능성(§9)과 함께, **진단 실좌표를 픽스처로 동결한 회귀 테스트**(§6 R군)로 "열끝 소실"·"이웃 오귀속" 재발 시 FAIL 하게 봉인한다.

---

## 2. 새 매칭 알고리즘 (`OccupancyJudge.judge` 재구성 — 의사코드)

```
judge(floorPolygons, detect):
  if floorPolygons 비배열: return []                        // 기존 graceful 유지
  vehicles ← detect?.vehicles ?? []
  rows ← floorPolygons.map(f ⇒ { idx: f.idx, occupied: false, source: null })

  // ── 1단계: 차량 접지밴드 argmax 귀속(주 매칭기 — 기존 2단계 기하 승격, 신규 기하 0줄) ──
  bestByPos ← Map()                                          // pos → { ratio, v }
  for v of vehicles:
    rect ← v?.rect;  없거나 band 면적 ≤ 0 → skip             // 기존 퇴화 처리 유지
    band ← groundBand(rect, this.groundBandRatio); corners ← rectCorners(band)
    (bestPos, bestRatio) ← argmax_j convexIntersectionArea(corners, floor[j].quad) / area(band)
                            // strict > 비교 — 동률 시 앞 슬롯(기존 tie-break)
    if bestPos ≥ 0 and bestRatio ≥ this.minBandOverlap:
      prev ← bestByPos.get(bestPos)
      if !prev or bestRatio > prev.ratio: bestByPos.set(bestPos, { ratio: bestRatio, v })

  placedPlateKeys ← Set()                                    // 배치 차량 attached plate 의 좌표 키
  placedVehicles ← Set()
  for (pos, { v }) of bestByPos:
    placedVehicles.add(v)
    c ← v.plate ? quadCentroid(v.plate.quad) : null
    if v.plate and c:                                        // plate 퇴화(c=null)는 bbox 로 강등
      rows[pos] ← { idx, occupied: true, source: 'plate', center: c,
                    plateQuad: v.plate.quad, vehicleRect: v.rect }
      placedPlateKeys.add(quadKey(v.plate.quad))             // quadKey = 4점 수치 직렬화
    else:
      rows[pos] ← { idx, occupied: true, source: 'bbox', vehicleRect: v.rect }

  // ── 2단계: plate-중심 폴백(비점유 슬롯 한정 — computeOccupancy 재사용, 논점 2) ──
  fallbackPlates ← [
    ...(detect?.plates ?? []).filter(p ⇒ p?.quad and !placedPlateKeys.has(quadKey(p.quad))),  // standalone
    ...vehicles.filter(v ⇒ !placedVehicles.has(v) and v?.plate).map(v ⇒ v.plate),             // 미배치 차량
  ]
  openPolys ← floorPolygons.filter((f, j) ⇒ !rows[j].occupied)   // (pos 역매핑 보존)
  for r of computeOccupancy(openPolys, fallbackPlates) where r.occupied:
    rows[posOf(r.idx)] ← { idx: r.idx, occupied: true, source: 'plate',
                           center: r.center, plateQuad: r.plateQuad }
  return rows
```

- **종료 보장**: 고정 2패스(차량 1회 순회 + 폴백 1회) — 루프 상한 자명, 재귀·반복 탐색 없음.
- **결정성**: 배열 순서 고정 + strict 비교 tie-break + 좌표 키 Set — 난수/시각/상태 없음(quadKey 는 동일 수치 → 동일 문자열).
- **복잡도**: O(V·S·k)(V=차량, S=슬롯, k=클립 정점≤8) — 기존 2단계와 동일 차수. 프리셋당 V,S ≤ ~30 → 마이크로초 대, 3fps 무풍.
- 삭제되는 코드: 기존 1단계 plate 선행 매칭 배선, `occupancy.js:163-165`(plate-in-any-polygon 후보 제외), `:188`(점유 슬롯 폴백 억제) — 진단 §5-③ 의 두 구제 실패 지점이 구조적으로 소멸.

---

## 3. 공개 API 시그니처 전/후 대조

| API | 전 | 후 | 변경 성격 |
|---|---|---|---|
| `core.js computeOccupancy(floorPolygons, plates)` | 동일 | **무변경** | — |
| `occupancy.js OccupancyJudge.judge(floorPolygons, detect)` | 동일 시그니처 | **시그니처·행 shape 무변경** | **의미 변경(파괴적)**: 귀속 기준 plate중심→차량접지. `source`=번호 인식 여부. plate 행에 `vehicleRect?` 추가(additive). 구 T7 계약 파기 → 재봉인 |
| `occupancy.d.ts OccupancyJudgement` | `vehicleRect` 주석 "source='bbox' 일 때만" | `vehicleRect`: 차량 귀속 행(plate/bbox 공통, 폴백 plate 행엔 없음) | 타입 형태 동일, 주석·의미 갱신 |
| `core.js buildFlatSlotRows({placeRoi, detectByKey, parkingSlotsByKey})` | 동일 | `{..., judge?}` 옵션 추가 — 전달 시 judge 로 점유 산출, 미전달 시 기존 경로 | additive(하위호환) |
| `app.js` (updateLogicOccupancy / drawOccupancyOverlay / buildFinalizeOccupancy) | — | updateLogicOccupancy·draw·finalize **무변경**, renderSlotList 의 buildFlatSlotRows 호출에 `judge` 1줄 | 최소 배선 |

---

## 4. 변경 파일 목록

| 파일 | 변경 요지 |
|---|---|
| `web/occupancy.js` | `judge` 재구성(§2): 1단계 접지 argmax 승격(+plate 유무로 source 결정, plate 퇴화 시 bbox 강등), 2단계 plate 폴백(비점유 슬롯 한정, attached 좌표키 제외 + 미배치 차량 plate 포함). `:163-165`/`:188` 조건 삭제. 기하 함수·상수·생성자 무변경 |
| `web/occupancy.d.ts` | `OccupancyJudgement.vehicleRect`/`source` 주석 의미 갱신(형태 무변경) |
| `web/core.js` | `buildFlatSlotRows` 에 `judge?` 주입 옵션(전달 시 `judge.judge` 사용). `computeOccupancy` 무변경 |
| `web/core.d.ts` | `buildFlatSlotRows` args 에 `judge?` 추가 |
| `web/app.js` | `renderSlotList`(:895) `buildFlatSlotRows` 호출에 `judge: occupancyJudge` 1줄. 그 외 무변경 |
| `test/occupancyJudge.test.ts` | T7 을 새 의미로 재봉인(plate 보유 차량 + plate 중심 밖 → `source:'plate'`+`plateQuad`+`vehicleRect`). T3 에 `vehicleRect` 존재 단언 보강(선택). 나머지 무변경 |
| `test/fixtures/occupancyAnchor/` **신규** | `_workspace/_qa_data_iter3/{place_roi.json, detect_cam1_p1~p3.json}` 동결 복사(진단 실좌표 픽스처) |
| `test/occupancyAnchor.regression.test.ts` **신규** | §6 R1~R7 회귀 봉인 |

`web/occupancyRegion.js`·`computeOccupancyRegions`·서버(src/)·라우트·DB 스키마·UI(html) **변경 없음**.

---

## 5. 기존 테스트 영향 검토표 (전부 Read 로 확인)

| 파일 | 판정 | 근거 |
|---|---|---|
| `test/computeOccupancy.test.ts` | **무변경 통과** | computeOccupancy 무변경 |
| `test/lpdFilterRegression.test.ts` | **무변경 통과** | computeOccupancy 직접 호출 기준의 서버 필터 불변 주장 — 함수·필터 모두 무변경. S2(plate-only 점유 유지)는 judge 2단계 폴백이 의미까지 보존 |
| `test/occupancyJudge.test.ts` | T1(plates only→폴백 경로 항등)·T2(bbox only)·T3(plate 차량 — vehicleRect 추가는 기존 단언과 무충돌)·T4·T5a/b·T6(standalone+bbox 병존)·T8(슬롯당 argmax)·T9(graceful)·config: **무변경 통과**. **T7 만 재봉인**(논점 3) | 케이스별 신규 알고리즘 수동 추적 완료 |
| `test/occupancyGeometryParity.test.ts` | 무변경 통과 | 기하 함수 무변경 |
| `test/placeGlobalIdx.test.ts` / `finalizerParkingSlots.test.ts` | 무변경 통과 | buildFlatSlotRows judge 미전달 기본 경로 유지 |
| `test/occupancyRegion.test.ts` | 무변경 통과 | occupancyRegion.js 무변경 |

---

## 6. 신규 유닛테스트 설계 (`test/occupancyAnchor.regression.test.ts`)

합성 케이스(A군)는 occupancyJudge.test.ts 기존 픽스처 재사용, 회귀 봉인(R군)은 실좌표 픽스처.

| # | 케이스 | 입력 | 기대 | 의도 |
|---|---|---|---|---|
| A1 | plate 보유 차량, plate 중심이 이웃 슬롯 | 차량 band 는 slot1, plate 중심은 slot2 내부 | slot1 occupied `source:'plate'` + plateQuad, **slot2 미점유** | 오귀속 메커니즘 자체 봉인(합성) |
| A2 | plate 보유 차량, plate 중심이 전 폴리곤 밖 | 구 T7 입력 | slot1 `source:'plate'`+plateQuad+vehicleRect (구: bbox) | 열끝 소실 메커니즘 봉인 + T7 신의미 |
| A3 | plate 퇴화(비4점) 차량 | v.plate.quad 3점 | `source:'bbox'` 강등, throw 없음 | 강등 철학 |
| A4 | standalone plate + 그 슬롯에 이미 차량 귀속 | attached 중복 quad 동수치 | 이중 마킹 없음(좌표키 제외 + 비점유 한정) | 폴백 중복 차단 |
| A5 | 차량 미검출 + standalone plate 만 | S2 상응 | 해당 슬롯 `source:'plate'` 점유 | 논점 2 계약 유지 |
| A6 | 슬롯 경합(두 차량 argmax 동일 슬롯) + 패자 plate 가 빈 이웃 슬롯 내부 | 합성 | 슬롯엔 ratio 승자, 패자 plate 는 폴백으로 이웃 슬롯 점유 | 논점 6 결정성 |
| A7 | 결정성 | A6 입력 2회 | 딥이퀄 | 결정성 |
| R1 | **p1 실좌표 전량** | 픽스처 cam1:1 | 점유 idx = `[1..7]` **정확히**, 전행 `source:'plate'`+plateQuad | 열끝 소실(slot7)·이웃 오귀속(5→6,6→7) 재발 시 FAIL |
| R2 | **p2 실좌표 전량** | cam1:2 | 점유 = `[8..13]`, 전행 plate | slot8 소실·10→9·9→8 봉인 |
| R3 | **p3 실좌표 전량** | cam1:3 | 점유 = `[14..17]`, 전행 plate(17 포함 — 구현 전엔 bbox 였음) | slot17 소실·15→16 봉인 |
| R4 | 슬롯↔차량 귀속 정확성 | p1 픽스처 | slot5 행의 vehicleRect === veh0.rect, slot6 === veh6.rect, slot7 === veh4.rect | 라벨 시프트(§3 진단) 봉인 |
| R5 | 사다리꼴 모집단 1:1 | p1~p3 judge 행 → `source==='plate'&&plateQuad` 필터 → `computeOccupancyRegions` | regions 수 = 7/6/4, overlapPairs=[] | 직접 발현 지점(app.js:371) 통합 봉인 |
| R6 | buildFlatSlotRows judge 주입 | p1~p3 픽스처 + judge | occupied 전역 idx = [1..17] 전량 true / judge 미전달 시 구 결과(하위호환) | 논점 4 |
| R7 | 최종화 스냅샷 의미 | R1 행을 buildFinalizeOccupancy 형으로 투영 | `{idx,occupied}` 17행 전량 true | 논점 4 DB 교정 확인 |

성공 게이트: `npx tsc -p tsconfig.json --noEmit` exit 0 + `npx vitest run` 전량 통과(기존 파일 포함, T7 재봉인 반영).

---

## 7. goal/loop 경험적 검증 계획 (B모드)

**Goal(명문화)**: 라이브 3프리셋(cam1 p1/p2/p3)에서 ① 점유 슬롯 수 = 화면상 차량 수(7/6/4), ② 오귀속 0(슬롯 라벨이 그 슬롯 위 차량과 일치 — 라벨 시프트 소멸), ③ 사다리꼴이 각 차량에 1:1(7/6/4개, 열끝 차 포함), ④ `overlapPairs=[]` — 를 스샷 육안 + 수치 로그로 동시 만족.

1. 구현 → §6 유닛 게이트 통과.
2. 오프라인 재현: 픽스처 + 뷰어 실물 모듈로 단계 추적(진단 §1 추적표 재실행) → ④단계 개수 7/6/4 확인.
3. 라이브: `npm start` → `POST /capture/detect` 3프리셋 재검출 → 뷰어 `#roi-occupancy` 켜고 sharp 스샷(기존 `_qa_live_roi_overlay.mjs` 관례) — 사다리꼴 개수·위치·라벨 육안 판정.
4. 틀어지면 재분석: 오귀속이 남으면 해당 차량의 band ratio 로그를 찍어 원인(임계/argmax/폴백) 격리 후 §2 로 복귀. **임계 튜닝은 최후 수단**(실측 여유 3.7배 — 건드릴 근거가 생기기 전엔 0.25/0.15 불변).
5. 성공 시 qa/documenter 이관(최종화 1회 실행해 DB `parking_slots` 값 교정도 확인).

---

## 8. 영향도 분석

| 영역 | 영향 |
|---|---|
| 뷰어 오버레이(`drawOccupancyOverlay`) | 무변경 — plate 행 vehicleRect 추가는 렌더 분기(`source==='bbox'&&vehicleRect`)와 무충돌. 열끝 3슬롯에 사다리꼴+빨강 원 신규 표시, p3 idx17 은 주황 원→사다리꼴로 승격 |
| 서버/DB | 스키마·라우트 무변경. **최종화 기록 값 교정**(p1 기준 slot5·7 등 occupied false→true) — 관측 가능한 동작 변화, 문서에 명시 |
| `buildFlatSlotRows` 소비처(renderSlotList) | 목록 뱃지가 오버레이와 정합(judge 주입). DB 태그 우선 규칙 무변경 |
| 기존 테스트 | §5 표 — T7 재봉인 외 전량 무수정 통과 |
| 성능 | judge O(V·S·k) — 기존 2단계와 동일 차수, 3fps 무풍 |
| 서버측 `onPlaceFilter` | 무변경 — 수집 필터와 뷰어 판정이 같은 기하(접지밴드)로 **정렬**되는 부수 이득 |

---

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| band 임계(0.15) 미달 주차차(심한 가림·비스듬) | 2단계 plate 폴백이 구제(미배치 차량 plate 포함). 실측 최소 ratio 0.558 — 현 데이터에선 발생 여지 없음. goal/loop 관찰 항목 |
| standalone plate 시차 누출로 **빈** 슬롯 FP | 폴백이 비점유 슬롯 한정이라 실차 슬롯은 면역. 빈 슬롯 누출은 현행에도 존재하던 결함의 부분집합(엄격히 축소). 잔존 시 후속(최근접 스냅은 진단 B 기각 사유대로 도입 않음) |
| VPD 거대 병합 박스(저신뢰)가 슬롯 점유 | argmax 1슬롯 규칙이 다중 점유 차단(기존 폴백과 동일 동작). lpdFilterRegression V-1 실좌표가 참고 케이스 |
| 이중주차(한 슬롯 2대) 패자 plate 의 이웃 누출 | A6 로 결정성만 봉인, 시각 판정은 goal/loop. 실데이터 미관측 — 추가 규칙은 과설계(규칙 2) |
| 구 run DB 와 신 run 점유 이력 불연속 | 버그 교정에 따른 필연 — documenter 산출물에 명시, 마스터 보고 |
| buildFlatSlotRows judge 미주입 경로에 구 결함 잔존 | 실소비처(app.js) 는 주입. 미주입 기본 경로는 하위호환용임을 d.ts 주석에 명시 |

---

## 다음 단계(구현자 인계)

```
1. web/occupancy.js judge 재구성(§2)                          → 검증: A1~A7 + 기존 occupancyJudge(T7 재봉인)
2. test/fixtures/occupancyAnchor 동결 + R1~R7                 → 검증: 회귀 봉인 전량 PASS
3. core.js buildFlatSlotRows judge 옵션 + app.js 1줄(§3)      → 검증: R6 + placeGlobalIdx/finalizer 무회귀
4. tsc+vitest 게이트 → §7 goal/loop 라이브 스샷 이터레이션     → 성공 기준: 7/6/4·오귀속 0·사다리꼴 1:1·overlap 0
```
