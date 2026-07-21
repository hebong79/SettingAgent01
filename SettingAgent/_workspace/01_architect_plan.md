# 01 설계 — 개별 center+zoom 실카 성공률 개선 (반경 게이트 + 줌 사다리)

대상 계약: `_workspace/00_goal.md` (B 모드 이터레이션 1)
작성: 2026-07-21 · 설계자
범위: Requirements 1(반경 게이트) · 2(줌 사다리) 구현 설계. **코드 미수정.**

---

## 0. 결론 요약 (구현자가 이것만 읽어도 되는 요약)

| 결정 | 내용 |
|---|---|
| 반경 게이트 | `PlatePtzOpts.initialRadiusNorm?` **신규 파라미터**(기존 `matchRadiusNorm` 재사용 안 함). **기본 undefined = 게이트 없음 = 기존 동작**. 클릭 경로만 주입, 기본값 **0.10** |
| 줌 사다리 배치 | **`PlatePtz` 의 신규 3번째 메서드** `centerAndZoomByLadder()`. 기존 `centerOnPlate`/`zoomToPlateWidth` 무변경 |
| 진입 분기 | `PtzCalibrator.centerOnPoint` 안에서 **`camera.centerOnPoint` 유무 + cfg 스위치**로 신규/기존 경로 택1. 라우트(`calibrateRoutes.ts`) **무변경** |
| 시뮬 회귀 | 기본 `pointZoomLadder='auto'` → 네이티브 없는 시뮬은 **기존 경로 그대로**. 사다리는 유닛테스트(가짜 네이티브 카메라)로 검증 |
| 카메라 명령 | 사다리는 `move()` 를 **직접 호출하지 않는다**. 이동+캡처는 `requestImage(ptz override)` 원자 호출(기존 PlatePtz 불변식), 유일한 직접 호출은 `camera.centerOnPoint` |
| 신규 실패 사유 | `no_plate_near_click` · `plate_not_found_at_max_zoom` · `aim_failed` (3건 추가) |

---

## 1. Requirement 1 — 최초 대상 선정 반경 게이트

### 1.1 왜 `matchRadiusNorm` 을 그대로 쓰면 안 되는가

`matchRadiusNorm=0.08` 은 **추적(tracking) 반경**이다. 기준점이 `predictPlateCenter`/`predictCenterAfterZoom` 로 계산된 **예측 중심**이고, 예측 오차는 게인 오차 정도(실측 1° 변위 예측오차 ≈0.001)라 0.08 은 예측오차 대비 ~80배 여유·오답후보(간격 0.15) 대비 절반이라는 균형에서 나온 값이다(platePtz.ts:83, :378 주석).

최초 클릭 선정 반경은 기준점이 **마스터의 마우스 클릭 좌표**다. 흡수해야 할 오차가 전혀 다르다:

| 오차원 | 크기(정규화, 광각 프레임 기준) | 근거 |
|---|---|---|
| 마우스 클릭 정밀도 | ±0.01~0.02 | 라이브뷰 클릭, 사람 손 |
| 번호판 ↔ 클릭점 오프셋 | 0.02~0.08 | 마스터가 차량 앞면 어디를 찍느냐. 먼 차량은 차체 전체가 0.05~0.10 폭이라 오프셋이 작고, 가까운 차량은 차체가 커서 오프셋이 클 수 있다 |
| LPD 박스 중심 vs 실제 판 중심 | ≤0.01 | 검출이 결정적(지터 0) |
| **합(worst)** | **≈0.10** | |

상한(넘으면 안 되는 값): **이웃 번호판 최소 간격 0.11**(PtzCalibrator.ts:29 주석 — 실측 슬롯 판 간격 ≈0.11~0.15). 반경이 0.11 이상이면 "진짜 대상이 미검출일 때 이웃이 반경 안에 들어와 채택"되는 원래 버그가 그대로 재현된다. 즉 게이트가 **의미를 가지려면 반드시 < 0.11**.

### 1.2 결정

- **신규 옵션** `PlatePtzOpts.initialRadiusNorm?: number` (기존 `matchRadiusNorm` 과 **분리**).
- **기본값 = `undefined` = 게이트 없음**(= 현재 `captureAndDetect(..., null)` 동작 그대로).
- 클릭 경로(`PtzCalibrator.centerOnPoint` / 사다리)만 **명시 주입**. 주입값은 `cfg.calibrate.pointMatchRadiusNorm ?? 0.10`.
- **권고 기본값 0.10** — 근거: 흡수해야 할 worst 오차 합(≈0.10) 이상이면서 이웃 최소 간격 0.11 미만인 **유일하게 좁은 구간**의 값. 0.11 이상은 게이트가 무의미해지고, 0.08(추적값)은 차체 클릭 오프셋을 못 흡수해 정상 케이스를 죽인다.
- 튜닝 규약: 라이브에서 `no_plate_near_click` 오탐이 잦으면 **코드 수정 없이 config 로 0.13 까지** 올린다(0.11 초과는 "이웃 오채택 가능"을 감수하는 것이므로 문서에 그 대가를 명시). 반대로 오채택이 관측되면 0.08 로 내린다.

### 1.3 회귀 안전성 (★핵심)

`PtzCalibrator.baseOpts()` 는 `plateRoi` 를 주지 않는다 → 배치(`calibrateSlot`→`acquireAndCenter`)의 `centerOnPlate` 최초 prior 는 **화면중앙 {0.5,0.5}** 이고, acquire zoom(줌인 상태)에서 판은 중앙에서 꽤 벗어나 있을 수 있다. 여기에 0.10 게이트를 **무조건** 걸면 배치가 대량 `no_plate` 로 죽는다 = 시뮬 98% 즉사.

→ 그래서 **기본 off + 클릭 경로 옵트인**이 유일하게 안전한 형태다. 배치의 오채택 방지는 이미 `peerOffsets`(Voronoi 소유권 게이트)가 담당하므로 정직성 원칙에도 구멍이 없다.

### 1.4 구현 변경점 (파일·함수)

| 파일 | 변경 |
|---|---|
| `src/calibrate/platePtz.ts` | `PlatePtzOpts` 에 `initialRadiusNorm?: number` 추가 / `ResolvedOpts` 에 `initialRadiusNorm?: number`(옵셔널 유지 — 기본값 부여 금지) / `centerOnPlate:209` 의 `captureAndDetect(..., o.plateRoi, null)` → `..., o.initialRadiusNorm ?? null)` / `zoomToPlateWidth:297` 은 **건드리지 않는다**(체이닝 시 이미 판 박스가 prior 라 게이트 불필요, 추가하면 배치 회귀 위험만) |
| `src/calibrate/platePtz.ts` | `captureAndDetect` 에 "반경 기각" 발생 시 구분 가능한 반환 필요 → 반환형을 `PlateBox \| null` 에서 **`{ plate: PlateBox } \| { plate: null; why: 'none' \| 'out_of_radius' }`** 로 바꾸거나(호출처 4곳 수정), 더 작게는 **private 필드 대신 지역 변수로 후보수만 별도 확인**. 권고: 아래 1.5 |
| `src/config/toolsConfig.ts` | `CalibrateSchema` 에 `pointMatchRadiusNorm: z.number().min(0).max(1).optional()` 추가(기본값 미설정 — 코드 기본 0.10) |
| `src/calibrate/PtzCalibrator.ts` | 클릭 경로에서 `initialRadiusNorm` 주입(§2.4) |

### 1.5 `no_plate` vs `no_plate_near_click` 구분 방법 (최소 변경안)

`captureAndDetect` 시그니처를 바꾸면 호출처 5곳이 흔들린다. 최소 변경으로:

```ts
// captureAndDetect 는 그대로 두고, 반경 기각을 별도 판정하는 private 헬퍼를 하나 추가한다.
private async captureDetectPick(
  camIdx: number, presetIdx: number, ptz: Ptz, prior: NormalizedRect, radius: number | null,
): Promise<{ plate: PlateBox | null; rejected: boolean }>
```
- 내부는 현재 `captureAndDetect` 본문과 동일하되, `picked !== null && 거리 > radius` 인 경우 `{plate:null, rejected:true}` 를 반환.
- 기존 `captureAndDetect` 는 이 헬퍼를 감싼 얇은 래퍼(`.plate` 반환)로 남겨 **기존 호출처 4곳 무변경**.
- `centerOnPlate` 의 **최초 선정만** 헬퍼를 직접 호출해 `rejected ? 'no_plate_near_click' : 'no_plate'` 로 사유를 가른다.

이 구분은 마스터에게 **"클릭 근처에 판이 없다(=클릭 위치를 옮겨라)"** 와 **"화면에 판이 하나도 안 잡힌다(=LPD/줌 문제)"** 를 분리해 준다. Goal 의 "실패는 실패로 보고" 요구를 UI 문자열 수준에서 충족.

---

## 2. Requirement 2 — 줌 사다리

### 2.1 배치 위치 결정 = `PlatePtz` 신규 메서드

세 후보를 판단 기준 (a)회귀금지 (b)PlatePtz 무상태·단독호출 철학 (c)라우트 얇게 로 대조:

| 후보 | (a) | (b) | (c) | 판정 |
|---|---|---|---|---|
| A. `PtzCalibrator.centerOnPoint` 의 분기 확장 | ○ | — | ○ | 사다리 rung 마다 캡처+LPD 가 필요한데 LPD 호출·검출 오케스트레이션은 PlatePtz 의 책임. PtzCalibrator 가 `deps.lpd` 를 직접 쓰기 시작하면 "폐루프는 소유하지 않는다"(PtzCalibrator.ts:92 주석) 계약이 깨진다 → **기각** |
| B. `PtzCalibrator` 오케스트레이션 + rung 마다 `centerOnPlate` 재호출 (배치 `acquireAndCenter` 패턴) | ○ | ○ | ○ | rung 마다 probe(게인 실측 이동 1회)가 붙는다. 실카에서 게인은 불필요·유해(§3)하고 시간도 2배 → **기각** |
| **C. `PlatePtz.centerAndZoomByLadder()` 신규 메서드** | ○ 기존 2메서드 무변경 | ○ 무상태·단독호출·단일 호출로 완결 | ○ 라우트 무변경, PtzCalibrator 는 3줄 분기만 | **채택** |

**C 채택 근거 보강**: 클릭점 조준(`camera.centerOnPoint` 또는 기하 1샷)도 PlatePtz 안에서 수행한다. `controlMath.aimPtzForPoint` 는 순수함수라 PlatePtz 가 그대로 쓸 수 있고, 이렇게 하면 `PtzCalibrator.aimPointToCenter`(그리고 그 안의 `pointBusy` 락)를 **전혀 건드리지 않는다** — 만약 PtzCalibrator 가 자기 `aimPointToCenter` 를 재사용하려 하면 `pointBusy` 가 이미 true 라 **자기 자신에게 409 를 던지는 데드락**이 된다(PtzCalibrator.ts:175 vs :213). 이 함정을 구조적으로 회피하는 것이 C 의 추가 이점이다.

### 2.2 신규 시그니처

```ts
// platePtz.ts — 기존 2메서드와 동급의 3번째 공개 메서드(무상태·단독 호출 가능)
/**
 * [함수 3] 클릭 지점 조준 → 줌 사다리 → 목표 폭 수렴. center+zoom 을 한 호출로 완결한다.
 * centerOnPlate / zoomToPlateWidth 를 호출하지 않는다(상호 의존 없음 — 기존 경로 무영향).
 */
async centerAndZoomByLadder(
  camIdx: number,
  presetIdx: number,
  point: NormalizedPoint,     // 클릭 지점(정규화, 현재 화면 기준)
  startPtz: Ptz,              // 현재 PTZ(호출측이 currentPtzFor 로 해석)
): Promise<PlatePtzResult>    // 반환형 재사용(ok/ptz/plate/err/plateWidth/gain/iterations/reason)
```

신규 옵션(전부 옵셔널, 기존 opts 와 공존):
```ts
initialRadiusNorm?: number;   // §1 — 사다리 rung0 게이트로도 재사용
ladderMaxRungs?: number;      // 사다리 rung 상한
nativeAimSettleMs?: number;   // 네이티브 setcenter 후 정착 대기(§4)
```
`maxZoomStepRatio`(기본 1.5) · `targetPlateWidth`(0.20) · `widthTol`(0.02) · `centerTol` · `settleMs` 는 **기존 값을 그대로 재사용**한다 = Requirement 2-② "1.5 정합".

### 2.3 루프 의사코드

```
centerAndZoomByLadder(cam, preset, point, startPtz):
  o = opts
  gain = scaleGainForZoom({fallbackGainPan, fallbackGainTilt, zoomRef:1}, startPtz.zoom)   // 기하 폴백용
  ptz  = startPtz
  latched = false          // 한 번이라도 대상 판을 잡았는가
  everDetected = false     // 사다리 전 구간 통틀어 판을 본 적이 있는가(사유 구분용)

  # ── ① 클릭점 조준 (rung 진입 전 1회) ───────────────────────────
  aim = await recenterTo(point)                       # 아래 recenterTo 참조
  if !aim.ok: return fail('aim_failed', ptz)
  ptz = aim.ptz                                       # zoom 불변

  # ── ②~④ 사다리 ────────────────────────────────────────────────
  for rung in 0 .. o.ladderMaxRungs:
     # 캡처는 항상 requestImage(ptz override) — 이동+캡처 원자(기존 PlatePtz 불변식 유지).
     # 실카에서는 CameraSourceClient.requestImage → RealPtzSource.move(waitUntilSettled 내장) → getJpeg.
     gate   = latched ? o.matchRadiusNorm : (o.initialRadiusNorm ?? null)
     picked = await captureDetectPick(cam, preset, ptz, priorRect({cx:0.5, cy:0.5}), gate)

     if picked.plate:
        everDetected = true; latched = true
        pr = quadBoundingRect(picked.plate.quad)
        w  = pr.w
        if isWidthConverged(w, o.targetPlateWidth, o.widthTol):
            return ok(ptz, picked.plate, w, rung+1)          # ★유일한 성공 출구

        # ③ 판 중심 재중심 — 실카는 네이티브 한 방, 아니면 게인 1스텝
        c = centerOfRect(pr)
        if !isCentered(plateCenterError(pr), o.centerTol):
            r = await recenterTo({x:c.cx, y:c.cy})
            if !r.ok: return fail('aim_failed', ptz, w)
            ptz = r.ptz

        # 다음 rung zoom: 목표 직행값을 1.5 배 스텝으로 클램프(과도 점프 금지)
        zWant = zoomForWidth(ptz.zoom, w, o.targetPlateWidth, clampZoom)   # 게인무관 직접 목표
        zNext = clampZoom(min(zWant, ptz.zoom * o.maxZoomStepRatio))
        if zNext <= ptz.zoom + EPS:
            return fail('zoom_saturated', ptz, w)            # 검출은 되는데 더 못 키움
     else:
        # 미검출 → 눈먼 1스텝 줌인. zoom-in 은 광학중심 보존 → ①로 중앙에 온 대상은 중앙에 남는다.
        if latched: return fail('plate_lost', ptz)           # 잡았다 놓친 것은 별개 사유
        zNext = clampZoom(ptz.zoom * o.maxZoomStepRatio)
        if zNext <= ptz.zoom + EPS:
            return fail(everDetected ? 'zoom_saturated' : 'plate_not_found_at_max_zoom', ptz)

     ptz = {...ptz, zoom: zNext}

  return fail(everDetected ? 'max_iterations' : 'plate_not_found_at_max_zoom', ptz)


recenterTo(p):                     # ③ 분기점 — 여기 한 곳에서만 갈린다
  native = this.camera.centerOnPoint
  if native:                                             # 실카(휴컴스)
     const got = await native.call(this.camera, cam, p)   # ptz_centering setcenter type=point
     await this.sleep(o.nativeAimSettleMs)                # ★setcenter 는 정착 대기가 없다(§4)
     try { return {ok:true, ptz: await this.camera.getPtz(cam)} }
     catch { return {ok:true, ptz: got} }                 # 조회 미지원 소스는 setcenter 반환값 사용
  # 시뮬/네이티브 미지원 — 기존 게인 1스텝(개방루프). move 로 명령하고 명령값을 상태로 삼는다.
  const aim = aimPtzForPoint(p, ptz, gainRefAtZoom, o.maxStepDeg)
  const ok  = await this.camera.move(cam, aim.pan, aim.tilt, aim.zoom)
  return {ok, ptz: aim}
```

### 2.4 `PtzCalibrator.centerOnPoint` 진입 분기 (변경 최소)

```ts
// PtzCalibrator.centerOnPoint 내부, 기존 락/currentPtzFor 이후
const useLadder = this.ladderEnabled(cam);   // §6 스위치
if (useLadder && opts?.zoom !== false) {
  const p = this.makePlatePtz({ ...this.baseOpts(), initialRadiusNorm: this.pointRadius() }, cam);
  if (p.centerAndZoomByLadder) {                       // 테스트 시임 하위호환(§7)
    const r = await p.centerAndZoomByLadder(camIdx, presetIdx, point, startPtz);
    return { ok: r.ok, ptz: r.ptz, plateWidth: r.plateWidth, ...(r.reason ? { reason: r.reason } : {}) };
  }
}
// ↓ 기존 경로 전부 그대로(무변경). 단 첫 centerOnPlate 에 initialRadiusNorm 주입(Requirement 1).
```
- `plateRoi` 는 사다리 경로에서 **주지 않는다**(조준 후에는 클릭점 = 화면중앙이므로 prior 는 항상 중앙). 기존 경로에는 지금처럼 `plateRoi: prior` 유지.
- `mode:'plate'`(zoom:false)는 사다리를 타지 않는다 — center 전용 경로는 이번 작업 범위 밖. 단 Requirement 1 게이트는 적용된다.

**Requirement 5(경로 정합)**: 사다리 안의 모든 카메라 접촉(`requestImage`·`centerOnPoint`·`move`·`clampZoom`)은 생성자에 주입된 `this.camera` 하나를 쓴다. 그 카메라는 `makePlatePtz(opts, cam)` 의 2번째 인자 = 라우트가 만든 `CameraSourceClient` 다(PtzCalibrator.ts:131 에서 이미 배선됨). **`this.camera`(파이프라인 카메라)로 새는 지점이 0 인지** 구현 시 grep 으로 확인할 것 — 이것이 R5 의 검증 포인트.

---

## 3. 네이티브 경로에서 게인·probe·damp 가 불필요한가 (리더 판단 검토)

**결론: 맞다. 단 조건이 하나 붙는다.**

- probe·게인·damp 는 전부 "정규화 화면오차 → pan/tilt 도(°)" 변환을 **소프트웨어가 추정**해야 하기 때문에 존재한다. `ptz_centering setcenter type=point` 는 그 변환을 **장비 펌웨어가 자기 FOV/줌 테이블로 수행**한다. 소프트웨어 추정치를 섞으면 오히려 오차원이 하나 늘어난다.
- damp(개선 정체 시 게인 감쇠)도 P 제어 진동 방지 장치라 **폐루프가 없으면 정의되지 않는다**. 사다리는 rung 마다 "검출 → setcenter 1회"라 P 제어 반복이 아니다.

**반례 검토(정직하게 남긴다)**:
1. **setcenter 자체가 부정확할 수 있다.** 장비 좌표계 기준 해상도(`CENTERING_BASE_WIDTH/HEIGHT`)로 반올림하고, 광각 왜곡 보정이 펌웨어에 없으면 화면 가장자리 지점은 중앙에 정확히 오지 않는다. → 사다리가 **rung 마다 재중심**하므로 잔차는 rung 을 거치며 수렴한다(1회 완벽을 요구하지 않는 구조). 이것이 "게인 불요"의 실제 방어막이다. 단 **잔차가 rung 의 zoom 배율(1.5)보다 빠르게 줄지 않으면 발산**한다 — 즉 setcenter 잔차가 매번 화면의 0.08(matchRadiusNorm) 이내여야 한다. **이것이 이 설계의 유일한 미검증 물리 가정**이며, 라이브 1회차에서 반드시 관측해야 할 값이다(§8).
2. **setcenter 의 정착 대기 부재**(§4) — 게인과 무관한 별개 결함이므로 §4 에서 처리.
3. `centerOnPoint` 는 pan/tilt 만 움직이므로 zoom 명령은 여전히 `requestImage`(→`move`) 로 나간다. 즉 **네이티브 경로에서도 `move` 는 쓰인다** — "네이티브라서 move 를 안 쓴다"는 오해를 구현자가 하지 않도록 명시한다.

---

## 4. 사다리 파라미터 표 (기본값 + 근거)

| 파라미터 | 기본값 | 근거 | 출처/관계 |
|---|---|---|---|
| 시작 zoom | **`startPtz.zoom`(현재 PTZ 그대로)** | 클릭은 "지금 보이는 화면" 기준이다. 별도 시작 zoom 을 강제하면 클릭 좌표와 프레임이 어긋난다. 배치의 `acquireZoom`(사전 계산 줌인)은 slot_setup 의 lpd 폭을 알 때만 가능한데 클릭에는 그 정보가 없다 | `currentPtzFor` (PtzCalibrator.ts:238) |
| 칸당 배율 | **1.5** (`maxZoomStepRatio` 재사용) | Requirement 2-② 명시. 기존 상수와 정합, cfg 로 이미 노출됨. 큰 점프는 중심 오차를 같은 배율로 확대(platePtz.ts:85) | `cfg.maxZoomStepRatio` |
| 최대 rung 수 | **`ladderMaxRungs = 8`** | 1.5^8 ≈ 25.6 배. `zoomMin=1`에서 시작해도 `zoomMax=36` 상한을 사실상 소진한다(그 전에 `clampZoom` 포화로 종료). 상한은 "무한 루프 방지"용이고 실질 종료는 clampZoom 이 담당 | `cfg.acquireLadderMaxSteps`(=5, 줌아웃용)와 **별개 파라미터**. 혼용 금지 |
| 최대 zoom | **`camera.clampZoom` 에 전적으로 위임** | 카메라마다 상한이 다르다. 사다리가 독자 상한을 두면 clampZoom 과 이중 진실이 된다. 포화(=`zNext<=ptz.zoom`) 판정은 기존 `zoomToPlateWidth:335` 의 포화 판정과 동일 관용구 | `zoomMin/zoomMax` (config) |
| rung 정착 대기 | **`settleMs=300` (기존값)** + 실카는 `move`→`waitUntilSettled` 가 추가 보장 | `captureAndDetect` 가 이미 `requestImage` 후 `settleMs` sleep. 시뮬은 이동+캡처가 원자라 300ms 로 충분(기존 검증됨) | platePtz.ts:401 |
| **네이티브 조준 정착** | **`nativeAimSettleMs = 1000`** | ★`RealPtzSource.centerOnPoint`(:237)는 `waitUntilSettled` 를 **호출하지 않는다**(`move` 와 달리). setcenter 직후의 `currentPtz()` 는 슬루 중 값일 수 있고, 그 값을 다음 rung 의 `requestImage` 로 명령하면 **엉뚱한 곳으로 이동**한다. speed=50 으로 큰 pan 을 도는 데 필요한 시간을 보수적으로 잡아 1000ms. **미확정 — 라이브 1회차 튜닝 대상**(§8) | RealPtzSource.ts:237 vs :187 |
| rung0 중앙 게이트 | **`initialRadiusNorm = 0.10`** | §1.2. 조준 후에는 클릭점이 화면중앙이므로 "클릭점 기준 반경"과 "중앙 기준 반경"이 **수학적으로 동일**하다 | §1 |
| latch 후 중앙 게이트 | **`matchRadiusNorm = 0.08` (기존값)** | 한 번 재중심된 뒤 대상은 중앙 ±centerTol(0.03) 근방. 이웃은 최소 0.11 떨어져 있고 **zoom-in 이 그 간격을 1.5배씩 벌린다**(rung1 에서 0.165, rung2 에서 0.25…) → 0.08 은 진짜 대상은 통과·이웃은 확실히 기각. 잔차 0.03 이 1.5배 확대돼도 0.045 < 0.08 (여유 1.8배) | platePtz.ts:83 |

**"각 칸에서도 거짓 latch 재발" 방지 = 위 두 줄이 전부다.** 사다리 rung 의 prior 는 **항상 화면중앙(0.5,0.5)** 고정이고(예측 prior 불요 — 재중심이 매 rung 대상을 중앙으로 되돌리므로), 게이트는 latch 전/후로 0.10 → 0.08. 게이트를 통과하지 못하면 대상이 없는 것으로 간주하고 `plate_lost`(latch 후) 또는 줌 1스텝(latch 전)으로 간다. **어떤 경우에도 "반경 밖 판을 대신 채택"하지 않는다** = Goal 의 위장 성공 0.

---

## 5. 실패 사유 체계

`PlatePtzFailReason` 을 3건 확장(기존 4건 문자열 **무변경** — UI/DB 회귀 0):

```ts
export type PlatePtzFailReason =
  | 'no_plate' | 'plate_lost' | 'max_iterations' | 'zoom_saturated'   // 기존
  | 'no_plate_near_click' | 'plate_not_found_at_max_zoom' | 'aim_failed';  // 신규
```

| reason | 의미 | 마스터의 다음 행동 |
|---|---|---|
| `no_plate` | 화면에 LPD 검출이 **0건** | LPD 서비스/조명/각도 확인 |
| `no_plate_near_click`(신규) | 검출은 있으나 **전부 클릭점에서 0.10 초과** | 번호판 위를 더 정확히 클릭. (이 사유가 곧 "거짓 성공을 하지 않았다"는 증거) |
| `plate_not_found_at_max_zoom`(신규) | 조준은 됐으나 **사다리 전 구간에서 한 번도 미검출**, 최대 줌 도달 | LPD 한계(가림·각도·오염). Requirement 3 그대로 |
| `plate_lost` | 잡았다가 이후 rung 에서 중앙 게이트 이탈 | setcenter 잔차 과다 의심 → `nativeAimSettleMs` 상향 검토 |
| `zoom_saturated` | 검출 중이나 clampZoom 상한이라 목표 폭 미달 | 물리적 한계(너무 먼 차) |
| `aim_failed`(신규) | setcenter/move 가 거절 또는 예외 | 장비 통신·권한 문제 |
| `max_iterations` | rung 상한 소진(검출 이력 있음) | `ladderMaxRungs` 상향 |

라우트는 `reason` 을 그대로 통과시키므로(`calibrateRoutes.ts:84`) **UI 변경 불요**. 다만 뷰어에 한글 매핑 테이블이 있다면 3건 추가가 필요 — **구현자는 `src/viewer` 에서 `zoom_saturated` 문자열을 grep 해 매핑 존재 여부를 확인할 것**(미확인 사항).

---

## 6. 회귀 보호 전략 (Requirement 4) — 트레이드오프 정면 처리

### 6.1 문제
"네이티브 없으면 기존 경로 유지"는 시뮬 98% 를 **구조적으로** 지킨다(시뮬은 새 코드를 단 한 줄도 실행하지 않는다). 대가는 **사다리가 시뮬 라이브에서 미검증**이라는 것 — 즉 실카 첫 시도가 곧 첫 통합 실행이 된다.

### 6.2 권고안: 3층 방어

1. **기본 동작은 네이티브 게이팅**(`pointZoomLadder: 'auto'`). 시뮬 라이브 = 기존 코드 경로 100%, 회귀 확률 0. 하드 제약을 확률이 아니라 **구조**로 만족시킨다.
2. **사다리 로직 자체는 유닛테스트로 완전 검증.** `centerOnPoint` 를 가진 **가짜 카메라 스텁**(정규화 좌표계를 그대로 시뮬레이션하는 결정형 모델: setcenter → 오차 0 으로 이동, zoom → 폭 ∝ zoom, 이웃 판 1개 배치)으로 rung 진행·게이트·사유를 전부 결정형 검증한다. 이러면 "시뮬 미검증"은 **통합 미검증**으로 좁혀지고 로직 미검증은 아니다.
3. **cfg 스위치로 시뮬 실험을 가능하게 남긴다**: `cfg.calibrate.pointZoomLadder: 'auto' | 'always' | 'off'` (기본 `'auto'`).
   - `'always'` → 시뮬에서도 사다리(재중심은 기하 게인 1스텝 폴백). 마스터가 원할 때 **config 한 줄로** 시뮬 통합 검증을 할 수 있고, 기본값이 아니므로 회귀는 발생하지 않는다.
   - `'off'` → 사다리 완전 비활성(실카에서도 기존 경로). **롤백을 배포 없이** 할 수 있는 안전핀.

   이 스위치는 "요청하지 않은 설정 가능성"이 아니라 **하드 제약(회귀 금지)과 검증 요구(R2)가 정면충돌하는 지점을 해소하는 최소 장치**다. 코드량은 분기 1줄 + 스키마 1줄.

### 6.3 정직한 한계 표기
- 시뮬 라이브에서 사다리가 검증되지 않는다(기본 설정에서). `'always'` 로 돌린 결과는 **네이티브 없는 기하 폴백 경로의 검증**이지 실카 네이티브 경로의 검증이 아니다.
- 실카 네이티브 경로의 통합 검증은 **마스터의 클릭에 100% 의존**한다(Goal §검증 한계와 동일). 리더가 재현할 수 없다.

---

## 7. 변경 파일·함수 목록 (구현자 인계)

| 파일 | 함수/심볼 | 변경 종류 |
|---|---|---|
| `src/calibrate/platePtz.ts` | `PlatePtzOpts` | +`initialRadiusNorm?` `ladderMaxRungs?` `nativeAimSettleMs?` |
| | `ResolvedOpts` | +동일 3필드(`initialRadiusNorm` 은 **기본값 부여 금지**, undefined 유지) |
| | `PlatePtzFailReason` | +3 문자열 |
| | `centerOnPlate` | :209 한 줄 — `null` → `o.initialRadiusNorm ?? null`, + 사유 분기(`no_plate_near_click`) |
| | `captureDetectPick`(신규 private) / `captureAndDetect`(래퍼로 축소) | 신규+리팩터(동작 동일) |
| | **`centerAndZoomByLadder`(신규 public)** | 신규 ~90행 |
| | `recenterTo`(신규 private) | 신규 ~15행 — 네이티브/기하 분기 유일 지점 |
| `src/calibrate/PtzCalibrator.ts` | `PlatePtzApi` 타입 | `Pick<...> & Partial<Pick<PlatePtz,'centerAndZoomByLadder'>>` (기존 테스트 스텁 하위호환 — §7 주의) |
| | `centerOnPoint` | 사다리 분기 3~6줄 + 기존 경로에 `initialRadiusNorm` 주입 |
| | `ladderEnabled`/`pointRadius`(신규 private) | cfg 해석 2~6줄 |
| | `aimPointToCenter`·`calibrateSlot`·`acquire*`·`baseOpts` | **무변경** |
| `src/config/toolsConfig.ts` | `CalibrateSchema` | +`pointMatchRadiusNorm?` `pointZoomLadder?` `ladderMaxRungs?` `nativeAimSettleMs?` (전부 optional, DEFAULT 미기재 → 기존 config 파일 무수정 동작) |
| `src/api/calibrateRoutes.ts` | — | **무변경**(라우트 얇게 유지) |
| `src/viewer/*` | reason 한글 매핑(있다면) | 확인 후 3건 추가 |

**★ 하위호환 함정**: `PlatePtzApi` 에 새 메서드를 **필수**로 추가하면 `makePlatePtz` 스텁을 쓰는 기존 테스트(`centeringSlot`·`centeringOwnership`·`centeringPreAim`·`calibratePointSource` 등)가 전부 타입 에러로 죽는다. 반드시 `Partial` 로 옵셔널 결합하고 호출측에서 존재 확인(`if (p.centerAndZoomByLadder)`) 후 없으면 기존 경로로 폴백할 것.

---

## 8. Requirements 대조표

| # | 요구 | 충족 방법 | 검증 |
|---|---|---|---|
| **1** | 최초 선정 반경 게이트, 파라미터화, 근거, 광각에서 정상케이스 미살상 | `initialRadiusNorm`(신규·기본 off·클릭 경로만 주입) 기본 0.10, 근거 §1.1 표(오차합 0.10 ≤ r < 이웃간격 0.11). 반경 밖이면 `no_plate_near_click` 실패 | T1 |
| **2** | ①클릭점 조준 ②1.5 사다리+rung 캡처/LPD ③실카 setcenter 한 방/시뮬 게인 1스텝 ④폭 수렴까지 반복. 가산·기존 경로 파괴 금지 | `centerAndZoomByLadder` §2.3 의사코드. ①=`recenterTo(point)` ②=`maxZoomStepRatio` 재사용 ③=`recenterTo` 의 native/geometric 분기 ④=`isWidthConverged` 만이 성공 출구. 기존 2메서드 무변경 | T2, T5 |
| **3** | 최대 줌 미검출 → 위장 성공 없이 명시 사유 | `plate_not_found_at_max_zoom`(검출 이력 0) / `zoom_saturated`(검출은 됨). 성공 출구가 폭 수렴 단 하나 | T3 |
| **4** | 시뮬 98% 하드 제약, 네이티브 분기로 기존 경로 보존 | `pointZoomLadder='auto'` 기본 → 시뮬은 신규 코드 미실행. 배치 경로는 `initialRadiusNorm` 기본 off 로 완전 무영향(§1.3) | T4 |
| **5** | `source` 라우팅이 사다리 전 구간 유지 | 모든 카메라 접촉이 `this.camera`(=`makePlatePtz(opts, cam)` 주입분). `PtzCalibrator.this.camera` 직접 참조 0 | T6 |
| **6** | vitest 최소 4건 | T1~T6 (6건 권고) | — |

### 테스트 계획 (qa-tester 인계)

| ID | 내용 | 성공 기준 |
|---|---|---|
| **T1** | 클릭점 0.30 거리에만 판이 있는 프레임 → `centerOnPlate`(initialRadiusNorm=0.10) | `ok:false`, `reason:'no_plate_near_click'`, **그 판을 채택하지 않음**(plate===null) |
| **T2** | 네이티브 있는 가짜 카메라 → 사다리 | `centerOnPoint` 호출 ≥1, `move`/`requestImage` 의 zoom 이 1.5배씩 증가, 최종 `ok:true` 이고 `plateWidth∈[0.18,0.22]` |
| **T3** | 사다리 전 구간 LPD 빈 배열 | `ok:false`, `reason:'plate_not_found_at_max_zoom'`, zoom 이 `zoomMax` 에서 멈춤 |
| **T4** | 네이티브 **없는** 카메라로 `PtzCalibrator.centerOnPoint`(mode plate-zoom) | 기존과 동일하게 `centerOnPlate`→`zoomToPlateWidth` 순 호출(스텁 호출 로그 대조), `centerAndZoomByLadder` 미호출 |
| **T5** | `pointZoomLadder:'always'` + 네이티브 없는 카메라 | 사다리를 타되 재중심이 `move`(기하)로 나감 = ③ 분기 검증 |
| **T6** | `source` 지정 요청 | 주입 카메라의 `requestImage`/`centerOnPoint` 만 호출되고 파이프라인 카메라 호출 0 (`calibratePointSource.test.ts` 확장) |

기존 회귀: `centeringSlot`·`centeringOwnership`·`centeringPreAim`·`centeringBoundary`·`calibrateRoutes.point`·`controlMath` 전부 **무수정 통과**가 조건.

---

## 9. 미확정 / 가정 (은닉 금지)

1. **[가정·최대 위험] setcenter 잔차가 rung 마다 0.08 이내로 수렴한다.** 휴컴스 펌웨어의 광각 왜곡 보정 여부를 모른다. 화면 가장자리 클릭에서 잔차가 크면 rung 을 거치며 `plate_lost` 가 난다. → 라이브 1회차에서 **각 rung 의 `errX/errY` 로그를 반드시 채록**(구현자는 rung 마다 `logger.info({cat:'centering', phase:'ladder', rung, zoom, errX, errY, reason})` 를 남길 것). 잔차가 크면 이터레이션 2에서 "rung 당 setcenter 2회" 또는 게이트 완화로 대응.
2. **[미확정] `nativeAimSettleMs=1000` 이 충분한가.** `RealPtzSource.centerOnPoint` 에 정착 대기가 없다는 것은 코드로 확인했으나, 실제 슬루 시간은 미측정. 대안(더 견고): `RealPtzSource.centerOnPoint` 안에서 `waitUntilSettled` 를 호출하도록 소스를 고치는 것 — 다만 이는 `개별 center`(mode:'point') 경로의 동작도 바꾸므로 **이번 이터레이션 범위 밖으로 두고 sleep 으로 우회**한다. 라이브에서 문제가 확인되면 그때 소스 수정을 제안한다.
3. **[미확정] "시뮬 98%"의 정확한 측정 대상**(배치 센터라이징 슬롯 수렴률 vs 개별 클릭 성공률)을 코드로 확인하지 못했다. 어느 쪽이든 §6.2 의 구조적 게이팅으로 보호되지만, 마스터가 "개별 클릭 시뮬 98%"를 뜻했다면 **Requirement 1 의 반경 게이트는 시뮬 클릭 경로에도 적용되므로 미세한 성공률 변화가 가능하다**(부정확한 클릭이 `no_plate_near_click` 로 바뀜). 이는 정직성 요구(R1)와 맞바꾼 의도된 변화이며, 회귀가 아니라 **거짓 성공의 제거**로 분류한다 — 마스터 확인 필요.
4. **[미확인] 뷰어 UI 의 reason 한글 매핑 테이블 존재 여부.** 있으면 신규 3건 추가 필요(§5).
5. **[범위 밖·명시]** `mode:'plate'`(center only) 경로는 사다리를 쓰지 않는다. `mode:'point'`(`aimPointToCenter`)는 **완전 무변경**.
