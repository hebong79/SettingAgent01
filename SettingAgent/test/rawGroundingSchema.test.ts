import { describe, it, expect } from 'vitest';
import { FloorRoiRawSchema, OccupancyRawSchema, OccupancyRawSpaceSchema } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): Qwen2.5-VL 절대픽셀 RAW 스키마 파싱 (설계 §3-2, 성공기준 4).
 * FloorRoiRawSchema/OccupancyRawSchema 가 픽셀 points_2d/bbox_2d 를 파싱하고,
 * 4점 아님·둘 다 부재를 거부(graceful → chatJson 재시도 → null → 결정형 폴백)한다.
 */

describe('FloorRoiRawSchema (절대픽셀 4점/bbox)', () => {
  const pts4: [number, number][] = [
    [258, 655],
    [1030, 655],
    [966, 510],
    [322, 510],
  ];

  it('points_2d 4점(픽셀) 파싱 + confidence default 0', () => {
    const r = FloorRoiRawSchema.parse({ points_2d: pts4 });
    expect(r.points_2d).toEqual(pts4);
    expect(r.confidence).toBe(0); // 생략 시 default 0
  });

  it('bbox_2d(축정렬 [x1,y1,x2,y2]) 파싱', () => {
    const r = FloorRoiRawSchema.parse({ bbox_2d: [0, 0, 644, 364], confidence: 0.4 });
    expect(r.bbox_2d).toEqual([0, 0, 644, 364]);
    expect(r.confidence).toBeCloseTo(0.4);
  });

  it('points_2d 3점 거부(.length(4))', () => {
    expect(() => FloorRoiRawSchema.parse({ points_2d: pts4.slice(0, 3) })).toThrow();
  });

  it('points_2d 5점 거부(.length(4))', () => {
    expect(() => FloorRoiRawSchema.parse({ points_2d: [...pts4, [1, 1]] })).toThrow();
  });

  it('points_2d/bbox_2d 둘 다 부재 → refine 거부', () => {
    expect(() => FloorRoiRawSchema.parse({ confidence: 0.9 })).toThrow();
  });

  it('bbox_2d 3원소 거부(tuple 길이)', () => {
    expect(() => FloorRoiRawSchema.parse({ bbox_2d: [0, 0, 644] })).toThrow();
  });
});

describe('OccupancyRawSchema (면별 픽셀 4점 · graceful)', () => {
  const pts4: [number, number][] = [
    [95, 266],
    [286, 266],
    [286, 186],
    [95, 186],
  ];

  it('spaces 픽셀 points_2d 파싱', () => {
    const r = OccupancyRawSchema.parse({
      spaces: [{ id: 1, occupied: true, points_2d: pts4 }],
      confidence: 0.6,
    });
    expect(r.spaces[0].points_2d).toEqual(pts4);
    expect(r.spaces[0].occupied).toBe(true);
  });

  it('points_2d/bbox_2d 미보유 면도 통과(refine 없음 → graceful)', () => {
    const r = OccupancyRawSchema.parse({ spaces: [{ id: 2, occupied: false }] });
    expect(r.spaces[0].points_2d).toBeUndefined();
    expect(r.spaces[0].bbox_2d).toBeUndefined();
    expect(r.spaces[0].occupied).toBe(false);
  });

  it('빈 spaces → default []', () => {
    const r = OccupancyRawSchema.parse({ confidence: 0.1 });
    expect(r.spaces).toEqual([]);
  });

  it('면별 points_2d 4점 아님 거부(.length(4))', () => {
    expect(() => OccupancyRawSpaceSchema.parse({ id: 1, occupied: true, points_2d: pts4.slice(0, 2) })).toThrow();
  });

  it('occupied 누락 거부(필수)', () => {
    expect(() => OccupancyRawSpaceSchema.parse({ id: 1, points_2d: pts4 })).toThrow();
  });

  it('id 누락 거부(필수 int)', () => {
    expect(() => OccupancyRawSpaceSchema.parse({ occupied: true, points_2d: pts4 })).toThrow();
  });
});
