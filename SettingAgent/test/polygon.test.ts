import { describe, it, expect } from 'vitest';
import {
  convexHull,
  polygonArea,
  polygonSignedArea,
  polygonCentroid,
  pointInPolygon,
  rectCorners,
  clipByHalfPlane,
  convexIntersectionArea,
  perpBisector,
  type HalfPlaneLine,
} from '../src/domain/polygon.js';
import type { NormalizedPoint, NormalizedPolygon } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 순수 기하 프리미티브 (설계서 §2-1 · 테스트계획 T5).
 * 수치 정확성 단언 — convexHull(정렬·중복·공선점), area/signedArea(부호), pointInPolygon(경계/내부/외부),
 * clipByHalfPlane(반평면 축소), convexIntersectionArea(겹침 면적), perpBisector(수직이등분선).
 */

const unitSquare: NormalizedPolygon = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

describe('convexHull', () => {
  it('중복점 제거 + 사각형 4정점 복원', () => {
    const pts: NormalizedPoint[] = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, // 중복
      { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    // 껍질 면적 = 1(단위정사각형).
    expect(polygonArea(hull)).toBeCloseTo(1, 12);
  });

  it('공선점(변 위의 점) 제거 → 코너만 남김', () => {
    const pts: NormalizedPoint[] = [
      { x: 0, y: 0 }, { x: 0.5, y: 0 }, // 아래 변 위 공선점
      { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
  });

  it('내부점 제거(삼각형 안의 점)', () => {
    const pts: NormalizedPoint[] = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 },
      { x: 0.5, y: 0.4 }, // 내부
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(3);
    expect(polygonArea(hull)).toBeCloseTo(0.5, 12);
  });

  it('완전 공선(일직선) 입력 → 정점 ≤2(퇴화)', () => {
    const pts: NormalizedPoint[] = [
      { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 },
    ];
    const hull = convexHull(pts);
    expect(hull.length).toBeLessThanOrEqual(2);
  });

  it('NaN/Inf 점은 필터', () => {
    const pts: NormalizedPoint[] = [
      { x: 0, y: 0 }, { x: NaN, y: 0.5 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
  });
});

describe('polygonArea / polygonSignedArea', () => {
  it('단위정사각형 면적 = 1', () => {
    expect(polygonArea(unitSquare)).toBeCloseTo(1, 12);
  });

  it('signedArea: CW(이미지좌표 하강) 부호 반대·절댓값 동일', () => {
    const cw = [...unitSquare].reverse();
    expect(polygonSignedArea(unitSquare)).toBeCloseTo(1, 12);
    expect(polygonSignedArea(cw)).toBeCloseTo(-1, 12);
    expect(Math.abs(polygonSignedArea(cw))).toBeCloseTo(polygonArea(cw), 12);
  });

  it('삼각형 면적', () => {
    const tri: NormalizedPolygon = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(polygonArea(tri)).toBeCloseTo(0.5, 12);
  });
});

describe('polygonCentroid', () => {
  it('단위정사각형 무게중심 = (0.5,0.5)', () => {
    const c = polygonCentroid(unitSquare);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0.5, 12);
  });

  it('퇴화(면적≈0) 시 정점 평균 폴백', () => {
    const line: NormalizedPolygon = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const c = polygonCentroid(line);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0, 12);
  });
});

describe('pointInPolygon (ray casting)', () => {
  it('내부 참', () => {
    expect(pointInPolygon(unitSquare, { x: 0.5, y: 0.5 })).toBe(true);
  });
  it('외부 거짓', () => {
    expect(pointInPolygon(unitSquare, { x: 1.5, y: 0.5 })).toBe(false);
    expect(pointInPolygon(unitSquare, { x: -0.1, y: 0.5 })).toBe(false);
  });
  it('명확한 내부/외부 판정(대각 삼각형)', () => {
    const tri: NormalizedPolygon = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    expect(pointInPolygon(tri, { x: 0.8, y: 0.2 })).toBe(true); // 삼각형 내부
    expect(pointInPolygon(tri, { x: 0.2, y: 0.8 })).toBe(false); // 대각선 반대편
  });
});

describe('rectCorners', () => {
  it('TL,TR,BR,BL 순서', () => {
    const c = rectCorners({ x: 0.1, y: 0.2, w: 0.4, h: 0.3 });
    expect(c).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.5 },
    ]);
  });
});

describe('clipByHalfPlane', () => {
  it('x ≥ 0.5 반평면으로 단위정사각형 클립 → 면적 0.5', () => {
    // n·(x−p0) ≥ 0, n=(1,0), p0=(0.5,·) → x ≥ 0.5 유지.
    const line: HalfPlaneLine = { p0: { x: 0.5, y: 0.5 }, n: { x: 1, y: 0 } };
    const clipped = clipByHalfPlane(unitSquare, line);
    expect(polygonArea(clipped)).toBeCloseTo(0.5, 12);
    // 유지된 정점은 모두 x ≥ 0.5.
    for (const p of clipped) expect(p.x).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it('전부 유지(반평면이 폴리곤 전체 포함) → 면적 불변', () => {
    const line: HalfPlaneLine = { p0: { x: -1, y: 0 }, n: { x: 1, y: 0 } }; // x ≥ -1 (전부)
    const clipped = clipByHalfPlane(unitSquare, line);
    expect(polygonArea(clipped)).toBeCloseTo(1, 12);
  });

  it('전부 제거(반평면 밖) → 빈 배열', () => {
    const line: HalfPlaneLine = { p0: { x: 2, y: 0 }, n: { x: 1, y: 0 } }; // x ≥ 2
    expect(clipByHalfPlane(unitSquare, line)).toHaveLength(0);
  });

  it('대각 반평면 클립 → 삼각형 면적 0.5', () => {
    // n=(−1,1), p0=(0,0): −x+y ≥ 0 → y ≥ x 유지(좌상 삼각형).
    const line: HalfPlaneLine = { p0: { x: 0, y: 0 }, n: { x: -1, y: 1 } };
    const clipped = clipByHalfPlane(unitSquare, line);
    expect(polygonArea(clipped)).toBeCloseTo(0.5, 10);
  });
});

describe('convexIntersectionArea', () => {
  it('절반 겹침(x 방향 0.5 폭) = 0.5', () => {
    const a = unitSquare;
    const b: NormalizedPolygon = [
      { x: 0.5, y: 0 }, { x: 1.5, y: 0 }, { x: 1.5, y: 1 }, { x: 0.5, y: 1 },
    ];
    // a: x∈[0,1], b: x∈[0.5,1.5] → 교차 x∈[0.5,1](폭0.5)×y∈[0,1] = 0.5.
    expect(convexIntersectionArea(a, b)).toBeCloseTo(0.5, 10);
    // 대칭성.
    expect(convexIntersectionArea(b, a)).toBeCloseTo(0.5, 10);
  });

  it('분리(겹침 없음) = 0', () => {
    const b: NormalizedPolygon = [
      { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 1 },
    ];
    expect(convexIntersectionArea(unitSquare, b)).toBeCloseTo(0, 12);
  });

  it('완전 포함 = 작은 쪽 면적', () => {
    const small: NormalizedPolygon = [
      { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 },
    ];
    expect(convexIntersectionArea(unitSquare, small)).toBeCloseTo(0.25, 10);
  });

  it('정점 3 미만이면 0', () => {
    expect(convexIntersectionArea([{ x: 0, y: 0 }, { x: 1, y: 1 }], unitSquare)).toBe(0);
  });
});

describe('perpBisector', () => {
  it('두 점의 수직이등분선: p0=중점, n=cA−cB (cA 측 양수)', () => {
    const line = perpBisector({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(line.p0).toEqual({ x: 1, y: 0 });
    expect(line.n).toEqual({ x: -2, y: 0 });
    // cA 측(원점) 유지: side(cA) ≥ 0.
    const side = (p: NormalizedPoint) => line.n.x * (p.x - line.p0.x) + line.n.y * (p.y - line.p0.y);
    expect(side({ x: 0, y: 0 })).toBeGreaterThan(0); // cA 측
    expect(side({ x: 2, y: 0 })).toBeLessThan(0); // cB 측
  });
});
