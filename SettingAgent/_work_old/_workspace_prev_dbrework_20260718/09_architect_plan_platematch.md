# 09. 설계 — plate→vehicle 배정 전역 그리디 교체(+재시도 중복 가드) : recovered 오귀속 근본 수정

> 설계자(architect) 산출물. 2026-07-16. **구현 0줄 — 설계 전용.**
> 사실 근거: `08_bug_diag_recovered_plate.md`(상류 진단 실측) + **본 설계 단계 실측**(`_workspace/_qa_tiebreak_09.mjs` — 동결 픽스처 `test/fixtures/occupancyAnchor/detect_cam1_p{1,2,3}.json` 에 tie-break 후보 5종을 실행한 결과. 아래 수치는 전부 이 실행의 출력이다).
> 실행 모드: **B. goal/loop** — 성공 기준이 관찰형(사다리꼴 1:1·overlap 0·중복 0).

---

## 0. 근본 원인 재확인과 수정 목표

`src/setup/plateMatch.ts:35`(+`:28`): plate→vehicle 배정이 **판별 argmax + 슬롯당 1개 캡 + 폐기** 구조라, 최적 차량이 점유됐을 때 차선 차량으로 넘기지 않고 판을 버린다. 판 bbox 가 두 rect 에 완전 포함되면 `intersectionArea` 가 포화해 **완전 동률**(판별력 0)이 되고, strict `>` 가 인덱스 순서로 승자를 정한다(기하 근거 0). p1 에서 veh6 의 진짜 판(1559,674)이 이렇게 폐기 → veh6 미귀속 → 줌 재시도(`detectPipeline.ts:314`, rect·중복 미검사 뷰중심 최근접)가 **veh0 의 판을 회수**(`recovered:true`) → 중복 귀속·사다리꼴 겹침(`overlapPairs=[[5,6]]`). p2 도 동일 결함(plates[5] 폐기)이 발현했으나 재시도가 우연히 자기 판을 되찾아 은폐(잠복). 중복 방지 장치는 코드베이스 전체에 전무.

**수정 목표**: ① 배정을 **전역 그리디 + 기하 tie-break** 로 교체해 "가진 정보를 버리는" 폐기 지점을 제거(근본), ② 재시도에 **중복 가드** 를 병행(심층 방어 — D2 재발 대비). 성공 기준: 3프리셋 사다리꼴 차량 1:1(7/6/4), `overlapPairs=[]` 전 프리셋, 슬롯 귀속 7/6/4 유지, recovered 판 중복 0.

---

## 1. 논점 결정 (1~7)

### 논점 1 — 배정 알고리즘: **전역 그리디 + frontAnchor tie-break** (헝가리안 기각)

**전역 그리디의 정확한 정의**: 후보쌍 = {(plate p, slot s) | p 중심 ∈ s.roi}(현행 1차 조건 유지). 전체 후보쌍을 **(겹침면적 내림차순 → frontAnchor 거리 오름차순 → plate 인덱스 → slot 인덱스)** 로 정렬해 순차 순회하며, **plate·slot 양쪽 모두 미배정일 때만** 확정한다.

**tie-break = frontAnchor 거리**: 판 중심 ↔ **(rect.x + rect.w/2, rect.y + rect.h × 0.62)** 의 정규화 유클리드 거리. 0.62 는 `detectPipeline.ts:113` 의 기존 상수 `FRONT_BIAS` — 줌 재시도가 "이 차량의 번호판이 있을 자리"로 이미 쓰는 동일한 기대치다(번호판은 bbox 상단이 아니라 전면 하부에 맺힌다). **신규 튜닝 파라미터 0.**

**후보 5종 실측 비교** (동결 3프리셋, `_qa_tiebreak_09.mjs` 실행 출력):

| tie-break | p1 (정답: veh6←p4, veh0←p5, 6/7) | p2 (정답: veh5←p5, 6/6) | p3 (4/4 무변화) | lpdFilter 합성† | 판정 |
|---|---|---|---|---|---|
| 인덱스 순(pi,si) | ✅ 정답 | ✅ 정답 | ✅ | ✅ TRUE | 통과하나 **기하 근거 0**(마스터 지적대로 자의적 — 배열 순서 요행) |
| **frontAnchor** | ✅ 정답 | ✅ 정답 | ✅ | ✅ **TRUE** | **채택 — 유일하게 전 케이스를 기하 근거로 통과** |
| 판중심↔rect중심 거리 | ✅ 정답 | ✅ 정답 | ✅ | ❌ **NOISE 채택(회귀)** | 기각 |
| rect 면적(작은 쪽) | ❌ **5/7, veh6←p5(옆차판)·veh0 미귀속** | ❌ 5/6 | ✅ | ✅ | **동결 데이터가 직접 기각** |
| 접지 거리(rect 하단↔판) | ❌ 위와 동일 실패 | ❌ 5/6 | ✅ | ✅ | **동결 데이터가 직접 기각** |

† `lpdFilterRegression.test.ts:332` 의 실좌표(PARKED rect(0.33,0.18,0.20,0.26), TRUE(0.43,0.335)/NOISE(0.43,0.29) — 둘 다 완전 포함 = 포화 동률): rect중심(cy 0.31) 기준 NOISE 가 0.020 < TRUE 0.025 로 **노이즈가 이기고**, frontAnchor(cy 0.3412) 기준 TRUE 0.0062 ≪ NOISE 0.0512 로 **진짜 판이 8배 차로 이긴다**. 판이 전면 하부에 맺힌다는 물리 사실이 rect 중심 대칭 가정을 이긴다.

동률 지점 실측 상세(frontAnchor 가 결정한 4곳 — 전부 정답 방향):

```
p1 plates[4](1559,674): veh4 0.07296  vs veh6 0.05707  → veh6 ✓ (마진 22%)
p1 plates[5](1348,678): veh0 0.06538  vs veh6 0.07111  → veh0 ✓ (마진 8.1% ★최소)
p2 plates[4](1191,724): veh3 0.07046  vs veh4 0.10678  → veh3 ✓ (34%)
p2 plates[5]( 408,636): veh5 0.05889  vs veh2 0.07457  → veh5 ✓ (21%)
```

(참고: p2 는 진단이 지목한 plates[5] 외에 plates[4]{veh3,veh4} 도 포화 동률이었다 — 본 실측에서 확인. frontAnchor 가 둘 다 정답 처리.)

**헝가리안(최적 배정) 기각 — 과설계**(규칙 2): ① 목적함수(총 겹침 합)가 포화로 **퇴화**한다 — 완전 동률 상황에선 최적해가 유일하지 않아 tie-break 문제가 그대로 남는다. 즉 최적화는 이 결함의 핵심(동률 판별)을 해결하지 않는다. ② 그리디+frontAnchor 가 동결 데이터에서 정답 전량 달성을 실측. ③ P,S ≤ ~30 규모에서 O(n³) 구현(~100줄+)이 주는 추가 이득 0.

### 논점 2 — 결정성: 전순서 comparator 로 보장

정렬 키 (overlap desc, anchorDist asc, pi asc, si asc) 는 **전순서**다 — (pi,si) 가 서로 다른 쌍을 항상 구별하므로 같은 입력이면 항상 같은 정렬, 같은 출력. **동률의 동률**(겹침·anchor 거리까지 동일)은 기하적으로 대칭인 합성 입력에서만 가능하며 그때 (pi,si) 폴백이 결정적으로 끊는다 — 인덱스는 **최후 폴백**으로 강등되어 결정성 보장 장치로만 남고, 실질 판별은 anchor 까지에서 끝난다(실데이터 실측: 인덱스까지 간 케이스 0). 난수·시각·외부 상태 없음. 종료: 유한 쌍(≤P·S) 1회 순회 — 자명.

### 논점 3 — (C) 재시도 중복 가드: **배정판 중심과 ε 거리 검사, 기각 시 다음 줌 계속**

`detectPipeline.ts` 재시도 루프에서 `inverseProjectQuad` 직후(클램프 전), 회수 quad 의 bbox 중심이 **이미 배정된 판**(base `matched` 의 quad 들 + 이 실행에서 앞서 확정된 recovered 판들)의 중심과 정규화 유클리드 거리 **ε=0.03 이내면 그 pick 을 기각**하고 `plate` 를 세우지 않은 채 **다음 zoomFactor 로 계속**한다(루프 상한 불변 — 호출 수 증가 0).

- **ε 근거(전부 실측)**: 중복 회수점↔원본 판 거리 **0.0100**(p1, 18.8px 상당) / 정상 신규 회수점(veh2, 1092)↔최근접 base 판 **0.1357** / base 판간 최소 간격 **0.1102**. → ε=0.03 은 관측된 역투영 오차의 **3.0배 위**, 정상 케이스 최소 거리의 **1/4.5 아래**. 판별 창이 한 자릿수 이상 벌어져 있다. 모듈 상수(설정화 금지 — 규칙 2).
- **rect 포함 검사는 추가하지 않는다**: 훔친 판(1367,676)이 피해 차량 veh6.rect **내부**라 판별력 0(진단 §후보B 기각 사유 그대로). 중복 ε 검사만이 유효하다.
- **진단 경고("단독 적용 시 05 회귀") 해소 논증 — (A) 병행 시 안전한 이유**:
  1. (A) 가 동결 케이스의 재시도 진입 자체를 제거한다(p1 veh6·p2 veh5 는 base 에서 자기 판 획득) → 가드는 동결 데이터에서 **발동 0**. p1 veh2 의 정상 회수(1092, base LPD 미검출 구제)는 거리 0.1357 ≫ ε 라 통과 — **과차단 없음**(실측).
  2. 가드가 발동하는 미래 장면(D2 재발 + 이웃 판만 시야)에서 결과는 `plate:undefined` → `source:'bbox'` 강등이다. **06/07 앵커 교체 이후** 슬롯 점유는 접지밴드가 담당하므로 점유는 잃지 않고, 사다리꼴만 주황 '번호미인식' 원으로 강등된다 — 05 원결함(점유+사다리꼴 동시 소실)으로의 회귀가 **아니다**. 옆차 판으로 만든 틀린 사다리꼴(중복 표시)보다 명백히 나은 실패다.
  3. 기각 후 중단이 아니라 **다음 줌 단계 계속** — 더 좁아진 FOV 에서 이웃 판이 시야를 벗어나 자기 판을 찾을 기회를 보존한다.

### 논점 4 — `Aggregator.ts:276` 규칙 복제: **본 작업 범위 밖, 별도 이슈 분리** (주석 1줄만 정정)

- **분리 근거**: ① :276 은 코드 공유가 아니라 **주석 참조 + 독립 복제 구현** — (A) 수정으로 컴파일·동작 모두 무영향. ② granularity 가 다르다: Aggregator 는 클러스터 **대표** 단위이고 루프 구조가 **차량별 argmax**(한 판 대표가 이론상 여러 차량에 붙을 수 있는 **반대 방향** 구조)라, 통합하려면 캡처 집계 파이프라인 자체를 재설계해야 한다. 본 버그(검출 1건 단위 폐기)와 인과가 없는 코드를 같이 바꾸는 것은 규칙 3 위반. ③ 캡처 경로는 다라운드 클러스터링이 노이즈를 흡수해 동일 결함의 발현 증거가 현재 없다.
- 단, :276 주석 "기존 matchPlatesToSlots 규칙" 은 (A) 후 **사실과 어긋난다**(plateMatch 는 전역 그리디로 개정됨). 변경된 사실의 서술 정정으로 **주석 1줄만** 갱신하고(07 §3 선례 — 오설명 방치 금지), "규칙 이원화 — 별도 이슈" 를 명기해 추적한다. 코드 무변경.

### 논점 5 — DB 영향(`SetupOrchestrator.ts:218`): **마이그레이션 불요, 셋업 재실행 권장**

- 저장되는 판 좌표(슬롯별 번호판 prior)가 달라질 수 있다 — 폐기되던 판이 차선 슬롯에 귀속되므로. **버그 교정이지만 관측 가능한 동작 변화** — documenter 산출물에 명시.
- **마이그레이션 불요 근거**: 셋업 아티팩트는 검출로부터의 **파생 데이터**로, 셋업 재실행으로 전량 재생성된다(원본 소스가 따로 있고 스키마 무변경). 기존 아티팩트는 그대로 유효하되 구 오배정을 담고 있을 수 있음 → **배포 후 셋업 1회 재실행을 운영 절차로 권장**.
- 부수 개선: `matched.size < built.length` 경고 빈도는 감소만 가능 — 그리디는 **maximal matching**(양쪽 미배정인 후보쌍을 남기지 않음)이라 매칭 수가 현행 대비 줄지 않는다(실측 p1 5→6, p2 5→6, p3 4→4).
- 와이어 계약·스키마·라우트 무변경. 최종화 `{idx,occupied}` 는 판 좌표와 무관해 무영향.

### 논점 6 — `lpdFilterRegression.test.ts:325`: **단언 무수정 통과, 서술의 유효 범위가 좁아짐**

- **실측**: 그 픽스처(단일 차량 PARKED, TRUE/NOISE 완전 포함 동률)에서 그리디+frontAnchor 는 TRUE 를 배정하고, NOISE 는 유일 후보 슬롯이 점유돼 미배정 + 폴리곤 밖 → 드롭 유지. `filteredOut=1`·`kept=TRUE`·plateY 단언 전부 그대로 성립 — **테스트 파일 무수정**.
- **의미 변화**: ":325 드롭은 의도" 는 이제 "**차선 후보 슬롯이 없을 때만** 드롭"으로 좁아진다. 그 픽스처는 단일 차량이라 서술이 여전히 참 — 재봉인 불요. 새로 생긴 성질(차선 폴백)은 이 테스트를 건드리지 않고 `plateMatch.test.ts` 신규 케이스(N4)로 **독립 봉인**한다.
- **교차 검증 기록**: rect중심 tie-break 를 택했다면 이 테스트가 NOISE 귀속으로 깨졌다(§1 표 †). 즉 이 기존 봉인이 tie-break 선정을 역방향에서 검증해 준 셈이다.
- **경계 케이스 추가 발견**: 구 코드는 이 픽스처에서 plates **배열 순서**에 의존한다 — NOISE 를 먼저 넣으면 구 코드가 NOISE 를 붙인다(동률에서 선착 유지). 신규 N5 가 이 순서 취약성까지 봉인한다(구 구현 FAIL → 신 구현 PASS 판별 테스트).

### 논점 7 — 미확정 사항(D2: "veh6 줌뷰에서 LPD 자기판 미검출"은 연역) 의존성 점검

- **(A) 는 D2 에 의존하지 않는다**: 폐기 제거로 동결 케이스의 재시도 자체가 소멸 — D2 의 진위와 무관하게 결함이 사라진다(진단 §6 판단 그대로).
- **(C) 는 D2 재발을 전제로 한 방어**다: D2 가 다시는 안 터지면 가드는 휴면(해 0), 터지면 오귀속 대신 표시 강등. **취약성 명시**: ε=0.03 의 상한 근거인 역투영 오차 실측이 **표본 2개**(0.0100 / 16px≈0.008)다. 다른 장면(고배율·경사)에서 역투영 오차가 ε 를 넘으면 중복이 새어들 수 있다 — goal/loop 관찰 항목으로 지정하고, 재발 시 ε 재실측으로 대응(선제 확대는 정상 신규 판 오차단 위험이 있어 하지 않는다).

---

## 2. 새 배정 알고리즘 (의사코드)

```
matchPlatesToSlots(slots, plates): Map<positionIdx, NormalizedQuad>   // 시그니처 무변경
  pairs ← []
  for pi, plate of plates:
    pr ← quadBoundingRect(plate.quad); c ← center(pr)
    for si, s of slots:
      if !containsPoint(s.roi, c.cx, c.cy): continue          // 1차 조건 현행 유지
      pairs.push({ pi, si, slot: s.positionIdx, quad: plate.quad,
                   overlap: intersectionArea(s.roi, pr),
                   anchor:  dist²(c, { x: roi 중심x, y: roi.y + roi.h × FRONT_BIAS }) })
  pairs.sort( overlap desc → anchor asc → pi asc → si asc )   // 전순서(§논점2)
  result ← Map(); usedPlate ← Set()
  for p of pairs:
    if usedPlate.has(p.pi) or result.has(p.slot): continue    // 양쪽 미배정일 때만 확정
    result.set(p.slot, p.quad)                                 // quad **참조** 그대로(하단 주의)
    usedPlate.add(p.pi)
  return result
```

- **복잡도**: 쌍 생성 O(P·S) + 정렬 O(K log K), K ≤ P·S ≤ ~40×40 — 마이크로초 대(현행 O(P·S) 와 실질 동급). 호출 빈도 저(on-demand 검출·셋업).
- **종료**: 유한 배열 2회 순회. **결정성**: §논점 2.
- **불변식 유지**: 판당 슬롯 ≤1, 슬롯당 판 ≤1(현행과 동일). **maximal**: 양쪽 미배정 후보쌍이 남지 않는다(현행엔 없던 성질 — 차선 폴백의 본체).
- **⚠️ 반환값은 `plate.quad` 참조를 그대로 담아야 한다**: `onPlaceFilter.ts:80-88` 의 `attached.has(p.quad)` 와 `detectPipeline.ts:303` 의 `p.quad === baseQuad` 가 참조 동등성에 의존(기존 계약).

### (C) 가드 의사코드 (detectPipeline 재시도 루프 내)

```
assignedCenters ← [matched 의 각 quad 중심] (루프 진입 전 1회 구성)
...재시도 pick 성공 시:
  recQuad ← inverseProjectQuad(...)
  rc ← center(quadBoundingRect(recQuad))
  if assignedCenters 중 dist(rc, ·) ≤ DUP_EPS(=0.03) 존재:
    warn 로그(중복 회수 기각 — cam/preset/veh/거리) 후 continue   // 다음 zoomFactor
  plate ← { quad: clampQuadCenterToRect(recQuad, ...), recovered: true, ... }
  assignedCenters.push(rc)                                      // 후속 차량 재시도와의 중복도 차단
```

---

## 3. 시그니처 전/후 대조표 · 변경 파일

| API | 전 | 후 | 성격 |
|---|---|---|---|
| `plateMatch.ts matchPlatesToSlots(slots, plates)` | 동일 | **시그니처·반환형 무변경** | **내부 알고리즘 교체(의미 변경)**: 판별 argmax+폐기 → 전역 그리디+frontAnchor. 배정 결과가 달라질 수 있음(그것이 수정의 본체) |
| `detectPipeline.ts runDetect(...)` | 동일 | 무변경 | 내부에 중복 가드 추가. `DetectPlate`/`DetectVehicle`/응답 shape 무변경 |
| 신규 공개 API | — | **없음** | 가드·anchor 계산은 모듈 내부. `DUP_EPS`·`FRONT_BIAS` 재사용은 상수 |

| 파일 | 변경 요지 |
|---|---|
| `src/setup/plateMatch.ts` | `matchPlatesToSlots` 내부를 §2 로 재작성 + 헤더 주석의 규칙 서술 갱신(구 규칙 오설명 방지) |
| `src/capture/detectPipeline.ts` | 재시도 루프에 중복 가드(§2C) + `DUP_EPS` 모듈 상수(ε 근거 주석 포함) |
| `src/capture/Aggregator.ts` | **:276 주석 1줄만** 정정(독립 복제 명시 + 별도 이슈 추적. 코드 무변경 — 논점 4) |
| `test/plateMatch.test.ts` | 기존 4건 **무수정 유지** + 신규 N1~N7 |
| `test/detectPipeline.test.ts` | 신규 G1~G3(가드) |
| *(goal/loop 성공 후)* `test/fixtures/occupancyAnchor/detect_cam1_p1.json` + `occupancyAnchor.regression.test.ts` | p1 픽스처 재동결 + **R5b `it.fails` → 양성 단언 전환**(§5-3) |

서버 라우트·DB 스키마·`onPlaceFilter.ts`·`web/`(뷰어)·`SetupOrchestrator.ts` **코드 무변경**.

---

## 4. 유닛테스트 설계

**픽스처**: `test/fixtures/occupancyAnchor/detect_cam1_p{1,2,3}.json` **재사용**(신규 픽스처 0 — vehicles[].rect 와 plates[] 가 그대로 입력이 된다). 07 선례대로 **신규 테스트를 먼저 작성해 수정 전 구현의 FAIL 을 실측 기록** 후 구현한다(위장 방지).

### `test/plateMatch.test.ts` 신규 (기존 4건은 무수정 — 그리디에서 결과 동일함을 수동 추적 완료: 케이스4 는 big 겹침 0.008 > small 0.0004 로 동률 아님)

| # | 케이스 | 입력 | 기대 | 수정 전 |
|---|---|---|---|---|
| **N1** | ★p1 실좌표 완전동률 회귀 봉인 | p1 픽스처 vehicles→slots, plates | matched **6/7**: veh6←plates[4](1559,674 quad 동등)·veh0←plates[5]·veh1/3/4/5 현행 동일·**veh2 만 미귀속** | **FAIL**(5/7, plates[4] 폐기) |
| **N2** | ★p2 잠복 D1 봉인 | p2 픽스처 | matched **6/6**: veh5←plates[5](408,636)·veh2←plates[2]·veh3←plates[4] | **FAIL**(5/6) |
| **N3** | p3 무변화(회귀 0) | p3 픽스처 | 구 알고리즘 결과와 딥이퀄(4/4) | PASS(판별력용 대조군 — 명기) |
| **N4** | ★다중 rect 동시 완전포함 + 차선 폴백(기존 4건 미커버 영역) | 합성: 판 A rect1 전용(겹침 大), 판 B 가 rect1·rect2 양쪽 완전포함 | rect1←A, **rect2←B**(폐기 아님) | **FAIL**(B 폐기) |
| **N5** | ★tie-break 메트릭 봉인(frontAnchor ≠ rect중심 ≠ 배열순) | lpdFilter 실좌표: PARKED rect + plates **[NOISE, TRUE] 순서**(NOISE 가 rect 중심에 더 가깝고 배열도 앞) | slot←**TRUE**(anchor 0.0062 vs 0.0512) | **FAIL**(구 코드는 선착 NOISE 유지 — §논점6 경계 발견) |
| **N6** | 결정성 | N1 입력 2회 실행 | 딥이퀄 | PASS(성질 유지 확인) |
| **N7** | 단일 슬롯 노이즈 드롭 보존 | 단일 rect + 판 2(겹침 상이) | 큰 쪽 유지, 작은 쪽 미배정(차선 없음 → 드롭) | PASS(lpdFilterRegression :332 상류 상응 봉인) |

### `test/detectPipeline.test.ts` 신규 (기존 스텁 패턴 재사용)

| # | 케이스 | 기대 | 수정 전 |
|---|---|---|---|
| **G1** | veh1 base 매칭(판 A) + veh2 미귀속, 전 줌뷰 LPD 가 A 와 역투영 중심 ε 내 판만 반환 | veh2.plate **undefined**(전 시도 기각), requestImage 5회(상한 불변), recovered=0 | **FAIL**(A 사본을 회수) |
| **G2** | 1차 줌뷰=중복 판, 2차 줌뷰=신규 판(ε 밖) | `attempts:2` 로 신규 판 채택(기각 후 계속 봉인) | **FAIL**(attempts:1 중복 채택) |
| **G3** | 신규 판이 최근접 배정판에서 0.13 거리(p1 veh2 상응) | 정상 recovered 유지 — **과차단 방지** | PASS(성질 유지 확인) |

**게이트**: `npx tsc -p tsconfig.json --noEmit` exit 0 + `npx vitest run` 전량 통과. 기존 테스트 예상: `plateMatch.test.ts` 4건·`lpdFilterRegression.test.ts`(§논점6)·`onPlaceFilter` 계열·`occupancyAnchor.regression.test.ts`(픽스처 불변인 한 R5b `it.fails` 포함) 전부 **무수정 통과**. 서버 산출이 바뀌므로 detect 픽스처를 소비하는 다른 테스트의 단언과 충돌하면 안 된다 — 픽스처 자체는 이 단계에서 건드리지 않으므로 충돌 없음.

---

## 5. goal/loop 경험적 검증 계획 (B모드)

**Goal(명문화)**: 라이브 3프리셋(cam1 p1/p2/p3) 재검출 후 ① 사다리꼴이 각 차량에 **1:1**(7/6/4), ② `computeOccupancyRegions.overlapPairs=[]` **전 프리셋**(특히 p1 [5,6] 소멸), ③ 슬롯 귀속 7/6/4 유지(06 앵커층 무회귀), ④ recovered 판 중복 0(전 recovered 중심↔배정판 최소거리 > ε 를 로그로 확인), ⑤ p1 slot5·slot6 사다리꼴이 각자의 차량 위에 섬(육안).

1. **유닛 게이트**(§4, 수정 전 FAIL 실측 포함) 통과.
2. **오프라인 재현**: `_qa_tiebreak_09.mjs` 를 수정 후 실코드 import 로 바꿔 재실행 → §1 표의 그리디 열과 동일 출력 확인(구현-설계 정합).
3. **라이브**: `npm start` → `POST /capture/detect` 3프리셋 → `_qa_regions*` 관례 스크립트로 regions 수·overlapPairs 수치 + 뷰어 `#roi-occupancy` sharp 스샷 육안 판정. p1 은 slot6 사다리꼴 축이 (1559,674) 계열로 이동했는지 좌표 로그 확인.
4. **틀어지면 재분석**: 배정 trace(정렬된 후보쌍 목록 + 확정/스킵 사유)를 임시 로그로 찍어 원인(동률 마진/폴백/가드) 격리 후 §2 로 복귀. **frontAnchor 계수(0.62)·ε(0.03) 튜닝은 최후 수단** — 실측 마진(anchor 최소 8.1%, ε 창 3.0×~4.5×)이 깨진 증거가 나오기 전엔 불변.
5. **성공 시 마감**: p1 detect 픽스처 재동결 → `occupancyAnchor.regression.test.ts` **R5b 를 `it.fails` → 양성 단언(overlapPairs=[]) 으로 전환**(07 §6 이 설계한 재방문 의무의 이행 — 픽스처가 구 서버 산출을 담는 한 자동으로 안 뒤집히므로 **재동결이 전환의 전제**임을 명시), R1/R4/R5 가 새 픽스처에서도 통과함을 확인. 셋업 1회 재실행(논점 5). qa/documenter 이관.

---

## 6. 영향도 분석

| 영역 | 영향 |
|---|---|
| `detectPipeline.ts:278` | 의도 대상. `:285` 주석("filterPlatesOnPlace 내부 재호출과 동일 입력·동일 결과")은 결정성 유지로 **여전히 참** |
| `onPlaceFilter.ts:82` (A)귀속 | attached 집합 변동. (B) 주차면 분기가 하한 보장. **단 kept 는 엄밀히는 비단조** — 구버전 attached 판이 그리디에서 미배정 + 폴리곤 밖이면 신규 드롭 가능(이론상). 동결 실측: attached 증가 방향·`lpdFilteredOut=0` 유지 → 리스크 표 |
| `SetupOrchestrator.ts:218` | 저장 판 prior 좌표 교정(논점 5 — 마이그레이션 불요·셋업 재실행 권장·경고 빈도 감소만 가능) |
| `Aggregator.ts:276` | 코드 무영향. **규칙 이원화 부채 → 별도 이슈**(논점 4) |
| 06/07 앵커층(뷰어 judge) | 서버 산출(vehicles[].plate) 소비자 — 상류 교정으로 p1 slot6 의 plateQuad 정상화 = 07 §6 잔존 증상(사다리꼴 겹침)의 해소. judge 코드 무변경 |
| 기존 테스트 | §4 게이트 — 전부 무수정 통과 예상(픽스처 재동결은 goal/loop 성공 후 별도 단계) |
| DB/와이어 | 스키마·계약 무변경. 셋업 아티팩트 값 교정(관측 가능한 변화 — documenter 명시) |
| 성능 | 정렬 추가 O(K log K), K≤~1600 — 무시 가능. 가드 발동 시에도 카메라 호출 수 상한 불변 |

---

## 7. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| frontAnchor(0.62) 가정이 깨지는 장면 — 후면 주차·심한 경사 등 판이 전면 하부에 안 맺히는 배치 | tie-break 는 **포화 동률에서만** 개입(1차 판별은 여전히 겹침) → 노출 면적이 좁다. goal/loop 관찰 항목. 동결 데이터 전 케이스 정답 실측이 현 근거 |
| p1 plates[5] anchor 마진 8.1%(최소) — 유사 장면에서 역전 가능성 | 역전해도 그리디 구조상 "폐기" 는 재발하지 않는다(차선 배정) — 최악이 구 결함이 아니라 1칸 오배정. 재발 시 배정 trace 로 격리(§5-4) |
| ε=0.03 근거 표본 2개(논점 7) — 역투영 오차가 ε 초과하는 장면에서 중복 누출 | goal/loop ④ recovered 거리 로그 상시 확인. 재발 시 ε 재실측(선제 확대 금지 — 정상 신규 판 오차단 위험) |
| onPlaceFilter kept 비단조(§6) — 이론상 attached 축소 드롭 | lpdFilterRegression·onPlaceFilter 기존 게이트 + 라이브 `lpdFilteredOut` 관찰. 발현 시 별도 진단(폴리곤 밖 attached 판은 현 데이터에 부재) |
| p1 픽스처 재동결 시 R1~R7 단언 어긋남 | 재동결 직후 anchor 회귀군 전량 재실행을 §5-5 절차에 포함. 어긋나면 재동결 보류·원인 격리 |
| 구현이 quad 참조 보존을 놓침 → onPlaceFilter/`:303` 참조 동등성 파괴 | §2 ⚠️ 명시 + 기존 detectPipeline·onPlaceFilter 테스트가 즉시 검출 |

---

## 다음 단계(구현자 인계)

```
1. 신규 테스트 N1~N7·G1~G3 작성 → 수정 전 FAIL 실측 기록(N1/N2/N4/N5/G1/G2)   → 검증: FAIL 로그
2. plateMatch.ts 전역 그리디(§2) + Aggregator :276 주석 1줄                    → 검증: N군 + 기존 4건 + lpdFilterRegression 무수정 통과
3. detectPipeline.ts 중복 가드(§2C, DUP_EPS=0.03)                              → 검증: G군 + 기존 detectPipeline 무수정 통과
4. tsc+vitest 전량 → §5 goal/loop(오프라인 재현 → 라이브 스샷/수치)             → 성공: 1:1·overlap 0·7/6/4·중복 0
5. 성공 후: p1 픽스처 재동결 + R5b 양성 전환 + 셋업 재실행                      → 검증: anchor 회귀군 전량 PASS
```
