import { describe, it, expect } from 'vitest';
import { matchPlatesToSlots } from '../src/setup/plateMatch.js';
import type { BuiltSlot } from '../src/setup/RoiBuilder.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';

const slot = (positionIdx: number, x: number, y: number): BuiltSlot => ({
  positionIdx,
  roi: { x, y, w: 0.2, h: 0.2 },
  confidence: 0.9,
});
const plate = (x: number, y: number, w = 0.05, h = 0.03): PlateBox => ({
  quad: rectToQuad({ x, y, w, h }),
  confidence: 0.95,
  cls: 'car_license_plate',
});

describe('matchPlatesToSlots', () => {
  it('번호판 중심이 차량 ROI 안이면 해당 슬롯에 귀속', () => {
    const slots = [slot(1, 0.1, 0.1), slot(2, 0.6, 0.1)];
    // 번호판 중심(0.17,0.22)은 슬롯1 ROI(0.1~0.3,0.1~0.3) 내부
    const m = matchPlatesToSlots(slots, [plate(0.15, 0.2)]);
    expect(m.has(1)).toBe(true);
    expect(m.has(2)).toBe(false);
    // 반환값은 실 OBB quad(방향 보존). 축정렬 fixture 는 boundingRect 유도로 rect 확인.
    expect(m.get(1)).toEqual(rectToQuad({ x: 0.15, y: 0.2, w: 0.05, h: 0.03 }));
    const br = quadBoundingRect(m.get(1)!);
    expect(br.x).toBeCloseTo(0.15);
    expect(br.y).toBeCloseTo(0.2);
    expect(br.w).toBeCloseTo(0.05);
    expect(br.h).toBeCloseTo(0.03);
  });

  it('두 슬롯 각각의 번호판 매칭', () => {
    const slots = [slot(1, 0.1, 0.1), slot(2, 0.6, 0.1)];
    const m = matchPlatesToSlots(slots, [plate(0.15, 0.2), plate(0.65, 0.2)]);
    expect(m.size).toBe(2);
    expect(quadBoundingRect(m.get(2)!).x).toBeCloseTo(0.65);
  });

  it('어느 ROI 에도 안 들면 매칭 없음', () => {
    const slots = [slot(1, 0.1, 0.1)];
    const m = matchPlatesToSlots(slots, [plate(0.9, 0.9)]);
    expect(m.size).toBe(0);
  });

  it('한 슬롯에 번호판 여럿이면 겹침 큰 것 유지', () => {
    const slots = [slot(1, 0.1, 0.1)];
    const small = plate(0.15, 0.2, 0.02, 0.02);
    const big = plate(0.15, 0.2, 0.1, 0.08);
    const m = matchPlatesToSlots(slots, [small, big]);
    expect(quadBoundingRect(m.get(1)!).w).toBeCloseTo(0.1);
  });
});
