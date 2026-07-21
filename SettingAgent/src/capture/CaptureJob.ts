import type { ICameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { OccupancyReviewer } from './OccupancyReviewer.js';
import type { SetupBrain, OccupancyJudgment } from '../brain/SetupBrain.js';
import { aggregate, type AggregateOptions } from './Aggregator.js';
import type { SetupTarget } from '../setup/SetupOrchestrator.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CaptureState, CaptureStatus, DetectionRow, AggregatedSlot } from './types.js';
import type { NormalizedPoint, NormalizedQuad, VehicleBox } from '../domain/types.js';
import type { PlateBox } from '../clients/LpdClient.js';
import { quadBoundingRect } from '../domain/geometry.js';
import { loadNormalizedPlaceRoi, type NormalizedPlaceRoi } from './placeRoi.js';
import { filterVehiclesOnPlace, filterPlatesOnPlace } from './onPlaceFilter.js';
import { buildFrameCuboids, type CuboidContext, type FrameCuboids } from '../ground/frameCuboids.js';
import { logger } from '../util/logger.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CaptureJobDeps {
  camera: ICameraClient;
  vpd: VpdClient;
  lpd?: LpdClient;
  /** 차량 점유율(LLM 판정) 체크포인트 계산기(옵셔널 — 인메모리 occByPreset 축소 보조. 미주입/LLM off 시 no-op). */
  occupancyReviewer?: OccupancyReviewer;
  /** LLM 두뇌(옵셔널 — warm-up 강제 구동용. warmup 미구현/비활성 시 no-op). */
  brain?: SetupBrain;
  cfg: ToolsConfig['capture'];
  /** LPD 번호판도 함께 검출·적재할지(setup.lpdEnabled 재사용). */
  lpdEnabled: boolean;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (h: NodeJS.Timeout) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  /** 단조 증가 숫자 시계(ms). 프리셋 이동 페이싱 elapsed 산술용(기본 Date.now). 테스트 결정성. */
  monotonic?: () => number;
  /** 프리셋별 기대 면 수(체크포인트 자문용, 선택). */
  expectedByPreset?: Record<string, number>;
  /** 미리 정의된 주차면 폴리곤 파일(PtzCamRoi.json). 모드A(주차면 위 차량만) 필터 소스. 미주입 시 강등(전량 통과). */
  placeRoiFile?: string;
  /**
   * ★ 차량 육면체 문맥 해결자(옵셔널·가산). 주입 시 **매 라운드** 프리셋마다 seg 를 1회 더 불러 육면체를 산출한다.
   * 미주입(또는 `ground.enabled=false` → 라우트가 미주입) → **육면체 전 기능 off**(신규 설정 플래그 0 — 기존 킬스위치 재사용).
   * 산출물은 **인메모리**에만 둔다(DB 무접촉). 실패는 전부 흡수 — **잡은 절대 죽지 않는다**.
   */
  cuboidCtx?: (camIdx: number, presetIdx: number) => Promise<CuboidContext | null>;
  /**
   * ★ 잡 종단 완료 콜백(옵셔널·가산 — 원버튼 셋업 파이프라인 배선). done/stopped/error 로 1회 통지.
   * 미주입 시 no-op(수동 흐름 회귀 0). throw 는 흡수한다 — 콜백이 잡을 죽이지 않는다.
   */
  onFinished?: (status: 'done' | 'stopped' | 'error') => void;
}

/** 잡이 들고 있는 프리셋별 최신 육면체(인메모리 — DB 저장 금지). `GET /capture/job-cuboids` 가 읽는다. */
export type JobCuboids = FrameCuboids & { camIdx: number; presetIdx: number; roundIdx: number; capturedAt: string };

/**
 * finalize 로 넘기는 인메모리 런 스냅샷(설계서 §2.3 — DB 중간테이블 폐기 대체).
 * dets/presetRounds = 결정형 집계 재계산 입력. aggregated = 마지막 체크포인트 집계(status 보존 병합용).
 * occByPreset = 축소 occupancy 보조(LLM off 시 빈 맵).
 */
export interface CaptureSnapshot {
  dets: DetectionRow[];
  presetRounds: Map<string, number>;
  aggregated: AggregatedSlot[];
  occByPreset: Map<string, OccupancyJudgment>;
}

export interface CaptureStartParams {
  count: number;
  intervalMs: number;
  checkpointEvery: number;
  /** 체크포인트 트리거 모드: 'rounds'(done%K==0) | 'time'(경과 ≥ intervalMs). */
  checkpointTriggerMode: 'rounds' | 'time';
  /** time 모드 주기(ms). rounds 모드에서는 무시. */
  checkpointIntervalMs: number;
  targets: SetupTarget[];
  /** 바닥 ROI 소스 모드(옵셔널). 미지정/true=LLM floor 생성, false=파일 모드(LLM floor 스킵). 기본 true. */
  floorRoiUseLlm?: boolean;
  /** VPD 검출 모드(옵셔널). 미지정/true=주차면 위 차량만, false=모든 차량. 기본 true. */
  vpdOnParkingOnly?: boolean;
  /**
   * VPD(차량) 검출 게이트(옵셔널). 미지정 시 **라이브러리 기본 true**(기존 완전 검출 동작 보존 → 기존 테스트 무수정).
   * 라우트(제품 정책)는 false 를 명시해 자동 경로 VPD 를 정지시킨다. false 면 vpd.detect·cuboid seg 미호출.
   */
  vpdEnabled?: boolean;
}

/**
 * 장기 관측·반복 수집 잡(상태머신, 설계서 §4.1).
 * idle→running→(stopping)→finalizing→done|stopped|error. 단일 인메모리 잡(중복 시작 거부).
 * 매 라운드: 프리셋 순회 캡처 → VPD(+LPD) 검출 → SQLite 적재. K라운드마다 집계+(LLM 체크포인트).
 * 주기 타이머·sleep·now 주입(fake timers 테스트).
 */
export class CaptureJob {
  private state: CaptureState = 'idle';
  /** 인메모리 런 식별자(로그·status 표시용만 — DB 무접촉. start 마다 ++runSeq). */
  private runId?: number;
  private runSeq = 0;
  /** 검출 원본 인메모리 누적(구 insertDetections 대체). start 에서 clear. */
  private dets: DetectionRow[] = [];
  /** 프리셋별 관측 라운드 집합(구 getPresetRounds 대체 — distinct round 카운트 소스). */
  private roundsByPreset = new Map<string, Set<number>>();
  /** 최근 체크포인트 집계 결과(구 aggregated_slot 대체 — finalize status 보존 소스). */
  private aggregated: AggregatedSlot[] = [];
  /** 프리셋별 축소 occupancy 판정(구 occupancy 테이블 대체 — 인메모리). LLM off 시 빈 맵. */
  private occByPreset = new Map<string, OccupancyJudgment>();
  /** 관측 시퀀스(구 observation.id 대체 — DetectionRow.observationId 채움용 카운터). */
  private obsSeq = 0;
  private round = 0;
  private done = 0;
  private planned = 0;
  private latestAdvisory: string[] = [];
  /** 이번 run 에서 floor ROI LLM 이 동작불가로 폴백을 썼는지(UI 경고 메시지박스 표식). */
  private llmFloorUnavailable = false;
  /** 이번 run 에서 occupancy LLM 이 동작불가였는지(UI 경고 표식). */
  private llmOccupancyUnavailable = false;
  /** 마지막 체크포인트 발화 시각(monotonic ms). time 모드 경과 판정 기준점. */
  private lastCheckpointMs = 0;
  private startedAt?: string;
  private endedAt?: string;
  /** 최근 캡처 프레임(뷰어가 수집 과정을 관찰용으로 표시 — 카메라 재명령 없이). */
  private lastFrame?: { jpeg: Buffer; camIdx: number; presetIdx: number; roundIdx: number };
  /** 프리셋별 최근 프레임(체크포인트 floor ROI 계산용). key=`${camIdx}:${presetIdx}`. */
  private lastFrameByPreset = new Map<string, Buffer>();
  private timer?: NodeJS.Timeout;
  private params?: CaptureStartParams;
  private roundRunning = false;
  /** 바닥 ROI 소스 모드. true=LLM floor 생성(기본), false=파일 모드(LLM floor 스킵). */
  private floorRoiUseLlm = true;
  /** VPD 검출 모드. true=주차면 위 차량만(기본), false=모든 차량. run 시작 시 고정(진행 중 토글 무시). */
  private vpdOnParkingOnly = true;
  /** VPD(차량) 검출 게이트. 라이브러리 기본 true, 라우트가 false(제품 정책 OFF)로 정지. run 시작 시 고정. */
  private vpdEnabled = true;
  /** 이번 run 의 주차면 폴리곤(run 시작 시 1회 로드 — 뷰어에서 편집·저장한 최신 ROI 반영). */
  private placePromise?: Promise<NormalizedPlaceRoi | null>;
  /** 모드A 필터로 제외한 차량 누적 대수. */
  private vpdFilteredOut = 0;
  /** 모드A 필터로 제외한 번호판 누적 수. */
  private lpdFilteredOut = 0;
  /** 주차면 폴리곤 부재로 모드B 강등 중인 사유(최초 1건). */
  private onPlaceDegraded?: string;
  /** 강등 warn 중복 억제(프리셋 키당 1회). */
  private degradeWarned = new Set<string>();
  /** ★ 프리셋별 최신 차량 육면체(인메모리 — **DB 무접촉**). key=`${camIdx}:${presetIdx}`. start() 에서 clear. */
  private cuboidsByPreset = new Map<string, JobCuboids>();

  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (h: NodeJS.Timeout) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;
  private readonly monotonic: () => number;

  constructor(private deps: CaptureJobDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.monotonic = deps.monotonic ?? (() => Date.now());
  }

  getRunId(): number | undefined {
    return this.runId;
  }

  /** 최근 캡처 프레임(없으면 undefined). 뷰어 /capture/frame 용. */
  getLastFrame(): { jpeg: Buffer; camIdx: number; presetIdx: number; roundIdx: number } | undefined {
    return this.lastFrame;
  }

  /** 이번 run 에서 캡처된 프리셋 키 목록(cam:preset, 정렬). 뷰어가 양쪽 카메라를 순환 표시하는 용도. */
  getFramePresets(): Array<{ camIdx: number; presetIdx: number }> {
    return [...this.lastFrameByPreset.keys()]
      .map((k) => {
        const [c, p] = k.split(':').map(Number);
        return { camIdx: c, presetIdx: p };
      })
      .sort((a, b) => a.camIdx - b.camIdx || a.presetIdx - b.presetIdx);
  }

  /** 특정 프리셋의 최근 프레임(없으면 undefined). */
  getFrameByPreset(camIdx: number, presetIdx: number): Buffer | undefined {
    return this.lastFrameByPreset.get(`${camIdx}:${presetIdx}`);
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
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.latestAdvisory.length > 0 ? { latestAdvisory: [...this.latestAdvisory] } : {}),
      ...(this.llmFloorUnavailable ? { llmFloorUnavailable: true } : {}),
      ...(this.llmOccupancyUnavailable ? { llmOccupancyUnavailable: true } : {}),
      ...(this.runId !== undefined ? { vpdEnabled: this.vpdEnabled } : {}),
      ...(this.runId !== undefined ? { vpdOnParkingOnly: this.vpdOnParkingOnly } : {}),
      ...(this.vpdFilteredOut > 0 ? { vpdFilteredOut: this.vpdFilteredOut } : {}),
      ...(this.lpdFilteredOut > 0 ? { lpdFilteredOut: this.lpdFilteredOut } : {}),
      ...(this.onPlaceDegraded ? { vpdOnPlaceDegraded: this.onPlaceDegraded } : {}),
      ...(this.cuboidsByPreset.size > 0 ? { cuboid: this.cuboidIndex() } : {}),
    };
  }

  /**
   * ★ status 에는 **경량 인덱스만** 싣는다(프리셋당 숫자 4개). status 는 초당 폴링되므로 전문(수십 KB)을
   * 매번 실어 보내지 않는다 — 뷰어는 `round` 가 **바뀔 때만** `GET /capture/job-cuboids` 로 전문을 가져간다.
   */
  private cuboidIndex(): Record<string, { round: number; cuboidCount: number; unmatched: number; segDegraded: boolean }> {
    const out: Record<string, { round: number; cuboidCount: number; unmatched: number; segDegraded: boolean }> = {};
    for (const [key, c] of this.cuboidsByPreset) {
      out[key] = {
        round: c.roundIdx,
        cuboidCount: c.summary.cuboidCount,
        unmatched: c.summary.unmatchedDet,
        segDegraded: c.summary.segDegraded,
      };
    }
    return out;
  }

  /** 잡 시작. running/stopping/finalizing 중이면 거부(throw). */
  start(p: CaptureStartParams): { runId: number } {
    if (this.state === 'running' || this.state === 'stopping' || this.state === 'finalizing') {
      throw new Error('capture already running');
    }
    this.params = p;
    this.floorRoiUseLlm = p.floorRoiUseLlm ?? true; // 기본 true(기존 캡처 동작 회귀 0).
    this.vpdOnParkingOnly = p.vpdOnParkingOnly ?? true; // 기본 모드A(주차면 위 차량만).
    this.vpdEnabled = p.vpdEnabled ?? true; // 라이브러리 기본 true(회귀 0). 라우트가 false 로 자동 경로 VPD 정지.
    this.vpdFilteredOut = 0;
    this.lpdFilteredOut = 0;
    this.onPlaceDegraded = undefined;
    this.degradeWarned.clear();
    // run 시작 시 1회 로드(사용자가 뷰어에서 편집·저장한 최신 ROI 반영). 미설정 → null → 강등(전량 통과).
    this.placePromise = loadNormalizedPlaceRoi(this.deps.placeRoiFile);
    this.round = 0;
    this.done = 0;
    this.planned = p.count;
    this.latestAdvisory = [];
    this.llmFloorUnavailable = false;
    this.llmOccupancyUnavailable = false;
    this.lastFrameByPreset.clear();
    this.cuboidsByPreset.clear(); // 이전 run 의 육면체 잔여 제거(인메모리 — DB 무접촉).
    // 인메모리 누적 초기화(구 DB 중간테이블 대체 — 설계서 §2.2).
    this.dets = [];
    this.roundsByPreset.clear();
    this.aggregated = [];
    this.occByPreset.clear();
    this.obsSeq = 0;
    // time 모드 첫 체크포인트는 시작 후 intervalMs 경과 시(즉시 발화 방지). rounds 모드는 미사용.
    this.lastCheckpointMs = this.monotonic();
    this.startedAt = this.now();
    this.endedAt = undefined;
    this.runId = ++this.runSeq; // 인메모리 런 식별자(로그·status 표시용 — DB 무접촉).
    this.state = 'running';
    // LLM 강제 구동(warm-up) 비동기 발화 — non-blocking(start 지연 0). best-effort, 라운드1 캡처 동안 모델 로드.
    void this.deps.brain?.warmup?.();
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

  private finishRun(status: 'done' | 'stopped' | 'error', _reason: 'count' | 'manual' | 'error'): void {
    this.endedAt = this.now();
    this.state = status;
    // 원버튼 셋업 파이프라인 통지(옵셔널). throw 흡수 — 잡 사망 절대 금지.
    try {
      this.deps.onFinished?.(status);
    } catch (e) {
      logger.warn({ err: e, status }, '잡 완료 콜백 예외(흡수)');
    }
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
      const targets = this.params.targets;
      const moveIntervalMs = this.deps.cfg.moveIntervalMs;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        // 진행 중 stop 시 다음 타깃 캡처 전 탈출(정지 반응성 — 이미 캡처된 타깃은 유지).
        if (this.currentState() === 'stopping') break;
        const t0 = this.monotonic(); // 이동 시작 시점(captureTarget 진입 직전 ≈ move 직전).
        try {
          await this.captureTarget(roundIdx, t);
        } catch (e) {
          // 개별 프리셋 캡처 실패는 경고로 흡수(잡 중단 아님 — detectPlates 패턴).
          logger.warn({ err: e, cam: t.camIdx, preset: t.presetIdx }, '캡처 라운드 프리셋 실패(흡수)');
        }
        // 타깃 간 이동 페이싱(floor): 마지막 타깃 뒤엔 불필요(라운드는 intervalMs 로 대기),
        // stop 요청 중이면 생략(정지 즉시반응 유지), move 없으면 미적용(moveBeforeCapture 게이트).
        const isLast = i === targets.length - 1;
        if (moveIntervalMs > 0 && !isLast && this.deps.cfg.moveBeforeCapture && this.currentState() !== 'stopping') {
          const rest = moveIntervalMs - (this.monotonic() - t0);
          if (rest > 0) await this.sleep(rest);
        }
      }
      this.round = roundIdx;
      this.done = roundIdx;

      // 트리거(rounds/time)마다 집계 + (LLM 체크포인트). 단, 정지 중이면 수 분짜리 checkpoint 스킵.
      if (this.shouldCheckpoint() && this.currentState() !== 'stopping') {
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

  private async captureTarget(roundIdx: number, t: SetupTarget): Promise<void> {
    // 캡처 전 카메라를 프리셋 PTZ 로 실제 이동(/req_move) → 시뮬/실 카메라 활성 화면이 프리셋마다 물리적으로 이동.
    // ptz 가 완전(pan/tilt/zoom)할 때만. 이동 실패는 흡수(스냅샷은 /req_img 로 계속).
    if (this.deps.cfg.moveBeforeCapture && t.ptz?.pan !== undefined && t.ptz.tilt !== undefined && t.ptz.zoom !== undefined) {
      try {
        await this.deps.camera.move(t.camIdx, t.ptz.pan, t.ptz.tilt, t.ptz.zoom);
      } catch (e) {
        logger.warn({ cat: 'packet', err: e, cam: t.camIdx, preset: t.presetIdx }, '캡처 전 카메라 이동 실패(흡수)');
      }
    }
    const cap = await this.deps.camera.requestImage(t.camIdx, t.presetIdx, t.ptz);
    this.lastFrame = { jpeg: cap.jpg, camIdx: t.camIdx, presetIdx: t.presetIdx, roundIdx };
    this.lastFrameByPreset.set(`${t.camIdx}:${t.presetIdx}`, cap.jpg);
    // 관측 인메모리 기록(구 insertObservation 대체 — observation 원본 pan/tilt/zoom/imgName 은 finalize 불필요 → 미보유).
    const obsId = ++this.obsSeq;
    const presetKey = `${t.camIdx}:${t.presetIdx}`;
    // 관측 라운드 누적(검출 유무 무관 — occupancyRate 분모). 구 observation 테이블의 distinct round 카운트 대체.
    let rs = this.roundsByPreset.get(presetKey);
    if (!rs) this.roundsByPreset.set(presetKey, (rs = new Set<number>()));
    rs.add(roundIdx);

    // VPD off(제품 정책) 시 vpd.detect 미호출 → vehicles=[]. 번호판 필터는 vehicles=[] 로 폴리곤 직접 전환(결정 C).
    const raw = this.vpdEnabled ? await this.deps.vpd.detect(cap.jpg) : [];
    const vehicles = this.vpdEnabled && this.vpdOnParkingOnly ? await this.applyOnPlaceFilter(raw, t) : raw;
    const dets: Array<{ kind: 'vehicle' | 'plate'; x: number; y: number; w: number; h: number; conf: number; quad?: NormalizedQuad }> =
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
        const rawPlates = await this.deps.lpd.detect(cap.jpg);
        // 모드A: 번호판도 주차면 위 차량 것만 적재(귀속 OR 주차면 내부).
        const plates = this.vpdOnParkingOnly ? await this.applyPlateFilter(rawPlates, vehicles, t) : rawPlates;
        for (const p of plates) {
          // rect(=quad boundingRect, 집계·클러스터링용) + quad(방향 보존) 동시 저장.
          const br = quadBoundingRect(p.quad);
          dets.push({ kind: 'plate', x: br.x, y: br.y, w: br.w, h: br.h, conf: p.confidence, quad: p.quad });
        }
      } catch (e) {
        logger.warn({ err: e, cam: t.camIdx, preset: t.presetIdx }, 'LPD 검출 실패(번호판 생략)');
      }
    }

    // 검출 인메모리 누적(구 insertDetections 대체 — DetectionRow 평면 행). 집계는 체크포인트/finalize 가 배열로 소비.
    for (const d of dets) {
      this.dets.push({
        observationId: obsId,
        roundIdx,
        camIdx: t.camIdx,
        presetIdx: t.presetIdx,
        kind: d.kind,
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        conf: d.conf,
        ...(d.quad ? { quad: d.quad } : {}),
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ↑ 여기까지가 **점유 판정 경로**다 — 위 블록은 한 줄도 바뀌지 않았다.
    // ↓ 아래는 **가산**(읽기 전용). `raw`/`vehicles` 를 읽기만 하고 DB 에 아무것도 쓰지 않는다.
    //   ∴ 육면체 on/off 는 `insertDetections` 인자를 바꿀 수 없다(구조적 회귀 0 — T6 가 봉인).
    // ─────────────────────────────────────────────────────────────────────────
    if (this.deps.cuboidCtx && this.vpdEnabled) {
      // ★ `keptDetIdx` 는 필터를 **재계산하지 않고** 참조 동일성(indexOf)으로 얻는다 → 필터 경로 무접촉.
      //   (`filterVehiclesOnPlace` 는 Array.filter — 입력 객체 참조를 보존한다.)
      //   ⚠️ **-1 을 여기서 버리지 않는다**(DEFECT-2): 전제가 깨지면 `buildFrameCuboids` 가 issues 로 **드러낸다**.
      //      예전엔 `.filter((i) => i >= 0)` 가 위반을 삼켜 `cuboids:[] · issues:[]`(빈 오버레이 + 무사유)가 됐다.
      const keptDetIdx = vehicles.map((v) => raw.indexOf(v));
      await this.updateCuboids(t, cap.jpg, raw, keptDetIdx, roundIdx);
    }
  }

  /**
   * 프리셋 1개분 육면체 갱신(가산·인메모리). **throw 0** — 잡 사망 절대 금지(마스터 §5).
   * `buildFrameCuboids` 자체가 throw 0 이지만, 문맥 해결(파일 IO)·예기치 못한 오류까지 **한 겹 더** 흡수한다(방어 이중화).
   */
  private async updateCuboids(
    t: SetupTarget,
    jpeg: Buffer,
    raw: readonly VehicleBox[],
    keptDetIdx: readonly number[],
    roundIdx: number,
  ): Promise<void> {
    try {
      const ctx = await this.deps.cuboidCtx!(t.camIdx, t.presetIdx);
      const fc = await buildFrameCuboids({ jpeg, detBoxes: raw, keptDetIdx, vpd: this.deps.vpd, ctx });
      this.cuboidsByPreset.set(`${t.camIdx}:${t.presetIdx}`, {
        ...fc,
        camIdx: t.camIdx,
        presetIdx: t.presetIdx,
        roundIdx,
        capturedAt: this.now(),
      });
    } catch (e) {
      // 육면체는 **관찰용 가산 기능**이다 — 실패해도 수집은 계속된다(점유·DB 무영향).
      logger.warn({ err: e, cam: t.camIdx, preset: t.presetIdx }, '차량 육면체 산출 실패(흡수 — 수집 계속)');
    }
  }

  /** 프리셋별 육면체 전문(GET /capture/job-cuboids). 카메라·VPD 호출 0 — 인메모리 읽기만. */
  getCuboids(camIdx: number, presetIdx: number): JobCuboids | undefined {
    return this.cuboidsByPreset.get(`${camIdx}:${presetIdx}`);
  }

  /** 대상 프리셋의 주차면 폴리곤(차량·번호판 필터 공유 소스). placePromise 는 캐시된 Promise — 파일 I/O 재발생 없음. */
  private async presetPlace(t: SetupTarget): Promise<{ place: NormalizedPlaceRoi | null; polys: NormalizedPoint[][] | null }> {
    const place = (await this.placePromise) ?? null;
    const polys = place?.byPreset.get(`${t.camIdx}:${t.presetIdx}`)?.map((s) => s.points) ?? null;
    return { place, polys };
  }

  /**
   * 모드A: 주차면 폴리곤 위 차량만 남긴다. 폴리곤 부재(파일 없음/해당 프리셋 주차면 0개)면
   * **전량 통과로 강등**하고 사유를 warn + status 에 드러낸다(조용한 폴백 금지).
   */
  private async applyOnPlaceFilter<T extends { rect: { x: number; y: number; w: number; h: number } }>(
    vehicles: T[],
    t: SetupTarget,
  ): Promise<T[]> {
    const key = `${t.camIdx}:${t.presetIdx}`;
    const { place, polys } = await this.presetPlace(t);
    const { kept, filteredOut, degraded } = filterVehiclesOnPlace(vehicles, polys);
    if (degraded) {
      const reason = place ? `프리셋 ${key} 주차면 0개` : '주차면 파일 없음/로드 실패';
      this.onPlaceDegraded ??= reason;
      if (!this.degradeWarned.has(key)) {
        this.degradeWarned.add(key);
        logger.warn({ cam: t.camIdx, preset: t.presetIdx, reason }, '주차면 필터 강등 — 모든 차량 통과(모드B)');
      }
      return kept;
    }
    this.vpdFilteredOut += filteredOut;
    return kept;
  }

  /**
   * 모드A: 번호판도 주차면 위 차량 것만 남긴다 — `(유지된 차량에 귀속) OR (번호판 중심 ∈ 주차면 폴리곤)`.
   * 두 번째 항은 VPD 가 놓친 주차차의 번호판을 살려 점유 판정(번호판 중심 기반) 뒤집힘을 막는다.
   * 강등(폴리곤 부재) 시 filteredOut=0 · 전량 통과 — 사유·warn 은 차량 필터가 이미 남긴다(중복 금지).
   */
  private async applyPlateFilter(plates: PlateBox[], keptVehicles: VehicleBox[], t: SetupTarget): Promise<PlateBox[]> {
    const { polys } = await this.presetPlace(t);
    const { kept, filteredOut } = filterPlatesOnPlace(plates, keptVehicles, polys);
    this.lpdFilteredOut += filteredOut;
    return kept;
  }

  /**
   * 체크포인트 발화 게이트. rounds: `done % checkpointEvery === 0`(기존 표현 동일 — 회귀 0).
   * time: 마지막 체크포인트 후 경과 ≥ checkpointIntervalMs. 두 모드 모두 라운드 경계에서만 평가.
   */
  private shouldCheckpoint(): boolean {
    const p = this.params!;
    if (p.checkpointTriggerMode === 'time') {
      return this.monotonic() - this.lastCheckpointMs >= p.checkpointIntervalMs;
    }
    return this.done % p.checkpointEvery === 0;
  }

  /** 집계 후 체크포인트(인메모리 누적 재집계 + 축소 occupancy 보조). 좌표 불변. */
  private async checkpoint(roundIdx: number): Promise<void> {
    // 발화 확정 → 다음 time 주기 기준점 갱신(rounds 모드에선 미사용).
    this.lastCheckpointMs = this.monotonic();
    // LLM 사용 직전 warm-up 재보장(라운드 간격으로 언로드됐어도 모델 로드 확정). best-effort — 실패해도 진행.
    // 정지 중이면 수 분짜리 콜드 로드 대기를 피하려 스킵.
    if (this.currentState() !== 'stopping') await this.deps.brain?.warmup?.();
    // 인메모리 결정형 집계(구 getDetectionsForRun/getPresetRounds/replaceAggregatedSlots DB 경로 대체 — 설계서 §2.2).
    // Aggregator 시그니처 불변(배열 + 프리셋별 라운드수 맵). CheckpointReviewer/FloorRoiReviewer 배선 제거(캡처 루프 LLM off).
    const presetRounds = new Map<string, number>([...this.roundsByPreset].map(([k, s]) => [k, s.size]));
    this.aggregated = aggregate(this.dets, presetRounds, this.aggOptions());

    // 차량 점유율(축소 보조·인메모리 occByPreset). 파일 모드(floorRoiUseLlm=false)/LLM off 면 no-op(저장 생략).
    if (this.deps.occupancyReviewer && this.floorRoiUseLlm !== false) {
      const occRes = await this.deps.occupancyReviewer.review(
        roundIdx,
        this.lastFrameByPreset,
        this.occByPreset,
        () => this.currentState() === 'stopping',
        this.deps.expectedByPreset,
      );
      if (occRes.llmUnavailable) this.llmOccupancyUnavailable = true;
    }
  }

  /** 현재 집계 결과(REST GET /capture/aggregate). 인메모리 최근 체크포인트 산출. */
  getAggregated(): AggregatedSlot[] {
    return this.aggregated;
  }

  /**
   * 프리셋별 축소 occupancy(REST GET /capture/occupancy). 구 occupancy 테이블 rows shape 유지
   * (camIdx/presetIdx/occupiedCount/total/rate/spacesJson) — 뷰어 occupancyByKey 무변경. LLM off 시 [].
   */
  getOccupancy(): Array<{
    camIdx: number;
    presetIdx: number;
    occupiedCount: number;
    total: number;
    rate: number;
    spacesJson: string;
  }> {
    const out: Array<{ camIdx: number; presetIdx: number; occupiedCount: number; total: number; rate: number; spacesJson: string }> = [];
    for (const [key, j] of this.occByPreset) {
      const [camIdx, presetIdx] = key.split(':').map(Number);
      out.push({
        camIdx,
        presetIdx,
        occupiedCount: j.occupiedCount,
        total: j.total,
        rate: j.rate,
        spacesJson: JSON.stringify(j.spaces),
      });
    }
    return out;
  }

  /** finalize 입력 스냅샷(설계서 §2.3). DB 재조회 없이 인메모리 누적을 그대로 넘긴다. */
  getSnapshot(): CaptureSnapshot {
    return {
      dets: this.dets,
      presetRounds: new Map<string, number>([...this.roundsByPreset].map(([k, s]) => [k, s.size])),
      aggregated: this.aggregated,
      occByPreset: this.occByPreset,
    };
  }
}
