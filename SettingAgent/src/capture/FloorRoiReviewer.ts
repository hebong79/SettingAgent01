import type { SqliteStore } from './SqliteStore.js';
import type { SetupBrain } from '../brain/SetupBrain.js';
import type { AggregatedSlot } from './types.js';
import type { NormalizedRect, NormalizedQuad } from '../domain/types.js';
import { resolveFloorPolygon, estimatePlateQuadFromNeighbors, type PlateNeighbor } from './floorRoi.js';
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
 * LLM 비활성/미지원/실패 시에도 결정형 폴백(bbox 유도 발자국 사변형)으로 **항상** floor ROI 를 생성·보유한다.
 * LLM 동작불가(비활성·메서드 부재·전 슬롯 무효)면 `{ llmUnavailable: true }` 를 반환하고 logger.warn 1회.
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
   * @param shouldStop 각 후보 슬롯 처리 전 정지 요청 여부(옵셔널). true 면 다음 슬롯 전 중단(진행 중 체크포인트도 ≤1 LLM 호출로 조기 탈출).
   */
  async review(
    runId: number,
    slots: AggregatedSlot[],
    framesByPreset: Map<string, Buffer>,
    shouldStop?: () => boolean,
  ): Promise<{ llmUnavailable: boolean }> {
    const brain = this.deps.brain;
    // 동작 가능 여부: brain 존재·활성·메서드 보유. 부재/비활성이면 폴백만 사용.
    const llmUsable = !!(brain?.enabled && brain.recognizeFloorRoi);

    const candidates = slots.filter((s) => s.status !== 'rejected' && s.status !== 'merged');
    let used = 0;
    let attempted = 0; // LLM 호출 시도 수.
    let succeeded = 0; // 유효 quad 반환 수.
    for (const s of candidates) {
      if (shouldStop?.()) break; // 정지 요청 시 다음 슬롯 전 중단(진행 중 체크포인트 조기 탈출).
      if (used >= this.maxPerCheckpoint) break; // 상한 초과분은 다음 주기에(폴백이 항상 있어 누락 무해).
      const jpeg = framesByPreset.get(s.presetKey);
      if (!jpeg) continue; // 이번 라운드 이 프리셋 프레임 부재 → skip.
      used += 1;

      const vehicle: NormalizedRect = { x: s.x, y: s.y, w: s.w, h: s.h };
      const plate: NormalizedRect | undefined =
        s.plateX !== null && s.plateY !== null && s.plateW !== null && s.plateH !== null
          ? { x: s.plateX, y: s.plateY, w: s.plateW, h: s.plateH }
          : undefined;
      const plateQuad = s.plateQuad ?? undefined; // 번호판 각도 단서(방향 보존).
      // 번호판 완전 부재(LPD 실패) 슬롯: 같은 프리셋 그룹의 번호판 보유 이웃으로 예상 quad 합성.
      let estimated: NormalizedQuad | undefined;
      if (plate === undefined && plateQuad === undefined) {
        const neighbors: PlateNeighbor[] = candidates
          .filter((n) => n !== s && n.presetKey === s.presetKey && n.plateQuad)
          .map((n) => ({ vehicle: { x: n.x, y: n.y, w: n.w, h: n.h }, plateQuad: n.plateQuad! }));
        estimated = estimatePlateQuadFromNeighbors(vehicle, neighbors);
      }
      // 폴백 우선순위: 실측 plateQuad > 이웃추정 > (undefined → predictPlateRect 상수).
      const effQuad = plateQuad ?? estimated;

      let polyRaw: Array<{ x: number; y: number }> | null = null;
      if (llmUsable && brain?.recognizeFloorRoi) {
        attempted += 1;
        try {
          const llm = await brain.recognizeFloorRoi({
            camIdx: s.camIdx,
            presetIdx: s.presetIdx,
            imageBase64: jpeg.toString('base64'),
            vehicle, // 대상 표시용만(번호판 신호는 LLM 입력에서 차단, 폴백 전용).
            slotHint: `${s.presetKey}#${s.clusterId}`,
          });
          polyRaw = llm?.polygon ?? null;
          if (polyRaw) succeeded += 1;
        } catch (e) {
          logger.warn({ err: e, preset: s.presetKey, cluster: s.clusterId }, 'floor ROI 추론 실패(폴백)');
        }
      }

      // LLM 유효 폴리곤이 메인. effQuad/plate 는 LLM 무효 시 폴백(번호판 앵커·포함강제) 전용.
      // ★ 캡처 루프 배선 제거(설계서 §6.5) — floor 발자국은 Finalizer 가 buildPlateAnchoredQuad 결정형으로 항상 생성.
      //   구 upsertFloorRoi(DB 중간테이블) 폐기. 산출 폴리곤은 미영속(본 클래스는 미배선 잔존).
      void resolveFloorPolygon(polyRaw, vehicle, effQuad, plate);
    }

    // 경고 신호: 애초에 동작 불가(비활성/메서드부재) 또는 시도했으나 전부 무효 반환.
    const llmUnavailable = !llmUsable || (attempted > 0 && succeeded === 0);
    if (llmUnavailable) {
      logger.warn({ llmUsable, attempted, succeeded }, 'floor ROI: LLM 비활성/불가 — 결정형 폴백 사용');
    }
    return { llmUnavailable };
  }
}
