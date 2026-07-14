import { describe, it, expect } from 'vitest';
import { area, center, clamp01, clampRect, containsPoint, intersectionArea, iou, median, normalizeBox, normalizeQuad, quadBoundingRect, rectToQuad, pad, mad, weightedMedian, medianPoint, circularMedianAngle, circularMad, synthesizePlateQuad, axialWrap, plateAngleRad } from '../src/domain/geometry.js';
import type { NormalizedRect, NormalizedPoint } from '../src/domain/types.js';

/** rect 근사 동등(부동소수 오차 허용). */
function expectRectClose(got: NormalizedRect, want: NormalizedRect): void {
  expect(got.x).toBeCloseTo(want.x);
  expect(got.y).toBeCloseTo(want.y);
  expect(got.w).toBeCloseTo(want.w);
  expect(got.h).toBeCloseTo(want.h);
}

describe('geometry', () => {
  it('center/area', () => {
    const r = { x: 0.2, y: 0.4, w: 0.2, h: 0.1 };
    expect(center(r)).toEqual({ cx: 0.30000000000000004, cy: 0.45 });
    expect(area(r)).toBeCloseTo(0.02);
  });

  it('intersection/iou - 동일 사각형', () => {
    const r = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(intersectionArea(r, r)).toBeCloseTo(0.25);
    expect(iou(r, r)).toBeCloseTo(1);
  });

  it('iou - 비겹침은 0', () => {
    const a = { x: 0, y: 0, w: 0.2, h: 0.2 };
    const b = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
    expect(iou(a, b)).toBe(0);
  });

  it('iou - 부분 겹침', () => {
    const a = { x: 0, y: 0, w: 0.4, h: 0.4 };
    const b = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    // inter = 0.2*0.2=0.04, union=0.16+0.16-0.04=0.28
    expect(iou(a, b)).toBeCloseTo(0.04 / 0.28);
  });

  it('containsPoint', () => {
    const r = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(containsPoint(r, 0.2, 0.2)).toBe(true);
    expect(containsPoint(r, 0.05, 0.2)).toBe(false);
  });

  it('pad - 0~1 범위 클램프', () => {
    const r = { x: 0.0, y: 0.0, w: 0.2, h: 0.2 };
    const p = pad(r, 0.5); // dx=dy=0.1, x=max(0,-0.1)=0
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
    expect(p.w).toBeCloseTo(0.4); // w+2dx=0.2+0.2=0.4, min(1-0,0.4)=0.4
  });

  it('normalizeBox - 픽셀→정규화', () => {
    const n = normalizeBox([100, 50, 300, 150], 1000, 500);
    expect(n.x).toBeCloseTo(0.1);
    expect(n.y).toBeCloseTo(0.1);
    expect(n.w).toBeCloseTo(0.2);
    expect(n.h).toBeCloseTo(0.2);
  });

  it('clamp01', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.3)).toBeCloseTo(0.3);
  });

  it('clampRect - 경계초과/음수 방어', () => {
    const r = clampRect({ x: -0.05, y: 0.9, w: 0.2, h: 0.3 });
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo(0.9);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1.0000001);
  });

  it('normalizeBox - 경계 밖 bbox 는 0~1 로 클램프(음수 제거)', () => {
    // x1 음수, x2 가 이미지 폭 초과 → 0~1 로 보정
    const n = normalizeBox([-10, 480, 1100, 520], 1000, 500);
    expect(n.x).toBe(0);
    expect(n.x + n.w).toBeLessThanOrEqual(1);
    expect(n.y + n.h).toBeLessThanOrEqual(1.0000001);
    expect(n.x).toBeGreaterThanOrEqual(0);
  });
});

// 검증자(qa-tester): LPD OBB quad 순수함수(설계서 §2, 케이스 1~3).
describe('normalizeQuad (LPD OBB 4점 정규화)', () => {
  it('픽셀 4점(1920×1080) → 0~1 정규화·점순서 보존(TL→TR→BR→BL)', () => {
    // ultralytics 규약: TL,TR,BR,BL. 순서를 재정렬하지 않고 그대로 보존해야 한다.
    const pts: [number, number][] = [
      [192, 108],   // TL → (0.1, 0.1)
      [960, 108],   // TR → (0.5, 0.1)
      [960, 540],   // BR → (0.5, 0.5)
      [192, 540],   // BL → (0.1, 0.5)
    ];
    const q = normalizeQuad(pts, 1920, 1080);
    expect(q).toHaveLength(4);
    expect(q[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(q[1]).toEqual({ x: 0.5, y: 0.1 });
    expect(q[2]).toEqual({ x: 0.5, y: 0.5 });
    expect(q[3]).toEqual({ x: 0.1, y: 0.5 });
  });

  it('회전 quad → 점순서/좌표 보존(축정렬로 뭉개지지 않음)', () => {
    // 마름모꼴(회전) — 각 점이 개별적으로 정규화되고 순서 유지.
    const pts: [number, number][] = [
      [500, 100],
      [700, 300],
      [500, 500],
      [300, 300],
    ];
    const q = normalizeQuad(pts, 1000, 1000);
    expect(q).toEqual([
      { x: 0.5, y: 0.1 },
      { x: 0.7, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.3 },
    ]);
  });

  it('경계 초과 픽셀 → 0~1 클램프', () => {
    const pts: [number, number][] = [
      [-50, -50],   // 음수 → 0
      [1100, -50],  // x 초과 → 1
      [1100, 600],  // y 초과 → 1
      [-50, 600],
    ];
    const q = normalizeQuad(pts, 1000, 500);
    expect(q[0]).toEqual({ x: 0, y: 0 });
    expect(q[1]).toEqual({ x: 1, y: 0 });
    expect(q[2]).toEqual({ x: 1, y: 1 });
    expect(q[3]).toEqual({ x: 0, y: 1 });
  });

  it('길이 != 4 → throw(방어)', () => {
    expect(() => normalizeQuad([[0, 0], [1, 1], [2, 2]] as [number, number][], 100, 100)).toThrow();
    expect(() => normalizeQuad([] as [number, number][], 100, 100)).toThrow();
  });
});

describe('quadBoundingRect (quad → 축정렬 rect)', () => {
  it('회전 quad → min/max 축정렬 bbox', () => {
    // 마름모(중심 0.5,0.3, 반경 0.2×0.2) → bbox x:0.3 y:0.1 w:0.4 h:0.4.
    const rot: [ { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number } ] = [
      { x: 0.5, y: 0.1 },
      { x: 0.7, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.3 },
    ];
    expectRectClose(quadBoundingRect(rot), { x: 0.3, y: 0.1, w: 0.4, h: 0.4 });
  });

  it('축정렬 quad → 동일 rect(정보 손실 없음)', () => {
    const r: NormalizedRect = { x: 0.2, y: 0.3, w: 0.15, h: 0.1 };
    expectRectClose(quadBoundingRect(rectToQuad(r)), r);
  });
});

describe('rectToQuad (하위호환 승격)', () => {
  it('rect → TL,TR,BR,BL 4점(순서·좌표)', () => {
    const q = rectToQuad({ x: 0.2, y: 0.3, w: 0.4, h: 0.1 });
    expect(q).toHaveLength(4);
    const near = (p: { x: number; y: number }, x: number, y: number) => {
      expect(p.x).toBeCloseTo(x);
      expect(p.y).toBeCloseTo(y);
    };
    near(q[0], 0.2, 0.3); // TL
    near(q[1], 0.6, 0.3); // TR (x+w)
    near(q[2], 0.6, 0.4); // BR (x+w, y+h)
    near(q[3], 0.2, 0.4); // BL (x, y+h)
  });

  it('quadBoundingRect(rectToQuad(r)) == r (왕복 항등)', () => {
    const cases: NormalizedRect[] = [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.11, y: 0.7, w: 0.03, h: 0.02 },
      { x: 0.5, y: 0.5, w: 0, h: 0 },
    ];
    for (const r of cases) {
      const back = quadBoundingRect(rectToQuad(r));
      expect(back.x).toBeCloseTo(r.x);
      expect(back.y).toBeCloseTo(r.y);
      expect(back.w).toBeCloseTo(r.w);
      expect(back.h).toBeCloseTo(r.h);
    }
  });
});

// 검증자(qa-tester): Aggregator 대표 bbox 산출의 핵심 헬퍼(설계서 §4.2 "중앙값").
describe('median (집계 대표 bbox 헬퍼)', () => {
  it('홀수 길이 → 가운데 값', () => {
    expect(median([3, 1, 2])).toBe(2); // 정렬 [1,2,3] → 2
    expect(median([5])).toBe(5);
  });

  it('짝수 길이 → 가운데 두 값의 평균', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5); // (2+3)/2
    expect(median([0.2, 0.4])).toBeCloseTo(0.3);
  });

  it('정렬되지 않은 입력도 정렬 후 중앙값(원본 불변)', () => {
    const input = [0.9, 0.1, 0.5, 0.3, 0.7];
    expect(median(input)).toBeCloseTo(0.5);
    // 원본 배열을 변형하지 않아야 한다([...values].sort 사용).
    expect(input).toEqual([0.9, 0.1, 0.5, 0.3, 0.7]);
  });

  it('빈 배열 → 0', () => {
    expect(median([])).toBe(0);
  });
});

// 검증자(qa-tester): 강건 통계 순수함수(설계서 §2 — 집계 강건화).
describe('mad (중앙절대편차, raw)', () => {
  it('center 미지정 → median 기준 편차의 median', () => {
    // values [1,2,4,4] median=3; |dev|=[2,1,1,1] → median=1.
    expect(mad([1, 2, 4, 4])).toBeCloseTo(1);
  });
  it('center 지정 시 그 기준', () => {
    expect(mad([0.2, 0.2, 0.5], 0.2)).toBeCloseTo(0); // |dev|=[0,0,0.3] median 0
  });
  it('길이<2 → 0', () => {
    expect(mad([])).toBe(0);
    expect(mad([0.7])).toBe(0);
  });
});

describe('weightedMedian (conf 가중 median)', () => {
  it('등가중이면 median 과 동일(홀수·짝수)', () => {
    expect(weightedMedian([3, 1, 2], [1, 1, 1])).toBe(2);
    expect(weightedMedian([1, 2, 3, 4], [1, 1, 1, 1])).toBeCloseTo(2.5); // 경계 평균
  });
  it('고가중 값 쪽으로 대표 이동', () => {
    // 값 3 에 큰 가중 → 누적이 절반을 3 에서 넘음.
    expect(weightedMedian([1, 2, 3], [1, 1, 10])).toBe(3);
  });
  it('가중치 전부 0/음수 → median 폴백', () => {
    expect(weightedMedian([1, 2, 3], [0, 0, 0])).toBe(2);
    expect(weightedMedian([1, 2, 3], [-1, -2, -3])).toBe(2);
  });
  it('단일 원소 → 그 값', () => {
    expect(weightedMedian([0.42], [0.9])).toBe(0.42);
  });
  it('빈 배열 → 0', () => {
    expect(weightedMedian([], [])).toBe(0);
  });
});

describe('medianPoint (좌표별 median 점)', () => {
  it('좌표별 median', () => {
    const pts: NormalizedPoint[] = [
      { x: 0.1, y: 0.5 },
      { x: 0.2, y: 0.4 },
      { x: 0.9, y: 0.6 },
    ];
    expect(medianPoint(pts)).toEqual({ x: 0.2, y: 0.5 });
  });
  it('빈 배열 → {0,0}', () => {
    expect(medianPoint([])).toEqual({ x: 0, y: 0 });
  });
});

describe('axialWrap (축 주기 π 래핑 → (-π/2, π/2])', () => {
  it('범위 내 각도 항등', () => {
    expect(axialWrap(0.3)).toBeCloseTo(0.3);
    expect(axialWrap(Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });
  it('π-반전은 같은 축(0 등가)', () => {
    expect(Math.abs(axialWrap(Math.PI))).toBeCloseTo(0);
    // θ+π 는 θ 와 동일 축.
    expect(axialWrap(0.3 + Math.PI)).toBeCloseTo(0.3);
  });
});

describe('circularMedianAngle (축 순환 median)', () => {
  it('동일 각들 → 그 각', () => {
    expect(circularMedianAngle([0.4, 0.4, 0.4])).toBeCloseTo(0.4);
  });
  it('±90° straddle(π 근처 배증) → 산술평균 오류 없이 올바른 축 대표', () => {
    // +80°, −80° 는 축(선방향)으로 거의 수직(±90°). 산술평균 0°(수평)는 오류.
    const a = (deg: number) => (deg * Math.PI) / 180;
    const m = circularMedianAngle([a(80), a(80), a(-80)]);
    // 축 대표는 ~±90° 쪽(|m|이 크다), 0 근처가 아님.
    expect(Math.abs(m)).toBeGreaterThan(a(70));
  });
  it('점순서 반전(θ vs θ+π) 흡수 → 동일 대표', () => {
    // 같은 선방향을 θ, θ+π 로 표기해도 대표는 동일 축.
    const m = circularMedianAngle([0.5, 0.5 + Math.PI, 0.5]);
    expect(axialWrap(m)).toBeCloseTo(0.5);
  });
  it('빈 배열 → 0, 단일 → 폴딩', () => {
    expect(circularMedianAngle([])).toBe(0);
    expect(circularMedianAngle([0.3 + Math.PI])).toBeCloseTo(0.3);
  });
  it('가중 median: 고가중 각도 쪽 대표', () => {
    const m = circularMedianAngle([0.1, 0.1, 0.5], [1, 1, 10]);
    expect(m).toBeCloseTo(0.5, 5);
  });
});

describe('circularMad (축 각도 분산)', () => {
  it('center 기준 축 잔차의 median', () => {
    // 잔차 |axialWrap([0,0,0.2]-0)| = [0,0,0.2] → median 0.
    expect(circularMad([0, 0, 0.2], 0)).toBeCloseTo(0);
    expect(circularMad([0, 0.2, 0.2], 0)).toBeCloseTo(0.2);
  });
  it('길이<2 → 0', () => {
    expect(circularMad([0.5], 0.5)).toBe(0);
  });
});

describe('synthesizePlateQuad (중심·각도·크기 → 대표 quad)', () => {
  it('plateAngleRad(합성) == theta(규약 정합), 점순서 TL,TR,BR,BL', () => {
    for (const theta of [0, 0.3, -0.4, 0.588]) {
      const q = synthesizePlateQuad({ x: 0.5, y: 0.5 }, theta, 0.1, 0.04);
      expect(plateAngleRad(q)).toBeCloseTo(theta, 6);
      // 중심 보존.
      const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
      const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
      expect(cx).toBeCloseTo(0.5);
      expect(cy).toBeCloseTo(0.5);
    }
  });
  it('boundingRect ≈ 로컬 크기(각도 0 이면 정확히 W×H)', () => {
    const q = synthesizePlateQuad({ x: 0.5, y: 0.5 }, 0, 0.1, 0.04);
    const br = quadBoundingRect(q);
    expect(br.w).toBeCloseTo(0.1);
    expect(br.h).toBeCloseTo(0.04);
  });
  it('각 점 clamp01(경계 방어)', () => {
    const q = synthesizePlateQuad({ x: 0.99, y: 0.99 }, 0, 0.2, 0.2);
    for (const p of q) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});
