import { describe, it, expect } from 'vitest';
import { aggregate, type AggregateOptions } from '../src/capture/Aggregator.js';
import type { DetectionRow } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): clusterMinSupport=1 효과 (config/tools.config.json capture 섹션 3→1).
 * "정밀수집 1회(단일 관측) 후 최종화 저장" 성립의 근거 — support=1 클러스터가 status:'candidate' 로 승격.
 * 대조: 동일 입력을 clusterMinSupport=3 으로 집계하면 'rejected'(회귀 방향 고정).
 * Aggregator 순수함수 · 파라미터만 다르게(코드 로직 불변, config 값 검증).
 */

const MIN1: AggregateOptions = { clusterDist: 0.06, clusterMinSupport: 1, minConfidence: 0.5 };
const MIN3: AggregateOptions = { clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5 };

function vehicle(round: number, x: number, y: number, over: Partial<DetectionRow> = {}): DetectionRow {
  return {
    observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle',
    x, y, w: 0.1, h: 0.1, conf: 0.9, ...over,
  };
}

describe('clusterMinSupport=1 승격 (단일 관측 최종화 근거)', () => {
  it('support=1(1회 관측) → clusterMinSupport:1 이면 candidate 로 승격', () => {
    const dets = [vehicle(1, 0.3, 0.3)]; // 단 1회 검출
    const rounds = new Map([['1:1', 1]]); // 정밀수집 1회
    const slots = aggregate(dets, rounds, MIN1);
    expect(slots).toHaveLength(1);
    expect(slots[0].support).toBe(1);
    expect(slots[0].status).toBe('candidate'); // 1 < 1 == false → 승격
  });

  it('대조: 동일 support=1 을 clusterMinSupport:3 으로 → rejected(3→1 변경의 실효 확인)', () => {
    const dets = [vehicle(1, 0.3, 0.3)];
    const rounds = new Map([['1:1', 1]]);
    const slots = aggregate(dets, rounds, MIN3);
    expect(slots).toHaveLength(1);
    expect(slots[0].support).toBe(1);
    expect(slots[0].status).toBe('rejected'); // 1 < 3 == true → 기각
  });

  it('여러 프리셋 단일 관측 → clusterMinSupport:1 이면 전부 candidate', () => {
    const dets = [
      vehicle(1, 0.2, 0.2, { camIdx: 1, presetIdx: 1 }),
      vehicle(1, 0.7, 0.7, { camIdx: 1, presetIdx: 2 }),
    ];
    const rounds = new Map([['1:1', 1], ['1:2', 1]]);
    const slots = aggregate(dets, rounds, MIN1);
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.support === 1 && s.status === 'candidate')).toBe(true);
    // 대조군은 전부 기각.
    const rejected = aggregate(dets, rounds, MIN3);
    expect(rejected.every((s) => s.status === 'rejected')).toBe(true);
  });

  it('support>=2 는 두 설정 모두 candidate(경계 아래만 달라짐)', () => {
    const dets = [vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3)];
    const rounds = new Map([['1:1', 2]]);
    expect(aggregate(dets, rounds, MIN1)[0].status).toBe('candidate');
    // support=2 < 3 → MIN3 에서는 여전히 rejected(경계값 대조).
    expect(aggregate(dets, rounds, MIN3)[0].status).toBe('rejected');
  });
});
