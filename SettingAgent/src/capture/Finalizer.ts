import type { SqliteStore } from './SqliteStore.js';
import type { Repository } from '../store/Repository.js';
import type { SetupBrain, FinalizeCaptureResult } from '../brain/SetupBrain.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { aggregate, type AggregateOptions } from './Aggregator.js';
import { clusterRef } from './CheckpointReviewer.js';
import { orderByPosition } from '../setup/ordering.js';
import { buildGlobalIndex, validateCoverage, type IndexableSlot } from '../setup/GlobalIndexer.js';
import { pad } from '../domain/geometry.js';
import type {
  GlobalSlotIndex,
  NormalizedRect,
  ParkingSlot,
  Preset,
  SetupArtifact,
} from '../domain/types.js';
import type { AggregatedSlot } from './types.js';

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
}

export interface FinalizeResult {
  artifact: SetupArtifact;
  slots: number;
  globalCount: number;
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

  async finalize(runId: number): Promise<FinalizeResult> {
    // 1) 최신 결정형 집계(멱등 — 체크포인트 status 갱신을 덮어쓰지 않도록 기존 status 보존).
    const dets = this.deps.store.getDetectionsForRun(runId);
    const presetRounds = this.deps.store.getPresetRounds(runId);
    const fresh = aggregate(dets, presetRounds, this.aggOptions());

    // 체크포인트에서 갱신한 status(merged/rejected)를 보존 병합.
    const prior = new Map(this.deps.store.getAggregatedSlots(runId).map((s) => [clusterRef(s), s.status]));
    for (const s of fresh) {
      const ps = prior.get(clusterRef(s));
      if (ps === 'merged' || ps === 'rejected') s.status = ps;
    }
    this.deps.store.replaceAggregatedSlots(runId, fresh);

    // 2) (LLM 활성 시) 최종 보조 판정.
    let llm: FinalizeCaptureResult | null = null;
    if (this.deps.brain?.enabled && this.deps.brain.finalizeCapture) {
      const presetCounts = new Map<string, number>();
      for (const s of fresh) if (s.status !== 'rejected' && s.status !== 'merged') {
        presetCounts.set(s.presetKey, (presetCounts.get(s.presetKey) ?? 0) + 1);
      }
      const checkpointNotes = this.deps.store
        .getCheckpoints(runId)
        .map((c) => c.summaryJson);
      try {
        llm = await this.deps.brain.finalizeCapture({
          totalSlots: [...presetCounts.values()].reduce((a, b) => a + b, 0),
          presets: [...presetCounts.entries()].map(([key, slotCount]) => ({
            key,
            slotCount,
            expected: this.deps.expectedByPreset?.[key],
          })),
          checkpointNotes,
        });
      } catch {
        llm = null; // 장애 격리: 결정형 강등.
      }
    }

    // 3) LLM rejects/duplicates 반영(좌표 불변 — 채택 여부 메타만).
    const rejectedRefs = new Set<string>(llm?.rejects ?? []);
    for (const group of llm?.duplicates ?? []) {
      for (const ref of group.slice(1)) rejectedRefs.add(ref);
    }

    // 4) 채택 클러스터만 → 프리셋별 positionIdx 부여 → ParkingSlot/Preset 조립.
    const accepted = fresh.filter((s) => s.status === 'candidate' && !rejectedRefs.has(clusterRef(s)));
    const { presets, slots, indexable } = this.assemble(accepted, llm?.zoneLabels ?? {});

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
    this.deps.store.insertArtifactSnapshot(runId, this.now(), JSON.stringify(artifact));

    return { artifact, slots: slots.length, globalCount: globalIndex.length };
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

      const coveredSlotIds: string[] = [];
      order.forEach((srcIdx, pos) => {
        const positionIdx = pos + 1;
        const m = members[srcIdx];
        const slotId = slotIdOf(camIdx, presetIdx, positionIdx);
        coveredSlotIds.push(slotId);
        const roi = pad(rects[srcIdx], this.deps.roiPadding);
        const slot: ParkingSlot = {
          slotId,
          zone: zoneLabels[slotId] ?? `cam${camIdx}`,
          roiByPreset: { [key]: roi },
        };
        if (m.plateX !== null && m.plateY !== null && m.plateW !== null && m.plateH !== null) {
          slot.plateRoiByPreset = { [key]: { x: m.plateX, y: m.plateY, w: m.plateW, h: m.plateH } };
        }
        slots.push(slot);
        indexable.push({ slotId, camIdx, presetIdx, positionIdx });
      });

      presets.push({ camIdx, presetIdx, label: key, coveredSlotIds });
    }

    return { presets, slots, indexable };
  }
}
