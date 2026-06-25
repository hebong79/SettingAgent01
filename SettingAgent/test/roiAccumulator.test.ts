import { describe, it, expect } from 'vitest';
import { buildSlotsAccumulated } from '../src/setup/RoiAccumulator.js';
import type { VehicleBox } from '../src/domain/types.js';

const vb = (x: number, y: number, conf = 0.9): VehicleBox => ({ rect: { x, y, w: 0.1, h: 0.1 }, confidence: conf, cls: 'car' });

const opts = { minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1, clusterDist: 0.06, minSupport: 2 };

describe('buildSlotsAccumulated', () => {
  it('여러 프레임의 근접 검출을 같은 슬롯으로 병합', () => {
    // 같은 두 위치가 3프레임에 약간씩 흔들리며 관측됨
    const frames: VehicleBox[][] = [
      [vb(0.20, 0.10), vb(0.60, 0.10)],
      [vb(0.21, 0.11), vb(0.59, 0.09)],
      [vb(0.205, 0.105), vb(0.61, 0.105)],
    ];
    const built = buildSlotsAccumulated(frames, opts);
    expect(built).toHaveLength(2);
    // 좌→우 순서, 대표 ROI 는 평균에 가까움
    expect(built[0].roi.x).toBeCloseTo(0.205, 1);
    expect(built[1].roi.x).toBeCloseTo(0.60, 1);
  });

  it('minSupport 미만(전이성) 클러스터 제외', () => {
    // 0.2 위치는 3회, 0.8 위치는 1회만(노이즈) → minSupport=2 면 1개만 남음
    const frames: VehicleBox[][] = [[vb(0.2, 0.5)], [vb(0.21, 0.5)], [vb(0.2, 0.49), vb(0.8, 0.5)]];
    const built = buildSlotsAccumulated(frames, opts);
    expect(built).toHaveLength(1);
    expect(built[0].roi.x).toBeCloseTo(0.2, 1);
  });

  it('멀리 떨어진 검출은 별도 슬롯', () => {
    const frames: VehicleBox[][] = [
      [vb(0.1, 0.1), vb(0.9, 0.9)],
      [vb(0.1, 0.1), vb(0.9, 0.9)],
    ];
    const built = buildSlotsAccumulated(frames, opts);
    expect(built).toHaveLength(2);
  });

  it('minConfidence 미만 제외', () => {
    const frames: VehicleBox[][] = [[vb(0.2, 0.2, 0.3)], [vb(0.2, 0.2, 0.4)]];
    expect(buildSlotsAccumulated(frames, opts)).toHaveLength(0);
  });

  it('빈 프레임들은 빈 결과', () => {
    expect(buildSlotsAccumulated([[], []], opts)).toEqual([]);
  });
});
