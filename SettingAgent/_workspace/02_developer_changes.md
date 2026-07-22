# 02_developer_changes — 이터레이션 1 구현(LPD 1회 미검 조기사망 제거: 미세 tilt 디더 재포착)

작성: 2026-07-22 · 구현자(developer) · B 모드 이터레이션 1
입력: `_workspace/00_goal.md` · `_workspace/01_architect_plan.md`(설계 그대로 구현, 임의 변경 없음)

---

## 1. 변경 파일·함수

| 파일 | 변경 |
|---|---|
| `src/calibrate/platePtz.ts` | `PlatePtzOpts` 2키 신규 · `ResolvedOpts` 2키 · `PlatePtzResult.recaptureDithers?` · **private `captureTrack()` 신규** · 모듈 로컬 순수함수 **`ditherSeq()` 신규** · 호출측 3곳(A/B/C) 치환 |
| `src/calibrate/PtzCalibrator.ts` | 상수 `POINT_RECAPTURE_DITHER_DEFAULT`(0.03)·`POINT_RECAPTURE_RETRIES_DEFAULT`(2) · private **`recaptureOpts()` 신규** · `centerOnPoint` 의 `makePlatePtz` **2곳에만** 스프레드 |
| `src/config/toolsConfig.ts` | `CalibrateSchema` 옵셔널 키 2개(`pointRecaptureDitherDeg`, `pointRecaptureRetries`) |
| `config/tools.config.json` | **무변경**(코드 기본값으로 동작) |
| `web/app.js` · 라우트 · `@parkagent/types` | **무변경**(응답 shape 불변) |
| `test/**` | **무변경**(유닛테스트는 qa 담당 — 이 단계에서 작성하지 않음) |

## 2. 핵심 diff 요지

### 2.1 `ditherSeq(n, d)` (platePtz.ts 모듈 로컬)
`[+d, −d, +2d, −2d, …]` 를 n 개. `n=0 → []`. 부호 교대라 두 번 다 실패해도 순 이동은 −d 잔차뿐.

### 2.2 `PlatePtz.captureTrack(cam, preset, cmd, obsCenter, obsPtz, gain, radius)`
- `deltas = [0, ...ditherSeq(retries, ditherDeg)]` 를 순회하며 `p = {pan: cmd.pan, tilt: cmd.tilt + delta, zoom: cmd.zoom}` 로 캡처.
- **prior 는 매 시도 `p` 기준 `predictPlateCenter` 로 재계산**(분기 없음 — 설계 §3.3 그대로).
- **게이트 불변**: 호출측이 준 **같은 `radius` 변수 하나**를 그대로 `captureDetectPick` 에 전달. 시그니처에 "완화 반경" 개념이 없다.
- **발동 조건 = `got.plate === null` 인 모든 경우** → 검출 0(`count=0`)과 반경 기각(`rejected`) **둘 다** 커버.
- 성공 시 `{plate, ptz: p(디더 포함), dithers: i}` 반환 → 호출측이 **디더된 PTZ 를 상태로 채택**(원복 없음).
- 실패 시 `ptz` = **마지막으로 명령한 PTZ**(카메라의 실제 위치 — 지어내지 않음).

### 2.3 호출측 치환(3곳)
| 지점 | 함수 | 앵커 |
|---|---|---|
| A | `centerOnPlate` 추적 루프 | `obsCenter`/`obsPtz`, gain=`gain` |
| B | `zoomToPlateWidth` 가드 재중심 | `obsCenter`/`obsPtz`, gain=`effGain` |
| C | `zoomToPlateWidth` 줌 후 캡처 | **앵커=`predictCenterAfterZoom` 결과, obsPtz=줌 후 ptz**, gain=`effGain` → 두 모델 순차 합성. 줌 명령 자체는 디더하지 않음 |

각 지점에서 `ptz = tr.ptz` 로 상태 채택 후 `if (!tr.plate) → plate_lost`. **`retries=0` 이면 `deltas=[0]` 이라 캡처 1회·prior 동일·`tr.ptz===cmd` → 기존 코드와 동작 동형**(D 사다리·`probeGain`·배치는 손대지 않음).

### 2.4 결과 필드 `recaptureDithers`
`centerOnPlate` / `zoomToPlateWidth` 각각 호출 단위로 **누계**(0 이면 필드 자체를 싣지 않음). 성공·`plate_lost`·`max_iterations` 반환에 실린다. `PtzCalibrator.centerOnPoint` 의 REST 반환 shape 은 무변경.

### 2.5 로깅(리더 라이브 판정용, 기존 관용구 `cat:'centering'` 준수)
| 시점 | 레벨 | phase | 실린 필드 |
|---|---|---|---|
| 미검 → 디더 시도 | `info` | `recapture` | `attempt`, `plates`(count), `rejected`, `nearestDist`, `radius`, `nextDither` |
| 디더로 재포착 성공 | `info` | `recapture` | `attempt`, `dither`, `tilt`, `plates`, `nearestDist`, `radius`, `recovered:true` |
| 디더 전부 소진·실패 | `warn` | `recapture` | `attempts`, `dithers`, `radius`, `recovered:false`, `ptz` |

`retries=0` 이면 세 로그 모두 **한 줄도 나오지 않는다**(로그 회귀 0).

### 2.6 주입 지점
`PtzCalibrator.centerOnPoint` 의 `makePlatePtz` **2곳**(centerOnPlate 용 · zoomToPlateWidth 용)에만 `...this.recaptureOpts()`. `baseOpts()` · `ladderOpts()` · 배치(`calibrateSlot`)에는 넣지 않았다 → 배치 회귀는 논증이 아니라 **구조로** 0.

## 3. 설계와 달라진 점
**없음.** 설계 §1~§8 을 그대로 구현했다. 설계에 명시되지 않았으나 리더 지시(관측 가능성)로 **추가한 것 1개**: "디더 전부 소진 후 실패" `warn` 로그(§2.5 3행). 동작에는 영향이 없고 `retries=0` 에서는 출력되지 않는다.

## 4. 검증 결과(수치)
- `npx tsc --noEmit` → **에러 0(클린)**.
- `npx vitest run` → **196 파일 / 2295 테스트 전건 통과**.
- ★ 지시서의 기준치(191/2260)와 다르다. **내 변경 때문이 아니다** — 변경분을 `git stash` 로 되돌린 상태에서 동일하게 **196/2295 통과**임을 실측 확인했다(테스트 파일은 한 개도 추가/수정하지 않았다). 지시서 수치가 최신 트리보다 오래된 값이다.

## 5. 스스로 발견한 결함·한계(은닉 금지)
1. **C 지점의 `effGain` 은 줌 *전* zoom 기준으로 스케일된 값이다**(설계 §8.2 C 가 명시적으로 `effGain` 을 지정해 그대로 따랐다). 줌 후 프레임에서의 실제 디더 변위는 `d·zNew/35.5` 인데 보정은 `d·zOld/35.5` 로 계산되므로 최대 `maxZoomStepRatio`(1.3~1.5)배 과소보정된다. 절대량은 zoom 36 최악에서도 0.030→0.010 수준의 차이라 게이트(0.08) 대비 안전하지만, 정확히 하려면 `scaleGainForZoom(gainRef, newZoom)` 을 써야 한다. **설계 결정이라 임의로 바꾸지 않았다** — 다음 루프 판단 요청.
2. `recaptureDithers` 를 **호출당 누계**로 정의했다(설계는 "시도 횟수"로만 서술). 설계 §9 T1(=1)·T3(=2)의 단일 회복/단일 실패 케이스에서는 누계와 "마지막 값"이 동일하지만, 여러 반복에서 각각 디더가 발생하면 누계가 더 커진다. qa 가 단언을 쓸 때 이 정의를 전제해야 한다.
3. `zoom_saturated` 반환에는 `recaptureDithers` 를 싣지 않았다(설계 지정 밖 — 그 경로는 미검 실패가 아니다).
4. **미적용(설계 §7 D·§3.5 그대로)**: 사다리 `centerAndZoomByLadder` latch 후 미검, `probeGain`, `centerOnPlate` 최초 대상 선정(첫 캡처). 실카 경로는 이번 루프에서 검증 수단이 없다.
5. **미검증**: 라이브 실측(슬롯 1~7)은 리더 담당이라 구현자는 카메라 API 를 호출하지 않았다. 디더가 실제로 LPD 검출을 되살리는지는 **아직 관측되지 않았다**(설계 §12-1 가정 그대로).

---

# 이터레이션 2 — 디더 단위 전환(각도 → 정규화 변위) + 에스컬레이팅 사다리

작성: 2026-07-22 · 지시: 리더 라이브 실측(추정 아님). 이터1 은 **방향이 맞았고 폭이 4배 부족**했다.

## 이터1 라이브 결과(리더 확인)
디더 재포착 `recovered:true` 3건, 기존 실패 slot2·slot3 신규 성공. 남은 실패(slot1)의 원인이 아래 실측으로 확정됐다.

| 디더(slot1 실패 프레임 pan 12 / tilt 11.047 / zoom 1.693) | 대상 재검출 |
|---|---|
| tilt ±0.03°(≈1.5px) | ✗ |
| tilt ±0.06°(≈3px) | ✗ |
| **tilt ±0.12°(≈6px)** | **✓** |
| pan ±0.06° | ✗ |
| zoom 1.693→1.75 | ✗ |

## 6. 이터2 변경 내역

| 파일 | 변경 |
|---|---|
| `src/calibrate/platePtz.ts` | 옵션 `plateRecaptureDitherDeg` → **`plateRecaptureDitherNorm`**(기본 **0.0014**) 교체(하위호환 잔재 없음) · `ditherSeq(n,d)` → **`ditherMultipliers(n)`**(배수 수열) 교체 · `captureTrack` 에 **변위→각도 환산** 추가 · 로그 필드 확장 · 로그용 `r5()` 추가 |
| `src/calibrate/PtzCalibrator.ts` | `POINT_RECAPTURE_DITHER_DEFAULT(0.03)` → **`POINT_RECAPTURE_DITHER_NORM_DEFAULT(0.0014)`**, 재시도 기본 **2 → 6** · `recaptureOpts()` 키 교체 |
| `src/config/toolsConfig.ts` | `pointRecaptureDitherDeg` → **`pointRecaptureDitherNorm`**(`.max(0.5)`) · `pointRecaptureRetries` 상한 `.max(5)` → **`.max(8)`**(6 을 담아야 하므로 필수) |
| `config/tools.config.json` | **무변경**(코드 기본값으로 동작) |
| `test/**` · 라우트 · `web/app.js` | **무변경** |

### 6.1 단위 전환(핵심)
```ts
// 변위(정규화) → tilt 각(°). predictPlateCenter 의 `변위 = dTilt/gainTilt` 역산.
const degPerNorm = Math.abs(
  scaleGainForZoom({ gainPan: 0, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 }, cmd.zoom).gainTilt,
); // = |fallbackGainTiltDeg| / cmd.zoom
const dNorm = mults[i] * o.plateRecaptureDitherNorm;   // 부호 포함 화면 변위
const dDeg  = dNorm * degPerNorm;                      // 실제 명령 각도
```
- ★ 환산에 **루프의 살아있는 `gain`(damp 로 절반씩 감쇠)을 쓰지 않는다** — 지시대로 무측정 fallback 게인 × 현재 zoom 이라는 고정 물리모델만 쓴다(감쇠는 제어 사정이지 검출기 사정이 아니라, 정작 흔들어야 할 때 디더가 함께 작아지는 자기무력화를 막는다).
- ★ **prior 예측은 종전대로 루프 `gain`** 을 계속 쓴다(그건 예측 모델이라 감쇠 반영이 맞다). 두 용도가 코드에서 분리돼 있다.
- 검산: zoom 1.6934 → `degPerNorm = 35.5/1.6934 = 20.97` → ±1배수 = **0.0294°**(≈이터1 의 0.03°), ±4배수 = **0.1174°**(≈리더가 회복을 확인한 0.12°). zoom 36 → ±4배수 = 0.0055° = **같은 6px**. 픽셀 공간에서 zoom 불변.

### 6.2 에스컬레이팅 사다리
`ditherMultipliers(n)` = `[+1, −1, +2, −2, +4, −4, +8, −8, …]`(`2^floor(i/2)`, 부호 교대). 기본 주입 6 이면 **1.5px → 3px → 6px 를 양방향**으로 훑는다. 전부 실패해도 순 이동은 마지막 한 칸(−4u ≈ 0.0056 정규화)뿐이라 대상을 밀어내지 않는다.

### 6.3 거짓 성공 금지선(재확인)
최대 디더 변위 = `4 × 0.0014 = 0.0056` → `matchRadiusNorm`(0.08)의 **7%**, 이웃 판 최소 간격 0.15 의 **3.7%**. 변위 단위라 이 비율은 **zoom 과 무관하게 고정**이다(이터1 은 zoom 36 에서 0.030 = 게이트의 38% 까지 커졌었다 → 오히려 **안전 여유가 개선**됐다). 게이트는 여전히 같은 `radius` 변수 하나뿐.

### 6.4 로그(리더 지시 4)
리더가 추가한 `prior:{x,y}`·`tilt` 필드는 **그대로 유지**했다. 여기에 추가:
| 로그 | 신규 필드 |
|---|---|
| 미검 → 디더 시도(`info`) | `ditherNorm`(r5), `ditherDeg`(r3), `nextMult`, `nextDitherNorm`, `nextDitherDeg` (기존 `attempt`·`plates`·`rejected`·`nearestDist`·`radius`·`prior`·`tilt` 유지) |
| 재포착 성공(`info`) | `mult`, `ditherNorm`, `ditherDeg`, `tilt`, `zoom`, `recovered:true` |
| 전부 소진 실패(`warn`) | `maxMult`, `maxDitherNorm`, `maxDitherDeg`, `attempts`, `dithers`, `recovered:false`, `ptz` |

### 6.5 왕복 비용 재계산(지시 5)
1 왕복 = `requestImage` + `settleMs`(300ms) + `lpd.detect` ≈ **0.6s**.

| 시나리오 | 추가 왕복 | 추가 시간 |
|---|---|---|
| 미검이 없는 정상 진행(대부분) | 0 | 0 |
| 1배수(1.5px)에서 회복 | +1 | +0.6s |
| 2배수(3px)에서 회복 | +3 | +1.8s |
| **4배수(6px)에서 회복** — 실측 slot1 케이스 | **+5** | **+3.0s** |
| **진짜 미검(실패 확정, 사다리 전체 소진)** | **+6** | **+3.6s** 후 `plate_lost` |
| 이론적 최악(`centerOnPlate` 15반복 × 매 반복 6 디더) | +90 | +54s |
| 클릭 1회 전체 최악(center 15 + zoom 15) | +180 | +108s |

이론적 최악은 "매 반복 첫 캡처가 미검이고 매번 마지막 칸에서 회복"이라는 조합으로, 관측된 실패율(슬롯당 0~1회)과는 거리가 멀다. **실측 기대값은 클릭당 +0~3.6s**(이터1 대비 최악이 3배로 늘었다 — 회복률과 맞바꾼 값이며, 라이브 체감이 문제가 되면 재시도를 4(±1,±2)로 낮추는 것이 첫 번째 노브다).

## 7. 이터2 검증 결과
- `npx tsc --noEmit` → **에러 0(클린)**.
- `npx vitest run` → **196 파일 / 2295 테스트 전건 통과**(이터1과 동일 수치 = 기본 0 유지로 무회귀 확인).
- 카메라 API 호출 없음(라이브 스윕은 리더 담당).

## 8. 이터2에서 스스로 발견한 결함·한계
1. **환산이 `fallbackGainTiltDeg`(−35.5 @zoomRef=1)에 100% 무측정 의존한다.** cam1 시뮬 실측에서 유도된 상수라 게인이 다른 카메라에서는 같은 `ditherNorm` 이 다른 픽셀 폭이 된다(지시대로 살아있는 `gain` 을 쓰지 않기로 한 대가). 실카에서 디더가 안 먹으면 `pointRecaptureDitherNorm` 상향이 아니라 **`fallbackGainTiltDeg` 실측치 점검**이 먼저다.
2. **`zoom` 축 회복 불가는 미해결.** 리더 실측에서 zoom 1.693→1.75 로는 회복되지 않았고, 디더는 tilt 단독이므로 "tilt 로도 안 흔들리는 미검"(가림·각도·오염)은 여전히 정직하게 `plate_lost` 다.
3. **8배수 이상은 미검증.** `ditherMultipliers` 는 재시도 8까지 `±8`(12px)로 자연히 확장되지만 실측 근거는 6px 까지뿐이다. 큰 폭은 이웃 여유(0.15)를 잠식하므로 재시도를 8 이상으로 올릴 때는 게이트 여유를 다시 계산해야 한다.
4. **slot5 비결정성은 별도 대응하지 않았다**(리더 지시). 큰 디더로 흡수되는지는 라이브 재스윕에서만 확인된다.
5. **미출시 키 교체(이터2)**: `pointRecaptureDitherDeg` 는 하위호환 없이 제거했다(지시대로 — 어제 추가된 미출시 키이고 `config/tools.config.json` 에도 없다). 외부에서 이 키를 쓰고 있었다면 **조용히 무시된다**(zod optional). 현재 리포지토리 전체 검색상 사용처는 없었다.

---

# 이터레이션 3 — P1 위장 성공 제거 + P2 줌 축 데드존 재포착

작성: 2026-07-22 · 지시: 리더(이터2 라이브 실측 후 직접 설계, `00_goal.md` "이터레이션 2 결과" 절).
이터2 로 **센터링 단계는 해결**됐다(2라운드 14/14, slot1 은 mult 4 = ±0.117° 로 재포착 — 환산이 실측 회복점과 일치). 이번은 그 과정에서 **새로 드러난 결함 2건**이다.

## 9. P1 — 줌 실패 삼킴 제거(거짓 성공 금지선 위반)

### 9.1 결함
`PtzCalibrator.centerOnPoint` 비-사다리 경로가 `if (z.ok) return z;` 만 갖고 있어, **줌이 실패하면 그대로 흘러내려 센터링 결과를 `ok:true` + reason 없이** 반환했다. 라이브 R1 slot1 이 정확히 이 경로였다 — `zoom 1.69 / plateWidth 0.032`(=base 폭, 줌이 전혀 안 일어남)인데 응답은 `ok:true`, UI 는 "개별 센터라이징 완료". **내 변경 이전부터 있던 결함이고 센터링이 고쳐지자 표면화됐다.**

### 9.2 수정
```ts
// 구: if (z.ok) return { ... };            // ← 실패면 낙하 → center 결과를 ok:true 로 반환(위장)
// 신: return { ok: z.ok, ptz: z.ptz, plateWidth: z.plateWidth, ...(z.reason ? { reason: z.reason } : {}) };
```
- 줌을 시도했으면 **그 결과가 정본**이다. 실패 시 `ok:false` + 줌 단계 `reason`(`plate_lost` 등)을 그대로 전파.
- `ptz`·`plateWidth` 는 **줌 단계가 마지막으로 도달한 실측값**(카메라의 실제 현재 위치). 센터링 시점 PTZ 를 싣는 것은 거짓말이다.
- **`zoom !== false` 로 요청했는데 줌이 안 일어난 결과를 `ok:true` 로 반환하는 경로는 이제 하나도 없다** — 분기가 `if (centered.ok && zoom!==false) → return z` / `else → return centered` 둘뿐이고, 후자는 애초에 줌을 시도하지 않은 경우다(회귀 테스트로 고정 — §9.3).
- 사다리 경로(`centerAndZoomByLadder`)는 **무변경**. 그쪽의 "장비 한계라 폭 미달이지만 `ok:true` + reason" 관용구는 *장비가 할 수 있는 일을 다 한* 경우고, 이쪽 실패는 **대상 소실**이라 성격이 다르다.

### 9.3 기존 테스트 수정(★ 위장 성공을 고정하고 있던 테스트)
`test/ptzCalibrator.point.test.ts` 의 `centerOnPoint — 줌 실패 시맨틱 (§5-A-4, 구현이 정본)` 은
"z.ok=false 면 낙하해 center 결과 반환(`ok:true`, reason 미전파)"을 **명시적으로 단언**하고 있었다 = 이번 결함의 스펙화. 의도를 확인한 결과 이 케이스는 "구현이 정본"이라는 이름 그대로 **당시 구현을 그대로 받아적은 것**이지 요구사항이 아니었다(설계 문서에 근거가 없다). 따라서 **의미를 뒤집어 다시 썼다**:
- `ok:false` + `reason:'plate_lost'` + `ptz`=줌 단계 PTZ + `plateWidth`=줌 단계 실측 을 단언.
- **회귀 가드 1건 추가**: `opts` 미지정·`{zoom:true}` 양쪽에서 줌 실패 시 `ok:true` 가 되지 않음.
→ 테스트 수 **2295 → 2296**(+1). 수정 1건·추가 1건, 삭제 0건.

## 10. P2 — 줌 스텝 직후 캡처(C 지점)의 재포착 축을 zoom 으로 교체

### 10.1 근거(리더 실측 — 같은 pan/tilt, zoom 만 변경)
| zoom | 7.8 | 8.0 | **8.1738** | 8.25 | 8.4 | 8.6 | 9.0 | 6.0 | 10.0 |
|---|---|---|---|---|---|---|---|---|---|
| 검출 | ✗ | ✗ | **✗**(plates:0) | ✓ 0.137 | ✓ 0.142 | ✗ | ✓ 0.156 | ✓ 0.117 | ✓ 0.188 |

그 프레임에서 **tilt 디더 7시도 전패**, **zoom +1%(8.1738→8.25)에서 회복**. 줌 스텝 직후 프레임은 배율 자체가 바뀐 새 프레임이라 회복 축도 zoom 이어야 한다.

### 10.2 구현
- 신규 private **`PlatePtz.captureTrackZoom(cam, preset, cmd, anchor, radius)`** — `captureTrack` 과 구조 동일, **흔드는 축만 zoom**.
- 배수는 **같은 `ditherMultipliers`** 재사용 × 신규 옵션 `plateRecaptureZoomStep`(기본 0.01) → `×[1.01, 0.99, 1.02, 0.98, 1.04, 0.96]`(지시와 정확히 일치). 횟수는 기존 `plateRecaptureRetries`(클릭 경로 6) 공용.
- prior 보정: `predictCenterAfterZoom(anchor, cmd.zoom, 디더된 zoom)` — tilt 디더의 `predictPlateCenter` 보정과 같은 원칙.
- **clampZoom 포화 스킵**: `i>0` 이고 `|clampZoom(cmd.zoom×factor) − cmd.zoom| ≤ ZOOM_EPS` 면 **캡처하지 않고 건너뛴다**. 로그 `axis:'zoom', skipped:'clamped', mult, factor` 로 남긴다. 스킵은 `dithers` 카운트에도 포함하지 않는다(실제 왕복만 센다).
- `i=0`(원 캡처)은 `clampZoom` 조차 통과시키지 않고 `cmd.zoom` 을 그대로 쓴다 → **`retries=0` 이면 기존 코드와 완전 동형**(배치·기존 테스트 회귀 구조적 0 유지).
- **A·B 지점(pan/tilt 이동 후 캡처)은 tilt 디더 그대로** — 실측으로 효과가 확인된 축이라 손대지 않았다.
- 로그: 성공 `axis:'zoom', mult, factor, zoomFrom, zoom, plates, nearestDist, recovered:true` / 미검 `… prior:{x,y}, zoom, factor, nextMult, nextFactor, nextZoom` / 전패 warn `attempts, dithers, maxFactor, recovered:false, ptz`. `axis` 필드로 tilt 디더 로그와 구분된다.

### 10.3 폭 부작용 검토(지시)
- 폭은 zoom 에 선형이므로 ±4% 디더 → 폭 ±4%. 목표 폭 0.2 기준 **±0.008 < `widthTol` 0.02**(여유 2.5배) → 디더된 자리에서 수렴 판정이 뒤집힐 구간은 "이미 tol 경계 ±0.012 밖"뿐이고, 그 경우는 어차피 다음 반복이 보정한다.
- **위장 위험 없음**: 수렴 판정은 항상 **디더된 그 프레임에서 실측한 폭**으로만 내린다(디더 전 폭을 그대로 쓰는 경로가 없다). 즉 폭을 좋게 보이게 만드는 것이 아니라 "그 배율에서 실제로 잰 값"이다.
- 게이트: zoom 디더는 중심을 `predictCenterAfterZoom` 로 정확히 예측 보정하므로 prior 오차 증가분은 0 에 가깝고, `matchRadiusNorm` 은 그대로다.

### 10.4 왕복 비용(C 지점)
1 왕복 ≈ 0.6s. +1% 회복 = +1왕복(+0.6s), +2% = +3(+1.8s), **+4% = +5(+3.0s)**, 전패 확정 = +6(+3.6s, clampZoom 스킵이 있으면 그만큼 감소). tilt 디더와 동일한 예산이며 두 축이 **서로 다른 지점**에 있어 곱해지지 않는다(한 반복에서 A/B 또는 C 중 하나만 탄다).

## 11. 이터3 변경 파일
| 파일 | 변경 |
|---|---|
| `src/calibrate/PtzCalibrator.ts` | **P1** `centerOnPoint` 줌 결과 무조건 반환(+doc) · **P2** 상수 `POINT_RECAPTURE_ZOOM_STEP_DEFAULT`(0.01) + `recaptureOpts()` 키 1개 |
| `src/calibrate/platePtz.ts` | **P2** 옵션 `plateRecaptureZoomStep`(기본 0.01) · private **`captureTrackZoom` 신규** · C 지점 호출 교체(A·B 무변경) |
| `src/config/toolsConfig.ts` | **P2** `pointRecaptureZoomStep` 옵셔널 키 1개 |
| `test/ptzCalibrator.point.test.ts` | **P1** 위장 성공 고정 테스트 1건 의미 반전 + 회귀 가드 1건 추가 |
| `config/tools.config.json` · 라우트 · `web/app.js` | **무변경** |

## 12. 이터3 검증 결과
- `npx tsc --noEmit` → **에러 0(클린)**.
- `npx vitest run` → **196 파일 / 2296 테스트 전건 통과**.
- ★ 2295 → **2296**(+1): P1 회귀 가드 신규 1건. 기존 1건은 삭제가 아니라 **의미 반전 수정**(§9.3). 그 외 기대값 변화 0 — P2 는 `retries` 기본 0 이라 기존 경로에 도달하지 않는다.
- 카메라 API 호출 없음(라이브 스윕은 리더 담당).

## 13. 이터3에서 스스로 발견한 결함·한계
1. **UI 표시 확인 못 함.** P1 로 `ok:false + reason` 이 새로 나가기 시작하므로 뷰어가 `종료(${reason})` 로 뜬다(리더가 그 경로를 지정했다). 다만 `plate_lost` 문자열 자체는 기존에도 나가던 값이라 UI 변경은 없다 — **라이브 육안 확인은 리더 몫**.
2. **zoom 디더 ±4% 상한은 실측 데드존 폭(8.1738 미검 ↔ 8.25 검출, 약 +0.9%)에 딱 맞춰진 값이다.** 실측 표에서 8.6 이 다시 ✗ 인 것으로 보아 데드존은 여러 개고 폭도 제각각이라, **더 넓은 데드존을 만나면 ±4% 로도 못 넘을 수 있다**. 그 경우 정직하게 `plate_lost` 이며, `pointRecaptureZoomStep` 상향이 첫 노브다.
3. **`pointRecaptureZoomStep` 을 config 키로도 노출했다.** 리더 지시는 "옵션화"까지였고 cfg 키는 명시 요구가 아니었으나, `pointRecaptureDitherNorm` 과 대칭을 맞춰 **코드 변경 없이 라이브 튜닝**이 가능하도록 했다(§규칙2 관점에서 과다하다고 판단되면 제거해도 동작 영향 0).
4. **P2 는 유닛테스트가 없다**(이 단계에서 테스트 작성은 qa 담당). `captureTrackZoom` 의 clampZoom 스킵·prior 보정·배수 사다리는 **아직 라이브로도 유닛으로도 검증되지 않았다**.
5. **A·B 지점의 zoom 데드존은 미대응.** pan/tilt 이동 직후에도 원리상 같은 데드존을 밟을 수 있으나, 그 지점은 tilt 디더가 실측으로 효과가 확인됐고 지시가 "그대로 두라"였다. 두 축을 겹쳐 쓰는 것은 왕복 폭증(6×6)이라 근거 없이 하지 않았다.
