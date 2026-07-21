import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { SlotCenteringRow } from '../capture/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { logger } from '../util/logger.js';
import { quadBoundingRect, center } from '../domain/geometry.js';
import type { NormalizedPoint, NormalizedRect } from '../domain/types.js';
import { resolvePresetPtz } from '../capture/detectPipeline.js';
import { expandPlateTargetsFromSlotSetup, writeSlotPtz } from './slotPtzWriter.js';
import { buildSlotPtzJson, aimPtzForPoint, zoomForWidth } from './controlMath.js';
import { setupSaveName, type SaveStore } from '../store/SaveStore.js';
import { buildSetupResult, SETUP_RESULT_NAME } from '../store/setupResult.js';
import { PlatePtz, type PlatePtzOpts, type PlatePtzResult } from './platePtz.js';
import type { PlateTarget, Ptz, SlotPtzItem, CalibrateState, CalibrateStatus } from './types.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 프리셋 PTZ 조회 실패 시 폴백(조용한 강등 금지 — warn 동반). */
const FALLBACK_START_PTZ: Ptz = { pan: 0, tilt: 0, zoom: 1 };

/**
 * pre-aim(선조준) 1스텝 상한(°). cfg.maxStepDeg(=5, 폐루프 미세보정용)는 너무 작아 재사용 금지 —
 * 넓은 FOV 에서 대상을 화면중앙 근처로 끌어오는 coarse 스텝은 크게 잡는다(정상 오프셋 ~18° 이내라 미클립, 이상 게인 방어 상한).
 */
const PREAIM_MAX_STEP = 90;

/**
 * 소유권 peer 유효 최소 오프셋(정규화). 실측 슬롯 판 간격 ≈0.11~0.15 이라 진짜 이웃은 전부 통과하고,
 * lpd 중심 일치/근접(≈0)한 peer 만 드롭한다 — 겹친 peer 는 Voronoi 판별정보가 없어 소유권을 무력화하므로 제외.
 */
const PEER_MIN_OFFSET = 0.02;

/**
 * (방안2·3) acquire 노브 폴백(cfg 미설정 시). 기존 config·테스트 회귀 0 을 위해 코드 기본값으로 처리.
 * - ACQUIRE_PLATE_WIDTH: acquire 시작줌이 겨눌 판폭. ★라이브 진단(zoomDetect): 일부 슬롯(slot5)은 zoom 6~10 에
 *   LPD 검출 사각지대가 있고 그 위(12~16)에선 정상 검출 → 0.12(→zoom~8)는 사각지대를 밟는다. 게인이 정확해
 *   pre-aim 이 판을 중앙에 정확히 놓으므로 FOV 여유 불필요 → 목표 근처(config 0.18)로 올려 사각지대를 건너뛴다.
 * - ACQUIRE_LADDER_STEP: 미검 시 줌아웃 1스텝 배율(rungZoom/=step).
 * - ACQUIRE_LADDER_MAX_STEPS: 사다리 최대 rung 수(floor=presetZoom 로 바운드).
 */
const ACQUIRE_PLATE_WIDTH_DEFAULT = 0.12;
const ACQUIRE_LADDER_STEP_DEFAULT = 1.5;
const ACQUIRE_LADDER_MAX_STEPS_DEFAULT = 5;

/** PlatePtz 기본 maxZoomStepRatio(cfg 미설정 시 width 복구 시작 스텝비). PlatePtz 내부 기본과 동일. */
const DEFAULT_ZOOM_STEP_RATIO = 1.5;

/**
 * width 복구 사다리 최대 재시도(줌아웃 재포착+고운스텝). 2 로 바운드 — 복구는 게인이 대략 맞는 슬롯을
 * 되살리되(라이브: 경계 슬롯 회복 확인), 게인 대오차 슬롯은 몇 번을 물러나도 폭확대 중 재드리프트하므로
 * 무한 재시도는 런타임만 늘린다(근본 해결은 게인 diagSweep 재실측). acquireLadderMaxSteps(acquire 전용)와 분리.
 */
const WIDTH_RECOVERY_MAX = 2;

/** lpdWidth 퇴화 판정 임계(0/음수 가드 — acquire 스킵=프리셋시야). */
const LPD_WIDTH_EPS = 1e-4;

/**
 * (개별 클릭 전용) 최초 대상 선정 반경 게이트 기본값(cfg 미설정 시). 근거는 CalibrateSchema.pointMatchRadiusNorm 주석.
 * 요약: 클릭정밀도 0.02 + 차체↔판 오프셋 0.08 = worst 0.10 이상, 이웃 판 최소 간격 0.11 미만.
 */
const POINT_MATCH_RADIUS_DEFAULT = 0.1;

/**
 * PlatePtz 중 이 잡이 쓰는 표면(테스트 시임 경계).
 * ★ centerAndZoomByLadder 는 **Partial** — 기존 makePlatePtz 스텁(2메서드만 구현)을 쓰는 테스트를
 *   타입 에러로 죽이지 않기 위해서다. 호출측은 존재 확인 후 없으면 기존 경로로 폴백한다.
 */
type PlatePtzApi = Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth'> &
  Partial<Pick<PlatePtz, 'centerAndZoomByLadder'>>;

export interface PtzCalibratorDeps {
  camera: ICameraClient;
  lpd: LpdClient;
  cfg: ToolsConfig['calibrate'];
  /** 센터라이징 소스(slot_setup 조회) + centering_slot 미러 저장. 잡의 유일 데이터 소스이므로 필수. */
  store: Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  /**
   * PlatePtz 팩토리 주입(테스트 시임). 기본=new PlatePtz({camera, lpd, sleep}, opts).
   * 2번째 인자는 **개별(클릭) 경로 전용 카메라 오버라이드**(뷰어가 보고 있는 소스). 미전달 시 deps.camera.
   */
  makePlatePtz?: (opts: PlatePtzOpts, camera?: ICameraClient) => PlatePtzApi;
  /** slot_ptz.json writer 주입(테스트는 캡처 stub). 기본=writeSlotPtz. */
  writer?: (artifact: ReturnType<typeof buildSlotPtzJson>, outFile: string) => void;
  /**
   * 최종 결과물 writer(옵셔널·가산). 미주입 시 기록 no-op(수동 흐름/테스트 회귀 0).
   * 잡 done 경로에서 동일 내용을 이력본(save/Setup_*.json)과 고정본(save/setup_result.json)으로 각 1회 기록한다.
   */
  saveStore?: Pick<SaveStore, 'saveSnapshot'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  /**
   * ★ 잡 종단 완료 콜백(옵셔널·가산 — 원버튼 셋업 파이프라인 배선). done/error 로 1회 통지.
   * 미주입 시 no-op(수동 흐름 회귀 0). throw 는 흡수한다 — 콜백이 잡을 죽이지 않는다.
   */
  onFinished?: (state: 'done' | 'error') => void;
}

/**
 * 주차면별 번호판 중심정렬·줌 센터라이징 잡(설계서 §1.3·§3.2).
 * CaptureJob 패턴 차용: 단일 인메모리 상태머신, 중복 시작 거부, 슬롯 순차 await.
 *
 * 제어 폐루프는 **소유하지 않는다** — 라이브 검증된 `PlatePtz`(결정형 도구)에 위임하고,
 * 이 클래스는 잡 상태머신·대상 펼침·시작 PTZ 해석·결과 매핑·저장(JSON + DB 미러)만 담당한다.
 *
 * 순서(방안2+3): acquire(acquireZoom 로 줌인해 큰 판 검출·센터, 미검이면 줌아웃 사다리) → width(폭 마감).
 * acquire 실패 시 width 는 시도하지 않는다(미중심 zoom-in 은 중심 오차를 배율만큼 확대해 대상을 날린다 — platePtz 설계 §2.3).
 */
export class PtzCalibrator {
  private state: CalibrateState = 'idle';
  private done = 0;
  private total = 0;
  private current?: { slotId: string };
  private startedAt?: string;
  private endedAt?: string;

  private readonly camera: ICameraClient;
  private readonly cfg: ToolsConfig['calibrate'];
  private readonly store: Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  private readonly makePlatePtz: (opts: PlatePtzOpts, camera?: ICameraClient) => PlatePtzApi;
  private readonly writer: (artifact: ReturnType<typeof buildSlotPtzJson>, outFile: string) => void;
  private readonly now: () => string;
  /** 잡 종단 완료 콜백(옵셔널·가산 — 파이프라인 배선). 미주입 시 no-op. */
  private readonly onFinished?: (state: 'done' | 'error') => void;
  /** 최종 셋업 스냅샷 writer(옵셔널·가산). 미주입 시 스냅샷 no-op. */
  private readonly saveStore?: Pick<SaveStore, 'saveSnapshot'>;
  /** 프리셋 PTZ 조회 캐시(`${cam}:${preset}` → PTZ) — Finalizer ptzByKey 패턴. */
  private readonly ptzByKey = new Map<string, Ptz>();
  /** 최근 센터라이징 캡처 프레임(없으면 undefined). 뷰어 /calibrate/frame 용 — CaptureJob.getLastFrame 패턴. */
  private lastFrame?: { jpeg: Buffer; camIdx: number; presetIdx: number };
  /** 개별(클릭) 센터라이징 진행 락. 배치 state==='running' 와 함께 카메라 경합을 막는다(centerOnPoint 상호배타 가드). */
  private pointBusy = false;

  constructor(deps: PtzCalibratorDeps) {
    this.camera = deps.camera;
    this.cfg = deps.cfg;
    this.store = deps.store;
    const sleep = deps.sleep ?? defaultSleep;
    const onFrame = (jpeg: Buffer, camIdx: number, presetIdx: number): void => {
      this.lastFrame = { jpeg, camIdx, presetIdx };
    };
    this.makePlatePtz = deps.makePlatePtz ?? ((opts, camera) => new PlatePtz({ camera: camera ?? deps.camera, lpd: deps.lpd, sleep, onFrame }, opts));
    this.writer = deps.writer ?? writeSlotPtz;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.onFinished = deps.onFinished;
    this.saveStore = deps.saveStore;
  }

  /** 최근 센터라이징 캡처 프레임(없으면 undefined). 뷰어 /calibrate/frame 용. 잡 종료 후에도 유지. */
  getLastFrame(): { jpeg: Buffer; camIdx: number; presetIdx: number } | undefined {
    return this.lastFrame;
  }

  /**
   * 카메라를 움직이는 잡 **시작 시** 직전 실행의 프레임 버퍼를 버린다.
   *
   * ★ 없으면 표시 버그가 된다(마스터 신고): 새 실행이 첫 캡처를 넣기 전까지 `/calibrate/frame` 이
   *   **직전 실행의 마지막 프레임**(예: 36배 확대 화면)을 계속 서빙하고, 뷰어는 그 사이 라이브를 끊고
   *   이 라우트를 폴링하므로 **카메라는 새 위치로 갔는데 화면만 과거를 보여준다**.
   * 비운 뒤에는 라우트가 404(기존 "버퍼 없음" 계약)를 돌려주고 뷰어는 갱신을 스킵해
   *   **클릭 시점의 라이브 프레임에 머문다** — 과거 실행 이미지를 현재인 양 보여주는 것보다 정직하다.
   */
  private clearLastFrame(): void {
    this.lastFrame = undefined;
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
   * 개별(클릭) 센터라이징(신규·가산 — 설계서 §3.1). 조작자가 라이브뷰에서 가리킨 지점 최근접 번호판으로
   * pan/tilt 정렬(+옵션 zoom). 배치 start()/run() 경로·저장(writer·DB·스냅샷)과 **완전 분리** — 어디에도 기록하지 않는다.
   *
   * 1. 상호배타 가드: 배치 진행(state==='running')·개별 진행(pointBusy) 중이면 throw(라우트 409 매핑).
   * 2. currentPtzFor 로 **현재 PTZ** 를 기준으로 잡는다(조회 실패 시 프리셋 폴백). 클릭은 "지금 보이는 화면" 기준이고,
   *    실카 소스는 프리셋 PTZ 테이블이 없어 프리셋 해석이 0/0/1 폴백으로 떨어져 카메라를 엉뚱한 곳으로 날린다.
   *    ★ 개별 경로 한정 — 배치(calibrateSlot)는 프리셋 정본 유지.
   * 3. plateRoi=클릭점(w/h=0) prior 로 centerOnPlate — peerOffsets 미주입 → pickNearestPlate(클릭 최근접).
   *    ★ initialRadiusNorm(기본 0.10) 주입 — 클릭점 반경 밖 판을 **대신 채택하지 않는다**(거짓 성공 제거).
   *    ★ zoom!==false 이고 사다리가 켜져 있으면(cfg.pointZoomLadder, 'auto'=네이티브 소스만) 3~4 대신
   *      PlatePtz.centerAndZoomByLadder 한 호출로 완결한다(조준 먼저 → 확대하며 찾기).
   * 4. center 성공 & zoom!==false 이면 center.gain 체이닝으로 zoomToPlateWidth 1회 마감(성공 시 z, 실패 시 center 반환 — 정직).
   * 5. 저장 호출 없음(writer/saveCenteringSlots/saveSetupSnapshot/upsertSlotCentering 미호출).
   *    onFrame 은 makePlatePtz 생성자에 이미 배선되어 진행 중 lastFrame 갱신(/calibrate/frame 폴링 자동).
   * 6. opts.camera 주입 시 그 카메라로만 동작(뷰어가 보고 있는 소스 = 명령 대상). 미주입이면 파이프라인 카메라.
   */
  async centerOnPoint(
    camIdx: number,
    presetIdx: number,
    point: NormalizedPoint,
    opts?: { zoom?: boolean; camera?: ICameraClient },
  ): Promise<{ ok: boolean; ptz: Ptz; plateWidth: number | null; reason?: string }> {
    if (this.state === 'running') throw new Error('calibrate already running');
    if (this.pointBusy) throw new Error('point centering busy');
    this.pointBusy = true;
    this.clearLastFrame(); // 직전 실행 프레임이 새 실행 화면으로 새는 것을 막는다.
    try {
      const cam = opts?.camera;
      const startPtz = await this.currentPtzFor(camIdx, presetIdx, cam);
      // 7. center+zoom 은 사다리 우선(조준 → 확대하며 찾기). 시뮬(네이티브 미지원)은 'auto' 에서 타지 않는다 = 기존 경로 보존.
      if (opts?.zoom !== false && this.ladderEnabled(cam ?? this.camera)) {
        const ladder = this.makePlatePtz({ ...this.baseOpts(), ...this.ladderOpts() }, cam);
        if (ladder.centerAndZoomByLadder) {
          const r = await ladder.centerAndZoomByLadder(camIdx, presetIdx, point, startPtz);
          return { ok: r.ok, ptz: r.ptz, plateWidth: r.plateWidth, ...(r.reason ? { reason: r.reason } : {}) };
        }
      }
      const prior: NormalizedRect = { x: point.x, y: point.y, w: 0, h: 0 };
      const centered = await this.makePlatePtz(
        { ...this.baseOpts(), plateRoi: prior, initialRadiusNorm: this.pointRadius() },
        cam,
      ).centerOnPlate(camIdx, presetIdx, startPtz);
      if (centered.ok && opts?.zoom !== false) {
        const z = await this.makePlatePtz({
          ...this.baseOpts(),
          plateRoi: quadBoundingRect(centered.plate!.quad),
          gain: centered.gain,
        }, cam).zoomToPlateWidth(camIdx, presetIdx, centered.ptz);
        if (z.ok) return { ok: z.ok, ptz: z.ptz, plateWidth: z.plateWidth, ...(z.reason ? { reason: z.reason } : {}) };
      }
      return { ok: centered.ok, ptz: centered.ptz, plateWidth: centered.plateWidth, ...(centered.reason ? { reason: centered.reason } : {}) };
    } finally {
      this.pointBusy = false;
    }
  }

  /**
   * 클릭 지점 조준(신규·가산): 조작자가 가리킨 **정규화 지점 자체**를 화면 중앙으로 보낸다.
   * 번호판 기준 `centerOnPoint` 와 목적이 다르다 — 검출(LPD) 0회·저장 0회·zoom 불변·개방루프 1샷.
   *
   * 1. 상호배타 가드는 centerOnPoint 와 동일한 락(state==='running' · pointBusy)을 재사용.
   * 2. 기준 PTZ = **현재 PTZ**(클릭은 "지금 보이는 화면" 기준이라 프리셋 base 를 쓰면 어긋난다).
   *    조회 실패 시 프리셋 PTZ 로 폴백하되 warn 을 남긴다(조용한 강등 금지).
   * 3. 소스가 네이티브 센터링(휴컴스 ptz_centering setcenter)을 지원하면 그것에 위임(mode:'native'),
   *    아니면 게인 기하로 절대 pan/tilt 를 계산해 move 1회(mode:'geometric').
   */
  async aimPointToCenter(
    camIdx: number,
    presetIdx: number,
    point: NormalizedPoint,
    opts?: { camera?: ICameraClient },
  ): Promise<{ ok: boolean; ptz: Ptz; plateWidth: null; mode: 'native' | 'geometric'; reason?: string }> {
    if (this.state === 'running') throw new Error('calibrate already running');
    if (this.pointBusy) throw new Error('point centering busy');
    this.pointBusy = true;
    this.clearLastFrame(); // 검출은 없지만 카메라는 움직인다 → 직전 프레임은 이 시점부터 과거다.
    try {
      // 카메라 오버라이드(뷰어가 보고 있는 소스) 우선 — 미주입이면 파이프라인 카메라.
      const camera = opts?.camera ?? this.camera;
      // 네이티브 분기가 먼저 — 장비가 스스로 계산하므로 기준 PTZ 조회(왕복 1회)가 불필요하다.
      const native = camera.centerOnPoint;
      if (native) {
        const ptz = await native.call(camera, camIdx, point);
        return { ok: true, ptz, plateWidth: null, mode: 'native' };
      }
      const cur = await this.currentPtzFor(camIdx, presetIdx, opts?.camera);
      const aim = aimPtzForPoint(point, cur, this.gainRef(), PREAIM_MAX_STEP);
      const ok = await camera.move(camIdx, aim.pan, aim.tilt, aim.zoom);
      // 이동 거절(false)은 조용히 200 ok:false 로 나가면 UI 가 '종료(200)' 로 보인다 — 사유를 붙인다.
      return { ok, ptz: aim, plateWidth: null, mode: 'geometric', ...(ok ? {} : { reason: 'move_failed' }) };
    } finally {
      this.pointBusy = false;
    }
  }

  /**
   * 줌 사다리 사용 여부(cfg 스위치 · 기본 'auto'). 'auto' 는 소스가 네이티브 센터링을 지원할 때만 켠다 —
   * 시뮬(미지원)은 신규 코드를 한 줄도 실행하지 않으므로 기존 성공률이 **구조적으로** 보존된다.
   */
  private ladderEnabled(camera: ICameraClient): boolean {
    const mode = this.cfg.pointZoomLadder ?? 'auto';
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return typeof camera.centerOnPoint === 'function';
  }

  /** 개별(클릭) 최초 대상 선정 반경. 배치 경로에는 주입하지 않는다(§회귀 안전성). */
  private pointRadius(): number {
    return this.cfg.pointMatchRadiusNorm ?? POINT_MATCH_RADIUS_DEFAULT;
  }

  /** 사다리 전용 opts(cfg 미설정 필드는 전달하지 않아 PlatePtz 코드 기본값을 쓰게 한다). */
  private ladderOpts(): PlatePtzOpts {
    return {
      initialRadiusNorm: this.pointRadius(),
      ...(this.cfg.ladderMaxRungs !== undefined ? { ladderMaxRungs: this.cfg.ladderMaxRungs } : {}),
      ...(this.cfg.nativeAimSettleMs !== undefined ? { nativeAimSettleMs: this.cfg.nativeAimSettleMs } : {}),
      ...(this.cfg.preLatchZoomStepRatio !== undefined ? { preLatchZoomStepRatio: this.cfg.preLatchZoomStepRatio } : {}),
    };
  }

  /**
   * 개별(클릭) 경로 기준 PTZ = 장비 현재 PTZ. 조회 실패 시 프리셋 PTZ 폴백(+warn — 조용한 강등 금지).
   * override 는 뷰어가 보고 있는 소스의 카메라(미주입 시 파이프라인 카메라).
   */
  private async currentPtzFor(camIdx: number, presetIdx: number, override?: ICameraClient): Promise<Ptz> {
    const camera = override ?? this.camera;
    try {
      return await camera.getPtz(camIdx);
    } catch (err) {
      logger.warn({ cam: camIdx, preset: presetIdx, err: String(err) }, '현재 PTZ 조회 실패 → 프리셋 PTZ 로 조준(오차 가능)');
      return this.startPtzFor({ camIdx, presetIdx } as PlateTarget, override);
    }
  }

  /**
   * 잡 시작(중복 거부 throw → 라우트 409). 대상=plateRoiByPreset 펼침(필터 slotIds).
   * 슬롯 순차 처리 → buildSlotPtzJson → writer 저장. 백그라운드(await 하지 않고 발화).
   */
  start(slotIds?: string[]): { total: number } {
    if (this.state === 'running') throw new Error('calibrate already running');
    let targets = expandPlateTargetsFromSlotSetup(this.store.getSlotSetup());
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
    this.clearLastFrame(); // 직전 실행 프레임 무효화(배치도 동일 병).
    void this.run(targets);
    return { total: targets.length };
  }

  private async run(targets: PlateTarget[]): Promise<void> {
    const items: SlotPtzItem[] = [];
    // 프리셋별 그룹핑(PlateDiscoveryJob 패턴) — 슬롯마다 같은 (cam,preset) 타 슬롯을 peer 로 소유권 게이트에 공급.
    const byPreset = new Map<string, PlateTarget[]>();
    for (const t of targets) {
      const key = `${t.camIdx}:${t.presetIdx}`;
      const g = byPreset.get(key);
      if (g) g.push(t);
      else byPreset.set(key, [t]);
    }
    try {
      for (const t of targets) {
        this.current = { slotId: t.slotId };
        const peerOffsets = this.peerOffsetsFor(t, byPreset.get(`${t.camIdx}:${t.presetIdx}`) ?? [t]);
        try {
          items.push(await this.calibrateSlot(t, peerOffsets));
        } catch (e) {
          // 개별 슬롯 실패 흡수(경고 + reason, 잡 중단 아님 — CaptureJob captureTarget 패턴).
          logger.warn({ err: e, slot: t.slotId, cam: t.camIdx, preset: t.presetIdx }, '센터라이징 슬롯 실패(흡수)');
          items.push(this.skipItem(t, { pan: 0, tilt: 0, zoom: 1 }, 0, 'error'));
        }
        this.done += 1;
      }
      this.writer(buildSlotPtzJson(items, this.now()), this.cfg.outFile);
      this.saveCenteringSlots(items); // DB UPDATE 먼저 — 아래 스냅샷이 PTZ 반영된 최신 slot_setup 을 읽도록.
      this.saveSetupSnapshot(); // done 경로에서만 best-effort 기록(error 경로는 미기록 — 부분·불신).
      this.current = undefined;
      this.endedAt = this.now();
      this.state = 'done';
      this.notifyFinished('done');
    } catch (e) {
      logger.error({ err: e }, '센터라이징 잡 예외 → error');
      this.endedAt = this.now();
      this.state = 'error';
      this.notifyFinished('error');
    }
  }

  /**
   * 최종 결과물 기록(옵셔널·best-effort). done 경로에서만 호출. **동일 내용 2벌**:
   *   1) save/Setup_YYYYMMDD_HHMMSS.json — 타임스탬프 이력본(덮어쓰기 없음)
   *   2) save/setup_result.json — 소비측이 읽는 고정 경로(매 실행 덮어쓰기)
   * payload = buildSetupResult(slot_setup 정본): 기하+점유+PTZ 반영된 최종 슬롯 목록.
   * saveCenteringSlots(DB UPDATE) 이후 getSlotSetup() 을 재조회하므로 PTZ 반영된 최신 뷰를 담는다.
   * saveStore 미주입·기록 실패는 격리(잡·JSON 정본 무영향). 두 기록은 각자 best-effort(한쪽 실패가 다른쪽을 막지 않음).
   */
  private saveSetupSnapshot(): void {
    if (!this.saveStore) return;
    const result = buildSetupResult(this.store.getSlotSetup()); // 1회 변환 → 2벌 동일 내용 보장.
    try {
      this.saveStore.saveSnapshot(setupSaveName(new Date()), result);
    } catch (e) {
      logger.warn({ err: e }, 'Setup_* 이력본 저장 실패(격리 — slot_ptz.json·DB 는 정상)');
    }
    try {
      this.saveStore.saveSnapshot(SETUP_RESULT_NAME, result);
    } catch (e) {
      logger.warn({ err: e }, 'setup_result.json 저장 실패(격리 — slot_ptz.json·DB 는 정상)');
    }
  }

  /** 종단 완료 콜백 통지(옵셔널). throw 흡수 — 콜백이 잡을 죽이지 않는다. */
  private notifyFinished(state: 'done' | 'error'): void {
    try {
      this.onFinished?.(state);
    } catch (e) {
      logger.warn({ err: e, state }, '센터라이징 완료 콜백 예외(흡수)');
    }
  }

  /**
   * 슬롯 1건 센터라이징(방안2+3 재조립, 설계 §A-2): preaim(프리셋시야 조준) →
   * acquire(acquirePlateWidth 근처로 줌인해 큰 판 검출·센터, centerOnPlate 재사용, 미검이면 줌아웃 사다리) →
   * width(zoomToPlateWidth 로 targetPlateWidth 마감).
   * ★ 소유권 peerOffsets 는 상수(원본 프레임)라 acquire 의 큰 zoom 에선 화면 이웃간격이 zoom/presetZoom 배로 확대 →
   *   각 단계 호출 zoom 으로 사전스케일해 주입(PlatePtz 무변경). center 결과 gain 을 width 로 체이닝.
   */
  private async calibrateSlot(t: PlateTarget, peerOffsets: NormalizedPoint[]): Promise<SlotPtzItem> {
    const baseStart = await this.startPtzFor(t); // 프리셋 base(캐시) — 슬롯간 공유.
    const presetZoom = baseStart.zoom;
    const plan = this.computeAcquirePlan(t, presetZoom);
    // pre-aim 은 프리셋 zoom 기준(plateRoi 가 측정된 프레임과 게인스케일 일치). zoom 은 acquire 단계가 부여.
    const aim = this.preAimPtz(t, baseStart);
    const base = this.baseOpts();

    // acquire: acquireZoom 으로 줌인해 큰 판을 검출·센터. 미검이면 줌아웃 사다리로 재포착(floor=presetZoom).
    const c = await this.acquireAndCenter(t, aim, plan, presetZoom, peerOffsets, base);
    if (!c.ok || !c.plate) return this.skipItem(t, c.ptz, c.plateWidth ?? 0, c.reason);

    // width: acquire 지점(c.ptz.zoom)에서 targetPlateWidth 로 마감. plate_lost 시 줌아웃 재포착+고운스텝 복구(방안3 확장).
    const z = await this.zoomToWidthWithRecovery(t, c, presetZoom, peerOffsets, base);

    return {
      camIdx: t.camIdx,
      presetIdx: t.presetIdx,
      slotId: t.slotId,
      globalIdx: t.globalIdx,
      ptz: z.ptz,
      plateWidth: z.plateWidth ?? c.plateWidth ?? 0,
      centered: true,
      converged: z.ok,
      ...(z.ok ? {} : { reason: z.reason }),
    };
  }

  /**
   * acquire·목표 zoom 산출(설계 §A-2, 순수·카메라 호출 0). 게인무관 직접 목표(폭∝zoom).
   * lpdWidth = t.plateRoi.w(이미 quadBoundingRect rect). 퇴화(≤0) → acquire 스킵=프리셋시야(정직).
   * acquireZoom ≤ targetZoom 보장(목표 초과 줌인 금지 — 마감 zoomToPlateWidth 가 Zt 방향).
   */
  private computeAcquirePlan(t: PlateTarget, presetZoom: number): { targetZoom: number; acquireZoom: number } {
    const lpdWidth = t.plateRoi.w;
    if (lpdWidth <= LPD_WIDTH_EPS) return { targetZoom: presetZoom, acquireZoom: presetZoom };
    const clamp = (z: number): number => this.camera.clampZoom(z);
    const targetZoom = zoomForWidth(presetZoom, lpdWidth, this.cfg.targetPlateWidth, clamp);
    const aw = this.cfg.acquirePlateWidth ?? ACQUIRE_PLATE_WIDTH_DEFAULT;
    const acquireZoom = Math.min(targetZoom, zoomForWidth(presetZoom, lpdWidth, aw, clamp));
    return { targetZoom, acquireZoom };
  }

  /**
   * peerOffsets(원본 프리셋 프레임 상대 오프셋)를 현재 zoom 화면 오프셋으로 사전스케일(설계 §A-2).
   * 화면 이웃간격은 방사 ∝ zoom(predictCenterAfterZoom 모델과 정합) → × zoom/presetZoom.
   * centerOnPlate 는 zoom 고정이라 이 정적 스케일이 호출 내내 정확. presetZoom ≥ 1 보장(0나눗셈 없음).
   */
  private scalePeerOffsets(offsets: NormalizedPoint[], zoom: number, presetZoom: number): NormalizedPoint[] {
    const k = zoom / presetZoom;
    return offsets.map((o) => ({ x: o.x * k, y: o.y * k }));
  }

  /**
   * acquire + 줌아웃 사다리(설계 §A-2 — 오케스트레이션, 폐루프 미소유). acquireZoom 에서 centerOnPlate 를 돌리고
   * 미검(no_plate/plate_lost/max_iterations 어느 실패든)이면 한 단계씩 줌아웃(rungZoom/=step)해 프레임 안으로 판을
   * 되돌려 재포착. floor=presetZoom(그 아래는 실패근원 판크기라 무의미). 성공 rung 즉시 반환.
   * 각 rung 은 그 zoom 으로 peerOffsets 를 사전스케일해 소유권 게이트 정합 유지.
   */
  private async acquireAndCenter(
    t: PlateTarget,
    aim: Ptz,
    plan: { acquireZoom: number },
    presetZoom: number,
    peerOffsets: NormalizedPoint[],
    base: PlatePtzOpts,
  ): Promise<PlatePtzResult> {
    const step = this.cfg.acquireLadderStep ?? ACQUIRE_LADDER_STEP_DEFAULT;
    const maxSteps = this.cfg.acquireLadderMaxSteps ?? ACQUIRE_LADDER_MAX_STEPS_DEFAULT;
    let zoom = plan.acquireZoom;
    let last: PlatePtzResult | undefined;
    for (let i = 0; i <= maxSteps; i++) {
      const rungZoom = Math.max(zoom, presetZoom); // floor 클램프.
      const scaled = this.scalePeerOffsets(peerOffsets, rungZoom, presetZoom);
      const opts: PlatePtzOpts = { ...base, ...(scaled.length ? { peerOffsets: scaled } : {}) };
      const c = await this.makePlatePtz(opts).centerOnPlate(t.camIdx, t.presetIdx, {
        pan: aim.pan,
        tilt: aim.tilt,
        zoom: rungZoom,
      });
      last = c;
      if (c.ok) return c;
      logger.info(
        { cat: 'centering', phase: 'acquire', cam: t.camIdx, preset: t.presetIdx, slot: t.slotId, rung: i, rungZoom: Number(rungZoom.toFixed(3)), reason: c.reason },
        'acquire rung 미검 → 줌아웃 사다리',
      );
      if (rungZoom <= presetZoom) break; // floor 도달 → 더 낮출 곳 없음.
      zoom = rungZoom / step;
    }
    return last!;
  }

  /**
   * width 마감 + 줌아웃 복구 사다리(방안3 확장). acquire 지점(centered)에서 zoomToPlateWidth 로 targetPlateWidth 마감하되,
   * **plate_lost**(폭확대 중 게인 드리프트로 소실)면 줌아웃해 판을 재포착(centerOnPlate)한 뒤 **더 고운 줌 스텝**
   * (maxZoomStepRatio 를 목표 1 방향으로 절반씩 축소)으로 재시도. 드리프트가 스텝당 작아져 소실 없이 목표에 도달.
   * plate_lost 이외(zoom_saturated 등)·재포착 실패는 복구 무의미 → best-effort(최대폭) 반환(정직·converged=false).
   * 성공 슬롯(대다수)은 첫 시도에 ok → 루프 1회로 종료(회귀 0). 각 시도 소유권은 시작 zoom 으로 사전스케일.
   */
  private async zoomToWidthWithRecovery(
    t: PlateTarget,
    centered: PlatePtzResult,
    presetZoom: number,
    peerOffsets: NormalizedPoint[],
    base: PlatePtzOpts,
  ): Promise<PlatePtzResult> {
    const step = this.cfg.acquireLadderStep ?? ACQUIRE_LADDER_STEP_DEFAULT;
    const maxRetry = WIDTH_RECOVERY_MAX; // width 복구 전용 상한(런타임 바운드 — acquire 사다리와 분리).
    let start = centered; // 판이 센터된 known-good 상태(ptz·plate·gain).
    let ratio = this.cfg.maxZoomStepRatio ?? DEFAULT_ZOOM_STEP_RATIO;
    let best: PlatePtzResult | undefined;
    for (let i = 0; i <= maxRetry; i++) {
      if (!start.plate) break; // 방어(centered.plate 는 항상 존재 — 호출측 가드).
      const scaled = this.scalePeerOffsets(peerOffsets, start.ptz.zoom, presetZoom);
      const z = await this.makePlatePtz({
        ...base,
        plateRoi: quadBoundingRect(start.plate.quad),
        gain: start.gain,
        maxZoomStepRatio: ratio,
        ...(scaled.length ? { peerOffsets: scaled } : {}),
      }).zoomToPlateWidth(t.camIdx, t.presetIdx, start.ptz);
      if (z.ok) return z;
      best = this.widerResult(best, z);
      if (z.reason !== 'plate_lost') return best; // 포화/미검 — 복구 무의미(정직).
      // 줌아웃 재포착: 판이 확실히 잡히던 낮은 zoom 으로 물러나 재센터 → 다음 시도는 고운 스텝.
      const backZoom = Math.max(presetZoom, start.ptz.zoom / step);
      if (backZoom >= start.ptz.zoom) break; // 더 물러날 곳 없음(이미 floor).
      const scaledBack = this.scalePeerOffsets(peerOffsets, backZoom, presetZoom);
      const re = await this.makePlatePtz({
        ...base,
        ...(scaledBack.length ? { peerOffsets: scaledBack } : {}),
      }).centerOnPlate(t.camIdx, t.presetIdx, { pan: z.ptz.pan, tilt: z.ptz.tilt, zoom: backZoom });
      logger.info(
        { cat: 'centering', phase: 'width', cam: t.camIdx, preset: t.presetIdx, slot: t.slotId, retry: i, backZoom: Number(backZoom.toFixed(3)), reAcquired: re.ok },
        'width plate_lost → 줌아웃 재포착+고운스텝 복구',
      );
      if (!re.ok || !re.plate) break; // 재포착 실패 → best-effort 반환.
      start = re;
      ratio = 1 + (ratio - 1) / 2; // 스텝 절반 축소(목표 1 방향) → 드리프트↓.
    }
    return best!;
  }

  /** best-effort 폭 비교: plateWidth 큰(=목표 0.2 에 가까운) 결과 유지. 초기 undefined → 후보 채택. */
  private widerResult(a: PlatePtzResult | undefined, b: PlatePtzResult): PlatePtzResult {
    if (!a) return b;
    return (b.plateWidth ?? 0) > (a.plateWidth ?? 0) ? b : a;
  }

  /**
   * 소유권 게이트용 peer 오프셋 산출(설계 이터2 §A-2). 같은 (cam,preset) 자기제외 타 슬롯의
   * 판중심 − 자기 판중심(원본 정규화 프레임 상대 오프셋). pan/tilt 강체평행이동 불변이라 현재 프레임에서도 유효.
   * 좌표계 일관: plateRoi 는 전부 slot_setup.lpd 유래(원본 프레임). 단일슬롯 프리셋 → [] → 최근접 동작(무해).
   *
   * ★ near-zero offset 드롭(PEER_MIN_OFFSET): 두 슬롯 lpd 중심이 일치/근접하면 peer 앵커가 selfRef 와 겹쳐
   *   엄격부등호 dSelf<dPeer 가 항상 false → 모든 검출을 기각(두 슬롯 다 미검). 겹친 peer 는 Voronoi 경계를
   *   못 만들어 판별정보가 없으므로 제외 → 그 쌍은 안전하게 최근접으로 복귀(단일슬롯 규약과 일관).
   */
  private peerOffsetsFor(t: PlateTarget, group: PlateTarget[]): NormalizedPoint[] {
    const s = center(t.plateRoi);
    return group
      .filter((p) => p.slotId !== t.slotId)
      .map((p) => {
        const c = center(p.plateRoi);
        return { x: c.cx - s.cx, y: c.cy - s.cy };
      })
      .filter((o) => Math.hypot(o.x, o.y) >= PEER_MIN_OFFSET);
  }

  /**
   * 선조준(pre-aim): 슬롯 LPD 박스 중심 → 화면중앙으로 base PTZ 를 결정형 1스텝 보정.
   * 공유 base(프리셋)에서 슬롯마다 다른 시작점을 만들어 폐루프가 이웃 판으로 갈아타는 latch 를 차단(R1).
   * controlMath(aimPtzForPoint) + geometry.center 재사용 — 코어 무접촉.
   * zoom 은 불변(넓은 시야 유지, 센터링은 zoom 미접촉). PREAIM_MAX_STEP coarse 클램프.
   */
  private preAimPtz(t: PlateTarget, base: Ptz): Ptz {
    const c = center(t.plateRoi); // plateRoi 는 이미 quadBoundingRect rect.
    return aimPtzForPoint({ x: c.cx, y: c.cy }, base, this.gainRef(), PREAIM_MAX_STEP);
  }

  /** 폴백 게인(측정 기준 zoom=1). pre-aim·클릭점 조준 공용. */
  private gainRef(): { gainPan: number; gainTilt: number; zoomRef: number } {
    return { gainPan: this.cfg.fallbackGainPanDeg, gainTilt: this.cfg.fallbackGainTiltDeg, zoomRef: 1 };
  }

  /** cfg → PlatePtz opts(그대로 전달). matchRadiusNorm 은 PlatePtz 기본값. maxZoomStepRatio 는 cfg 지정 시 전달. */
  private baseOpts(): PlatePtzOpts {
    return {
      centerTol: this.cfg.centerTol,
      targetPlateWidth: this.cfg.targetPlateWidth,
      widthTol: this.cfg.widthTol,
      maxIterations: this.cfg.maxIterations,
      probeStepDeg: this.cfg.probeStepDeg,
      maxStepDeg: this.cfg.maxStepDeg,
      settleMs: this.cfg.settleMs,
      fallbackGainPanDeg: this.cfg.fallbackGainPanDeg,
      fallbackGainTiltDeg: this.cfg.fallbackGainTiltDeg,
      ...(this.cfg.maxZoomStepRatio ? { maxZoomStepRatio: this.cfg.maxZoomStepRatio } : {}),
    };
  }

  /**
   * 시작 PTZ = 프리셋 정본(GET /cameras). 키별 1회 조회 캐시. 실패·미보유 → 0/0/1 폴백 + warn.
   * override(개별 경로의 뷰어 소스) 주입 시엔 그 소스로 조회하고 **캐시를 쓰지 않는다** —
   * 캐시 키는 cam/preset 뿐이라 소스가 다르면 서로 다른 PTZ 테이블이 섞인다.
   */
  private async startPtzFor(t: PlateTarget, override?: ICameraClient): Promise<Ptz> {
    const key = `${t.camIdx}:${t.presetIdx}`;
    const hit = override ? undefined : this.ptzByKey.get(key);
    if (hit) return hit;
    const ptz = await resolvePresetPtz(override ?? this.camera, t.camIdx, t.presetIdx);
    if (!ptz) {
      logger.warn({ cam: t.camIdx, preset: t.presetIdx }, '프리셋 PTZ 미해결 → 0/0/1 시작(시야 열화 가능)');
    }
    const resolved = ptz ?? FALLBACK_START_PTZ;
    if (!override) this.ptzByKey.set(key, resolved);
    return resolved;
  }

  /**
   * slot_setup 센터라이징 부분 갱신(성공 항목만 · best-effort). slot_id 키 UPDATE(pan/tilt/zoom/centered/img1).
   * ★ 정수 slot_id = it.globalIdx(setup_artifact.globalIndex 역참조, 전역 1..N). globalIdx 부재면 매핑 불가 → 스킵.
   *   구 CenteringSlotRow(문자열 slotId + pos JSON) → SlotCenteringRow(정수 slot_id + 분해 pan/tilt/zoom, 설계서 §2-4).
   * 실패해도 JSON(정본)·잡 완료를 막지 않는다 — Finalizer 의 slot_setup 격리 패턴.
   */
  private saveCenteringSlots(items: SlotPtzItem[]): void {
    if (!this.store) return;
    const updatedAt = this.now();
    const rows: SlotCenteringRow[] = [];
    for (const it of items) {
      // centered(pan/tilt 수렴)만 게이트 — zoom 미수렴(converged:false)도 pan/tilt 는 유효하므로 저장.
      // centered:false(번호판 자체 미검)만 제외(오염 방지). zoom-수렴 뉘앙스는 slot_ptz.json 이 정본.
      if (!it.centered) continue;
      if (it.globalIdx == null) {
        logger.warn(
          { slot: it.slotId, cam: it.camIdx, preset: it.presetIdx },
          'globalIdx 부재 → slot_setup 센터라이징 매핑 불가(스킵)',
        );
        continue;
      }
      rows.push({
        slotId: it.globalIdx, // 정수 전역 slot_id(= slot_setup.slot_id, §2-5 정합).
        pan: it.ptz.pan,
        tilt: it.ptz.tilt,
        zoom: it.ptz.zoom,
        centered: 1,
        img1: null,
        updatedAt,
      });
    }
    if (rows.length === 0) return;
    try {
      this.store.upsertSlotCentering(rows);
    } catch (e) {
      logger.warn({ err: e, rows: rows.length }, 'slot_setup 센터라이징 갱신 실패(JSON 은 정상 — 잡 계속)');
    }
  }

  private skipItem(t: PlateTarget, ptz: Ptz, plateWidth: number, reason?: PlatePtzResult['reason'] | string): SlotPtzItem {
    return {
      camIdx: t.camIdx,
      presetIdx: t.presetIdx,
      slotId: t.slotId,
      globalIdx: t.globalIdx,
      ptz,
      plateWidth,
      centered: false,
      converged: false,
      ...(reason ? { reason } : {}),
    };
  }
}
