import { describe, it, expect } from 'vitest';
import {
  plateCenterError,
  pickNearestPlate,
  estimateGain,
  panTiltCorrection,
  zoomCorrection,
  isCentered,
  isWidthConverged,
  dampGain,
  buildSlotPtzJson,
} from '../src/calibrate/controlMath.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { SlotPtzItem } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): 캘리브레이션 제어 수학(순수, 외부 의존 0).
 * 부호 포함 게인 추정·P 제어 클램프·zoom 공식·수렴 판정·JSON 조립.
 */

const plate = (x: number, y: number, w = 0.05, h = 0.03): PlateBox => ({ quad: rectToQuad({ x, y, w, h }), confidence: 0.9, cls: 'plate' });

describe('plateCenterError', () => {
  it('정중앙 번호판 → 오차 0', () => {
    const e = plateCenterError({ x: 0.475, y: 0.485, w: 0.05, h: 0.03 });
    expect(e.errX).toBeCloseTo(0);
    expect(e.errY).toBeCloseTo(0);
  });
  it('우하단 → errX·errY 양수', () => {
    const e = plateCenterError({ x: 0.7, y: 0.8, w: 0.05, h: 0.03 });
    expect(e.errX).toBeGreaterThan(0);
    expect(e.errY).toBeGreaterThan(0);
  });
});

describe('pickNearestPlate', () => {
  const target = { x: 0.5, y: 0.5, w: 0.05, h: 0.03 };
  it('다수 중 prior 중심 최근접 선택', () => {
    const got = pickNearestPlate([plate(0.1, 0.1), plate(0.49, 0.49), plate(0.9, 0.9)], target);
    // PlateBox 는 quad 만 보유 → boundingRect 유도로 위치 확인(경계면: quad→rect).
    expect(quadBoundingRect(got!.quad).x).toBeCloseTo(0.49);
  });
  it('빈 배열 → null', () => {
    expect(pickNearestPlate([], target)).toBeNull();
  });
});

describe('estimateGain', () => {
  const fb = { gainPan: 20, gainTilt: 15 };
  it('probe 전후 변위 → 부호 포함 게인', () => {
    // pan +2° 명령 시 errX 가 +0.1 변함 → gainPan = 2/0.1 = 20(양수)
    const g = estimateGain({ errX: 0.0, errY: 0.0 }, { errX: 0.1, errY: -0.05 }, { dPan: 2, dTilt: 1 }, fb);
    expect(g.gainPan).toBeCloseTo(20);
    expect(g.gainTilt).toBeCloseTo(-20); // tilt +1° 에 errY -0.05 → 1/-0.05 = -20(부호 반영)
  });
  it('변위 미미(분모≈0) → fallback 게인', () => {
    const g = estimateGain({ errX: 0.1, errY: 0.1 }, { errX: 0.1, errY: 0.1 }, { dPan: 1, dTilt: 1 }, fb);
    expect(g.gainPan).toBe(20);
    expect(g.gainTilt).toBe(15);
  });
});

describe('panTiltCorrection', () => {
  const gain = { gainPan: 20, gainTilt: 20 };
  it('작은 오차 → 비례 보정(클램프 미발동, newPan=cur-errX*gain)', () => {
    const r = panTiltCorrection({ errX: 0.1, errY: -0.1 }, gain, 10, 5, 5);
    expect(r.pan).toBeCloseTo(10 - 2); // -(0.1*20)=-2
    expect(r.tilt).toBeCloseTo(5 + 2); // -(-0.1*20)=+2
  });
  it('큰 오차 → maxStepDeg 클램프', () => {
    const r = panTiltCorrection({ errX: 0.5, errY: -0.5 }, gain, 0, 0, 5);
    expect(r.pan).toBe(-5); // -(0.5*20)=-10 → -5 로 클램프
    expect(r.tilt).toBe(5);
  });
});

describe('zoomCorrection', () => {
  const clamp = (z: number) => Math.min(36, Math.max(1, z));
  it('폭이 목표보다 크면 축소', () => {
    expect(zoomCorrection(10, 0.4, 0.2, clamp)).toBeLessThan(10);
  });
  it('폭이 목표보다 작으면 확대', () => {
    expect(zoomCorrection(10, 0.1, 0.2, clamp)).toBeGreaterThan(10);
  });
  it('clamp 1~36 적용', () => {
    expect(zoomCorrection(30, 0.001, 0.2, clamp)).toBe(36);
    expect(zoomCorrection(36, 0.9, 0.0005, clamp)).toBe(1);
  });
  it('plateWidth≈0 방어 → 현재 zoom 클램프 반환', () => {
    expect(zoomCorrection(8, 0, 0.2, clamp)).toBe(8);
  });
});

describe('isCentered / isWidthConverged 경계', () => {
  it('isCentered 경계(=tol 포함)', () => {
    expect(isCentered({ errX: 0.03, errY: -0.03 }, 0.03)).toBe(true);
    expect(isCentered({ errX: 0.031, errY: 0 }, 0.03)).toBe(false);
  });
  it('isWidthConverged 경계', () => {
    expect(isWidthConverged(0.185, 0.2, 0.02)).toBe(true);
    expect(isWidthConverged(0.17, 0.2, 0.02)).toBe(false);
  });
});

describe('dampGain', () => {
  it('기본 절반 감쇠', () => {
    expect(dampGain({ gainPan: 20, gainTilt: 10 })).toEqual({ gainPan: 10, gainTilt: 5 });
  });
});

describe('buildSlotPtzJson', () => {
  it('스키마 조립(createdAt·items 그대로)', () => {
    const items: SlotPtzItem[] = [
      { camIdx: 1, presetIdx: 1, slotId: 'c1p1s1', globalIdx: 1, ptz: { pan: 1, tilt: 2, zoom: 3 }, plateWidth: 0.2, centered: true, converged: true },
    ];
    const a = buildSlotPtzJson(items, '2026-06-30T00:00:00Z');
    expect(a.createdAt).toBe('2026-06-30T00:00:00Z');
    expect(a.items).toHaveLength(1);
    expect(a.items[0].slotId).toBe('c1p1s1');
  });
});
