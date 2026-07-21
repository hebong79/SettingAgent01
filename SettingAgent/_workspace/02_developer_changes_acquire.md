# 02 DEVELOPER — 센터라이징 방안2(줌인 acquire) + 방안3(줌아웃 사다리) 구현 변경노트

> 입력: `_workspace/01_architect_plan_acquire.md`(설계) + 리더 확정(D-1 acquirePlateWidth 0.12·PlatePtz 코어 무변경·peerOffsets 사전스케일).
> 산출: 소스 5파일 + 이 문서. 검증: `npx tsc --noEmit` exit 0, `npx vitest run --no-file-parallelism` = **178 파일 / 2065 테스트 전부 green**.
> 라이브 실행 없음(리더가 goal/loop 으로 /calibrate/ptz 직접 검증). 순수 로직·빌드·유닛만.

---

## 1. 변경 파일 요약

| 파일 | 변경 | 성격 |
|---|---|---|
| `src/calibrate/controlMath.ts` | 신규 pure `zoomForWidth` 1개 가산(기존 함수 무변경) | 순수 수학 |
| `src/calibrate/PtzCalibrator.ts` | 상수 4개 + private 3개(`computeAcquirePlan`·`scalePeerOffsets`·`acquireAndCenter`) 가산 + `calibrateSlot` 재조립 + import 1개 | 오케스트레이션 재배선 |
| `src/config/toolsConfig.ts` | `CalibrateSchema` 에 optional 노브 3개 가산(DEFAULT 객체·기존 config 무파괴) | 스키마 가산 |
| `src/calibrate/platePtz.ts` | **무변경**(코어 무접촉 — 리더 원칙) | — |
| `test/controlMath.test.ts` | `zoomForWidth` 단위 테스트 3블록 가산 | 신규 검증 |
| `test/ptzCalibrator.test.ts` | "순서(중심→줌)" 테스트를 신 계약(줌인 acquire 우선)으로 **개정**(설계 명시 1건) | 계약변경 |
| `test/centeringSlot.test.ts` | T3·T4·T5·T6 개정(줌인 zoom·사다리) | 계약변경(설계 미열거) |
| `test/centeringPreAim.test.ts` | B-1.1(2블록)·B-1.2 개정(줌인 zoom) | 계약변경(설계 미열거) |
| `test/centeringOwnership.test.ts` | T3 개정(clampZoom 주입·사전스케일·[]→undefined) | 계약변경(설계 미열거) |

---

## 2. 소스 구현 노트 (파일:라인·이유)

### 2-1. `controlMath.ts` — `zoomForWidth`(신규, `zoomCorrection` 바로 뒤)
- `zoomForWidth(curZoom, curWidth, targetWidth, clampZoom)` = `curWidth<=GAIN_EPS(1e-4) ? clampZoom(curZoom) : clampZoom(curZoom*(targetWidth/curWidth))`.
- 게인무관 **직접 목표**(폭∝zoom 선형). `zoomCorrection` 의 sqrt(반복 감쇠 스텝)과 별개 — 감쇠 없는 1발 목표산출. 시그니처에 gain 부재 = 게인 무의존을 구조적 보장.
- 기존 함수·시그니처·동작 전부 무변경(가산만).

### 2-2. `PtzCalibrator.ts`
- import: `zoomForWidth` 추가(`./controlMath.js`).
- 신규 module-private 상수: `ACQUIRE_PLATE_WIDTH_DEFAULT=0.12`, `ACQUIRE_LADDER_STEP_DEFAULT=1.5`, `ACQUIRE_LADDER_MAX_STEPS_DEFAULT=5`, `LPD_WIDTH_EPS=1e-4`. cfg 미설정 폴백(기존 config 무파괴, `?? 기본` 패턴 — centerZoom/maxZoomStepRatio 선례 준수).
- **`computeAcquirePlan(t, presetZoom)`**(신규 private, 순수·카메라 호출 0): `lpdWidth=t.plateRoi.w`. 퇴화(≤1e-4)면 `{targetZoom:presetZoom, acquireZoom:presetZoom}`(acquire 스킵=프리셋시야, 정직). `targetZoom=zoomForWidth(presetZoom,lpdWidth,cfg.targetPlateWidth,clamp)`, `acquireZoom=min(targetZoom, zoomForWidth(presetZoom,lpdWidth,acquirePlateWidth,clamp))`(Za≤Zt).
- **`scalePeerOffsets(offsets, zoom, presetZoom)`**(신규 private, 순수): `k=zoom/presetZoom`, 각 오프셋 ×k. 원본 프레임 오프셋 → 현재 zoom 화면 오프셋(방사∝zoom). centerOnPlate 는 zoom 고정이라 정적 스케일이 호출 내내 정확. presetZoom≥1(clampZoom·프리셋 zoom≥1) 보장 → 0나눗셈 없음.
- **`acquireAndCenter(t, aim, plan, presetZoom, peerOffsets, base)`**(신규 private, 오케스트레이션): `for i=0..maxSteps` — `rungZoom=max(zoom,presetZoom)`(floor 클램프) → 그 zoom 으로 peerOffsets 사전스케일(빈배열이면 opts 에서 조건부 생략) → `centerOnPlate(cam,preset,{aim.pan,aim.tilt,zoom:rungZoom})`. 성공 rung 즉시 반환. 실패면 `cat:centering·phase:'acquire'` 로그(rung·rungZoom·reason) 후 floor 도달이면 break, 아니면 `zoom=rungZoom/step`. 전 rung 실패 시 마지막 결과 반환(skipItem 재료). 실패 종류(no_plate/plate_lost/max_iterations) 무관 사다리 하강(설계 B-2.72).
- **`calibrateSlot` 재조립**(설계 §A-2 그대로): `baseStart=startPtzFor(t)` → `presetZoom=baseStart.zoom` → `plan=computeAcquirePlan` → `aim=preAimPtz(t,baseStart)`(pre-aim 을 **프리셋 zoom 기준**으로 — 구 `wideBase`(centerZoom override) 제거) → `base=baseOpts()` → `c=acquireAndCenter(...)` → 실패면 skipItem → 성공이면 width 단계: `plateRoi=quadBoundingRect(c.plate.quad)`, `gain=c.gain`, peerOffsets 를 **c.ptz.zoom 으로 사전스케일**(빈배열 조건부 생략) 하여 `zoomToPlateWidth(cam,preset,c.ptz)`. item 매핑(centered/converged/reason) 무변경.
- **무변경**: `preAimPtz`·`startPtzFor`·`peerOffsetsFor`·`baseOpts`·`saveCenteringSlots`·`saveSetupSnapshot`·`run`(byPreset 그룹핑·peerOffsetsFor 주입)·`notifyFinished`·`skipItem`·저장3중 경로.
- 클래스 상단 doc 의 "순서 엄수: centerOnPlate 수렴→zoomToPlateWidth" 한 줄만 신 흐름(acquire→width)으로 정정 — 내 변경이 직접 falsify 한 주석이라 외과적 정정(그 외 인접 주석 무개선).

### 2-3. `toolsConfig.ts` — `CalibrateSchema` optional 노브 3개
- `acquirePlateWidth: z.number().min(0).max(1).optional()` — acquire 시작줌 목표폭(코드 기본 0.12, 0.2면 full-jump).
- `acquireLadderStep: z.number().min(1).max(3).optional()` — 줌아웃 1스텝 배율(코드 기본 1.5).
- `acquireLadderMaxSteps: z.number().int().nonnegative().optional()` — 사다리 최대 rung(코드 기본 5, 0이면 사다리 없음).
- `DEFAULT_TOOLS_CONFIG.calibrate` 무변경(코드 폴백이 담당). loadToolsConfig 섹션 병합은 optional 미존재를 그대로 통과 → 기존 config 파싱 회귀 0.

---

## 3. 개정한 테스트 (이유·신 계약)

**설계가 명시한 "의도된 계약변경 1건"은 `ptzCalibrator.test.ts` 순서 테스트뿐**이었으나, 실측 결과 **동일 계약(줌인 acquire 우선 + peerOffsets 사전스케일)을 pin 하던 테스트가 3개 파일에 더 존재**했다(§4 설계 어긋남 참조). 전부 같은 클래스의 계약변경이라 **신 계약을 정확히 인코딩**(느슨화 아님)했다.

### 3-1. `ptzCalibrator.test.ts` — "순서(중심→줌)" → "방안2: 줌인 acquire→센터→폭"(설계 명시 1건)
- 구: 첫 zoom≠1 명령이 마지막 pan/tilt 변화 **이후**여야 함(센터→줌).
- 신: 첫 명령 `moves[0].zoom==acquireZoom(=1×0.12/0.05=2.4)>presetZoom(1)`(줌인 우선) → width 진입 전 모든 명령 zoom 이 acquireZoom 고정(centerOnPlate zoom 불변)이고 그 사이 pan/tilt 센터링 발생 → 최종 zoom 이 acquireZoom 초과로 상승(Zt=4.0 방향).

### 3-2. `controlMath.test.ts` — `zoomForWidth` 3블록 가산
- 폭∝zoom 직접목표(1.69341/0.0274/0.2→12.36, 1/0.05/0.12→2.4, 1/0.05/0.2→4.0), curWidth≈0 가드, clamp 상한(1/0.005/0.2→36).

### 3-3. `centeringSlot.test.ts`
- **T3**(프리셋 정본): 첫 캡처 pan/tilt=preAim(프리셋 base 22/6.8 유래), **zoom=acquireZoom(1.69341×0.12/0.05=4.064)** — 구 `zoom==1.69341` 반전. pan>22 유지.
- **T4**(폴백): 첫 캡처 pan/tilt=preAim(0/0/1 유래), **zoom=acquireZoom(2.4)** — 구 `zoom==1` 반전.
- **T5 plate_lost**: 모킹이 최초 1회만 검출 → 사다리 ON 이면 하위 rung 이 no_plate 로 소진돼 plate_lost 가 no_plate 로 묻힌다. plate_lost 전파 자체(단일 rung 초기검출 후 소실) 검증 위해 `acquireLadderMaxSteps:0`(사다리 off)로 격리. no_plate/zoom_saturated/max_iterations 3종은 무개정 통과.
- **T6**(center 실패→zoom 미시도): 사다리 ON 이면 실패 rung 마다 makePlatePtz 재생성이라 `opts.length` 이 rung 수가 됨. center→zoom 게이트만 격리하려 `acquireLadderMaxSteps:0` → `opts.length==1`·`zoomCalls==0` 원 계약 유지. it.ptz/plateWidth/reason 무변경.

### 3-4. `centeringPreAim.test.ts`
- **B-1.1 #1**(startPtz==preAim): pan/tilt=preAim 근사비교, **zoom=acquireZoom(2×0.12/0.05=4.8)**, plateRoi undefined 유지. (구 `startPtz.toEqual(preAim)` 는 zoom 까지 포함이라 실패.)
- **B-1.1 #2**(구 "zoom==base.zoom 불변") → "zoom==acquireZoom(줌인, base.zoom 아님)": 4.8·>base.zoom. 반전.
- **B-1.2**(anti-duplication): startPtz.pan/tilt==preAim(box8/box9) 근사비교로 변경(zoom 은 acquireZoom 이라 toEqual 불가). item.ptz 상이·plateRoi undefined 유지. anti-duplication 축(pan/tilt) 무손상.
- B-1.1 부호(우/좌 박스)·"서로 다른 박스중심"·B-1.3~1.5 는 pan/tilt·정렬·게이트·스냅샷만 봐 무개정 통과.

### 3-5. `centeringOwnership.test.ts` — T3(peerOffsetsFor 산출)
- 구 `camera:{}` 는 이제 `computeAcquirePlan` 이 `camera.clampZoom` 을 쓰므로 실제 clamp 주입.
- acquire 가 peerOffsets 를 rungZoom/presetZoom 배 사전스케일하므로, 이 테스트(오프셋 산출만 검증)의 교란 제거 위해 `acquirePlateWidth:0.05(=lpd폭)`→acquireZoom≈presetZoom→스케일≈1, `acquireLadderMaxSteps:0`→슬롯당 centerOnPlate 정확히 1회(captured 1:1). 오프셋 값 assertion(자기제외·프리셋격리) 전부 무변경 유지.
- 단일슬롯(slot4) peerOffsets `[]` → 스케일 결과 빈배열 → opts 조건부 생략(설계 §A-2) → `opts.peerOffsets===undefined`. 구 `toEqual([])` → `toBeUndefined()` 로 정정(기능 동일 — PlatePtz 최근접 경로). T1/T2 는 PlatePtz 직접 구동이라 무영향·무개정.

### 3-6. `platePtz.test.ts` — **무개정 green**(코어 무변경, 바이트 동치).

---

## 4. 설계와 어긋난 판단 (리더/설계자 보고 필요)

**설계 어긋남 1건 — 회귀 범위 과소평가**: 설계서 B-4 는 "개정 1건(`ptzCalibrator.test.ts` order)뿐, 나머지 이터1~3 스위트 무수정 green" 이라 단언했으나, **줌인 acquire 우선 + peerOffsets 사전스케일**이라는 리더 확정 크럭스는 다음도 필연적으로 바꾼다:
1. 첫 `centerOnPlate` 명령의 zoom(구 base.zoom → 신 acquireZoom) — `centeringSlot` T3/T4, `centeringPreAim` B-1.1(×2)/B-1.2 가 이를 pin.
2. `centerOnPlate`/`zoomToPlateWidth` 에 넘기는 peerOffsets(구 원본값 → 신 사전스케일값·빈배열 조건부 생략) — `centeringOwnership` T3 가 이를 pin.
3. 실패 시 사다리가 `centerOnPlate` 를 다회 호출(구 1회) — `centeringSlot` T5(plate_lost→no_plate 소진)·T6(opts 길이).

→ 설계가 이터1(pre-aim: `centeringPreAim`)·이터2(소유권: `centeringOwnership`)·통합(`centeringSlot`) 테스트 파일을 열거하지 않아 "개정 1건" 으로 판단했다. 실제로는 **동일 계약의 반영이라 총 4파일 8케이스가 신 계약으로 개정 필요**했다. 전부 리더 확정 동작을 정확히 인코딩(느슨화 아님)했으며, 각 개정은 §3에 파일·이유 명시.

**독립 판단 2건(설계 A-2 코드 그대로 따르되 결과 명시)**:
- 빈 peerOffsets 는 opts 에서 조건부 생략(설계 A-2 `...(scaled.length ? ...)`) → 단일슬롯에서 `opts.peerOffsets===undefined`. 구 `calibrateSlot` 은 무조건 `[]` 전달이었으나 기능 동일(PlatePtz 에서 `[]`·undefined 모두 최근접 경로). `centeringOwnership` T3 assertion 을 undefined 로 정정.
- `centerZoom`(cfg 필드) 는 재설계 acquire 흐름에서 미사용(pre-aim 은 presetZoom 기준). 설계 D-4 대로 **필드 유지·소스 참조 제거**(orphan 없음 — 스키마·DEFAULT 에만 잔존, back-compat). 테스트·config 어디도 centerZoom 사용 없음 확인.

**미변경 확인(회귀 0)**: PlatePtz 코어·controlMath 기존 함수·slotPtzWriter·plateDiscovery·저장3중(save/Setup·DB slot_setup·slot_ptz.json)·소유권 게이트·타깃정렬·부분UPDATE·stringify5·좌표계·결정론. ESM(.js import)·ParkSimMgr 컨벤션 준수. 범위 밖 리팩토링 없음.

---

## 5. 검증 결과 (self-check)
- `npx tsc --noEmit` → **exit 0**.
- `npx vitest run --no-file-parallelism` → **178 파일 / 2065 테스트 전부 green**(개정 후).
- 라이브(/calibrate/ptz)는 리더 goal/loop 실측(설계 B-5·D-6 이월): converged↑·최종폭0.2·acquire 경로 로그(`phase:'acquire'` rung/rungZoom/reason)·게인 오귀속 상한 확증.
