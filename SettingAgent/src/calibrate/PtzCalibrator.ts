import type { CameraClient } from '../clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../clients/LpdClient.js';
import type { SetupBrain, CenteringAdvice } from '../brain/SetupBrain.js';
import type { Repository } from '../store/Repository.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { logger } from '../util/logger.js';
import { expandPlateTargets, writeSlotPtz } from './slotPtzWriter.js';
import {
  plateCenterError,
  pickNearestPlate,
  estimateGain,
  panTiltCorrection,
  zoomCorrection,
  isCentered,
  isWidthConverged,
  dampGain,
  buildSlotPtzJson,
} from './controlMath.js';
import type { PlateTarget, Ptz, SlotPtzItem, CalibrateState, CalibrateStatus } from './types.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PtzCalibratorDeps {
  camera: CameraClient;
  lpd: LpdClient;
  /** LLM 자문(옵셔널). cfg.llmAdvise=false 또는 메서드 null 이면 순수 결정형 폴백. */
  brain?: SetupBrain;
  repo: Repository;
  cfg: ToolsConfig['calibrate'];
  /** slot_ptz.json writer 주입(테스트는 캡처 stub). 기본=writeSlotPtz. */
  writer?: (artifact: ReturnType<typeof buildSlotPtzJson>, outFile: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

/** LLM zoom 배율 제안 클램프 범위(설계서 §3.3). */
const ADVISE_ZOOM_MIN = 0.5;
const ADVISE_ZOOM_MAX = 2.0;

/**
 * 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션 잡(설계서 §1.3·§3.2).
 * CaptureJob 패턴 차용: 단일 인메모리 상태머신, 중복 시작 거부, 슬롯 순차 await.
 *
 * ★ PTZ 상태 추적: 시뮬 응답 PTZ 는 0/0/1 echo 라 신뢰 불가 → 내가 /req_move 로 명령한 값(commanded)을
 *   상태로 추적한다. requestImage 에 명령 PTZ override 를 넘겨 현재 화면을 얻고, 게인은
 *   명령 도(°) 변화 ↔ 관측 번호판 정규화 변위로 측정한다(응답 PTZ 무관).
 *
 * 순서 엄수: pan/tilt 중심정렬(0.5,0.5) 수렴 → zoom(폭 targetPlateWidth). 하이브리드(결정형+LLM 자문),
 * LLM off/실패/검증실패 시 순수 결정형 폴백(항상 동작).
 */
export class PtzCalibrator {
  private state: CalibrateState = 'idle';
  private done = 0;
  private total = 0;
  private current?: { slotId: string };
  private startedAt?: string;
  private endedAt?: string;

  private readonly camera: CameraClient;
  private readonly lpd: LpdClient;
  private readonly brain?: SetupBrain;
  private readonly cfg: ToolsConfig['calibrate'];
  private readonly repo: Repository;
  private readonly writer: (artifact: ReturnType<typeof buildSlotPtzJson>, outFile: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(deps: PtzCalibratorDeps) {
    this.camera = deps.camera;
    this.lpd = deps.lpd;
    this.brain = deps.brain;
    this.cfg = deps.cfg;
    this.repo = deps.repo;
    this.writer = deps.writer ?? writeSlotPtz;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  getStatus(): CalibrateStatus {
    return {
      state: this.state,
      done: this.done,
      total: this.total,
      ...(this.current ? { current: this.current } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
    };
  }

  /**
   * 잡 시작(중복 거부 throw → 라우트 409). 대상=plateRoiByPreset 펼침(필터 slotIds).
   * 슬롯 순차 처리 → buildSlotPtzJson → writer 저장. 백그라운드(await 하지 않고 발화).
   */
  start(slotIds?: string[]): { total: number } {
    if (this.state === 'running') throw new Error('calibrate already running');
    const artifact = this.repo.loadArtifact();
    if (!artifact) throw new Error('no setup artifact');
    let targets = expandPlateTargets(artifact);
    if (slotIds && slotIds.length > 0) {
      const set = new Set(slotIds);
      targets = targets.filter((t) => set.has(t.slotId));
    }
    this.state = 'running';
    this.done = 0;
    this.total = targets.length;
    this.current = undefined;
    this.startedAt = this.now();
    this.endedAt = undefined;
    void this.run(targets);
    return { total: targets.length };
  }

  private async run(targets: PlateTarget[]): Promise<void> {
    const items: SlotPtzItem[] = [];
    try {
      for (const t of targets) {
        this.current = { slotId: t.slotId };
        try {
          items.push(await this.calibrateSlot(t));
        } catch (e) {
          // 개별 슬롯 실패 흡수(경고 + reason, 잡 중단 아님 — CaptureJob captureTarget 패턴).
          logger.warn({ err: e, slot: t.slotId, cam: t.camIdx, preset: t.presetIdx }, '캘리브레이션 슬롯 실패(흡수)');
          items.push(this.skipItem(t, { pan: 0, tilt: 0, zoom: 1 }, 0, 'error'));
        }
        this.done += 1;
      }
      this.writer(buildSlotPtzJson(items, this.now()), this.cfg.outFile);
      this.current = undefined;
      this.endedAt = this.now();
      this.state = 'done';
    } catch (e) {
      logger.error({ err: e }, '캘리브레이션 잡 예외 → error');
      this.endedAt = this.now();
      this.state = 'error';
    }
  }

  /** 슬롯 1건 캘리브레이션(설계서 §1.3 의사코드). 명령 PTZ 추적. */
  private async calibrateSlot(t: PlateTarget): Promise<SlotPtzItem> {
    // 1. 프리셋 PTZ 로 시작(명령 PTZ 추적 시작점). 응답 PTZ 는 신뢰하지 않음(★).
    let ptz: Ptz = { pan: 0, tilt: 0, zoom: 1 };
    let plate = await this.captureAndDetect(t, ptz);
    if (!plate) return this.skipItem(t, ptz, 0, 'no_plate');

    // ── A) pan/tilt 중심 정렬 ───────────────────────────────
    let err = plateCenterError(plate.rect);

    // probe: 작은 dPan/dTilt 1회 → 게인 추정(부호 포함).
    const gainResult = await this.probeGain(t, ptz, err);
    let gain = gainResult.gain;

    let centered = isCentered(err, this.cfg.centerTol);
    for (let iter = 0; iter < this.cfg.maxIterations && !centered; iter++) {
      // (옵셔널) LLM 자문 → 검증·클램프. occluded 면 스킵.
      const advice = await this.advise(t, ptz, err, plate.rect.w, 'center');
      if (advice?.occluded) return this.skipItem(t, ptz, plate.rect.w, 'occluded');

      const next = this.applyCenterAdvice(err, gain, ptz, advice);
      ptz = { ...ptz, pan: next.pan, tilt: next.tilt };
      const got = await this.captureAndDetect(t, ptz);
      if (!got) {
        // 가림/소실 — 마지막 상태 기록.
        return this.skipItem(t, ptz, plate.rect.w, 'plate_lost');
      }
      plate = got;
      const newErr = plateCenterError(plate.rect);
      // 개선 정체 → 게인 감쇠(진동 방지).
      if (improvement(err, newErr) < IMPROVE_EPS) gain = dampGain(gain);
      err = newErr;
      centered = isCentered(err, this.cfg.centerTol);
    }

    // ── B) zoom 폭 정렬(중심 수렴 후에만) ───────────────────
    let plateWidth = plate.rect.w;
    let converged = isWidthConverged(plateWidth, this.cfg.targetPlateWidth, this.cfg.widthTol);
    for (let iter = 0; iter < this.cfg.maxIterations && !converged; iter++) {
      const advice = await this.advise(t, ptz, plateCenterError(plate.rect), plateWidth, 'zoom');
      if (advice?.occluded) break;
      const newZoom = this.applyZoomAdvice(ptz.zoom, plateWidth, advice);
      ptz = { ...ptz, zoom: newZoom };
      const got = await this.captureAndDetect(t, ptz);
      if (!got) break; // 소실 — 마지막 상태 기록
      plate = got;

      // zoom 으로 중심 드리프트 시 1스텝 재중심(과보정 방지 1회).
      const zErr = plateCenterError(plate.rect);
      if (!isCentered(zErr, this.cfg.centerTol)) {
        const rec = panTiltCorrection(zErr, gain, ptz.pan, ptz.tilt, this.cfg.maxStepDeg);
        ptz = { ...ptz, pan: rec.pan, tilt: rec.tilt };
        const reGot = await this.captureAndDetect(t, ptz);
        if (reGot) plate = reGot;
      }

      plateWidth = plate.rect.w;
      converged = isWidthConverged(plateWidth, this.cfg.targetPlateWidth, this.cfg.widthTol);
    }

    return {
      camIdx: t.camIdx,
      presetIdx: t.presetIdx,
      slotId: t.slotId,
      globalIdx: t.globalIdx,
      ptz,
      plateWidth,
      centered,
      converged,
    };
  }

  /** probe 1회 이동 후 게인 추정. probe 후 본 제어 복귀(ptz 는 호출측이 유지). */
  private async probeGain(
    t: PlateTarget,
    ptz: Ptz,
    beforeErr: { errX: number; errY: number },
  ): Promise<{ gain: { gainPan: number; gainTilt: number } }> {
    const fb = { gainPan: this.cfg.fallbackGainPanDeg, gainTilt: this.cfg.fallbackGainTiltDeg };
    const probePtz: Ptz = {
      pan: ptz.pan + this.cfg.probeStepDeg,
      tilt: ptz.tilt + this.cfg.probeStepDeg,
      zoom: ptz.zoom,
    };
    const probePlate = await this.captureAndDetect(t, probePtz);
    if (!probePlate) return { gain: fb };
    const afterErr = plateCenterError(probePlate.rect);
    const gain = estimateGain(beforeErr, afterErr, { dPan: this.cfg.probeStepDeg, dTilt: this.cfg.probeStepDeg }, fb);
    return { gain };
  }

  /** 명령 PTZ override 로 캡처 → LPD → 대상 prior 최근접 번호판(없으면 null). */
  private async captureAndDetect(t: PlateTarget, ptz: Ptz): Promise<PlateBox | null> {
    const cap = await this.camera.requestImage(t.camIdx, t.presetIdx, ptz);
    await this.sleep(this.cfg.settleMs);
    const plates = await this.lpd.detect(cap.jpg);
    return pickNearestPlate(plates, t.plateRoi);
  }

  /** LLM 자문(cfg.llmAdvise && brain.adviseCentering 존재 시만). 실패·검증실패 → null. */
  private async advise(
    t: PlateTarget,
    ptz: Ptz,
    err: { errX: number; errY: number },
    plateWidth: number,
    phase: 'center' | 'zoom',
  ): Promise<CenteringAdvice | null> {
    if (!this.cfg.llmAdvise || !this.brain?.adviseCentering) return null;
    try {
      const cap = await this.camera.requestImage(t.camIdx, t.presetIdx, ptz);
      return await this.brain.adviseCentering({
        imageBase64: cap.jpg.toString('base64'),
        err,
        plateWidth,
        target: { centerTol: this.cfg.centerTol, targetWidth: this.cfg.targetPlateWidth },
        phase,
      });
    } catch (e) {
      logger.warn({ err: e, slot: t.slotId }, '자문 실패(결정형 폴백)');
      return null;
    }
  }

  /** 중심정렬 적용: 자문 제안(클램프) 우선, 없으면 비례제어. */
  private applyCenterAdvice(
    err: { errX: number; errY: number },
    gain: { gainPan: number; gainTilt: number },
    ptz: Ptz,
    advice: CenteringAdvice | null,
  ): { pan: number; tilt: number } {
    const base = panTiltCorrection(err, gain, ptz.pan, ptz.tilt, this.cfg.maxStepDeg);
    if (advice && (advice.suggestPan !== undefined || advice.suggestTilt !== undefined)) {
      const dPan = clampStep(advice.suggestPan ?? 0, this.cfg.maxStepDeg);
      const dTilt = clampStep(advice.suggestTilt ?? 0, this.cfg.maxStepDeg);
      return { pan: ptz.pan + dPan, tilt: ptz.tilt + dTilt };
    }
    return base;
  }

  /** zoom 적용: 자문 배율(0.5~2.0 클램프) 우선, 없으면 결정형 공식. */
  private applyZoomAdvice(curZoom: number, plateWidth: number, advice: CenteringAdvice | null): number {
    if (advice?.suggestZoomFactor !== undefined) {
      const factor = Math.min(ADVISE_ZOOM_MAX, Math.max(ADVISE_ZOOM_MIN, advice.suggestZoomFactor));
      return this.camera.clampZoom(curZoom * factor);
    }
    return zoomCorrection(curZoom, plateWidth, this.cfg.targetPlateWidth, (z) => this.camera.clampZoom(z));
  }

  private skipItem(t: PlateTarget, ptz: Ptz, plateWidth: number, reason: string): SlotPtzItem {
    return {
      camIdx: t.camIdx,
      presetIdx: t.presetIdx,
      slotId: t.slotId,
      globalIdx: t.globalIdx,
      ptz,
      plateWidth,
      centered: false,
      converged: false,
      reason,
    };
  }
}

/** 개선 정체 판정 임계(이전 대비 오차 크기 감소량). */
const IMPROVE_EPS = 1e-3;

function clampStep(v: number, maxStep: number): number {
  return Math.min(maxStep, Math.max(-maxStep, v));
}

/** 오차 크기(유클리드) 개선량. >0 이면 개선. */
function improvement(before: { errX: number; errY: number }, after: { errX: number; errY: number }): number {
  const mag = (e: { errX: number; errY: number }) => Math.hypot(e.errX, e.errY);
  return mag(before) - mag(after);
}
