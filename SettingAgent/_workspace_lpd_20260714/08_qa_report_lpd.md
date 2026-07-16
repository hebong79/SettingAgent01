# 08. 검증(2차 증분, 독립 검증자) — LPD 번호판 주차면 필터

**대상**: `06_architect_plan_lpd.md`(설계) / `07_developer_changes_lpd.md`(구현) / `src/capture/onPlaceFilter.ts` 외.
**규칙**: `keepPlate(p) = (유지된 VPD 차량에 귀속: matchPlatesToSlots) OR (번호판 중심 ∈ 주차면 폴리곤)`
**입장**: 구현자 보고를 신뢰하지 않고 게이트를 재실행했고, 설계서의 «증명» 2건을 **반증하려 시도**했다.

---

## 1. 게이트 재실행 (있는 그대로)

```
$ npx tsc -p tsconfig.json --noEmit
TSC_EXIT=0                                  # 출력 없음 — 구현자 보고와 일치

$ npx vitest run                            # 내 테스트 추가 **전**
 Test Files  133 passed (133)
      Tests  1469 passed (1469)             # 구현자 보고(133/1469)와 정확히 일치

$ npx vitest run                            # 내 테스트 추가 **후**
 Test Files  134 passed (134)
      Tests  1478 passed (1478)  →  1479 passed (1479)   # +10 (내가 추가)
TSC_EXIT=0
```

구현자의 게이트 보고는 **사실이었다**(과장·은폐 없음).

---

## 2. 설계서 §6 유닛테스트 항목 대조 — **누락 없음**

| 항목 | 위치 | 상태 |
|---|---|---|
| P1~P7 (onPlaceFilter) | `test/onPlaceFilter.test.ts:219~311` | ✅ 7건 전부 존재 |
| **★ P4 거대 병합 박스 → 정확히 1건 봉쇄** | `test/onPlaceFilter.test.ts:260` | ✅ **존재**(마스터 지정 필수 2건 중 1) |
| **★ P2 VPD 미검출 주차차 번호판이 (B)로 생존** | `test/onPlaceFilter.test.ts:242` | ✅ **존재**(필수 2건 중 2) |
| **★ C2 위 항목의 DB 끝단 봉인** | `test/captureJobOnPlace.test.ts:243` | ✅ 존재 |
| D1~D6 (detectPipeline) | `test/detectPipeline.test.ts:243~296` | ✅ 불변식·모드A/B·recovered·강등 |
| C1/C3 (CaptureJob) | `test/captureJobOnPlace.test.ts:230/258` | ✅ 동결 픽스처 사용 |
| R1/R2 (captureRoutes 경계면) | `test/captureRoutes.test.ts:648~680` | ✅ typeof number + 불변식 |

→ 마스터가 "반드시 존재해야 한다"고 지정한 2건은 **이미 있었다**. 추가 작성 불요.
**내가 추가한 것**은 설계서가 «증명했다»고 주장한 무회귀 2건의 **반증 시도**다(§3·§4).

---

## 3. ★ 점유 무회귀 — **반증 시도 결과: 반례 발견(주장은 일반적으로 거짓)**

신규 `test/lpdFilterRegression.test.ts` (9건). 소비처 union 은 **web/core.js 를 직접 import** 해 이중구현을 피했다:
`[...detect.plates, ...detect.vehicles.map(v=>v.plate).filter(Boolean)]` (web/app.js:335 · core.js:585 동일 식).

### 3.1 설계서가 옳은 부분 (봉인 완료)

S1~S4 전부 **모드A 점유 === 모드B 점유**:
- S1 주차차+통행차 → 통행차 번호판 드롭되지만 점유 동일
- S2 (B항) VPD 미검출 → 폴리곤 안 번호판 생존 → 점유 유지(**뒤집힘 방지 성공**)
- S3 (A항) kept 차량 안·폴리곤 밖 번호판 → 유지되나 점유 기여 없음
- S4 (V-1) 거대 병합 박스 + 배경 번호판 5개 → 1건만 통과, 점유 동일

### 3.2 ★★ 반례 (설계서 §1 헤드라인 «점유 불변»은 **거짓**)

**근인: 중심 정의가 서버와 프론트에서 다르다.**

| | 정의 | 위치 |
|---|---|---|
| 서버 필터 (B)항 | `center(quadBoundingRect(quad))` = **bbox 중심** | `onPlaceFilter.ts:85` |
| 프론트 점유 판정 | `quadCentroid` = **4점 산술평균** | `web/core.js:434` |

→ **4점평균 ∈ 폴리곤 · bbox중심 ∉ 폴리곤** 인 quad 는 서버가 **드롭**하는데 프론트 기준으론 **점유를 참으로 만들 수 있었다** → 점유가 `true → false` 로 **뒤집힌다**.

```
반례 quad(비아핀 스파이크): [(0.40,0.31), (0.44,0.31), (0.42,0.31), (0.42,0.80)]
  4점평균 y = 0.4325  → BACK_ROW(y 0.30~0.45) 안  → 모드B 점유 true
  bbox중심 y = 0.555  → BACK_ROW 밖             → 모드A 드롭 → 점유 false
```
→ 테스트가 `occA ≠ occB` 를 **단언**한다(`lpdFilteredRegression.test.ts` ★★ 반례).

### 3.3 반례의 **실무 도달 가능성** — 좁다 (정량화)

| 조건 | 이격 | 결론 |
|---|---|---|
| **아핀 quad**(회전사각형/평행사변형 OBB) | **정확히 0** (24개 각도 lemma 테스트로 봉인) | 이 경우 «점유 불변»은 ε 없이 **엄밀히 참** |
| 원근(키스톤) 왜곡 번호판 | `< 0.005` 정규화 (1080p 기준 수 px) | 번호판 중심이 폴리곤 경계 **±0.005 이내**일 때만 뒤집힘 |

**평가**: 설계서 §7-1 이 이를 "ε 예외"로 **정직하게 명시**했으므로 은닉은 아니다. 다만 §1 의 굵은 글씨 «`computeOccupancy` 결과는 필터 전후 동일하다(불변)»는 **그대로는 참이 아니다** — "아핀 quad 에 한해" 라는 단서가 필요하다. 후속 과제 **P-1**(중심 정의 통일)은 미용이 아니라 **이 주장을 참으로 만드는 작업**이다.

---

## 4. ★ Aggregator 무회귀 (설계서 §2 / 질문6) — **반증 시도 결과: 반례 발견**

### 4.1 "손실 0"은 **참**
kept 차량 rect **밖** 번호판(통로 번호판)을 상류에서 지워도 `aggregate()` 산출 **완전 동일**(`toEqual`). 설계서대로.

### 4.2 ★★ "산출 불변"은 **거짓** — granularity 불일치

| | 규칙 | 진 번호판의 운명 |
|---|---|---|
| 상류 `matchPlatesToSlots` | **검출 1건 단위** 경쟁(차량당 1개) | **드롭** |
| 하류 `Aggregator` | **클러스터 대표 단위** 매칭 | 드롭되지 않고 **승자 클러스터에 병합** → robust median 을 끌어당김 |

→ 한 kept 차량 rect 안에 번호판 2개가 있고 서로 `clusterDist`(0.06) 안이면, 상류가 진 쪽을 지우는 순간 **하류 대표 좌표가 이동한다**. 설계서의 "상류가 버리는 것 = 하류도 버렸을 것"은 **성립하지 않는다**(하류는 버리지 않고 *섞는다*).

**실측(테스트 봉인)**: 진짜 번호판(폴리곤 안, y중심 0.335) + 근접 오검출(폴리곤 밖, y중심 0.29, 거리 0.045 < clusterDist)

```
모드B(미필터)  plateY = 0.3005   ← 오검출에 오염된 중앙값
모드A(필터)    plateY = 0.323    ← 진짜 번호판 실좌표와 정확히 일치
차이 0.0225 정규화 ≈ 1080p 기준 24px  →  AggregatedSlot → Finalizer → parking_slots.lpdJson 에 그대로 전파
```

**방향은 개선이다**: 모드A 값이 **정답**(진짜 번호판 좌표), 모드B 값이 오염된 값. 슬롯 손실 0, 차량 대표 rect·support·occupancyRate·status **완전 동일**.

**결론**: `Aggregator.ts`/`Finalizer.ts` **무변경 결정은 옳다**(코드 수정 불요). 그러나 설계서 §2 의 "`aggregate()` 산출은 **불변**" 문장은 **사실과 다르다** → 모드A/모드B 런의 `lpdJson` 을 동일하다고 가정하는 후속 코드·비교는 **틀린다**. 문서 정정 필요.

---

## 5. 경계면 교차 비교 — **정합(구현자 판단이 옳다)**

| 필드 | 서버 | 프론트 소비 | 판정 |
|---|---|---|---|
| `summary.lpdFilteredOut` | `DetectResult.summary` **필수 number** (`detectPipeline.ts:76`) | `cap-msg`: `${s.lpdCount - s.lpdFilteredOut}/${s.lpdCount}` (app.js:577) | ✅ 항상 존재 → **NaN 위험 없음**. 불변식 `plates.length === lpdCount − lpdFilteredOut` 을 라우트·파이프라인·**라이브**에서 모두 확인(12−8=4 ✓) |
| `CaptureStatus.lpdFilteredOut` | **옵셔널**, `> 0` 일 때만 노출(`CaptureJob.ts:165`) | 배지: `status.lpdFilteredOut ?? 0` (app.js:1444) | ✅ 미노출 → 0 표기 |

### ★ 구현자의 계획 이탈(배지 falsy 가드 OR 확장) — **검증 결과 옳다. 봉인 추가.**
구현자는 `status.vpdFilteredOut ? …` → `status.vpdFilteredOut || status.lpdFilteredOut ? …` 로 확장했다(07 §3).
그 확장이 **필요한 상태가 실제로 도달 가능한지** 아무 테스트도 증명하지 않고 있었다 → **C4 를 추가**(`test/captureJobOnPlace.test.ts`):

> VPD 가 주차차만 검출(차량 제외 **0건** → `vpdFilteredOut` **미노출**) + LPD 가 통로 번호판까지 검출(번호판 제외 **1건**)
> → 구 가드였다면 `undefined ? …` = falsy → 괄호가 통째로 사라져 **`lpdFilteredOut` 이 관측 불가**(조용한 정보 손실).

이 상태는 **도달 가능**하다(테스트로 실증). 구현자의 이탈은 **정당하며 필수적**이었다.

---

## 6. ★ 라이브 경험적 검증 (설계서 §7-7 "성공 판정의 본체") — **수행함. 두 조건 모두 충족.**

구현자가 "수행하지 않았다"고 명시한 항목이다. 서비스가 모두 가동 중이어서(SettingAgent 13020 / 카메라 13110 / VPD 9081 / LPD 9082) **실제로 돌렸다**.
프론트와 **동일한 계산**(`web/core.js` 의 `computeOccupancy`·`normalizePtzCamRoi` 직접 import + app.js 와 동일한 union)으로 `cam1:preset3` 모드A/모드B 를 3회 반복 비교:

```
trial 1: A점유=[14,15,16,17] B점유=[14,15,16,17]  lpd 12->4 (제외 8)  vpd 15->5  OK 무회귀
trial 2: A점유=[14,15,16,17] B점유=[14,15,16,17]  lpd 12->4 (제외 8)  vpd 15->5  OK 무회귀
trial 3: A점유=[14,15,16,17] B점유=[14,15,16,17]  lpd 12->4 (제외 8)  vpd 15->5  OK 무회귀
```

| §7-7 성공 조건 | 결과 |
|---|---|
| ① 뒷줄 번호판이 실제로 사라지는가 (`lpdFilteredOut > 0`) | ✅ **12건 중 8건 제외** — 마스터 스크린샷의 노란 번호판 quad 증상 **해소** |
| ② 점유 면 수가 필터 전과 동일한가 | ✅ **[14,15,16,17] 4면, 3회 모두 동일** — 점유 회귀 **0** |

→ §3.2 의 반례는 **실 LPD quad 에서는 발동하지 않았다**(3회 시행). 반례는 실재하나 **좁다**는 §3.3 정량화와 일치.

⚠️ 단서: 모드A/모드B 는 **별개의 라이브 캡처**다(VPD/LPD 는 프레임마다 비결정적). 동일 프레임 A/B 가 아니므로 quad 단위 대조는 무의미하고, **점유 집합 일치**만이 유효한 지표다. `recovered` 가 A=1 / B=3 으로 다른 것은 모드B 가 차량을 더 많이 유지해 zoom 재시도를 더 도는 정상 동작이다(회귀 아님).

---

## 7. 발견 버그

**구현 버그: 없음.** 구현은 설계서를 충실히 따랐고, 계획 이탈 1건(배지 OR 가드)은 **옳았다**(§5).
발견된 2건은 전부 **설계서의 주장 과장**이며 코드 수정을 요하지 않는다:

| # | 내용 | 심각도 | 조치 |
|---|---|---|---|
| **D-1** | §1 «점유 불변» — 아핀 quad 에 한해서만 참. 비아핀 quad + 중심이 폴리곤 경계 ±0.005 이내면 점유가 뒤집힌다(반례 봉인). | **낮음**(라이브 3회 미발동, 실 OBB 는 아핀에 근접) | 문서 정정 + **P-1**(중심 정의 통일)을 "미용"이 아닌 **정합성 과제**로 승격 권고 |
| **D-2** | §2 «aggregate() 산출 불변» — 거짓. 상류(검출 단위 드롭) ↔ 하류(클러스터 병합) granularity 불일치로 `plateX/Y/W/H/plateQuad` 가 이동(실측 24px). 방향은 **개선**. | **낮음**(손실 0·개선 방향) | 문서 정정. `Aggregator`/`Finalizer` 코드는 **무변경 유지가 옳다** |

---

## 8. 봉인하지 못한 것 (은닉 금지)

1. **`web/app.js` DOM 렌더 자체**: `renderCaptureStatus` 배지 문자열·`cap-msg` 문자열은 DOM 의존이라 테스트 하네스가 없다(기존에도 없음). C4 로 **데이터(status shape)** 는 봉인했으나 **렌더 결과 문자열**은 미봉인.
2. **ε 반례의 런타임 관측 불가**: 4점평균은 폴리곤 안인데 bbox중심이 밖이라 드롭되는 번호판이 발생해도 **경고가 없다**. 조용히 점유가 뒤집힌다. → 드롭 시 "폴리곤 경계 근방" 여부를 warn 하는 가드를 권고(선택).
3. **설계서 §7-4 (A·B 동시 실패)**: VPD 미검출 + 번호판 중심이 폴리곤 밖 → 드롭(점유 뒤집힘). 관측 불가·미봉인(설계서도 인정).
4. **`matchPlatesToSlots` 동점 처리**: 여러 번호판이 kept 차량 rect 안에 **완전히** 들어가 겹침이 같으면 `overlap > bestOverlap`(strict) 이라 **배열 순서상 첫 번째**가 이긴다. 거대 병합 박스에서 "어느 1건이 살아남는가"는 **LPD 응답 순서 의존**(응답별로는 결정적, 원리적으로는 임의). 설계는 "정확히 1건"만 약속하므로 위반은 아니나 봉인하지 않았다.
5. **라이브는 `preset3`·3회·단일 장면**: 다른 프리셋/시간대/차량 배치에서의 점유 무회귀는 미확인.
6. 라이브 검증은 런타임 `data/Place01/PtzCamRoi.json` 을 썼다(서버가 쓰는 그 파일 — 라이브 검증에선 이것이 옳다). **유닛테스트는 전부 동결 픽스처** `test/fixtures/PtzCamRoi.unity.json` 만 사용(HANDOFF §2-2 준수).

---

## 9. 산출물

| 파일 | 내용 |
|---|---|
| `test/lpdFilterRegression.test.ts` | **신규 9건** — 점유 무회귀 반증(S1~S4 + ★★반례 + 아핀 lemma + ε 정량화), Aggregator 무회귀 반증(A1 + ★★반례) |
| `test/captureJobOnPlace.test.ts` | **C4 추가 1건** — 배지 OR 가드가 필요한 상태(`vpdFilteredOut` 미노출 + `lpdFilteredOut>0`)의 도달 가능성 봉인 |

**최종 게이트**: `tsc --noEmit` exit 0 · `vitest run` **134 files / 1479 tests 전량 통과**.
