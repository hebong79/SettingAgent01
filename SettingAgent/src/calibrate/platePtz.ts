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

import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../clients/LpdClient.js';
import type { NormalizedRect } from '../domain/types.js';
import { logger } from '../util/logger.js';
import { quadBoundingRect } from '../domain/geometry.js';
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
  /** 1스텝 zoom 증배 상한(대칭: [z/r, z·r]). 기본 1.5 — 큰 점프는 중심 오차를 같은 배율로 확대해 대상을 날린다. */
  maxZoomStepRatio?: number;
}

export type PlatePtzFailReason = 'no_plate' | 'plate_lost' | 'max_iterations' | 'zoom_saturated';

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
  gain?: PtzGain;
}

/** 개선 정체 판정 임계(PtzCalibrator.ts 와 동일 값 — 그쪽은 module-private 라 import 불가). */
const IMPROVE_EPS = 1e-3;
/**
 * 게인 감쇠 누적 상한(설계 §2.1). 상한이 없으면 개선 정체가 이어질 때 매 반복 damp →
 * 0.5^15 ≈ 3e-5 로 게인이 소멸 → PTZ 정지 → improvement=0 → 영구 damp(회복 불가, 실측 A 실패).
 */
const DAMP_LIMIT = 3;

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
      ...(opts.gain ? { gain: opts.gain } : {}),
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
   * @returns 실패 시 reason: 'no_plate'(시작부터 미검출) | 'plate_lost'(도중 소실·매칭 기각) | 'max_iterations'.
   *          결과의 gain 을 zoomToPlateWidth 의 opts.gain 으로 넘기면 실측 게인이 재사용된다(zoom 스케일 자동).
   */
  async centerOnPlate(camIdx: number, presetIdx: number, startPtz: Ptz): Promise<PlatePtzResult> {
    const o = this.opts;
    // fallback 은 zoomRef=1 정의 → 시작 zoom 으로 스케일해 두면 루프 전체가 동일 기준(zoomRef=startPtz.zoom).
    const fbBase: PtzGain = { gainPan: o.fallbackGainPanDeg, gainTilt: o.fallbackGainTiltDeg, zoomRef: 1 };
    const fb: PtzGain = { ...scaleGainForZoom(fbBase, startPtz.zoom), zoomRef: startPtz.zoom };
    let ptz: Ptz = { ...startPtz };

    // 초기 대상 선정만 plateRoi prior(반경 기각 없음) — 이후는 예측 추적(§2.5).
    let plate = await this.captureAndDetect(camIdx, presetIdx, ptz, o.plateRoi, null);
    if (!plate) return { ok: false, ptz, plate: null, err: null, plateWidth: null, gain: fb, iterations: 0, reason: 'no_plate' };

    let pr = quadBoundingRect(plate.quad);
    let err = plateCenterError(pr);
    if (isCentered(err, o.centerTol)) {
      // 이미 수렴 — probe 캡처 생략.
      return { ok: true, ptz, plate, err, plateWidth: pr.w, gain: fb, iterations: 0 };
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

    for (let iter = 0; iter < o.maxIterations; iter++) {
      const next = panTiltCorrection(err, gain, ptz.pan, ptz.tilt, o.maxStepDeg);
      // zoom 은 startPtz.zoom 고정(계약: 이 함수는 zoom 을 절대 바꾸지 않는다).
      const cmd: Ptz = { pan: next.pan, tilt: next.tilt, zoom: startPtz.zoom };
      // 예측 prior: 직전 관측 위치 + (관측 시점 → 이번 명령) delta 의 예측 변위.
      const prior = predictPlateCenter(obsCenter, { dPan: cmd.pan - obsPtz.pan, dTilt: cmd.tilt - obsPtz.tilt }, gain);
      ptz = cmd;
      const got = await this.captureAndDetect(camIdx, presetIdx, ptz, priorRect(prior), o.matchRadiusNorm);
      if (!got) {
        return { ok: false, ptz, plate, err, plateWidth: pr.w, gain, iterations: iter + 1, reason: 'plate_lost' };
      }
      plate = got;
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
        return { ok: true, ptz, plate, err, plateWidth: pr.w, gain, iterations: iter + 1 };
      }
    }
    logger.warn({ cat: 'centering', phase: 'center', cam: camIdx, preset: presetIdx, errX: err.errX, errY: err.errY }, '번호판 센터링 반복 상한 소진');
    return { ok: false, ptz, plate, err, plateWidth: pr.w, gain, iterations: o.maxIterations, reason: 'max_iterations' };
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
    if (!plate) return { ok: false, ptz, plate: null, err: null, plateWidth: null, gain: gainRef, iterations: 0, reason: 'no_plate' };

    let pr = quadBoundingRect(plate.quad);
    let obsCenter = centerOfRect(pr);
    let obsPtz: Ptz = { ...ptz };
    let plateWidth = pr.w;
    let err = plateCenterError(pr);
    if (isWidthConverged(plateWidth, o.targetPlateWidth, o.widthTol)) {
      return { ok: true, ptz, plate, err, plateWidth, gain: gainRef, iterations: 0 };
    }

    for (let iter = 0; iter < o.maxIterations; iter++) {
      const effGain = scaleGainForZoom(gainRef, ptz.zoom);

      // [가드 선행] 중심이 tol 밖이면 이번 반복은 줌을 올리지 않고 1스텝 재중심만 한다.
      if (!isCentered(err, o.centerTol)) {
        const rec = panTiltCorrection(err, effGain, ptz.pan, ptz.tilt, o.maxStepDeg);
        const cmd: Ptz = { pan: rec.pan, tilt: rec.tilt, zoom: ptz.zoom };
        const prior = predictPlateCenter(obsCenter, { dPan: cmd.pan - obsPtz.pan, dTilt: cmd.tilt - obsPtz.tilt }, effGain);
        ptz = cmd;
        const got = await this.captureAndDetect(camIdx, presetIdx, ptz, priorRect(prior), o.matchRadiusNorm);
        if (!got) {
          return { ok: false, ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1, reason: 'plate_lost' };
        }
        plate = got;
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
        return { ok: false, ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1, reason: 'zoom_saturated' };
      }
      const prior = predictCenterAfterZoom(obsCenter, ptz.zoom, newZoom);
      ptz = { ...ptz, zoom: newZoom };
      const got = await this.captureAndDetect(camIdx, presetIdx, ptz, priorRect(prior), o.matchRadiusNorm);
      if (!got) {
        return { ok: false, ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1, reason: 'plate_lost' };
      }
      plate = got;
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
        return { ok: true, ptz, plate, err, plateWidth, gain: gainRef, iterations: iter + 1 };
      }
    }
    logger.warn({ cat: 'centering', phase: 'zoom', cam: camIdx, preset: presetIdx, plateWidth }, '번호판 줌 반복 상한 소진');
    return { ok: false, ptz, plate, err, plateWidth, gain: gainRef, iterations: o.maxIterations, reason: 'max_iterations' };
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
   * 명령 PTZ override 로 캡처 → LPD → prior 최근접 번호판.
   * radius 가 주어지면 prior 로부터 그 거리를 넘는 후보는 기각한다(=대상 소실. 이웃 갈아타기 차단 — §2.5).
   */
  private async captureAndDetect(
    camIdx: number,
    presetIdx: number,
    ptz: Ptz,
    prior: NormalizedRect,
    radius: number | null,
  ): Promise<PlateBox | null> {
    const cap = await this.camera.requestImage(camIdx, presetIdx, ptz);
    this.onFrame?.(cap.jpg, camIdx, presetIdx);
    await this.sleep(this.opts.settleMs);
    const plates = await this.lpd.detect(cap.jpg);
    const picked = pickNearestPlate(plates, prior);
    if (!picked || radius === null) return picked;
    const c = centerOfRect(quadBoundingRect(picked.quad));
    const t = centerOfRect(prior);
    return Math.hypot(c.cx - t.cx, c.cy - t.cy) <= radius ? picked : null;
  }
}

/** 오차 크기(유클리드) 개선량. >0 이면 개선. (PtzCalibrator.ts 와 동일 — 그쪽은 module-private 라 import 불가) */
function improvement(before: { errX: number; errY: number }, after: { errX: number; errY: number }): number {
  const mag = (e: { errX: number; errY: number }) => Math.hypot(e.errX, e.errY);
  return mag(before) - mag(after);
}
