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
  zoomForWidth,
  buildSlotPtzJson,
  aimPtzForPoint,
} from '../src/calibrate/controlMath.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { Ptz, SlotPtzItem } from '../src/calibrate/types.js';

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

describe('zoomForWidth (방안2 목표 zoom 직접산출·게인무관)', () => {
  const clamp = (z: number) => Math.min(36, Math.max(1, z));
  it('폭∝zoom 직접 목표: targetZoom = curZoom×targetWidth/curWidth', () => {
    // 실측 판폭 0.0274 @z1.69341 → 목표폭 0.2 는 z≈12.36, acquire 0.12 는 z≈7.42.
    expect(zoomForWidth(1.69341, 0.0274, 0.2, clamp)).toBeCloseTo(1.69341 * 0.2 / 0.0274, 4);
    expect(zoomForWidth(1.69341, 0.0274, 0.12, clamp)).toBeCloseTo(1.69341 * 0.12 / 0.0274, 4);
    // presetZoom=1·lpd 0.05 → acquire 0.12 = z 2.4, target 0.2 = z 4.0(PtzCalibrator 계획값).
    expect(zoomForWidth(1, 0.05, 0.12, clamp)).toBeCloseTo(2.4, 5);
    expect(zoomForWidth(1, 0.05, 0.2, clamp)).toBeCloseTo(4.0, 5);
  });
  it('curWidth≈0(퇴화) 가드 → clampZoom(curZoom)', () => {
    expect(zoomForWidth(3, 0, 0.2, clamp)).toBe(3);
    expect(zoomForWidth(3, 1e-5, 0.2, clamp)).toBe(3);
  });
  it('clamp 상한: 초소 lpd → 산출 zoom>36 → 36', () => {
    expect(zoomForWidth(1, 0.005, 0.2, clamp)).toBe(36); // 1×0.2/0.005=40 → 36.
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

/**
 * 검증자(qa-tester): aimPtzForPoint — 설계서 §1(a)·§2 테스트 계획 1번.
 * "정규화 지점을 화면중앙으로" 의 절대 pan/tilt 순수함수. pre-aim(선조준)과 클릭점 조준의 단일 출처.
 * 불변: zoom 은 base.zoom 그대로(개방루프 1샷·줌 미접촉), 게인 ∝ 1/zoom, 스텝 ±maxStepDeg 클램프.
 */
describe('aimPtzForPoint (클릭점 조준 기하, §1-a)', () => {
  // 실측 폴백 게인(cfg.fallbackGain*). ★음수 — panTiltCorrection 이 -err*gain 이라 최종 부호는 +err 방향.
  const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 1 };
  const base: Ptz = { pan: 10, tilt: 5, zoom: 1 };

  it('정중앙 클릭(0.5,0.5) → 델타 0(base 그대로), zoom 불변', () => {
    const a = aimPtzForPoint({ x: 0.5, y: 0.5 }, base, GAIN, 90);
    expect(a.pan).toBeCloseTo(base.pan, 10);
    expect(a.tilt).toBeCloseTo(base.tilt, 10);
    expect(a.zoom).toBe(base.zoom);
  });

  it('부호: 우하단 클릭 → pan↑·tilt↑ / 좌상단 클릭 → pan↓·tilt↓', () => {
    const rb = aimPtzForPoint({ x: 0.8, y: 0.9 }, base, GAIN, 90);
    expect(rb.pan).toBeGreaterThan(base.pan);
    expect(rb.tilt).toBeGreaterThan(base.tilt);
    const lt = aimPtzForPoint({ x: 0.2, y: 0.1 }, base, GAIN, 90);
    expect(lt.pan).toBeLessThan(base.pan);
    expect(lt.tilt).toBeLessThan(base.tilt);
  });

  it('수치: (0.8,0.9)@zoom1 → dPan=0.3*62=18.6, dTilt=0.4*35.5=14.2', () => {
    const a = aimPtzForPoint({ x: 0.8, y: 0.9 }, base, GAIN, 90);
    expect(a.pan).toBeCloseTo(10 + 18.6, 9);
    expect(a.tilt).toBeCloseTo(5 + 14.2, 9);
  });

  it('zoom 불변: base.zoom 이 무엇이든 반환 zoom 은 동일(줌 미접촉 — Goal 핵심 제약)', () => {
    for (const z of [1, 1.6934098, 2, 12, 36]) {
      const a = aimPtzForPoint({ x: 0.13, y: 0.77 }, { ...base, zoom: z }, GAIN, 90);
      expect(a.zoom).toBe(z);
    }
  });

  it('게인 ∝ 1/zoom: zoom 2배 → 동일 클릭의 pan/tilt 델타가 정확히 절반', () => {
    const p = { x: 0.8, y: 0.9 };
    const z1 = aimPtzForPoint(p, { pan: 0, tilt: 0, zoom: 1 }, GAIN, 90);
    const z2 = aimPtzForPoint(p, { pan: 0, tilt: 0, zoom: 2 }, GAIN, 90);
    expect(z2.pan).toBeCloseTo(z1.pan / 2, 9);
    expect(z2.tilt).toBeCloseTo(z1.tilt / 2, 9);
    // zoom 4배 → 1/4.
    const z4 = aimPtzForPoint(p, { pan: 0, tilt: 0, zoom: 4 }, GAIN, 90);
    expect(z4.pan).toBeCloseTo(z1.pan / 4, 9);
  });

  it('maxStep 클램프: 큰 오차라도 |Δ| ≤ maxStepDeg (양·음 양방향)', () => {
    const hi = aimPtzForPoint({ x: 1, y: 1 }, base, GAIN, 3);
    expect(hi.pan).toBeCloseTo(base.pan + 3, 9);
    expect(hi.tilt).toBeCloseTo(base.tilt + 3, 9);
    const lo = aimPtzForPoint({ x: 0, y: 0 }, base, GAIN, 3);
    expect(lo.pan).toBeCloseTo(base.pan - 3, 9);
    expect(lo.tilt).toBeCloseTo(base.tilt - 3, 9);
  });

  it('maxStep 미도달 구간은 클램프 무영향(선형 유지)', () => {
    const a = aimPtzForPoint({ x: 0.55, y: 0.55 }, base, GAIN, 90);
    expect(a.pan).toBeCloseTo(10 + 0.05 * 62, 9);
    expect(a.tilt).toBeCloseTo(5 + 0.05 * 35.5, 9);
  });
});
