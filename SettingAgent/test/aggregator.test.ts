import { describe, it, expect } from 'vitest';
import { aggregate, type AggregateOptions } from '../src/capture/Aggregator.js';
import type { DetectionRow } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): Aggregator 결정형 순수함수 (G3 — 핵심).
 * 합성 DetectionRow 로 클러스터·지지·중앙값 bbox·점유율·plate 귀속·프리셋 분리 검증.
 * 결정형: 동일 입력 → 동일 출력. DB/IO 비의존.
 */

const OPTS: AggregateOptions = { clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5 };

function vehicle(round: number, x: number, y: number, over: Partial<DetectionRow> = {}): DetectionRow {
  return {
    observationId: round,
    roundIdx: round,
    camIdx: 1,
    presetIdx: 1,
    kind: 'vehicle',
    x,
    y,
    w: 0.1,
    h: 0.1,
    conf: 0.9,
    ...over,
  };
}
function plate(round: number, x: number, y: number, over: Partial<DetectionRow> = {}): DetectionRow {
  return { ...vehicle(round, x, y, over), kind: 'plate', w: 0.03, h: 0.02 };
}

describe('Aggregator 안정 클러스터 (G3)', () => {
  it('같은 위치 반복 검출 → 1 클러스터·support=N·candidate', () => {
    const dets = [vehicle(1, 0.2, 0.2), vehicle(2, 0.205, 0.2), vehicle(3, 0.195, 0.205)];
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots).toHaveLength(1);
    expect(slots[0].support).toBe(3);
    expect(slots[0].status).toBe('candidate'); // support(3) >= minSupport(3)
    expect(slots[0].presetKey).toBe('1:1');
    expect(slots[0].clusterId).toBe(1); // 프리셋 내 1-based
  });

  it('대표 bbox = 멤버 중앙값(평균 아님, 지터 강건)', () => {
    // x: [0.20, 0.21, 0.50] → median 0.21 (평균이면 0.303). 0.50 은 거리상 같은 클러스터로 모이게 근접 배치.
    const dets = [
      vehicle(1, 0.20, 0.20),
      vehicle(2, 0.21, 0.20),
      vehicle(3, 0.25, 0.20), // 중심거리 0.05 < clusterDist 0.06 누적
    ];
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots).toHaveLength(1);
    // x median of [0.20,0.21,0.25] = 0.21
    expect(slots[0].x).toBeCloseTo(0.21);
    expect(slots[0].y).toBeCloseTo(0.20);
  });

  it('노이즈(support < minSupport) → rejected', () => {
    const dets = [vehicle(1, 0.8, 0.8)]; // 1회만 등장 → support=1 < 3
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots).toHaveLength(1);
    expect(slots[0].support).toBe(1);
    expect(slots[0].status).toBe('rejected');
  });

  it('minConfidence 미만 검출은 집계 제외', () => {
    const dets = [
      vehicle(1, 0.2, 0.2, { conf: 0.4 }), // 제외
      vehicle(2, 0.2, 0.2, { conf: 0.4 }), // 제외
      vehicle(3, 0.2, 0.2, { conf: 0.9 }),
    ];
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots).toHaveLength(1);
    expect(slots[0].support).toBe(1); // conf>=0.5 인 1건만
    expect(slots[0].status).toBe('rejected');
  });
});

describe('Aggregator 점유율 (G3)', () => {
  it('occupancyRate = 점유 라운드 / 프리셋 총 라운드', () => {
    // 같은 클러스터에 round 1,2,3 검출 → 점유 3라운드. 총 라운드 6 → 0.5.
    const dets = [vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.305, 0.3)];
    const rounds = new Map([['1:1', 6]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots[0].occupancyRate).toBeCloseTo(3 / 6);
  });

  it('같은 라운드 중복 검출은 점유 라운드 분자에 1회만(distinct round)', () => {
    // round 1 에 2건, round 2 1건 → 점유 distinct round = 2. support = 3.
    const dets = [vehicle(1, 0.3, 0.3), vehicle(1, 0.305, 0.3), vehicle(2, 0.3, 0.305)];
    const rounds = new Map([['1:1', 4]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots[0].support).toBe(3);
    expect(slots[0].occupancyRate).toBeCloseTo(2 / 4); // distinct rounds {1,2}
  });

  it('presetRounds 누락(0) → occupancyRate 0 (0 division 방어)', () => {
    const dets = [vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.3, 0.3)];
    const slots = aggregate(dets, new Map(), OPTS); // 분모 없음
    expect(slots[0].occupancyRate).toBe(0);
  });
});

describe('Aggregator 프리셋 분리 (G3)', () => {
  it('다른 preset_key 는 별도 클러스터(좌표계 혼합 금지)', () => {
    const dets = [
      vehicle(1, 0.2, 0.2, { camIdx: 1, presetIdx: 1 }),
      vehicle(2, 0.2, 0.2, { camIdx: 1, presetIdx: 1 }),
      vehicle(3, 0.2, 0.2, { camIdx: 1, presetIdx: 1 }),
      // 같은 좌표지만 다른 프리셋 → 분리.
      vehicle(1, 0.2, 0.2, { camIdx: 1, presetIdx: 2 }),
      vehicle(2, 0.2, 0.2, { camIdx: 1, presetIdx: 2 }),
      vehicle(3, 0.2, 0.2, { camIdx: 1, presetIdx: 2 }),
    ];
    const rounds = new Map([['1:1', 3], ['1:2', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots).toHaveLength(2);
    expect(new Set(slots.map((s) => s.presetKey))).toEqual(new Set(['1:1', '1:2']));
    expect(slots.every((s) => s.clusterId === 1)).toBe(true); // 각 프리셋 내 1-based 독립
  });

  it('한 프리셋 내 멀리 떨어진 두 위치 → 2 클러스터', () => {
    const dets = [
      vehicle(1, 0.2, 0.2), vehicle(2, 0.2, 0.2), vehicle(3, 0.2, 0.2),
      vehicle(1, 0.7, 0.7), vehicle(2, 0.7, 0.7), vehicle(3, 0.7, 0.7),
    ];
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.clusterId).sort()).toEqual([1, 2]);
    expect(slots.every((s) => s.support === 3 && s.status === 'candidate')).toBe(true);
  });
});

describe('Aggregator plate 귀속 (G3)', () => {
  it('vehicle ROI 내부 plate 클러스터 → 해당 슬롯 plate_* 채움', () => {
    const dets = [
      vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.3, 0.3),
      // plate 중심(0.31+0.015, 0.34+0.01)=(0.325,0.35) → vehicle rep(0.3..0.4, 0.3..0.4) 내부.
      plate(1, 0.31, 0.34), plate(2, 0.31, 0.34), plate(3, 0.31, 0.34),
    ];
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    const veh = slots.find((s) => s.status === 'candidate')!;
    expect(veh.plateX).not.toBeNull();
    expect(veh.plateX).toBeCloseTo(0.31);
    expect(veh.plateY).toBeCloseTo(0.34);
  });

  it('vehicle ROI 밖 plate → 귀속 안 됨(plate_* null)', () => {
    const dets = [
      vehicle(1, 0.2, 0.2), vehicle(2, 0.2, 0.2), vehicle(3, 0.2, 0.2),
      // plate 중심이 vehicle ROI 와 동떨어짐.
      plate(1, 0.8, 0.8), plate(2, 0.8, 0.8), plate(3, 0.8, 0.8),
    ];
    const rounds = new Map([['1:1', 3]]);
    const slots = aggregate(dets, rounds, OPTS);
    const veh = slots[0];
    expect(veh.plateX).toBeNull();
    expect(veh.plateY).toBeNull();
    expect(veh.plateW).toBeNull();
    expect(veh.plateH).toBeNull();
  });
});

describe('Aggregator 결정형 (G3)', () => {
  it('동일 입력 2회 → 동일 출력(순수·결정형)', () => {
    const dets = [vehicle(1, 0.2, 0.2), vehicle(2, 0.2, 0.2), vehicle(3, 0.2, 0.2)];
    const rounds = new Map([['1:1', 3]]);
    const a = aggregate(dets, rounds, OPTS);
    const b = aggregate(dets, rounds, OPTS);
    expect(a).toEqual(b);
  });

  it('vehicle 검출 없는 프리셋(plate 만) → 슬롯 미생성', () => {
    const dets = [plate(1, 0.3, 0.3), plate(2, 0.3, 0.3)];
    const slots = aggregate(dets, new Map([['1:1', 2]]), OPTS);
    expect(slots).toHaveLength(0);
  });

  it('빈 입력 → 빈 출력', () => {
    expect(aggregate([], new Map(), OPTS)).toEqual([]);
  });
});
