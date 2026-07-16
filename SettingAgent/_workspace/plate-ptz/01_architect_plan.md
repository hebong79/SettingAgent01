# 설계: 번호판 센터링·줌 독립 함수 모듈 (PlatePtz)

작성: 2026-07-16 / 설계자
브랜치: `feat/plate-ptz` (워크트리 `ParkAgent-plate-ptz` — 메인 리포 쓰기 금지)
요구: (1) LPD 번호판 OBB 중심으로 pan/tilt 이동 (2) OBB 가로가 화면 가로 ~20% 될 때까지 zoom (3) 한 모듈/클래스, 두 작업 완전 분리·각각 단독 호출 가능

## 개정 이력

| 판 | 날짜 | 내용 |
|---|---|---|
| r0 | 2026-07-16 | 최초 설계 |
| r2 | 2026-07-16 | **r1 라이브 재검증 실패(B `plate_lost`) — 근본 원인: r1 이 근거로 쓴 게인 실측 자체가 최근접 추적 aliasing 오염(리더 정정 보고, `_live/diagSweep.mts` 전체목록 스윕으로 참값 확정: gainPan=−36.6~−37.0·gainTilt=−21.0~−21.1 @z1.69341, 1°/2°/3° 완전 선형 → zoomRef=1 환산 −62.0/−35.5).** ① probeStepDeg 3°→**1°** 복귀(변위 0.027 = 간격 절반 0.075 의 36%; 3° 변위 0.082 는 사정권 — r1 근거 폐기) ② fallback 게인 **−62/−35.5** 부호·크기 정정(r1 pan +75 는 오염 허상) ③ aliasing 자기확증 방어는 **추가 장치 없음(④)** — §2.7 신설(수치 근거·후보 ①②③ 기각 사유) ④ maxStepDeg 5° **유지**(허용 게인 오차 31% vs probe 실측 오차 ≤1% — §2.7) ⑤ §6 모킹 모델을 실측 물리로 고정(음수 게인·zoom 종속·공백 메우는 미끼 검출) + 케이스 20 신설 — **부호 오류가 유닛에서 잡히도록** ⑥ §7 Goal 에 "게인 부호·크기 실측 일치" 명시 관측 항목 추가. **무변경(r1 유지 — 정정 실측이 오히려 검증)**: §2.5 예측 prior 추적·§2.6 zoom 스케일링(diagZoom: err 실측/예측 비 0.97~1.01)·damp 상한 3회·가드 선행·줌 스텝비 클램프·matchRadiusNorm 0.08. |
| r1 | 2026-07-16 | **라이브 검증 실패(Unity 13110 RPC + LPD 9082, cam1 프리셋1) 반영.** ① 대상 신원 전환 → §2.5 신설(직전 관측+예측 prior 추적) ② 게인 zoom 종속 → §2.6 신설(gain∝1/zoom, controlMath 순수 함수 3종 신규) ③ damp 죽음의 나선 → 감쇠 상한 3회(§2.1) ④ zoom 단독 성공 계약화(가드 선행+줌 스텝비 클램프, §2.2) ⑤ fallback 게인 실측 정합(pan +75/tilt **−35**, zoomRef=1)·probe 3°(§2.0) ⑥ §7 검증 환경 정정(시뮬 :13100 폐기 → Unity :13110 JSON-RPC·`RpcCameraClient`) ⑦ 테스트 13~19 추가(§6). **"기존 코드 변경 0줄" 제약은 "기존 함수·기존 테스트 무변경, controlMath 에 순수 함수 신규 추가만 허용"으로 개정**(리더 승인 — 제약의 목적은 회귀 방지이지 제약 자체가 아님). |

> ## 3줄 요약 (r1 갱신)
> 1. `controlMath.ts` 의 순수 함수 8종을 그대로 재사용하고, `PtzCalibrator.calibrateSlot()` 안에 얽혀 있던 **폐루프 오케스트레이션만 2개 공개 메서드로 분리**한 얇은 신규 클래스 `PlatePtz` 를 만든다. *(r1: 라이브 실측이 드러낸 물리 2건 — 대상 신원 추적·게인 zoom 종속 — 을 위해 controlMath 에 **순수 함수 3종만 신규 추가**한다. §2.5/§2.6/§5)*
> 2. 두 함수 모두 **폐루프(반복 검출)** 가 기본이다 — 오픈루프(FOV 모델)는 fovBaseV 취득 실패 시 계통 오차(과거 재중심 30% 미달 실측)가 있어 기본으로 부적합. probe 1회(캡처+검출 1회 추가)의 비용으로 부호 포함 게인을 실측하는 기존 확립 패턴을 따른다.
> 3. **기존 함수·기존 테스트 변경 0줄** — 신규 파일 2개 + controlMath 말미 순수 함수 추가만. `PtzCalibrator`/라우트/config 스키마 무접촉 → 기존 테스트 회귀 위험 구조적으로 0.

---

## 1. 핵심 판단: 재사용 vs 신규

| 후보 | 판정 | 근거 |
|---|---|---|
| `detectMath.vehicleCenterZoomPtz` (오픈루프 1샷) | **재사용 안 함** | ① pan/tilt+zoom 이 한 반환값에 합쳐져 있어 "완전 분리" 요구와 정면 충돌. ② `fovBaseV` 필요 — 취득 경로(`detectPipeline.loadDetectCfg` 의 지면모델 공동추정)가 placeRoi+camerapos+ground 주입을 요구하고, 실패 시 폴백 상수(34.6348°)로 강등되는데 이 값이 틀리면 **1샷이라 보정 기회가 없다**(과거 `camera.fov` 혼동으로 재중심 30% 미달 — detectPipeline.ts:126~133 주석에 실측 기록). ③ 대상이 차량 rect(frontBias)지 번호판이 아님. |
| `PtzCalibrator.calibrateSlot` (폐루프) | **로직 패턴 재사용, 함수로는 재사용 불가** | 원하는 제어 루프가 이미 여기 있으나 ① 센터링→줌이 한 private 메서드에 직렬 결합, ② `Repository`(setup_artifact)·`slot_ptz.json` writer·잡 상태머신·LLM 자문에 결박되어 단독 호출 불가. **이 결박을 푸는 것이 이번 작업의 본질.** |
| `controlMath.ts` 순수 함수군 | **100% 재사용** | 센터링(P 제어+게인 실측)·줌(sqrt 감쇠 보정)·수렴 판정·감쇠·최근접 선택 전부 존재. 중복 구현 금지 원칙에 따라 **신규 수학을 쓰지 않는다.** |
| `geometry.quadBoundingRect` / `LpdClient.detect` / `ICameraClient.requestImage` | 재사용 | OBB→rect 유도, 검출, 이동+캡처 원자 연산. |

결론: **신규는 오케스트레이션 클래스 1개뿐.** `calibrateSlot` 의 A단계(센터링)·B단계(줌)를 각각 독립 메서드로 재조립한다. `PtzCalibrator` 자체를 이 클래스에 위임하도록 리팩토링하는 것은 **이번 범위에서 제외**(기존 동작 불변 원칙 — 후속 과제로 §8에 기록).

## 2. 두 함수의 계약

### 2.0 배치 — 클래스 1개, 메서드 2개

```ts
// src/calibrate/platePtz.ts  (신규)
import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../clients/LpdClient.js';
import type { NormalizedRect } from '../domain/types.js';
import type { Ptz } from './types.js';

export interface PlatePtzDeps {
  camera: ICameraClient;   // 인터페이스 주입 — REST/RPC/모킹 교체 가능
  lpd: LpdClient;          // detect(Buffer)→PlateBox[] 만 사용(구조적 모킹 가능)
  sleep?: (ms: number) => Promise<void>;  // 테스트 0ms 주입
}

/** 게인은 항상 기준 zoom(zoomRef)과 함께 다닌다 — 실효 게인 = gain·zoomRef/현재zoom (§2.6). */
export interface PtzGain { gainPan: number; gainTilt: number; zoomRef: number }

export interface PlatePtzOpts {           // 전부 옵셔널
  centerTol?: number;           // 0.03
  targetPlateWidth?: number;    // 0.20
  widthTol?: number;            // 0.02
  maxIterations?: number;       // 15
  probeStepDeg?: number;        // 1.0 (r2: 3.0→1.0 복귀 — r1 의 3° 근거(1° 부호 모순 실측)는 aliasing 오염 데이터로 폐기.
                                //      판정: 1° 변위 0.027 = 간격 절반 0.075 의 36% (안전) vs 3° 변위 0.082 > 0.075 (사정권).
                                //      검출 노이즈 실측 0(diagGuard 5/5 결정적)이라 0.027 은 게인 산출에 충분히 큼. §2.7)
  maxStepDeg?: number;          // 5.0 (r2 재검토 후 유지 — 허용 게인 오차 31% vs probe 실측 오차 ≤1%. §2.7)
  fallbackGainPanDeg?: number;  // -62  (r2: +75→-62. ★부호·크기 정정 — diagSweep 전체목록 실측 gainPan=-36.6~-37.0
                                //      @z1.69341 → zoomRef=1 환산 ≈ -62.0. r1 의 +75 는 aliasing 오염 실측이 근거)
  fallbackGainTiltDeg?: number; // -35.5 (r2: -35→-35.5. 실측 gainTilt=-21.0~-21.1 @z1.69 → ×1.69 ≈ -35.5. 부호는 r1 대로)
  settleMs?: number;            // 300
  plateRoi?: NormalizedRect;    // 초기 대상 선정 prior 전용(이후는 §2.5 추적). 기본 {0.5,0.5,0,0}=화면 중앙 최근접
  gain?: PtzGain;               // (zoom 전용) 재중심 게인 체이닝. §2.3
  matchRadiusNorm?: number;     // 0.08 (r1 신설. §2.5 — 예측 prior 로부터 이 거리 초과 매칭은 기각(대상 소실 취급).
                                //      실측 번호판 간격 0.15 의 절반 근사. 이웃 갈아타기 차단)
  maxZoomStepRatio?: number;    // 1.5 (r1 신설. §2.2 — 1스텝 zoom 증배 상한(대칭: [z/1.5, z·1.5]).
                                //      실측 C: 1스텝에 zoom 1.69→7.49 점프 시 중심오차 4.4배 확대로 소실)
}

export type PlatePtzFailReason = 'no_plate' | 'plate_lost' | 'max_iterations' | 'zoom_saturated';

export interface PlatePtzResult {
  ok: boolean;
  ptz: Ptz;                     // 최종 "명령" PTZ (★ 응답 echo 아님 — §2.4)
  plate: PlateBox | null;       // 마지막 검출 OBB
  err: { errX: number; errY: number } | null;  // 마지막 중심 오차
  plateWidth: number | null;    // 마지막 boundingRect 폭(정규화)
  gain: PtzGain;                // 실측/사용 게인(+측정 시점 zoomRef) — zoomToPlateWidth 에 체이닝용 (r1: zoomRef 추가)
  iterations: number;
  reason?: PlatePtzFailReason;  // ok=false 일 때만
}

export class PlatePtz {
  constructor(deps: PlatePtzDeps, opts?: PlatePtzOpts) {...}

  /** [함수 1] 번호판 OBB 중심을 화면 중심(0.5,0.5)으로 — pan/tilt 만 변경, zoom 불변. */
  centerOnPlate(camIdx: number, presetIdx: number, startPtz: Ptz): Promise<PlatePtzResult>;

  /** [함수 2] 번호판 boundingRect 폭을 targetPlateWidth 로 — zoom 주도, 드리프트 시 1스텝 재중심 가드. */
  zoomToPlateWidth(camIdx: number, presetIdx: number, startPtz: Ptz): Promise<PlatePtzResult>;
}
```

- 무상태(잡 상태머신 없음) — 호출마다 독립. `Repository`·writer·brain 의존 없음.
- 메서드별 opts 오버라이드(`centerOnPlate(..., over?: Partial<PlatePtzOpts>)`)는 **넣지 않는다**(요청에 없음 — 필요하면 인스턴스 하나 더 만들면 됨. 과설계 금지). *[구현자 재량: 시그니처 끝에 `over?` 하나 얹는 것이 테스트를 단순화하면 허용 — 단 그 이상 금지]*
- `startPtz` 는 **필수 인자**: 명령 PTZ 추적의 시작점(§2.4). 프리셋 기본값이 필요하면 호출측이 `detectPipeline.resolvePresetPtz` 로 얻는다(이 클래스는 listCameras 에 의존하지 않는다 — 경계 최소).

### 2.1 [함수 1] `centerOnPlate` — 의사코드 (calibrateSlot A단계의 독립판)

```
1. captureAndDetect(startPtz, prior=plateRoi) → 없으면 {ok:false, reason:'no_plate'}
   ── 이후 모든 검출의 prior 는 §2.5 예측 prior (초기 대상만 plateRoi)
2. err = plateCenterError(quadBoundingRect(quad));  이미 isCentered? → 즉시 ok:true (probe 생략)
3. probe: startPtz + probeStepDeg(1°, pan·tilt 동시) 1회 캡처·검출   // r2: 3°→1° (§2.7)
   prior = predictPlateCenter(직전 중심, {+1,+1}, fallback게인)  // §2.5 — fallback=실측 참값이라 예측오차 ~0.001
   → estimateGain (검출/매칭 실패 → fallback 게인).  gain.zoomRef = startPtz.zoom
4. loop ≤ maxIterations:
     ptz ← panTiltCorrection(err, gain, ..., maxStepDeg)   // zoom 은 startPtz.zoom 고정(줌 불변이라 게인 스케일링 불요)
     prior = predictPlateCenter(직전 중심, 명령 delta, gain)  // §2.5 신원 유지
     재검출/매칭 실패 → {ok:false, reason:'plate_lost', ptz}  // 마지막 명령 PTZ 반환 = 복구 재료
     개선 정체(improvement < 1e-3) && dampCount < 3 → gain = dampGain(gain); dampCount++
       // r1 ★죽음의 나선 차단: 감쇠 상한 3회(게인 하한 = 실측치의 1/8).
       // 실측: 상한 없이는 매 반복 damp → 0.5^15 ≈ 3e-5 로 게인 소멸 → ptz 정지 → improvement=0 → 영구 damp (회복 불가)
     isCentered(err, centerTol) → {ok:true}
5. 루프 소진 → {ok:false, reason:'max_iterations'}
```

- **중심 정의**: `quadBoundingRect(quad)` 중심 = `plateCenterError` 입력. `quadCentroid`(산술평균)·`polygonCentroid`(면적가중)와 정의가 갈리지만, **번호판 OBB 는 중심대칭 사각형이라 세 정의가 일치**(geometry.ts:118 주석 명시). 기존 캘리브레이션 계약(controlMath 전체가 rect 기반)과 일관되게 boundingRect 중심을 쓴다.
- probe 는 성공/실패와 무관하게 이후 본 루프가 probe 위치가 아닌 **보정 목표 절대값**을 명령하므로 별도 복귀 이동이 불필요(기존 calibrateSlot 과 동일).

### 2.2 [함수 2] `zoomToPlateWidth` — 의사코드 (calibrateSlot B단계의 독립판)

```
1. captureAndDetect(startPtz, prior=plateRoi) → 없으면 {ok:false, reason:'no_plate'}
   gainRef = opts.gain ?? {fallbackPan, fallbackTilt, zoomRef:1}
2. width = quadBoundingRect(quad).w;  이미 isWidthConverged? → 즉시 ok:true
3. loop ≤ maxIterations:                                  // r1 ★가드 선행: "중심이 안전할 때만 확대"
     effGain = scaleGainForZoom(gainRef, ptz.zoom)         // §2.6 — zoom 20 에서 게인 ~1/12 로 스케일
     [가드] !isCentered(err, centerTol):
        ptz ← panTiltCorrection(err, effGain, ..., maxStepDeg); prior=predictPlateCenter(...)
        재검출/매칭 실패 → {ok:false, reason:'plate_lost'};  continue  // 이 반복은 zoom 을 올리지 않는다
     [줌] z1 = zoomCorrection(zoom, width, target, clampZoom)
        newZoom = clamp(z1, [zoom/maxZoomStepRatio, zoom·maxZoomStepRatio])   // r1 스텝비 클램프(대칭)
        [포화 판정] newZoom === zoom && width < target − widthTol → {ok:false, reason:'zoom_saturated'}
        ptz.zoom ← newZoom; prior = predictCenterAfterZoom(직전 중심, zoom, newZoom)  // §2.5/§2.6
        재검출/매칭 실패 → {ok:false, reason:'plate_lost'}
     isWidthConverged(width, target, widthTol) → {ok:true}
4. 루프 소진 → {ok:false, reason:'max_iterations'}
```

- **가드 선행의 근거(실측)**: C 실패 = errX=−0.073 인 채 zoom 1.69→7.49 → 오차 4.4배 확대로 화면 밖 소실. 가드를 줌보다 먼저 두면 base 조건(err≤0.17)에서 1~2 반복 내 centerTol 진입 후 확대가 시작된다 — **단독 호출 성공이 계약**이 된다(§2.3).
- **반복 예산 검증**: 재중심 ~2회 + 줌 스텝 log(7.4)/log(1.5)≈5회 + 중간 가드 여유 → 15회 상한 내(기본값 유지, 신규 수치 발명 없음).
- 가드 스텝은 여전히 반복당 1스텝(과보정 방지) — 단 "센터링될 때까지 줌 보류"가 r0 의 "줌 먼저, 가드 나중"을 대체한다.

### 2.3 결합의 물리적 현실을 계약에 드러내는 방식

zoom-in 은 FOV 를 좁힌다 → 번호판이 중심에서 벗어나 있으면 확대할수록 화면 가장자리로 밀려나 **소실**된다. "완전 분리" 요구와 이 물리를 다음 3장치로 양립시킨다:

1. **가드 선행(r1 — "중심이 안전할 때만 확대")**: `zoomToPlateWidth` 는 매 반복에서 중심 오차가 centerTol 초과면 **줌을 보류하고** 1스텝 재중심한다(§2.2). 이는 "센터링 기능 재실행"이 아니라 줌의 자기 보전 — 이 장치와 스텝비 클램프 덕에 **base 수준 오차(실측 err≤0.17)에서의 단독 호출 성공이 계약**이 된다. `plate_lost` 는 "정상"이 아니라 대상이 실제로 시야를 이탈했거나 검출이 끊긴 예외적 결과로 강등된다.
2. **게인 체이닝(옵셔널) + zoom 스케일링(r1)**: 가드의 재중심 게인은 `opts.gain`(centerOnPlate 실측) ?? fallback(−62/−35.5, zoomRef=1 — r2 정정). 어느 쪽이든 **매 반복 `scaleGainForZoom` 으로 현재 zoom 에 스케일**해서 쓴다(§2.6) — r0 는 zoom1.69 게인을 zoom20 에 그대로 적용해 12배 스케일 불일치로 실패(실측 B). zoom 함수 안에서 probe 를 다시 하지 않는다(스케일링이 probe 재실행을 대체 — 비용 0).
3. **실패 모드의 정직한 반환**: 실패 시에도 마지막 명령 PTZ 를 반환(복구 재료). 예외를 던지지 않는 이유: 검출 소실은 예외가 아니라 이 도메인의 결과 중 하나(기존 skipItem/UNKNOWN 강등 철학). JSDoc 의 "단독 호출 시 plate_lost 가능" 문구는 "대상이 초기 시야에 없거나 극단 오차인 경우"로 한정해 갱신한다.

전송 계층 오류(`CameraApiError`/`LpdApiError` — 타임아웃·5xx)는 **그대로 전파**한다(reason 으로 삼키지 않음). 검출 실패(빈 결과)와 인프라 장애는 다른 문제이고, 재시도는 이미 클라이언트(withRetry)가 소유한다.

### 2.4 명령 PTZ 추적 (★ 확립 패턴 준수)

시뮬 응답의 pan/tilt/zoom echo(0/0/1)는 신뢰 불가(PtzCalibrator.ts:44~47) → 모든 반복에서 `requestImage(camIdx, presetIdx, ptz)` 에 **명령값 override** 를 넘기고, 상태는 내가 명령한 값으로만 갱신한다. `move()` 는 쓰지 않는다 — `requestImage` 가 이동+캡처 원자라 별도 move 는 레이스만 만든다. *(r1: 라이브 전송 계층은 `RpcCameraClient`(Unity :13110 JSON-RPC `cam.setPTZ`/`cam.captureJPG`) — `ICameraClient` 주입이라 본 모듈 설계는 무영향.)*

### 2.5 (r1 신설) 대상 번호판 신원 추적 — prior 는 "예측 위치"로 매 스텝 갱신

**실측 사실**: cam1 프리셋1 에 번호판 6개(cx 간격 ≈0.15). r0 의 prior 는 화면 중심 고정(`plateRoi={0.5,0.5,0,0}`)이라 카메라가 움직이면 "지금 중심에 가장 가까운 번호판"이 **다른 차로 갈아탐**(진단 6스텝 중 5스텝 신원 전환). 폐루프가 매 프레임 다른 물체의 오차를 재니 개선 정체 → damp 연쇄 → 게인 지수 붕괴(A 실패의 근본 원인).

**결정 — 예측 prior 추적** (대안 비교):
| 대안 | 판정 | 근거 |
|---|---|---|
| (a) prior = 직전 관측 위치 | 기각 | 카메라 이동 시 **모든** 번호판이 함께 이동. maxStepDeg 5° → 변위 pan 0.137/tilt 0.238 (r2 참게인 −36.6/−21.0 역산) > 간격 절반 0.075 — 이웃이 직전 위치에 더 가까워지는 역전 발생(오매칭 재발) |
| (b) **prior = 직전 관측 + 명령 delta 로 예측한 위치** | **채택** | 예측 오차 = 게인 오차분만(probe 실측 게인 오차 ≤1% → 0.238×0.01≈0.002 ≪ 0.075; 보수적 30% 가정에도 0.07 — §2.7). 순수 함수 2줄로 구현 가능, 상태는 호출 스코프 지역(무상태 계약 유지) |
| (c) OBB 형상/텍스트 매칭 | 기각 | LPD 계약에 식별자 없음 — 과설계 |

- **초기 대상 선정만** `plateRoi` prior 로 `pickNearestPlate`(기존 함수 무변경). 이후 매 스텝:
  - pan/tilt 명령 후: `prior = predictPlateCenter(직전 중심, 명령 delta °, 현재 실효 게인)` — dX = dPan/gainPan (estimateGain 의 역산).
  - zoom 명령 후: `prior = predictCenterAfterZoom(직전 중심, zOld, zNew)` — 중심 기준 방사 확대, err' = err·zNew/zOld.
- **매칭 기각 반경 `matchRadiusNorm`(기본 0.08)**: 예측 prior 에서 최근접 후보까지 거리가 이를 초과하면 매칭 기각(=그 스텝 검출 실패 취급 → plate_lost 경로). 대상이 한 프레임 검출 누락됐을 때 이웃(0.15 거리)을 조용히 갈아타는 것을 차단. 근거: 실측 간격 0.15 의 절반 − 여유.
- probe 스텝의 예측은 게인이 아직 없으므로 **fallback 게인으로 예측**한다 — r2 정정 fallback(−62/−35.5)은 실측 참값 그 자체라 1° probe 변위(pan −0.027/tilt −0.048)를 오차 ~0.001 로 예측(§2.7). **주의: fallback 이 틀리면 예측 prior 가 틀린 게인을 자기확증할 수 있다(r1 실패 메커니즘) — 방어 판단은 §2.7.**

### 2.6 (r1 신설) 게인의 zoom 스케일링 — gain(z) = gain(zRef)·zRef/z

**실측 사실 (r2 정정)**: 게인[°/정규화] ∝ FOV ∝ 1/zoom. `diagSweep`(추적 휴리스틱 배제, 전체 검출 목록 공통변위) 실측 **gainPan=−36.6~−37.0, gainTilt=−21.0~−21.1 (zoom 1.69341 기준, 1°/2°/3° 스텝에서 완전 선형)** → zoomRef=1 환산 **−62.0/−35.5**. zoom 20 에서는 크기 ~1/12. (r1 의 gainPan≈+45 는 최근접 추적이 aliasing 에 오염된 허상 — 폐기.) r0 는 zoom 스케일링 자체를 무시해 B(체이닝 줌)가 스케일 불일치로 실패.

**모델 검증 (r2)**: `diagZoom` 실측 — pan/tilt 고정, zoom 2.0→10.0 스윕에서 중심오차 실측/예측 비 0.97~1.01, 예측오차 0.0013~0.0039 ≪ matchRadiusNorm 0.08. **`gain(z)=gain(zRef)·zRef/z` 및 `predictCenterAfterZoom`(방사 확대)은 실측으로 정당성 확정 — r2 무변경.**

**결정 — 수식 스케일링 채택** (줌 단계마다 재probe 기각: 반복당 캡처+검출 1회 추가 비용, 수식이 소각(小角) 영역에서 충분히 정확하며 폐루프가 잔차를 흡수). 모든 게인 값은 `PtzGain{gainPan, gainTilt, zoomRef}` 로 기준 zoom 과 함께 다니고, 사용 시점에 항상 스케일한다:

```ts
// controlMath.ts 말미 신규 (순수 함수 3종 — 기존 함수·기존 export 무변경, 추가만)
/** 게인 zoom 스케일: gain ∝ FOV ∝ 1/zoom. */
export function scaleGainForZoom(gain: PtzGain, zoom: number): { gainPan: number; gainTilt: number };
/** pan/tilt 명령 후 번호판 중심 예측: c' = c + dDeg/gain (|gain|<eps 방어 → c 유지). estimateGain 의 역산. */
export function predictPlateCenter(center: {cx,cy}, deltaDeg: {dPan,dTilt}, gain: {gainPan,gainTilt}): {cx,cy};
/** zoom 명령 후 번호판 중심 예측: 화면 중심 기준 방사 확대 c' = 0.5 + (c−0.5)·zNew/zOld. */
export function predictCenterAfterZoom(center: {cx,cy}, zoomFrom: number, zoomTo: number): {cx,cy};
```

- **배치 근거**: controlMath 는 "캘리브레이션 제어 수학 — 결정형 순수 모듈"(파일 헤더)의 소유자. platePtz(오케스트레이션)에 수식을 넣으면 소유권 규칙이 갈라진다. "기존 코드 변경 0줄" 제약은 개정(개정 이력 참조): **기존 함수·시그니처·동작 무변경, 파일 말미 순수 함수 추가만** — 기존 테스트 전량 green 이 회귀 방지 증명.
- `centerOnPlate` 내부는 zoom 불변이라 루프 중 스케일링 불요 — probe 실측 게인을 그대로 쓰고 `zoomRef=startPtz.zoom` 을 결과에 기록만 한다. `zoomToPlateWidth` 는 매 반복 스케일(§2.2).

### 2.7 (r2 신설) aliasing 자기확증 방어 — 판단: **④ 추가 장치 없음** (probe 1° + fallback 정정으로 충분)

**r1 라이브 실패 메커니즘(수치 확정)**: 틀린 fallback 부호(+75)가 만든 예측 prior 가 3° probe 의 큰 변위(0.082 > 간격 절반 0.075)와 결합 → base 공백(0.427~0.702)을 메우며 새로 등장한 엉뚱한 검출(0.488)이 오히려 예측(0.495)에서 0.007 로 참 위치보다 가까워 매칭 성공 → 허상 게인 +49.4 자기확증(구현 보고 +49.77 재현 일치) → 가드가 pan 을 역방향 +1.44° 로 밀어 오차 확대 → `plate_lost`. **오매칭 성패는 matchRadiusNorm 이 아니라 "예측 오차 vs 후보 간 중점 거리"가 결정한다.**

**④ 로 충분한 수치 근거** (probe 1°, 참 실효 게인 −36.6/−21.0 @z1.69, 실측 프레임 pan=23 기준):
- 정정 fallback(−62 → z1.69 실효 −36.7)의 probe 예측 오차 **≈0.001** vs 최근접 오답 후보까지 0.14 — 여유 ~90배.
- 오매칭이 성립하려면 예측이 참(0.401)과 이웃(하방 0.247/상방 0.540)의 중점을 넘어야 함 → **동부호 fallback 은 실효 |g| > 9.7 (참값의 27%)이면 안전**. 심지어 r1 의 부호 반대 fallback(+75 → 실효 +44.4)조차 1° 에선 예측 0.4495 가 참 위치(거리 0.049)를 오답 0.540(거리 0.090)보다 가깝게 잡아 **부호를 자가 회복**한다(3° 에는 없던 회복력 — 리더 실측 4항 재현).
- zoom 불변성: 변위·번호판 간격 모두 ∝ z(방사 확대) → 변위/간격 비 36% 는 시작 zoom 무관.
- 검출은 결정적(diagGuard 5/5 동일 목록) — "노이즈 대비 변위 부족" 우려는 실측상 없음.

**기각한 후보**: ① probe pan·tilt 분리 2회 — 실측상 축이 이미 분리(pan 스윕은 cx 만, tilt 스윕은 cy 만 이동)라 교차오염이 관측되지 않음. 캡처+검출 1회 비용만 추가(과설계). ② 더 좁은 매칭 반경 — r1 사례에서 오답(0.007)이 참(0.049)보다 예측에 **더 가까웠으므로** 반경 축소는 참 매칭부터 죽인다(역효과). ③ 게인 부호·크기 위생검사 — fallback 이 이제 실측 참값이라 예측 prior 에 같은 지식이 이미 내장(중복 방어). 회귀 방지는 코드 가드가 아니라 **§6 케이스 20(부호 검증 유닛)** 이 담당.

**maxStepDeg=5° 재검토 → 유지**: 본 루프의 예측 prior 는 probe **실측** 게인을 쓴다. 5° 변위 = pan 5/36.6=0.137 / **tilt 5/21.0=0.238(최악)**. 오매칭 조건(예측 오차 > 0.075) 역산 → **허용 게인 상대오차 = 0.075/0.238 ≈ 31%**. probe 실측 오차는 완전 선형·결정적 검출로 **≤1%**(스윕 −36.6/−36.6/−37.0, −21.0/−21.1) — 여유 ~30배. 축소 불요. (probe 실패로 fallback 구동 시에도 fallback=참값이라 동일 여유.)

## 3. 오픈루프 vs 폐루프 — **폐루프로 결정**

| 기준 | 오픈루프(FOV 모델, detectMath) | 폐루프(반복 검출, controlMath) |
|---|---|---|
| 정확도 전제 | fovBaseV 가 정확해야 함. 취득 실패 시 폴백 상수 강등 — **틀려도 모른 채 1샷 종료**. 과거 실측: fov 혼동 시 재중심 30% 미달·평균 154px 오프 | 게인을 probe 로 **부호 포함 실측** — FOV 지식 불요, 시뮬/실카메라 무관 |
| 비용 | 캡처 1회 | probe 1회 + 반복 3~7회(회당 settleMs 300ms + LPD ≈ 1s 내외) — 셋업타임 작업이라 허용 |
| 검증 가능성 | 결과 검증하려면 결국 재검출 필요 → 폐루프와 비용 수렴 | 수렴 판정이 관측값 그 자체 |
| 20% 폭 목표 | zoom→폭 순수 모델 필요(비선형·클램프) | `zoomCorrection` sqrt 감쇠 반복으로 모델 오차 흡수 |

**결정: 두 함수 모두 폐루프 기본. 오픈루프 초기샷 가속 옵션은 넣지 않는다**(요청에 없고, fovBaseV 의존을 이 모듈에 끌어들이는 순간 loadDetectCfg·ground 주입이 따라와 경계가 무거워짐). `detectMath` 는 이번 모듈이 import 하지 않는다.

## 4. "화면 가로의 20%" 정의 — **(a) 축정렬 boundingRect 폭으로 결정**

- **정의**: `quadBoundingRect(plate.quad).w === 0.20 ± 0.02` (정규화, 이미지 가로 대비).
- **근거**: ① 마스터 문구 "화면 가로의 20%"는 이미지 가로축 점유율을 뜻함 — 회전 OBB 의 장변 길이는 "화면 가로" 가 아니라 번호판 고유 길이라 문구와 다른 개념. ② 기존 시스템 전체가 이 정의(`SlotPtzItem.plateWidth`·`zoomCorrection` 입력·`targetPlateWidth=0.2` config·설계서 §2)로 통일되어 있어 갈라지면 조용한 불일치 발생. ③ 폐루프 관측값(LPD 재검출→boundingRect)과 동일 정의라 수렴 판정이 자기일관적. ④ 주차장 번호판 기울기는 대부분 소각(<15°) — 두 정의 차는 cosθ 수준(≤3.5%)으로 widthTol(0.02=목표의 10%) 안.
- **목표/오차**: target 0.20, tol ±0.02 — 기존 config 기본값 그대로(신규 수치 발명 안 함).
- **zoom 포화**: `camera.clampZoom`(1~36) 통과 후 zoom 이 더 못 오르는데 폭이 `target − widthTol` 미만이면 `zoom_saturated` 로 명시 실패(clamp 가 조용히 미달 수렴을 "성공"으로 위장하는 것 방지). 판정은 `newZoom === curZoom && width < target − tol` — zoomMax 값 자체를 알 필요 없음(clampZoom 캡슐화 유지).

## 5. 경계·의존성 (레이어)

```
src/calibrate/platePtz.ts       [신규 · I/O 오케스트레이션]
 ├─ import { plateCenterError, pickNearestPlate, estimateGain, panTiltCorrection,
 │           zoomCorrection, isCentered, isWidthConverged, dampGain,
 │           scaleGainForZoom, predictPlateCenter, predictCenterAfterZoom } from './controlMath.js'
 │           [순수 · 기존 8종 + r1 신규 3종(§2.6 — 파일 말미 추가만, 기존 함수 무변경)]
 ├─ import { quadBoundingRect } from '../domain/geometry.js'                                   [순수·기존]
 ├─ import type { ICameraClient } / { LpdClient, PlateBox } / { Ptz }                          [기존]
 └─ detectMath / detectPipeline / Repository / SetupBrain — import 하지 않음
```

- **순수 수학의 소유자는 controlMath 단일** — r1 신규 3종도 그곳에 추가한다(신규 순수 모듈 생성 금지). platePtz 에 남는 순수 계산은 포화 판정·스텝비 클램프·매칭 반경 판정 각 1줄 수준 — 별도로 뽑을 규모가 아님.
- 파일 위치는 `src/calibrate/` — 같은 도메인(번호판 PTZ 정렬)·같은 타입(`./types.js` 의 `Ptz`) 소비. 신규 디렉터리 불요.
- 라우트/MCP 도구 노출은 **하지 않는다**(요청은 "단독으로 쓰기 편한 함수"까지 — 호출면 추가는 요청 밖).
- **MCP 경계 판단**: 이 기능은 수치 반복 루프(P 제어·줌 보정) = **결정형 도구** 영역. LLM 자문(brain)은 의도적으로 배제 — 기존 PtzCalibrator 와 달리 이 모듈은 순수 결정형이다(모호 판단이 필요한 호출자가 바깥에서 감싸면 됨).

## 6. 유닛테스트 계획 — `test/platePtz.test.ts` (신규)

모킹 경계: `ptzCalibrator.test.ts:44~69 makeMockModel` 패턴 재사용 — **명령 PTZ 로만** 번호판 위치/폭을 만드는 camera+lpd 스텁(에코 0/0/1 반환 = ★패턴 재현), `sleep: async()=>{}` 주입. HTTP 없음.

| # | 케이스 | 픽스처/모델 | 검증 |
|---|---|---|---|
| 1 | centerOnPlate 수렴 | **공통 실측 모델**(하단 r2 정의 — 음수 게인) | ok=true, |errX|·|errY|≤0.03, **모든 명령의 zoom===startPtz.zoom**(pan/tilt 만 변경 보장), **자기보고 gainPan<0·gainTilt<0** |
| 2 | centerOnPlate 시작 무검출 | detect→[] | ok=false, reason='no_plate', iterations=0 |
| 3 | centerOnPlate 도중 소실 | N회째부터 [] | reason='plate_lost', ptz=마지막 명령값 |
| 4 | centerOnPlate probe 무변위 | probe 후 변위 0 | fallback 게인으로도 수렴(estimateGain 폴백 경로) |
| 5 | centerOnPlate 이미 중심 | cx=cy=0.5 | ok=true, iterations=0, **probe 캡처 미발생**(호출 수 검증) |
| 6 | zoomToPlateWidth 단독 수렴 | w=0.05·zoom, 중심 고정 | ok=true, width∈[0.18,0.22], zoom≈4, pan/tilt===startPtz(가드 미발동) |
| 7 | zoom 드리프트 가드 | zoom↑ 시 중심이 밀리는 모델(cx=0.5+0.02·(zoom−1)−pan·0.02) | 가드 1스텝 재중심 발동 후 수렴, opts.gain 전달 시 그 게인 사용 |
| 8 | zoom 포화 | w=0.004·zoom (zoom36→0.144<0.18) | ok=false, reason='zoom_saturated', ptz.zoom=36 |
| 9 | 반복 상한 | 게인 부호 반대 모델(발산) | reason='max_iterations', iterations=maxIterations |
| 10 | 독립성 | 6번을 centerOnPlate 없이 실행 / 1번을 zoom 없이 실행 | 상호 의존 없음(각 단독 green) |
| 11 | 다수 번호판 prior | 2개 검출, plateRoi 지정 | pickNearestPlate 로 지정측 초기 선정 |
| 12 | 전송 오류 전파 | detect가 LpdApiError throw | reason 강등 아닌 **reject 전파** |

**r1 추가 — 라이브 실패 모드를 모킹으로 재현. r2 ★공통 모킹 모델을 실측 물리로 고정** — r1 구현의 모킹 모델(+50/−25)은 pan 부호가 물리와 반대라 **부호 오류가 유닛 green 인 채 라이브에서 터졌다**(이번 실패의 정확한 재현 경로). 공통 모델 정의:
- 번호판 6개, base(pan22/tilt6.8/z1.69341) cx 목록 = 실측 `0.116 0.274 0.427 0.702 0.812 0.928`(간격 ≈0.15), 대상 cx=0.427.
- **게인 zoom 종속·음수**: `cx' = cx + dPan·z/(−62)`, `cy' = cy + dTilt·z/(−35.5)` (@z1.69 실효 −36.6/−21.0), zoom 변경 시 방사 확대(중심 기준 ×zNew/zOld).
- **aliasing 미끼**: pan 이동으로 base 공백(0.427~0.702)이 화면에 들어오면 신규 검출 1개가 공백 위치에 등장(실측 pan=23 의 0.540, pan=25 의 0.488 재현).
- base err=(−0.073, 0.171), w=0.0274·(z/1.69341).

| # | 케이스 | 픽스처/모델 | 검증 |
|---|---|---|---|
| # | 케이스 | 픽스처/모델 | 검증 |
|---|---|---|---|
| 13 | **신원 전환 재현·차단** | 공통 모델(전원 함께 이동 + 미끼 검출) | centerOnPlate 가 **초기 선정 번호판(0.427)을 끝까지 추적**해 수렴(최종 plate 신원 동일), iterations < 8 |
| 14 | **damp 죽음의 나선 차단** | 개선이 계속 정체하는 모델(대상 고정·오차 불변) | 최종 gain 크기 ≥ 초기의 1/8 (damp ≤ 3회), 게인 0 수렴 없음 |
| 15 | **zoom 단독 성공(=실측 C 재현)** | 공통 모델, z0=1.69341 (변위/° = z/(−62), r2 정정) | zoomToPlateWidth **단독** ok=true, width∈[0.18,0.22], plate_lost 미발생 |
| 16 | **게인 zoom 스케일 체이닝(=실측 B 재현)** | opts.gain={−36.6, −21, zoomRef:1.69341}(r2 정정), zoom 10 에서 가드 발동 모델 | 가드 명령 크기·**방향**이 scaleGainForZoom 결과(≈×1.69/10, 음수 유지)와 일치 |
| 17 | 매칭 기각 반경 | 대상이 1프레임 검출 누락, 이웃(0.15 거리)만 검출 | 이웃 갈아타기 없이 plate_lost (신원 절도 차단) |
| 18 | 줌 스텝비 클램프 | w 목표까지 7.4배 증배 필요 모델 | 모든 zoom 명령의 인접비 ≤ 1.5, 포화·plate_lost 없이 수렴 |
| 19 | 신규 순수 함수 3종 | scaleGainForZoom/predictPlateCenter/predictCenterAfterZoom 수치표 + |gain|<eps 방어 | 실측 수치 역산 일치(r2 정정 예: gain(1.69→20) = −62×1/20 = **−3.1** — 부호 보존 검증 포함) |
| 20 | **(r2 신설) probe 부호 자기확증 차단 — r1 라이브 실패의 유닛 재현** | 공통 모델 + 미끼 검출(pan 이동 시 공백 위치 신규 등장), probe 1° | estimateGain 결과 **부호 음수, 실효 크기 −36.6±15% (@z1.69)**. 허상 +49 산출 시 red — **probe 3° 재도입 또는 fallback 부호 반전(+) 회귀 시 이 케이스가 깨지도록** 미끼 배치를 실측(0.540/0.488) 그대로 재현 |

기존 1~12(구현 14케이스)는 유지하되 `gain` 타입(`PtzGain` — zoomRef 추가)·§2.2 루프 순서·**r2 정정값(fallback −62/−35.5, probe 1°, 공통 모델 음수 게인)** 에 맞춰 기대값만 갱신. r1 구현의 기대값 중 오염 실측(+75/+49) 유래는 전부 폐기.

성공 기준: 신규 포함 전 케이스 green + **기존 스위트 전량 green**(`npm test` — controlMath 기존 테스트 무수정 green 이 "추가만" 제약의 증명) + `npm run typecheck` 무오류.

## 7. 경험적 검증(goal/loop) 계획 (r1 전면 정정 — 시뮬 :13100 폐기)

**환경(확정)**: **Unity :13110 JSON-RPC**(`cam.setPTZ`/`cam.captureJPG`/`cam.getPTZ`, 클라이언트 `RpcCameraClient`) + 실 LPD :9082. 검증 스크립트는 `_workspace/plate-ptz/_live/platePtzLive.mts`(기존) 재사용. 대상: **cam1 프리셋1 `{pan:22, tilt:6.8, zoom:1.69341}`** — 차량 7대·번호판 6개 검출 확인(신뢰도 0.87~0.93, 폭 0.024~0.037).

**Goal(관찰 가능 수치 — r1 에서 ③이 "기록"→"성공 요건"으로 승격, r2 에서 ④ 신설)**:
① `centerOnPlate` 후 **독립 재관측**(결과 PTZ 로 새 캡처→LPD) 중심오차 |errX|,|errY| ≤ 0.03 (게인 붕괴 부재 확인)
② ①의 결과 PTZ+gain 체이닝으로 `zoomToPlateWidth` → 재검출 폭 ∈ [0.18, 0.22]
③ `zoomToPlateWidth` **단독**(base 에서, 센터링 생략) → ok=true, 폭 ∈ [0.18, 0.22] (§2.3 계약)
④ **(r2 신설 — 명시 관측 항목)** 자기보고 gain 의 **부호·크기가 실측과 일치: gainPan ∈ −36.6±20%, gainTilt ∈ −21.0±20% (@z1.69 실효 환산)**. r1 의 "자릿수 정합" 수준 관측은 부호 반전(+49.77)을 통과시켰음 — 수치 대역으로 강화.

**Loop**: 수치 미달 시 반복 로그(iterations, gain 궤적, err 궤적, 매 스텝 매칭 거리)와 전/후 스샷으로 원인 분석 → 재설계/재구현. 특히 **매 스텝 "추적 중인 번호판의 cx 궤적"을 로그로 남겨 신원 유지 자체를 관찰**한다. **(r2) 독립 재관측·게인 검증에 최근접 휴리스틱을 쓰지 말 것 — `_live/diagSweep.mts` 의 전체목록 공통변위 기법을 쓴다**(r1 검증 하네스의 "중심 최근접" 관측이 aliasing 에 오염돼 A 의 PASS 자체가 허위였음).

## 8. 영향도

| 대상 | 영향 |
|---|---|
| `controlMath` | **r1: 파일 말미 순수 함수 3종 추가만**(scaleGainForZoom/predictPlateCenter/predictCenterAfterZoom). 기존 함수·시그니처·동작·export 무변경 — 기존 테스트 무수정 green 필수 |
| `PtzCalibrator` / `detectMath` / `geometry` / 클라이언트 | **변경 0줄** — import 만 당함. 기존 동작·테스트 불변 |
| 라우트/config/스키마 | 무접촉. r2: `PlatePtzOpts` 의 fallback 게인(−62/−35.5)·probeStepDeg(1°)는 **config 기본과 의도적으로 다른 실측 정합값** — PlatePtz 전용 기본이며 스키마 확장 없음 |
| 신규 파일 | `src/calibrate/platePtz.ts`, `test/platePtz.test.ts` 2개뿐 |
| 후속 과제(이번 범위 아님) | ① `PtzCalibrator.calibrateSlot` 의 `PlatePtz` 위임 리팩토링(잡 상태·LLM 자문·skipItem 결박 해체는 별도 작업). ② **r2 확장 — config 기본 `fallbackGainPanDeg` +20·`fallbackGainTiltDeg` +15 는 둘 다 실측 부호(−36.6/−21.0 @z1.69)와 반대**: PtzCalibrator 경로도 동일 결함(probe 실패 시 발산 + 예측 없는 최근접 매칭)을 잠재 보유하나 이번 범위에서 무접촉(변경 시 기존 테스트·동작 영향) — 리더에게 보고만 |

## 9. 가정·미해결 (명시)

1. **[가정] `startPtz` 필수**: "현재 PTZ" 조회 수단이 없으므로(에코 신뢰 불가) 시작 명령 PTZ 는 호출자 책임. 프리셋 기본이 필요하면 `resolvePresetPtz` 사용 — 이 모듈이 대신 조회하지 않는다.
2. **[가정] 예외 정책**: 검출 소실=결과(`ok:false`), 전송 장애=예외 전파. 기존 철학(UNKNOWN 강등 + withRetry 소유권)에서 유도.
3. **[가정] LLM 자문 배제**: 요청 범위 밖 + 결정형 도구 영역. 필요 시 호출자가 감싼다.
4. **[미해결·검증에서 확인] zoom→폭 실측 곡선**: `zoomCorrection` sqrt 감쇠 + r1 스텝비 클램프(1.5)가 15회 내 수렴하는지 라이브 루프(§7)에서 확인. 미수렴 시 클램프비/반복 상한 재조정.
5. ~~[미해결] 검증용 차량 배치~~ → **r1 해소**: cam1 프리셋1 `{22, 6.8, 1.69341}` 에서 번호판 6개 검출 확정(§7).
6. **[r1 가정] 게인 zoom 모델 gain(z)=gain(zRef)·zRef/z**: 핀홀·소각 근사(FOV∝1/zoom). Unity 시뮬 카메라가 이 모델을 따른다고 가정 — §7 ②③에서 zoom 7~13 구간의 가드 명령이 과/부족 보정 없이 수렴하는지로 검증. 편차 관찰 시 zoom 중간 재probe 1회 추가를 후보로(현 설계에는 미포함 — 과설계 금지).
7. **[r2 정정] 신원 추적의 예측 정확도**: 예측 오차 상한 ≈ 게인 상대오차 × 스텝 변위 — probe 실측 오차 ≤1% × 최악 변위 0.238(tilt 5°) ≈ 0.002, 보수적 30% 가정에도 0.07 < 간격 절반 0.075(§2.7 수치). 번호판 간격이 0.15 보다 촘촘한 씬에서는 matchRadiusNorm 하향이 필요할 수 있음(opts 로 조정 가능 — 기본값 변경은 그때 판단).
8. **[r2 교훈·전제] 라이브 게인 관측은 반드시 전체목록 공통변위로**: 최근접·중심근접 휴리스틱 단독 관측은 간격 0.15 씬에서 aliasing 에 구조적으로 취약(r1 의 실측·검증 양쪽이 이것에 당함). 본 설계의 모든 수치 전제는 `diagSweep`(비오염) 실측이다.

## 구현자(developer)에게

- 산출: `src/calibrate/platePtz.ts` + `test/platePtz.test.ts`. §2 계약·§2.1/2.2 의사코드 준수. **controlMath 재사용 — 제어 수식 재작성 금지.** ESM `.js` 확장자 import, strict.
- **r1 변경분**: ① controlMath 말미에 순수 함수 3종 추가(§2.6 — 기존 코드 라인 무접촉) ② platePtz: `PtzGain`(zoomRef) 타입, 예측 prior 추적+매칭 반경(§2.5), damp 상한 3회(§2.1), zoom 루프 가드 선행+스텝비 클램프+게인 스케일링(§2.2) ③ 기존 테스트 1~12 기대값 갱신 + 신규 13~19(§6).
- **r2 변경분(최소 — 구조 무변경, 상수 2건 + 테스트 모델)**: ① 기본값 정정 `probeStepDeg 3→1`, `fallbackGainPanDeg +75→−62`, `fallbackGainTiltDeg −35→−35.5` ② §6 공통 모킹 모델을 실측 물리로 교체(음수 게인 −62/z·−35.5/z, 실측 cx 목록, 미끼 검출) + 케이스 20 신설 + 오염 실측(+75/+49) 유래 기대값 폐기 ③ 로직(예측 prior·매칭 반경·damp·가드·클램프·스케일링)은 **손대지 않는다** — r1 구조는 정당하고 상수만 틀렸다.
- 완료 게이트: `npm test` 전량 green(신규 포함, **controlMath 기존 테스트 무수정 green**) + `npm run typecheck` + §7 라이브 ①②③④ 수치 충족(④ 게인 부호·크기 실측 일치 — r2).
- 워크트리(`ParkAgent-plate-ptz`) 안에서만 쓰기. 메인 리포 금지.

## 문서화(documenter)에게

- 영향 범위: 신규 2파일 + 본 계획. 기존 모듈 변경 없음이 핵심 메시지. 문서 파일명 `yyyyMMdd_hhmmss_번호판센터링줌모듈.md`.
