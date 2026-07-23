import { describe, it, expect } from 'vitest';
import { okResult, failResult, limitResult, detectZoomStall, nextLadderZoom } from '../src/calibrate/platePtz.js';
import type { Ptz } from '../src/calibrate/types.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 구현자(developer): 리팩토링 §4.3 로 추출한 **순수 수치부·결과 빌더**의 계약 고정.
 * 이 테스트는 platePtz 상태기계를 돌리지 않는다 — 추출된 결정형 함수만 직접 호출한다.
 * 회귀 안전망의 본체는 platePtzRecapture/platePtzLadder/ptzCalibrator* 스위트이며(대표 경로 deep-equal),
 * 여기서는 그 스위트가 간접적으로만 밟는 경계값(stall 경계·bisection 수렴·선택필드 스프레드)을 직접 못박는다.
 */

const PTZ: Ptz = { pan: 1, tilt: 2, zoom: 3 };
const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 1 };
const ERR = { errX: 0.01, errY: -0.02 };
function plate(): PlateBox {
  return { quad: rectToQuad({ x: 0.4, y: 0.4, w: 0.2, h: 0.05 }), confidence: 0.9, cls: 'plate' };
}

// ══════════════════════════════════════════════════════════════════════════════
// A. okResult / failResult — 정직성 관용구(선택필드 스프레드 유/무)
// ══════════════════════════════════════════════════════════════════════════════
describe('A. okResult/failResult 빌더 — 선택필드 존재여부(deep-equal 보존)', () => {
  const core = { ptz: PTZ, plate: plate(), err: ERR, plateWidth: 0.2, gain: GAIN, iterations: 3 };

  it('okResult: extras 없으면 필수 7필드만 — 선택 필드 키 자체가 없다', () => {
    const r = okResult(core);
    expect(r).toEqual({ ok: true, ...core });
    expect('reason' in r).toBe(false);
    expect('recaptureDithers' in r).toBe(false);
    expect('restoredToBest' in r).toBe(false);
  });

  it('failResult: reason 이 항상 실린다', () => {
    const r = failResult('plate_lost', core);
    expect(r).toEqual({ ok: false, ...core, reason: 'plate_lost' });
  });

  it('dithers>0 일 때만 recaptureDithers 를 싣는다', () => {
    expect('recaptureDithers' in okResult(core, { dithers: 0 })).toBe(false);
    expect(okResult(core, { dithers: 2 }).recaptureDithers).toBe(2);
    // 인라인 생성과 완전히 동일한 객체여야 한다.
    expect(okResult(core, { dithers: 2 })).toEqual({ ok: true, ...core, recaptureDithers: 2 });
    expect(okResult(core, { dithers: 0 })).toEqual({ ok: true, ...core });
  });

  it('restoredToBest 는 truthy 일 때만 true 로 실린다(false/undefined → 키 없음)', () => {
    expect('restoredToBest' in failResult('max_iterations', core, { restoredToBest: false })).toBe(false);
    expect(failResult('max_iterations', core, { restoredToBest: true }).restoredToBest).toBe(true);
  });

  it('rest: 비균일 선택필드(recenterAttempts/widthShortfall/centerShortfall)는 존재여부 그대로 통과', () => {
    // 사다리 zoom_saturated 출구 재현: widthShortfall·recenterAttempts 는 값이 false/0 이어도 항상 실린다.
    const r = failResult('zoom_saturated', core, { rest: { widthShortfall: false, recenterAttempts: 0 } });
    expect(r.widthShortfall).toBe(false);
    expect(r.recenterAttempts).toBe(0);
    expect('widthShortfall' in r).toBe(true);
    expect('recenterAttempts' in r).toBe(true);
  });

  it('limitResult: ok 를 호출측이 정하고 reason 은 항상 공존한다(ok:true + reason 정직성 관용구)', () => {
    // 장비 한계에서 정렬 성공 → ok:true 인데 reason 도 남는다(폭 미달 사실).
    const okr = limitResult(true, 'zoom_saturated', core, { rest: { widthShortfall: true, recenterAttempts: 0 } });
    expect(okr.ok).toBe(true);
    expect(okr.reason).toBe('zoom_saturated');
    expect(okr.widthShortfall).toBe(true);
    // 정렬 실패 → ok:false + 같은 reason.
    const failr = limitResult(false, 'zoom_resolution_limit', core, { restoredToBest: true });
    expect(failr.ok).toBe(false);
    expect(failr.reason).toBe('zoom_resolution_limit');
    expect(failr.restoredToBest).toBe(true);
  });

  it('rest + dithers + restoredToBest 조합도 충돌 없이 병합된다', () => {
    const r = failResult('zoom_resolution_limit', core, {
      dithers: 1,
      restoredToBest: true,
      rest: { widthShortfall: true, recenterAttempts: 2 },
    });
    expect(r).toEqual({
      ok: false, ...core, reason: 'zoom_resolution_limit',
      widthShortfall: true, recenterAttempts: 2, recaptureDithers: 1, restoredToBest: true,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. detectZoomStall — 실측 zoom 정체 판정(경계)
// ══════════════════════════════════════════════════════════════════════════════
describe('B. detectZoomStall — 정체 경계·연속 요구·live 게이트', () => {
  // 상수(platePtz): LADDER_ZOOM_STALL_EPS=0.05, LADDER_ZOOM_STALL_LIMIT=2.
  it('첫 rung(prev 없음)은 판정하지 않고 상태를 그대로 돌려준다', () => {
    expect(detectZoomStall(null, null, 10, 8, false, 0)).toEqual({ actLive: false, stall: 0, stalled: false });
    expect(detectZoomStall(null, 8, 10, 9, true, 1)).toEqual({ actLive: true, stall: 1, stalled: false });
  });

  it('실측이 명령을 따라오면 actLive 가 켜지고, 그 rung 은 정체가 아니다(dAct 큼)', () => {
    // prevAct 5 → currAct 8 (dAct=3>eps) : 살아있음, stall 리셋.
    expect(detectZoomStall(5, 5, 8, 8, false, 1)).toEqual({ actLive: true, stall: 0, stalled: false });
  });

  it('actLive 확인 전에는 "명령↑·실측제자리"여도 stall 을 세지 않는다(시뮬 echo 오판 차단)', () => {
    // actLive=false 이고 dAct=0 → 아직 판정재료 무효라 stall 0 유지.
    expect(detectZoomStall(5, 5, 5, 8, false, 0)).toEqual({ actLive: false, stall: 0, stalled: false });
  });

  it('actLive 이후 "명령↑(dCmd>eps)·실측제자리(dAct≤eps)"가 연속 2회면 stalled', () => {
    const a = detectZoomStall(5, 5, 5.01, 8, true, 0); // dAct 0.01≤eps, dCmd 3>eps → stall 1
    expect(a).toEqual({ actLive: true, stall: 1, stalled: false });
    const b = detectZoomStall(5.01, 8, 5.02, 10, a.actLive, a.stall); // 또 제자리 → stall 2 = LIMIT
    expect(b).toEqual({ actLive: true, stall: 2, stalled: true });
  });

  it('중간에 실측이 다시 움직이면 stall 이 리셋된다', () => {
    const a = detectZoomStall(5, 5, 5.01, 8, true, 1); // stall 2? no: 1+1
    expect(a.stall).toBe(2);
    const b = detectZoomStall(5.01, 8, 6, 10, true, a.stall); // dAct 0.99>eps → 리셋
    expect(b).toEqual({ actLive: true, stall: 0, stalled: false });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. nextLadderZoom — 괄호 이분 수렴 / 미형성 외삽
// ══════════════════════════════════════════════════════════════════════════════
describe('C. nextLadderZoom — bisection/외삽 수치부', () => {
  const clamp = (z: number) => Math.min(36, Math.max(1, z));

  it('괄호 형성 시 중점 이분(maxZoomStepRatio 면제 — 넓은 괄호도 중점으로 점프)', () => {
    // zLo=16, zHi=36, zoom=16, ratio 1.3(클램프면 20.8 이 상한이나 이분은 26 으로 점프해야 한다).
    const r = nextLadderZoom(16, 16, 36, 0.15, 0.2, 1.3, clamp);
    expect(r.zNext).toBeCloseTo(26, 9);
    expect(r.bracketExhausted).toBe(false);
  });

  it('괄호가 LADDER_BRACKET_MIN_SPAN(0.01) 이하로 좁혀지면 bracketExhausted', () => {
    const r = nextLadderZoom(20, 20.0, 20.005, 0.19, 0.2, 1.3, clamp);
    expect(r.bracketExhausted).toBe(true);
  });

  it('괄호가 넓으면(span>MIN_SPAN) 중점 이분만 하고 소진하지 않는다', () => {
    const r = nextLadderZoom(1, 1, 1.02, 0.19, 0.2, 1.3, clamp);
    // 중점 1.01, span 0.02 > MIN_SPAN(0.01) 이고 |1.01-1|=0.01 > ZOOM_EPS 라 미소진.
    expect(r.bracketExhausted).toBe(false);
    expect(r.zNext).toBeCloseTo(1.01, 9);
  });

  it('괄호 미형성(한쪽만) → zoomForWidth 직행 목표를 maxZoomStepRatio 로 대칭 클램프(상승)', () => {
    // width 0.1 < target 0.2 → 더 확대. ratio 1.3 상한이 걸려 zoom*1.3 을 넘지 못한다.
    const r = nextLadderZoom(10, 10, null, 0.1, 0.2, 1.3, clamp);
    expect(r.bracketExhausted).toBe(false);
    expect(r.zNext).toBeLessThanOrEqual(10 * 1.3 + 1e-9);
    expect(r.zNext).toBeGreaterThan(10);
  });

  it('괄호 미형성 + 폭 초과(근거리) → 줌아웃 방향으로 대칭 클램프(하강 경로 보존)', () => {
    // width 0.4 > target 0.2 → 줄여야 한다. zoom/1.3 하한.
    const r = nextLadderZoom(10, null, 10, 0.4, 0.2, 1.3, clamp);
    expect(r.zNext).toBeGreaterThanOrEqual(10 / 1.3 - 1e-9);
    expect(r.zNext).toBeLessThan(10);
  });
});
