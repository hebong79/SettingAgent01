# 03 검증 — 개별 center+zoom 반경 게이트 + 줌 사다리 (B 모드 이터레이션 1)

대상 계약: `_workspace/00_goal.md` · 설계 `01_architect_plan.md` · 구현 `02_developer_changes.md`
작성: 2026-07-21 · 검증자(qa-tester)

## 0. 한 줄 결론

**신규 로직은 요구 1~6 을 유닛 수준에서 전부 충족하고 회귀 0**(187파일/2186테스트 전건 통과, `tsc --noEmit` 클린).
배선도 라우트→사다리까지 실물로 연결됨을 확인했다. 다만 **라이브에서 실패로 이어질 결함 후보 2건**(줌 사다리 상한이
실사용 config 에서 줌 상한을 소진하지 못함 / 사다리가 줌아웃을 못 해 근거리 클릭이 새로 실패)을 발견했다 — §5.

---

## 1. 실행 결과 (그대로)

| 항목 | 명령 | 결과 |
|---|---|---|
| 기준선(구현자 보고 확인) | `npx vitest run` | **184 파일 / 2147 테스트 통과** (신규 테스트 추가 전) |
| 타입 | `npx tsc -p tsconfig.json --noEmit` | 통과(출력 없음) |
| 최종 전건 | `npx vitest run` | **187 파일 / 2186 테스트 통과, 실패 0** |

신규 테스트 파일 3건 / 39 케이스 (전부 통과):

| 파일 | 케이스 | 담당 |
|---|---|---|
| `test/platePtzLadder.test.ts` | 21 | R1 반경 게이트 · R2 사다리(네이티브/기하) · R3 명시 사유 · 경계 관찰(L0/L1) |
| `test/ptzCalibratorLadder.test.ts` | 13 | 진입 분기표(cfg × 네이티브 × mode) · R4 회귀 가드 · 하위호환 · R5 카메라 우선순위 |
| `test/calibratePointLadderWiring.test.ts` | 5 | **배선 무결성(라우트→사다리 실물 체인)** · R5 파이프라인 카메라 접촉 0 |

기존 회귀 대상(`centeringSlot`·`centeringOwnership`·`centeringPreAim`·`centeringBoundary`·
`calibrateRoutes.point`·`calibratePointSource`·`ptzCalibrator.point`·`controlMath`·`platePtz`) **무수정 전건 통과**.

---

## 2. 필수 테스트 4건 — 대조

### ① 반경 밖 판만 있을 때 `no_plate_near_click` (1순위 목적)
마스터 목격 시나리오를 그대로 재현했다: **클릭 = 화면 좌측 끝(0.05, 0.5), 검출 판은 중앙 근처(0.60/0.68)에만**.

- `ok:false` · `reason:'no_plate_near_click'` · **`plate === null`**(중앙 판을 대신 채택하지 않음) · `plateWidth === null`
- `iterations === 0`, **캡처 1회**(폐루프 미진입) → 카메라가 엉뚱한 차로 **움직이지 않는다**
- 같은 프레임에서 게이트를 빼면(`initialRadiusNorm` 미주입) **중앙 왼쪽 판(conf 0.91)을 조용히 채택**하고 폐루프에 진입한다
  → 마스터가 목격한 버그가 실재했고 게이트가 정확히 그것을 막는다는 대조 증명
- 구분 검증: 검출 0건 → `no_plate` / 반경 안(0.06)에 판 있음 → 정상 선정(정상 케이스 미살상)
- 라우트 응답까지 전달됨을 실물 체인으로 확인(`mode:'plate'` → 200 + `reason:'no_plate_near_click'`, `move` 0회)

### ② 네이티브 유무 분기
스텁 카메라의 호출 기록으로 검사.

- 네이티브 있음 → `centerOnPoint` ≥1회(첫 호출 인자 = 클릭 지점 그대로), **`move` 0회**
- 네이티브 없음 → `centerOnPoint` 0회, `move` ≥1회이며 첫 조준 pan 이 기하 해 −21.7° 와 일치(= `maxStepDeg` 5° 로 잘리지 않음)
- `getPtz` 미지원 소스 → setcenter 반환값으로 강등하되 **zoom 은 명령값 유지**(§5-2 검증)
- setcenter 예외는 삼키지 않고 전파(조용한 성공 금지)
- `move` 거절 → `aim_failed`

### ③ 최대 줌 미검출 시 명시 사유
- 전 구간 LPD 빈 배열 → `plate_not_found_at_max_zoom`, zoom 이 `zoomMax(36)` 에서 정지, `plate:null`
- **§5-3 분기 확인**: 최대 줌까지 계속 반경 밖 판만 검출 → `no_plate_near_click`(LPD 한계가 아니라 클릭 위치 문제)
- 검출되지만 물리적으로 확대 불가 → `zoom_saturated`(`ok:false`) — **성공 출구는 폭 수렴 단 하나**
- latch 후 대상 소실 → `plate_lost`(이웃을 대신 잡지 않음, 마지막 신원 유지)

### ④ 시뮬 경로 기존 동작 불변
- `pointZoomLadder` 미설정(=auto) + 네이티브 없는 카메라 → 호출 순서 `['center','zoom']`, **`ladder` 미포함**
- 사다리 전용 opts(`ladderMaxRungs`·`nativeAimSettleMs`)가 기존 경로 opts 로 **새지 않는다**
- 반환 shape 도 기존과 동일(`{ok, ptz, plateWidth}`)
- 단, **Requirement 1 게이트는 시뮬 클릭 경로에도 적용**된다(`initialRadiusNorm: 0.10` 주입 확인) — 구현자 §6-3 의
  "미세 성공률 변화 가능"은 사실이며 의도된 변화(거짓 성공 제거)다. 배치 경로에는 미주입 확인.

---

## 3. 배선 무결성(리더 지시 5) — 호출 체인 추적

코드로 끝까지 추적했고, **끊긴 구간 없음**.

```
web/index.html:212  <option value="center-zoom">개별 center+zoom</option>
web/app.js:3413     mouseup → calPointCenter(nx, ny, 'plate-zoom')
web/app.js:2367     POST /calibrate/point { cam, preset, point, mode:'plate-zoom', source: state.source }
calibrateRoutes.ts:73   source → new CameraSourceClient(src, cameraCfg)      ← 네이티브 centerOnPoint 승계(:21)
calibrateRoutes.ts:82   zoom = (mode === 'plate-zoom')  → true
calibrateRoutes.ts:83   calibrator.centerOnPoint(cam, preset, point, { zoom, camera })
PtzCalibrator.ts:195    opts.zoom !== false && ladderEnabled(cam ?? this.camera)   ← 'auto' = centerOnPoint 보유 여부
PtzCalibrator.ts:196-198 makePlatePtz({...baseOpts, ...ladderOpts}, cam).centerAndZoomByLadder(...)
platePtz.ts:465          ① recenterTo(point) → ② rung 루프
platePtz.ts:587          native.call(this.camera, ...) → CameraSourceClient → RealPtzSource.centerOnPoint (ptz_centering setcenter)
server.ts:269-274        sources/cameraCfg 주입됨 → source 지정이 살아 있다
```

`test/calibratePointLadderWiring.test.ts` 가 이 체인을 **스텁 없이 실물로** 태워 고정했다(라우트 inject →
실제 `PtzCalibrator`+`PlatePtz`+`CameraSourceClient` → 소스 `centerOnPoint`/`snapshot` 발화 → 응답 `ok:true`,
`plateWidth 0.18~0.22`). `'off'` 스위치로 사다리가 꺼지는 것도 라우트 레벨에서 확인.

### Requirement 5 — source 라우팅 유지
- 파이프라인 카메라를 **모든 메서드가 접촉을 기록하는 스텁**으로 두고 사다리를 완주 → **접촉 `[]`(0회)**.
  `clampZoom` 조차 새지 않는다. 사다리의 카메라 접촉은 전부 주입된 `CameraSourceClient` 로 갔다.
- 분기 판정 기준도 주입 카메라다: 파이프라인이 네이티브여도 주입 카메라가 비네이티브면 사다리를 타지 않고,
  그 반대도 성립. `makePlatePtz` 2번째 인자로 주입 카메라가 그대로 전달됨을 동일성(`toBe`)으로 확인.
- `source` 미지정 시엔 기존대로 파이프라인 카메라(회귀 0).

---

## 4. Requirements 1~6 충족 대조표

| # | 요구 | 판정 | 근거 |
|---|---|---|---|
| 1 | 최초 선정 반경 게이트·파라미터화·근거·정상케이스 미살상 | **충족** | `initialRadiusNorm`(신규·기본 off·클릭 경로만 주입, cfg 로 튜닝 가능). T1 5케이스. 게이트 유무 대조로 버그 실재 증명 |
| 2 | 줌 사다리(①조준 ②확대+LPD ③재중심 ④수렴 반복), 가산·기존 파괴 금지 | **충족** | T2/T5. 조준이 검출보다 먼저임을 대조 케이스로 고정(광각 미검출 상황에서 기존 `centerOnPlate` 는 `no_plate` 로 시작조차 못 하고 사다리는 수렴). 기존 2메서드 무변경·미호출 |
| 3 | 최대 줌 미검출 → 위장 성공 없이 명시 사유 | **조건부 충족** | 사유 체계·성공 출구 단일화는 검증됨. 단 **`plate_not_found_at_max_zoom` 이 실제로는 최대 줌이 아닌 지점에서 나온다**(§5-①) |
| 4 | 시뮬 98% 하드 제약, 네이티브 분기로 기존 경로 보존 | **충족(구조적)** | 'auto' 기본에서 시뮬은 신규 코드 0줄 실행. 배치 경로 `initialRadiusNorm` 미주입. 기존 2147 테스트 무수정 통과. ※시뮬 **클릭** 경로는 게이트가 걸리므로 "부정확한 클릭의 조용한 오채택"이 실패로 바뀐다(의도) |
| 5 | source 라우팅이 사다리 전 구간 유지 | **충족** | 파이프라인 카메라 접촉 0 을 실물 체인으로 증명(§3) |
| 6 | vitest 최소 4건 | **충족(39건)** | §1 |

---

## 5. 발견한 결함 후보 (리더 → 구현자 회신용)

### ① [높음] `ladderMaxRungs=8` 이 **실사용 config 에서 줌 상한을 소진하지 못한다** — 사유 문자열도 사실과 다름

- **근거**: 구현자 §3 의 근거는 "1.5^8 ≈ 25.6배 → zoom 1 출발에서도 상한(36)을 사실상 소진"이다.
  그러나 `config/tools.config.json:71` 의 **실제 값은 `maxZoomStepRatio: 1.3`**(1.5 아님)이고,
  `baseOpts()` 가 이 값을 사다리에 그대로 전달한다.
- **재현**(`platePtzLadder.test.ts` L0, 통과 중):
  `maxZoomStepRatio:1.3` · `ladderMaxRungs` 기본 8 · 전 구간 미검출 → 사다리는 **zoom 10.60(=1.3^9)** 에서 포기하고
  `reason:'plate_not_found_at_max_zoom'` 을 보고한다. **카메라 상한은 36** 으로 아직 3.4배가 남아 있다.
- **영향**: 이번 작업의 표적인 **먼 차량**은 zoom 10 에서 여전히 미검출일 수 있다. 사다리가 "찾을 때까지 확대"를
  끝까지 하지 못하고 중도 포기하면서, 마스터에게는 "최대 줌에서도 못 찾았다(LPD 한계)"고 보고한다 →
  **Goal 의 "실패는 실패로, 사유는 정직하게"에 어긋나는 오보**이며 성공률 개선분도 잘린다.
- **권고**: `ladderMaxRungs` 기본값을 상수로 두지 말고 `ceil(log(zoomMax/startZoom)/log(maxZoomStepRatio))`
  로 산출하거나(무한루프 방지 바운드는 별도 상한으로), 최소한 config 에 `ladderMaxRungs: 14` 를 명시할 것.
  검증 완료: 같은 조건에서 `ladderMaxRungs:14` → 실제로 zoom 36 까지 도달(L0 두 번째 케이스).

### ② [중간] 사다리가 **줌아웃을 하지 못한다** — 근거리 클릭이 새로 실패한다(경로 비대칭 회귀)

- **근거**: `platePtz.ts:522-530` 은 `zNext = clampZoom(min(zWant, zoom×ratio))` 이고, `zNext <= zoom` 이면
  무조건 `zoom_saturated` 로 종료한다. 목표보다 **큰** 판(=줌아웃이 필요한 경우)에 대한 하강 경로가 없다.
  기존 `zoomToPlateWidth:415` 는 `Math.max(zoom/ratio, z1)` 로 **양방향**이다.
- **재현**(L1, 통과 중): zoom 4 에서 판 폭 0.30(목표 0.20 초과) →
  사다리 `ok:false, reason:'zoom_saturated'` / 같은 상황에서 `zoomToPlateWidth` 는 zoom 2.81 로 **수렴 성공**.
- **영향**: 실카는 이제 `mode:'plate-zoom'` 이 **사다리 전용**이다(실패해도 기존 경로로 되돌아가지 않는다 — 이건 옳다).
  따라서 "이미 충분히 크게 보이는 차를 클릭"하는 케이스가 **기존에는 성공했는데 이제 실패**한다.
  Goal 배경진단의 "가까운 것만 성공(10%)"이 곧 기존 성공분이므로, 그 성공분 일부를 잃을 수 있다.
- **권고**: rung 의 다음 zoom 을 대칭 클램프로 바꾸고(`min(zoom×r, max(zoom/r, zWant))`),
  포화 판정을 "폭 미달일 때만"으로 좁힐 것(기존 `zoomToPlateWidth:417` 과 동일 관용구).

### ③ [낮음] 포화 로그 문구가 사실과 다름
`platePtz.ts:526` 의 `'사다리 zoom 포화(폭 목표 미달)'` 는 ②의 **폭 초과** 케이스에서도 그대로 찍힌다
(재현 로그: `plateWidth: 0.3` 인데 "폭 목표 미달"). 라이브 진단을 오도한다.

### ④ [낮음] rung 기각 로그의 `click` 필드가 오해를 부른다
`platePtz.ts:540` 은 `click:{point.x, point.y}` 를 찍지만 `nearestDist` 는 **화면중앙 기준** 거리다.
조준이 성공했다면 둘은 같지만, 기하 폴백(`'always'`)에서 게인이 틀려 조준이 빗나가면 필드명이 거짓이 된다.
`prior:{0.5,0.5}` 를 함께 남기거나 필드명을 바꿀 것.

### ⑤ [정보] `plate_not_found_at_max_zoom` vs `no_plate_near_click` 은 **마지막 rung** 의 상태로만 갈린다
중간 rung 들이 전부 반경 기각이었어도 마지막 rung 에서 검출이 0 이면 `plate_not_found_at_max_zoom` 으로 보고된다
(그 반대도 성립). 사유가 뒤바뀔 수 있으나 rung 별 로그가 남으므로 진단 불능은 아니다. 개선하려면 "기각 이력"을 누적할 것.

---

## 6. 구현자 §5 (설계와 달라진 점 4건) 검토

| # | 변경 | 판정 | 근거 |
|---|---|---|---|
| 5-1 | 기하 폴백 조준 상한 `maxStepDeg(5)` → `LADDER_AIM_MAX_STEP=90` | **타당(설계 결함 지적이 옳다)** | 수치 확인: 게인 −62@zoom1 에서 클릭 오차 0.35 는 21.7° 를 요구 → 5° 클램프면 조준이 **4.3분의 1**만 이뤄져 경로가 성립하지 않는다(테스트로 고정). 개방루프 1샷이라 진동 방지 클램프가 불요하고, 같은 성격의 `PREAIM_MAX_STEP=90` 선례와 정합. **반례 없음**(최대 오차 0.5 → 31°, 90 은 이상 게인 방어 상한으로만 작동). 네이티브 경로에는 무영향 |
| 5-2 | 네이티브 재중심 후 zoom 은 조회값이 아니라 **명령값** 유지 | **타당** | `setcenter` 는 zoom 미변경 → 조회 zoom 을 채택하면 장비 raw↔뷰어 왕복 반올림(`mapRange`)이 사다리 zoom 상태에 누적된다. 이 파일의 명시 불변식("명령 PTZ 추적·응답 echo 불신")과 정합. `getPtz` 미지원 소스 강등 경로까지 테스트로 고정. **반례 없음** |
| 5-3 | 최대줌 미검출 시 `rejected` 면 `no_plate_near_click` | **타당(단 §5-⑤ 단서)** | 마스터의 다음 행동이 정반대("클릭 다시" vs "LPD 확인")라 구분이 옳다. 다만 판정이 마지막 rung 상태에만 의존 |
| 5-4 | `everDetected` 제거 | **타당** | 코드로 확인: `latched` 분기가 먼저 return 하므로 설계 의사코드의 `everDetected ? 'zoom_saturated' : ...` 는 도달 불가 데드 브랜치였다. 사유 결정 결과 동일 |

---

## 7. 검증하지 못한 것 (은닉 금지)

1. **실카 라이브 통합은 전혀 검증하지 못했다.** 휴컴스 장비 접속이 불가하다. 아래는 전부 **가정 그대로 남아 있다**:
   - `setcenter` 잔차가 rung 마다 게이트(0.08) 안으로 수렴하는가(설계 §9-1, 이 설계의 최대 위험).
   - `nativeAimSettleMs=1000` 이 충분한가. **부족할 경우의 피해가 설계 문서보다 크다**:
     슬루 중 `getPtz` 값이 다음 rung 의 `requestImage(ptz override)` 로 나가면 `RealPtzSource.move` 가
     `waitUntilSettled` 로 **그 중간 지점까지 실제로 카메라를 되돌린다** → 센터링이 부분 취소된다.
     (코드 확인: `RealPtzSource.centerOnPoint:237` 에 `waitUntilSettled` 없음 — 구현자·설계자 진술 사실 확인)
   - LPD 가 zoom 몇 배부터 먼 판을 잡는지(사다리 rung 수 요구량의 실제값).
2. **시뮬 라이브 98% 재측정을 하지 못했다.** 유닛으로는 "시뮬이 신규 코드를 실행하지 않는다"까지만 증명했다.
   시뮬 **클릭** 경로는 반경 게이트가 새로 걸리므로 클릭 정확도에 따라 성공률이 변할 수 있다(의도된 변화).
3. **뷰어 UI 실측 미확인**. `reason` 한글 매핑 테이블이 없다는 구현자 보고는 코드로 재확인했으나(뷰어는 서버 문자열을
   `종료(reason)` 로 그대로 표시), 마스터 화면에서 신규 3개 사유가 어떻게 보이는지는 눈으로 못 봤다.
4. 성능(사다리 rung 수 × 정착시간 = 체감 소요)은 측정하지 못했다. 네이티브 경로는 rung 마다
   `nativeAimSettleMs(1000ms)` + `settleMs(300ms)` + 장비 슬루가 붙어 **최악 10 rung ≈ 15초 이상**이 될 수 있다 — 라이브 채록 필요.

---

## 8. 라이브 1회차에서 마스터가 채록해야 할 것

1. 실패 시 UI `종료(reason)` 문자열 그대로.
2. 서버 로그 `cat:'centering', phase:'ladder'` 의 rung 별 `zoom / errX / errY / plateWidth / plates / nearestDist`.
   → `errX/errY` 가 rung 을 거치며 0.08 안으로 줄어드는지가 **설계의 유일한 미검증 물리 가정**의 답이다.
3. `phase:'gate'` 로그의 `nearestDist` 분포 → 반경 0.10 이 적정한지(오탐이면 0.13, 오채택이면 0.08).
4. 클릭 → 완료까지 체감 시간.

---

# [추가] 재검증 — 수정 1~4 반영 후 (델타 검증)

검증: 2026-07-21 · 검증자(qa-tester) · 대상: `02_developer_changes.md` 의 「QA 결함 회신 수정(A/B/C)」 + 「수정 4 latch 인지형 사다리 배율」

## R1. 회귀 전건 (내가 직접 돌린 결과 그대로)

| 항목 | 명령 | 결과 |
|---|---|---|
| 타입 | `npx tsc -p tsconfig.json --noEmit` | **통과**(출력 없음, exit 0) |
| 전건 | `npx vitest run` | **187 파일 / 2192 테스트 전건 통과, 실패 0** |
| 델타 검증 후 재확인 | `npx vitest run`(임시 파일 삭제 후) | **187 / 2192 통과** — 소스 무수정 확인(`git status` 상 소스 3파일만 기존 변경) |

구현자 보고(187/2192)와 **일치**. 소스는 손대지 않았다.

델타 검증은 임시 파일 `test/_qaDelta.tmp.test.ts`(19 케이스)로 수행하고 **보고 후 삭제**했다
(재현 필요 시 아래 각 항목의 파라미터로 재작성 가능 — 전부 기존 `platePtzLadder.test.ts` 하네스 규약과 동일 모델).
모든 케이스는 **실사용 config 값**(`targetPlateWidth 0.215 · centerTol 0.03 · widthTol 0.015 · maxZoomStepRatio 1.3`)
+ 클릭 경로 주입값(`initialRadiusNorm 0.10`) + `preLatchZoomStepRatio` 기본 2.0 으로 돌렸다.

## R2. 수정 1 실효 — **유효함**(가장 중요한 확인 항목, 통과)

`ladderRungBudget` 이 `min(maxZoomStepRatio, preLatchZoomStepRatio)` 로 바뀐 뒤에도 상한 도달은 유지된다.

| 케이스 | 결과 |
|---|---|
| ratio 1.3 · 전 구간 미검출 · start zoom 1 | zoom **36 도달**, `plate_not_found_at_max_zoom` (rung 11: 1→2→4→8→16→32→36…) |
| 위와 동일하되 `preLatchZoomStepRatio:1.3`(구 동작) | zoom **36 도달** |
| 광각 미검출(z≥3 부터 검출) → 목표 폭 0.215 수렴 필요 | **`ok:true`** — latch 후 1.3 정밀 구간이 예산 안에서 완주(예산이 latch 후를 자르지 않는다) |

→ **수정 4 가 수정 1 을 무효화하지 않는다.** 예산을 작은 배율 기준으로 잡은 판단은 옳고, 성긴 구간이 예산을 덜 쓰는 구조도 확인됐다.

## R3. 수정 2 실효 — **유효함**

| 케이스 | 사다리 | 기존 `zoomToPlateWidth`(대조) |
|---|---|---|
| start zoom 4 · 판 폭 0.30(목표 초과) | **ok:true**, zoom 2.867, 폭 0.215 | ok:true, zoom 2.989, 폭 0.224 |

사다리 도입 전 성공하던 근거리 케이스가 사다리에서도 성공한다. §5-② 회귀는 **해소**.
다만 이 수정이 새 결함 1건을 드러냈다 → **R6-①**.

## R4. 수정 3 실효 — **유효함**

- `rejectedEver` 누적이 사유 분기를 실제로 개선했다: 「저배율에서 반경 밖 이웃 판만 기각되다가 고배율에서
  그 판이 화면 밖으로 나가 검출 0 이 된」 프레임에서 최대줌 도달 사유가 **`no_plate_near_click`** 으로 나온다.
  누적 전이었다면 마지막 rung 상태(검출 0)만 보고 `plate_not_found_at_max_zoom`(=LPD 한계) 로 **오보**했을 케이스다.
  마스터의 다음 행동(클릭 다시 vs LPD 점검)이 정반대이므로 실질 개선이 맞다.
- 포화 로그: 문구 중립화(`'사다리 zoom 포화(목표 폭 도달 불가)'`) + `targetPlateWidth` + `shortfall:'under'|'over'`
  → 폭 초과 케이스에서 거짓말하지 않는다(코드 `platePtz.ts:588-596` 확인).
- 기각 로그: `nearestDistFromPrior` + `prior:{0.5,0.5}` 병기 → 필드명이 기준을 밝힌다. `click` 은 문맥용으로 남아
  조준이 빗나가도 로그가 거짓이 되지 않는다. **오독 소지 해소**.

## R5. 거짓 성공 제거(1순위 목적) — **여전히 차단됨**

수정 4건이 모두 들어간 상태에서 마스터 목격 시나리오를 재현했다.

| 경로 | 결과 |
|---|---|
| 사다리(`centerAndZoomByLadder`) · 클릭 (0.05, 0.5) · 판은 화면중앙에만 | `ok:false` · `reason:'no_plate_near_click'` · **`plate === null`** |
| 비사다리(`centerOnPlate`) 동일 조건 | `ok:false` · `reason:'no_plate_near_click'` · `plate === null` |

**중앙 판을 대신 채택하는 일은 없다.** 이 이터레이션의 1순위 목적은 유지된다.

## R6. 새로 발견한 결함 2건 (수정 1·2·4 의 상호작용에서 나온 델타 결함)

### ① [중간] `ladderRungBudget` 이 **하강(줌아웃) 칸수를 계산에 넣지 않는다** — 수정 2 가 연 경로를 수정 1 이 자른다

- **원인**: `platePtz.ts:665-668` 은 `climbs = ceil(log(zoomMax/startZoom)/log(ratio))` 로 **등반만** 센다.
  `startZoom` 이 `zoomMax` 에 가까우면 `climbs≈0` → 예산은 `LADDER_RUNG_SLACK(4)` 뿐인데,
  수정 2 로 열린 **줌아웃 수렴은 그보다 많은 칸을 쓸 수 있다**.
- **재현**(실사용 config, 판이 최대줌에서 큰 경우 — w1=0.02, start zoom 36):
  - 자동 예산 → 캡처 5회(zoom 36→27.69→21.30→16.39→12.60)에서 **예산 소진**,
    `ok:false · reason:'max_iterations'` · 폭 0.252 (목표 0.215 직전에서 잘림. 한 칸만 더 있으면 10.75 로 수렴)
  - 같은 케이스에 **`ladderMaxRungs:8` 명시**(=수정 1 이전의 구 고정 상수) → **`ok:true`**, zoom 10.75, 폭 0.215, 6칸
  - start zoom 30 → 예산 5칸을 **정확히 다 써서** 간신히 성공(여유 0). start 20/10/4 는 정상.
- **즉, 구 상수 8 이 성공시키던 케이스를 자동 예산이 실패시킨다** — 수정 1 이 만든 좁은 회귀다.
- **도달 경로가 실재한다**: 사다리는 실패해도 **PTZ 를 복원하지 않는다**(R5 재현에서 실패 후 카메라가 zoom 36 에 남았다).
  즉 「한 번 실패 → 카메라 zoom 36 에 주차 → 마스터가 가까운 차를 다시 클릭」이면 정확히 이 조건이 된다.
- **위험도 판단**: 거짓 성공이 아니라 정직한 실패이고(사유 `max_iterations`), 판이 최대줌에서 상당히 커야
  발생한다(zoom 36 기준 폭 > 약 0.61). 그래서 **중간**.
- **권고**: 예산을 양방향으로 — `span = max(zoomMax/startZoom, startZoom/zoomMin)` 로 두고 동일 공식 적용.
  (부수적으로 `max_iterations` 라는 사유가 "예산 소진"을 뜻한다는 게 마스터에게 잘 안 읽힌다 — 로그의 `rungBudget` 필드로만 구분된다.)

### ② [중간] 수정 4 의 `sawAnyPlate` 완화는 **latch 창 건너뜀을 막지 못한다** — 리더 근거의 허점이 실측으로 살아 있다

- **논리**: `sawAnyPlate` 는 **첫 검출 rung 에서야 켜진다**. 그런데 latch 창의 **시작점이 곧 첫 검출 지점**이다
  (창 = `k ∈ [k_검출, radius/e1]`). 따라서 첫 검출 rung 이 이미 반경 밖이면 **완화가 발동한 시점에 이미 늦었다**.
  게다가 조준 후 오프셋은 `e1·k` 로 **zoom 에 단조 증가**하므로 창을 지나치면 **회복 불가**다(이후 1.3 으로 낮춰도 멀어지기만 한다).
- **재현**(실사용 config · 판 각오프셋 1.333°(=e1 0.0215) · LPD 최소 검출폭 0.06 → 검출 시작 zoom 3 → 창 `[3, 4.65]`, 배율폭 1.55):

  | 시작 zoom | `preLatchZoomStepRatio` 2.0(현행 기본) | 1.3(구 동작) |
  |---|---|---|
  | 1.20 | **FAIL** `no_plate_near_click` (1.2→2.4→**4.8**: 창 통과, 첫 검출이 이미 반경 밖) | **OK** (…→3.43 latch → 10.75 수렴) |
  | 1.00~2.00 를 0.05 간격 스윕(21점) | **6/21 실패(29%)** | **0/21 실패** |

- **대가가 시간 이득을 역전시킨다**: 창을 놓친 뒤에도 사다리는 zoom 36 까지 계속 오른다(재현 로그 캡처 11회).
  즉 이 케이스에서 수정 4 는 "40% 빨라짐"이 아니라 **성공 → 전량 실패 + 최대줌까지 낭비**가 된다.
- **완화가 듣는 구간도 있다**: 창의 배율폭이 2.0 이상이거나(먼 차·정확한 클릭), 그리드 위상이 창에 걸리면 정상 latch 한다.
  스윕상 창폭 1.55 에서 실패율 ≈ `1 − log(1.55)/log(2.0)` 과 일치(이론값 37%, 실측 29%).
- **끈적임(깜빡이는 검출)은 안전 방향으로 확인됨**: `sawAnyPlate` 는 한 번 켜지면 내려가지 않는다
  (`platePtz.ts:555`). 반경 밖 판이 한 rung 보였다 사라진 프레임에서 이후 인접 zoom 비가 **전부 1.3**임을 확인했다.
  → "깜빡임 때문에 성긴 배율로 되돌아가는" 반례는 **없다**.
- **권고(택1, 이터레이션 2)**: (a) `preLatchZoomStepRatio` 기본을 1.6 이하로 — 창폭 1.55 구간을 대부분 덮는다;
  또는 (b) `sawAnyPlate` 가 처음 켜지는 rung 이 **`rejected` 였다면 직전 칸과의 기하평균으로 한 번 되돌아가 재시도**
  (창을 건너뛴 것이 확실한 유일한 신호다). 코드 수정 없이 config 로 가능한 것은 (a)뿐.

## R7. 결함은 아니지만 실카 1회차에서 반드시 볼 구조적 한계 (신규 관측)

**게이트 반경(`initialRadiusNorm` 0.10)은 고정인데, 클릭↔판 오프셋은 zoom 에 비례해 커진다.**
따라서 latch 가능 조건은 닫힌 형태로 `e1 ≤ 0.10 / k_검출` 이다(`e1` = 시작 화면에서 클릭점↔판 중심 정규화 거리).
`preLatchZoomStepRatio` 를 1.3 으로 낮춰도(가장 촘촘) 이 한계는 남는다 — 실측 격자:

| 검출 시작 zoom | e1=0.005 | 0.01 | 0.02 | 0.03 |
|---|---|---|---|---|
| 2.0 | OK | OK | OK | OK |
| 3.0 | OK | OK | OK | **FAIL** |
| 5.0 | OK | OK | **FAIL** | **FAIL** |
| 7.5 | OK | OK | **FAIL** | **FAIL** |

즉 **이번 작업의 표적인 먼 차량(검출까지 5~8배 줌이 필요)은 클릭이 판 중심에서 화면폭 1~2% 안에 들어야 한다.**
구현자 §3 의 반경 근거("차체↔판 오프셋 ≤0.08 을 흡수")는 **zoom 1 기준이라 사다리에서는 성립하지 않는다**.
실패는 정직하다(`no_plate_near_click`, 거짓 성공 아님) — 그래서 결함이 아니라 **설계 긴장**으로 보고한다.
라이브에서 이 항목이 원인이면 로그에 `phase:'ladder'` 의 `nearestDistFromPrior` 가 **rung 마다 커지는** 패턴으로 나타난다.
대응은 게이트 반경을 조준 시점 zoom 대비로 스케일하는 것(`radius × z/z_aim`, 상한 두고)이며 이터레이션 2 사안이다.

## R8. 여전히 검증하지 못한 것 (§7 그대로 · 변동 없음)

실카 라이브(휴컴스 `setcenter` 잔차 수렴 · `nativeAimSettleMs` 실측 · LPD 검출 시작 zoom 실측 · 체감 소요) **불가**.
시뮬 라이브 98% 재측정도 하지 못했다. 뷰어 UI 실측 미확인. 위 R6-②/R7 의 수치는 전부 **모델 기반 추정**이며
실제 `k_검출`·`e1` 분포는 라이브 로그로만 확정된다.

## R9. 한 줄 판정

**실카 검증 진행 가(可)** — 회귀 0(187/2192·tsc 클린), 1순위 목적(거짓 성공 제거) 유지, 수정 1~3 은 실효 확인.
남은 2건(R6-① 고배율 출발 줌아웃 예산 부족 / R6-② `preLatchZoomStepRatio` 2.0 의 latch 창 건너뜀)은 **거짓 성공이 아니라
정직한 실패**이며, R7 과 함께 **라이브 로그로만 실제 빈도를 확정할 수 있는 항목**이다.
다만 R6-② 는 config 한 줄(`calibrate.preLatchZoomStepRatio: 1.6`)로 위험을 줄일 수 있으므로,
**실카 1회차를 1.6 으로 시작하고 `phase:'ladder'` 의 latch 직전 rung `plates` 값을 채록할 것을 권고**한다.

---

# [추가] 이터레이션 2 검증 — 수정 7~13 + 리더 스키마 핫픽스

검증: 2026-07-21 · 검증자(qa-tester) · 대상: `02_developer_changes.md` 수정 7~13 + **파이프라인 밖 리더 수정**(`toolsConfig.ts` `ptz` 축별 optional)

## S0. 회귀 전건 (내가 직접 돌린 결과 그대로)

| 항목 | 명령 | 결과 |
|---|---|---|
| 타입 | `npx tsc -p tsconfig.json --noEmit` | **통과**(출력 없음, exit 0) |
| 기준선 | `npx vitest run` | **189 파일 / 2220 테스트 전건 통과, 실패 0** |
| 신규 테스트 추가 후 | `npx vitest run` | **190 파일 / 2231 테스트 전건 통과, 실패 0** |

구현자 보고(189/2220)와 **일치**. 소스는 한 줄도 고치지 않았다(`git status` 상 내 추가분은 테스트 1파일뿐).

신규 **영구** 테스트 1건: `test/toolsConfigPtzOptional.test.ts` (11케이스) — 리더 핫픽스 회귀 가드(S1).
반례 사냥은 임시 파일 `test/_qa2Adversarial.tmp.test.ts`(12케이스)로 수행하고 **보고 후 삭제**했다.
전부 실사용 config 값(`targetPlateWidth 0.215 · centerTol 0.03 · widthTol 0.015 · maxZoomStepRatio 1.3 · initialRadiusNorm 0.10`).

---

## S1. ★ 리더 핫픽스 검증 (`ptz` 축별 optional) — **정당하고, 회귀로 고정했다**

유닛테스트 없이 들어간 변경이라 최우선으로 검증했다. **결함 없음. 진단도 정확했다.**

| 확인 항목 | 결과 |
|---|---|
| 기존 config(3축 전부 지정) 여전히 유효 | **통과** — 값 그대로 보존 |
| `zoomRange` 만 지정(현재 실카 config) | **통과** — 마스터 크래시(`cameraSources[2].ptz.panRange Required`) 재현→해소 확인 |
| `ptz` 자체 미지정(시뮬 소스) | **통과** · 빈 객체 `{}` 도 유효 |
| 실제 `config/tools.config.json` 로드 | **throw 없음**. 실카 2대 모두 `zoomRange [0,16384]` · pan/tilt 키 없음 · 시뮬은 `ptz` 없음 |
| 축별 optional ↔ `RealPtzSource` 폴백 정합 | **통과** — `goptzfpos` raw 목표를 관측해 확인. `zoomRange` 만 주면 zoom 만 16384 로 바뀌고 pan/tilt raw 는 무지정 대조군과 **완전히 동일**. `panRange` 만 / `tiltRange` 만 주는 경우도 축 독립 확인 |
| 느슨해진 범위가 과한가 | **아니다** — 느슨해진 것은 "필수 여부"뿐. 3-튜플·1-튜플·문자열·숫자는 그대로 거부됨을 고정 |

**판단**: `RealPtzSource:155~157` 이 이미 축별 `?? HUCOMS_DEFAULT_*` 이므로 스키마만 코드보다 엄격했다는 리더 진단이 맞다.
축별 optional 은 오히려 "기본값을 config 에 복제하지 않는다"는 이점이 있다(기본값을 바꿔도 사본이 남지 않는다).
이 크래시는 **회귀 테스트로 봉인**했다 — 재발하면 `test/toolsConfigPtzOptional.test.ts` 가 먼저 죽는다.

---

## S2. ★ 수정 13 금지선 — 반례를 적극적으로 찾았고, **거짓 성공은 되살아나지 않았다**

이번 이터레이션 최대 위험이라 가장 엄격하게 봤다. 구현자 L6 이 덮은 3건 외에 **별도 반례 7건**을 설계해 돌렸다.

| 반례 | 시나리오 | 결과 |
|---|---|---|
| **마스터 원래 시나리오 (clampZoom 포화 경로)** | 좌측끝(0.05,0.5) 클릭 · 판은 원래 화면중앙에만 · 장비 상한 도달 | **`ok:false` · `plate === null` · `plateWidth === null`** — 차단 |
| **마스터 원래 시나리오 (zoomAct 정체 경로 — 신규 출구)** | 위와 동일 + 수정 11 조기종료로 끝남 | **`ok:false` · `plate === null`** — 신규 출구도 차단 |
| 신원 치환 공격 | latch 후 대상이 사라지고 **다른 판**이 중앙 0.06 지점에 등장 | **`ok:false`** — `matchRadius`(0.08) 안이어도 `centerTol`(0.03) 이 막는다 |
| 치환 경계 측정 | 이웃을 0.04 → 0.02 로 당김 | 0.04 **실패** / 0.02 성공. 즉 **치환이 성공하려면 이웃이 대상과 사실상 같은 자리(±0.03)여야 한다** — 어떤 위치 기준으로도 대상과 구별 불가능한 지점이므로 실질 공격면 아님 |
| `centerTol` 경계 | 이탈 0.02 / 0.045 | 0.02 성공 · 0.045 **실패** — 경계가 실제 판정에 쓰인다 |
| 미측정 재중심 | 미정렬(0.06) 상태에서 포화 — 재중심 명령은 나갔으나 결과를 측정한 rung 없음 | **`ok:false`** + `widthShortfall` 보존. "검증 안 된 것을 성공이라 하지 않는다" 실효 |
| 데이터 오염 | `ok:true` + `widthShortfall` 이 DB/JSON 에 converged 로 새는가 | **새지 않는다** — `calPointCenter`(app.js:2399~)는 UI 메시지·PTZ 동기화만 하고 영속화하지 않는다. `converged: z.ok`(PtzCalibrator:421)는 **배치 경로**(`zoomToPlateWidth`)이고 사다리는 클릭 전용이라 접촉 0 |

**결론: 수정 13 은 성공 경계를 옮겼지만 거짓 성공을 되살리지 않았다.** `saturatedOutcome` 의 두 게이트(latch + 이번 rung 실측 `centerTol`)가
실제로 방어선으로 동작하고, 두 호출 지점 모두 "상한 도달을 사실 확인한 자리"다(추정 판정 없음).

### S2-①  [낮음·관측] 폭 미달 **정도에 하한이 없다** — 목표의 9%여도 `ok:true`
- 재현: 장비 최대 zoom 에서도 판 폭 **0.02**(목표 0.215 의 9%) → `ok:true` · `widthShortfall:true`.
- 논리적으로는 옳다(장비가 할 수 있는 일을 전부 했다). 다만 마스터 화면에는 **판이 여전히 점으로 보이는데 "완료"** 가 뜬다.
  UI 가 `장비 최대 배율(zoom_saturated)` 을 병기하므로 정보 은닉은 아니다 → **결함이 아니라 UX 경계**로 보고한다.
- 권고(선택): `widthShortfall` 이 심할 때(예 `plateWidth < target/3`) UI 문구를 `완료(최대 배율 — 대상이 너무 멀다)` 로 갈라 주면
  마스터가 "장비 한계"와 "클릭을 다시 해야 하는 상황"을 구분할 수 있다. 코드 판정은 그대로 두어도 된다.

---

## S3. 수정 11 오탐 — **오판하지 않는다**(임계를 수치로 측정)

| 케이스 | 결과 |
|---|---|
| 로그 실측 기반 저속 모터(rung 당 명령차의 40%만 추종, 목표 미도달) | **`ok:true` · reason 없음** — 조기 종료하지 않고 정상 수렴. **오탐 없음** |
| 오판 임계 측정 | rung 당 실측 이동 **0.04 뷰어(≈raw 23)** → 정체로 판정 / **0.5** → 정상. 즉 EPS 0.05 가 경계 |
| `actLive` 가드 (echo 고정 시뮬 0/0/1) | **판정 미발동 · `ok:true`** — 시뮬 전멸 위험 없음. 가드가 실제로 동작한다 |
| 정체 확정 시 종료 속도 | 캡처 ≤12 로 종료(자동 예산 19칸을 태우지 않음) |

**임계 타당성 검산**: `zoomRange [0,16384]`·뷰어 `[1,36]` 에서 EPS 0.05 뷰어 ≈ **raw 23**.
로그 실측 줌 속도 ≈ **1250 raw/s** 이므로 정상 모터는 **18ms** 면 EPS 를 넘는다. rung 당 대기가 15초인 것을 감안하면
"움직이는데 정체로 오판"하려면 실제 속도가 **정상의 1/800** 이어야 한다 → 물리적으로 도달 불가. **EPS 0.05 는 넉넉히 안전한 쪽**이다.

**경계면 교차 확인(실카 경로)**: `got.act.zoom` 의 출처를 끝까지 따라갔다 —
`platePtz.captureDetectPick` → `CameraSourceClient.requestImage:51-59`(`captured.ptz` 를 그대로 실음) → `RealPtzSource.snapshot:205`
→ `currentPtz()` → `getptzfpos` **장비 실측** → `fromNativePtz`(뷰어 좌표계). **실카에서 `zoomAct` 는 진짜 실측이 맞다.**
장비가 조회를 지원하지 않으면 `currentPtz` 가 마지막 **명령값**으로 강등되는데, 그 경우 `act == cmd` 라 정체가 잡히지 않는다 →
**안전한 방향의 강등**(오탐이 아니라 미발동)이다.

### S3-① [낮음] 정체 출구가 `rejectedEver` 를 사유에 반영하지 않는다 — 수정 3 의 정직성이 신규 출구에서 끊긴다
- 재현: 저배율부터 계속 반경 밖 판만 기각되다가 장비 상한 정체로 종료 → 반환 사유 **`zoom_saturated`**.
  같은 프레임이 `clampZoom` 포화로 끝나면 `no_plate_near_click` 이 나온다(수정 3 이 만든 구분).
- 영향: 마스터의 다음 행동이 정반대다("클릭을 다시" vs "장비 배율 한계 수용"). 정체 출구에서 그 구분이 사라진다.
  `ok:false` 는 유지되므로 **거짓 성공은 아니고 사유 오보**다. rung 별 기각 로그가 남아 진단 불능은 아니다.
- 권고: 정체 분기(`platePtz.ts:631-634`)의 사유를 `latched ? 'zoom_saturated' : rejectedEver ? 'no_plate_near_click' : 'zoom_saturated'` 로 맞출 것(1줄).

### S3-② [정보] 수정 10 이후 수정 11 의 실제 발동면은 매우 좁다
`zoomRange` 가 정정되어 뷰어 36 = raw 16384 = 장비 최대가 **정확히 일치**하므로, `real-camera-1` 에서는 `clampZoom` 포화가 먼저 걸리고
정체 판정까지 갈 일이 거의 없다. **수정 11 의 실질 가치는 "zoomRange 가 또 틀렸을 때의 안전망"** 이고,
그 대상이 바로 구현자가 §7-2 에 남긴 **미실측 장비 `real-camera-2`(192.168.0.154)** 다. 그 장비를 쓸 때 가치가 드러난다.

---

## S4. 수정 12 트레이드오프 — **수정 11 과 짝으로 낭비를 끊지만, 상쇄에 가깝다**

| 시나리오 | 이전(5초) | 현재(15초 + 수정 11) |
|---|---|---|
| 마스터가 겪은 실패(도달 불가 zoom 반복) | 5 rung × 6.2초 ≈ **31초** | 정체 2 rung × ~15초 ≈ **30초** |
| 정상 줌아웃 전 구간 이동(raw 16384→0) | **5초 타임아웃 후 미정착 반환**(오조준) | 약 13초에 정착 → **정상 완료**(수정 12 의 본래 목적) |
| `mode:'point'` 1회 클릭 | 최대 5초 | **최대 15초 UI 대기** |

- **수정 12 의 이득은 "낭비 감소"가 아니라 "미정착 오조준 제거"** 다. 낭비 시간은 위 표대로 거의 상쇄된다 —
  구현자 §4 의 "둘은 짝으로 설계됐다"는 맞지만, **체감 시간이 개선되지는 않는다**는 점은 마스터에게 정직히 전달돼야 한다.
- **[중간] 새 최악 케이스**: "느리지만 계속 움직이는" 장비은 수정 11 이 (정당하게) 발동하지 않으므로
  **모든 rung 이 15초를 태울 수 있다**. 자동 예산 19칸이면 이론상 **약 5분**(이전 95초). 실카에서 이 패턴이 나오면
  체감이 크게 나빠진다 → 라이브 1회차에서 **클릭→완료 체감 시간을 반드시 채록**할 것(현재 유일한 방어는 마스터의 인내).

---

## S5. 수정 8 — 슬루 중 값을 반환하지 않는다 · `mode:'point'` 퇴행 없음

- 코드 확인: `centerOnPoint`(RealPtzSource:318~327)이 `waitUntilStopped()` **뒤에** `currentPtz()` 를 읽는다 → 슬루 중 값이 나갈 경로가 없다.
  `waitUntilStopped` 는 "움직임을 한 번 본 뒤의 정지"만 정착으로 인정하므로 명령 직후 미출발 구간을 정지로 오판하지 않는다.
  구현자 신규 테스트(`realPtzSourceCenterSettle.test.ts` 5케이스)가 이 회귀 가드를 이미 고정하고 있고, 전건 통과를 확인했다.
- `mode:'point'` **로직 퇴행 없음**: `aimPointToCenter` 는 무변경이고, 응답 PTZ 가 슬루 중 값 → 정지 위치로 **정확해졌다**.
  유일한 변화는 **응답 지연**(즉시 → 정지까지, 최대 `settleTimeoutMs` 15초)이다. 마스터가 "잘 되던 기능이 느려졌다"고 느낄 수 있으나
  그 대기는 원래 카메라가 움직이던 시간이며 기존에는 숨기고 있었을 뿐이다 → **기능 퇴행 아님, 체감 변화**로 보고한다.
- **[낮음] 남은 구멍**: `setcenter` 명령이 장비에 **무시된 경우**와 진짜 no-op(이미 그 지점이 중앙)이 구별되지 않는다 —
  둘 다 7폴 유예 후 `settled:true` 다. `setcenter` 에 echo 가 없어 구조적으로 구별 불가하므로 개선 대상은 아니나, 라이브에서
  "조준이 전혀 안 되는데 성공으로 보고"가 보이면 이 지점이다.

---

## S6. ★ 수정 7 — **4곳이 전부가 아니다. 이동 유발 경로 2곳이 누락됐다**

`web/app.js` 의 모든 fetch 를 라우트 소스까지 따라가 이동 여부를 판정했다(실카는 `snapshot(mode:'manual')` 일 때만 `move()`).
배선된 4곳(`calPointCenter`·`calPoll`·`discPoll`·`capPoll`)은 **실패/취소 전이까지 포함해 전부 정상**이다. 그러나 —

### S6-① [중간] `/capture/detect` VPD 테스트 경로 — 실제로 카메라를 움직이는데 동기화가 없다
- 위치: `web/app.js:1012-1044`(`runLiveDetect`), 발화 `:2615`(**[VPD 검출(테스트)] 버튼**)
- 서버가 움직이는 근거: `src/capture/detectPipeline.ts:329-332` — 번호판 미귀속 차량마다 `vehicleCenterZoomPtz` 로 계산한 PTZ 를
  `requestImage(cam, preset, {pan,tilt,zoom})` 로 명령 → `CameraSourceClient:46-50` 이 `mode:'manual'` → `RealPtzSource.snapshot:204` → **`move()`**.
  루프 종료 후 **원위치 복귀 코드 없음**(`:357-378`).
- 시나리오: 프리셋 프레이밍(pan 12/tilt −8/zoom 4)에서 VPD 테스트 → 미귀속 차량 쪽으로 pan/tilt + zoom ×2~3 이동한 채 정지.
  `state.ptz` 는 여전히 12/−8/4 → 마스터가 ▲를 누르면 **줌인된 위치에서 원래 프레이밍으로 통째로 되돌아간 뒤 2°만 이동**한다.
  **마스터가 겪었다고 보고한 증상과 형태가 동일**하다.

### S6-② [중간] 원버튼 자동체인의 `discovering` 단계 — 전이 감시 누락으로 동기화가 발화하지 않는다
- 위치: `web/app.js:2142-2182`(`pollPipeline`). 체인 전이에서 **`calibrating` 진입 때만 `calPoll()` 을 재기동**(`:2163`)하고
  `discovering` 에 대응하는 `discPoll()` 재기동이 없다 → `prevDiscState` 가 `'idle'` 로 남아 `discPoll` 의 `running→done` 전이(`:2553`)가 **성립하지 않는다**.
- 그 단계는 실제로 카메라를 돌린다(`src/pipeline/SetupPipeline.ts:179-185` 전 프리셋 앵커 loop LPD).
- 미동기화가 확정되는 두 종결: ① discovery 실패(`SetupPipeline.ts:112-115`) ② discovery 성공이나 LPD 타깃 0 → 센터라이징 스킵 후 `done`(`:121-126`).
  둘 다 `calibrating` 을 거치지 않으므로 마지막 sync 는 **수집 종료 시점**(`capPoll:2120`)이고, 그 뒤 discovery 이동이 전부 반영되지 않는다.

### S6-③ [낮음] 배치 잡은 `source` 를 동봉하지 않는데 동기화는 `state.source` 를 읽는다
`/calibrate/ptz`·`/discover/ptz`·`/capture/start` 는 `source` 미동봉이라 서버 기동 시 고정된 파이프라인 카메라를 명령하는 반면,
`syncPtzAfterJob` → `refreshCurrentPtz`(`app.js:303`)는 `state.source` 를 조회한다. **둘이 다르면 엉뚱한 장비의 PTZ 를 읽어 온다.**
`source` 를 넘기는 건 `/calibrate/point` 뿐(`:2392`). 현재 마스터 운용(단일 소스 선택)에서는 드러나지 않지만 구조적 불일치다.

### 실카/시뮬 분기 — **정합함(결함 없음)**
`selectedSourceIsReal()`(`:268`)이 소스 id 문자열이 아니라 **`kind` 필드**(`'hucoms'`)로 판별하고, `kind` 는 서버가 실객체에서 내려준다(`viewer/routes.ts:410`).
실물 장비는 `RealPtzSource`(hucoms) 하나뿐이라 실카가 시뮬 분기를 타거나 그 반대인 경우는 없다.
실카는 `getPtz`→`currentPtz(true)` 로 **장비 실측을 강제**(실패를 명령값으로 위장하지 않음), 시뮬은 응답 3필드가 모두 유한할 때만 채택하고
아니면 서버 조회 폴백 — 폴백 대상 4종 소스가 전부 `getPtz` 를 구현하므로 501 사각지대도 없다. **지시받은 분기 요구와 일치한다.**

(부수 관측) 시뮬에서도 잡 종료 후 `state.ptz` 가 잡의 마지막 위치로 바뀌므로 라이브 뷰(=state.ptz override 렌더)가 그 위치로 이동해 보인다.
정직한 표시이지만 기존 시뮬 거동 대비 **변화**이므로 마스터가 낯설게 느낄 수 있다.

---

## S7. 수정 10 파장 — 기존 zoom 로직에 **코드 회귀는 없다**. 단 **영속 데이터의 의미가 바뀌었다**

- **코드 회귀 0**: `zoomRange` 는 `RealPtzSource` 의 raw 매핑(`toNativePtz:341-343`/`fromNativePtz:350-352`)에서만 쓰인다(전 소스 grep 확인).
  `zoomToPlateWidth`·배치 `calibrateSlot`·acquire 사다리는 전부 **뷰어 좌표계 `clampZoom`(1~36)** 위에서 동작하므로 수식이 바뀌지 않았다.
  기존 zoom 관련 테스트 전건 무수정 통과.
- **[중간] 영속 zoom 값의 의미 변화 (구현자 미보고 항목)**: `data/slot_ptz.json` 과 DB `slot_setup` 에 **17건**의 뷰어 zoom 이 저장돼 있고
  범위는 **5.81 ~ 19.73, 그중 14건이 9.75 초과**다. 이 값들은 **구 매핑(`[0,65535]`)에서 기록**됐다.
  같은 숫자가 지금은 **다른 물리 배율**을 뜻한다(예 뷰어 19.73 → 구: raw 35,059 = 범위 밖 → 장비가 튐 / 신: raw 8,763 = 정상 도달).
  → 수정 10 은 **앞으로의 재현성을 고치는 대신 과거 기록의 해석을 바꾼다**. ActionAgent 등이 이 값을 재생하면 이전과 다른 화각이 나온다.
  - **단, 이 17건의 출처(실카/시뮬)를 확정하지 못했다** — 레코드에 소스 필드가 없다. 시뮬 기록이면 무해하다(시뮬은 `zoomRange` 미사용).
    구 매핑 실카에서는 zoom 9.75 초과가 전부 같은 물리 위치였을 텐데 이 17건은 zoom 5.8~19.7 전 구간에서 `plateWidth ≈ 0.20` 으로
    매끄럽게 수렴해 있다 → **시뮬 기록일 가능성이 높다**. 그래도 마스터가 **실카로 채운 셋업이 있는지 확인**해야 한다.
- **구현자의 "배치 폭 수렴률 재측정 권고"는 타당**하다. 다만 유닛으로는 확인할 수 없다(천장이 넓어진 효과는 실장비에서만 관측된다).

---

## S8. 검증하지 못한 것 (은닉 금지)

1. **실카 라이브 전면 미검증** — 휴컴스 장비 접속 불가. 아래는 전부 가정 그대로다:
   `setcenter` 잔차 수렴 · `waitUntilStopped` 의 실제 정착 판정 정확도 · `SETTLE_START_GRACE_POLLS=7` 의 적정성 ·
   15초 타임아웃의 실제 체감 · `zoomAct` 가 라이브에서 정말 장비 실측인지(코드 경로는 확인했으나 실물 응답 미확인).
2. **`real-camera-2`(192.168.0.154) 의 `zoomRange 16384` 는 실측되지 않았다** — 구현자 §7-2 그대로. 다른 값이면 같은 유형의 실패가 재발한다.
3. **S6-①/②(수정 7 누락 2건)는 코드 정독으로 판정**했고 브라우저 실행으로 재현하지는 못했다.
4. **뷰어 UI 실측 미확인** — `ok:true` + `장비 최대 배율(zoom_saturated)` 문구가 마스터 화면에 어떻게 보이는지 눈으로 못 봤다.
5. 시뮬 라이브 성공률 재측정 미수행.

---

## S9. 새 결함 요약 (이번 이터레이션)

| # | 심각도 | 내용 | 거짓 성공? |
|---|---|---|---|
| S6-① | **중간** | `/capture/detect` VPD 테스트가 카메라를 움직이는데 `state.ptz` 미동기화 — 마스터 원증상 재발 경로 | 아니오 |
| S6-② | **중간** | 자동체인 `discovering` 전이 감시 누락으로 동기화 미발화 | 아니오 |
| S4 | **중간** | "느리지만 움직이는" 장비에서 rung 마다 15초 → 최악 약 5분 | 아니오 |
| S7 | **중간** | 영속 zoom 값의 물리적 의미 변화(출처 확정 필요) | 아니오 |
| S3-① | 낮음 | 정체 출구가 `rejectedEver` 를 사유에 반영하지 않음(사유 오보) | 아니오 |
| S6-③ | 낮음 | 배치 잡 `source` 미동봉 ↔ 동기화는 `state.source` 조회 | 아니오 |
| S2-① | 낮음 | 폭 미달 하한 없음(목표의 9%여도 `ok:true`) — UX 경계 | 아니오 |
| S5 | 낮음 | `setcenter` 무시와 진짜 no-op 이 구별 불가 | 아니오 |

**리더 핫픽스(S1) 및 수정 8·11·12·13 의 핵심 로직에서는 새 결함이 없다.**
특히 **수정 13 의 금지선은 반례 7건을 견뎌 냈고, 마스터가 목격한 원래 시나리오는 신규 출구(정체 조기종료)에서도 차단된다.**

---

## S10. 한 줄 판정

**마스터 실카 재검증 진행 가(可)** — 회귀 0(190파일/2231테스트·tsc 클린), 리더 스키마 핫픽스는 정당하며 회귀 테스트로 봉인했고,
1순위 목적(거짓 성공 제거)은 수정 13 이후에도 유지된다. 발견한 8건은 **전부 거짓 성공이 아니며** 실카 재검증을 막는 것은 없다.
다만 **S6-①(VPD 테스트 버튼)** 은 마스터가 그 버튼을 쓰면 원래 증상을 그대로 다시 겪으므로
**재검증 중에는 [VPD 검출(테스트)]를 누르지 말 것**을 권고하고(또는 배선을 먼저 넣고), 라이브에서는
`zoomCmd`/`zoomAct`/`sha` 와 **클릭→완료 체감 시간**을 반드시 채록할 것.
