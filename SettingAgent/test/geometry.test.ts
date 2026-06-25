import { describe, it, expect } from 'vitest';
import { area, center, clamp01, clampRect, containsPoint, intersectionArea, iou, median, normalizeBox, pad } from '../src/domain/geometry.js';

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
