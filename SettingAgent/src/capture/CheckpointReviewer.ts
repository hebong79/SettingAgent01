import type { SqliteStore } from './SqliteStore.js';
import type { SetupBrain } from '../brain/SetupBrain.js';
import type { CheckpointResult } from '../brain/SetupBrain.js';
import type { AggregatedSlot } from './types.js';

/** 클러스터 식별자(LLM 입출력용): `presetKey#clusterId`. */
export function clusterRef(s: { presetKey: string; clusterId: number }): string {
  return `${s.presetKey}#${s.clusterId}`;
}

/** 체크포인트 자문(coverage/convergence)을 표시 문자열 배열로 변환(좌표 불변·표시만). */
export function advisoryLines(r: CheckpointResult): string[] {
  const lines: string[] = [];
  for (const c of r.coverage) {
    if (c.short) lines.push(`프리셋 ${c.preset}: 기대 ${c.expected} > 수집 ${c.got} (부족)`);
  }
  if (r.convergence.converged) {
    lines.push(`수렴됨${r.convergence.advice ? `: ${r.convergence.advice}` : ''}`);
  } else if (r.convergence.advice) {
    lines.push(r.convergence.advice);
  }
  return lines;
}

export interface CheckpointReviewerDeps {
  store: SqliteStore;
  brain?: SetupBrain;
  now?: () => string;
}

/**
 * 집계 텍스트 요약 → brain.reviewCheckpoint → 결과 반영(좌표 불변 — status 메타만 갱신) + checkpoint 행 저장.
 * LLM 비활성/미지원/실패 시 null(no-op). 설계서 §4.3.
 */
export class CheckpointReviewer {
  private readonly now: () => string;
  constructor(private deps: CheckpointReviewerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * @param runId 대상 런
   * @param atRound 현재 라운드
   * @param plannedCount 계획 횟수
   * @param slots 현재 집계 결과(같은 런)
   * @param newFacesRecentK 최근 K회 신규 면 수(수렴 신호)
   * @param expectedByPreset 프리셋별 기대 면 수(선택)
   */
  async review(
    runId: number,
    atRound: number,
    plannedCount: number,
    slots: AggregatedSlot[],
    newFacesRecentK: number,
    expectedByPreset?: Record<string, number>,
  ): Promise<CheckpointResult | null> {
    if (!this.deps.brain?.enabled || !this.deps.brain.reviewCheckpoint) return null;

    // 프리셋별 요약(slotCount = rejected 제외 후보 수, avgOccupancy = 평균 점유율).
    const byPreset = new Map<string, { count: number; occSum: number }>();
    for (const s of slots) {
      if (s.status === 'rejected') continue;
      let acc = byPreset.get(s.presetKey);
      if (!acc) byPreset.set(s.presetKey, (acc = { count: 0, occSum: 0 }));
      acc.count += 1;
      acc.occSum += s.occupancyRate;
    }
    const presets = [...byPreset.entries()].map(([key, v]) => ({
      key,
      slotCount: v.count,
      expected: expectedByPreset?.[key],
      avgOccupancy: v.count > 0 ? v.occSum / v.count : 0,
    }));

    let result: CheckpointResult | null = null;
    try {
      result = await this.deps.brain.reviewCheckpoint({ atRound, plannedCount, presets, newFacesRecentK });
    } catch {
      return null; // 장애 격리: 체크포인트 실패는 잡을 막지 않는다.
    }
    if (!result) return null;

    // 적용(좌표 불변): rejects → status='rejected', merges 그룹의 2번째부터 → status='merged'.
    // ★ DB 중간테이블 폐기(설계서 §2) — status 는 인메모리 AggregatedSlot 에 직접 반영(구 updateAggregatedStatus 대체).
    //   본 클래스는 캡처 루프 배선에서 분리됨(§6.5) — clusterRef/advisoryLines 공유 유틸만 잔존.
    const refToSlot = new Map<string, AggregatedSlot>();
    for (const s of slots) refToSlot.set(clusterRef(s), s);

    for (const ref of result.rejects) {
      const s = refToSlot.get(ref);
      if (s) s.status = 'rejected';
    }
    for (const group of result.merges) {
      for (const ref of group.slice(1)) {
        const s = refToSlot.get(ref);
        if (s) s.status = 'merged';
      }
    }

    return result;
  }
}
