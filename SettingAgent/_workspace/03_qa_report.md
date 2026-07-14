# 03. 검증 — VPD 검출 모드 2종(주차면 위 차량만 / 모든 차량)

계획서 §6 의 **18개 항목 전부**를 vitest 로 작성·실행했다. 외부 REST(카메라/VPD/LPD)는 전량 모킹.

---

## 1. 게이트 실행 결과 (있는 그대로)

```
npx tsc -p tsconfig.json --noEmit   → TSC_EXIT=0
npx vitest run                      → Test Files  133 passed (133)
                                      Tests       1456 passed (1456)
```

| | 구현자 인계 시점 | 검증 후 | 증분 |
|---|---|---|---|
| Test Files | 131 | **133** | +2(신규 파일) |
| Tests | 1412 | **1456** | **+44**(신규 케이스) |

**실패 0건. 기존 테스트 회귀 0건**(기존 파일은 §6 증분 케이스 **추가**만 했고 기존 단언은 1줄도 고치지 않았다).

---

## 2. 작성한 테스트 — §6 항목 매핑

### 2.1 `test/onPlaceFilter.test.ts` (신규, 21케이스) — 순수 규칙

| §6 | 케이스 | 결과 |
|---|---|---|
| **1** | 주차차: 접지 밴드가 폴리곤 내부 → `keep` | ✅ |
| **★2** | **통행차 → `drop`** (아래 §3 상세) — 3케이스로 분해: ①중심이 폴리곤 **안**임을 `pointInPolygon` 으로 **먼저 증명** ②접지 밴드가 통로임을 좌표로 증명 ③규칙 결과 = `drop` | ✅ |
| **★2** | 주차차+통행차 혼재 → 주차차만 생존, `filteredOut=1` | ✅ |
| **3** | 겹침비 0.10(<0.15) → `drop` / **같은 형상에서 0.30 으로만 키우면 `keep`**(임계가 실제로 판정을 가름) | ✅ |
| **★4** | **다중 폴리곤 OR**: 자기 칸만 주면 `drop`(=배정 규칙이었다면 이 차를 잃는다) → **옆 칸을 함께 주면 `keep`**. 폴리곤 순서 무관 | ✅ |
| **5** | 강등 `null`/`undefined`/`[]` → `degraded=true`, 전량 통과, `filteredOut=0`. `kept` 는 입력 배열의 **복사본**. 정상 폴리곤 시 `degraded=false` | ✅ |
| **6** | 퇴화 rect(`h=0`/`w=0`/둘 다) → throw 없이 `false`. 필터에선 "제외"로 집계(강등 아님) | ✅ |
| **7** | `groundBand` 좌표(**`toBeCloseTo`** — 구현자 경고 반영), 밴드 하단=rect 하단, 밴드 높이=`h×0.25`, 상수 계약(`0.25`/`0.15`) | ✅ |

### 2.2 `test/captureJobOnPlace.test.ts` (신규, 7케이스) — 정밀수집 배선

픽스처는 **동결 `test/fixtures/PtzCamRoi.unity.json`**. 런타임 `data/Place01/PtzCamRoi.json` **미사용**(HANDOFF §2-2).
좌표는 픽스처에서 **파생**한다(폴리곤 무게중심에 접지 밴드를 얹음 → 하드코딩 0, 픽스처가 바뀌면 테스트도 따라감).

| §6 | 케이스 | 결과 |
|---|---|---|
| — | 전제 확인: 파생된 `PARKED`/`PASSING` 이 실제로 on/off-place 임을 먼저 단언(공허한 테스트 방지) | ✅ |
| **8** | 픽스처 + VPD[주차차,통행차] → `insertDetections` vehicle **1건** + `status.vpdFilteredOut=1` + 강등 아님 | ✅ |
| **9** | `vpdOnParkingOnly:false` → vehicle **2건**(모드B 회귀 0), `vpdFilteredOut` **미노출** | ✅ |
| **10** | `placeRoiFile` 미주입 → **2건 전량** + `vpdOnPlaceDegraded='주차면 파일 없음/로드 실패'` + `vpdFilteredOut` 미노출 | ✅ |
| **10** | 존재하지 않는 경로 → 동일 강등(throw 없음) | ✅ |
| **10** | 파일은 있으나 **해당 프리셋 주차면 0개**(preset 9) → `'프리셋 1:9 주차면 0개'` — **파일 부재와 구별되는 사유**(구현자가 계획에서 벗어나 추가한 `degradeReason` 의 정당성 확인) | ✅ |
| **11** | LPD: 모드A/B 모두 plate **2건 불변**, 차량만 1↔2로 변함 | ✅ |

### 2.3 `test/detectPipeline.test.ts` (증분 +8케이스) — 라이브 검출

| §6 | 케이스 | 결과 |
|---|---|---|
| **12** | `{onlyOnPlace:true, polys}` → 통행차 제외, `onPlaceOnly=true`, `filteredOut=1`, `vpdCount=2`(**필터 전** 원 검출), 계약 `vehicles.length = vpdCount − filteredOut` | ✅ |
| **12b** | 필터 후 **번호판 매칭 인덱스 정합**(축소된 vehicles 로 `matchPlatesToSlots` — 인덱스가 밀리면 깨짐) | ✅ |
| **★13** | **카메라 호출 절감**: 모드A → `requestImage` **1회(base 만)** | ✅ |
| **★13b** | **대조군**: 같은 입력·모드B → **5회**(base + 통행차 zoom 재시도 4회). 절감이 실재함을 대조로 증명 | ✅ |
| **14** | `{onlyOnPlace:true, polys:null}` → 전량 통과 + `onPlaceOnly=false` + `onPlaceDegraded='주차면 폴리곤 없음'`(기본 문구) | ✅ |
| **14b** | `polys:[]` + `degradeReason` 지정 → 호출측 문구 그대로 | ✅ |
| **15** | `{onlyOnPlace:false}` + 폴리곤 존재 → 필터 자체를 건너뜀(강등 아님) | ✅ |
| **15b** | **3인자 호출(기존 계약)** → `onPlaceOnly=false`, `filteredOut=0`, `onPlaceDegraded` **키 자체가 없음** | ✅ |

### 2.4 `test/captureRoutes.test.ts` (증분 +8케이스) — REST 경계

| §6 | 케이스 | 결과 |
|---|---|---|
| **16** | `POST /capture/start {vpdOnParkingOnly:false}` → zod 통과 + `job.start` 전달 + status 관측 | ✅ |
| **16b** | start 미지정 → 기본 모드A(`status.vpdOnParkingOnly=true`) | ✅ |
| **16c** | 비불리언(`'yes'`) → **400**(zod) | ✅ |
| **★17** | `POST /capture/detect` 모드 미지정 + `placeRoiFile`(동결 픽스처) → **기본 true 로 필터 적용**(vehicles 1건, `filteredOut:1`) | ✅ |
| **18** | `POST /capture/detect {vpdOnParkingOnly:false}` + 픽스처 → 전량 통과(2건), 강등 아님 | ✅ |
| **18b** | 주차면 없는 프리셋(9) → `'프리셋 1:9 주차면 0개'` | ✅ |
| **★경계면** | detect `summary` ↔ `web/app.js` 소비 계약 | ✅ |
| **★경계면** | `GET /capture/status` ↔ `app.js` 배지 계약 | ✅ |

---

## 3. ★ §6-2 가 봉인한 것 (설계 결정의 회귀 방어)

이 테스트는 단순히 "통행차가 걸러진다"를 확인하지 않는다. **중심 규칙(대안 a)이었다면 이 차가 통과했을 것**임을 같은 테스트 안에서 **먼저 증명**한다.

```
BACK_ROW(뒷줄 바닥 quad) = (0.30,0.30) (0.56,0.30) (0.58,0.45) (0.28,0.45)   // 통로 = y > 0.45
PASSING(통행차 bbox)     = x 0.32~0.52, y 0.28~0.60   // 지붕 0.28(뒷줄 위) ~ 접지 0.60(통로)

① center(PASSING) = (0.42, 0.44)  →  pointInPolygon(BACK_ROW, center) === true   ← 중심규칙: keep(오답)
② groundBand(PASSING).y = 0.52 > 0.45                                            ← 접지 밴드는 통로
③ isVehicleOnPlace(PASSING, [BACK_ROW]) === false                                ← 채택안 d: drop(정답)
```

①이 깨지면(=중심이 폴리곤 밖이면) 이 테스트는 **공허해진다**. 그래서 ①을 명시적 단언으로 고정했다.
누군가 규칙을 `center ∈ polygon` 으로 "단순화"하면 ③이 즉시 실패한다 — **설계 결정이 회귀로부터 봉인됐다.**

§6-4(다중 폴리곤 OR)도 같은 방식으로 **"자기 칸만 주면 drop, 옆 칸을 함께 주면 keep"** 을 대조로 단언해 *배정이 아니라 필터*임을 봉인했다.

---

## 4. 경계면 교차 비교 (서버 응답 shape ↔ 프론트 소비)

**불일치 0건.** 구현자에게 보고할 사항 없음.

| 서버 산출 | 필드 | 프론트 소비 | 정합 |
|---|---|---|---|
| `runDetect().summary` (`detectPipeline.ts:289-296`) | `vpdCount`, `filteredOut`, `onPlaceOnly`, `onPlaceDegraded?` | `web/app.js:574-578` `runLiveDetect` — `검출 ${s.vpdCount - s.filteredOut}/${s.vpdCount}대 · 주차면필터 ${s.onPlaceOnly?'ON':'OFF'}[ — 강등: ${s.onPlaceDegraded}]` | ✅ 4/4 |
| `CaptureStatus` (`types.ts:143-148`, `CaptureJob.getStatus():160-162`) | `vpdOnParkingOnly?`, `vpdFilteredOut?`, `vpdOnPlaceDegraded?` | `web/app.js:1437-1443` `renderCaptureStatus` 배지 | ✅ 3/3 |
| `POST /capture/start` `StartBodySchema` (`captureRoutes.ts:44`) | `vpdOnParkingOnly?` | `app.js:1634` `capStart` body | ✅ |
| `POST /capture/detect` `DetectBodySchema` (`captureRoutes.ts:66`) | `vpdOnParkingOnly?` | `app.js:569` detect payload | ✅ |
| `web/index.html:167` `#cap-vpd-onplace` (`checked`) | — | `app.js` 가 `$('cap-vpd-onplace').checked` 로 2곳에서 참조 | ✅ id 일치 |

**옵셔널 키의 falsy 가드까지 대조했다**(조용한 `undefined` 표시 방지):
- `vpdFilteredOut` 은 **0이면 키 자체가 없다**(조건부 스프레드) ↔ app.js 는 `status.vpdFilteredOut ? '(제외 N대)' : ''` 로 falsy 가드 → 정합. **테스트로 고정**(start 직후 status 에 키 부재 단언).
- `vpdOnParkingOnly` 는 `runId` 정의 시에만 노출 ↔ app.js 는 `!== undefined` 게이트 → 정합. **테스트로 고정**(start 전 키 부재 / start 후 boolean).
- `onPlaceDegraded` 는 강등 시에만 노출 ↔ app.js 는 삼항 → 정합.

---

## 5. 발견한 버그 / 수정 내역

**구현 버그 0건.** 소스 코드는 1줄도 고치지 않았다.

검증 중 **테스트 측** 함정 2건을 만나 테스트를 고쳤다(둘 다 구현 결함 아님 — 재발 방지를 위해 기록):

1. **부동소수(구현자가 §5 에서 경고한 바로 그것, 다른 위치에서 발생)**
   `center()` 결과에 `toEqual({cx:0.42, cy:0.44})` 를 썼다가 실패 — 실제값 `0.42000000000000004`. `toBeCloseTo` 로 수정.
   → 구현자 경고는 `groundBand` 만 지목했으나, **`center()` 에도 동일하게 적용**된다.

2. **microtask flush 로는 모드A 라운드 완료를 기다릴 수 없다**
   기존 `captureJob.test.ts` 의 `for(20) await Promise.resolve()` 패턴을 그대로 썼더니 **파일 I/O 를 하는 케이스만** 검출 0건으로 오탐했다. 모드A 는 `loadNormalizedPlaceRoi` 로 **실제 파일을 읽는다(macrotask)** → microtask 루프는 적재 전에 반환한다.
   → `waitDone(job)`(종료 상태 폴링)으로 교체. **모드B·`placeRoiFile` 미주입 케이스만 우연히 통과했던 것**이라 자칫 "일부만 실패"로 오해할 수 있었다.

---

## 6. 유닛테스트가 봉인하지 **못하는** 것 (은닉 금지)

1. **임계값(0.25 / 0.15)의 적절성 — 봉인 불가.** 유닛테스트는 규칙의 *논리*(밴드 겹침비 ≥ 임계 → keep)만 고정한다. 내 테스트는 "겹침비 0.10 → drop, 0.30 → keep"을 단언하지만, **실제 주차장에서 0.15 가 옳은 컷인지는 증명하지 않는다.** 임계값을 0.05나 0.4로 바꿔도 내 테스트는 **일부만** 깨진다. → **라이브 검증(§7-1)이 성공 판정의 본체**: 모드A 수집 1라운드 → `filteredOut > 0` 이면서 **주차차가 빠지지 않았음**을 육안 대조.
2. **임계 경계(`>= 0.15` 정확히)는 테스트하지 않았다.** 겹침비를 정확히 0.15로 만드는 좌표는 부동소수 오차에 취약해 `0.10`(drop) / `0.30`(keep) 로 양옆만 고정했다. 경계에서 `>` 와 `>=` 를 맞바꿔도 내 테스트는 **통과한다**.
3. **`web/app.js` · `web/index.html` 은 실행되지 않았다.** 프론트 배선은 **코드 대조(grep)로만** 확인했다(위 §4 표 — id·필드명 일치). DOM 테스트가 없으므로 "체크박스를 끄면 실제로 payload 에 `false` 가 실린다"는 **브라우저에서 클릭해봐야** 확정된다. `#cap-vpd-onplace` 를 rename 하면 **어떤 테스트도 깨지지 않고** 프론트만 조용히 죽는다.
4. **가림(occlusion)**: 앞줄 차가 뒷줄 차 하단을 가려 bbox 하단이 접지선보다 위로 잡히는 경우는 **모킹으로 재현할 수 없다**(VPD 실출력 특성). 전 폴리곤 OR 이 얼마나 흡수하는지는 라이브에서만 관측된다.
5. **ROI 정합 사각지대 상속**: 주차면 ROI 자체가 한 칸 평행이동돼 있으면 필터도 똑같이 틀린다. 내 테스트는 픽스처 ROI 를 **정답으로 가정**한다 — 필터가 ROI 를 검증하지 않는다는 사실은 테스트로 드러나지 않는다.
6. **오목 폴리곤**: `convexIntersectionArea` 는 볼록 전제. 사용자가 정점을 끌어 오목 quad 를 만든 경우는 테스트하지 않았다(겹침 과대추정 → keep 쪽으로 안전측이지만 부정확).
7. **프로덕션 기본 동작 변경(모드A)의 실데이터 영향**: 이전 run 대비 `parking_slots` 검출 수 감소가 **정상 감소인지 주차차 손실인지**는 유닛테스트로 구분 불가. 라이브 1라운드 + `status.vpdFilteredOut` 대조가 필요하다.

---

## 7. 회귀 확인

- 기존 `captureJob*.test.ts` 4건: `placeRoiFile` 미주입 → 강등(전량 통과) → **무변경 통과**(계획 §5 예측대로).
- 기존 `finalizer*.test.ts`: Finalizer 무변경 → 영향 없음.
- 기존 `detectPipeline.test.ts:119` / `captureRoutes.test.ts:501`: 구현자가 갱신한 `summary` 기대값 그대로 통과(응답 shape 가산 — 동작 변경 아님).
- 전체 1456 테스트 통과 — **가산 변경이 기존 계약을 깨지 않았음이 실측으로 확인됐다.**
