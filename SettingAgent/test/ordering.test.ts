import { describe, it, expect } from 'vitest';
import { orderByPosition } from '../src/setup/ordering.js';
import type { NormalizedRect } from '../src/domain/types.js';

const rect = (x: number, y: number): NormalizedRect => ({ x, y, w: 0.05, h: 0.05 });

describe('orderByPosition', () => {
  it('상→하 밴드, 같은 밴드 내 좌→우', () => {
    // 윗줄: y≈0.1 (x=0.6, 0.2) / 아랫줄: y≈0.5 (x=0.4, 0.1)
    const rects = [rect(0.6, 0.1), rect(0.2, 0.1), rect(0.4, 0.5), rect(0.1, 0.5)];
    const order = orderByPosition(rects, 0.1);
    // 기대: 윗줄 좌→우 (idx1=x0.2, idx0=x0.6), 아랫줄 좌→우 (idx3=x0.1, idx2=x0.4)
    expect(order).toEqual([1, 0, 3, 2]);
  });

  it('단일 행', () => {
    const rects = [rect(0.9, 0.5), rect(0.1, 0.5), rect(0.5, 0.5)];
    expect(orderByPosition(rects, 0.1)).toEqual([1, 2, 0]);
  });

  it('빈 입력', () => {
    expect(orderByPosition([], 0.1)).toEqual([]);
  });

  it('tolerance 작으면 별도 밴드로 분리', () => {
    // y 차이 0.04 < tol 0.05 → 같은 밴드(좌→우). tol 0.02 → 다른 밴드(상→하)
    const rects = [rect(0.8, 0.10), rect(0.2, 0.14)];
    expect(orderByPosition(rects, 0.05)).toEqual([1, 0]); // 같은 밴드, 좌→우
    expect(orderByPosition(rects, 0.02)).toEqual([0, 1]); // 다른 밴드, 위(y0.10)가 먼저
  });
});
