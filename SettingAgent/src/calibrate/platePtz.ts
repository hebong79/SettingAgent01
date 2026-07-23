// 번호판 센터링·줌 독립 함수 모듈(설계서 01_architect_plan §2).
// PtzCalibrator.calibrateSlot 의 A단계(pan/tilt 센터링)·B단계(zoom 폭 정렬) 폐루프를
// 잡 상태머신·Repository·writer·LLM 자문 결박에서 풀어 **단독 호출 가능한 2개 메서드**로 재조립한다.
//
// 제어 수식은 controlMath.ts 소유 — 이 파일은 오케스트레이션(캡처·검출·상태 추적)만 한다.
// 좌표는 정규화(0~1), pan/tilt 는 도(°), zoom 은 배율(clampZoom 소유).
//
// r1(라이브 실패 반영): ① 예측 prior 로 대상 신원 추적(§2.5) ② 게인 zoom 스케일링(§2.6)
//                      ③ damp 상한 3회(§2.1) ④ zoom 루프 가드 선행 + 줌 스텝비 클램프(§2.2).
// r2(라이브 재실패 반영): **로직 무변경 — 상수만 정정**(§2.0/§2.7). r1 의 게인 근거였던 실측이
//   최근접 추적 aliasing 에 오염된 허상이었다(diagSweep 전체목록 공통변위 참값: gainPan −36.6~−37.0 /
//   gainTilt −21.0~−21.1 @z1.69341 → zoomRef=1 환산 −62.0/−35.5, 1°/2°/3° 완전 선형).
//   ① probeStepDeg 3→1 ② fallbackGainPanDeg +75→−62(★부호) ③ fallbackGainTiltDeg −35→−35.5.

import { createHash } from 'node:crypto';
import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../clients/LpdClient.js';
import type { NormalizedPoint, NormalizedRect } from '../domain/types.js';
import { logger } from '../util/logger.js';
import { quadBoundingRect } from '../domain/geometry.js';
import { pickOwnedPlate } from './plateDiscovery.js';
import {
  plateCenterError,
  pickNearestPlate,
  estimateGain,
  panTiltCorrection,
  zoomCorrection,
  isCentered,
  isWidthConverged,
  dampGain,
  scaleGainForZoom,
  predictPlateCenter,
  predictCenterAfterZoom,
  aimPtzForPoint,
  zoomForWidth,
} from './controlMath.js';
import type { Ptz } from './types.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PlatePtzDeps {
  camera: ICameraClient;
  lpd: LpdClient;
  sleep?: (ms: number) => Promise<void>;
  /** 매 캡처 직후 방금 찍은 JPEG 을 흘려보내는 관찰용 훅(가산·옵셔널 — 새 requestImage 없음). */
  onFrame?: (jpeg: Buffer, camIdx: number, presetIdx: number) => void;
}

/** 게인은 항상 측정 기준 zoom(zoomRef)과 함께 다닌다 — 실효 게인 = gain·zoomRef/현재zoom(설계 §2.6). */
export interface PtzGain {
  gainPan: number;
  gainTilt: number;
  zoomRef: number;
}

/** 전부 옵셔널. 기본값은 PlatePtz 전용 실측 정합값 — config 스키마 확장 없음(설계 §8). */
export interface PlatePtzOpts {
  centerTol?: number;
  targetPlateWidth?: number;
  widthTol?: number;
  maxIterations?: number;
  /**
   * probe 1스텝(°). 기본 1.0 — 1° 변위 0.027 은 번호판 간격 절반(0.075)의 36%(안전)이고,
   * 검출이 결정적(지터 0)이라 게인 산출에 충분히 크다. 3° 변위 0.082 는 간격 절반을 넘어
   * 예측이 틀린 순간 이웃/미끼 검출과 오매칭된다(r1 라이브 실패 — §2.7).
   */
  probeStepDeg?: number;
  maxStepDeg?: number;
  /**
   * zoomRef=1 기준 fallback 게인. 기본 −62/−35.5(실측 −36.6/−21.0 @z1.69341 환산 — 둘 다 ★음수).
   * ★ 이 기본값은 **cam1 시뮬 카메라 실측**에서 유도된 상수다 — 다른 카메라에서 타당하다는 근거는 없다.
   * `zoomToPlateWidth` 를 `gain` 없이 단독 호출하면 이 값이 **무측정 1차 게인**이 된다(gain 필드 주석 참조).
   */
  fallbackGainPanDeg?: number;
  fallbackGainTiltDeg?: number;
  settleMs?: number;
  /** **초기 대상 선정 prior 전용**(이후는 §2.5 예측 추적). 기본 {0.5,0.5,0,0} = 화면 중앙 최근접. */
  plateRoi?: NormalizedRect;
  /**
   * (zoom 전용) 드리프트 가드 재중심 게인. centerOnPlate 결과의 gain 체이닝용(설계 §2.3).
   * ★ 미전달 시 가드 게인은 `fallbackGain*` 로 폴백하며, `zoomToPlateWidth` 는 probe 를 하지 않으므로
   *   **측정 기회가 0 이다**(설계 §2.2 — 스케일링이 probe 재실행을 대체). 즉 이 필드의 부재는
   *   "probe 실패 시 안전판"이 아니라 **무측정 1차 의존**을 뜻한다.
   */
  gain?: PtzGain;
  /** 예측 prior 로부터 이 거리 초과 매칭은 기각(대상 소실 취급). 기본 0.08 = 실측 번호판 간격 0.15 의 절반 근사. */
  matchRadiusNorm?: number;
  /**
   * **최초 대상 선정 전용** 반경 게이트(정규화). `plateRoi` prior 로부터 이 거리를 넘는 후보는
   * "대신 채택"하지 않고 기각한다(`no_plate_near_click`). `matchRadiusNorm`(추적용)과 **별개 파라미터**다 —
   * 기준점이 예측 중심이 아니라 **조작자의 클릭 좌표**라 흡수해야 할 오차원이 다르기 때문.
   *
   * ★ 기본 undefined = **게이트 없음 = 기존 동작**. 배치(calibrateSlot)는 plateRoi 를 주지 않아 prior 가
   *   화면중앙이고 acquire zoom 에서 판이 중앙에서 크게 벗어날 수 있어, 무조건 게이트를 걸면 대량 미검이 된다.
   *
   * ★ 사다리(`centerAndZoomByLadder`)에서는 이 값이 **조준(원본) 프레임 기준**으로 해석된다 —
   *   latch 전 각 rung 은 누적배율 k 로 스케일한 `initialRadiusNorm × k` 를 실제 게이트로 쓴다.
   *   `centerOnPlate` 는 확대 없이 1회 선정이라 k=1 = 이 값 그대로다(동작 불변).
   *   → 클릭 경로만 명시 주입한다(권고 0.10 — 클릭정밀도 0.02 + 차체↔판 오프셋 0.08 = worst 0.10 이상이면서
   *   이웃 판 최소 간격 0.11 미만인 구간. 0.11 이상은 이웃 오채택이 되살아나 게이트가 무의미해진다).
   */
  initialRadiusNorm?: number;
  /** 1스텝 zoom 증배 상한(대칭: [z/r, z·r]). 기본 1.5 — 큰 점프는 중심 오차를 같은 배율로 확대해 대상을 날린다. */
  maxZoomStepRatio?: number;
  /**
   * (사다리 전용) **latch 이전** 눈먼 줌인 배율. 기본 2.0(LADDER_PRELATCH_RATIO — 근거는 그 상수 주석).
   * 아직 추적 대상이 없는 구간이라 `maxZoomStepRatio` 의 "대상을 날린다" 근거가 성립하지 않는다.
   */
  preLatchZoomStepRatio?: number;
  /**
   * (소유권 선정 전용) 같은 프리셋 타 슬롯 판중심 − 자기 판중심(원본 정규화 프레임 상대 오프셋, 설계 §A-1).
   * pan/tilt 강체평행이동 불변이라 현재 프레임에서 자기중심 prior 에 더하면 peer 앵커가 된다.
   * 미전달 → 기존 화면중앙 최근접(`pickNearestPlate`, 하위호환). 전달 시 자기 Voronoi 셀 소유 후보만 선정.
   */
  peerOffsets?: NormalizedPoint[];
  /**
   * (사다리 전용) rung 상한. **기본 undefined = 시작 zoom·maxZoomStepRatio·clampZoom 상한에서 자동 산출**.
   * 실질 종료 조건은 `clampZoom` 포화이고 rung 수는 그 위임을 방해하지 않아야 한다 —
   * ★ 고정 상수(구 기본 8)는 이 위임을 배신했다: 근거였던 1.5 와 달리 실사용 `config/tools.config.json`
   *   의 `maxZoomStepRatio` 는 **1.3** 이라 1.3^9 ≈ 10.6 에서 사다리가 포기하고,
   *   zoom 상한 36 이 3.4배 남았는데도 "최대 줌에서 못 찾음"이라는 **오보**를 냈다(이번 작업의 표적인
   *   먼 차량이 정확히 그 지점에서 잘린다). 자동 산출은 비율이 무엇이든 상한 도달을 보장한다.
   * ★ `cfg.acquireLadderMaxSteps`(배치의 **줌아웃** 사다리, 기본 5)와 **다른 파라미터** — 혼용 금지.
   */
  ladderMaxRungs?: number;
  /**
   * (사다리 전용) 네이티브 setcenter 후 정착 대기(ms). 기본 1000.
   * 근거: `RealPtzSource.centerOnPoint` 는 `move` 와 달리 `waitUntilSettled` 를 호출하지 않는다 →
   * setcenter 직후의 PTZ 조회값이 슬루 중 값일 수 있고, 그 값을 다음 rung 의 requestImage 로 명령하면
   * 카메라가 엉뚱한 곳으로 간다. speed=50 으로 큰 pan 을 도는 시간을 보수적으로 잡은 값(★라이브 미측정 — 튜닝 대상).
   */
  nativeAimSettleMs?: number;
  /**
   * (재포착) 추적 캡처가 미검일 때 프레이밍을 바꾸기 위한 **1배수 화면 변위**(정규화). 기본 0.0014(1080p 기준 ≈1.5px).
   *
   * ★ 단위가 각도가 아니라 **정규화 변위**인 이유(이터2 — 리더 실측): 검출기 불안정은 **픽셀 공간** 현상이다.
   *   고정 각도(°)는 화면 변위가 zoom 에 반비례해 최대 36배까지 달라져(0.03° = base zoom 1.69 에서 1.5px,
   *   zoom 36 에서 32px) 같은 노브가 zoom 마다 전혀 다른 일을 한다. 변위로 고정하면 어느 zoom 에서든
   *   같은 픽셀만큼 흔든다. 실제 tilt 각은 `변위 × |fallbackGainTiltDeg| / zoom` 로 환산한다.
   * ★ 같은 PTZ 로 다시 찍는 것은 무의미하다 — LPD 는 **같은 프레임에 대해 결정적**이고(리더 실측: 3회 반복 동일),
   *   결과를 바꾸는 것은 재캡처가 아니라 **재프레이밍**이다.
   * 축이 tilt 단독인 이유: 리더 실측 변동이 전부 세로 방향이다(pan ±0.06° 는 회복 실패, zoom 변경도 실패).
   */
  plateRecaptureDitherNorm?: number;
  /**
   * (재포착) 미세 디더 재캡처 최대 횟수. ★ 기본 0 = 재포착 없음 = **기존 동작**(1회 미검 → 즉시 plate_lost).
   * 기본을 0 으로 둔 이유: 재시도가 0바퀴면 캡처 횟수·반환 PTZ·reason 이 수정 전과 완전히 동일해
   * 기존 테스트·배치 경로에 **구조적으로** 회귀가 없다(켜면 미검 픽스처에서 캡처 횟수·실패 PTZ 가 달라진다).
   * 개별(클릭) 경로에서만 PtzCalibrator 가 명시 주입한다(권장 6 = 에스컬레이팅 사다리 전체).
   */
  plateRecaptureRetries?: number;
  /**
   * (재포착·zoom 축) **줌 스텝 직후 캡처** 전용 1배수 승법 디더 비율. 기본 0.01(=±1%).
   * 배수 사다리와 곱해져 `×[1.01, 0.99, 1.02, 0.98, 1.04, 0.96]` 이 된다.
   *
   * ★ 이 지점만 축이 다른 이유(이터3 — 리더 실측): 줌 스텝 직후 프레임은 **배율 자체가 바뀐 새 프레임**이라
   *   회복 축도 zoom 이어야 한다. 실측(같은 pan/tilt, zoom 만 변경)에서 LPD 는 **좁고 산발적인 데드존**을 보였다:
   *   7.8 ✗ / 8.0 ✗ / 8.1738 ✗ / **8.25 ✓** / 8.4 ✓ / 8.6 ✗ / 9.0 ✓ — 그 프레임에서 tilt 디더 7시도는 전부 실패했고
   *   **+1%(8.1738→8.25)로 회복**됐다. pan/tilt 이동 지점(A·B)은 tilt 디더가 실측으로 효과가 확인됐으므로 그대로 둔다.
   */
  plateRecaptureZoomStep?: number;
}

export type PlatePtzFailReason =
  | 'no_plate'
  | 'plate_lost'
  | 'max_iterations'
  | 'zoom_saturated'
  // ↓ 사다리·반경게이트 추가분(기존 4건 문자열 무변경 — UI/DB 회귀 0).
  /** 검출은 있으나 전부 클릭점 반경(initialRadiusNorm) 밖 → 다른 판을 대신 채택하지 않고 실패(위장 성공 금지). */
  | 'no_plate_near_click'
  /** 조준은 됐으나 사다리 전 구간 미검출 + 줌 상한 도달(LPD 한계 — 가림·각도·오염). */
  | 'plate_not_found_at_max_zoom'
  /** 네이티브 setcenter / move 가 거절 또는 예외(장비 통신·권한). */
  | 'aim_failed'
  /**
   * (수정 20) 목표 폭을 **사이에 두고** 괄호가 장비 zoom 해상도까지 좁혀졌으나 `widthTol` 안에 못 들어감.
   * 줌으로 더 가까이 갈 방법이 없다는 뜻이며, `zoom_saturated`(장비 배율 상한)와는 원인이 다르다.
   */
  | 'zoom_resolution_limit';

export interface PlatePtzResult {
  ok: boolean;
  /** 최종 "명령" PTZ (★ 응답 echo 아님 — 설계 §2.4). 실패 시 복구 재료. */
  ptz: Ptz;
  plate: PlateBox | null;
  err: { errX: number; errY: number } | null;
  /** 마지막 boundingRect 폭(정규화). */
  plateWidth: number | null;
  /** 실측/사용 게인(+측정 시점 zoomRef) — zoomToPlateWidth 에 체이닝용. */
  gain: PtzGain;
  iterations: number;
  reason?: PlatePtzFailReason;
  /**
   * (수정 13) **장비 zoom 상한에서 목표 폭에 미달한 채 종료**했는가.
   * ok:true 와 함께 올 수 있다 — "장비가 할 수 있는 일을 전부 했다"는 뜻이지 목표 달성이 아니다.
   * 성공/실패와 무관하게 이 사실은 결과에서 삭제하지 않는다(정직성).
   */
  widthShortfall?: boolean;
  /** (수정 17) 장비 줌 상한에서 정렬을 만들기 위해 시도한 **마지막 재중심 횟수**(0 = 불요). */
  recenterAttempts?: number;
  /** (수정 18) 종료 시 **최선 폭 지점으로 되돌아갔는가**(진동·악화 종료 방지). */
  restoredToBest?: boolean;
  /**
   * (수정 21) `ok:true` 인데 **중심 정렬이 centerTol 밖**으로 남았는가.
   * 폭은 수렴했고 신원은 게이트가 보장했으므로 성공이지만, "정렬이 이만큼 남았다"를 지우지 않는다
   * (`widthShortfall` 과 같은 정직성 관용구). 최종 오차는 `err` 에 실려 있다.
   */
  centerShortfall?: boolean;
  /**
   * (재포착) 이번 호출에서 **미세 디더로 추가 캡처한 총 횟수**(0 이면 필드 자체를 싣지 않는다).
   * 성공·실패 양쪽에 실린다 — 성공이면 "몇 번 흔들어서 되찾았나", 실패면 "몇 번 흔들어도 안 나왔나"
   * (`widthShortfall`/`centerShortfall` 과 같은 정직성 관용구).
   */
  recaptureDithers?: number;
}

interface ResolvedOpts {
  centerTol: number;
  targetPlateWidth: number;
  widthTol: number;
  maxIterations: number;
  probeStepDeg: number;
  maxStepDeg: number;
  fallbackGainPanDeg: number;
  fallbackGainTiltDeg: number;
  settleMs: number;
  plateRoi: NormalizedRect;
  matchRadiusNorm: number;
  maxZoomStepRatio: number;
  preLatchZoomStepRatio: number;
  /** ★ 기본값 부여 금지 — undefined 가 "clampZoom 상한까지 자동 산출"이라는 의미를 갖는다(ladderRungBudget). */
  ladderMaxRungs?: number;
  nativeAimSettleMs: number;
  /** 재포착 1배수 화면 변위(정규화)·재시도 횟수. 0 = 재포착 없음(기존 동작)이라 undefined 에 의미를 줄 필요가 없다. */
  plateRecaptureDitherNorm: number;
  plateRecaptureRetries: number;
  /** 재포착 zoom 승법 디더 1배수 비율(줌 스텝 직후 캡처 전용). */
  plateRecaptureZoomStep: number;
  /** ★ 기본값 부여 금지 — undefined 가 "게이트 없음"(기존 동작)이라는 의미를 갖는다. */
  initialRadiusNorm?: number;
  gain?: PtzGain;
  peerOffsets?: NormalizedPoint[];
}

/** 개선 정체 판정 임계(PtzCalibrator.ts 와 동일 값 — 그쪽은 module-private 라 import 불가). */
const IMPROVE_EPS = 1e-3;
/**
 * 게인 감쇠 누적 상한(설계 §2.1). 상한이 없으면 개선 정체가 이어질 때 매 반복 damp →
 * 0.5^15 ≈ 3e-5 로 게인이 소멸 → PTZ 정지 → improvement=0 → 영구 damp(회복 불가, 실측 A 실패).
 */
const DAMP_LIMIT = 3;

/**
 * (사다리 전용) zoom 포화 판정 임계. zoom 은 1~36 배율이라 1e-6 은 유효자릿수 훨씬 아래 =
 * "clampZoom 이 더 못 올린다"만 잡고 정상 스텝(최소 ×1.5)은 절대 오판하지 않는다.
 */
const ZOOM_EPS = 1e-6;

/**
 * (사다리 전용) 기하 폴백 조준의 1스텝 상한(°). cfg.maxStepDeg(=5)는 **폐루프 미세보정용**이라 재사용 금지 —
 * 게인 −62@zoom1 에서 클릭 오차 0.3 은 18.6° 를 요구하는데 5° 로 잘리면 조준이 성립하지 않는다.
 * 사다리의 재중심은 P 제어 반복이 아니라 **개방루프 1샷**이라 진동 방지 클램프가 필요 없고,
 * PtzCalibrator 의 pre-aim 상한(PREAIM_MAX_STEP=90)과 같은 성격이라 같은 값을 쓴다(이상 게인 방어 상한).
 */
const LADDER_AIM_MAX_STEP = 90;

/**
 * (사다리 전용) 자동 산출 rung 예산에 얹는 여유 칸수. 등반 칸수 위에 얹는 이유는 latch 이후의 rung 이
 * 항상 ×ratio 로 오르지는 않기 때문이다(직행 목표 zWant 가 더 낮으면 스텝이 작아지고, 재중심만 하고
 * 넘어가는 칸도 있다). 4 는 목표 폭 부근에서의 미세 수렴 칸을 덮는 관측형 여유값이다.
 */
const LADDER_RUNG_SLACK = 4;

/**
 * (사다리 전용) **latch 이전** 눈먼 줌인의 1스텝 배율. 기본 2.0.
 *
 * ★ 되돌리기 전에 읽을 것 — `maxZoomStepRatio`(1.3)를 여기에 쓰지 않는 이유:
 * 1.3 의 존재 근거는 이 파일 상단 주석 그대로 "큰 점프는 중심 오차를 같은 배율로 확대해 대상을 날린다" 인데,
 * 그 근거는 **추적 중인 대상이 있을 때만** 성립한다. latch 이전에는 날릴 대상이 아직 검출되지도 않았다.
 *
 * ① **누적 드리프트는 칸수가 아니라 총 배율이 결정한다.** 이 파일의 줌 모델(`predictCenterAfterZoom`:
 *    c' = 0.5 + (c−0.5)·zTo/zFrom)은 곱셈 합성이라 경로에 무관하다 → e_final = e_0 × z_final/z_0.
 *    같은 zoom 36 에 도달하는 한 1.3 으로 14칸을 가든 2.0 으로 6칸을 가든 **최종 잔차는 동일**하다.
 *    (latch 이전에는 rung 간 재중심이 아예 없으므로 이 등식이 근사가 아니라 정확하다.)
 * ② 큰 스텝의 실제 대가는 "최초 검출 가능 zoom 을 지나쳐 필요 이상으로 확대"뿐인데, 검출 가능성은 zoom 에
 *    단조 증가라 지나쳐도 검출은 되고, **대칭 클램프**(latch 후 줌아웃 허용)가 초과분을 되돌린다.
 * ③ 대가로 얻는 것: latch 까지의 칸수 절반 이하 = rung 당 (nativeAimSettleMs + settleMs + 장비 슬루)를
 *    절반으로. 정밀도가 실제로 필요한 latch 이후 구간은 1.3 이 그대로 보존된다.
 *
 * ★ 단 하나의 실측 유보(구현자 관측): 잔차가 커지면 반경 게이트(0.10) **밖**으로 나가 latch 창이 좁아진다.
 *   그래서 "검출이 하나도 없는 구간"에서만 이 배율을 쓰고, LPD 가 후보를 내기 시작하면(기각이더라도)
 *   즉시 `maxZoomStepRatio` 로 되돌린다(§sawAnyPlate). 속도 이득은 광각 무검출 구간에 몰려 있으므로
 *   이 보수화로 잃는 이득은 거의 없다.
 */
const LADDER_PRELATCH_RATIO = 2.0;

/**
 * (사다리 전용) rung 절대 상한(무한루프 방지 안전판). `maxZoomStepRatio` 를 1 에 가깝게(예: 1.05)
 * 설정하면 자동 산출 예산이 수백 칸으로 폭주하므로 런타임을 하드 바운드한다.
 * 64 는 실사용 최소 비율 1.3 에서 필요한 14 칸의 4배 이상이라 정상 설정을 절대 자르지 않는다.
 */
const LADDER_RUNG_HARD_CAP = 64;

/**
 * (사다리 전용) zoom **실측 정체** 판정 임계(뷰어 배율 단위)와 연속 허용 횟수.
 *
 * 배경: `move` 는 `waitUntilSettled` 타임아웃에도 `true` 를 반환하므로 사다리는 줌 명령이 성공한 줄 안다.
 * 실카 라이브에서 장비 zoom 이 상한에 걸려 더 오르지 않는데도 사다리가 5 rung 을 더 올라가며
 * rung 당 정착 타임아웃(수 초)을 통째로 낭비했다(실측 25초+). `clampZoom` 은 **뷰어 범위**만 알아
 * 장비의 물리 상한을 모르므로 포화를 감지하지 못한다 → 실측(zoomAct)으로 판정한다.
 *
 * ★ 임계를 "거의 0"으로 잡은 이유: 줌 모터가 느려 한 rung 안에 목표에 못 닿는 **정상** 케이스가 실재한다
 *   (실측: 목표 raw 8894 명령에 5초 후 9968 — 이동 중이지만 미도달). 그런 경우 실측은 **분명히 변한다**.
 *   반면 진짜 포화는 실측이 **완전히 고정**된다. 그래서 "조금이라도 움직였으면 정상"으로 보고,
 *   0.05 배율(≈ raw 50 @[0,16384])만 못 움직인 rung 만 정체로 센다.
 * ★ 연속 2회를 요구하는 이유: 1회 미상승은 폴링 타이밍·인코더 양자화로도 생길 수 있다. 2회 연속이면
 *   "명령은 올라갔는데 장비는 두 칸 내내 제자리"라 물리 상한으로 단정할 근거가 된다.
 */
/**
 * (사다리 이분탐색·수정 20) 괄호(bracket)를 더 좁히는 것이 무의미해지는 최소 폭(뷰어 배율 단위).
 *
 * 근거: 뷰어 zoom [1,36] 은 raw [0,16384] 의 선형 사상이라 **1 raw ≈ 0.0021 뷰어 단위**다. 0.01 은 약 5 raw =
 * 장비 양자화보다 확실히 크고(노이즈를 쫓지 않는다), 동시에 실측 최급구간(zoom 35.153→36 에서 폭 0.157→0.238)에서도
 * 0.01 구간의 폭 변화는 ≈0.001 로 `widthTol`(0.015)의 **1/15** 에 불과하다 → 더 좁혀도 판정이 바뀌지 않는다.
 */
const LADDER_BRACKET_MIN_SPAN = 0.01;

const LADDER_ZOOM_STALL_EPS = 0.05;
const LADDER_ZOOM_STALL_LIMIT = 2;

/** 로그 자릿수 축약(가독). 영속화가 아니므로 round5 규약 대상 아님. */
const r3 = (v: number): number => Number(v.toFixed(3));
/** 로그 자릿수 축약(정규화 변위용 — 0.0014 처럼 r3 이면 통째로 뭉개지는 값). */
const r5 = (v: number): number => Number(v.toFixed(5));

type Center = { cx: number; cy: number };

const centerOfRect = (r: NormalizedRect): Center => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });
const priorRect = (c: Center): NormalizedRect => ({ x: c.cx, y: c.cy, w: 0, h: 0 });

/**
 * 번호판 OBB 기준 PTZ 정렬(센터링·줌)의 결정형 폐루프.
 * 무상태 — 호출마다 독립. Repository·writer·SetupBrain 의존 없음(순수 결정형 도구).
 *
 * ★ 명령 PTZ 추적: 시뮬 응답의 pan/tilt/zoom echo(0/0/1)는 신뢰 불가(PtzCalibrator.ts:44~47) →
 *   requestImage 에 명령값 override 를 넘기고 상태는 **내가 명령한 값**으로만 갱신한다.
 *   move() 는 쓰지 않는다(requestImage 가 이동+캡처 원자 — 별도 move 는 레이스만 만든다).
 *
 * ★ 대상 신원 추적(§2.5): 화면에 번호판이 여러 개면(실측 6개, 간격 0.15) 고정 prior 는 매 스텝
 *   "지금 중심에 가장 가까운" 다른 차로 갈아탄다 → 폐루프가 매 프레임 다른 물체의 오차를 재게 된다.
 *   초기 1회만 plateRoi 로 고르고, 이후 prior 는 "직전 관측 + 명령 delta 의 예측 변위"로 갱신하며
 *   예측에서 matchRadiusNorm 을 넘는 후보는 기각한다(이웃 갈아타기 차단).
 *
 * 예외 정책(설계 §2.3): 검출 소실은 이 도메인의 정상 결과 → ok:false + reason 반환.
 * 전송 계층 오류(CameraApiError·LpdApiError)는 삼키지 않고 그대로 전파한다(재시도는 클라이언트 소유).
 */
export class PlatePtz {
  private readonly camera: ICameraClient;
  private readonly lpd: LpdClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onFrame?: (jpeg: Buffer, camIdx: number, presetIdx: number) => void;
  private readonly opts: ResolvedOpts;

  constructor(deps: PlatePtzDeps, opts: PlatePtzOpts = {}) {
    this.camera = deps.camera;
    this.lpd = deps.lpd;
    this.sleep = deps.sleep ?? defaultSleep;
    this.onFrame = deps.onFrame;
    this.opts = {
      centerTol: opts.centerTol ?? 0.03,
      targetPlateWidth: opts.targetPlateWidth ?? 0.2,
      widthTol: opts.widthTol ?? 0.02,
      maxIterations: opts.maxIterations ?? 15,
      probeStepDeg: opts.probeStepDeg ?? 1.0,
      maxStepDeg: opts.maxStepDeg ?? 5.0,
      fallbackGainPanDeg: opts.fallbackGainPanDeg ?? -62,
      fallbackGainTiltDeg: opts.fallbackGainTiltDeg ?? -35.5,
      settleMs: opts.settleMs ?? 300,
      plateRoi: opts.plateRoi ?? { x: 0.5, y: 0.5, w: 0, h: 0 },
      matchRadiusNorm: opts.matchRadiusNorm ?? 0.08,
      maxZoomStepRatio: opts.maxZoomStepRatio ?? 1.5,
      preLatchZoomStepRatio: opts.preLatchZoomStepRatio ?? LADDER_PRELATCH_RATIO,
      nativeAimSettleMs: opts.nativeAimSettleMs ?? 1000,
      // 0.0014 ≈ 1080p 1.5px. 실제 tilt 각은 captureTrack 이 zoom 별로 환산한다(픽셀 공간 고정).
      plateRecaptureDitherNorm: opts.plateRecaptureDitherNorm ?? 0.0014,
      // ★ 기본 0 = 재포착 없음 = 기존 동작(주입 없으면 코드가 재시도 루프에 진입조차 하지 않는다).
      plateRecaptureRetries: opts.plateRecaptureRetries ?? 0,
      plateRecaptureZoomStep: opts.plateRecaptureZoomStep ?? 0.01,
      // ★ ladderMaxRungs 는 기본값을 주지 않는다(undefined = clampZoom 상한까지 자동 산출 — ladderRungBudget).
      ...(opts.ladderMaxRungs !== undefined ? { ladderMaxRungs: opts.ladderMaxRungs } : {}),
      // ★ initialRadiusNorm 만 기본값을 주지 않는다(undefined = 게이트 없음 = 기존 동작).
      ...(opts.initialRadiusNorm !== undefined ? { initialRadiusNorm: opts.initialRadiusNorm } : {}),
      ...(opts.gain ? { gain: opts.gain } : {}),
      ...(opts.peerOffsets ? { peerOffsets: opts.peerOffsets } : {}),
    };
  }

  /**
   * [함수 1] 번호판 OBB 중심을 화면 중심(0.5,0.5)으로 정렬한다 — **pan/tilt 만 변경, zoom 불변**.
   *
   * 폐루프: 최초 검출(plateRoi 최근접) → probe 1회로 부호 포함 게인 실측(실패 시 fallback 게인)
   * → P 제어 반복(매 스텝 예측 prior 로 동일 번호판 추적). 이미 centerTol 안이면 probe 없이 즉시 성공.
   * `zoomToPlateWidth` 를 호출하지 않는다(단독 호출 가능 — 상호 의존 없음).
   *
   * zoom 불변이라 루프 중 게인 스케일링은 불요 — 게인은 zoomRef=startPtz.zoom 로 기록되어 반환된다.
   *
   * @param startPtz 명령 PTZ 추적 시작점(필수 — 응답 echo 신뢰 불가라 "현재 PTZ" 조회 수단이 없다.
   *                 프리셋 기본값이 필요하면 호출측이 detectPipeline.resolvePresetPtz 로 얻는다).
   * @returns 실패 시 reason: 'no_plate'(시작부터 미검출) | 'no_plate_near_click'(검출은 있으나 전부
   *          initialRadiusNorm 밖 — 주입 시에만 발생) | 'plate_lost'(도중 소실·매칭 기각) | 'max_iterations'.
   *          결과의 gain 을 zoomToPlateWidth 의 opts.gain 으로 넘기면 실측 게인이 재사용된다(zoom 스케일 자동).
   */
  async centerOnPlate(camIdx: number, presetIdx: number, startPtz: Ptz): Promise<PlatePtzResult> {
    const o = this.opts;
    // fallback 은 zoomRef=1 정의 → 시작 zoom 으로 스케일해 두면 루프 전체가 동일 기준(zoomRef=startPtz.zoom).
    const fbBase: PtzGain = { gainPan: o.fallbackGainPanDeg, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 };
    const fb: PtzGain = { ...scaleGainForZoom(fbBase, startPtz.zoom), zoomRef: startPtz.zoom };
    let ptz: Ptz = { ...startPtz };

    // 초기 대상 선정만 plateRoi prior — 이후는 예측 추적(§2.5).
    // 반경 게이트는 initialRadiusNorm 이 주입된 경우에만(클릭 경로). 미주입=null=기존 무게이트 동작.
    const first = await this.captureDetectPick(camIdx, presetIdx, ptz, o.plateRoi, o.initialRadiusNorm ?? null);
    if (!first.plate) {
      if (first.rejected) {
        // ★ 기각을 반드시 관측 가능하게 남긴다 — "왜 안 되지"를 추측이 아니라 로그로 알 수 있어야 한다.
        logger.info(
          {
            cat: 'centering', phase: 'gate', cam: camIdx, preset: presetIdx,
            click: { x: r3(o.plateRoi.x + o.plateRoi.w / 2), y: r3(o.plateRoi.y + o.plateRoi.h / 2) },
            plates: first.count, nearestDist: first.nearestDist === null ? null : r3(first.nearestDist),
            radius: o.initialRadiusNorm,
          },
          '클릭점 반경 밖 판만 검출 → 대신 채택하지 않고 실패(no_plate_near_click)',
        );
      }
      return failResult(first.rejected ? 'no_plate_near_click' : 'no_plate', {
        ptz, plate: null, err: null, plateWidth: null, gain: fb, iterations: 0,
      });
    }
    let plate: PlateBox = first.plate;

    let pr = quadBoundingRect(plate.quad);
    let err = plateCenterError(pr);
    if (isCentered(err, o.centerTol)) {
      // 이미 수렴 — probe 캡처 생략.
      return okResult({ ptz, plate, err, plateWidth: pr.w, gain: fb, iterations: 0 });
    }

    // 관측 앵커: 마지막으로 대상을 본 중심과 그때의 명령 PTZ(예측 prior 의 기준점).
    let obsCenter = centerOfRect(pr);
    let obsPtz: Ptz = { ...ptz };

    // probe: 작은 dPan/dTilt 1회 → 게인 추정(부호 포함). 본 루프는 절대값을 명령하므로 복귀 이동 불요.
    const probed = await this.probeGain(camIdx, presetIdx, ptz, err, obsCenter, fb);
    let gain = probed.gain;
    if (probed.obs) {
      obsCenter = probed.obs.center;
      obsPtz = probed.obs.ptz;
    }
    let dampCount = 0;
    // (재포착) 이번 호출에서 쓴 디더 캡처 누계(0 이면 결과에 싣지 않는다 = 기존 shape).
    let dithers = 0;

    for (let iter = 0; iter < o.maxIterations; iter++) {
      const next = panTiltCorrection(err, gain, ptz.pan, ptz.tilt, o.maxStepDeg);
      // zoom 은 startPtz.zoom 고정(계약: 이 함수는 zoom 을 절대 바꾸지 않는다).
      const cmd: Ptz = { pan: next.pan, tilt: next.tilt, zoom: startPtz.zoom };
      // 예측 prior 는 captureTrack 이 시도마다(디더 포함) 재계산한다 — 직전 관측 + 명령 delta 의 예측 변위.
      const tr = await this.captureTrack(camIdx, presetIdx, cmd, obsCenter, obsPtz, gain, o.matchRadiusNorm);
      // ★ 디더된 PTZ 를 그대로 상태로 채택한다(원복 금지) — obsPtz 의 정의가 "obsCenter 를 관측한 그 프레임의
      //   명령 PTZ" 라 디더 전 값을 쓰면 다음 prior 가 체계적으로 틀리고, 원복은 미검이 났던 그 프레임으로
      //   되돌아가는 것이라 회복을 원점으로 되돌린다.
      ptz = tr.ptz;
      dithers += tr.dithers;
      if (!tr.plate) {
        return failResult('plate_lost', { ptz, plate, err, plateWidth: pr.w, gain, iterations: iter + 1 }, { dithers });
      }
      plate = tr.plate;
      pr = quadBoundingRect(plate.quad);
      obsCenter = centerOfRect(pr);
      obsPtz = { ...ptz };
      const newErr = plateCenterError(pr);
      // 개선 정체 → 게인 감쇠(진동 방지). 단 누적 DAMP_LIMIT 회까지(게인 소멸 방지 — §2.1).
      if (improvement(err, newErr) < IMPROVE_EPS && dampCount < DAMP_LIMIT) {
        gain = { ...dampGain(gain), zoomRef: gain.zoomRef };
        dampCount++;
      }
      err = newErr;
      if (isCentered(err, o.centerTol)) {
        logger.info(
          { cat: 'centering', phase: 'center', cam: camIdx, preset: presetIdx, iterations: iter + 1, errX: Number(err.errX.toFixed(3)), errY: Number(err.errY.toFixed(3)), ptz },
          '번호판 센터링 수렴',
        );
        return okResult({ ptz, plate, err, plateWidth: pr.w, gain, iterations: iter + 1 }, { dithers });
      }
    }
    logger.warn({ cat: 'centering', phase: 'center', cam: camIdx, preset: presetIdx, errX: err.errX, errY: err.errY }, '번호판 센터링 반복 상한 소진');
    return failResult('max_iterations', { ptz, plate, err, plateWidth: pr.w, gain, iterations: o.maxIterations }, { dithers });
  }

  /**
   * [함수 2] 번호판 boundingRect 폭을 targetPlateWidth(기본 0.20 = 화면 가로의 20%)로 맞춘다 — **zoom 주도**.
   *
   * 폐루프(§2.2 — 가드 선행 = "중심이 안전할 때만 확대"):
   *  매 반복 ① 중심 오차가 centerTol 초과면 그 반복은 **줌을 보류하고** 1스텝 재중심
   *         ② 안전하면 zoomCorrection(sqrt 감쇠) 1스텝 — 단 인접 zoom 비를 maxZoomStepRatio 로 클램프.
   * 가드는 "센터링 기능 재실행"이 아니라 줌의 자기 보전이다(zoom-in 은 FOV 를 좁혀 중심 오차를
   * 같은 배율로 확대 → 대상을 화면 밖으로 밀어낸다). 이 두 장치 덕에 **base 수준 오차에서의
   * 단독 호출 성공이 계약**이다(§2.3) — `plate_lost` 는 대상이 실제로 시야를 이탈한 예외적 결과.
   * `centerOnPlate` 를 호출하지 않는다(단독 호출 가능 — 상호 의존 없음).
   *
   * 가드의 재중심 게인은 opts.gain(centerOnPlate 실측) ?? fallback(−62/−35.5 @zoomRef=1)이며,
   * **매 반복 현재 zoom 으로 스케일**해서 쓴다(§2.6 — 게인 ∝ 1/zoom). probe 는 하지 않는다(스케일링이 대체).
   *
   * ★ 게인 의존 명시(계약): 이 함수는 **probe 를 전혀 하지 않는다**. 따라서 `opts.gain` 없이 단독
   *   호출하면 드리프트 가드의 게인은 **fallback 에 100% 무측정 의존**한다(`centerOnPlate` 처럼
   *   probe 로 자가 교정되지 않는다). fallback 기본값 −62/−35.5(@zoomRef=1)는 **cam1 시뮬 카메라
   *   실측 기준**이라, 게인이 다른 카메라에서는 가드가 역방향/과소 보정해 오차가 커지고 `plate_lost`
   *   로 이어질 수 있다(센터링은 멀쩡한 채 줌 단독만 조용히 열화 → 진단이 비대칭).
   *   **권고**: 다른 카메라에서는 ① `centerOnPlate` 결과의 `gain` 을 `opts.gain` 으로 체이닝하거나
   *   ② `diagSweep` 실측값을 `opts.fallbackGain*` 로 주입할 것.
   *
   * @param startPtz 명령 PTZ 추적 시작점(필수 — centerOnPlate 결과의 ptz 를 그대로 넘기면 체이닝).
   * @returns 실패 시 reason: 'no_plate' | 'plate_lost' | 'zoom_saturated'(zoom 클램프 상한인데 폭 미달)
   *          | 'max_iterations'.
   */
  async zoomToPlateWidth(camIdx: number, presetIdx: number, startPtz: Ptz): Promise<PlatePtzResult> {
    const o = this.opts;
    const gainRef: PtzGain = o.gain ?? { gainPan: o.fallbackGainPanDeg, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 };
    let ptz: Ptz = { ...startPtz };

    let plate = await this.captureAndDetect(camIdx, presetIdx, ptz, o.plateRoi, null);
    if (!plate) return failResult('no_plate', { ptz, plate: null, err: null, plateWidth: null, gain: gainRef, iterations: 0 });

    let pr = quadBoundingRect(plate.quad);
    let obsCenter = centerOfRect(pr);
    let obsPtz: Ptz = { ...ptz };
    let plateWidth = pr.w;
    let err = plateCenterError(pr);
    if (isWidthConverged(plateWidth, o.targetPlateWidth, o.widthTol)) {
      return okResult({ ptz, plate, err, plateWidth, gain: gainRef, iterations: 0 });
    }
    // (재포착) 이번 호출에서 쓴 디더 캡처 누계(0 이면 결과에 싣지 않는다 = 기존 shape).
    let dithers = 0;

    for (let iter = 0; iter < o.maxIterations; iter++) {
      const effGain = scaleGainForZoom(gainRef, ptz.zoom);

      // [가드 선행] 중심이 tol 밖이면 이번 반복은 줌을 올리지 않고 1스텝 재중심만 한다.
      if (!isCentered(err, o.centerTol)) {
        const rec = panTiltCorrection(err, effGain, ptz.pan, ptz.tilt, o.maxStepDeg);
        const cmd: Ptz = { pan: rec.pan, tilt: rec.tilt, zoom: ptz.zoom };
        // (재포착) centerOnPlate 와 완전히 동일한 실패 패턴이라 같은 헬퍼를 쓴다(A 만 고치면 한 칸 뒤에서 재발).
        const tr = await this.captureTrack(camIdx, presetIdx, cmd, obsCenter, obsPtz, effGain, o.matchRadiusNorm);
        ptz = tr.ptz; // ★ 디더 채택(원복 금지 — centerOnPlate 와 같은 근거).
        dithers += tr.dithers;
        if (!tr.plate) {
          return failResult('plate_lost', { ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1 }, { dithers });
        }
        plate = tr.plate;
        pr = quadBoundingRect(plate.quad);
        obsCenter = centerOfRect(pr);
        obsPtz = { ...ptz };
        err = plateCenterError(pr);
        plateWidth = pr.w;
        continue;
      }

      // [줌] sqrt 감쇠 보정 → 인접 zoom 비 클램프(대칭). clampZoom 통과값이라 재클램프 불요.
      const z1 = zoomCorrection(ptz.zoom, plateWidth, o.targetPlateWidth, (z) => this.camera.clampZoom(z));
      const newZoom = Math.min(ptz.zoom * o.maxZoomStepRatio, Math.max(ptz.zoom / o.maxZoomStepRatio, z1));
      // 포화: clamp 상한이라 zoom 이 더 못 오르는데 폭이 미달 → clamp 가 미달 수렴을 "성공"으로 위장하는 것 방지.
      if (newZoom === ptz.zoom && plateWidth < o.targetPlateWidth - o.widthTol) {
        logger.warn({ cat: 'centering', phase: 'zoom', cam: camIdx, preset: presetIdx, zoom: ptz.zoom, plateWidth }, 'zoom 포화(폭 목표 미달)');
        // 이 출구도 앞선 반복에서 쓴 디더 횟수를 버리지 않는다(정직성 관용구 — 다른 출구와 동일).
        return failResult('zoom_saturated', { ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1 }, { dithers });
      }
      // 줌 후 prior 는 모델이 다르다(pan/tilt 변위가 아니라 배율 확대) → **줌 예측 중심을 앵커로** 넘긴다.
      // ★ 이 지점의 재포착 축은 **zoom** 이다(이터3) — 배율이 바뀐 새 프레임이라 tilt 로 흔들어도 회복되지
      //   않는 데드존이 실측됐고(tilt 7시도 전패), zoom +1%(8.1738→8.25)로 회복됐다.
      //   pan/tilt 이동 지점(A·B)은 tilt 디더가 실측으로 효과가 확인됐으므로 그대로 둔다.
      const prior = predictCenterAfterZoom(obsCenter, ptz.zoom, newZoom);
      const zPtz: Ptz = { ...ptz, zoom: newZoom };
      const tr = await this.captureTrackZoom(camIdx, presetIdx, zPtz, prior, o.matchRadiusNorm);
      ptz = tr.ptz; // ★ 디더 채택(원복 금지).
      dithers += tr.dithers;
      if (!tr.plate) {
        return failResult('plate_lost', { ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1 }, { dithers });
      }
      plate = tr.plate;
      pr = quadBoundingRect(plate.quad);
      obsCenter = centerOfRect(pr);
      obsPtz = { ...ptz };
      err = plateCenterError(pr);
      plateWidth = pr.w;
      if (isWidthConverged(plateWidth, o.targetPlateWidth, o.widthTol)) {
        logger.info(
          { cat: 'centering', phase: 'zoom', cam: camIdx, preset: presetIdx, iterations: iter + 1, plateWidth: Number(plateWidth.toFixed(3)), ptz },
          '번호판 폭 수렴',
        );
        return okResult({ ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1 }, { dithers });
      }
    }
    logger.warn({ cat: 'centering', phase: 'zoom', cam: camIdx, preset: presetIdx, plateWidth }, '번호판 줌 반복 상한 소진');
    return failResult('max_iterations', { ptz, plate, err, plateWidth, gain: gainRef, iterations: o.maxIterations }, { dithers });
  }

  /**
   * [함수 3] 클릭 지점 조준 → **줌 사다리** → 목표 폭 수렴. 개별 center+zoom 을 한 호출로 완결한다.
   * `centerOnPlate`/`zoomToPlateWidth` 를 호출하지 않는다(상호 의존 없음 — 기존 두 경로 무영향).
   *
   * 기존 center+zoom 경로는 **조준보다 검출을 먼저** 요구해서(광각에서 먼 판은 화소 부족 → LPD 미검출)
   * 시작조차 못 했다. 사다리는 순서를 뒤집는다:
   *  ① 클릭점을 먼저 화면중앙으로 조준(검출 불요 — 실카는 장비 네이티브 setcenter, 시뮬은 기하 1샷)
   *  ② 미검출이면 눈먼 zoom 1스텝(×maxZoomStepRatio). **zoom-in 은 광학중심을 보존**하므로 ①로 중앙에 온
   *     대상은 확대해도 중앙에 남는다 = "찾을 때까지 확대"가 대상을 잃지 않는다.
   *  ③ 검출되면 판중심으로 재중심(실카는 setcenter 한 방 — 게인/probe/damp 불요) 후 다음 칸으로.
   *  ④ 폭이 targetPlateWidth 에 수렴하면 성공. **성공 출구는 이 한 곳뿐**(위장 성공 0).
   *
   * 거짓 성공 차단: rung 의 prior 는 항상 화면중앙이고, 게이트는 latch 전 `initialRadiusNorm`(클릭 반경) /
   * latch 후 `matchRadiusNorm`(추적 반경). 게이트를 못 넘으면 **다른 판을 대신 잡지 않고** 실패로 간다.
   *
   * @param point   클릭 지점(정규화, **현재 화면 기준**)
   * @param startPtz 현재 PTZ(호출측이 조회해 넘긴다 — 클릭은 "지금 보이는 화면" 기준이라 프리셋 base 는 어긋난다)
   * @returns 실패 reason: 'aim_failed' | 'no_plate_near_click'(게이트 기각은 로그로만 남기고 rung 은 줌인 계속)
   *          | 'plate_not_found_at_max_zoom' | 'plate_lost' | 'zoom_saturated' | 'max_iterations'.
   */
  async centerAndZoomByLadder(
    camIdx: number,
    presetIdx: number,
    point: NormalizedPoint,
    startPtz: Ptz,
  ): Promise<PlatePtzResult> {
    const o = this.opts;
    // 기하 폴백 전용 게인(zoomRef=1 정의 — aimPtzForPoint 가 사용 시점 zoom 으로 스케일한다).
    // 네이티브 경로에서는 쓰이지 않는다(장비 펌웨어가 자기 FOV 테이블로 변환).
    const fb: PtzGain = { gainPan: o.fallbackGainPanDeg, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 };
    let ptz: Ptz = { ...startPtz };

    // ── ① 클릭점 조준(rung 진입 전 1회) ──
    const aim = await this.recenterTo(camIdx, point, ptz, fb);
    if (!aim.ok) {
      return failResult('aim_failed', { ptz, plate: null, err: null, plateWidth: null, gain: fb, iterations: 0 });
    }
    ptz = aim.ptz;
    logger.info(
      { cat: 'centering', phase: 'ladder', step: 'aim', cam: camIdx, preset: presetIdx, mode: aim.mode, point: { x: r3(point.x), y: r3(point.y) }, ptz },
      '사다리 클릭점 조준 완료',
    );

    let plate: PlateBox | null = null;
    let err: { errX: number; errY: number } | null = null;
    let plateWidth: number | null = null;
    let latched = false; // 한 번이라도 대상 판을 잡았는가(사유 구분·게이트 전환 겸용).
    // 반경 기각 이력. 사유를 **마지막 rung 상태로만** 가르면 중간에 계속 기각되다가 마지막에 검출 0 이 된
    // 경우가 'LPD 한계' 로 오보된다 — 한 번이라도 기각이 있었으면 클릭 위치 문제로 보고한다.
    let rejectedEver = false;
    // LPD 가 후보를 한 번이라도 냈는가(기각 포함). latch 전 성긴 배율은 **검출이 0 인 구간**에서만 쓴다 —
    // 후보가 보이기 시작하면 반경 게이트를 지나치지 않도록 즉시 정밀 배율로 되돌린다(LADDER_PRELATCH_RATIO 주석 ★).
    let sawAnyPlate = false;
    // (수정 20) 실측쌍 괄호: width < target 인 **최대** zoom(zLo) / width > target 인 **최소** zoom(zHi).
    // ★ 검출된 rung 에서만 채워지므로 latch 이전 탐색 동작에는 구조적으로 영향이 없다.
    let zLo: number | null = null;
    let zHi: number | null = null;
    // (수정 18) 목표 폭에 가장 가까웠던 rung 을 기억한다. 사다리는 **자신이 도달했던 최선보다 나쁘게 끝나면 안 된다**.
    let best: { ptz: Ptz; plate: PlateBox; err: { errX: number; errY: number }; plateWidth: number; rung: number } | null = null;
    const rungBudget = this.ladderRungBudget(ptz.zoom);
    // zoom 실측 정체 추적(수정 11). prevAct 는 직전 rung 의 장비 실측 zoom.
    // ★ actLive: 실측이 명령을 따라 움직이는 것을 **한 번이라도 확인**하기 전에는 판정하지 않는다 —
    //   응답 echo 를 신뢰할 수 없는 소스(시뮬은 0/0/1 고정)에서 "항상 정체"로 오판하는 것을 구조적으로 막는다.
    let prevAct: number | null = null;
    let prevCmd: number | null = null;
    let actLive = false;
    let stall = 0;
    // 조준 완료 시점의 zoom. latch 전에는 rung 간 재중심이 **없으므로**(재중심은 검출 분기에만 있다)
    // 화면 전체가 누적배율 k = z_cur/z_aim 로 정확히 등방 확대된다(predictCenterAfterZoom 의 곱셈 합성).
    const aimZoom = Math.max(ptz.zoom, 1e-6);

    // ── ②~④ 사다리 ──
    for (let rung = 0; rung <= rungBudget; rung++) {
      // 캡처는 항상 requestImage(ptz override) — 이동+캡처 원자(PlatePtz 불변식). move 직접 호출 없음.
      // ★ latch 전 게이트는 **누적배율 k 로 스케일**한다(고정 0.10 이 아니다).
      //   관측 거리는 e_orig·k 로 커지는데 고정 반경과 비교하면 축척이 다른 두 양을 비교하는 것이라
      //   k 가 커질수록 게이트가 부당하게 엄격해지고 latch 창이 [k_검출, radius/e1] 로 **닫힌다**
      //   (실측: 창 [3,4.65] 프레임에서 성긴 배율이 창을 건너뛰어 6/21 실패).
      //   radius·k 로 비교하면 게이트가 **원본(조준) 프레임 기준 0.10** 이라는 고정 의미를 되찾고 창은 [k_검출, ∞) 가 된다.
      //   ★ 판별력은 전혀 약해지지 않는다: 원본에서 0.15 떨어진 이웃은 어느 zoom 에서든 관측 0.15·k → 원본환산 0.15 > 0.10 기각.
      //   ★ 상한을 두지 않는 이유: k≥5 면 반경이 0.5 를 넘어 사실상 무효로 보이지만, 그 zoom 에서는
      //     원본 0.1 이상 떨어진 후보가 **이미 프레임 밖**이라(0.1·5=0.5=화면 반폭) 프레임 자체가 게이트 역할을 한다.
      //     상한을 두면 이번에 고치는 "창이 닫히는" 버그를 그대로 되살린다.
      const k = ptz.zoom / aimZoom;
      const gate = latched
        ? o.matchRadiusNorm
        : o.initialRadiusNorm === undefined
          ? null
          : o.initialRadiusNorm * k;
      const got = await this.captureDetectPick(camIdx, presetIdx, ptz, priorRect({ cx: 0.5, cy: 0.5 }), gate);
      if (got.count > 0) sawAnyPlate = true;

      // [수정 11] 명령은 올렸는데 장비 실측 zoom 이 제자리면 물리 상한이다 — 성공으로 믿고 rung 을 낭비하지 않는다.
      // 정체 판정 수치부는 detectZoomStall 로 뽑고, 카운터(actLive/stall) 갱신은 여기(루프)가 소유한다.
      const zs = detectZoomStall(prevAct, prevCmd, got.act.zoom, ptz.zoom, actLive, stall);
      actLive = zs.actLive;
      stall = zs.stall;
      if (zs.stalled) {
        // [수정 13] 정체 시점의 **이번 rung 실측**으로 판정한다(직전 rung 값으로 성공을 주지 않는다).
        const pr = got.plate ? quadBoundingRect(got.plate.quad) : null;
        const e = pr ? plateCenterError(pr) : null;
        const w = pr ? pr.w : plateWidth;
        const fin = await this.finalizeAtDeviceLimit(camIdx, presetIdx, ptz, got.plate ?? plate, e ?? err, w, latched, fb);
        logger.warn(
          {
            cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx,
            // zs.stalled 는 prevAct !== null 일 때만 참이다(detectZoomStall) — 단언은 그 불변식의 표기다.
            zoomCmd: r3(ptz.zoom), zoomAct: r3(got.act.zoom), prevAct: r3(prevAct!), stall,
            plateWidth: fin.plateWidth === null ? null : r3(fin.plateWidth), atDeviceLimit: 'zoomAct', ok: fin.ok,
            recenterAttempts: fin.attempts,
            errX: fin.err === null ? null : r3(fin.err.errX), errY: fin.err === null ? null : r3(fin.err.errY),
          },
          'zoom 명령이 장비 실측에 반영되지 않음(연속 정체) → 그 지점을 최종 위치로 확정',
        );
        return limitResult(fin.ok, 'zoom_saturated', {
          ptz: fin.ptz, plate: fin.plate, err: fin.err, plateWidth: fin.plateWidth, gain: fb, iterations: rung + 1,
        }, {
          rest: {
            widthShortfall: fin.plateWidth !== null && fin.plateWidth < o.targetPlateWidth,
            recenterAttempts: fin.attempts,
          },
        });
      }
      prevAct = got.act.zoom;
      prevCmd = ptz.zoom;

      if (got.plate) {
        latched = true;
        plate = got.plate;
        const pr = quadBoundingRect(plate.quad);
        plateWidth = pr.w;
        err = plateCenterError(pr);
        logger.info(
          {
            cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx, zoom: r3(ptz.zoom),
            errX: r3(err.errX), errY: r3(err.errY), plateWidth: r3(plateWidth), plates: got.count,
            // 진단(수정 9): 명령 zoom 이 올라도 zoomAct 가 안 오르면 장비가 실제로 줌하지 않은 것이고,
            // sha/bytes 가 인접 rung 과 같으면 같은 프레임을 분석한 것이다. 둘을 구분하려면 둘 다 필요하다.
            zoomCmd: r3(ptz.zoom), zoomAct: r3(got.act.zoom), panAct: r3(got.act.pan), tiltAct: r3(got.act.tilt),
            bytes: got.bytes, sha: got.sha,
          },
          '사다리 rung 검출',
        );
        if (best === null || Math.abs(plateWidth - o.targetPlateWidth) < Math.abs(best.plateWidth - o.targetPlateWidth)) {
          best = { ptz: { ...ptz }, plate, err, plateWidth, rung };
        }
        if (isWidthConverged(plateWidth, o.targetPlateWidth, o.widthTol)) {
          // [수정 21] 이 기능의 이름은 **센터라이징**이다 — 폭만 맞고 화면 한쪽에 치우친 채 "완료"는 절반만 한 일이다.
          //   수정 17 이 세운 "성공 = latch + 실측 정렬" 원칙을 주 경로에도 적용하되, **성공을 좁히지는 않는다**.
          const fin = await this.finalizeConverged(camIdx, presetIdx, ptz, plate, err, plateWidth, fb);
          logger.info(
            {
              cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx, zoom: r3(fin.ptz.zoom),
              plateWidth: r3(fin.plateWidth), recenterAttempts: fin.attempts, aligned: fin.aligned,
              errX: r3(fin.err.errX), errY: r3(fin.err.errY),
              errBefore: { x: r3(err.errX), y: r3(err.errY) },
            },
            fin.aligned ? '사다리 폭 수렴 — 완료' : '사다리 폭 수렴 — 완료(정렬 잔차 남음)',
          );
          return okResult({
            ptz: fin.ptz, plate: fin.plate, err: fin.err, plateWidth: fin.plateWidth, gain: fb, iterations: rung + 1,
          }, {
            // 이 출구의 선택 필드는 출구마다 조건이 달라 rest 로 존재여부까지 확정해 넘긴다(비균일 관용구).
            rest: {
              ...(fin.attempts > 0 ? { recenterAttempts: fin.attempts } : {}),
              ...(fin.aligned ? {} : { centerShortfall: true }),
              // 재중심 뒤 재측정에서 폭이 목표 아래로 벗어났다면 그 사실도 남긴다(수정 18 의 best 복귀는
              // max_iterations/plate_lost 전용 경로라 이 성공 출구와 코드 경로가 겹치지 않는다 — 충돌 없음).
              ...(fin.plateWidth < o.targetPlateWidth - o.widthTol ? { widthShortfall: true } : {}),
            },
          });
        }
        // ③ 판중심 재중심(중심 오차가 tol 밖일 때만 — 불필요한 왕복 억제).
        if (!isCentered(err, o.centerTol)) {
          const c = centerOfRect(pr);
          const re = await this.recenterTo(camIdx, { x: c.cx, y: c.cy }, ptz, fb);
          if (!re.ok) {
            return failResult('aim_failed', { ptz, plate, err, plateWidth, gain: fb, iterations: rung + 1 });
          }
          ptz = re.ptz;
        }
        // ── (수정 20) 실측쌍 괄호 갱신 ──
        // 목표를 아래에서 스치면 zLo, 위에서 스치면 zHi. 둘 다 잡히면 목표는 반드시 그 사이에 있다(단조성).
        if (plateWidth < o.targetPlateWidth) {
          if (zLo === null || ptz.zoom > zLo) zLo = ptz.zoom;
        } else if (zHi === null || ptz.zoom < zHi) {
          zHi = ptz.zoom;
        }

        // 다음 rung zoom 은 순수 수치부(nextLadderZoom)가 결정한다 — 괄호 이분/미형성 외삽의 근거는 그 함수 doc 참조.
        // 복귀(restoreBest)·확정(finalize)·상태 갱신·종료 반환은 이 루프가 소유한다(수치부만 추출 — 과분해 금지).
        const zdec = nextLadderZoom(
          ptz.zoom, zLo, zHi, plateWidth, o.targetPlateWidth, o.maxZoomStepRatio, (z) => this.camera.clampZoom(z),
        );
        const zNext = zdec.zNext;
        if (zdec.bracketExhausted) {
          // 괄호가 장비 해상도까지 좁혀졌거나 중점이 현재와 같으면 줌으로 더 가까이 갈 방법이 없다 → best 로 종료.
          const back = await this.restoreBest(camIdx, presetIdx, ptz, plateWidth, best, o.widthTol);
          const fin = await this.finalizeAtDeviceLimit(
            camIdx, presetIdx, back.restored ? back.ptz : ptz,
            back.plate ?? plate, back.err ?? err, back.plateWidth ?? plateWidth, latched, fb,
          );
          logger.warn(
            {
              cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx,
              // bracketExhausted 는 괄호 형성(zLo/zHi 비null) 시에만 참이다(nextLadderZoom) — 단언은 그 불변식.
              zLo: r3(zLo!), zHi: r3(zHi!), span: r3(zHi! - zLo!), zoom: fin.ptz.zoom,
              plateWidth: fin.plateWidth === null ? null : r3(fin.plateWidth), targetPlateWidth: o.targetPlateWidth,
              ok: fin.ok, recenterAttempts: fin.attempts, restoredToBest: back.restored,
            },
            '괄호가 장비 zoom 해상도까지 좁혀짐 — 최선 지점을 최종 위치로 확정',
          );
          return limitResult(fin.ok, 'zoom_resolution_limit', {
            ptz: fin.ptz, plate: fin.plate, err: fin.err, plateWidth: fin.plateWidth, gain: fb, iterations: rung + 1,
          }, {
            restoredToBest: back.restored,
            rest: {
              widthShortfall: fin.plateWidth !== null && fin.plateWidth < o.targetPlateWidth,
              recenterAttempts: fin.attempts,
            },
          });
        }
        // 포화: 양방향 모두 막힌 경우(clampZoom 상한/하한). 폭 수렴은 위에서 이미 반환했으므로 여기는 항상 미수렴.
        if (Math.abs(zNext - ptz.zoom) <= ZOOM_EPS) {
          // [수정 13+17] 장비 상한에서의 폭 미달은 "장비가 할 수 있는 일을 전부 한 상태"일 수 있다.
          //   정렬을 **전제로 요구하지 않고 만든다**: tol 밖이면 마지막으로 한 번 더 재중심하고 재확인한다.
          const fin = await this.finalizeAtDeviceLimit(camIdx, presetIdx, ptz, plate, err, plateWidth, latched, fb);
          logger.warn(
            {
              cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx, zoom: fin.ptz.zoom,
              plateWidth: fin.plateWidth === null ? null : r3(fin.plateWidth), targetPlateWidth: o.targetPlateWidth,
              zoomCmd: r3(ptz.zoom), zoomAct: r3(got.act.zoom), sha: got.sha, atDeviceLimit: 'clampZoom', ok: fin.ok,
              recenterAttempts: fin.attempts,
              errX: fin.err === null ? null : r3(fin.err.errX), errY: fin.err === null ? null : r3(fin.err.errY),
              // 방향을 사실대로 남긴다(구 문구는 '폭 목표 미달' 고정이라 폭 초과 케이스에서 거짓말을 했다).
              shortfall: plateWidth < o.targetPlateWidth ? 'under' : 'over',
            },
            '사다리 zoom 포화 — 장비 상한 지점을 최종 위치로 확정',
          );
          return limitResult(fin.ok, 'zoom_saturated', {
            ptz: fin.ptz, plate: fin.plate, err: fin.err, plateWidth: fin.plateWidth, gain: fb, iterations: rung + 1,
          }, {
            rest: {
              widthShortfall: fin.plateWidth !== null && fin.plateWidth < o.targetPlateWidth,
              recenterAttempts: fin.attempts,
            },
          });
        }
        ptz = { ...ptz, zoom: zNext };
        continue;
      }

      // 미검출 — 반경 기각이면 관측 가능하게 남긴다(마스터가 클릭 위치 문제인지 LPD 문제인지 알아야 한다).
      if (got.rejected) {
        rejectedEver = true;
        logger.info(
          {
            cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx,
            click: { x: r3(point.x), y: r3(point.y) }, plates: got.count,
            // ★ 거리 기준은 클릭점이 아니라 **조준 후 화면중앙**(rung prior)이다. 조준이 빗나가면 둘이 갈라지므로
            //   기준점을 함께 남기고 필드명도 기준을 밝힌다(구 필드명 nearestDist 는 클릭 기준으로 오독됐다).
            prior: { x: 0.5, y: 0.5 },
            nearestDistFromPrior: got.nearestDist === null ? null : r3(got.nearestDist), radius: gate === null ? null : r3(gate),
            // 원본(조준) 프레임 환산 거리 — 게이트가 스케일되므로 실제 판정은 이 값 대 initialRadiusNorm 이다.
            k: r3(k), distAtAim: got.nearestDist === null ? null : r3(got.nearestDist / k),
            zoomCmd: r3(ptz.zoom), zoomAct: r3(got.act.zoom), bytes: got.bytes, sha: got.sha,
          },
          '사다리 rung 반경 밖 판만 검출 → 대신 채택하지 않음',
        );
      }
      if (latched) {
        // (수정 18) 대상을 놓친 자리에 그대로 멈추지 말고, 도달했던 최선 폭 지점으로 되돌아가 끝낸다.
        const back = await this.restoreBest(camIdx, presetIdx, ptz, null, best, o.widthTol);
        return failResult('plate_lost', {
          ptz: back.ptz, plate: back.plate ?? plate, err: back.err ?? err,
          plateWidth: back.plateWidth ?? plateWidth, gain: fb, iterations: rung + 1,
        }, { restoredToBest: back.restored });
      }
      // latch 전 미검출 → 눈먼 1스텝 줌인(광학중심 보존 가정).
      // 배율은 latch 인지형: 검출이 하나도 없는 구간만 성긴 preLatchZoomStepRatio(칸수↓=소요시간↓),
      // LPD 가 후보를 내기 시작하면 정밀 maxZoomStepRatio 로 되돌린다(반경 게이트 창을 지나치지 않도록).
      const stepRatio = sawAnyPlate ? o.maxZoomStepRatio : o.preLatchZoomStepRatio;
      const zNext = this.camera.clampZoom(ptz.zoom * stepRatio);
      if (zNext <= ptz.zoom + ZOOM_EPS) {
        logger.warn(
          { cat: 'centering', phase: 'ladder', rung, cam: camIdx, preset: presetIdx, zoom: ptz.zoom, plates: got.count, rejectedEver, zoomCmd: r3(ptz.zoom), zoomAct: r3(got.act.zoom), sha: got.sha },
          '사다리 최대 줌 도달 — 대상 판 미확보',
        );
        return failResult(rejectedEver ? 'no_plate_near_click' : 'plate_not_found_at_max_zoom', {
          ptz, plate: null, err: null, plateWidth: null, gain: fb, iterations: rung + 1,
        });
      }
      ptz = { ...ptz, zoom: zNext };
    }
    // (수정 18) 예산 소진 시점이 도달했던 최선보다 유의하게 나쁘면(진동 등) 최선 지점으로 복귀해 끝낸다.
    const back = await this.restoreBest(camIdx, presetIdx, ptz, plateWidth, best, o.widthTol);
    logger.warn(
      {
        cat: 'centering', phase: 'ladder', cam: camIdx, preset: presetIdx, zoom: back.ptz.zoom,
        plateWidth: back.plateWidth ?? plateWidth, rungBudget, latched, rejectedEver,
        restoredToBest: back.restored, bestRung: best?.rung ?? null,
      },
      '사다리 rung 상한 소진',
    );
    return failResult(latched ? 'max_iterations' : rejectedEver ? 'no_plate_near_click' : 'plate_not_found_at_max_zoom', {
      ptz: back.ptz, plate: back.plate ?? plate, err: back.err ?? err,
      plateWidth: back.plateWidth ?? plateWidth, gain: fb, iterations: rungBudget + 1,
    }, { restoredToBest: back.restored });
  }

  /**
   * (수정 21) **폭 수렴 성공 출구의 정렬 확인** — best-effort. **성공을 취소하지 않는다.**
   *
   * 무회귀가 이 함수의 제1 제약이다: 오늘 성공하는 케이스가 내일 실패하면 안 된다.
   *  · 이미 tol 안 → **추가 카메라 왕복 0회**로 즉시 반환(대부분이 여기다 — 체감 시간 회귀 없음).
   *  · tol 밖 → 재중심 1회 + 재확인. **실패하든 여전히 tol 밖이든 호출측은 ok:true 를 유지**하고,
   *    남은 잔차를 `err`·`centerShortfall`·로그로 드러낸다(감추지 않되 실패로 바꾸지도 않는다).
   *
   * 반환 `aligned` 는 "실측으로 정렬이 확인됐는가"이며 성공 여부가 아니다(호출측이 성공을 결정한다).
   */
  private async finalizeConverged(
    camIdx: number,
    presetIdx: number,
    ptz: Ptz,
    plate: PlateBox,
    err: { errX: number; errY: number },
    plateWidth: number,
    fb: PtzGain,
  ): Promise<{
    ptz: Ptz; plate: PlateBox; err: { errX: number; errY: number };
    plateWidth: number; attempts: number; aligned: boolean;
  }> {
    const o = this.opts;
    if (isCentered(err, o.centerTol)) return { ptz, plate, err, plateWidth, attempts: 0, aligned: true };

    const c = centerOfRect(quadBoundingRect(plate.quad));
    const re = await this.recenterTo(camIdx, { x: c.cx, y: c.cy }, ptz, fb);
    if (!re.ok) {
      logger.warn(
        { cat: 'centering', phase: 'ladder', cam: camIdx, preset: presetIdx, errX: r3(err.errX), errY: r3(err.errY) },
        '폭 수렴 후 정렬 보정 실패(이동 거절) — 완료는 유지하고 잔차를 보고',
      );
      return { ptz, plate, err, plateWidth, attempts: 1, aligned: false };
    }
    const again = await this.captureDetectPick(camIdx, presetIdx, re.ptz, priorRect({ cx: 0.5, cy: 0.5 }), o.matchRadiusNorm);
    if (!again.plate) {
      // 재확인에서 대상을 못 봤다 — 위치는 re.ptz(카메라 실제 위치), 수치는 **마지막 실측값**을 유지한다(지어내지 않는다).
      logger.warn(
        { cat: 'centering', phase: 'ladder', cam: camIdx, preset: presetIdx, errX: r3(err.errX), errY: r3(err.errY) },
        '폭 수렴 후 정렬 재확인 실패(대상 미검출) — 완료는 유지하고 마지막 실측을 보고',
      );
      return { ptz: re.ptz, plate, err, plateWidth, attempts: 1, aligned: false };
    }
    const pr = quadBoundingRect(again.plate.quad);
    const e2 = plateCenterError(pr);
    return { ptz: re.ptz, plate: again.plate, err: e2, plateWidth: pr.w, attempts: 1, aligned: isCentered(e2, o.centerTol) };
  }

  /**
   * (수정 17) **장비 줌 상한 지점을 최종 위치로 확정한다.**
   *
   * 마스터 요구: "36배줌 해도 번호판이 20% 안되면 거기서 그 부분이 최종 위치가 되도록."
   * 상한에서 폭은 더 못 키우지만 **정렬은 아직 만들 수 있다**(줌 상한에서도 setcenter 는 동작한다).
   * 그래서 정렬을 **전제로 요구하지 않고**, tol 밖이면 마지막으로 한 번 더 재중심하고 **실측으로 재확인**한다.
   *
   * ★ 금지선 유지: latch 하지 못했으면 재중심을 시도하지 않고 실패다. 재중심 후에도 tol 밖이거나
   *   재확인에서 대상을 놓치면 **실패로 둔다**("했으니 됐다" 금지 — 수정 13 에서 세운 추정 금지 원칙).
   * @returns attempts = 마지막 재중심 시도 횟수(0 = 이미 정렬돼 불요).
   */
  private async finalizeAtDeviceLimit(
    camIdx: number,
    presetIdx: number,
    ptz: Ptz,
    plate: PlateBox | null,
    err: { errX: number; errY: number } | null,
    plateWidth: number | null,
    latched: boolean,
    fb: PtzGain,
  ): Promise<{
    ok: boolean; ptz: Ptz; plate: PlateBox | null; err: { errX: number; errY: number } | null;
    plateWidth: number | null; attempts: number;
  }> {
    const o = this.opts;
    // 대상을 못 잡았으면 정렬을 만들 대상 자체가 없다(금지선) — 카메라를 건드리지 않고 실패.
    if (!latched || !plate) return { ok: false, ptz, plate, err, plateWidth, attempts: 0 };

    // ★ 먼저 **현재 위치에서 실측**한다. 호출 시점의 err/plate 는 이번 rung 안에서 이미 재중심이 나간 뒤라면
    //   낡은 값이고, 그 낡은 중심으로 다시 재중심하면 같은 오프셋을 두 번 밀어 **반대편으로 넘어간다**
    //   (구현 중 실측: err 0.06 → 재중심 → −0.06). "최종 위치"라고 말하려면 그 자리를 직접 재야 한다.
    const now = await this.captureDetectPick(camIdx, presetIdx, ptz, priorRect({ cx: 0.5, cy: 0.5 }), o.matchRadiusNorm);
    if (!now.plate) return { ok: false, ptz, plate, err, plateWidth, attempts: 0 }; // 대상 소실 — 위장 금지.
    const pr = quadBoundingRect(now.plate.quad);
    const e = plateCenterError(pr);
    if (isCentered(e, o.centerTol)) {
      return { ok: true, ptz, plate: now.plate, err: e, plateWidth: pr.w, attempts: 0 }; // 이미 정렬 — 그 자리가 최종.
    }

    // 정렬을 **만든다**: 방금 잰 판 중심으로 마지막 재중심 1회(줌 상한에서도 setcenter 는 동작한다).
    const c = centerOfRect(pr);
    const re = await this.recenterTo(camIdx, { x: c.cx, y: c.cy }, ptz, fb);
    if (!re.ok) return { ok: false, ptz, plate: now.plate, err: e, plateWidth: pr.w, attempts: 1 };
    // ★ 실측 재확인(추정 금지). latch 후이므로 추적 반경으로 신원을 유지한다.
    const again = await this.captureDetectPick(camIdx, presetIdx, re.ptz, priorRect({ cx: 0.5, cy: 0.5 }), o.matchRadiusNorm);
    if (!again.plate) return { ok: false, ptz: re.ptz, plate: now.plate, err: e, plateWidth: pr.w, attempts: 1 };
    const pr2 = quadBoundingRect(again.plate.quad);
    const err2 = plateCenterError(pr2);
    return { ok: isCentered(err2, o.centerTol), ptz: re.ptz, plate: again.plate, err: err2, plateWidth: pr2.w, attempts: 1 };
  }

  /**
   * (수정 18) **도달했던 최선 폭 지점으로 복귀**한다. 사다리가 자신의 최선보다 나쁜 상태로 끝나는 것을 막는다.
   *
   * 실측 배경: 장비 상단에서 폭은 zoom 에 선형이 아니다(라이브 실측 w/z 가 0.0013→0.0066 으로 5배 변화).
   * 그래서 `zoomForWidth` 의 선형 목표가 크게 빗나가 zoom 36 ↔ 32.5 사이에서 폭이 0.238 ↔ 0.102 로
   * **진동**했고, 마지막 rung 이 하필 나쁜 쪽이면 "다 확대해놓고 마지막에 작아지는" 결과가 된다.
   *
   * 복귀 기준은 `widthTol` 재사용 — "우리가 신경 쓰는 허용오차보다 더 나쁠 때만" 되돌린다(새 임계 없음).
   * 복귀도 **실측으로 확인**하고(대상 재검출 실패 시 현재 상태 유지), 복귀 사실을 로그에 남긴다.
   */
  private async restoreBest(
    camIdx: number,
    presetIdx: number,
    curPtz: Ptz,
    curWidth: number | null,
    best: { ptz: Ptz; plate: PlateBox; err: { errX: number; errY: number }; plateWidth: number; rung: number } | null,
    widthTol: number,
  ): Promise<{
    restored: boolean; ptz: Ptz; plate: PlateBox | null;
    err: { errX: number; errY: number } | null; plateWidth: number | null;
  }> {
    const o = this.opts;
    if (!best) return { restored: false, ptz: curPtz, plate: null, err: null, plateWidth: null };
    const bestDelta = Math.abs(best.plateWidth - o.targetPlateWidth);
    // 현재 폭이 없으면(대상 소실) 최선 대비 무한히 나쁜 것으로 본다.
    const curDelta = curWidth === null ? Infinity : Math.abs(curWidth - o.targetPlateWidth);
    if (curDelta - bestDelta <= widthTol) return { restored: false, ptz: curPtz, plate: null, err: null, plateWidth: null };

    const got = await this.captureDetectPick(camIdx, presetIdx, best.ptz, priorRect({ cx: 0.5, cy: 0.5 }), o.matchRadiusNorm);
    if (!got.plate) {
      // 복귀는 했으나 대상을 다시 못 잡았다 — 위치는 최선 지점이되 실측을 위장하지 않는다.
      logger.warn(
        { cat: 'centering', phase: 'ladder', cam: camIdx, preset: presetIdx, bestRung: best.rung, bestZoom: r3(best.ptz.zoom) },
        '최선 지점 복귀 후 대상 재검출 실패 — 위치만 복귀(실측 미확인)',
      );
      return { restored: true, ptz: best.ptz, plate: null, err: null, plateWidth: null };
    }
    const pr = quadBoundingRect(got.plate.quad);
    logger.info(
      {
        cat: 'centering', phase: 'ladder', cam: camIdx, preset: presetIdx, bestRung: best.rung,
        bestZoom: r3(best.ptz.zoom), plateWidth: r3(pr.w), curWidth: curWidth === null ? null : r3(curWidth),
      },
      '종료 상태가 최선보다 나빠 최선 폭 지점으로 복귀',
    );
    return { restored: true, ptz: best.ptz, plate: got.plate, err: plateCenterError(pr), plateWidth: pr.w };
  }

  /**
   * (수정 13) **장비 zoom 상한 도달 시 성공/실패 판정.**
   *
   * 마스터의 실제 목적은 "클릭한 차를 최대한 크게 본다"이고, 아래 세 조건이 모두 성립하면
   * **장비가 할 수 있는 일을 전부 한 상태**다 → 목표 폭 미달이어도 성공으로 보고한다.
   *   ① 클릭한 그 판을 latch 했다  ② 이번 rung **실측**이 중앙 정렬(centerTol) ③ 상한 도달이 사실 확인됨
   * (③ 은 호출측이 clampZoom 포화 또는 zoomAct 연속 정체로 **확인한 자리에서만** 이 함수를 부른다 — 추정 금지.)
   *
   * ★ 위장 성공 금지 원칙과 충돌하지 않는 이유: 위장 성공은 "**클릭한 대상이 아닌 것**을 잡고 완료라 하는 것"이다.
   *   여기서는 대상 신원(latch)과 정렬(중앙)이 모두 검증됐고, 미달한 것은 **장비의 물리 한계**뿐이며
   *   그 사실도 `widthShortfall`/`reason` 으로 결과에 남는다. 정보를 지우지 않으므로 은닉이 아니다.
   *   반대로 latch 실패나 미정렬은 여기서 **false 를 반환해 실패를 유지**한다 — 1순위 목적은 그대로 지켜진다.
   */
  private saturatedOutcome(
    latched: boolean,
    plate: PlateBox | null,
    err: { errX: number; errY: number } | null,
    centerTol: number,
  ): boolean {
    if (!latched || !plate || !err) return false; // 대상 미확보 → 여전히 실패(위장 성공 금지).
    return isCentered(err, centerTol);            // 중앙 tol 밖 → 여전히 실패.
  }

  /**
   * (사다리 전용) rung 예산 산출. **실질 종료는 `clampZoom` 포화**이고 이 값은 무한루프 방지 안전판이다 —
   * 그래서 "설정된 `maxZoomStepRatio` 가 무엇이든 zoom 상한에 도달하는 것"이 보장되도록 계산한다.
   *
   * 등반 칸수 = ceil(log(zoomMax/startZoom) / log(ratio)). zoomMax 는 카메라에게 묻는다(clampZoom 위임 유지 —
   * 사다리가 독자 상한을 두면 clampZoom 과 이중 진실이 된다). 여기에 latch 후 미세수렴 여유(LADDER_RUNG_SLACK)를
   * 얹고 절대 상한(LADDER_RUNG_HARD_CAP)으로 바운드한다. `ladderMaxRungs` 명시 주입 시엔 그 값을 존중한다.
   */
  private ladderRungBudget(startZoom: number): number {
    const explicit = this.opts.ladderMaxRungs;
    if (explicit !== undefined) return Math.min(explicit, LADDER_RUNG_HARD_CAP);
    // ★ 사다리는 두 배율을 쓴다(latch 전 preLatch / latch 후 max). 예산은 **보수적으로 작은 쪽**으로 잡는다 —
    //   성긴 배율로 예산을 잡으면 정밀 배율 구간(latch 후)에서 칸이 모자라 목표 폭 직전에 잘린다.
    //   실사용에서는 preLatch(2.0) > max(1.3) 이라 사실상 max 기준이며, 성긴 구간은 예산을 덜 쓸 뿐이다.
    const ratio = Math.min(this.opts.maxZoomStepRatio, this.opts.preLatchZoomStepRatio);
    // ratio ≤ 1 은 확대 불가 설정 — 첫 rung 의 포화 판정이 즉시 종료시키므로 예산은 최소로 둔다.
    if (ratio <= 1 + ZOOM_EPS) return LADDER_RUNG_SLACK;
    // ★ 예산은 **양방향**으로 센다. 대칭 클램프(줌아웃 수렴)가 들어간 뒤로는 시작 zoom 이 상한 근처일 때
    //   등반 칸수가 ≈0 이 되어 예산이 SLACK 뿐인데, 정작 필요한 것은 하강 칸수다(실측: start zoom 36·큰 판 →
    //   5칸 소진 후 폭 0.252 에서 max_iterations, 한 칸만 더 있으면 수렴). 사다리는 실패해도 PTZ 를 복원하지
    //   않아 카메라가 상한에 주차되므로 **다음 클릭이 정확히 이 조건**이 된다 — 연쇄 실패를 막으려면 양방향이어야 한다.
    const z0 = Math.max(startZoom, 1e-6);
    const zoomMax = this.camera.clampZoom(Number.MAX_SAFE_INTEGER);
    const zoomMin = Math.max(this.camera.clampZoom(0), 1e-6);
    const span = Math.max(zoomMax / z0, z0 / zoomMin, 1);
    const rungs = Math.ceil(Math.log(span) / Math.log(ratio));
    return Math.min(rungs + LADDER_RUNG_SLACK, LADDER_RUNG_HARD_CAP);
  }

  /**
   * (사다리 전용) 정규화 지점을 화면중앙으로 — **네이티브/기하 분기의 유일 지점**.
   *
   * 네이티브(휴컴스 ptz_centering setcenter): 정규화오차→도(°) 변환을 장비 펌웨어가 자기 FOV/줌 테이블로
   * 수행하므로 게인·probe·damp 가 전부 불요하다(소프트웨어 추정치를 섞으면 오차원만 늘어난다).
   * ★ setcenter 는 `move` 와 달리 정착 대기를 하지 않는다 → nativeAimSettleMs sleep 후 PTZ 재조회.
   *   zoom 은 setcenter 가 건드리지 않으므로 **명령값을 그대로 유지**한다(응답 echo 불신 — 이 파일의 불변식).
   * 기하 폴백(시뮬 등 네이티브 미지원): 개방루프 1샷 — move 로 명령하고 명령값을 상태로 삼는다.
   */
  private async recenterTo(
    camIdx: number,
    p: NormalizedPoint,
    ptz: Ptz,
    gainRef: PtzGain,
  ): Promise<{ ok: boolean; ptz: Ptz; mode: 'native' | 'geometric' }> {
    const native = this.camera.centerOnPoint;
    if (native) {
      const got = await native.call(this.camera, camIdx, p);
      if (got.settled === false) {
        // ★ 미정착 상태로 다음 rung 을 명령하면 카메라를 슬루 중간 지점으로 되돌린다(라이브 실패 원인).
        //   조용히 진행하지 않고 조준 실패로 올린다.
        logger.warn(
          { cat: 'centering', phase: 'ladder', step: 'aim', cam: camIdx, point: { x: r3(p.x), y: r3(p.y) } },
          '네이티브 조준 정착 미확인 → 조준 실패 처리(미정착 PTZ 로 다음 명령 금지)',
        );
        return { ok: false, ptz, mode: 'native' };
      }
      // 소스가 스스로 정착을 확인했으면(settled===true) 고정 sleep 은 불필요한 지연일 뿐이다.
      // 정착 판정을 제공하지 않는 소스(settled===undefined)에는 기존 고정 대기를 폴백으로 유지한다.
      if (got.settled === undefined) await this.sleep(this.opts.nativeAimSettleMs);
      try {
        const cur = await this.camera.getPtz(camIdx);
        return { ok: true, ptz: { pan: cur.pan, tilt: cur.tilt, zoom: ptz.zoom }, mode: 'native' };
      } catch {
        // 조회 미지원/실패 소스는 setcenter 반환값으로 강등(조용한 실패 아님 — 이동 자체는 성공).
        return { ok: true, ptz: { pan: got.pan, tilt: got.tilt, zoom: ptz.zoom }, mode: 'native' };
      }
    }
    const aim = aimPtzForPoint(p, ptz, gainRef, LADDER_AIM_MAX_STEP);
    const ok = await this.camera.move(camIdx, aim.pan, aim.tilt, aim.zoom);
    return { ok, ptz: aim, mode: 'geometric' };
  }

  /**
   * probe 1회 이동 후 게인 추정(부호 포함). 검출·매칭 실패 → fallback 게인.
   * probe 위치의 관측은 다음 예측 prior 의 앵커로 반환한다(obs).
   */
  private async probeGain(
    camIdx: number,
    presetIdx: number,
    ptz: Ptz,
    beforeErr: { errX: number; errY: number },
    beforeCenter: Center,
    fb: PtzGain,
  ): Promise<{ gain: PtzGain; obs: { center: Center; ptz: Ptz } | null }> {
    const o = this.opts;
    const probePtz: Ptz = { pan: ptz.pan + o.probeStepDeg, tilt: ptz.tilt + o.probeStepDeg, zoom: ptz.zoom };
    // 게인 미측정 상태 → fallback 게인으로 예측. fallback 이 실측 참값이라 1° 변위 예측 오차 ≈0.001
    // (오답 후보까지 0.14 — 여유 ~90배). ★fallback 이 틀리면 예측 prior 가 틀린 게인을 자기확증한다(§2.7).
    const prior = predictPlateCenter(beforeCenter, { dPan: o.probeStepDeg, dTilt: o.probeStepDeg }, fb);
    const probePlate = await this.captureAndDetect(camIdx, presetIdx, probePtz, priorRect(prior), o.matchRadiusNorm);
    if (!probePlate) return { gain: fb, obs: null };
    const probeRect = quadBoundingRect(probePlate.quad);
    const afterErr = plateCenterError(probeRect);
    const g = estimateGain(beforeErr, afterErr, { dPan: o.probeStepDeg, dTilt: o.probeStepDeg }, fb);
    return { gain: { ...g, zoomRef: fb.zoomRef }, obs: { center: centerOfRect(probeRect), ptz: probePtz } };
  }

  /**
   * (재포착) **추적 캡처 1회 + 미검 시 미세 tilt 디더 재캡처**.
   *
   * 근거: 추적 중 1회 미검을 즉시 `plate_lost` 로 확정하던 계약은 LPD 의 **픽셀 단위 프레이밍 불안정**에
   * 그대로 노출돼 있었다(리더 실측: 동일 이미지 1/2/3px 세로 시프트로 검출 5/7/7개). 프레임 내에서는
   * 결정적이라 **같은 PTZ 재캡처로는 회복 불가** → 디더로 프레이밍을 바꿔 다시 본다.
   *
   * ★ 디더 폭은 **화면 변위(정규화)로 지정하고 매 호출 zoom 으로 각도 환산**한다(이터2). 검출기가 보는 것은
   *   픽셀뿐이라 고정 각도는 zoom 마다 다른 일을 한다. 배수는 `[+1,−1,+2,−2,+4,−4]` 로 에스컬레이팅 —
   *   실측상 1.5px·3px 로는 회복되지 않고 **6px 에서 재검출**됐다.
   * ★ 게이트는 **절대 완화하지 않는다** — 재시도도 호출측이 준 **같은 `radius` 변수 하나**를 그대로 넘긴다
   *   (시그니처에 "완화 반경" 개념이 존재하지 않는다 = 거짓 성공 금지선이 구조적으로 불변).
   *   최대 디더 변위(4×0.0014 = 0.0056)는 `matchRadiusNorm`(0.08)의 7%, 이웃 판 간격 0.15 의 3.7% 라
   *   어느 zoom 에서도 이웃을 게이트 안으로 끌어들일 수 없다.
   * ★ prior 는 매 시도의 **디더된 cmd 기준으로 재계산**한다(분기 없음). 기존 코드와 동일한 식이라 근사가 아니며
   *   비용 0 이다.
   * ★ 발동 조건은 **`plate===null` 인 모든 경우** = 검출 0(`count=0`)과 반경 기각(`rejected`) 둘 다.
   *   두 실패는 "LPD 가 그 프레임에서 대상 판을 내지 않았다"는 **같은 사건의 두 얼굴**이고(화면에 이웃이
   *   있으면 rejected, 없으면 count=0), 실제 관측된 실패가 rejected 쪽이었다(count=4, dist 0.126 > 0.08).
   *
   * @param cmd  이번 반복에서 명령하려던 PTZ(디더 전 기준).
   * @returns 성공 시 그 판과 **실제로 명령한 PTZ**(디더 포함 — 호출측이 상태로 채택한다. 원복 금지 §5),
   *          실패 시 plate=null 과 **마지막으로 명령한 PTZ**(카메라의 실제 위치 — 지어내지 않는다).
   *          dithers = 추가로 쓴 디더 캡처 횟수(0 이면 기존과 완전히 동일한 1회 캡처).
   */
  private async captureTrack(
    camIdx: number,
    presetIdx: number,
    cmd: Ptz,
    obsCenter: Center,
    obsPtz: Ptz,
    gain: { gainPan: number; gainTilt: number },
    radius: number | null,
  ): Promise<{ plate: PlateBox | null; ptz: Ptz; dithers: number }> {
    const o = this.opts;
    // 변위 배수 사다리 [+1,−1,+2,−2,+4,−4] (0 은 디더 없는 원 캡처).
    const mults = [0, ...ditherMultipliers(o.plateRecaptureRetries)];
    // 변위(정규화) → tilt 각(°) 환산 계수. predictPlateCenter 의 `변위 = dTilt/gainTilt` 역산이다.
    // ★ 루프의 살아있는 `gain`(damp 로 절반씩 줄어드는 값)을 쓰지 않는다 — 감쇠는 제어 사정이지 검출기 사정이
    //   아니라서, 감쇠된 게인으로 환산하면 정작 흔들어야 할 때 디더가 함께 작아진다(자기무력화).
    //   검출기가 보는 것은 픽셀뿐이므로 환산은 **무측정 fallback 게인 × 현재 zoom** 이라는 고정 물리모델로만 한다.
    const degPerNorm = Math.abs(
      scaleGainForZoom({ gainPan: 0, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 }, cmd.zoom).gainTilt,
    );
    const u = o.plateRecaptureDitherNorm;
    let last: Ptz = cmd;
    for (let i = 0; i < mults.length; i++) {
      const dNorm = mults[i]! * u;          // 이번 시도의 화면 변위(정규화, 부호 포함)
      const dDeg = dNorm * degPerNorm;      // 그 변위를 만드는 tilt 각(°)
      const p: Ptz = { pan: cmd.pan, tilt: cmd.tilt + dDeg, zoom: cmd.zoom };
      const prior = predictPlateCenter(obsCenter, { dPan: p.pan - obsPtz.pan, dTilt: p.tilt - obsPtz.tilt }, gain);
      const got = await this.captureDetectPick(camIdx, presetIdx, p, priorRect(prior), radius);
      last = p;
      if (got.plate) {
        if (i > 0) {
          logger.info(
            {
              cat: 'centering', phase: 'recapture', cam: camIdx, preset: presetIdx, attempt: i,
              mult: mults[i]!, ditherNorm: r5(dNorm), ditherDeg: r3(dDeg), tilt: r3(p.tilt), zoom: r3(cmd.zoom),
              plates: got.count,
              nearestDist: got.nearestDist === null ? null : r3(got.nearestDist), radius, recovered: true,
            },
            '미세 디더 재캡처로 대상 재포착',
          );
        }
        return { plate: got.plate, ptz: p, dithers: i };
      }
      if (i < mults.length - 1) {
        const nextNorm = mults[i + 1]! * u;
        logger.info(
          {
            cat: 'centering', phase: 'recapture', cam: camIdx, preset: presetIdx, attempt: i,
            plates: got.count, rejected: got.rejected,
            nearestDist: got.nearestDist === null ? null : r3(got.nearestDist), radius,
            // 진단: 예측 prior 자체가 틀린 경우(예측 오차)와 검출기 미검을 구분하려면 prior 좌표가 필요하다.
            prior: { x: r3(prior.cx), y: r3(prior.cy) }, tilt: r3(p.tilt),
            ditherNorm: r5(dNorm), ditherDeg: r3(dDeg),
            nextMult: mults[i + 1]!, nextDitherNorm: r5(nextNorm), nextDitherDeg: r3(nextNorm * degPerNorm),
          },
          '추적 캡처 미검(검출0 또는 반경기각) → 미세 디더 재캡처 시도',
        );
      }
    }
    if (mults.length > 1) {
      logger.warn(
        {
          cat: 'centering', phase: 'recapture', cam: camIdx, preset: presetIdx,
          attempts: mults.length, dithers: mults.length - 1, radius, recovered: false, ptz: last,
          maxMult: mults[mults.length - 1]!,
          maxDitherNorm: r5(Math.abs(mults[mults.length - 1]!) * u),
          maxDitherDeg: r3(Math.abs(mults[mults.length - 1]!) * u * degPerNorm),
        },
        '미세 디더 재캡처를 모두 소진했으나 대상 미검 → plate_lost 확정',
      );
    }
    return { plate: null, ptz: last, dithers: mults.length - 1 };
  }

  /**
   * (재포착·zoom 축) **줌 스텝 직후 캡처 1회 + 미검 시 승법 zoom 디더 재캡처**.
   *
   * `captureTrack`(tilt 축)과 구조는 같고 **흔드는 축만 다르다**. 이 지점의 프레임은 pan/tilt 이동이 아니라
   * **배율 변경**으로 만들어진 새 프레임이라, 리더 실측에서 tilt 디더 7시도가 전부 실패한 반면
   * zoom +1% 한 칸으로 회복됐다(LPD 의 zoom 축 데드존이 좁고 산발적이다 — `plateRecaptureZoomStep` 주석의 표).
   *
   * ★ prior 는 매 시도 `predictCenterAfterZoom(anchor, cmd.zoom, 디더된 zoom)` 으로 보정한다
   *   (tilt 디더가 `predictPlateCenter` 로 보정하는 것과 같은 원칙 — 흔든 만큼 예측도 옮긴다).
   * ★ 게이트는 **불변** — 호출측이 준 같은 `radius` 를 그대로 넘긴다.
   * ★ `clampZoom` 으로 값이 안 바뀌는 시도(장비 배율 상·하한 포화)는 **캡처하지 않고 건너뛴다** —
   *   같은 프레임을 또 찍는 순수 낭비다(건너뛴 사실은 로그에 남긴다).
   *
   * @param anchor 줌 직후 예측 중심(`predictCenterAfterZoom` 결과) — 디더 보정의 기준점.
   */
  private async captureTrackZoom(
    camIdx: number,
    presetIdx: number,
    cmd: Ptz,
    anchor: Center,
    radius: number | null,
  ): Promise<{ plate: PlateBox | null; ptz: Ptz; dithers: number }> {
    const o = this.opts;
    const mults = [0, ...ditherMultipliers(o.plateRecaptureRetries)];
    let last: Ptz = cmd;
    let dithers = 0;
    for (let i = 0; i < mults.length; i++) {
      // i=0 은 디더 없는 원 캡처 — clampZoom 도 통과시키지 않는다(기존 동작과 완전 동형 보장).
      const factor = 1 + mults[i]! * o.plateRecaptureZoomStep;
      const z = i === 0 ? cmd.zoom : this.camera.clampZoom(cmd.zoom * factor);
      if (i > 0 && Math.abs(z - cmd.zoom) <= ZOOM_EPS) {
        logger.info(
          {
            cat: 'centering', phase: 'recapture', axis: 'zoom', cam: camIdx, preset: presetIdx, attempt: i,
            mult: mults[i]!, factor: r3(factor), zoom: r3(cmd.zoom), skipped: 'clamped',
          },
          'zoom 디더가 clampZoom 포화로 같은 배율 → 캡처 생략',
        );
        continue;
      }
      const prior = predictCenterAfterZoom(anchor, cmd.zoom, z);
      const p: Ptz = { pan: cmd.pan, tilt: cmd.tilt, zoom: z };
      const got = await this.captureDetectPick(camIdx, presetIdx, p, priorRect(prior), radius);
      last = p;
      if (i > 0) dithers += 1;
      if (got.plate) {
        if (i > 0) {
          logger.info(
            {
              cat: 'centering', phase: 'recapture', axis: 'zoom', cam: camIdx, preset: presetIdx, attempt: i,
              mult: mults[i]!, factor: r3(factor), zoomFrom: r3(cmd.zoom), zoom: r3(z), plates: got.count,
              nearestDist: got.nearestDist === null ? null : r3(got.nearestDist), radius, recovered: true,
            },
            'zoom 승법 디더 재캡처로 대상 재포착',
          );
        }
        return { plate: got.plate, ptz: p, dithers };
      }
      if (i < mults.length - 1) {
        const nextFactor = 1 + mults[i + 1]! * o.plateRecaptureZoomStep;
        logger.info(
          {
            cat: 'centering', phase: 'recapture', axis: 'zoom', cam: camIdx, preset: presetIdx, attempt: i,
            plates: got.count, rejected: got.rejected,
            nearestDist: got.nearestDist === null ? null : r3(got.nearestDist), radius,
            prior: { x: r3(prior.cx), y: r3(prior.cy) }, zoom: r3(z), factor: r3(factor),
            nextMult: mults[i + 1]!, nextFactor: r3(nextFactor), nextZoom: r3(cmd.zoom * nextFactor),
          },
          '줌 직후 캡처 미검(검출0 또는 반경기각) → zoom 승법 디더 재캡처 시도',
        );
      }
    }
    if (mults.length > 1) {
      logger.warn(
        {
          cat: 'centering', phase: 'recapture', axis: 'zoom', cam: camIdx, preset: presetIdx,
          attempts: dithers + 1, dithers, radius, recovered: false, ptz: last,
          maxFactor: r3(1 + Math.abs(mults[mults.length - 1]!) * o.plateRecaptureZoomStep),
        },
        'zoom 승법 디더 재캡처를 모두 소진했으나 대상 미검 → plate_lost 확정',
      );
    }
    return { plate: null, ptz: last, dithers };
  }

  /**
   * 명령 PTZ override 로 캡처 → LPD → prior 최근접 번호판(동작은 종전과 동일 — captureDetectPick 의 얇은 래퍼).
   * radius 가 주어지면 prior 로부터 그 거리를 넘는 후보는 기각한다(=대상 소실. 이웃 갈아타기 차단 — §2.5).
   */
  private async captureAndDetect(
    camIdx: number,
    presetIdx: number,
    ptz: Ptz,
    prior: NormalizedRect,
    radius: number | null,
  ): Promise<PlateBox | null> {
    return (await this.captureDetectPick(camIdx, presetIdx, ptz, prior, radius)).plate;
  }

  /**
   * captureAndDetect 본체 + **기각 사유 관측용 부가정보**. 반환 null 이 "검출 0" 인지 "반경 밖 기각" 인지
   * 호출측이 구분할 수 있어야 `no_plate` / `no_plate_near_click` 를 정직하게 가를 수 있다.
   * count(검출 판 개수)·nearestDist(선정 후보까지 거리)는 라이브에서 게이트를 튜닝하기 위한 관측치다.
   */
  private async captureDetectPick(
    camIdx: number,
    presetIdx: number,
    ptz: Ptz,
    prior: NormalizedRect,
    radius: number | null,
  ): Promise<{
    plate: PlateBox | null; rejected: boolean; count: number; nearestDist: number | null;
    /** 진단용: 캡처가 보고한 **장비 실측 PTZ**(명령값이 아니다) + 프레임 지문. */
    act: Ptz; bytes: number; sha: string;
  }> {
    const cap = await this.camera.requestImage(camIdx, presetIdx, ptz);
    this.onFrame?.(cap.jpg, camIdx, presetIdx);
    await this.sleep(this.opts.settleMs);
    const plates = await this.lpd.detect(cap.jpg);
    // 진단(수정 9): 장비 실측 PTZ + 프레임 지문. 인접 rung 이 같은 지문이면 같은 이미지를 분석한 것이다.
    const diag = {
      act: { pan: cap.pan, tilt: cap.tilt, zoom: cap.zoom },
      bytes: cap.jpg.length,
      sha: createHash('sha1').update(cap.jpg).digest('hex').slice(0, 8),
    };
    // 대상선정: peerOffsets 전달 시 자기 Voronoi 셀 소유 판만(이웃 latch 불가), 미전달 시 기존 화면중앙 최근접(하위호환).
    const picked = this.opts.peerOffsets
      ? pickOwnedByOffsets(plates, prior, this.opts.peerOffsets)
      : pickNearestPlate(plates, prior);
    if (!picked) return { plate: null, rejected: false, count: plates.length, nearestDist: null, ...diag };
    const c = centerOfRect(quadBoundingRect(picked.quad));
    const t = centerOfRect(prior);
    const dist = Math.hypot(c.cx - t.cx, c.cy - t.cy);
    if (radius !== null && dist > radius) return { plate: null, rejected: true, count: plates.length, nearestDist: dist, ...diag };
    return { plate: picked, rejected: false, count: plates.length, nearestDist: dist, ...diag };
  }
}

/**
 * (재포착) **에스컬레이팅 디더 배수** 수열 `[+1, −1, +2, −2, +4, −4, …]` 를 n 개. n=0 이면 빈 배열 = 재포착 없음.
 *
 * - **배수를 2배씩 키우는 이유(이터2 — 리더 실측)**: 같은 실패 프레임에서 1.5px(±1)·3px(±2)로는 회복되지 않고
 *   **6px(±4)에서 검출됐다**. 고정 폭이었다면 몇 번을 흔들어도 못 넘는다. 작은 폭부터 시도해 대상 위치를
 *   불필요하게 많이 흔들지 않으면서, 필요한 만큼은 확실히 도달한다.
 * - **부호를 번갈아 내는 이유**: 전부 실패해도 순 이동이 마지막 한 칸(−4u)뿐이라 한 방향으로 누적해
 *   대상을 프레임 밖으로 밀어내지 않는다.
 */
function ditherMultipliers(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const step = 2 ** Math.floor(i / 2);
    out.push(i % 2 === 0 ? step : -step);
  }
  return out;
}

/** 오차 크기(유클리드) 개선량. >0 이면 개선. (PtzCalibrator.ts 와 동일 — 그쪽은 module-private 라 import 불가) */
function improvement(before: { errX: number; errY: number }, after: { errX: number; errY: number }): number {
  const mag = (e: { errX: number; errY: number }) => Math.hypot(e.errX, e.errY);
  return mag(before) - mag(after);
}

/**
 * 소유권(Voronoi) 기반 대상선정 — 이웃 판 latch 차단(설계 이터2 §A-1).
 * self 기준점 = prior 중심(예측 자기중심). peer 앵커 = self + 오프셋(원본 프레임 상대 오프셋, 강체평행이동 불변).
 * 검출 후보 중 자기 앵커가 모든 peer 앵커보다 엄격 최근접인 판만 자기 소유 → 그 중 최근접 1개(없으면 null).
 * ★ 점 형태는 반드시 {x,y}(pickOwnedPlate 규약) — platePtz 내부 {cx,cy}(centerOfRect)와 혼용 금지.
 */
function pickOwnedByOffsets(plates: PlateBox[], prior: NormalizedRect, offsets: readonly NormalizedPoint[]): PlateBox | null {
  const selfRef: NormalizedPoint = { x: prior.x + prior.w / 2, y: prior.y + prior.h / 2 };
  const cands = plates.map((p) => {
    const r = quadBoundingRect(p.quad);
    return { plate: p, centerOrig: { x: r.x + r.w / 2, y: r.y + r.h / 2 } as NormalizedPoint };
  });
  const peerAnchors = offsets.map((o) => ({ x: selfRef.x + o.x, y: selfRef.y + o.y }));
  return pickOwnedPlate(cands, selfRef, peerAnchors);
}

/** 필수 6필드(ok 제외) — 모든 PlatePtzResult 반환점이 공유한다. */
interface PlatePtzResultCore {
  ptz: Ptz;
  plate: PlateBox | null;
  err: { errX: number; errY: number } | null;
  plateWidth: number | null;
  gain: PtzGain;
  iterations: number;
}

/**
 * 결과별 **선택 필드**. 두 가지는 **정직성 관용구가 균일**해 여기서 판정을 중앙화한다:
 *  · `dithers` — 0 초과일 때만 `recaptureDithers` 를 싣는다(그 외엔 필드 자체를 생략 — `in` 검사 보존).
 *  · `restoredToBest` — truthy 일 때만 `restoredToBest:true` 를 싣는다.
 * 나머지(`recenterAttempts`/`widthShortfall`/`centerShortfall`)는 출구마다 존재조건이 **다르므로**
 * 호출부가 `rest` 로 존재여부까지 확정해 넘긴다(균일하지 않은 관용구를 억지로 통일하지 않는다 — deep-equal 보존).
 */
interface PlatePtzResultExtras {
  dithers?: number;
  restoredToBest?: boolean;
  rest?: Partial<PlatePtzResult>;
}

function applyResultExtras(base: PlatePtzResult, extras: PlatePtzResultExtras): PlatePtzResult {
  const dithers = extras.dithers ?? 0;
  return {
    ...base,
    ...(extras.rest ?? {}),
    ...(dithers > 0 ? { recaptureDithers: dithers } : {}),
    ...(extras.restoredToBest ? { restoredToBest: true } : {}),
  };
}

/**
 * @internal 성공 결과 빌더. `ok:true` + 필수 6필드 + (있으면) 선택 필드. 반환객체는 기존 인라인 생성과 deep-equal.
 */
export function okResult(core: PlatePtzResultCore, extras: PlatePtzResultExtras = {}): PlatePtzResult {
  return applyResultExtras({ ok: true, ...core }, extras);
}

/**
 * @internal 실패 결과 빌더. `ok:false` + reason + 필수 6필드 + (있으면) 선택 필드. deep-equal 보존.
 */
export function failResult(
  reason: PlatePtzFailReason,
  core: PlatePtzResultCore,
  extras: PlatePtzResultExtras = {},
): PlatePtzResult {
  return applyResultExtras({ ok: false, ...core, reason }, extras);
}

/**
 * @internal 장비 zoom 한계 확정 결과. **ok 를 호출측이 정하고 reason 은 항상 함께 싣는다** —
 * "장비가 할 수 있는 일을 전부 했다(ok:true)"와 그 사유(zoom_saturated/zoom_resolution_limit)가 공존하는
 * 정직성 관용구다(ok:true + reason). okResult(reason 없음)/failResult(ok:false 고정)로는 표현할 수 없다.
 */
export function limitResult(
  ok: boolean,
  reason: PlatePtzFailReason,
  core: PlatePtzResultCore,
  extras: PlatePtzResultExtras = {},
): PlatePtzResult {
  return applyResultExtras({ ok, ...core, reason }, extras);
}

/**
 * @internal (사다리) zoom **실측 정체** 판정의 순수 수치부. 상태전이(actLive/stall 갱신)는 호출측 루프가 소유하고
 * 이 함수는 다음 상태값과 정체 여부만 계산한다(과분해 금지 — 카운터 변수는 루프에 남는다).
 *
 * prevAct/prevCmd 가 없으면(첫 rung) 판정 불가 → actLive/stall 을 그대로 돌려주고 stalled:false.
 * 그 외엔 원 로직과 동일: 실측이 명령을 한 번이라도 따라오면 actLive, 이후 "명령은 올랐는데 실측 제자리"가
 * 연속 LADDER_ZOOM_STALL_LIMIT 회면 정체로 판정한다.
 */
export function detectZoomStall(
  prevAct: number | null,
  prevCmd: number | null,
  currAct: number,
  currCmd: number,
  actLive: boolean,
  stall: number,
): { actLive: boolean; stall: number; stalled: boolean } {
  if (prevAct === null || prevCmd === null) return { actLive, stall, stalled: false };
  const dAct = Math.abs(currAct - prevAct);
  const dCmd = Math.abs(currCmd - prevCmd);
  const nextActLive = actLive || dAct > LADDER_ZOOM_STALL_EPS;
  const nextStall =
    nextActLive && dCmd > LADDER_ZOOM_STALL_EPS && dAct <= LADDER_ZOOM_STALL_EPS ? stall + 1 : 0;
  return { actLive: nextActLive, stall: nextStall, stalled: nextStall >= LADDER_ZOOM_STALL_LIMIT };
}

/**
 * @internal (사다리) 다음 rung zoom 산출의 순수 수치부. **모델을 가정하지 않는 이분 + 괄호 미형성 외삽**만 결정하고,
 * 복귀(restoreBest)·확정(finalize)·상태 갱신·종료 반환은 호출측 루프가 소유한다(수치부만 추출).
 *
 * ① 실측쌍 괄호(zLo<target<zHi)가 유효하면 **중점 이분**. 선형 외삽(zoomForWidth)을 쓰지 않는 이유는
 *    `width ∝ zoom` 가정이 장비 상단에서 깨져(실측 w/z 5배 변화) 괄호 밖으로 튀는 극한 순환이 생기기 때문이다.
 *    이분은 "zoom↑ ⇒ width↑" 단조성만 요구한다. maxZoomStepRatio 클램프는 **면제**한다 — 괄호 두 끝은 이미
 *    측정·검출된 zoom 이라 "측정 안 한 zoom 으로 크게 튀어 대상을 날린다"는 클램프 근거가 성립하지 않고,
 *    반대로 클램프를 걸면 넓은 괄호의 중점이 막혀 수렴이 정체된다. 장비 범위 클램프(clampZoom)는 그대로 적용.
 *    괄호가 장비 해상도(LADDER_BRACKET_MIN_SPAN)까지 좁혀졌거나 중점이 현재와 같으면 `bracketExhausted`.
 * ② 괄호 미형성(목표의 한쪽만 봄) → 게인무관 직행 목표(zoomForWidth)를 maxZoomStepRatio 로 **대칭** 클램프
 *    (줌아웃 경로 보존 — 근거리 클릭에서 zoom_saturated 회귀 방지).
 */
export function nextLadderZoom(
  zoom: number,
  zLo: number | null,
  zHi: number | null,
  plateWidth: number,
  targetPlateWidth: number,
  maxZoomStepRatio: number,
  clampZoom: (z: number) => number,
): { zNext: number; bracketExhausted: boolean } {
  if (zLo !== null && zHi !== null && zHi - zLo > ZOOM_EPS) {
    const zNext = clampZoom((zLo + zHi) / 2);
    const bracketExhausted = zHi - zLo <= LADDER_BRACKET_MIN_SPAN || Math.abs(zNext - zoom) <= ZOOM_EPS;
    return { zNext, bracketExhausted };
  }
  const zWant = zoomForWidth(zoom, plateWidth, targetPlateWidth, clampZoom);
  const zNext = clampZoom(Math.min(zoom * maxZoomStepRatio, Math.max(zoom / maxZoomStepRatio, zWant)));
  return { zNext, bracketExhausted: false };
}
