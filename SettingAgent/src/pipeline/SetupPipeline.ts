import type { CaptureJob, CaptureSnapshot } from '../capture/CaptureJob.js';
import type { Finalizer } from '../capture/Finalizer.js';
import type { PtzCalibrator } from '../calibrate/PtzCalibrator.js';
import type { PlateDiscoveryJob } from '../calibrate/PlateDiscoveryJob.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import { expandPlateTargetsFromSlotSetup } from '../calibrate/slotPtzWriter.js';
import { logger } from '../util/logger.js';

/**
 * 이 3단계 체인 전용 의존성(전부 기존 객체 재사용 — Finalizer/PtzCalibrator 로직 무수정, 설계서 §3.1).
 * Pick 로 표면을 좁혀 파이프라인이 부르는 메서드만 계약으로 고정한다.
 */
export interface SetupPipelineDeps {
  job: Pick<CaptureJob, 'getSnapshot'>;
  finalizer: Pick<Finalizer, 'finalize'>;
  discovery: Pick<PlateDiscoveryJob, 'start' | 'getStatus'>; // 앞면중심 앵커 loop LPD 탐색(finalize→centering 사이)
  calibrator: Pick<PtzCalibrator, 'start' | 'getStatus'>;
  store: Pick<SqliteStore, 'getSlotSetup'>; // 커버리지 요약(전체 슬롯 수)용
  now?: () => string;
}

export type PipelineStage = 'idle' | 'capturing' | 'finalizing' | 'discovering' | 'calibrating' | 'done' | 'failed';

/** GET /capture/pipeline 응답 shape(설계서 §3.4). 인메모리 status 전용 — 영속화·좌표수치 없음(round5 비대상). */
export interface PipelineStatus {
  armed: boolean; // 이번 run 에 자동 체인이 켜졌는가
  stage: PipelineStage;
  startedAt?: string;
  endedAt?: string;
  failure?: { stage: 'capture' | 'finalize' | 'discover' | 'calibrate'; reason: string };
  finalize?: { slots: number; globalCount: number }; // finalize 성공 시
  /** LPD 홀 정직 리포트(§6): 대상 targets / 전체 totalSlots / 미대상 uncovered. */
  coverage?: { targets: number; totalSlots: number; uncovered: number };
  note?: string; // '센터라이징 스킵 — LPD 보유 슬롯 0' 등
}

/**
 * 원버튼 셋업 파이프라인(신규, 인메모리 상태머신 — 설계서 §3).
 * idle→capturing→finalizing→discovering→calibrating→done|failed. 이 체인 전용(범용 워크플로 엔진 아님, 단계 하드코딩).
 *
 * **비무장(수동 수집) 시 모든 콜백은 no-op** — 수동 3버튼 흐름 회귀 0의 구조적 보장.
 * 실패는 그 단계에서 정지한다(재시도·자동복구 없음 — 위장 성공 금지). 3종 가드:
 *   - dets 0 → finalize 미호출(F10 DELETE+INSERT 데이터 파괴 방지)
 *   - finalize throw → calibrate 미발화·failed{finalize}
 *   - LPD 타깃 0 → calibrator.start 미호출(F6 빈 slot_ptz.json 덮어쓰기 방지) → done+note
 */
export class SetupPipeline {
  private armed = false;
  /** 이번 run 의 VPD 게이트. false=VPD off → F10 dets 가드 우회(finalize 로 slot_setup 행+front_center 부트스트랩). 기본 true. */
  private runVpdEnabled = true;
  private stage: PipelineStage = 'idle';
  private startedAt?: string;
  private endedAt?: string;
  private failure?: { stage: 'capture' | 'finalize' | 'discover' | 'calibrate'; reason: string };
  private finalizeSummary?: { slots: number; globalCount: number };
  private coverage?: { targets: number; totalSlots: number; uncovered: number };
  private note?: string;
  private readonly now: () => string;

  constructor(private deps: SetupPipelineDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** /capture/start 성공 직후 라우트가 호출. armed=true 면 capturing 무장, false 면 disarm+idle 리셋. */
  onCaptureStart(armed: boolean, vpdEnabled = true): void {
    this.armed = armed;
    this.runVpdEnabled = vpdEnabled; // 기본 true(기존 테스트 호출부 무수정). 라우트가 false(제품 정책)를 전달.
    this.failure = undefined;
    this.finalizeSummary = undefined;
    this.coverage = undefined;
    this.note = undefined;
    this.endedAt = undefined;
    if (armed) {
      this.stage = 'capturing';
      this.startedAt = this.now();
    } else {
      this.stage = 'idle';
      this.startedAt = undefined;
    }
  }

  /** CaptureJob 완료 콜백(신규 옵셔널 dep 로 배선). 비무장/비-capturing 이면 no-op. throw 0. */
  onCaptureFinished(status: 'done' | 'stopped' | 'error'): void {
    if (!this.armed || this.stage !== 'capturing') return;
    if (status === 'stopped') {
      this.fail('capture', 'stopped(수동 정지)');
      return;
    }
    if (status === 'error') {
      this.fail('capture', 'capture error');
      return;
    }
    // done — 검출 스냅샷 확인(F10 가드): dets 0 이면 finalize 를 부르지 않는다(DELETE+INSERT DB 파괴 방지).
    // 단, VPD off(제품 정책) 흐름에서는 우회한다 — finalize 가 slot_setup 행+slot3d_front_center 를 까는 유일 부트스트랩
    // 경로이고(결정 E), 이것이 있어야 LPD-only discovery→센터라이징 하류가 성립한다. front_center 는 VPD 무관 기하라
    // 검출 0 이어도 산출되며, hit 없으면 검출 컬럼은 prev 보존(파괴 아님)이라 우회는 안전하다.
    const snapshot = this.deps.job.getSnapshot();
    if (this.runVpdEnabled && snapshot.dets.length === 0) {
      this.fail('finalize', '검출 0건 — finalize 미실행(DB 보호)');
      return;
    }
    this.stage = 'finalizing';
    void this.runFinalizeThenCalibrate(snapshot);
  }

  /**
   * PlateDiscoveryJob 완료 콜백(신규 옵셔널 dep 로 배선). 비무장/비-discovering 이면 no-op.
   * error → 정직 실패(centering 오발화 금지, F6). done → 이제 discovery 가 채운 lpd 로 커버리지 재계산 후 센터라이징.
   */
  onDiscoverFinished(state: 'done' | 'error'): void {
    if (!this.armed || this.stage !== 'discovering') return;
    if (state === 'error') {
      this.fail('discover', 'discover error');
      return;
    }
    // done — 커버리지 산출(§3.6): discovery 가 방금 slot_setup.lpd 를 부분 UPDATE 한 뒤의 상태를 읽는다.
    const views = this.deps.store.getSlotSetup();
    const targets = expandPlateTargetsFromSlotSetup(views);
    this.coverage = { targets: targets.length, totalSlots: views.length, uncovered: views.length - targets.length };

    if (targets.length === 0) {
      // F6 가드: 대상 0 이면 calibrator.start 를 부르지 않는다(빈 slot_ptz.json 덮어쓰기 방지).
      this.note = '센터라이징 스킵 — LPD 보유 슬롯 0';
      this.finish('done');
      return;
    }

    this.stage = 'calibrating';
    try {
      this.deps.calibrator.start(); // 백그라운드 발화 — 완료는 onCalibrateFinished 로 회귀.
    } catch (err) {
      // 수동 센터라이징 경합('already running') 등 → 정직 실패(§5.3).
      this.fail('calibrate', err instanceof Error ? err.message : String(err));
    }
  }

  /** PtzCalibrator 완료 콜백(신규 옵셔널 dep 로 배선). 비무장/비-calibrating 이면 no-op. */
  onCalibrateFinished(state: 'done' | 'error'): void {
    if (!this.armed || this.stage !== 'calibrating') return;
    if (state === 'done') this.finish('done');
    else this.fail('calibrate', 'calibrate error');
  }

  /** finalizing/discovering/calibrating 중이면 true — /capture/start 409 가드 소스. */
  isBusy(): boolean {
    return this.stage === 'finalizing' || this.stage === 'discovering' || this.stage === 'calibrating';
  }

  getStatus(): PipelineStatus {
    return {
      armed: this.armed,
      stage: this.stage,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.finalizeSummary ? { finalize: this.finalizeSummary } : {}),
      ...(this.coverage ? { coverage: this.coverage } : {}),
      ...(this.note ? { note: this.note } : {}),
    };
  }

  /**
   * finalize(동기 계약) → 성공 시 discovery(앞면중심 앵커 loop) 발화. finalizing 진입 후 비동기로 1회 진행.
   * finalize throw → failed{finalize}(discovery 미발화). 커버리지·센터라이징은 discovery 완료(onDiscoverFinished)로 이월:
   * 최종 slot_setup.lpd 는 이제 finalize 가 아니라 discovery 앵커 loop 가 채우기 때문(후보 C).
   */
  private async runFinalizeThenCalibrate(snapshot: CaptureSnapshot): Promise<void> {
    let result: Awaited<ReturnType<Finalizer['finalize']>>;
    try {
      // logicOccupancy 미전달(헤드리스 체인엔 프론트 점유 스냅샷 없음 — occupancyAgreement 미부착이 정상, §3.5).
      result = await this.deps.finalizer.finalize(snapshot, {});
    } catch (err) {
      this.fail('finalize', err instanceof Error ? err.message : String(err));
      return;
    }
    this.finalizeSummary = { slots: result.slots, globalCount: result.globalCount };

    // finalize 가 front_center 를 부트스트랩했으니 discovery 앵커 loop 로 전 프리셋 lpd 를 채운다(→ onDiscoverFinished).
    this.stage = 'discovering';
    try {
      this.deps.discovery.start({}); // 전 프리셋 백그라운드 발화 — 완료는 onDiscoverFinished 로 회귀.
    } catch (err) {
      // 수동 discovery 경합('discover already running') 등 → 정직 실패.
      this.fail('discover', err instanceof Error ? err.message : String(err));
    }
  }

  private fail(stage: 'capture' | 'finalize' | 'discover' | 'calibrate', reason: string): void {
    this.failure = { stage, reason };
    logger.warn({ stage, reason }, '자동 셋업 체인 중단');
    this.finish('failed');
  }

  private finish(stage: 'done' | 'failed'): void {
    this.stage = stage;
    this.endedAt = this.now();
  }
}
