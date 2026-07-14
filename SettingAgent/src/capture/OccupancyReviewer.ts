import type { SqliteStore } from './SqliteStore.js';
import type { SetupBrain } from '../brain/SetupBrain.js';
import { logger } from '../util/logger.js';

export interface OccupancyReviewerDeps {
  store: SqliteStore;
  brain?: SetupBrain;
  now?: () => string;
}

/**
 * 체크포인트 cadence 로 이번 라운드에 캡처된 "모든 프리셋" 프레임을 LLM 점유율 판정 → 저장한다(설계서 §3.6).
 * FloorRoiReviewer 와 별 클래스: floor ROI 는 채택 후보 슬롯 per-vehicle 순회(maxPerCheckpoint 캡)지만
 * occupancy 는 전 프리셋(빈 화면 포함, 0%도 보고) 순회이며 캡이 없다(결정 3).
 * 폴백 없음(floor ROI 와 의도적 차이): LLM 불가/실패 시 graceful skip(저장 생략) + 경고 플래그(잡 미중단).
 * 산술(occupiedCount/total/rate)은 brain.judgeOccupancy 가 결정형으로 산출(LLM 산술 미신뢰).
 */
export class OccupancyReviewer {
  private readonly now: () => string;
  constructor(private deps: OccupancyReviewerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * @param runId 대상 런
   * @param atRound 이 체크포인트의 라운드 번호(이력 append 키)
   * @param framesByPreset 프리셋별 최근 프레임 JPEG(`${camIdx}:${presetIdx}` → Buffer, 전 프리셋)
   * @param shouldStop 각 프리셋 처리 전 정지 요청 여부(옵셔널). true 면 다음 프리셋 전 중단.
   * @param expectedByPreset 프리셋별 기대 면 수(LLM 힌트, 선택).
   */
  async review(
    runId: number,
    atRound: number,
    framesByPreset: Map<string, Buffer>,
    shouldStop?: () => boolean,
    expectedByPreset?: Record<string, number>,
  ): Promise<{ llmUnavailable: boolean }> {
    const brain = this.deps.brain;
    // 동작 가능 여부: brain 존재·활성·메서드 보유. 부재/비활성이면 저장 생략(폴백 없음).
    const usable = !!(brain?.enabled && brain.judgeOccupancy);
    let attempted = 0;
    let succeeded = 0;
    let nullCount = 0;
    let errorCount = 0;
    for (const [key, jpeg] of framesByPreset) {
      if (shouldStop?.()) break; // 정지 요청 시 다음 프리셋 전 중단.
      if (!usable) continue; // 폴백 없음 → 저장 생략(결정형 occupancyRate 는 별도로 이미 존재).
      const [camIdx, presetIdx] = key.split(':').map(Number);
      attempted += 1;
      try {
        const j = await brain!.judgeOccupancy!({
          camIdx,
          presetIdx,
          imageBase64: jpeg.toString('base64'),
          expected: expectedByPreset?.[key],
        });
        if (!j) {
          nullCount += 1;
          logger.warn({ key }, 'occupancy 판정 null(파싱/스키마 실패 추정 — 스킵)');
          continue; // 비활성/무효 → skip(빈 프리셋 0% 는 j.total===0 로 저장됨).
        }
        succeeded += 1;
        this.deps.store.insertOccupancy(runId, {
          camIdx,
          presetIdx,
          atRound,
          occupiedCount: j.occupiedCount,
          total: j.total,
          rate: j.rate,
          spacesJson: JSON.stringify(j.spaces),
          updatedAt: this.now(),
        });
      } catch (e) {
        errorCount += 1;
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : undefined, key },
          'occupancy 판정 실패(스킵)',
        );
      }
    }
    // 경고 신호: 애초에 동작 불가(비활성/메서드부재) 또는 시도했으나 전부 무효/실패.
    const llmUnavailable = !usable || (attempted > 0 && succeeded === 0);
    if (llmUnavailable) {
      logger.warn({ usable, attempted, succeeded, nullCount, errorCount }, 'occupancy: LLM 비활성/불가 — 저장 생략');
    }
    return { llmUnavailable };
  }
}
