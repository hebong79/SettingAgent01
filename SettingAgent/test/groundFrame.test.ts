import { describe, it, expect } from 'vitest';
import { groundFrameOf, groundPointOf, groundCoordsOf } from '../src/ground/groundFrame.js';
import { slotBearingDeg } from '../src/ground/groundModel.js';
import { dot3 } from '../src/ground/project.js';
import type { GroundModel } from '../src/ground/types.js';
import type { Vec3 } from '../src/ground/contactTypes.js';

/**
 * L3 Loop 2-1 — 프리셋 불변 지면 2D 좌표계.
 * 검증: 왕복 항등 / 직교정규 기저 / 퇴화 null / slotBearingDeg 와의 역관계.
 */

const DEG = Math.PI / 180;

function model(tiltDeg: number, d = 5): GroundModel {
  const t = tiltDeg * DEG;
  return {
    camIdx: 1, presetIdx: 1, imgW: 1920, imgH: 1080, zoom: 1, f: 1500,
    n: [0, Math.cos(t), Math.sin(t)], d,
    tiltDeg, ptzTiltDeg: tiltDeg, tiltErrDeg: 0, slotBearingDeg: null, bearingDevDeg: null, dDevRel: null,
    depthEdgePx: 500, metricErr: 0, conf: 1, source: 'file', issues: [],
  };
}

describe('groundFrameOf', () => {
  it('왕복 항등: groundCoordsOf(groundPointOf(a,b)) === (a,b)', () => {
    for (const tilt of [5, 20, 45, 80]) {
      for (const pan of [-170, 0, 19.8, 90.1, 180]) {
        const fr = groundFrameOf(model(tilt), pan)!;
        expect(fr).toBeTruthy();
        for (const [a, b] of [[0, 0], [3.7, -12.25], [-100.5, 40]]) {
          const rt = groundCoordsOf(fr, groundPointOf(fr, a, b));
          expect(Math.abs(rt.a - a)).toBeLessThan(1e-9);
          expect(Math.abs(rt.b - b)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('기저는 직교정규이고 지면 위(법선과 수직)에 있다', () => {
    const g = model(20);
    const fr = groundFrameOf(g, 41.5)!;
    expect(Math.abs(dot3(fr.e1, fr.e2))).toBeLessThan(1e-12);
    expect(Math.abs(Math.hypot(...fr.e1) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(Math.hypot(...fr.e2) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(dot3(fr.e1, g.n as Vec3))).toBeLessThan(1e-12);
    expect(Math.abs(dot3(fr.e2, g.n as Vec3))).toBeLessThan(1e-12);
  });

  it('원점은 나딜(d·n) — 평면 위이고 카메라에서 d 만큼 떨어져 있다', () => {
    const g = model(35.8, 4.95);
    const fr = groundFrameOf(g, 90.1)!;
    expect(Math.abs(dot3(fr.origin, g.n as Vec3) - g.d)).toBeLessThan(1e-12);
    expect(Math.abs(Math.hypot(...fr.origin) - g.d)).toBeLessThan(1e-12);
  });

  it('★ slotBearingDeg 의 역: e1 은 bearing 0°, e2 는 bearing 90° 방향', () => {
    for (const pan of [0, 19.8, 41.5, 90.1]) {
      const g = model(20);
      const fr = groundFrameOf(g, pan)!;
      // slotBearingDeg 는 mod 90 이므로 0/90 은 둘 다 0 으로 접힌다.
      expect(slotBearingDeg(g.n, fr.e1, pan)!).toBeCloseTo(0, 8);
      expect(slotBearingDeg(g.n, fr.e2, pan)!).toBeCloseTo(0, 8);
      // mod 90 이전 값 대조: e2 는 e1 을 지면에서 정확히 90° 돌린 방향.
      expect(Math.abs(dot3(fr.e1, fr.e2))).toBeLessThan(1e-12);
    }
  });

  // ※ '프리셋 간 실제 이식' 은 합성 모델로는 증명할 수 없다(같은 나딜·같은 세계를 가정해야 하므로 순환).
  //    실증은 실데이터로만 가능하며 test/groundGrid.test.ts 의 "프리셋 불변 프레임 실증" 이 담당한다.

  it('퇴화 → null (throw 금지)', () => {
    expect(groundFrameOf(model(20), null)).toBeNull();
    expect(groundFrameOf(model(20), Number.NaN)).toBeNull();
    expect(groundFrameOf({ ...model(20), d: 0 }, 0)).toBeNull();
    // 수직 하방(n = z) → 지면 전방 정의 불가.
    expect(groundFrameOf({ ...model(20), n: [0, 0, 1] }, 0)).toBeNull();
    expect(groundFrameOf({ ...model(20), n: [0, 0, 0] }, 0)).toBeNull();
  });
});
