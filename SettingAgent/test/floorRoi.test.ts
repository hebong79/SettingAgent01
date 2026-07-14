import { describe, it, expect } from 'vitest';
import {
  buildPlateAnchoredQuad,
  normalizePolygon,
  resolveFloorPolygon,
  expandPolygonToContainRect,
  predictPlateRect,
} from '../src/capture/floorRoi.js';
import { rectCorners } from '../src/domain/polygon.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { NormalizedRect, NormalizedPolygon } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): floor ROI 결정형 순수 모듈 (설계서 §2·§3 · 가변 다각형 4~10점).
 * 폴백 발자국·예상 번호판 포함·마진·볼록껍질 정규화·포함 확장(멱등). 값 확장(마진·포함)으로
 * 정확한 좌표 대신 불변식(정점수·범위·포함·순서·멱등)을 검증한다.
 */

const inRange = (v: number) => v >= 0 && v <= 1;
const allIn = (poly: NormalizedPolygon) => poly.every((p) => inRange(p.x) && inRange(p.y));

/** 점이 볼록 N각형 내부/경계에 있는지(cross product 부호 일관성, 경계 포함). */
function pointInConvex(p: { x: number; y: number }, poly: NormalizedPolygon): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
const containsRect = (poly: NormalizedPolygon, r: NormalizedRect) =>
  rectCorners(r).every((c) => pointInConvex(c, poly));

describe('predictPlateRect (R3 · 앞·하단 중앙 밴드)', () => {
  it('차량 앞면 하단 중앙, 0~1', () => {
    const v: NormalizedRect = { x: 0.2, y: 0.3, w: 0.4, h: 0.4 };
    const p = predictPlateRect(v);
    expect(p.x).toBeCloseTo(0.2 + 0.4 * 0.3, 10);
    expect(p.y).toBeCloseTo(0.3 + 0.4 * 0.72, 10);
    expect(p.w).toBeCloseTo(0.4 * 0.4, 10);
    expect(p.h).toBeCloseTo(0.4 * 0.18, 10);
    // 가로 중앙 = 차량 중앙, 세로는 하단(중앙보다 아래).
    expect(p.x + p.w / 2).toBeCloseTo(v.x + v.w / 2, 10);
    expect(p.y).toBeGreaterThan(v.y + v.h / 2);
  });

  it('경계 차량 → clamp 0~1', () => {
    const p = predictPlateRect({ x: 0.9, y: 0.95, w: 0.4, h: 0.4 });
    expect(inRange(p.x) && inRange(p.y)).toBe(true);
    expect(p.x + p.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(p.y + p.h).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('buildPlateAnchoredQuad (번호판 기준 4점 회전 사변형 · 번호판 포함)', () => {
  const v: NormalizedRect = { x: 0.2, y: 0.3, w: 0.4, h: 0.3 };

  it('정확히 4점, 모두 0~1', () => {
    const poly = buildPlateAnchoredQuad(v);
    expect(poly).toHaveLength(4);
    expect(allIn(poly)).toBe(true);
  });

  it('plateQuad 없이도 예상 번호판(predictPlateRect) 포함', () => {
    const poly = buildPlateAnchoredQuad(v);
    expect(containsRect(poly, predictPlateRect(v))).toBe(true);
  });

  it('plateQuad 주면 그 번호판 포함', () => {
    const plate: NormalizedRect = { x: 0.1, y: 0.55, w: 0.05, h: 0.05 };
    const poly = buildPlateAnchoredQuad(v, rectToQuad(plate));
    expect(containsRect(poly, plate)).toBe(true);
  });

  it('범위 초과 차량도 클램프되어 0~1', () => {
    expect(allIn(buildPlateAnchoredQuad({ x: 0.9, y: 0.9, w: 0.4, h: 0.4 }))).toBe(true);
  });
});

describe('normalizePolygon (검증·클램프·볼록껍질·정렬·마진)', () => {
  const p = { x: 0.2, y: 0.2 };

  it('점 수 3 → null', () => {
    expect(normalizePolygon([p, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.5 }])).toBeNull();
  });

  it('점 수 11 → null', () => {
    const raw = Array.from({ length: 11 }, (_, i) => ({ x: 0.1 + i * 0.01, y: 0.5 }));
    expect(normalizePolygon(raw)).toBeNull();
  });

  it('NaN 포함 → null', () => {
    expect(normalizePolygon([{ x: NaN, y: 0.1 }, p, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }])).toBeNull();
  });

  it('undefined → null', () => {
    expect(normalizePolygon(undefined)).toBeNull();
  });

  it('4·7·10점 → 유효(4~10, 0~1)', () => {
    for (const n of [4, 7, 10]) {
      const raw = Array.from({ length: n }, (_, i) => ({
        x: 0.5 + 0.3 * Math.cos((2 * Math.PI * i) / n),
        y: 0.5 + 0.3 * Math.sin((2 * Math.PI * i) / n),
      }));
      const out = normalizePolygon(raw)!;
      expect(out).not.toBeNull();
      expect(out.length).toBeGreaterThanOrEqual(4);
      expect(out.length).toBeLessThanOrEqual(10);
      expect(allIn(out)).toBe(true);
    }
  });

  it('범위 초과 → 클램프 0~1', () => {
    const q = normalizePolygon([
      { x: -0.5, y: 1.5 },
      { x: 1.2, y: 1.4 },
      { x: 1.3, y: -0.2 },
      { x: -0.1, y: -0.3 },
    ])!;
    expect(allIn(q)).toBe(true);
  });

  it('4점 캐노니컬: [0]=앞왼(max y·min x), 시계방향(앞→앞→뒤→뒤)', () => {
    // 입력 뒤죽박죽: 뒤오, 앞왼, 뒤왼, 앞오.
    const q = normalizePolygon([
      { x: 0.8, y: 0.2 }, // 뒤오
      { x: 0.2, y: 0.9 }, // 앞왼
      { x: 0.1, y: 0.2 }, // 뒤왼
      { x: 0.9, y: 0.9 }, // 앞오
    ])!;
    expect(q).toHaveLength(4);
    // 앞(하단) 두 점이 뒤(상단) 두 점보다 아래(y 큼).
    expect(q[0].y).toBeGreaterThan(q[3].y);
    expect(q[1].y).toBeGreaterThan(q[2].y);
    // 앞왼이 앞오보다 왼쪽, 뒤왼이 뒤오보다 왼쪽.
    expect(q[0].x).toBeLessThan(q[1].x);
    expect(q[3].x).toBeLessThan(q[2].x);
  });
});

describe('expandPolygonToContainRect (포함 강제 · 멱등 · clamp)', () => {
  const base = (): NormalizedPolygon => [
    { x: 0.3, y: 0.9 },
    { x: 0.7, y: 0.9 },
    { x: 0.65, y: 0.6 },
    { x: 0.35, y: 0.6 },
  ];

  it('밖 rect → 4모서리 모두 포함', () => {
    const rect: NormalizedRect = { x: 0.05, y: 0.92, w: 0.2, h: 0.06 };
    const poly = expandPolygonToContainRect(base(), rect);
    expect(containsRect(poly, rect)).toBe(true);
    expect(poly.length).toBeLessThanOrEqual(10);
  });

  it('이미 내부면 원본 반환(멱등, 동일 참조)', () => {
    const b = base();
    const inside: NormalizedRect = { x: 0.45, y: 0.7, w: 0.1, h: 0.1 };
    const out = expandPolygonToContainRect(b, inside);
    expect(out).toBe(b);
    expect(expandPolygonToContainRect(out, inside)).toBe(b);
  });

  it('확장 후 재적용 불변(멱등)', () => {
    const rect: NormalizedRect = { x: 0.05, y: 0.92, w: 0.2, h: 0.06 };
    const once = expandPolygonToContainRect(base(), rect);
    const twice = expandPolygonToContainRect(once, rect);
    expect(twice).toEqual(once);
  });

  it('범위 초과 rect → 결과 모든 좌표 0~1(clamp)', () => {
    const poly = expandPolygonToContainRect(base(), { x: -0.1, y: -0.1, w: 1.3, h: 1.3 });
    expect(allIn(poly)).toBe(true);
  });
});

describe('resolveFloorPolygon (LLM 결과 + rect → 항상 유효 다각형)', () => {
  const vehicle: NormalizedRect = { x: 0.2, y: 0.3, w: 0.3, h: 0.3 };

  it('llm=null·plate=undefined → 유효 다각형 + 예상 번호판 포함', () => {
    const poly = resolveFloorPolygon(null, vehicle);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    expect(allIn(poly)).toBe(true);
    expect(containsRect(poly, predictPlateRect(vehicle))).toBe(true);
  });

  it('무효 llm(3점) → 폴백(유효)', () => {
    const poly = resolveFloorPolygon([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], vehicle);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    expect(allIn(poly)).toBe(true);
  });

  it('유효 llm(메인) → normalizePolygon(raw) 그대로(밖 plate 포함강제 안함)', () => {
    const raw = [
      { x: 0.2, y: 0.9 },
      { x: 0.5, y: 0.9 },
      { x: 0.45, y: 0.6 },
      { x: 0.25, y: 0.6 },
    ];
    const plate: NormalizedRect = { x: 0.6, y: 0.7, w: 0.08, h: 0.05 };
    const poly = resolveFloorPolygon(raw, vehicle, undefined, plate);
    // 권위 역전: LLM 유효 → 안전망(normalizePolygon)만 적용, 번호판 앵커·포함강제 없음.
    expect(poly).toEqual(normalizePolygon(raw));
    // 밖에 있는 plate 를 삼키지 않음(메인 경로 포함강제 제거 증명).
    expect(containsRect(poly, plate)).toBe(false);
  });
});
