import type { SqliteStore } from './SqliteStore.js';
import type { Repository } from '../store/Repository.js';
import { defaultSaveName, type SaveStore } from '../store/SaveStore.js';
import type { SetupBrain, FinalizeCaptureResult } from '../brain/SetupBrain.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { aggregate, type AggregateOptions } from './Aggregator.js';
import { clusterRef } from './CheckpointReviewer.js';
import { buildPlateAnchoredQuad, deconflictPolygons, estimatePlateQuadFromNeighbors, type PlateNeighbor } from './floorRoi.js';
import { loadNormalizedPlaceRoi, normalizeGlobalIdx } from './placeRoi.js';
import { assignClustersToSpaces } from './spaceAssign.js';
import { orderByPosition } from '../setup/ordering.js';
import { buildGlobalIndex, validateCoverage, type IndexableSlot } from '../setup/GlobalIndexer.js';
import { pad, rectToQuad } from '../domain/geometry.js';
import { logger } from '../util/logger.js';
import type {
  GlobalSlotIndex,
  NormalizedQuad,
  NormalizedRect,
  ParkingSlot,
  Preset,
  SetupArtifact,
} from '../domain/types.js';
import type { AggregatedSlot, SlotSetupRow } from './types.js';
import type { CaptureSnapshot } from './CaptureJob.js';

/** 슬롯 ID(기존 slotIdOf 규칙 동일). */
function slotIdOf(camIdx: number, presetIdx: number, positionIdx: number): string {
  return `c${camIdx}p${presetIdx}s${positionIdx}`;
}

export interface FinalizerDeps {
  store: SqliteStore;
  repo: Repository;
  brain?: SetupBrain;
  cfg: ToolsConfig['capture'];
  /** ROI 패딩·y 밴드 허용치(기존 setup 값 재사용). */
  roiPadding: number;
  yBandTolerance: number;
  now?: () => string;
  /** 프리셋별 기대 면 수(LLM 보조 입력, 선택). */
  expectedByPreset?: Record<string, number>;
  /** finalize 완료 시 결과 스냅샷 자동 저장(save/). 미주입 시 자동 저장 생략(가산). */
  saveStore?: SaveStore;
  /** 미리 정의된 주차면 폴리곤 파일(Place01/PtzCamRoi.json) 경로. 주입 시 finalize 에서 slot_setup 저장(§06). */
  placeRoiFile?: string;
}

export interface FinalizeResult {
  artifact: SetupArtifact;
  slots: number;
  globalCount: number;
  /** 로직 점유(프론트) vs LLM 점유(캡처 중 저장분) 1회 비교 결과(best-effort, R4). 비교 불가 시 미부착. */
  occupancyAgreement?: { comparedPresets: number; comparedSpaces: number; agreedSpaces: number; agreementRate: number };
}

/** finalize 바디로 전달되는 프론트 로직 점유 스냅샷(프리셋별). */
export interface LogicOccupancyPreset {
  key: string;
  spaces: Array<{ idx: number; occupied: boolean }>;
}

/**
 * 전체 집계 + (LLM 활성 시) 최종 보조 판정 → SetupArtifact 조립 → Repository.saveArtifact + artifact_snapshot 기록.
 * 좌표 불변식: ParkingSlot.roi = 집계 대표 bbox(+패딩). LLM 은 중복/라벨/거부 메타만(좌표 생성·수정 금지).
 * LLM 비활성/실패 시 결정형 강등(rejected 제외, zone=cam{N}, report 없음). 설계서 §4.4.
 */
export class Finalizer {
  private readonly now: () => string;
  constructor(private deps: FinalizerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private aggOptions(): AggregateOptions {
    return {
      clusterDist: this.deps.cfg.clusterDist,
      clusterMinSupport: this.deps.cfg.clusterMinSupport,
      minConfidence: this.deps.cfg.minConfidence,
    };
  }

  async finalize(snapshot: CaptureSnapshot, opts?: { logicOccupancy?: LogicOccupancyPreset[] }): Promise<FinalizeResult> {
    // 1) 최신 결정형 집계(멱등 — 체크포인트 status 갱신을 덮어쓰지 않도록 기존 status 보존).
    //    구 DB 재조회(getDetectionsForRun/getPresetRounds/getAggregatedSlots) → 인메모리 스냅샷 참조(설계서 §2.3).
    const fresh = aggregate(snapshot.dets, snapshot.presetRounds, this.aggOptions());

    // 체크포인트에서 갱신한 status(merged/rejected)를 보존 병합.
    const prior = new Map(snapshot.aggregated.map((s) => [clusterRef(s), s.status]));
    for (const s of fresh) {
      const ps = prior.get(clusterRef(s));
      if (ps === 'merged' || ps === 'rejected') s.status = ps;
    }

    // 2) (LLM 활성 시) 최종 보조 판정.
    let llm: FinalizeCaptureResult | null = null;
    if (this.deps.brain?.enabled && this.deps.brain.finalizeCapture) {
      const presetCounts = new Map<string, number>();
      for (const s of fresh) if (s.status !== 'rejected' && s.status !== 'merged') {
        presetCounts.set(s.presetKey, (presetCounts.get(s.presetKey) ?? 0) + 1);
      }
      try {
        llm = await this.deps.brain.finalizeCapture({
          totalSlots: [...presetCounts.values()].reduce((a, b) => a + b, 0),
          presets: [...presetCounts.entries()].map(([key, slotCount]) => ({
            key,
            slotCount,
            expected: this.deps.expectedByPreset?.[key],
          })),
          // 구 getCheckpoints(DB 체크포인트 노트) 폐기(LLM 최소화, 설계서 §2.3) — 노트 미제공.
          checkpointNotes: [],
        });
      } catch {
        llm = null; // 장애 격리: 결정형 강등.
      }
    }

    // 2b) (best-effort, R4) 로직 점유(바디 전달분) vs LLM 점유(캡처 중 인메모리 occByPreset) 1회 비교.
    // 새 LLM 호출 없음 — 스냅샷의 축소 occupancy 재사용(구 getLatestOccupancy DB 대체, 설계서 §2.3).
    // graceful skip 조건: LLM 전면 비활성, 로직 점유 바디 미전달, 저장분 없음, 비교 가능한 면 0개.
    let occupancyAgreement: FinalizeResult['occupancyAgreement'];
    if (this.deps.brain?.enabled && opts?.logicOccupancy?.length) {
      const llmSpacesByKey = new Map<string, Array<{ id: number; occupied: boolean }>>();
      for (const [key, j] of snapshot.occByPreset) {
        llmSpacesByKey.set(key, j.spaces.map((s) => ({ id: s.id, occupied: s.occupied })));
      }
      let comparedPresets = 0;
      let comparedSpaces = 0;
      let agreedSpaces = 0;
      for (const preset of opts.logicOccupancy) {
        const llmSpaces = llmSpacesByKey.get(preset.key);
        if (!llmSpaces) continue;
        comparedPresets += 1;
        for (const sp of preset.spaces) {
          const match = llmSpaces.find((s) => s.id === sp.idx);
          if (!match) continue;
          comparedSpaces += 1;
          if (match.occupied === sp.occupied) agreedSpaces += 1;
        }
      }
      if (comparedSpaces > 0) {
        occupancyAgreement = { comparedPresets, comparedSpaces, agreedSpaces, agreementRate: agreedSpaces / comparedSpaces };
      }
    }

    // 3) LLM rejects/duplicates 반영(좌표 불변 — 채택 여부 메타만).
    const rejectedRefs = new Set<string>(llm?.rejects ?? []);
    for (const group of llm?.duplicates ?? []) {
      for (const ref of group.slice(1)) rejectedRefs.add(ref);
    }

    // 4) 채택 클러스터만 → 프리셋별 positionIdx 부여 → ParkingSlot/Preset 조립.
    //    floor 발자국은 assemble 이 buildPlateAnchoredQuad 결정형으로 항상 생성(구 getFloorRois 별 테이블 폐기, 설계서 §6.5).
    const accepted = fresh.filter((s) => s.status === 'candidate' && !rejectedRefs.has(clusterRef(s)));
    const { presets, slots, indexable } = this.assemble(accepted, llm?.zoneLabels ?? {});

    // 주차면 점유 로그(cat:'occupancy'): 채택 클러스터별 점유 근거(support=검출 수).
    logger.info(
      {
        cat: 'occupancy',
        accepted: accepted.length,
        slots: slots.length,
        byCluster: accepted.map((s) => ({ ref: clusterRef(s), support: s.support, occupancyRate: s.occupancyRate, confidence: s.confidence })),
      },
      '주차면 점유 최종화',
    );

    const globalIndex: GlobalSlotIndex[] = buildGlobalIndex(indexable);
    const coverage = validateCoverage(globalIndex, slots);
    if (!coverage.ok) {
      throw new Error(`전역 인덱스 커버리지 불일치 missing=${coverage.missing} extra=${coverage.extra}`);
    }

    const artifact: SetupArtifact = {
      presets,
      slots,
      globalIndex,
      createdAt: this.now(),
      ...(llm?.report_ko ? { report: llm.report_ko } : {}),
    };
    this.deps.repo.saveArtifact(artifact);
    // 구 insertArtifactSnapshot(artifact_snapshot 테이블) 폐기(설계서 §2.3) — 정본은 repo.saveArtifact(setup_artifact.json).

    // 파일 바닥ROI(PtzCamRoi.json) 기준 슬롯 셋업(slot_setup) 전량 교체(§06 · best-effort — 파일 없음/검출 없음 시 graceful skip,
    // artifact 흐름 불변). VPD/LPD/점유영역은 accepted(집계 대표) 재사용(D1) + pointInPolygon 공간배정(D2/D3).
    // ★ 단일 트랜잭션 교체(실패 자동 롤백 → 이전 확정본 보존, 설계서 배경 A.3).
    // pan/tilt/zoom/centered/img1 은 센터라이징(PtzCalibrator) 산출 — finalize 시점엔 미보유 → null/0(이후 upsertSlotCentering 채움).
    try {
      const place = await loadNormalizedPlaceRoi(this.deps.placeRoiFile);
      if (place) {
        const byPresetAcc = new Map<string, AggregatedSlot[]>();
        for (const s of accepted) {
          let arr = byPresetAcc.get(s.presetKey);
          if (!arr) byPresetAcc.set(s.presetKey, (arr = []));
          arr.push(s);
        }
        const rows: SlotSetupRow[] = [];
        // slot_id 는 **전역번호(1..N)** — 뷰어(web/core.js normalizeGlobalIdx)와 동일 규칙으로
        // 정규화(Unity 생성 0-based 파일도 재부여). 파일이 이미 1..N 이면 무변경(멱등). setup_artifact.globalIndex 와 정합(§2-5).
        const byPresetPlace = normalizeGlobalIdx(place.byPreset);
        const updatedAt = this.now();
        for (const [key, spaces] of byPresetPlace) {
          const [camIdx, presetIdx] = key.split(':').map(Number);
          const clusters = byPresetAcc.get(key) ?? [];
          // 프리셋 단위 상호배타 전역-그리디 1:1 배정(설계서 §2/§3). 선착순 find() 대신 사전 배정.
          const assigned = assignClustersToSpaces(spaces, clusters, { centroidGate: this.deps.cfg.slotAssignGate });
          spaces.forEach((sp, i) => {
            const hit = assigned.get(i) ?? null;
            // 점유영역(발자국) = 배정 차량 rect + 번호판 quad 로 결정형 사변형(부재 시 null).
            const occupyRange = hit
              ? buildPlateAnchoredQuad({ x: hit.x, y: hit.y, w: hit.w, h: hit.h }, hit.plateQuad ?? undefined)
              : null;
            rows.push({
              slotId: sp.idx,
              camId: camIdx,
              presetId: presetIdx,
              presetSlotIdx: i + 1, // 프리셋 내 배열순 1-based.
              slotRoi: JSON.stringify(sp.points),
              vpdBbox: hit ? JSON.stringify({ x: hit.x, y: hit.y, w: hit.w, h: hit.h }) : null,
              lpdObb: hit?.plateQuad ? JSON.stringify(hit.plateQuad) : null,
              occupyRange: occupyRange ? JSON.stringify(occupyRange) : null,
              pan: null,
              tilt: null,
              zoom: null,
              centered: 0,
              img1: null,
              updatedAt,
            });
          });
        }
        this.deps.store.replaceSlotSetup(rows);
      }
    } catch (err) {
      logger.warn({ err }, '슬롯 셋업(slot_setup) 저장 실패'); // 격리 — 정본 artifact 는 이미 저장됨.
    }

    // finalize 완료 시 결과 스냅샷 자동 저장(요구사항 1). 실패는 격리(정본 저장은 이미 완료).
    if (this.deps.saveStore) {
      try {
        this.deps.saveStore.save(defaultSaveName(), artifact);
      } catch (err) {
        logger.warn({ err }, 'finalize 결과 스냅샷 자동 저장 실패');
      }
    }

    return {
      artifact,
      slots: slots.length,
      globalCount: globalIndex.length,
      ...(occupancyAgreement ? { occupancyAgreement } : {}),
    };
  }

  /** 채택 클러스터 → 프리셋별 위치 정렬 → ParkingSlot/Preset/Indexable 조립. */
  private assemble(
    accepted: AggregatedSlot[],
    zoneLabels: Record<string, string>,
  ): { presets: Preset[]; slots: ParkingSlot[]; indexable: IndexableSlot[] } {
    const byPreset = new Map<string, AggregatedSlot[]>();
    for (const s of accepted) {
      let arr = byPreset.get(s.presetKey);
      if (!arr) byPreset.set(s.presetKey, (arr = []));
      arr.push(s);
    }

    const presets: Preset[] = [];
    const slots: ParkingSlot[] = [];
    const indexable: IndexableSlot[] = [];

    for (const [key, members] of byPreset) {
      const camIdx = members[0].camIdx;
      const presetIdx = members[0].presetIdx;
      const rects: NormalizedRect[] = members.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }));
      const order = orderByPosition(rects, this.deps.yBandTolerance);

      // 위치순으로 바닥 다각형(+번호판 rect) 수집 → 프리셋 그룹 비겹침 클리핑을 단일 패스로 적용(R4).
      // 바닥 영역은 항상 부여: 체크포인트 LLM 산출이 있으면 그것을, 없으면 bbox 유도 폴백을 사용.
      const positioned = order.map((srcIdx, pos) => {
        const m = members[srcIdx];
        const rect = rects[srcIdx];
        const plateRect: NormalizedRect | undefined =
          m.plateX !== null && m.plateY !== null && m.plateW !== null && m.plateH !== null
            ? { x: m.plateX, y: m.plateY, w: m.plateW, h: m.plateH }
            : undefined;
        // 번호판 완전 부재(LPD 실패) 슬롯: 같은 프리셋 그룹의 번호판 보유 이웃으로 예상 quad 합성(결정형 폴백 각도 추종).
        let estimated: NormalizedQuad | undefined;
        if (m.plateQuad == null && plateRect === undefined) {
          const neighbors: PlateNeighbor[] = members
            .filter((n) => n !== m && n.plateQuad)
            .map((n) => ({ vehicle: { x: n.x, y: n.y, w: n.w, h: n.h }, plateQuad: n.plateQuad! }));
          estimated = estimatePlateQuadFromNeighbors(rect, neighbors);
        }
        // floor 발자국 결정형 생성(실측 plateQuad > 이웃추정 > predictPlateRect 상수). 구 floorByRef(LLM) 폐기(§6.5).
        const base = buildPlateAnchoredQuad(rect, m.plateQuad ?? estimated ?? undefined);
        return { pos, srcIdx, m, rect, plateRect, base };
      });
      const deconflicted = deconflictPolygons(
        positioned.map((p) => ({ ref: clusterRef(p.m), polygon: p.base, plate: p.plateRect })),
      );

      const coveredSlotIds: string[] = [];
      positioned.forEach((p, i) => {
        const positionIdx = p.pos + 1;
        const m = p.m;
        const slotId = slotIdOf(camIdx, presetIdx, positionIdx);
        coveredSlotIds.push(slotId);
        const roi = pad(p.rect, this.deps.roiPadding);
        const slot: ParkingSlot = {
          slotId,
          zone: zoneLabels[slotId] ?? `cam${camIdx}`,
          roiByPreset: { [key]: roi },
        };
        if (p.plateRect) {
          // 실 대표 OBB quad 우선(방향 보존), 부재(구데이터·polygon 미보존) 시 rect→quad 폴백.
          const plateQuad = m.plateQuad ?? rectToQuad(p.plateRect);
          slot.plateRoiByPreset = { [key]: plateQuad };
        }
        slot.floorRoiByPreset = { [key]: deconflicted[i] };
        slots.push(slot);
        indexable.push({ slotId, camIdx, presetIdx, positionIdx });
      });

      presets.push({ camIdx, presetIdx, label: key, coveredSlotIds });
    }

    return { presets, slots, indexable };
  }
}
