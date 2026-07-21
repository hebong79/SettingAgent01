// 번호판 탐색·확대반복·역계산 배치 잡(설계서 §5, Phase 2). PtzCalibrator 상태머신 패턴 미러.
//
// 탐색 폐루프는 소유하지 않는다 — PlateDiscovery(결정형 도구)에 위임하고, 이 클래스는
// 잡 상태머신·대상 펼침(앞면중심 기준)·시작 PTZ 해석·JSON 정본 + slot_setup.lpd 부분 UPDATE 만 담당.
//
// ★ 센터라이징(PtzCalibrator)의 상류 별개 잡: discovery 가 slot_setup.lpd 를 채우면
//   expandPlateTargetsFromSlotSetup(v.lpd==null 누락)이 검출 의존에서 독립된다(과업 A2 해소).
//   쓰기는 slot_id 키 부분 UPDATE(upsertSlotLpd) — DELETE+INSERT 절대 금지(wipe fragility).

import type { ICameraClient } from '../clients/CameraClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { SlotLpdRow } from '../capture/types.js';
import { logger } from '../util/logger.js';
import { stringify5 } from '../util/round.js';
import { resolvePresetPtz } from '../capture/detectPipeline.js';
import { buildOccupyRegionsBySlot } from '../domain/occupancyRegion.js';
import type { NormalizedPoint } from '../domain/types.js';
import { PlateDiscovery, type PlateDiscoveryOpts } from './plateDiscovery.js';
import { expandDiscoveryTargets, writePlateDiscovery } from './plateDiscoveryWriter.js';
import type {
  DiscoveryTarget,
  DiscoverState,
  DiscoverStatus,
  PlateDiscoveryArtifact,
  PlateDiscoveryItem,
  Ptz,
} from './types.js';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** PlateDiscovery 중 이 잡이 쓰는 표면(테스트 시임 경계). */
type PlateDiscoveryApi = Pick<PlateDiscovery, 'discoverSlot'>;

export interface PlateDiscoveryJobDeps {
  camera: ICameraClient;
  lpd: LpdClient;
  /** 대상 소스(slot_setup 조회) + slot_setup.lpd 미러 저장. 필수. */
  store: Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>;
  /** plate_discovery.json 경로. */
  outFile: string;
  /** PlateDiscovery 팩토리 주입(테스트 시임). 기본=new PlateDiscovery({camera, lpd, sleep, onFrame}, opts). */
  makeDiscovery?: (opts: PlateDiscoveryOpts) => PlateDiscoveryApi;
  /** plate_discovery.json writer 주입(테스트는 캡처 stub). 기본=writePlateDiscovery. */
  writer?: (artifact: PlateDiscoveryArtifact, outFile: string) => void;
  /** 탐색 상수 오버라이드(기본 = PlateDiscovery 코드 기본값 §3-3). */
  opts?: PlateDiscoveryOpts;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  /** 종단 완료 콜백(옵셔널) — 파이프라인 자동연쇄 배선용. 미주입 시 no-op(수동 /discover/ptz 회귀 0). */
  onFinished?: (state: 'done' | 'error') => void;
}

/**
 * 번호판 디스커버리 잡. CaptureJob/PtzCalibrator 패턴: 단일 인메모리 상태머신, 중복 시작 거부, 슬롯 순차 await.
 * 대상 = slot_setup 중 slot3d_front_center 보유 전 슬롯(검출 무관).
 */
export class PlateDiscoveryJob {
  private state: DiscoverState = 'idle';
  private done = 0;
  private total = 0;
  private found = 0;
  private current?: { slotId: string };
  private startedAt?: string;
  private endedAt?: string;

  private readonly store: Pick<SqliteStore, 'getSlotSetup' | 'upsertSlotLpd'>;
  private readonly outFile: string;
  private readonly camera: ICameraClient;
  private readonly makeDiscovery: (opts: PlateDiscoveryOpts) => PlateDiscoveryApi;
  private readonly writer: (artifact: PlateDiscoveryArtifact, outFile: string) => void;
  private readonly opts: PlateDiscoveryOpts;
  private readonly now: () => string;
  private readonly onFinished?: (state: 'done' | 'error') => void;
  /** 프리셋 PTZ 조회 캐시(`${cam}:${preset}` → PTZ) — PtzCalibrator ptzByKey 패턴. */
  private readonly ptzByKey = new Map<string, Ptz | null>();
  /** 최근 탐색 캡처 프레임(뷰어 /discover/frame 용) — PtzCalibrator.getLastFrame 패턴. */
  private lastFrame?: { jpeg: Buffer; camIdx: number; presetIdx: number };

  constructor(deps: PlateDiscoveryJobDeps) {
    this.store = deps.store;
    this.outFile = deps.outFile;
    this.camera = deps.camera;
    this.opts = deps.opts ?? {};
    const sleep = deps.sleep ?? defaultSleep;
    const onFrame = (jpeg: Buffer, camIdx: number, presetIdx: number): void => {
      this.lastFrame = { jpeg, camIdx, presetIdx };
    };
    this.makeDiscovery =
      deps.makeDiscovery ?? ((opts) => new PlateDiscovery({ camera: deps.camera, lpd: deps.lpd, sleep, onFrame }, opts));
    this.writer = deps.writer ?? writePlateDiscovery;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.onFinished = deps.onFinished;
  }

  /** 최근 탐색 캡처 프레임(없으면 undefined). 뷰어 /discover/frame 용. 잡 종료 후에도 유지. */
  getLastFrame(): { jpeg: Buffer; camIdx: number; presetIdx: number } | undefined {
    return this.lastFrame;
  }

  getStatus(): DiscoverStatus {
    return {
      state: this.state,
      done: this.done,
      total: this.total,
      found: this.found,
      ...(this.current ? { current: this.current } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
    };
  }

  /**
   * 잡 시작(중복 거부 throw → 라우트 409). 대상=slot_setup 앞면중심 펼침(필터 slotIds).
   * 슬롯 순차 처리 → JSON 정본 저장 + slot_setup.lpd 부분 UPDATE. 백그라운드(발화 후 미대기).
   */
  start(filter: { slotIds?: string[]; cam?: number; preset?: number } = {}): { total: number } {
    if (this.state === 'running') throw new Error('discover already running');
    let targets = expandDiscoveryTargets(this.store.getSlotSetup());
    if (filter.cam != null && filter.preset != null) {
      // 현재 프리셋 한정(cam+preset 동시 전달 시만) — expandDiscoveryTargets 불변, 기존 slotIds 필터와 같은 자리.
      targets = targets.filter((t) => t.camIdx === filter.cam && t.presetIdx === filter.preset);
    }
    if (filter.slotIds && filter.slotIds.length > 0) {
      const set = new Set(filter.slotIds);
      targets = targets.filter((t) => set.has(t.slotId));
    }
    this.state = 'running';
    this.done = 0;
    this.total = targets.length;
    this.found = 0;
    this.current = undefined;
    this.startedAt = this.now();
    this.endedAt = undefined;
    // 직전 실행 프레임 무효화 — 새 실행이 첫 캡처를 넣기 전까지 /discover/frame 이 과거 화면을 서빙하면
    // 카메라 위치와 화면이 어긋나 보인다(PtzCalibrator 와 동일 병).
    this.lastFrame = undefined;
    void this.run(targets);
    return { total: targets.length };
  }

  private async run(targets: DiscoveryTarget[]): Promise<void> {
    const items: PlateDiscoveryItem[] = [];
    const discovery = this.makeDiscovery(this.opts);
    // 프리셋별 대상 그룹핑(§9-2) — 배타성 게이트 peer 앵커 소스(1회 산출).
    const byPreset = new Map<string, DiscoveryTarget[]>();
    for (const t of targets) {
      const key = `${t.camIdx}:${t.presetIdx}`;
      const g = byPreset.get(key);
      if (g) g.push(t);
      else byPreset.set(key, [t]);
    }
    try {
      for (const t of targets) {
        this.current = { slotId: t.slotId };
        try {
          const presetPtz = await this.startPtzFor(t);
          // 같은 프리셋 타 슬롯(자기 제외)의 non-null 하향앵커 = peer 앵커(§9).
          const peers = byPreset.get(`${t.camIdx}:${t.presetIdx}`) ?? [];
          const peerAnchors = peers.flatMap((p) => (p.slotId !== t.slotId && p.anchor != null ? [p.anchor] : []));
          const item = await discovery.discoverSlot(t, presetPtz, peerAnchors);
          items.push(item);
          if (item.found) this.found += 1;
        } catch (e) {
          // 개별 슬롯 실패 흡수(경고 + 정직 리포트, 잡 중단 아님 — PtzCalibrator 패턴).
          logger.warn({ err: e, slot: t.slotId, cam: t.camIdx, preset: t.presetIdx }, '번호판 디스커버리 슬롯 실패(흡수)');
          items.push({
            camIdx: t.camIdx,
            presetIdx: t.presetIdx,
            slotId: t.slotId,
            globalIdx: t.globalIdx,
            found: false,
            lpdOrig: null,
            tier: 'full',
            step: 0,
            confidence: 0,
            reason: 'no_plate',
          });
        }
        this.done += 1;
      }
      this.writer({ createdAt: this.now(), items }, this.outFile);
      this.saveSlotLpd(items);
      this.current = undefined;
      this.endedAt = this.now();
      this.state = 'done';
      logger.info({ total: this.total, found: this.found }, '번호판 디스커버리 잡 완료');
      this.notifyFinished('done');
    } catch (e) {
      logger.error({ err: e }, '번호판 디스커버리 잡 예외 → error');
      this.endedAt = this.now();
      this.state = 'error';
      this.notifyFinished('error');
    }
  }

  /** 종단 완료 콜백 통지(옵셔널). throw 흡수 — 콜백이 잡을 죽이지 않는다(PtzCalibrator 미러). */
  private notifyFinished(state: 'done' | 'error'): void {
    try {
      this.onFinished?.(state);
    } catch (e) {
      logger.warn({ err: e, state }, '번호판 디스커버리 완료 콜백 예외(흡수)');
    }
  }

  /** 시작 PTZ = 프리셋 정본(GET /cameras). 키별 1회 조회 캐시. 미해결 → null(requestImage 가 프리셋 기본). */
  private async startPtzFor(t: DiscoveryTarget): Promise<Ptz | null> {
    const key = `${t.camIdx}:${t.presetIdx}`;
    if (this.ptzByKey.has(key)) return this.ptzByKey.get(key) ?? null;
    const ptz = await resolvePresetPtz(this.camera, t.camIdx, t.presetIdx);
    if (!ptz) {
      logger.warn({ cam: t.camIdx, preset: t.presetIdx }, '프리셋 PTZ 미해결 → echo 폴백(시야 열화 가능)');
    }
    this.ptzByKey.set(key, ptz);
    return ptz;
  }

  /**
   * 찾은 슬롯의 원본 좌표 LPD OBB 를 slot_setup.lpd 로 부분 UPDATE(best-effort).
   * ★ globalIdx(=정수 slot_id) 부재·미검출 항목은 스킵(위장 저장 금지). 실패해도 JSON 정본·잡 완료 무방.
   */
  private saveSlotLpd(items: PlateDiscoveryItem[]): void {
    const updatedAt = this.now();
    const found = items.filter((it) => {
      if (!it.found || it.lpdOrig == null) return false;
      if (it.globalIdx == null) {
        logger.warn({ slot: it.slotId, cam: it.camIdx, preset: it.presetIdx }, 'globalIdx 부재 → slot_setup.lpd 매핑 불가(스킵)');
        return false;
      }
      return true;
    });
    // 점유영역 = 번호판 기준 사다리꼴(뷰어 라이브와 같은 규약, domain/occupancyRegion).
    // 겹침 회피 배율이 프레임 단위 집합 연산이라 **프리셋별로 묶어** 생성한다. 미산출 슬롯은 생략(lpd 는 저장).
    const regionBySlot = new Map<number, NormalizedPoint[]>();
    const byPreset = new Map<string, PlateDiscoveryItem[]>();
    for (const it of found) {
      const key = `${it.camIdx}:${it.presetIdx}`;
      const g = byPreset.get(key) ?? [];
      g.push(it);
      byPreset.set(key, g);
    }
    for (const group of byPreset.values()) {
      try {
        const regions = buildOccupyRegionsBySlot(group.map((it) => ({ slotId: it.globalIdx!, quad: it.lpdOrig! })));
        for (const [slotId, poly] of regions) regionBySlot.set(slotId, poly);
      } catch (e) {
        logger.warn({ err: e, cam: group[0]?.camIdx, preset: group[0]?.presetIdx }, '점유영역 생성 실패(occupy_range 생략, lpd 는 저장)');
      }
    }
    const rows: SlotLpdRow[] = found.map((it) => {
      const poly = regionBySlot.get(it.globalIdx!);
      return {
        slotId: it.globalIdx!,
        lpdObb: stringify5(it.lpdOrig!),
        occupyRange: poly ? stringify5(poly) : undefined,
        updatedAt,
      };
    });
    if (rows.length === 0) return;
    try {
      this.store.upsertSlotLpd(rows);
    } catch (e) {
      logger.warn({ err: e, rows: rows.length }, 'slot_setup.lpd 갱신 실패(JSON 은 정상 — 잡 계속)');
    }
  }
}
