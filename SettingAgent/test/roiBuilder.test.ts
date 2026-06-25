import { describe, it, expect } from 'vitest';
import { buildSlots } from '../src/setup/RoiBuilder.js';
import type { VehicleBox } from '../src/domain/types.js';

const vb = (x: number, y: number, conf = 0.9): VehicleBox => ({
  rect: { x, y, w: 0.1, h: 0.1 },
  confidence: conf,
  cls: 'car',
});

describe('buildSlots', () => {
  it('위치 순서대로 positionIdx 부여(1-based)', () => {
    const built = buildSlots([vb(0.6, 0.1), vb(0.2, 0.1), vb(0.3, 0.6)], {
      minConfidence: 0.5,
      roiPadding: 0,
      yBandTolerance: 0.1,
    });
    expect(built.map((b) => b.positionIdx)).toEqual([1, 2, 3]);
    // 첫 슬롯은 윗줄 좌측(x=0.2)
    expect(built[0].roi.x).toBeCloseTo(0.2);
    expect(built[1].roi.x).toBeCloseTo(0.6);
    expect(built[2].roi.y).toBeCloseTo(0.6);
  });

  it('minConfidence 미만 제외', () => {
    const built = buildSlots([vb(0.2, 0.1, 0.3), vb(0.5, 0.1, 0.8)], {
      minConfidence: 0.5,
      roiPadding: 0,
      yBandTolerance: 0.1,
    });
    expect(built).toHaveLength(1);
    expect(built[0].confidence).toBe(0.8);
  });

  it('roiPadding 적용으로 ROI 가 bbox 보다 넓어짐', () => {
    const built = buildSlots([vb(0.4, 0.4)], { minConfidence: 0.5, roiPadding: 0.1, yBandTolerance: 0.1 });
    expect(built[0].roi.w).toBeGreaterThan(0.1);
  });

  it('검출 없으면 빈 배열', () => {
    expect(buildSlots([], { minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1 })).toEqual([]);
  });
});
