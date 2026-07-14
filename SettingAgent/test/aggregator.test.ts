import { describe, it, expect } from 'vitest';
import { aggregate, type AggregateOptions } from '../src/capture/Aggregator.js';
import type { DetectionRow } from '../src/capture/types.js';
import type { NormalizedQuad } from '../src/domain/types.js';
import { plateAngleRad } from '../src/domain/geometry.js';

/** quad centroid(4모서리 평균). 합성 대표 quad 중심 검증용. */
function quadCentroid(q: NormalizedQuad): { x: number; y: number } {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

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

// 검증자(qa-tester): 대표 quad 방향 보존·중심 최근접·plate 없음 null (설계 케이스 8, 핵심).
describe('Aggregator 대표 quad 방향 보존 (G3·설계 케이스 8)', () => {
  /**
   * quad 를 가진 plate DetectionRow. rect(x,y,w,h)=quad boundingRect(CaptureJob 이 quadBoundingRect 로 채우는 계약 재현).
   * 회전 quad → boundingRect 는 축정렬이지만, 대표 quad 는 실 4점 방향을 보존해야 한다.
   */
  function plateQuad(round: number, quad: NormalizedQuad): DetectionRow {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate',
      x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, conf: 0.9, quad,
    };
  }

  it('회전 quad 멤버 → 합성 대표 quad 가 각도·중심 보존(축 순환 median)', () => {
    // 마름모(회전) 번호판. plateAngleRad ≈ atan2(0.04,0.06). 합성 대표는 이 방향을 보존해야 함.
    const rot: NormalizedQuad = [
      { x: 0.33, y: 0.33 },
      { x: 0.36, y: 0.35 },
      { x: 0.33, y: 0.37 },
      { x: 0.30, y: 0.35 },
    ];
    const dets = [
      vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.3, 0.3),
      plateQuad(1, rot), plateQuad(2, rot), plateQuad(3, rot),
    ];
    const slots = aggregate(dets, new Map([['1:1', 3]]), OPTS);
    const veh = slots.find((s) => s.status === 'candidate')!;
    expect(veh.plateQuad).not.toBeNull();
    // 합성 규약 정합: plateAngleRad(합성 quad) == θ_rep == 원본 방향.
    expect(plateAngleRad(veh.plateQuad!)).toBeCloseTo(plateAngleRad(rot), 5);
    // 강건 중심 = 멤버 centroid 의 median(원본 centroid (0.33, 0.35)).
    const c = quadCentroid(veh.plateQuad!);
    expect(c.x).toBeCloseTo(0.33);
    expect(c.y).toBeCloseTo(0.35);
    // 축정렬이 아니다(회전 보존): 상변 두 점의 y 가 다르다.
    expect(veh.plateQuad![0].y).not.toBeCloseTo(veh.plateQuad![1].y);
  });

  it('각도 이상치 멤버(N≥4) → 강건 대표 각도가 다수 방향 유지(이상치 무시)', () => {
    // 축정렬(각도 0) 다수 + 크게 기운 1개. 축 순환 median 이 이상치를 무시하고 0 을 대표로.
    const flat: NormalizedQuad = [
      { x: 0.30, y: 0.33 }, { x: 0.36, y: 0.33 }, { x: 0.36, y: 0.37 }, { x: 0.30, y: 0.37 },
    ];
    const tilt: NormalizedQuad = [
      { x: 0.33, y: 0.33 }, { x: 0.36, y: 0.35 }, { x: 0.33, y: 0.37 }, { x: 0.30, y: 0.35 },
    ];
    // 같은 위치의 plate 5멤버(4 flat + 1 tilt) → 1 클러스터.
    const dets = [
      vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.3, 0.3),
      plateQuad(1, flat), plateQuad(2, flat), plateQuad(3, flat), plateQuad(4, flat),
      plateQuad(5, tilt),
    ];
    const slots = aggregate(dets, new Map([['1:1', 5]]), OPTS);
    const veh = slots.find((s) => s.status === 'candidate')!;
    expect(veh.plateQuad).not.toBeNull();
    // 다수(각도 0) 방향이 대표 — 이상치 tilt 에 끌려가지 않음.
    expect(plateAngleRad(veh.plateQuad!)).toBeCloseTo(0, 5);
    // 각도 분산(angleSpread)이 산출됨(quad ≥2).
    expect(veh.angleSpread).not.toBeNull();
    expect(veh.angleSpread!).toBeGreaterThanOrEqual(0);
  });

  it('plate 없음 → plateQuad null', () => {
    const dets = [vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.3, 0.3)];
    const slots = aggregate(dets, new Map([['1:1', 3]]), OPTS);
    expect(slots[0].plateQuad).toBeNull();
  });

  it('quad 부재 plate 멤버만(구DB) → 매칭돼도 plateQuad null', () => {
    // plate 멤버가 quad 없이 rect 만(구스키마) → 대표 quad 부재 → null(Finalizer 폴백 대상).
    const dets = [
      vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.3, 0.3),
      plate(1, 0.31, 0.34), plate(2, 0.31, 0.34), plate(3, 0.31, 0.34),
    ];
    const slots = aggregate(dets, new Map([['1:1', 3]]), OPTS);
    const veh = slots.find((s) => s.status === 'candidate')!;
    expect(veh.plateX).not.toBeNull(); // rect 매칭은 성공
    expect(veh.plateQuad).toBeNull();  // 하지만 quad 부재 → null
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

// 검증자(qa-tester): 강건 통계(개선 ②③) — 신뢰도 단조성·소표본 폴백·위치 이상치 컷.
describe('Aggregator 신뢰도·강건 통계 (G3)', () => {
  it('confidence ∈ [0,1] 이고 occupancy 높을수록 비감소(단조성)', () => {
    const dets = [vehicle(1, 0.3, 0.3), vehicle(2, 0.3, 0.3), vehicle(3, 0.305, 0.3)];
    const hi = aggregate(dets, new Map([['1:1', 3]]), OPTS)[0]; // occ=1.0
    const lo = aggregate(dets, new Map([['1:1', 6]]), OPTS)[0]; // occ=0.5
    expect(hi.confidence).toBeGreaterThanOrEqual(lo.confidence);
    for (const c of [hi.confidence, lo.confidence]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    // plate 부재 → angleSpread null, posSpread 산출.
    expect(hi.angleSpread).toBeNull();
    expect(hi.posSpread).toBeGreaterThanOrEqual(0);
  });

  it('N=2 vehicle 소표본 폴백 → 가중median = median(현행 보존)', () => {
    // 등가중(conf 동일) 2멤버 → weightedMedian == median(짝수 평균).
    const dets = [vehicle(1, 0.20, 0.20), vehicle(2, 0.24, 0.20)];
    const s = aggregate(dets, new Map([['1:1', 2]]), OPTS)[0];
    expect(s.x).toBeCloseTo(0.22); // median([0.20,0.24]) = 0.22
    expect(s.support).toBe(2);
  });

  it('N≥4 위치 이상치 → robustRect 가 이상치 제외(대표는 다수쪽), support 보존', () => {
    const dets = [
      vehicle(1, 0.30, 0.30), vehicle(2, 0.301, 0.30), vehicle(3, 0.299, 0.30), vehicle(4, 0.30, 0.301),
      vehicle(5, 0.34, 0.30), // clusterDist 0.06 이내로 합류하지만 위치 gross outlier
    ];
    const s = aggregate(dets, new Map([['1:1', 5]]), OPTS)[0];
    expect(s.support).toBe(5); // support 는 전체 관측(관측 사실 보존)
    expect(s.x).toBeCloseTo(0.30, 2); // 대표 중심은 이상치(0.34) 미포함 다수쪽
  });
});
