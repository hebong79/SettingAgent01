import type { CameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { SqliteStore } from './SqliteStore.js';
import type { CheckpointReviewer } from './CheckpointReviewer.js';
import { advisoryLines } from './CheckpointReviewer.js';
import { aggregate, type AggregateOptions } from './Aggregator.js';
import type { SetupTarget } from '../setup/SetupOrchestrator.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CaptureState, CaptureStatus } from './types.js';
import { logger } from '../util/logger.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CaptureJobDeps {
  camera: CameraClient;
  vpd: VpdClient;
  lpd?: LpdClient;
  store: SqliteStore;
  reviewer?: CheckpointReviewer;
  cfg: ToolsConfig['capture'];
  /** LPD 번호판도 함께 검출·적재할지(setup.lpdEnabled 재사용). */
  lpdEnabled: boolean;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (h: NodeJS.Timeout) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  /** 프리셋별 기대 면 수(체크포인트 자문용, 선택). */
  expectedByPreset?: Record<string, number>;
}

export interface CaptureStartParams {
  count: number;
  intervalMs: number;
  checkpointEvery: number;
  targets: SetupTarget[];
}

/**
 * 장기 관측·반복 수집 잡(상태머신, 설계서 §4.1).
 * idle→running→(stopping)→finalizing→done|stopped|error. 단일 인메모리 잡(중복 시작 거부).
 * 매 라운드: 프리셋 순회 캡처 → VPD(+LPD) 검출 → SQLite 적재. K라운드마다 집계+(LLM 체크포인트).
 * 주기 타이머·sleep·now 주입(fake timers 테스트).
 */
export class CaptureJob {
  private state: CaptureState = 'idle';
  private runId?: number;
  private round = 0;
  private done = 0;
  private planned = 0;
  private latestAdvisory: string[] = [];
  private timer?: NodeJS.Timeout;
  private params?: CaptureStartParams;
  private roundRunning = false;

  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (h: NodeJS.Timeout) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(private deps: CaptureJobDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  getRunId(): number | undefined {
    return this.runId;
  }

  /** 현재 상태(타입 협소화 우회 — await 사이 stop() 변경 반영). */
  private currentState(): CaptureState {
    return this.state;
  }

  getStatus(): CaptureStatus {
    return {
      state: this.state,
      ...(this.runId !== undefined ? { runId: this.runId } : {}),
      round: this.round,
      done: this.done,
      planned: this.planned,
      ...(this.latestAdvisory.length > 0 ? { latestAdvisory: [...this.latestAdvisory] } : {}),
    };
  }

  /** 잡 시작. running/stopping/finalizing 중이면 거부(throw). */
  start(p: CaptureStartParams): { runId: number } {
    if (this.state === 'running' || this.state === 'stopping' || this.state === 'finalizing') {
      throw new Error('capture already running');
    }
    this.params = p;
    this.round = 0;
    this.done = 0;
    this.planned = p.count;
    this.latestAdvisory = [];
    this.runId = this.deps.store.createRun({ plannedCount: p.count, intervalMs: p.intervalMs, startedAt: this.now() });
    this.state = 'running';
    // 첫 라운드는 즉시 발화(주기 0 대기), 이후 intervalMs.
    this.timer = this.setTimer(() => void this.runRound(), 0);
    return { runId: this.runId };
  }

  /** 수동 정지: running→stopping(현재 라운드 마치면 stopped). */
  stop(): void {
    if (this.state !== 'running') return;
    this.state = 'stopping';
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    // 라운드 진행 중이 아니면 즉시 종료(다음 발화 없음).
    if (!this.roundRunning) this.finishRun('stopped', 'manual');
  }

  private finishRun(status: 'done' | 'stopped' | 'error', reason: 'count' | 'manual' | 'error'): void {
    if (this.runId !== undefined) {
      this.deps.store.endRun(this.runId, { status, stopReason: reason, endedAt: this.now() });
    }
    this.state = status;
  }

  private aggOptions(): AggregateOptions {
    return {
      clusterDist: this.deps.cfg.clusterDist,
      clusterMinSupport: this.deps.cfg.clusterMinSupport,
      minConfidence: this.deps.cfg.minConfidence,
    };
  }

  /** 한 라운드: 프리셋 순회 캡처·검출·적재 → 진행 갱신 → (K마다) 집계+체크포인트. */
  private async runRound(): Promise<void> {
    if (this.state !== 'running' || !this.params || this.runId === undefined) return;
    this.roundRunning = true;
    const roundIdx = this.round + 1;
    try {
      for (const t of this.params.targets) {
        try {
          await this.captureTarget(this.runId, roundIdx, t);
        } catch (e) {
          // 개별 프리셋 캡처 실패는 경고로 흡수(잡 중단 아님 — detectPlates 패턴).
          logger.warn({ err: e, cam: t.camIdx, preset: t.presetIdx }, '캡처 라운드 프리셋 실패(흡수)');
        }
      }
      this.round = roundIdx;
      this.done = roundIdx;
      this.deps.store.updateRunProgress(this.runId, this.done);

      // K라운드마다 집계 + (LLM 체크포인트).
      if (this.done % this.params.checkpointEvery === 0) {
        await this.checkpoint(roundIdx);
      }
    } catch (e) {
      logger.error({ err: e }, '캡처 라운드 예외 → error');
      this.roundRunning = false;
      this.finishRun('error', 'error');
      return;
    }
    this.roundRunning = false;

    // 정지 요청 중이면 여기서 종료(stopped). stop() 이 await 중 state 를 바꿀 수 있어 현재 값으로 확인.
    if (this.currentState() === 'stopping') {
      this.finishRun('stopped', 'manual');
      return;
    }
    // 계획 횟수 도달 → 자동 완료(finalize 는 별도 호출).
    if (this.done >= this.planned) {
      this.finishRun('done', 'count');
      return;
    }
    // 다음 라운드 예약.
    this.timer = this.setTimer(() => void this.runRound(), this.params.intervalMs);
  }

  private async captureTarget(runId: number, roundIdx: number, t: SetupTarget): Promise<void> {
    const cap = await this.deps.camera.requestImage(t.camIdx, t.presetIdx, t.ptz);
    const obsId = this.deps.store.insertObservation({
      runId,
      roundIdx,
      camIdx: t.camIdx,
      presetIdx: t.presetIdx,
      capturedAt: this.now(),
      pan: cap.pan,
      tilt: cap.tilt,
      zoom: cap.zoom,
      imgName: cap.imgName,
    });

    const vehicles = await this.deps.vpd.detect(cap.jpg);
    const dets: Array<{ kind: 'vehicle' | 'plate'; x: number; y: number; w: number; h: number; conf: number }> =
      vehicles.map((v) => ({
        kind: 'vehicle',
        x: v.rect.x,
        y: v.rect.y,
        w: v.rect.w,
        h: v.rect.h,
        conf: v.confidence,
      }));

    if (this.deps.lpdEnabled && this.deps.lpd) {
      try {
        const plates = await this.deps.lpd.detect(cap.jpg);
        for (const p of plates) {
          dets.push({ kind: 'plate', x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h, conf: p.confidence });
        }
      } catch (e) {
        logger.warn({ err: e, cam: t.camIdx, preset: t.presetIdx }, 'LPD 검출 실패(번호판 생략)');
      }
    }

    if (dets.length > 0) this.deps.store.insertDetections(obsId, t.camIdx, t.presetIdx, dets);
  }

  /** 집계 후 체크포인트(LLM 활성 시 자문 갱신). 좌표 불변. */
  private async checkpoint(roundIdx: number): Promise<void> {
    if (this.runId === undefined) return;
    const dets = this.deps.store.getDetectionsForRun(this.runId);
    const presetRounds = this.deps.store.getPresetRounds(this.runId);
    const slots = aggregate(dets, presetRounds, this.aggOptions());
    this.deps.store.replaceAggregatedSlots(this.runId, slots);

    if (this.deps.reviewer) {
      const result = await this.deps.reviewer.review(
        this.runId,
        roundIdx,
        this.planned,
        slots,
        this.newFacesRecentK(),
        this.deps.expectedByPreset,
      );
      if (result) this.latestAdvisory = advisoryLines(result);
    }
  }

  /** 최근 K회 신규 면 수(수렴 신호). 1차는 단순화 — 현재 후보 면 수를 신호로 전달. */
  private newFacesRecentK(): number {
    if (this.runId === undefined) return 0;
    return this.deps.store.getAggregatedSlots(this.runId).filter((s) => s.status !== 'rejected').length;
  }
}
