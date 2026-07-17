# 구현 보고: 번호판 센터링·줌 독립 함수 모듈 (PlatePtz)

작성: 2026-07-16 / 구현자
브랜치: `feat/plate-ptz` (워크트리 `ParkAgent-plate-ptz`)
입력 설계: `_workspace/plate-ptz/01_architect_plan.md` (§2 계약 · §2.1/2.2 의사코드 · §4 정의 그대로 구현)

> 이 파일은 이전 세션(VPD 육면체 과제)의 보고서를 대체한다 — 본 워크트리 세션의 산출 기록.

## 개정 이력

| 판 | 내용 |
|---|---|
| r0 | 최초 구현(신규 2파일, 기존 코드 0줄 변경). 유닛 green — **라이브 검증에서 두 함수 모두 실패**. |
| r1 | 설계 r1 반영. **아래 §R1 이 이 판의 변경분** — 나머지 절(§1~§6)은 r0 기록이며 r1 로 갱신된 항목은 §R1 이 우선한다. |
| r2 | 설계 r2 반영. 상수 3건 + §6 테스트 모델 교체. 로직 무변경. §R1 의 수치(+75/−35·probe 3°·게인 45/−21)는 **오염 실측 유래로 전량 폐기**되었으니 §R2 를 따를 것. |
| r3 | QA 결함 D-1/D-2 정정. **아래 §R3 가 최신** — **주석·JSDoc 만, 로직·상수·테스트 전량 무변경.** |

---

# §R3 (2026-07-16 · QA 03_qa_report §5 결함 D-1/D-2 정정 — **최신**)

## R3-0. 이 판의 성격: **문서 전용**. 실행 코드 0줄 변경

QA 게이트는 이미 전량 green(회귀 0)이었고, 결함 2건은 **둘 다 "코드가 말하지 않은 것"** 이었다.
따라서 이 판은 **주석/JSDoc 만 고쳤다** — 로직·상수·시그니처·테스트 **무변경**.

## R3-1. 변경 파일 (2 수정, 실행 코드 0줄)

| 파일 | 변경 |
|---|---|
| `src/calibrate/controlMath.ts` | **D-1** — `scaleGainForZoom` JSDoc 의 폐기 실측값 정정(주석 1줄 → 3줄). |
| `src/calibrate/platePtz.ts` | **D-2** — `zoomToPlateWidth` JSDoc + `PlatePtzOpts.gain` / `fallbackGain*` 필드 주석에 게인 의존 명시. |

## R3-2. D-1 — 부호가 반대인 r1 오염 실측값 정정

r1 이 추가한 `scaleGainForZoom` JSDoc 에 `실측: gainPan≈+45, gainTilt≈−21` 이 **"실측" 단정형으로 화석화**되어 있었다. `+45` 는 r1 aliasing 오염의 허상이고 **부호가 반대**다 — 기본값(−62/−35.5)·설계서·테스트는 전부 음수인데 **이 주석만 홀로 +를 주장**했다(코드베이스 내부 모순이자, r1 라이브 실패의 근본 원인 "게인 부호를 +로 믿음"을 재생산할 유일한 근거).

정정 후:
```
 * 실측: gainPan≈−36.6, gainTilt≈−21.0 (zoom 1.69341 기준 — 둘 다 ★음수) → zoom 20 에서 약 1/12.
 *   출처: 라이브 diagSweep 전체목록 공통변위(구현 probe 라이브 측정 −37.1/−21.2 와 일치).
 *   ★ 이 값은 특정 시뮬 카메라(cam1)의 실측이며 게인은 장비마다(FOV·센서·마운트) 다르다.
```
측정 출처와 **장비 종속성**을 덧붙였다 — 다음 엔지니어가 이 상수를 보편값으로 오해하지 않도록.

**append-only 유지 확인**(이 줄은 main 에 없던 r1 추가분이라 정정해도 제약 무위반):
```
$ git diff --numstat main -- src/calibrate/controlMath.ts
48      0       SettingAgent/src/calibrate/controlMath.ts
$ git diff main -- src/calibrate/controlMath.ts | grep -E "^@@|^-[^-]"
@@ -103,3 +103,51 @@ export function dampGain(...)
(삭제 줄 0건)
```
→ **48 삽입 / 0 삭제**, 훅 단 1개(파일 말미). **원래부터 있던 줄 무접촉.**

## R3-3. D-2 — 계약의 침묵 해소 (JSDoc 만)

**사실**: `probeGain` 호출부는 `centerOnPlate` 단 1곳이다. `zoomToPlateWidth` 는 **probe 를 하지 않는다**(설계 §2.2 의 의도적 결정 — 스케일링이 probe 재실행을 대체). 따라서 `opts.gain` 미전달 = **드리프트 가드 게인이 fallback 에 100% 무측정 의존**.

라이브 C(줌 단독) PASS 는 **fallback(−62/−35.5)이 마침 그 카메라의 참값이었기 때문**이지, 단독 경로가 게인을 알아내서가 아니다. 게다가 열화가 **비대칭**이다 — 센터링은 probe 로 자가 교정되므로 멀쩡한 채 **줌 단독만 조용히** 틀어져 진단이 어렵다. 설계·JSDoc 어디에도 이 의존이 적혀 있지 않았다(**침묵이 결함**).

명시한 곳 3군데(한글):
| 위치 | 내용 |
|---|---|
| `zoomToPlateWidth` JSDoc | "probe 를 전혀 하지 않는다 → `opts.gain` 없는 단독 호출은 fallback 에 100% 무측정 의존". fallback 기본값이 **cam1 시뮬 실측 기준**임 · 다른 카메라에서 역방향/과소 보정 → `plate_lost` 가능 · **열화의 비대칭성** · 권고(① `centerOnPlate` 결과 `gain` 체이닝 ② `diagSweep` 실측을 `fallbackGain*` 로 주입) |
| `PlatePtzOpts.gain` | 미전달 시 **측정 기회 0** — 이 필드의 부재는 "probe 실패 시 안전판"이 아니라 **무측정 1차 의존**을 뜻함 |
| `PlatePtzOpts.fallbackGain*` | 기본 −62/−35.5 는 **cam1 실측 유도 상수** — 타 카메라 타당성 근거 없음 |

**로직 무변경**: probe 추가하지 않았다(설계 §2.6 이 비용 대비 이득 없음으로 기각). 이번 범위는 **문서화가 옳다**는 QA §5 D-2 판정에 동의.

## R3-4. 완료 게이트 실행 결과 (실제 출력 그대로)

```
$ npm run typecheck
> parkagent-setting@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
(진단 출력 없음, exit 0)

$ npx vitest run test/platePtz.test.ts
 ✓ test/platePtz.test.ts (26 tests) 12ms
 Test Files  1 passed (1)
      Tests  26 passed (26)

$ npm test
 Test Files  151 passed (151)
      Tests  1667 passed (1667)
```
→ **26 / 1667 — QA 기준치와 정확히 일치. 회귀 0.** 테스트는 **한 줄도 고치지 않았다**(주석만 바꿨으니 당연 — 수치가 흔들렸다면 그게 이상 신호였을 것).

## R3-5. 범위 준수 · 검증자·문서화에게

- **무접촉 확인**: `PtzCalibrator`·`geometry`·`detectMath`·라우트·config 스키마 — 워킹 diff 에 부재. 메인 리포 무접촉.
- **D-1/D-2 외 변경 0건** — 인접 코드·포맷 "개선" 없음, 리팩토링 없음. QA 가 지적한 R-6(3줄 중복) 등은 **손대지 않았다**(범위 밖).
- **문서화에게**: 이 판의 메시지는 "**결함 2건은 실행 코드가 아니라 문서였고, 문서로 고쳤다**". D-1(부호 오정보 제거) · D-2(줌 단독의 fallback 의존이 이제 JSDoc 에 명시됨)를 문서에 실을 것. 실증 범위는 여전히 **cam1 preset1 단일 프리셋·단일 대상**(QA R-1)이며 **"완벽 통과"로 요약 금지**.
- **미해소로 남긴 것**(범위 밖·후속): QA R-3(config 기본 `+20`/`+15` 가 실측 부호와 반대 → `PtzCalibrator` 잠재 결함) — 이번 지시가 config 스키마·`PtzCalibrator` 무접촉을 못박았으므로 **손대지 않았다. 후속 과제로 유효.**

---

# §R2 (2026-07-16 · 설계 r2 반영분)

## R2-0. 이 판의 성격: 로직 무변경, **상수와 테스트 모델만**

r1 구현의 구조(예측 prior 추적 · 매칭 반경 · damp 상한 · 가드 선행 · 줌 스텝비 클램프 · 게인 zoom 스케일링)는
r2 정정 실측이 오히려 정당성을 검증했다 — **한 줄도 건드리지 않았다**. 틀린 것은 상수였다.

| # | 항목 | r1 | r2 | 근거 |
|---|---|---|---|---|
| ① | `probeStepDeg` | 3.0 | **1.0** | 1° 변위 0.027 = 번호판 간격 절반(0.075)의 36%(안전). 3° 변위 0.082 > 0.075 = aliasing 사정권. 검출이 결정적(지터 0)이라 0.027 로 충분. |
| ② | `fallbackGainPanDeg` | +75 | **−62** | ★부호 오류. diagSweep 참값 −36.6 @z1.69341 → zoomRef=1 환산 −62.0. |
| ③ | `fallbackGainTiltDeg` | −35 | **−35.5** | 실측 −21.0 @z1.69341 → ×1.69341 ≈ −35.5. 부호는 r1 대로. |
| ④ | §6 모킹 모델 | +50/−25(**pan 부호가 물리와 반대**) | **실측 물리**(음수·zoom 종속 게인 + 실측 cx 목록 + 미끼 검출) | r1 유닛이 green 인 채 라이브가 터진 정확한 이유가 ④다. |

aliasing 추가 방어 장치는 **넣지 않았다**(설계 §2.7 이 수치로 불요를 논증 — probe 축 분리·반경 축소·게인 위생검사 전부 기각). `maxStepDeg` 5° **유지**.

## R2-1. 변경 파일 (2 수정)

| 파일 | 변경 |
|---|---|
| `src/calibrate/platePtz.ts` | **기본값 3건**(`probeStepDeg 3→1`, `fallbackGainPanDeg 75→−62`, `fallbackGainTiltDeg −35→−35.5`) + 그 근거를 담은 주석/JSDoc. **로직·시그니처·제어 흐름 무변경.** |
| `test/platePtz.test.ts` | §6 공통 모킹 모델을 **실측 물리로 교체** + 1~19 기대값 정정 + **케이스 20 신설**. 23 `it` → **25 `it`**. |

`controlMath.ts`(r1 추가 3종 포함) / `PtzCalibrator.ts` / `geometry.ts` / `detectMath.ts` / 라우트 / config 스키마: **이번 판 무접촉**.

## R2-2. §6 공통 모델 — 실측 물리 재현 (이번 판의 핵심)

`makeWorld` 를 실측 참값으로 재정의(`_workspace/plate-ptz/_live/diagSweep.mts` — 추적 휴리스틱 없이 전체 검출 목록의 공통 변위):

```
게인 ∝ 1/zoom 이고 ★음수:  cx′ = cx + dPan·z/(−62),  cy′ = cy + dTilt·z/(−35.5)
   → z=1.69341 에서 1° → dx=−0.0273 / dy=−0.0477  (= 실측 그대로)
방사 확대: zoom 변경 시 화면 중심 기준 ×zNew/zOld,  폭 ∝ zoom
번호판 6개 base cx = 0.116 0.274 0.427 0.702 0.812 0.928 (간격 ≈0.15), 대상 = 0.427(중심 최근접)
base cy = 0.671(errY=+0.171), w = 0.0274·(z/1.69341)
★미끼: base 목록엔 없다가 pan 이 움직이면 공백(0.427~0.702)에 등장하는 검출 1개
       (base 환산 cx=0.569 → pan+1°에 0.541 / pan+3°에 0.487 = 실측 0.540/0.488 재현)
```

r1 모델과의 결정적 차이: **pan 게인의 부호**. r1 모델(+50)에서는 fallback +75 가 "부호가 맞는" 값이라 유닛이 전부 green 이었다. 물리가 −62 인 세계에서 +75 는 예측을 반대편으로 던진다 — 유닛은 그 사실을 볼 수 없었다.

## R2-3. 케이스 20 — r1 실패의 유닛 재현 + 민감도 실측

**`estimateGain` 산출만 격리 관측**하기 위해 `maxIterations: 0` 을 썼다(본 루프의 damp 가 반환 게인을 감쇠시켜 부호·크기 관측을 흐린다 — 실제로 첫 구현에서 허상 +49.95 가 damp 3회로 6.24 로 나타나 케이스가 red 였다. 이 red 가 격리의 필요를 알려줬다).

동일 모델에서 상수 조합별 `estimateGain` 실측(임시 스윕 테스트로 확인):

| 조합 | gainPan 산출 | 판정 |
|---|---|---|
| **r2 기본(1°, −62)** | **−36.61** | 참값 정확 복원 |
| probe 3° 만 회귀(fallback −62 정상) | −36.61 | 정상(예측이 참 위치를 정확히 가리켜 미끼가 무력) |
| fallback 부호만 회귀(1°, +75) | −36.61 | **정상 — 1° 의 자가 회복력**(설계 §2.7 이 논증한 그대로) |
| **r1 둘 다(3°, +75)** | **+49.95** | ★허상 재현 — **라이브 보고 +49.77 과 0.4% 일치** |

→ 케이스 20 은 두 `it` 으로 구성: ① r2 기본값이 음수·−36.6±15% ② **r1 상수를 되돌리면 같은 모델에서 허상 +49 가 재현**된다(모델이 라이브 실패를 실제로 재현한다는 증거 = ①의 green 이 의미를 갖는 근거).

**설계 §6 과의 차이 1건(보고)**: 설계는 케이스 20 이 "probe 3° 재도입 **또는** fallback 부호 반전 회귀 시" red 이길 요구하나, **실측상 단독 회귀는 red 가 아니다**(위 표 2·3행). 이는 설계 자신의 §2.7("1° 에는 3° 에 없던 부호 자가 회복력이 있다")과 정확히 일치하는 귀결이라, **모델을 조작해 억지로 red 를 만들지 않고** 물리가 말하는 대로 두고 ②로 조합 회귀를 감시한다. 설계 §6 의 "또는"이 §2.7 과 모순되는 것이며, 방어의 실질(=r1 실패 재현 시 red)은 확보돼 있다.

## R2-4. 케이스별 기대값 정정 (1~19)

| # | r2 정정 |
|---|---|
| 1 | 공통 실측 모델·`LIVE_START` 사용. 게인 기대 50/−25 → **부호 음수 + −36.61/−20.96**. |
| 3 | 공통 모델이 **iteration 1 에 수렴**하므로 소실 주입 시점 `i>=3` → `i>=2`, `iterations` 2 → **1**. |
| 4 | probe 미검출 → fallback 사용. **r2 fallback 이 실측 참값 그 자체**라 별도 정합 모델 불요 — 공통 모델에서 fallback 만으로 수렴(기대 게인 −36.61/−20.96 @zoomRef 1.69341). |
| 7 | 세계 모델 게인 +50/−25 → **−50/−25**, `opts.gain` 동일 정정. 결과(`ptz.pan ≈ −0.5`)는 대칭이라 불변. |
| 9·14 | 극둔감 모델의 게인 부호를 물리(음수)에 맞춤(±1000 → −1000, ±20000 → −20000). 14 의 최종 게인 기대 **−2500/−2500**(= 초기의 1/8, damp 상한 3회). |
| 11 | "노이즈 1개 추가" 픽스처 → **공통 모델(번호판 6개)에서 `plateRoi` 로 중심 최근접(0.427)이 아닌 0.702 를 지정 선정**(confidence 0.93 로 신원 검증). 실측 씬에 더 가깝다. |
| 13·15·17 | 공통 모델로 통일(미끼 포함). 15 의 자기보고 게인·수렴 zoom(11.22)·폭(0.182) 재확인. |
| 16 | `opts.gain` **{−36.6, −21.0, zoomRef 1.69341}**(r2 정정). 가드 명령이 `scaleGainForZoom` 결과와 일치하고 **음수 방향**임을 검증(`eff.gainPan < 0` 명시). |
| 18 | `z0` 1.69 → **1.69341**. 첫 줌 명령 = `z0·1.5` 절삭·전 구간 인접비 ≤1.5 불변. |
| 19 | 수치표를 r2 참값으로: `gain(z0→20)` = **−62/20 = −3.1**(부호 보존 검증 포함), fallback(−62/−35.5 @1) → z1.69341 = **−36.61/−20.96**, `predictPlateCenter` 1° → **dx −0.0273 / dy −0.0477**(실측 그대로). |

## R2-5. 완료 게이트 실행 결과 (실제 출력 그대로)

작업 디렉터리: `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`

### `npm run typecheck`
```
> parkagent-setting@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
→ 무오류(진단 출력 없음, exit 0).

### `npx vitest run test/platePtz.test.ts`
```
 ✓ test/platePtz.test.ts (25 tests) 13ms

 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  578ms
```

### `npm test` (전량)
```
 Test Files  151 passed (151)
      Tests  1666 passed (1666)
   Duration  11.67s
```
→ **회귀 0**. 1664 → 1666 (+2 = 케이스 20 의 2 `it`). `controlMath` 기존 테스트 **무수정 green** = "추가만" 제약 유지의 증명.

> 테스트를 느슨하게 고쳐 통과시킨 항목 없음. 유일한 완화처럼 보이는 `maxIterations: 0`(케이스 20)은 **관측 격리**이지 기준 완화가 아니다 — 같은 케이스의 ②가 이 격리에서 허상 +49.95 를 정확히 잡아낸다.

## R2-6. 라이브에 대한 예측 · 리더에게

1. **라이브 미검증**(리더 수행). 이 모델이 라이브 실패(+49.77)를 0.4% 오차로 재현하므로, r2 상수에서의 green 은 r1 때보다 훨씬 강한 필요조건이다. 다만 여전히 **필요조건**이다.
2. **§7 ④(게인 부호·크기) 관측 시 최근접 휴리스틱 금지** — `diagSweep` 의 전체목록 공통변위 기법으로만 관측할 것(r1 은 검증 하네스 자체가 오염돼 A 의 PASS 가 허위였다).
3. **`matchRadiusNorm` 0.08 vs `maxStepDeg` 5°** 의 여유는 r2 참값에서 재계산됨: 최악(tilt 5°) 변위 0.238 → 허용 게인 상대오차 31%, probe 실측 오차 ≤1% → 여유 ~30배(설계 §2.7). r1 보고서 §R1-6-2 의 "fallback 오차 55%" 우려는 fallback 이 참값이 된 지금 무의미하므로 **철회**한다.
4. **잔존(설계 §8 후속)**: config 기본 `fallbackGainPanDeg` +20 / `fallbackGainTiltDeg` +15 는 **둘 다 실측 부호와 반대** → `PtzCalibrator` 경로는 동일 결함(probe 실패 시 발산)을 잠재 보유한다. 이번 범위 무접촉 — 보고만.
5. `improvement`/`IMPROVE_EPS` 3줄 중복은 여전(범위 밖).

---

# §R1 (2026-07-16 · 설계 r1 반영분)

## R1-0. 라이브 실패 → 수정 대응표

| 라이브 실패 | 실측 원인 | r1 구현 |
|---|---|---|
| A. `centerOnPlate` → `max_iterations` | prior 가 화면중심 고정 → 6개 번호판 중 "지금 중심 최근접"이 매 스텝 갈아탐(6스텝 중 5) → 개선 정체 → 매 반복 `dampGain` → 게인 0.5^15≈3e-5 소멸 | **예측 prior 추적**(§2.5) + **매칭 기각 반경 0.08** + **damp 상한 3회** |
| B. 체이닝 줌 실패 | zoom 1.69 기준 게인(45/−21)을 zoom 20 에 그대로 적용 → 12배 과보정 | **게인 zoom 스케일링**(§2.6) — 게인이 `zoomRef` 를 달고 다니며 매 반복 `scaleGainForZoom` |
| C. 줌 단독 → `plate_lost` | errX=−0.073 인 채 zoom 1.69→7.49 **1스텝 점프** → 오차 4.4배 확대로 화면 밖 소실 | **가드 선행**(중심이 tol 밖이면 그 반복은 줌 보류·재중심) + **줌 스텝비 클램프 1.5 대칭** |
| (잠재) probe 실패 시 발산 | `fallbackGainTiltDeg=+15` 가 실측 부호(−21)와 **반대** | PlatePtz 전용 기본값 **pan +75 / tilt −35 (zoomRef=1)** · probe 1°→**3°** |

## R1-1. 변경 파일 (2 수정 + 0 신규)

| 파일 | 변경 |
|---|---|
| `src/calibrate/controlMath.ts` | **파일 말미에 순수 함수 3종 추가만**: `scaleGainForZoom` / `predictPlateCenter` / `predictCenterAfterZoom`. **기존 함수·시그니처·동작·export 무변경(기존 라인 무접촉)** — 기존 controlMath 테스트 **무수정 green** 이 증명. |
| `src/calibrate/platePtz.ts` | `PtzGain`(zoomRef) 타입 · 예측 prior 추적 + 매칭 반경 · damp 상한 3회 · zoom 루프 가드 선행/스텝비 클램프/게인 스케일링 · 기본값 정정. |
| `test/platePtz.test.ts` | 1~12 를 r1 계약에 맞춰 갱신 + **13~19 신규**(라이브 실패를 실측 수치 모킹으로 재현). 14 `it` → **23 `it`**. |

`PtzCalibrator.ts` / `detectMath.ts` / `geometry.ts` / 라우트 / config 스키마: **무접촉**(설계 §8 준수).

### controlMath 신규 3종 — 타입 배치 판단

설계 §2.0 은 `PtzGain` 을 `platePtz.ts` 에, §2.6 은 `scaleGainForZoom(gain: PtzGain, ...)` 을 controlMath 에 둔다. 그대로 쓰면 controlMath→platePtz 역방향 import(순환)가 생기고, controlMath 에 인터페이스를 새로 export 하는 것도 "순수 함수 추가만" 제약에서 벗어난다. → **controlMath 는 구조적 인라인 타입**(`{gainPan, gainTilt, zoomRef}`)으로 받고, `PtzGain` 은 설계대로 `platePtz.ts` 가 소유·export 한다. 구조적 호환이라 계약 동일, 순환 없음, 제약 준수.

## R1-2. 핵심 구현 노트

### 예측 prior 추적 (§2.5)
- **관측 앵커** `obsCenter`(마지막으로 대상을 본 중심) + `obsPtz`(그때의 **명령** PTZ)를 호출 스코프 지역 변수로 유지 → 무상태 계약 유지.
- 다음 명령 `cmd` 의 prior = `predictPlateCenter(obsCenter, {dPan: cmd.pan − obsPtz.pan, dTilt: cmd.tilt − obsPtz.tilt}, gain)`.
  - **앵커를 "직전 명령"이 아니라 "마지막 관측 시점"으로 잡은 이유**: probe 는 `ptz` 상태를 전진시키지 않는데(본 루프가 절대값을 명령하므로) 물리 카메라는 probe 위치에 있다. 앵커를 명령 상태로 잡으면 첫 반복의 예측이 probe 변위(3°)만큼 통째로 어긋난다. 관측 앵커는 probe·가드·줌 모든 경로를 한 식으로 덮는다.
- 초기 대상 선정만 `plateRoi` prior + **반경 기각 없음**, 이후 전 캡처는 반경 `matchRadiusNorm`(0.08) 적용.
- `captureAndDetect(camIdx, presetIdx, ptz, prior, radius|null)` 로 통합 — `radius===null` 이 "초기 선정" 모드.
- probe 는 게인 미측정 상태라 **fallback 게인으로 예측**(설계 §2.5). probe 매칭 실패 → 예외가 아니라 fallback 게인 확정(`plate_lost` 아님).

### 게인 zoom 스케일링 (§2.6)
- `centerOnPlate`: fallback(zoomRef=1)을 **시작 시점에 `scaleGainForZoom(fb, startPtz.zoom)` 로 환산**해 루프 전체를 `zoomRef=startPtz.zoom` 단일 기준으로 통일. zoom 불변이라 루프 중 재스케일 불요(설계 §2.6과 일치). 결과 gain 의 `zoomRef=startPtz.zoom`.
  - ※ r0 는 probe 실패 시 zoomRef=1 짜리 fallback(75/−35)을 zoom 1.69 에 그대로 써서 1.69배 과보정했다 — 이 환산이 그 구멍을 막는다.
- `zoomToPlateWidth`: **매 반복** `effGain = scaleGainForZoom(gainRef, ptz.zoom)`. 반환 `gain` 은 스케일 전 `gainRef`(기준을 달고 다니는 원본)로 유지 — 호출측 재체이닝이 안전하도록.
- `dampGain` 은 `{gainPan,gainTilt}` 만 반환하므로 `{...dampGain(gain), zoomRef: gain.zoomRef}` 로 기준을 보존.

### damp 상한 (§2.1)
- `DAMP_LIMIT = 3` 모듈 상수, `dampCount` 지역 카운터. **발동 조건 자체는 무변경**(`improvement < 1e-3`) — 상한만 추가. 게인 하한 = 초기의 1/8.

### zoom 루프 (§2.2)
- 루프 구조: `effGain` 계산 → **가드 선행**(`!isCentered` → 1스텝 재중심 후 `continue`, 그 반복은 줌 미상승) → 줌 스텝.
- 스텝비 클램프: `newZoom = min(z·1.5, max(z/1.5, zoomCorrection(...)))`. `zoomCorrection` 이 이미 `clampZoom` 통과값이라 **재클램프 불요**(상방은 min 으로 더 작아지고 하방은 max 로 z1 이상 → 1~36 범위 유지). 포화 판정 `newZoom === ptz.zoom` 은 스텝비 클램프 뒤에도 유효(z·1.5 ≠ z).

## R1-3. 설계 대비 차이 / 이견 (3건 — 모두 명시 후 진행)

### (1) 테스트 4 픽스처: "probe 무변위" → "probe 프레임 미검출"
설계 §6 표의 케이스 4 는 "probe 후 변위 0 → estimateGain 폴백 경로". **r1 에서 이 경로는 platePtz 를 통해 도달 불가**가 됐다: probe 예측 prior 는 fallback 게인 기준 변위(3° → 0.0676/−0.1449)만큼 이동한 지점인데, 변위가 0 이면 실제 중심은 prior 에서 0.16 떨어져 있어 **매칭 반경 0.08 에서 먼저 기각**된다(= probe 미검출과 동일 분기). 즉 `estimateGain` 의 ε-폴백 가지는 이제 순수 함수 단위로만 도달 가능하다(controlMath 기존 테스트가 이미 덮음).
→ 검증 목표("fallback 게인만으로 수렴")는 그대로 두고 픽스처를 **probe 프레임만 미검출**로 교체. 계약 변경 없음.

### (2) 테스트 9/14 픽스처: "완전 무반응 모델" 사용 불가 → "극둔감 모델 + 정합 fallback"
r0 의 케이스 9(무반응 고정 모델)는 r1 에서 필연적으로 `plate_lost` 가 된다 — **명령해도 안 움직이는 카메라는 매칭 반경 관점에서 "대상 소실"과 구분 불가**하며, 이는 설계 §2.5 의 의도된 귀결이다(§9-7: 예측 오차 < 반경이 전제).
→ `max_iterations`(9) / damp 상한(14) 경로를 **매칭을 유지한 채** 태우기 위해 "실게인이 매우 큰(변위가 극히 작은) 모델 + 그 게인에 맞춘 `fallbackGain*` opts" 를 썼다. 예측이 정확 → 신원 유지, 스텝은 `maxStepDeg` 에 물려 개선이 미미 → 9 는 미수렴(게인 ±1000, 반복당 0.005 개선), 14 는 개선 < 1e-3 로 damp 상시 조건(게인 ±20000, 반복당 3.5e-4). **검증 항목·기대값은 설계 §6 그대로**(9: `max_iterations`+`iterations===maxIterations` / 14: 최종 |gain| ≥ 초기의 1/8).

### (3) 표준 센터링 모델의 게인 부호를 실측 정합으로 교체
r0 의 `centerModel`(실게인 −50/−50)은 r1 fallback(+75/−35)과 **pan 부호가 반대**라, probe 예측이 반경 밖으로 벗어나 probe 가 상시 기각된다(모델 자체가 물리적으로 fallback 과 모순). → 표준 모델을 **+50/−25**(fallback 과 부호 동일, 크기만 다름 → probe 예측 오차 0.04 < 0.08 로 매칭 유지·`estimateGain` 은 여전히 실측)로 교체. 케이스 7 은 zoom 종속 물리가 필요해 `makeWorld` 모델로 교체.

## R1-4. 신규 테스트 13~19 — 실측 재현 방식

라이브 물리를 `makeWorld` 순수 모델로 재현(테스트 파일 상단):
```
gainPan(z) = gainPan0·z0/z          (게인 ∝ 1/zoom)
cx_i = 0.5 + (aX_i + pan)·z/(gainPan0·z0)   → 중심오차 ∝ zoom(방사 확대) + 모든 번호판 동반 이동
cy   = 0.5 + (aY  + tilt)·z/(gainTilt0·z0)
w    = w0·z/z0 ,  화면(0~1) 밖 번호판은 미검출, confidence(0.90+i·0.01) = 신원 태그
```
실측 상수: `z0=1.69, gainPan0=45, gainTilt0=−21, w0=0.0274`, base err=(−0.073, 0.171) → `aX=−3.285°, aY=−3.591°`, 번호판 6개(간격 0.15 = 각도 6.75°, 대상 = index 2 / confidence 0.92).

| # | 케이스 | 확인된 동작(실행 로그) |
|---|---|---|
| 13 | 신원 전환 차단 | **iterations=1** 에 err→0 수렴, 최종 `plate.confidence=0.92`(초기 선정 대상 유지), 실측 게인 45/−21 정확 복원 |
| 14 | damp 나선 차단 | `max_iterations`, 최종 게인 **±2500 = 초기 ±20000 의 1/8**(상한 없으면 0.61 로 소멸) |
| 15 | **줌 단독 성공(실측 C)** | base 오차 그대로 단독 호출 → `iterations=7`, width **0.182**, zoom **11.20**, 신원 0.92 유지, **plate_lost 없음** |
| 16 | 게인 zoom 스케일(실측 B) | zoom 10 가드 명령 pan **+3.285°** = `scaleGainForZoom` 예측치와 일치(r0 의 무스케일 게인이면 maxStepDeg 5° 로 포화) |
| 17 | 매칭 기각 반경 | 대상 1프레임 누락 시 이웃(0.15) 갈아타기 없이 `plate_lost` |
| 18 | 줌 스텝비 클램프 | 첫 줌 명령이 sqrt 해(4.57)가 아닌 **z0·1.5=2.535** 로 절삭, 전 구간 인접비 ≤1.5, 포화·소실 없이 수렴 |
| 19 | 순수 함수 3종 | `gain(1.69→20)=3.8025`, `fb(75/−35 @1)→zoom1.69 = 44.38/−20.71`(실측 45/−21 정합), 예측식·ε 방어 |

> 13·15 의 모델은 **r0 구현이 실제로 실패했던 바로 그 물리**다(신원 동반 이동·오차 방사 확대·게인 zoom 종속). 통과가 라이브 성공을 보장하진 않지만, **이 모델에서 실패하면 라이브에서도 실패**한다는 의미의 필요조건 게이트다.

## R1-5. 완료 게이트 실행 결과 (실제 출력 그대로)

작업 디렉터리: `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`

### `npm run typecheck`
```
> parkagent-setting@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
→ 무오류(진단 출력 없음, exit 0).

### `npx vitest run test/platePtz.test.ts`
```
 ✓ test/platePtz.test.ts (23 tests) 13ms

 Test Files  1 passed (1)
      Tests  23 passed (23)
   Duration  582ms
```
→ 신규 13~19 포함 23 `it` 전량 green.

### `npm test` (전량)
```
 Test Files  151 passed (151)
      Tests  1664 passed (1664)
   Duration  11.17s
```
→ **회귀 0**. 1655 → 1664 (+9 = 신규 테스트 증가분 23−14). `controlMath` 기존 테스트 **무수정 green** = "추가만" 제약의 증명.

## R1-6. 남은 리스크 · 리더에게

1. **라이브 미검증** — 유닛까지만 확정(리더가 §7 ①②③ 직접 수행). 모킹은 `gain ∝ 1/zoom` 핀홀 근사를 **참으로 가정**하므로, Unity 카메라가 이 모델에서 벗어나면 zoom 7~13 구간 가드가 과/부족 보정할 수 있다(설계 §9-6).
2. **`matchRadiusNorm` 0.08 vs `maxStepDeg` 5°** — fallback 게인 기준 5° 변위는 tilt 축 0.143 로 반경의 1.8배다. 즉 **fallback 게인의 실제 오차가 ~55% 를 넘으면 probe 이전 첫 스텝에서 매칭 기각(=`plate_lost`)** 이 날 수 있다. 실측 정합 기본값(75/−35)에선 여유가 있으나, 다른 프리셋에서 `plate_lost` 가 반복되면 이 조합이 1순위 용의자다(`matchRadiusNorm` 상향 또는 `maxStepDeg` 하향으로 조정 가능 — 현 설계에 자동 조정 없음).
3. **설계 §8 재확인 — config `fallbackGainTiltDeg` 기본 +15 는 실측 부호(−21)와 반대**. `PtzCalibrator` 경로는 이번 무접촉이라 **동일 결함을 잠재 보유**한다(PlatePtz 만 −35 로 정정). 별도 과제로 보고.
4. **후속** — `improvement`/`IMPROVE_EPS` 3줄 중복(아래 §3-(1))은 여전히 남아 있다. r1 에서 controlMath 에 순수 함수를 추가할 수 있게 됐으므로 `improvement` 승격도 가능해졌으나, **설계 §2.6 이 열거한 3종 외 추가는 범위 밖**이라 하지 않았다.

---

# (이하 r0 기록 — 갱신 항목은 위 §R1 이 우선)

## 1. 산출 파일 (신규 2개 — 기존 코드 변경 0줄)

| 파일 | 역할 |
|---|---|
| `src/calibrate/platePtz.ts` | 신규 클래스 `PlatePtz`. `PtzCalibrator.calibrateSlot` 의 A단계(pan/tilt 센터링)·B단계(zoom 폭 정렬) 폐루프를 잡 상태머신·`Repository`·writer·LLM 자문 결박에서 풀어 **단독 호출 가능한 공개 메서드 2개**(`centerOnPlate` / `zoomToPlateWidth`)로 재조립. 제어 수식 **신규 0줄**. |
| `test/platePtz.test.ts` | 설계 §6 의 12케이스(vitest, camera/lpd 모킹 · sleep 0ms 주입 · HTTP 없음). 실제 파일에는 14 `it` — 케이스 10(독립성)을 3개 `it` 로 분할했다. |

`git status` 로 확인한 변경면: 위 2파일 추가뿐. `PtzCalibrator.ts` / `controlMath.ts` / `detectMath.ts` / `geometry.ts` / 라우트 / config 무접촉.

## 2. 설계 준수 항목

- **제어 수식 재사용**: `controlMath.ts` 의 `plateCenterError` · `pickNearestPlate` · `estimateGain` · `panTiltCorrection` · `zoomCorrection` · `isCentered` · `isWidthConverged` · `dampGain` 과 `geometry.quadBoundingRect` 를 그대로 import. 신규 수학은 없다.
- **미import 확인**: `detectMath` · `fovBaseV` · `Repository` · `SetupBrain` · `detectPipeline` 은 import 하지 않는다.
- **생성자 주입**: `ICameraClient` / `LpdClient` / `sleep?` 를 `PlatePtzDeps` 로 주입. 카메라 I/O 는 `requestImage`(이동+캡처 원자)만 사용 — `move()` 미사용.
- **★ PTZ 에코 불신**: 응답 pan/tilt/zoom 을 상태로 삼지 않고 **내가 명령한 값(commanded)** 만 추적. 모든 캡처는 `requestImage(camIdx, presetIdx, ptz)` 에 명령값 override 를 넘긴다. 테스트 모킹도 응답 echo 0/0/1 을 돌려주어 이 가정을 재현·검증한다(케이스 1·6 에서 명령 궤적 `moves` 로 확인).
- **zoom 불변 계약**: `centerOnPlate` 는 매 반복 `ptz = { pan, tilt, zoom: startPtz.zoom }` 로 재구성 — 구조적으로 zoom 을 바꿀 수 없다. 케이스 1 이 명령 전량의 `zoom === startPtz.zoom` 을 검증.
- **드리프트 가드 1스텝**: `zoomToPlateWidth` 의 pan/tilt 변경은 §2.3 가드(`panTiltCorrection` 1스텝 + 재검출 1회)뿐.
- **상호 독립**: 두 메서드는 서로를 호출하지 않는다(케이스 10 이 각각 단독 green 확인).
- **예외 정책**: 검출 소실 → `ok:false` + reason. 전송 오류(`LpdApiError`/`CameraApiError`) → 삼키지 않고 전파(케이스 12).
- **포화 판정**: `newZoom === ptz.zoom && width < target − widthTol` → `zoom_saturated`. `zoomMax` 값을 알 필요 없이 `clampZoom` 캡슐화 유지.
- JSDoc 에 §2.3 실패 모드("센터링 후 호출 권장, 단독 호출 시 `plate_lost` 가능")를 한글로 명기.
- ESM `.js` 확장자 import, strict typecheck 통과.
- 메서드별 opts 오버라이드(`over?`)는 **넣지 않았다**(설계 §2.0 — 테스트가 인스턴스 단위 opts 로 충분히 단순했다).

## 3. 설계 대비 차이 / 이견 (2건 — 모두 사소, 승인 불요 판단)

### (1) `improvement()` / `IMPROVE_EPS` 3줄 중복 — 불가피

§2.1 의 "개선 정체(improvement < 1e-3) → dampGain" 을 구현하려면 `improvement` 헬퍼가 필요하나, `PtzCalibrator.ts` 의 `improvement`/`IMPROVE_EPS` 는 **module-private(export 안 됨)** 이다. import 하려면 기존 파일에 `export` 를 추가해야 하는데 이는 "기존 코드 변경 0줄" 제약 위반이라, `platePtz.ts` 에 동일 정의를 복제하고 주석으로 출처를 명기했다.
→ 후속 과제(설계 §8 의 `PtzCalibrator` → `PlatePtz` 위임 리팩토링) 시점에 `controlMath.ts` 로 승격해 단일화하는 것이 옳다. 지금은 3줄 중복이 기존 파일 수정보다 싸다고 판단.

### (2) 테스트 케이스 9 픽스처를 "부호 반대 모델" → "보정 무반응(고정) 모델" 로 교체

설계 §6 표의 케이스 9 픽스처는 "게인 부호 반대 모델(발산)" 이지만, **부호가 반대인 모델로는 발산하지 않는다** — probe 가 부호를 포함해 게인을 실측하므로(`estimateGain` 이 `dPan/dX` 로 음수 게인을 그대로 반환) 모델 부호가 뒤집혀도 폐루프는 정상 수렴한다. 이것이 probe 설계의 존재 이유다(설계 §3 "부호 무관").
→ 검증 목표(`reason='max_iterations'`, `iterations === maxIterations`)는 그대로 두고, 픽스처만 **명령과 무관하게 번호판이 고정된 무반응 모델**(기존 `ptzCalibrator.test.ts` 의 `stuckLpd` 패턴)로 교체해 상한 소진 경로를 확정적으로 태웠다. 검증 항목·기대값은 설계와 동일하므로 계약 변경 없음.

## 4. 미구현 항목 (설계상 이번 범위 밖 — 의도적)

- 라우트/MCP 도구 노출 없음(설계 §5).
- LLM 자문(`SetupBrain`) 미연동 — 순수 결정형(설계 §5·§9-3).
- 오픈루프(FOV 모델) 초기샷 가속 없음(설계 §3).
- `PtzCalibrator` 를 `PlatePtz` 위임으로 리팩토링하지 않음(설계 §8 후속 과제).
- **라이브 경험적 검증(설계 §7) 미수행** — 본 보고는 유닛(모킹 폐루프)까지만 확정. Unity 시뮬(:13100)·da_lpd_api(:9082) 기동 하의 실측(센터링 후 |err|≤0.03, 줌 후 폭 0.18~0.22, 스샷)은 미완이며 **조용히 생략한 것이 아니라 미완임을 명시**한다.

## 5. 완료 게이트 실행 결과 (실제 출력 그대로)

작업 디렉터리: `D:\Work\Parking3D\AgentVLA\ParkAgent-plate-ptz\SettingAgent`

### `npm run typecheck`
```
> parkagent-setting@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
→ 무오류(진단 출력 없음, exit 0).

### `npx vitest run test/platePtz.test.ts`
```
 ✓ test/platePtz.test.ts (14 tests) 10ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Duration  636ms
```
→ 신규 12케이스(14 `it`) 전량 green.

### `npm test` (전량)
```
 Test Files  151 passed (151)
      Tests  1655 passed (1655)
```
→ 기존 포함 전량 green, **회귀 0**.

### 폐루프 실측 궤적(테스트 로그 발췌 — 수렴 특성 참고)
| 케이스 | 결과 |
|---|---|
| 1. 센터링 수렴 | `iterations:3`, `errX:0, errY:0`, `ptz{pan:10, tilt:15, zoom:1}` — zoom 불변 확인 |
| 4. probe 무변위(fallback 게인) | `iterations:7`, `errX:0.007, errY:0.027` — fallback 20/15 로도 수렴 |
| 6. 줌 단독 | `iterations:4`, `plateWidth:0.183`, `zoom:3.668`, `pan:0, tilt:0` — 가드 미발동 |
| 7. 드리프트 가드 | `iterations:4`, `plateWidth:0.183`, `zoom:3.668`, **`pan:1.828`** — 전달 게인(-50) 기반 1스텝 재중심 발동(fallback +20 이었다면 부호가 반대) |
| 8. 포화 | `zoom:36`, `plateWidth:0.144` → `zoom_saturated` |
| 9. 상한 소진 | `errX:0.3, errY:0.3` → `max_iterations`, `iterations:5` |

`zoomCorrection` 의 sqrt 감쇠는 모킹 선형 모델(w ∝ zoom)에서 **4회**에 폭 0.183(허용 0.18~0.22) 수렴 — 설계 §9-4 의 "15회 내 수렴" 우려는 유닛 수준에선 여유. 실제 시뮬 곡선은 라이브 검증 대상.

## 6. 검증자·문서화에게

- **검증자**: 신규 2파일만 보면 된다. 라이브(설계 §7) 미수행 — cam1 프리셋 중 번호판 가시 슬롯 선정부터 필요. `data/slot_ptz.json` 은 전량 실패 기록이라 신뢰 금지(설계 §7).
- **문서화**: 핵심 메시지는 "**기존 모듈 변경 0줄, 신규 2파일**". 영향면은 `controlMath`/`geometry` 가 import 당하는 것뿐(순수 함수라 부작용 없음). 위 §3 의 이견 2건(3줄 중복 · 케이스 9 픽스처 교체)을 문서에 반영할 것.
