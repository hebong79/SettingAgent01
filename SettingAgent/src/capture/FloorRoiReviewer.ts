import type { SqliteStore } from './SqliteStore.js';
import type { SetupBrain } from '../brain/SetupBrain.js';
import type { AggregatedSlot } from './types.js';
import type { NormalizedRect } from '../domain/types.js';
import { resolveFloorQuad } from './floorRoi.js';
import { logger } from '../util/logger.js';

export interface FloorRoiReviewerDeps {
  store: SqliteStore;
  brain?: SetupBrain;
  /** 체크포인트 1회당 LLM 호출 상한(미설정 시 12). */
  maxPerCheckpoint?: number;
  now?: () => string;
}

/**
 * 체크포인트 cadence 로 채택 후보 슬롯의 바닥 점유 영역(floor ROI · 4점)을 (재)계산·저장한다(설계서 §5.2).
 * 좌표를 "생성"하는 유일한 LLM 단계(CheckpointReviewer 는 좌표 불변 — 역할 분리해 별 클래스).
 * LLM 비활성/미지원 시 no-op. LLM 실패·무효 시 결정형 폴백(bbox 유도 사변형)으로 항상 floor ROI 보유.
 */
export class FloorRoiReviewer {
  private readonly now: () => string;
  private readonly maxPerCheckpoint: number;
  constructor(private deps: FloorRoiReviewerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.maxPerCheckpoint = deps.maxPerCheckpoint ?? 12;
  }

  /**
   * @param runId 대상 런
   * @param slots 현재 집계 결과(같은 런)
   * @param framesByPreset 프리셋별 최근 프레임 JPEG(`${camIdx}:${presetIdx}` → Buffer)
   */
  async review(runId: number, slots: AggregatedSlot[], framesByPreset: Map<string, Buffer>): Promise<void> {
    const brain = this.deps.brain;
    if (!brain?.enabled || !brain.recognizeFloorRoi) return; // no-op

    const candidates = slots.filter((s) => s.status !== 'rejected' && s.status !== 'merged');
    let used = 0;
    for (const s of candidates) {
      if (used >= this.maxPerCheckpoint) break; // 상한 초과분은 다음 주기에(폴백이 항상 있어 누락 무해).
      const jpeg = framesByPreset.get(s.presetKey);
      if (!jpeg) continue; // 이번 라운드 이 프리셋 프레임 부재 → skip.
      used += 1;

      const vehicle: NormalizedRect = { x: s.x, y: s.y, w: s.w, h: s.h };
      const plate: NormalizedRect | undefined =
        s.plateX !== null && s.plateY !== null && s.plateW !== null && s.plateH !== null
          ? { x: s.plateX, y: s.plateY, w: s.plateW, h: s.plateH }
          : undefined;

      let quadRaw: Array<{ x: number; y: number }> | null = null;
      try {
        const llm = await brain.recognizeFloorRoi({
          camIdx: s.camIdx,
          presetIdx: s.presetIdx,
          imageBase64: jpeg.toString('base64'),
          vehicle,
          ...(plate ? { plate } : {}),
          slotHint: `${s.presetKey}#${s.clusterId}`,
        });
        quadRaw = llm?.quad ?? null;
      } catch (e) {
        logger.warn({ err: e, preset: s.presetKey, cluster: s.clusterId }, 'floor ROI 추론 실패(폴백)');
      }

      const quad = resolveFloorQuad(quadRaw, vehicle); // 항상 존재(폴백 보장).
      this.deps.store.upsertFloorRoi(runId, s.presetKey, s.clusterId, quad, this.now());
    }
  }
}
