import { describe, it, expect } from 'vitest';
import { circularMedianAngle, axialWrap, plateAngleRad } from '../src/domain/geometry.js';
import { aggregate, type AggregateOptions } from '../src/capture/Aggregator.js';
import type { DetectionRow } from '../src/capture/types.js';
import type { NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester) 보강 테스트 — 계획 §9 불변식 중 구현자 테스트가 얕게 덮은 부분을 강화한다.
 * (1) circularMedianAngle ±90° 경계 붕괴(89°/-89°)·알려진 각 집합 수렴,
 * (2) conf 가중 대조(균등 대비 이동) at aggregate,
 * (3) ROBUST_MIN_MEMBERS 경계(N=3 컷 생략 vs N=4 컷 engage),
 * (4) slotConfidence 개별항 단조성(angleSpread↓·posSpread↓)·plate 부재 재정규화.
 * 구현 소스는 수정하지 않는다(순수 관찰).
 */

const OPTS: AggregateOptions = { clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5 };
const deg = (d: number) => (d * Math.PI) / 180;

// ── (1) 축 순환 median: ±90° 경계 붕괴 방지 + 알려진 집합 수렴 ─────────────
describe('circularMedianAngle 경계 강건성(보강)', () => {
  it('±90° 경계 straddle(89°/89°/-89°) → 붕괴 없이 ~89°(산술평균 29.7° 오류 회피)', () => {
    const m = circularMedianAngle([deg(89), deg(89), deg(-89)]);
    // 축(주기 π)에서 89°·-89° 는 2° 이내로 인접 → 대표는 ~89°.
    expect(Math.abs(m)).toBeCloseTo(deg(89), 2);
    // 산술평균(=29.7°)로 붕괴하지 않았음을 명시 대조.
    const naiveMean = (deg(89) + deg(89) + deg(-89)) / 3;
    expect(Math.abs(m - naiveMean)).toBeGreaterThan(deg(30));
  });

  it('-90°/+90° 등가(수직 축) 혼합 → 동일 축으로 수렴', () => {
    // +90° 와 -90° 는 같은 수직 축. 대표의 axialWrap 은 +90°(=π/2) 에 폴딩.
    const m = circularMedianAngle([deg(90), deg(-90), deg(90)]);
    expect(Math.abs(axialWrap(m))).toBeCloseTo(deg(90), 4);
  });

  it('알려진 각 집합 [10°,20°,30°] → 20°(±ε)', () => {
    expect(circularMedianAngle([deg(10), deg(20), deg(30)])).toBeCloseTo(deg(20), 5);
  });

  it('π-반전 대량 혼입([θ, θ+π, θ, θ+π, θ]) → 동일 축 대표', () => {
    const theta = 0.4;
    const m = circularMedianAngle([theta, theta + Math.PI, theta, theta + Math.PI, theta]);
    expect(axialWrap(m)).toBeCloseTo(theta, 5);
  });
});

// ── 헬퍼: 합성 검출행 ──────────────────────────────────────────────────
function vehicle(round: number, x: number, y: number, over: Partial<DetectionRow> = {}): DetectionRow {
  return { observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x, y, w: 0.1, h: 0.1, conf: 0.9, ...over };
}
/** 축 각도 theta 의 번호판 quad(중심 c, 크기 0.04×0.02). rect 는 boundingRect. */
function plateQuadRow(round: number, c: { x: number; y: number }, theta: number, over: Partial<DetectionRow> = {}): DetectionRow {
  const hw = 0.02, hh = 0.01;
  const ux = Math.cos(theta), uy = Math.sin(theta), vx = -Math.sin(theta), vy = Math.cos(theta);
  const corner = (su: number, sv: number): { x: number; y: number } => ({ x: c.x + su * hw * ux + sv * hh * vx, y: c.y + su * hw * uy + sv * hh * vy });
  const q: NormalizedQuad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { observationId: round, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, conf: 0.9, quad: q, ...over };
}

// ── (2) conf 가중 대조: 고conf 멤버 쪽으로 대표 이동(균등 대비) ──────────
describe('robustRect conf 가중 대조(보강)', () => {
  it('고conf 멤버가 대표 bbox 를 자기 쪽으로 끌어당김(균등 median 대비 이동)', () => {
    // x=[0.20,0.21,0.25] 단일 클러스터. 등가중 → median 0.21. 0.25 에 큰 가중 → 0.25 로 이동.
    const xs: [number, number] = [0.20, 0.21];
    const equalDets = [vehicle(1, xs[0], 0.30), vehicle(2, xs[1], 0.30), vehicle(3, 0.25, 0.30)];
    const equal = aggregate(equalDets, new Map([['1:1', 3]]), OPTS)[0];
    expect(equal.x).toBeCloseTo(0.21); // 등가중 = median

    const biasedDets = [
      vehicle(1, 0.20, 0.30, { conf: 0.6 }),
      vehicle(2, 0.21, 0.30, { conf: 0.6 }),
      vehicle(3, 0.25, 0.30, { conf: 1.5 }), // 고conf
    ];
    const biased = aggregate(biasedDets, new Map([['1:1', 3]]), OPTS)[0];
    expect(biased.x).toBeCloseTo(0.25); // 고conf 쪽으로 이동
    // 대조 assert: 가중이 대표를 유의하게 이동시켰다.
    expect(biased.x).toBeGreaterThan(equal.x + 0.02);
  });
});

// ── (3) ROBUST_MIN_MEMBERS 경계: N=3 컷 생략 vs N=4 컷 engage ────────────
describe('robustRect MAD 컷 경계(보강, ROBUST_MIN_MEMBERS=4)', () => {
  it('N=4 = 경계 → gross outlier 컷 engage(대표 다수쪽·posSpread 축소)', () => {
    // 지터 인라이어 3(0.298,0.300,0.302) + 이상치 1(0.345). N=4 → 컷.
    const dets = [
      vehicle(1, 0.298, 0.30), vehicle(2, 0.300, 0.30), vehicle(3, 0.302, 0.30),
      vehicle(4, 0.345, 0.30),
    ];
    const s = aggregate(dets, new Map([['1:1', 4]]), OPTS)[0];
    expect(s.support).toBe(4); // 관측 사실 보존
    expect(s.x).toBeCloseTo(0.300, 2); // 이상치(0.345) 미포함 → 인라이어 median
    return s.posSpread; // 아래 대조에서 재사용(참조용)
  });

  it('N=3 < 경계 → 동일 이상치 포함해도 컷 생략(posSpread 가 N=4 컷본보다 큼)', () => {
    // 인라이어 2(0.298,0.302) + 이상치(0.345). N=3 → 컷 생략, posSpread 이상치 포함.
    const n3 = aggregate(
      [vehicle(1, 0.298, 0.30), vehicle(2, 0.302, 0.30), vehicle(3, 0.345, 0.30)],
      new Map([['1:1', 3]]), OPTS,
    )[0];
    // 인라이어 3 + 이상치. N=4 → 컷.
    const n4 = aggregate(
      [vehicle(1, 0.298, 0.30), vehicle(2, 0.300, 0.30), vehicle(3, 0.302, 0.30), vehicle(4, 0.345, 0.30)],
      new Map([['1:1', 4]]), OPTS,
    )[0];
    // 컷 생략(N=3) 의 위치 퍼짐 > 컷 engage(N=4).
    expect(n3.posSpread).toBeGreaterThan(n4.posSpread);
    expect(n4.x).toBeCloseTo(0.300, 2); // N=4 는 이상치 제거된 대표
  });
});

// ── (4) slotConfidence 개별항 단조성 + plate 부재 재정규화 ────────────────
describe('slotConfidence 단조성·재정규화(보강)', () => {
  it('angleSpread↓ → confidence↑ (support/occupancy/posSpread 동일, 각도 일관성만 차이)', () => {
    const c = { x: 0.34, y: 0.35 };
    // 프리셋 1:1 — 번호판 각도 일관(모두 0) → angleSpread≈0.
    const consistent = [
      vehicle(1, 0.30, 0.30, { presetIdx: 1 }), vehicle(2, 0.30, 0.30, { presetIdx: 1 }), vehicle(3, 0.30, 0.30, { presetIdx: 1 }),
      plateQuadRow(1, c, 0, { presetIdx: 1 }), plateQuadRow(2, c, 0, { presetIdx: 1 }), plateQuadRow(3, c, 0, { presetIdx: 1 }),
    ];
    // 프리셋 1:2 — 동일 vehicle, 번호판 각도 퍼짐(+0.2/0/−0.2) → angleSpread 큼.
    const spread = [
      vehicle(1, 0.30, 0.30, { presetIdx: 2 }), vehicle(2, 0.30, 0.30, { presetIdx: 2 }), vehicle(3, 0.30, 0.30, { presetIdx: 2 }),
      plateQuadRow(1, c, 0.2, { presetIdx: 2 }), plateQuadRow(2, c, 0, { presetIdx: 2 }), plateQuadRow(3, c, -0.2, { presetIdx: 2 }),
    ];
    const rounds = new Map([['1:1', 3], ['1:2', 3]]);
    const slots = aggregate([...consistent, ...spread], rounds, OPTS);
    const a = slots.find((s) => s.presetKey === '1:1')!;
    const b = slots.find((s) => s.presetKey === '1:2')!;
    // 위치·지지·점유 동일(vehicle 동일) → 각도 일관성만 차이.
    expect(a.posSpread).toBeCloseTo(b.posSpread);
    expect(a.support).toBe(b.support);
    expect(a.occupancyRate).toBeCloseTo(b.occupancyRate);
    expect(a.angleSpread!).toBeLessThan(b.angleSpread!); // 일관 < 퍼짐
    expect(a.confidence).toBeGreaterThan(b.confidence);   // 단조성: angleSpread↓ → conf↑
  });

  it('posSpread↓ → confidence↑ (plate 부재, 위치 퍼짐만 차이)', () => {
    // 프리셋 1:1 — 위치 촘촘.
    const tight = [
      vehicle(1, 0.300, 0.30, { presetIdx: 1 }), vehicle(2, 0.301, 0.30, { presetIdx: 1 }), vehicle(3, 0.299, 0.30, { presetIdx: 1 }),
    ];
    // 프리셋 1:2 — 위치 들쭉날쭉(단일 클러스터 유지).
    const loose = [
      vehicle(1, 0.30, 0.30, { presetIdx: 2 }), vehicle(2, 0.32, 0.30, { presetIdx: 2 }), vehicle(3, 0.28, 0.30, { presetIdx: 2 }),
    ];
    const slots = aggregate([...tight, ...loose], new Map([['1:1', 3], ['1:2', 3]]), OPTS);
    const a = slots.find((s) => s.presetKey === '1:1')!;
    const b = slots.find((s) => s.presetKey === '1:2')!;
    expect(a.angleSpread).toBeNull();
    expect(b.angleSpread).toBeNull();
    expect(a.posSpread).toBeLessThan(b.posSpread);
    expect(a.confidence).toBeGreaterThan(b.confidence); // 단조성: posSpread↓ → conf↑
  });

  it('plate 부재 재정규화: 지지 포화·점유1·퍼짐0 → 각도항 제외 후 confidence == 1.0(무번호판 불이익 없음)', () => {
    // 10 라운드 각 1검출, 동일 위치 → support=10(포화), occ=1, posSpread=0, plate 없음.
    const dets: DetectionRow[] = [];
    for (let r = 1; r <= 10; r++) dets.push(vehicle(r, 0.30, 0.30));
    const s = aggregate(dets, new Map([['1:1', 10]]), OPTS)[0];
    expect(s.angleSpread).toBeNull();
    expect(s.posSpread).toBeCloseTo(0);
    // (W_OCC·1 + W_SUP·1 + W_POS·1) / (W_OCC+W_SUP+W_POS) = 1.0 (각도항 제외 재정규화).
    expect(s.confidence).toBeCloseTo(1.0, 6);
  });
});

// ── (5) 각도 이상치 강건성 대조: 로버스트 vs 나이브 평균 ───────────────────
describe('robustPlatePose 각도 이상치 대조(보강, §9-5)', () => {
  it('다수 각도 0 + 이상치 1(60°) → 대표 ~0(나이브 각도평균은 유의하게 이탈)', () => {
    const c = { x: 0.34, y: 0.35 };
    const angles = [0, 0, 0, 0, deg(60)]; // 4 정상 + 1 이상치(N=5, 컷 대상)
    const plates = angles.map((th, i) => plateQuadRow(i + 1, c, th));
    const dets = [vehicle(1, 0.30, 0.30), vehicle(2, 0.30, 0.30), vehicle(3, 0.30, 0.30), ...plates];
    const s = aggregate(dets, new Map([['1:1', 5]]), OPTS).find((x) => x.status === 'candidate')!;
    expect(s.plateQuad).not.toBeNull();
    const rep = plateAngleRad(s.plateQuad!);
    expect(rep).toBeCloseTo(0, 4); // 로버스트: 이상치 무시
    // 대조: 멤버 각도 산술평균은 유의하게 0 에서 이탈(단일/나이브 대비 개선 실증).
    const naive = angles.reduce((a, b) => a + b, 0) / angles.length; // = 60°/5 = 12°
    expect(Math.abs(naive - rep)).toBeGreaterThan(deg(10));
  });
});
