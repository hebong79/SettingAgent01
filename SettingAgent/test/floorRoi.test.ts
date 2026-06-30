import { describe, it, expect } from 'vitest';
import { fallbackQuadFromRect, normalizeQuad, resolveFloorQuad } from '../src/capture/floorRoi.js';
import type { NormalizedRect } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): floor ROI 결정형 순수 모듈 (설계서 §4).
 * 폴백 사변형·좌표 클램프·순서 정규화([앞왼,앞오,뒤오,뒤왼]). floor ROI 항상 존재 보장.
 */

const inRange = (v: number) => v >= 0 && v <= 1;

describe('fallbackQuadFromRect (bbox 유도 폴백)', () => {
  it('rect → 4점, 모두 0~1, 바닥 변 y > 윗 변 y', () => {
    const r: NormalizedRect = { x: 0.2, y: 0.3, w: 0.4, h: 0.3 };
    const q = fallbackQuadFromRect(r);
    expect(q).toHaveLength(4);
    expect(q.every((p) => inRange(p.x) && inRange(p.y))).toBe(true);
    // [0],[1]=앞(하단, y 큼), [2],[3]=뒤(상단, y 작음).
    expect(q[0].y).toBeGreaterThan(q[3].y);
    expect(q[1].y).toBeGreaterThan(q[2].y);
    // 앞 변(하단)이 뒤 변(상단)보다 넓다(inset).
    expect(q[1].x - q[0].x).toBeGreaterThan(q[2].x - q[3].x);
  });

  it('범위 초과 rect 도 클램프되어 0~1', () => {
    const q = fallbackQuadFromRect({ x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    expect(q.every((p) => inRange(p.x) && inRange(p.y))).toBe(true);
  });
});

describe('normalizeQuad (검증·클램프·순서)', () => {
  it('점 수 3 → null', () => {
    expect(normalizeQuad([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }])).toBeNull();
  });

  it('NaN 포함 → null', () => {
    expect(
      normalizeQuad([{ x: NaN, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }]),
    ).toBeNull();
  });

  it('undefined → null', () => {
    expect(normalizeQuad(undefined)).toBeNull();
  });

  it('범위 초과 → 클램프 0~1', () => {
    const q = normalizeQuad([
      { x: -0.5, y: 1.5 },
      { x: 1.2, y: 1.4 },
      { x: 1.3, y: -0.2 },
      { x: -0.1, y: -0.3 },
    ])!;
    expect(q.every((p) => inRange(p.x) && inRange(p.y))).toBe(true);
  });

  it('뒤섞인 순서 → [앞왼, 앞오, 뒤오, 뒤왼] 정렬', () => {
    // 입력을 뒤죽박죽으로: 뒤오, 앞왼, 뒤왼, 앞오.
    const q = normalizeQuad([
      { x: 0.8, y: 0.2 }, // 뒤오(상단·우)
      { x: 0.2, y: 0.9 }, // 앞왼(하단·좌)
      { x: 0.1, y: 0.2 }, // 뒤왼(상단·좌)
      { x: 0.9, y: 0.9 }, // 앞오(하단·우)
    ])!;
    expect(q[0]).toEqual({ x: 0.2, y: 0.9 }); // 앞왼
    expect(q[1]).toEqual({ x: 0.9, y: 0.9 }); // 앞오
    expect(q[2]).toEqual({ x: 0.8, y: 0.2 }); // 뒤오
    expect(q[3]).toEqual({ x: 0.1, y: 0.2 }); // 뒤왼
  });
});

describe('resolveFloorQuad (LLM 결과 + rect → 항상 quad)', () => {
  const vehicle: NormalizedRect = { x: 0.2, y: 0.3, w: 0.3, h: 0.3 };

  it('llm=null → 폴백 사변형', () => {
    const q = resolveFloorQuad(null, vehicle);
    expect(q).toEqual(fallbackQuadFromRect(vehicle));
  });

  it('유효 llm → 정규화 quad(폴백 아님)', () => {
    const raw = [
      { x: 0.2, y: 0.9 },
      { x: 0.5, y: 0.9 },
      { x: 0.45, y: 0.6 },
      { x: 0.25, y: 0.6 },
    ];
    const q = resolveFloorQuad(raw, vehicle);
    expect(q).toEqual(normalizeQuad(raw));
  });

  it('무효 llm(3점) → 폴백', () => {
    const q = resolveFloorQuad([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], vehicle);
    expect(q).toEqual(fallbackQuadFromRect(vehicle));
  });
});
