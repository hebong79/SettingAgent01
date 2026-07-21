# 10. 구현 — plate→vehicle 전역 그리디 배정 + 재시도 중복 가드 (설계 09 이행)

> 구현자(developer) 산출물. 2026-07-16.
> 입력: `09_architect_plan_platematch.md`(설계) / `08_bug_diag_recovered_plate.md`(진단).
> 아래 수치는 전부 **본 세션 실행 실측**이다. 예측·추정은 그렇게 명기했다.

---

## 0. 요약

| 항목 | 결과 |
|---|---|
| 변경 소스 | `src/setup/plateMatch.ts`(알고리즘 교체) / `src/capture/detectPipeline.ts`(가드) / `src/capture/Aggregator.ts`(**주석 1줄**) |
| 변경 테스트 | `test/plateMatch.test.ts`(신규 N1~N7) / `test/detectPipeline.test.ts`(신규 G1~G3) — **기존 케이스 무수정** |
| 게이트 | `npx tsc --noEmit` **exit 0** / `npx vitest run` **152 files · 1686 tests 전량 통과**(기준선 1676 → **+10**) |
| 수정 전 FAIL 실측 | **N1·N2·N4·N5 / G1·G2 = FAIL 확인**(판별력 있음). N3·N6·N7·G3 = 수정 전에도 PASS(**설계가 명기한 대조군**) |
| 설계 이탈 | 1건(경미) — `FRONT_BIAS` 를 import 가 아니라 **값 복제**(순환 import 회피). §3 |
| 범위 | `web/`·`onPlaceFilter.ts`·`SetupOrchestrator.ts`·라우트·DB **무변경**. 픽스처 재동결·R5b 전환 **미수행**(범위 밖) |

---

## 1. 파일별 변경

### 1-1. `src/setup/plateMatch.ts` — 알고리즘 교체(시그니처 무변경)

`matchPlatesToSlots(slots, plates)` 내부를 설계 §2 의사코드 그대로 재작성했다. **시그니처·반환형 불변**.

- **전**: 번호판별 argmax(strict `>`) + 슬롯당 1개 캡 → 승자가 이미 더 큰 판을 보유하면 **폐기**(차선 슬롯으로 안 넘김).
- **후**: 후보쌍 = {(p,s) | p 중심 ∈ s.roi}(1차 조건 현행 유지) → **(겹침 desc → frontAnchor 거리 asc → pi asc → si asc)** 정렬 → **양쪽 미배정일 때만** 확정(maximal matching = 차선 폴백).
- `anchor` 는 제곱거리로 비교(정렬 순서 동일, `sqrt` 불요 — 신규 기하 프리미티브 0. 기존 `quadBoundingRect`/`center`/`containsPoint`/`intersectionArea` 만 사용).
- **quad 참조 보존**: `result.set(p.slot, p.quad)` 로 원 참조를 담는다(설계 §2 ⚠️ — `onPlaceFilter.ts:80-88` 의 `attached.has(p.quad)`, `detectPipeline.ts:303` 의 `p.quad === baseQuad` 가 참조 동등성에 의존). 신규 N1~N5·N7 이 전부 `toBe`(참조 동등)로 단언해 이 계약을 함께 봉인한다.
- 헤더 주석의 규칙 서술을 갱신했다(구 규칙 오설명 방지 — 설계 §3 지시).

### 1-2. `src/capture/detectPipeline.ts` — 재시도 중복 가드(+`DUP_EPS`)

- 모듈 상수 `DUP_EPS = 0.03` 추가(ε 실측 근거 주석 포함 — 설정화하지 않음, 규칙 2).
- 루프 진입 전 `assignedCenters` 1회 구성: `[...matched.values()].map(q => center(quadBoundingRect(q)))`.
- 재시도 pick 성공 시 `inverseProjectQuad` 직후 · **`clampQuadCenterToRect` 전** 좌표로 판정한다(클램프는 `v.rect` 로 당겨 훔친 판과 자기 판을 뭉갠다 — 진단 08 §2-2 6항의 "유일한 방어 장치가 침묵한" 지점).
- 배정판 중심과 거리 ≤ `DUP_EPS` 면 **warn 로그 후 `continue`** — 중단이 아니라 **다음 zoomFactor 계속**(루프 상한 불변 → 카메라 호출 수 증가 0. G1 이 `requestImage` 5회로 봉인).
- 채택 시 `assignedCenters.push(rc)` — 후속 차량 재시도와의 중복도 차단.
- import 추가: `center`, `quadBoundingRect`(`../domain/geometry.js`). 고아 import·변수 없음.

### 1-3. `src/capture/Aggregator.ts` — 주석 1줄만(코드 무변경)

`:276` 의 "기존 matchPlatesToSlots 규칙" 서술이 (A) 후 사실과 어긋나므로 정정했다:

> `// 번호판 귀속: 번호판 대표 중심이 vehicle 대표 ROI 내부 + 겹침 최대(**독립 복제 구현** — matchPlatesToSlots 는 전역 그리디로 개정됨. 규칙 이원화 = 별도 이슈).`

코드는 **한 줄도 건드리지 않았다**(설계 논점 4 — granularity 상이·인과 없음).

---

## 2. 수정 전 FAIL 실측 (위장 방지 — 설계 §4 절차)

신규 테스트를 **먼저 작성해 미수정 구현에 실행**했다. 실측 출력:

```
$ npx vitest run test/plateMatch.test.ts          # ← 구 plateMatch.ts
 × N1 p1 실좌표 완전동률 …            → AssertionError: expected 5 to be 6
 × N2 p2 잠복 결함 …                  → AssertionError: expected 5 to be 6
 × N4 두 rect 동시 완전포함 …          → AssertionError: expected [{x:0.52,…}] to be [{x:0.33,…}]
 × N5 tie-break 메트릭 봉인 …          → AssertionError: expected [{x:0.405,y:0.278},…] to be [{x:0.405,y:0.323},…]
 Tests  4 failed | 7 passed (11)

$ npx vitest run test/detectPipeline.test.ts      # ← 구 detectPipeline.ts
 × G1 전 줌뷰가 배정판 사본만 반환 …    → AssertionError: expected { …(4) } to be undefined
 × G2 1차 뷰=중복 / 2차 뷰=신규 …       → AssertionError: expected 1 to be 2
 Tests  2 failed | 31 passed (33)
```

수정 후: 위 6건 전부 PASS(§4 게이트).

### 판별력 없는(수정 전에도 PASS) 테스트 — 명시

| # | 수정 전 | 성격 | 유지 사유 |
|---|---|---|---|
| **N3** p3 무변화 | **PASS** | 회귀 0 **대조군** | 설계 §4 가 "판별력용 대조군 — 명기" 로 지정. 동률 없는 프리셋에서 구/신 결과 동일함을 봉인 |
| **N6** 결정성 | **PASS** | 성질 유지 확인 | 신 구현이 정렬 도입 후에도 결정적임을 봉인(전순서 comparator) |
| **N7** 단일 슬롯 드롭 보존 | **PASS** | 성질 유지 확인 | 그리디가 maximal 이 되면서 "드롭"이 사라지지 않았음(차선 후보 없을 때만 드롭)을 봉인 |
| **G3** 0.13 거리 정상 회수 | **PASS** | **과차단 방지** | ε 가 정상 신규 회수(p1 veh2, 실측 0.1357)를 막지 않음을 봉인 |

→ 이들은 **결함 재발 탐지용이 아니라 성질 보존용**이다. 앞선 이터레이션의 A3/A5/A7 과 달리 설계가 그 역할을 사전에 명기했으므로 제거하지 않았다. 판별력 있는 봉인은 **N1·N2·N4·N5·G1·G2 6건**이다.

---

## 3. 설계 이탈 / 판단

### 이탈 1 (경미) — `FRONT_BIAS`: import 재사용 → **값 복제**

- 설계 §1: "tie-break 는 기존 `FRONT_BIAS` 상수 재사용(신규 파라미터 0)".
- **문제**: `FRONT_BIAS` 는 `detectPipeline.ts:113` 의 **모듈 private** 이고, `detectPipeline` 이 `plateMatch` 를 import 한다 → 역방향 import 는 **순환 의존**. 제3 모듈로 승격하면 설계 §3 의 변경 파일 목록(`detectMath.ts` 미포함)을 벗어난다.
- **선택**: `plateMatch.ts` 에 `const FRONT_BIAS = 0.62;` 를 두고 주석으로 동일 상수임·복제 사유를 명시. **설계 의도(신규 튜닝 파라미터 0 · 값 0.62 불변)는 그대로 지켰다.** 값이 3곳(`detectPipeline:113`·`detectMath:113` 기본값·`plateMatch`)에 있는 부채가 되므로 기록한다.

### 판단 1 — N4 합성 픽스처: 동일 크기 판 → **A 를 큰 판으로**(설계 문언 준수)

최초 A·B 를 동일 크기(0.06×0.03)로 잡았더니 **부동소수 노이즈**로 완전 포함 겹침이 정확히 동률이 아니었다(실측: `A/s1 = 1.79999999999999995e-3` < `B/s1 = 1.80000000000000147e-3`). 이러면 그리디가 B 를 slot1 에 먼저 넣어 A 가 드롭되어 설계 의도와 다른 케이스가 된다. 설계 §4 N4 는 애초에 **"판 A rect1 전용(겹침 大)"** 이라 명기했으므로 A 를 0.08×0.04(겹침 0.0032)로 키워 문언대로 맞췄다. 이탈 아님(내 초안 오류의 정정).

- **부수 관찰(코드 수정 대상 아님)**: "완전 포함 → 완전 동률" 은 **실좌표에서는 성립**하나(동결 3프리셋의 동률 4곳은 `|Δ| < 1e-12` 로 실측 확인 — 설계 §1 표) 합성 좌표에서는 `intersectionArea` 의 뺄셈 순서 차이로 1e-18 급 노이즈가 낄 수 있다. 그 경우 tie-break 가 발동하지 않고 겹침 비교에서 갈린다. 실데이터 마진(anchor 최소 8.1%)과 무관한 크기라 대응 불요.

### 판단 2 — 가드 판정에 `Math.hypot` 사용

설계 §2C 의 `dist(rc, ·) ≤ DUP_EPS` 를 그대로 구현. `plateMatch` 의 anchor 는 제곱거리 비교(순서만 필요)지만, 가드는 **절대 임계 ε 와 비교**하므로 실거리가 필요하다. 로그에도 실거리를 남긴다(ε 재실측 — 설계 §7 리스크 항목의 관찰 수단).

---

## 4. 게이트 실측

```
$ cd SettingAgent && npx tsc -p tsconfig.json --noEmit
TSC_EXIT=0

$ npx vitest run
 Test Files  152 passed (152)
      Tests  1686 passed (1686)
```

| | 기준선 | 수정 후 | 증감 |
|---|---|---|---|
| Test Files | 152 | **152** | 0 (신규 파일 0 — 기존 2파일에 추가) |
| Tests | 1676 | **1686** | **+10** (N1~N7 = 7, G1~G3 = 3) |
| 실패 | 0 | **0** | — |

---

## 5. 기존 테스트 영향 실측

| 테스트 | 예상(설계) | **실측** |
|---|---|---|
| `plateMatch.test.ts` 기존 4건 | 무수정 통과 | **PASS**(무수정) — 비겹침/단일 슬롯이라 그리디에서 결과 동일 |
| `lpdFilterRegression.test.ts:332`(★★ 반례 시도) | **무수정 통과** | **PASS**(무수정) — 설계 논점 6 대로 그리디+frontAnchor 가 TRUE 를 배정, NOISE 는 유일 후보 슬롯이 점유돼 미배정 + 폴리곤 밖 → 드롭. `filteredOut=1`·`kept=TRUE`·`plateY` 단언 전부 성립. **깨지지 않았으므로 삭제·수정 없음** |
| `lpdFilterRegression.test.ts` 전체 | 통과 | **PASS**(무수정) |
| `occupancyAnchor.regression.test.ts` R1~R7 | 픽스처 불변인 한 통과(R5b `it.fails` 포함) | **PASS**(무수정) — R5b 는 여전히 `it.fails` 로 **예상대로 실패 → 통과 처리** |
| `onPlaceFilter.test.ts` | 통과 | **PASS**(무수정) |
| `detectPipeline.test.ts` 기존 31건 | 통과 | **PASS**(무수정) — 가드가 기존 시나리오에서 **발동 0**(base 매칭 판과 ε 밖) |
| `detectCuboid.test.ts` 등 나머지 | 통과 | **PASS** — 전량(152 files) 그린 |

### 의미가 바뀐 기존 테스트 — 1건(단언·코드 무수정)

`lpdFilterRegression.test.ts:325` 의 서술 ":325 드롭은 의도" 의 **유효 범위가 좁아졌다**: 이제 "**차선 후보 슬롯이 없을 때만** 드롭"이다. 그 픽스처는 단일 차량(PARKED)이라 서술이 **여전히 참** → 재봉인 불요(설계 논점 6). 새로 생긴 성질(차선 폴백)은 그 파일을 건드리지 않고 **N4 가 독립 봉인**한다.

### R5b(`it.fails`) 현 상태 — 이번 범위 밖임을 명기

- `occupancyAnchor.regression.test.ts:192` `it.fails('R5b p1 겹침 없음 …')` 는 **손대지 않았다**.
- 설계 §7 명시대로 **픽스처가 구 서버 산출을 담는 한 자동으로 안 뒤집힌다** — `detect_cam1_p1.json` 은 구 알고리즘이 만든 `vehicles[].plate`(veh6 의 훔친 판 포함)를 그대로 담고 있고, 이번 수정은 그 **JSON 을 소비하는 뷰어 judge 경로가 아니라 그 JSON 을 생산하는 서버 경로**를 고쳤다. 따라서 R5b 는 계속 `overlapPairs=[[5,6]]` 로 실패 → `it.fails` 로 **통과 유지**(실측 확인).
- **양성 단언(`overlapPairs=[]`) 전환의 전제는 p1 픽스처 재동결**이며, 재동결은 설계 §5-5(goal/loop 라이브 성공 후) 단계다 — **이번 범위 밖**. 지시대로 픽스처·R5b 모두 무변경으로 남겼다.

---

## 6. 설계-구현 정합 확인(오프라인 재현)

설계 §5-2 는 `_qa_tiebreak_09.mjs`(설계용 기하 복제본)를 실코드 import 로 재실행해 §1 표의 **greedy/frontAnchor 열과 동일 출력**을 확인하라고 했다. **N1·N2·N3 이 실코드(`src/setup/plateMatch.js`)로 그 열을 그대로 단언**하므로 동등한 확인이 유닛 게이트 안에 들어갔다(별도 스크립트 불요):

```
설계 §1 표 greedy/frontAnchor    →  신규 테스트 단언(실코드)
p1: veh6<-p4 veh0<-p5 (6/7)      →  N1: m.size=6, m.get(6)===plates[4].quad, m.get(0)===plates[5].quad, !m.has(2)
p2: veh5<-p5 veh3<-p4 (6/6)      →  N2: m.size=6, m.get(5)===plates[5].quad, m.get(3)===plates[4].quad
p3: 구와 동일        (4/4)       →  N3: m.size=4, 4쌍 전부 일치
lpdFilter 합성: slot0 <- TRUE    →  N5(순서 [NOISE, TRUE] 로 강화) + lpdFilterRegression:332 무수정 통과
```

**남은 goal/loop 단계(설계 §5-3~5)** — 라이브 3프리셋 재검출·`overlapPairs` 수치·뷰어 스샷 육안·p1 픽스처 재동결·R5b 전환·셋업 1회 재실행 — 는 **미수행**(qa/오케스트레이터 이관).

---

## 7. 영향도 (구현 관점 — 상세는 설계 §6 / documenter)

| 영역 | 실측/판단 |
|---|---|
| 와이어 계약·DB 스키마·라우트 | **무변경**. `DetectPlate`/`DetectVehicle`/`DetectResult` shape 불변 |
| **관측 가능한 동작 변화** | 배정 결과가 달라진다(그것이 수정의 본체). `SetupOrchestrator.ts:218` 이 저장하는 슬롯별 번호판 prior 좌표가 교정됨 → **마이그레이션 불요**(파생 데이터·스키마 무변경), **배포 후 셋업 1회 재실행 권장**(설계 논점 5) |
| 매칭 수 | 줄지 않는다(maximal). 실측 p1 5→6, p2 5→6, p3 4→4 → `matched.size < built.length` 경고 빈도는 **감소만 가능** |
| 카메라 호출 수 | 감소 또는 동일. (A) 가 p1 veh6·p2 veh5 의 재시도 진입을 제거(왕복 −1회/차량), 가드는 루프 상한을 늘리지 않는다(G1 실측 5회) |
| 성능 | 정렬 O(K log K), K ≤ P·S ≤ ~40×40 — 마이크로초 대. 저빈도 on-demand |
| 가드 발동 시 실패 모드 | `plate:undefined` → judge `source:'bbox'` 강등(점유는 06/07 접지밴드가 유지, 사다리꼴만 '번호미인식'). 옆차 판으로 만든 틀린 사다리꼴보다 나은 실패(설계 논점 3) |
| 잔존 부채(기록만) | ① `Aggregator.ts:276` 규칙 이원화 — **별도 이슈**(주석에 명기) ② `FRONT_BIAS` 값 3곳 복제(§3) ③ ε=0.03 근거 표본 2개(설계 §7 — 라이브 관찰 항목) |

---

## 8. 검증자 인계

- **변경 파일**: `src/setup/plateMatch.ts` / `src/capture/detectPipeline.ts` / `src/capture/Aggregator.ts`(주석) / `test/plateMatch.test.ts` / `test/detectPipeline.test.ts`.
- **게이트 재현**: `cd SettingAgent && npx tsc -p tsconfig.json --noEmit && npx vitest run` → exit 0 / 152 files · 1686 tests.
- **중점 검토 요청**: ① 가드 판정을 **클램프 전** 좌표로 한 것(설계 §2C 준수)의 타당성 ② `FRONT_BIAS` 값 복제(§3 이탈 1)의 수용 여부 ③ N3/N6/N7/G3 이 대조군임을 전제로 한 판별력 평가.
- **미수행(범위 밖·설계 §5-3~5)**: 라이브 goal/loop 관찰, p1 픽스처 재동결, R5b `it.fails` → 양성 전환, 셋업 재실행.

---

## 9. 마감 — p1 픽스처 처리와 R5b 양성 전환 (goal/loop 성공 후 처리, 설계 09 §5-5 / §7)

> 근거: `11_qa_report_final.md`(라이브 전 항목 달성, p1 `overlapPairs=[]`). 본 절 수치는 전부 **본 세션 실측**.
> **소스 코드(`src/`) 변경 0줄** — 테스트·픽스처 층만 마감했다.

### 9-1. 결정: **교체가 아니라 병존** (설계 §5-5 "p1 재동결" 의 이행 형태 변경)

설계 §3 표·§5-5 는 `detect_cam1_p1.json` **교체(재동결)** 를 지시했다. 실측 결과 **교체가 정상 동작 중인 2층 봉인을 개작하게 만든다**는 사실이 드러나, 같은 목적(R5b 양성 전환)을 부작용 없이 달성하는 **병존**으로 이행했다. 설계 §7 리스크 표의 "재동결 시 R1~R7 단언 어긋남 → **어긋나면 재동결 보류·원인 격리**" 지침의 적용이다(본 건은 R군이 아니라 **N군**이 어긋났다 — 설계가 예측하지 못한 경로).

**픽스처 구성(최종)**

| 파일 | 출처 | 쓰임 |
|---|---|---|
| `detect_cam1_p{1,2,3}.json` | 구 서버 `_qa_data_iter3` (**무변경**) | R1~R7 의 **1층(앵커) 봉인** + `plateMatch.test.ts` N1/N2/N3 의 **matcher 입력** |
| **`detect_cam1_p1_fixed.json`** (신규) | **수정 서버 라이브** `_qa_data_final2/detect_cam1_p1.json` 무가공 복사 | **R5b 전용** — 2층 수정의 뷰어 레벨 귀결 봉인 |

`place_roi.json` 은 구/신이 **의미 동일**(`JSON.stringify` 동등, 바이트 차이만) → 1종 유지.

### 9-2. 병존을 택한 실측 근거 (교체를 기각한 이유)

**① 판별력은 교체해도 보존된다 — 즉 이것은 기각 사유가 아니다.** 신규 픽스처 + **구 judge**(= `web/core.js:computeOccupancy`, 1층 plate 중심 point-in-polygon. R6 이 `legacy` 경로로 여전히 실행) 실측:

```
[구 judge] p1 미점유=[5]   p2 미점유=[10]   p3 미점유=[17]     ← 구 픽스처와 **완전 동일**
[신 judge] p1 occ=[1..7] regions=7/7 overlapPairs=[]  R4 slot5←veh0 slot6←veh6 slot7←veh5
```
1층 결함(plate 중심 시차)은 서버가 아니라 **뷰어 매칭** 문제라 데이터 vintage 와 무관하게 재현된다 — 지시의 예측대로다. **R1~R7 은 신규 픽스처로도 판별력을 유지**한다.

**② 그러나 픽스처는 이중 역할이고, 교체는 2층 봉인(N1)을 개작시킨다 — 이것이 결정적 기각 사유.**

- R군은 이 파일을 **서버 산출**(`vehicles[].plate`)로 소비하고, N1/N2 는 **같은 파일**을 `matchPlatesToSlots` 의 **입력**(`vehicles[].rect` + `plates[]`)으로 소비한다.
- 수정 서버 재검출에서 **VPD 차량 반환 순서가 바뀌었다** — p1 은 7대 중 **5대가 재색인**(실측):

```
OLD veh1 → NEW veh3 | OLD veh2 → NEW veh1 | OLD veh3 → NEW veh2 | OLD veh4 → NEW veh5 | OLD veh5 → NEW veh4
(rect 거리 ≤0.0033 = 동일 차량. 좌표가 아니라 배열 위치만 바뀜)
```
- 그 결과 N1 이 단언하는 매핑이 통째로 이동한다:

```
OLD: veh6←plates[4] veh0←plates[5] veh1←plates[0] veh4←plates[1] veh5←plates[2] veh3←plates[3] **veh2 미귀속**
NEW: veh6←plates[4] veh0←plates[5] veh3←plates[0] veh4←plates[1] veh2←plates[2] veh5←plates[3] **veh1 미귀속**
```
→ 교체 시 **N1 단언 5개 + 진단 08 실측 서술(동률 847.7px²·상대 veh4)** 이 재작성 대상. 정상 동작·정확한 2층 봉인의 **불필요한 개작**(CLAUDE.md 규칙 3 위반)이며, **진단 08 이 분석한 바로 그 장면과의 추적성**을 잃는다. 단언을 산출에 맞춰 고쳐 쓰는 과정 자체가 위장 위험이기도 하다.

**③ R5b 는 수정 서버 산출이 반드시 필요하다.** 구 픽스처의 `vehicles[6].plate` = 옆차에서 훔친 판 `(1367,676) recovered:true` 는 **수정 서버가 더는 생성하지 않는 값**이라, 구 픽스처로는 2층 수정의 귀결을 원리적으로 표현할 수 없다.

→ **결론**: 각 픽스처를 **그것이 증거인 대상에만** 쓴다. 구 픽스처 = 1층 봉인 + 진단 08 장면의 matcher 입력, 신규 픽스처 = 2층 수정의 산출. 교체가 주는 이득 0, 비용(N1 개작·추적성 상실) 有.

### 9-3. R5b 전환 후 **판별력 확인** (위장 방지 — 지시 3)

`it.fails` 제거 → 양성 단언 전환. **구 픽스처(`_qa_data_iter3`)를 주입해 FAIL 을 실측**했다:

```
$ (R5b 의 regionsFor(1, DETECT_P1_FIXED) → regionsFor(1, DETECT[1]) 로 일시 치환 후)
$ npx vitest run test/occupancyAnchor.regression.test.ts -t "R5b"
 → *** FAIL ***  AssertionError: expected [] to deeply equal [ [ 5, 6 ] ]
    at test/occupancyAnchor.regression.test.ts:222  expect(overlapPairs).toEqual([])
 Tests  1 failed | 15 skipped
```
**판별력 있음 ✅** — 구 데이터로 정확히 `[[5,6]]` 재현. 치환은 확인 후 원복(현재 파일은 `DETECT_P1_FIXED` 사용).

**공허한 통과 방지**: `overlapPairs=[]` 는 사다리꼴 모집단이 비면 **자동으로 참**이 된다. 이를 막기 위해 R5b 에 두 단언을 함께 넣었다 — ① `regions.length === 7`(모집단 유지), ② `vehicles[6].plate.recovered === false`(원인 층에서 결함 본체 소멸 확인). 위 반증 실행에서 ①이 먼저 통과하고 ②의 `overlapPairs` 에서 실패한 것이, 그 FAIL 이 **모집단 붕괴가 아니라 진짜 겹침**임을 증명한다.

### 9-4. 봉인 유지 확인 (지시 2·4)

| 층 | 봉인 | 상태 | 근거 |
|---|---|---|---|
| **1층**(앵커·뷰어 judge) | R1~R7 | **유지** — 전량 PASS, 픽스처 **무변경** | 구 judge 가 구/신 데이터 모두에서 `[5]/[10]/[17]` 미점유 → 판별력 실측 확인(9-2 ①) |
| **2층**(matcher·서버) | `plateMatch.test.ts` N1/N2/N4 | **독립 유지** — 파일·픽스처 **양쪽 다 무변경**(내가 건드리지 않았다) | 병존 선택으로 N군 입력이 그대로다. 판별력 실측: p1 신 `6/7` vs 구 `5/7` ✅ / p2 신 `6/6` vs 구 `5/6` ✅ (N4 는 합성 — 구 size 1 vs 신 size 2) |
| **2층**(뷰어 귀결) | R5b | **양성 전환 완료** | 9-3 반증으로 판별력 확인 |

2층 봉인은 `plateMatch.test.ts`(matcher 단위) + R5b(뷰어 귀결) **두 층에서 독립적으로** 걸린다 — 픽스처 재동결로 함께 사라지는 일은 없다(애초에 재동결을 하지 않았고, N군 입력과 R5b 입력이 **서로 다른 파일**로 분리됐다).

### 9-5. 게이트 실측

```
$ cd SettingAgent
$ npx tsc -p tsconfig.json --noEmit      → exit 0
$ npx vitest run                          → Test Files 152 passed (152)
                                             Tests     1686 passed (1686)   Duration 10.66s
```
**기준선 152 files / 1686 tests 대비 증감 0.** R5b 는 `it.fails`(실패해야 통과) → 양성(통과해야 통과)로 **의미만** 뒤집혔고 테스트 **개수는 불변**이라 총계가 유지된다. 개수가 그대로인 것이 정상이며, 실제 전환은 위 §9-3 반증으로 확인된다.

지명 확인(`--reporter=verbose`): `R1 R2 R3 R4 R5 R5b R6 R7` + `N1~N7` + `A1~A7` **27/27 PASS**.

### 9-6. 변경 파일 (마감분)

| 파일 | 변경 |
|---|---|
| `test/fixtures/occupancyAnchor/detect_cam1_p1_fixed.json` | **신규** — `_qa_data_final2/detect_cam1_p1.json` 무가공 복사(수정 서버 라이브 산출) |
| `test/occupancyAnchor.regression.test.ts` | R5b `it.fails` → **양성 단언** 전환(+모집단·recovered 단언) / `regionsFor(preset, detect)` 헬퍼 분리(기존 `regionsOf` 는 위임으로 유지 — 타 테스트 무영향) / R군 픽스처 병존 사유 주석 |
| `test/fixtures/occupancyAnchor/detect_cam1_p{1,2,3}.json` | **무변경**(병존 결정) |
| `test/plateMatch.test.ts` | **무변경**(2층 봉인 그대로) |

### 9-7. 미수행·잔존

- **셋업 1회 재실행**(설계 논점 5 운영 절차) — 미수행. 운영 판단 필요(코드·테스트 범위 밖).
- p2 픽스처는 구 서버 산출(`veh5.plate recovered:true`)을 유지한다. 수정 서버에선 `recovered:false` 지만(검증 11 §2), **어떤 단언도 p2 의 recovered 를 보지 않으므로** 교체는 순수 churn 이라 하지 않았다(규칙 3). p2 의 2층 봉인은 N2 가 matcher 층에서 담당한다.
- 설계 06 §6 이 예고한 "R5b 를 R5 겹침 테스트로 **통합**" 은 하지 않았다 — R5(p2·p3, 구 픽스처)와 R5b(p1, 신규 픽스처)는 **입력 픽스처가 달라** 한 루프로 합칠 수 없다. 프리셋이 분리돼 중복 단언은 0.
