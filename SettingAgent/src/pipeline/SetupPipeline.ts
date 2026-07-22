import type { CaptureJob, CaptureSnapshot } from '../capture/CaptureJob.js';
import type { Finalizer } from '../capture/Finalizer.js';
import type { PtzCalibrator } from '../calibrate/PtzCalibrator.js';
import type { PlateDiscoveryJob } from '../calibrate/PlateDiscoveryJob.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { ICameraClient } from '../clients/CameraClient.js';
import { expandPlateTargetsFromSlotSetup } from '../calibrate/slotPtzWriter.js';
import { expandDiscoveryTargets } from '../calibrate/plateDiscoveryWriter.js';
import { logger } from '../util/logger.js';

/**
 * 정밀수집(startPrecise) 전용 대기시간 코드 상수(요구1·2·3·6).
 * ★ 잡 인스턴스(dep)가 아니라 **start() 인자**로만 전달한다 — 수동 `/discover/ptz`·`/calibrate/ptz` 는
 *   인자 미전달로 기본 0 이 되어 회귀가 **구조적으로** 0 이다(같은 싱글턴을 공유하기 때문).
 */
const PRECISE_DISCOVER_BETWEEN_SLOT_MS = 500; // 요구1: 슬롯당 LPD 1건 후.
const PRECISE_OCCUPY_SETTLE_MS = 300; // 요구2: 점유영역 생성 후(프리셋 그룹 단위 — 생성이 프레임 집합연산).
const PRECISE_DISCOVER_TO_CALIBRATE_MS = 1000; // 요구3: 탐색 완료 → 센터라이징 시작.
const PRECISE_CALIBRATE_BETWEEN_SLOT_MS = 1000; // 요구6: 센터라이징 슬롯 1건 후.

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** 단계 전이 대기(요구3). 미주입 시 setTimeout — 테스트 시임 경계. */
  sleep?: (ms: number) => Promise<void>;
}

export type PipelineStage = 'idle' | 'capturing' | 'finalizing' | 'discovering' | 'calibrating' | 'done' | 'failed';

/** GET /capture/pipeline 응답 shape(설계서 §3.4). 인메모리 status 전용 — 영속화·좌표수치 없음(round5 비대상). */
export interface PipelineStatus {
  armed: boolean; // 이번 run 에 자동 체인이 켜졌는가
  /** 이번 run 이 정밀수집(startPrecise) 경로인가 — 프론트 완료 메시지 분기용(수집 경로에선 미부착). */
  precise?: boolean;
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
  private readonly sleep: (ms: number) => Promise<void>;
  /** 이번 run 이 정밀수집(startPrecise) 경로인가 — 대기시간·카메라 오버라이드 적용 게이트. */
  private precise = false;
  /** 정밀수집 run 의 카메라 오버라이드(요청 source). 미지정 시 잡의 부팅 카메라. */
  private preciseCamera?: ICameraClient;
  /** 센터라이징 분리(UI '센터라이징 분리' 체크) — true 면 탐색·점유영역까지만 돌고 센터라이징 전에 done. */
  private preciseSkipCentering = false;

  constructor(private deps: SetupPipelineDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * ★ 정밀수집 진입점(W1 — 신규 가산). 수집(CaptureJob)·최종화(Finalizer) 없이
   * **discovering → (1s) → calibrating → done** 만 돈다. 내부는 전부 기존 메서드 호출이다:
   * preflight 는 `expandDiscoveryTargets`(탐색 대상 조건과 **같은 함수**), 이후 체인은 기존
   * `onDiscoverFinished`/`onCalibrateFinished` 콜백 그대로.
   *
   * preflight 실패(앞면중심 0)는 **조용히 넘어가지 않는다** — 잡을 발화하지 않고 failed{discover} 로 끝낸다
   * (탐색 대상 0 으로 잡이 즉시 done 나면 사용자는 "돌았는데 아무것도 안 나왔다"로 오독한다).
   */
  startPrecise(opts: { camera?: ICameraClient; skipCentering?: boolean } = {}): PipelineStatus {
    if (this.isBusy()) throw new Error('pipeline busy');
    this.armed = true;
    this.precise = true;
    this.preciseCamera = opts.camera;
    this.preciseSkipCentering = opts.skipCentering === true;
    this.runVpdEnabled = false; // 정밀수집 경로는 VPD 를 한 번도 호출하지 않는다(LPD 전용).
    this.failure = undefined;
    this.finalizeSummary = undefined;
    this.coverage = undefined;
    this.note = undefined;
    this.endedAt = undefined;
    this.startedAt = this.now();
    const targets = expandDiscoveryTargets(this.deps.store.getSlotSetup());
    if (targets.length === 0) {
      this.stage = 'discovering'; // fail() 이 stage 를 failed 로 덮는다 — 사유 기록용 진입.
      this.fail('discover', '앞면중심 0 — ROI 파일 로딩 먼저(지면모델 확인)');
      return this.getStatus();
    }
    this.stage = 'discovering';
    try {
      this.deps.discovery.start(
        {},
        { betweenSlotMs: PRECISE_DISCOVER_BETWEEN_SLOT_MS, occupySettleMs: PRECISE_OCCUPY_SETTLE_MS },
      );
    } catch (err) {
      this.fail('discover', err instanceof Error ? err.message : String(err));
    }
    return this.getStatus();
  }

  /** /capture/start 성공 직후 라우트가 호출. armed=true 면 capturing 무장, false 면 disarm+idle 리셋. */
  onCaptureStart(armed: boolean, vpdEnabled = true): void {
    this.armed = armed;
    this.precise = false; // 수집 경로 — 정밀수집 전용 대기·카메라 오버라이드 해제.
    this.preciseCamera = undefined;
    this.preciseSkipCentering = false;
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
    // 요구3: 정밀수집 경로만 탐색 완료 → 센터라이징 시작 사이 1s 대기. 수집(autoChain) 경로는 즉시 전이(회귀 0).
    // 단 '센터라이징 분리' 면 센터라이징에 들어가지 않으므로 진입 대기도 불필요하다(즉시 마감).
    if (this.precise && !this.preciseSkipCentering) {
      void this.beginCalibrateAfterDelay();
      return;
    }
    this.beginCalibrate();
  }

  /** 요구3 대기 후 센터라이징 진입. 대기 중 단계가 바뀌었으면(정지·실패) 발화하지 않는다. */
  private async beginCalibrateAfterDelay(): Promise<void> {
    await this.sleep(PRECISE_DISCOVER_TO_CALIBRATE_MS);
    if (this.stage !== 'discovering') return;
    this.beginCalibrate();
  }

  /** 커버리지 산출 → 센터라이징 발화(구 onDiscoverFinished 후반부 — 로직 무변경, 대기 삽입 위해 분리). */
  private beginCalibrate(): void {
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

    // '센터라이징 분리'(사용자 옵트인): 탐색·점유영역까지가 이번 run 의 끝이다. calibrator 를 발화하지 않으므로
    // slot_ptz.json·setup_result.json 도 생성되지 않는다(기존 센터링 값은 무접촉 — 파괴 없음).
    if (this.preciseSkipCentering) {
      this.note = `센터라이징 분리 — 탐색·점유영역까지 완료(센터라이징 대상 ${targets.length}슬롯 대기)`;
      this.finish('done');
      return;
    }

    this.stage = 'calibrating';
    try {
      // 백그라운드 발화 — 완료는 onCalibrateFinished 로 회귀. 정밀수집만 대기·카메라 오버라이드를 실어 보낸다
      // (수집 경로는 인자 없이 호출 → 기존 시그니처·거동 그대로).
      if (this.precise) {
        this.deps.calibrator.start(undefined, {
          betweenSlotMs: PRECISE_CALIBRATE_BETWEEN_SLOT_MS,
          ...(this.preciseCamera ? { camera: this.preciseCamera } : {}),
        });
      } else {
        this.deps.calibrator.start();
      }
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
      ...(this.precise ? { precise: true } : {}), // 수집 경로 응답 shape 불변(회귀 0).
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
