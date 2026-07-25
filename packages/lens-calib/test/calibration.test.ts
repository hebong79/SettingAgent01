import { describe, expect, it } from 'vitest';
import { CameraCalibration } from '../src/calibration.js';
import { undistortRadius } from '../src/distortion.js';
import { TRUE_DISTORTION } from '../mock/mockCamera.js';

describe('CameraCalibration.from', () => {
  it('프리셋 이름을 해석한다', () => {
    const cal = CameraCalibration.from('cam-001');
    expect(cal.source).toBe('cam-001');
    expect(cal.hasGain).toBe(true);
    expect(cal.hfovAt(0)).toBeCloseTo(57.14, 6);
  });

  it('★null 은 "캘리브레이션 없음" — 보정 없이 조준한다', () => {
    const cal = CameraCalibration.from(null);
    expect(cal.source).toBe('none');
    expect(cal.hasGain).toBe(false);
    expect(cal.hasDistortion).toBe(false);
    expect(cal.gainAt(8000)).toBe(1);
    // 화각표는 그려야 하므로 기본 프리셋을 쓰지만, 조준은 건드리지 않는다.
    expect(cal.hfovAt(0)).toBeCloseTo(57.14, 6);
  });

  it('실측 객체는 프리셋을 상속하고 잰 것만 덮어쓴다', () => {
    const cal = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });
    expect(cal.hfovAt(0)).toBeCloseTo(57.14, 6); // 상속
    expect(cal.hasDistortion).toBe(true); // 덮어쓴 것
    expect(cal.source).toBe('measured');
  });

  it('구버전 모양(게인 배열 하나)도 받는다', () => {
    const cal = CameraCalibration.from([
      { z: 0, k: 1.0 },
      { z: 8000, k: 1.2 },
    ]);
    expect(cal.gainAt(8000)).toBeCloseTo(1.2, 6);
  });

  it('toJSON 을 그대로 from 에 되먹일 수 있다', () => {
    const a = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });
    const b = CameraCalibration.from(a.toJSON());
    expect(b.hfovAt(5129)).toBeCloseTo(a.hfovAt(5129), 2);
    expect(b.gainAt(5129)).toBeCloseTo(a.gainAt(5129), 3);
    expect(b.distortion!.coeffsAt(5129).k1).toBeCloseTo(a.distortion!.coeffsAt(5129).k1, 5);
  });
});

describe('aim() — 조준 3단', () => {
  const base = CameraCalibration.from('cam-001');

  it('★곡면율 표가 없으면 참조본 식과 비트 단위로 같다 (회귀 고정)', () => {
    // 참조본: ax = cx + (x-cx)*k, ay = cy + (y-cy)*k, 반올림 후 클램프.
    for (const zoom of [0, 3000, 8000, 12161, 16384, 22000]) {
      for (const [x, y] of [
        [1440, 300],
        [200, 900],
        [960, 540],
        [1900, 1070],
      ] as const) {
        const k = base.gainAt(zoom);
        const expectX = clamp(Math.round(960 + (x - 960) * k), 0, 1920);
        const expectY = clamp(Math.round(540 + (y - 540) * k), 0, 1080);
        const got = base.aim({ x, y, zoom });
        expect(got.x).toBe(expectX);
        expect(got.y).toBe(expectY);
        expect(got.undistortScale).toBe(1);
      }
    }
  });

  it('★순서가 undistort → ×k 다 (반대로 하면 답이 달라진다)', () => {
    const cal = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });
    const zoom = 0;
    const x = 1700;
    const y = 540;

    const f = cal.focalAt(zoom);
    const k = cal.gainAt(zoom);
    const c = cal.distortion!.coeffsAt(zoom);

    // 올바른 순서: 펴고 나서 민다
    const correct = 960 + undistortRadius((x - 960) / f, c) * f * k;
    // 틀린 순서: 밀고 나서 편다
    const wrong = 960 + undistortRadius(((x - 960) * k) / f, c) * f;

    expect(cal.aim({ x, y, zoom }).x).toBe(Math.round(correct));
    // 두 순서는 수학적으로 다른 답을 낸다(차이 = k1·k·r³·(k²−1)).
    expect(Math.abs(correct - wrong)).toBeGreaterThan(1e-6);

    // ★ 다만 크기를 정직하게 말해 둔다: cam-001 의 z0 게인은 0.988(≈1)이라 이 줌에서 차이는
    //   1px 미만이다. 게인이 1 에서 멀어질수록 커진다 — 순서가 중요해지는 것은 그 지점이다.
    expect(Math.abs(correct - wrong)).toBeLessThan(1);
    const strongGain = CameraCalibration.from({ zoomHfov: cal.toJSON().zoomHfov, centeringGain: [{ z: 0, k: 1.3 }], lensDistortion: TRUE_DISTORTION });
    const c2 = strongGain.distortion!.coeffsAt(0);
    const f2 = strongGain.focalAt(0);
    const correct2 = 960 + undistortRadius((x - 960) / f2, c2) * f2 * 1.3;
    const wrong2 = 960 + undistortRadius(((x - 960) * 1.3) / f2, c2) * f2;
    expect(Math.abs(correct2 - wrong2)).toBeGreaterThan(5); // 픽셀로 눈에 보인다
  });

  it('배럴이면 곡면율이 편심을 **더 밀어낸다**(undistortScale > 1)', () => {
    const cal = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });
    const a = cal.aim({ x: 1800, y: 900, zoom: 0 });
    expect(a.undistortScale).toBeGreaterThan(1);
    expect(cal.aim({ x: 1000, y: 560, zoom: 0 }).undistortScale).toBeLessThan(a.undistortScale); // 중심 근처는 거의 1
  });

  it('프레임을 벗어나면 clamped:true 로 알린다 — 부분 보정임을 숨기지 않는다', () => {
    const a = base.aim({ x: 1910, y: 540, zoom: 8000 });
    expect(a.clamped).toBe(true);
    expect(a.x).toBe(1920);
  });

  it('중심 클릭은 어떤 표에서도 중심으로 나간다', () => {
    const cal = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });
    expect(cal.aim({ x: 960, y: 540, zoom: 0 })).toMatchObject({ x: 960, y: 540, clamped: false });
  });
});

describe('진단값', () => {
  const cal = CameraCalibration.from({ model: 'cam-001', lensDistortion: TRUE_DISTORTION });

  it('★배럴이면 실제 가장자리 화각이 주변축 화각보다 넓다', () => {
    expect(cal.hfovEdgeAt(0)).toBeGreaterThan(cal.hfovAt(0));
  });

  it('곡면율이 없으면 두 화각이 같다', () => {
    const plain = CameraCalibration.from('cam-001');
    expect(plain.hfovEdgeAt(0)).toBeCloseTo(plain.hfovAt(0), 10);
    expect(plain.distortionShiftPx(0)).toBe(0);
  });

  it('vfov 비율은 일정하지 않다 (tan 렌즈의 성질)', () => {
    const wide = cal.vfovAt(0) / cal.hfovAt(0);
    const tele = cal.vfovAt(12161) / cal.hfovAt(12161);
    expect(wide).not.toBeCloseTo(tele, 3);
  });

  it('describe 는 세 표의 상태를 한 줄로 말한다', () => {
    expect(cal.describe()).toMatch(/화각/);
    expect(cal.describe()).toMatch(/게인/);
    expect(cal.describe()).toMatch(/곡면율/);
    expect(CameraCalibration.from(null).describe()).toMatch(/곡면율 없음/);
  });
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
