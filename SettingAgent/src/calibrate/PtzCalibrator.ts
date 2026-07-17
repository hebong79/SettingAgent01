import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { Repository } from '../store/Repository.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { SlotCenteringRow } from '../capture/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { logger } from '../util/logger.js';
import { quadBoundingRect } from '../domain/geometry.js';
import { resolvePresetPtz } from '../capture/detectPipeline.js';
import { expandPlateTargets, writeSlotPtz } from './slotPtzWriter.js';
import { buildSlotPtzJson } from './controlMath.js';
import { PlatePtz, type PlatePtzOpts, type PlatePtzResult } from './platePtz.js';
import type { PlateTarget, Ptz, SlotPtzItem, CalibrateState, CalibrateStatus } from './types.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 프리셋 PTZ 조회 실패 시 폴백(조용한 강등 금지 — warn 동반). */
const FALLBACK_START_PTZ: Ptz = { pan: 0, tilt: 0, zoom: 1 };

/** PlatePtz 중 이 잡이 쓰는 표면(테스트 시임 경계). */
type PlatePtzApi = Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth'>;

export interface PtzCalibratorDeps {
  camera: ICameraClient;
  lpd: LpdClient;
  repo: Repository;
  cfg: ToolsConfig['calibrate'];
  /** centering_slot 미러 저장(옵셔널). 미주입 시 JSON 만 저장 — 잡은 정상 동작. */
  store?: Pick<SqliteStore, 'upsertSlotCentering'>;
  /** PlatePtz 팩토리 주입(테스트 시임). 기본=new PlatePtz({camera, lpd, sleep}, opts). */
  makePlatePtz?: (opts: PlatePtzOpts) => PlatePtzApi;
  /** slot_ptz.json writer 주입(테스트는 캡처 stub). 기본=writeSlotPtz. */
  writer?: (artifact: ReturnType<typeof buildSlotPtzJson>, outFile: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

/**
 * 주차면별 번호판 중심정렬·줌 센터라이징 잡(설계서 §1.3·§3.2).
 * CaptureJob 패턴 차용: 단일 인메모리 상태머신, 중복 시작 거부, 슬롯 순차 await.
 *
 * 제어 폐루프는 **소유하지 않는다** — 라이브 검증된 `PlatePtz`(결정형 도구)에 위임하고,
 * 이 클래스는 잡 상태머신·대상 펼침·시작 PTZ 해석·결과 매핑·저장(JSON + DB 미러)만 담당한다.
 *
 * 순서 엄수: centerOnPlate(pan/tilt) 수렴 → zoomToPlateWidth(폭). 센터링 실패 시 zoom 은 시도하지 않는다
 * (미중심 zoom-in 은 중심 오차를 배율만큼 확대해 대상을 날린다 — platePtz 설계 §2.3).
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
  private readonly repo: Repository;
  private readonly store?: Pick<SqliteStore, 'upsertSlotCentering'>;
  private readonly makePlatePtz: (opts: PlatePtzOpts) => PlatePtzApi;
  private readonly writer: (artifact: ReturnType<typeof buildSlotPtzJson>, outFile: string) => void;
  private readonly now: () => string;
  /** 프리셋 PTZ 조회 캐시(`${cam}:${preset}` → PTZ) — Finalizer ptzByKey 패턴. */
  private readonly ptzByKey = new Map<string, Ptz>();

  constructor(deps: PtzCalibratorDeps) {
    this.camera = deps.camera;
    this.cfg = deps.cfg;
    this.repo = deps.repo;
    this.store = deps.store;
    const sleep = deps.sleep ?? defaultSleep;
    this.makePlatePtz = deps.makePlatePtz ?? ((opts) => new PlatePtz({ camera: deps.camera, lpd: deps.lpd, sleep }, opts));
    this.writer = deps.writer ?? writeSlotPtz;
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
          logger.warn({ err: e, slot: t.slotId, cam: t.camIdx, preset: t.presetIdx }, '센터라이징 슬롯 실패(흡수)');
          items.push(this.skipItem(t, { pan: 0, tilt: 0, zoom: 1 }, 0, 'error'));
        }
        this.done += 1;
      }
      this.writer(buildSlotPtzJson(items, this.now()), this.cfg.outFile);
      this.saveCenteringSlots(items);
      this.current = undefined;
      this.endedAt = this.now();
      this.state = 'done';
    } catch (e) {
      logger.error({ err: e }, '센터라이징 잡 예외 → error');
      this.endedAt = this.now();
      this.state = 'error';
    }
  }

  /**
   * 슬롯 1건 센터라이징: PlatePtz 위임 2단계(설계 §5-2).
   * ★ center 결과의 gain 을 zoom 단계로 체이닝(무측정 fallback 게인 의존 소멸) +
   *   zoom 단계 초기 prior 는 센터링 후 마지막 관측 위치로 갱신(이웃 번호판 오선정 차단).
   */
  private async calibrateSlot(t: PlateTarget): Promise<SlotPtzItem> {
    const startPtz = await this.startPtzFor(t);
    const base = this.baseOpts();

    const c = await this.makePlatePtz({ ...base, plateRoi: t.plateRoi }).centerOnPlate(t.camIdx, t.presetIdx, startPtz);
    if (!c.ok || !c.plate) return this.skipItem(t, c.ptz, c.plateWidth ?? 0, c.reason);

    const z = await this.makePlatePtz({
      ...base,
      plateRoi: quadBoundingRect(c.plate.quad),
      gain: c.gain,
    }).zoomToPlateWidth(t.camIdx, t.presetIdx, c.ptz);

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

  /** cfg → PlatePtz opts(그대로 전달). matchRadiusNorm·maxZoomStepRatio 는 PlatePtz 기본값 사용. */
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
    };
  }

  /** 시작 PTZ = 프리셋 정본(GET /cameras). 키별 1회 조회 캐시. 실패·미보유 → 0/0/1 폴백 + warn. */
  private async startPtzFor(t: PlateTarget): Promise<Ptz> {
    const key = `${t.camIdx}:${t.presetIdx}`;
    const hit = this.ptzByKey.get(key);
    if (hit) return hit;
    const ptz = await resolvePresetPtz(this.camera, t.camIdx, t.presetIdx);
    if (!ptz) {
      logger.warn({ cam: t.camIdx, preset: t.presetIdx }, '프리셋 PTZ 미해결 → 0/0/1 시작(시야 열화 가능)');
    }
    const resolved = ptz ?? FALLBACK_START_PTZ;
    this.ptzByKey.set(key, resolved);
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
      if (!it.centered || !it.converged) continue;
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
