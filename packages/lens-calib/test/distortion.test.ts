import { describe, expect, it } from 'vitest';
import { LensDistortion, distortRadius, mapRadialPx, undistortRadius } from '../src/distortion.js';

const CX = 960;
const CY = 540;
const F = 1762.7; // cam-001 z0 (hfov 57.14°) 의 주변축 초점거리

describe('반경 변환', () => {
  it('k=0 이면 항등 — 표가 없을 때 기존 경로와 동일해야 한다', () => {
    expect(distortRadius(0.4, { k1: 0, k2: 0 })).toBe(0.4);
    expect(undistortRadius(0.4, { k1: 0, k2: 0 })).toBe(0.4);
    expect(mapRadialPx(1500, 800, CX, CY, F, { k1: 0, k2: 0 }, false)).toEqual({ x: 1500, y: 800, scale: 1 });
  });

  it('distort ∘ undistort = 항등 (라운드트립)', () => {
    const c = { k1: -0.085, k2: 0.012 };
    for (const rd of [0.05, 0.1, 0.2, 0.35, 0.5, 0.62]) {
      const ru = undistortRadius(rd, c);
      expect(distortRadius(ru, c)).toBeCloseTo(rd, 9);
    }
  });

  it('★배럴(k1<0)은 상을 안으로 수축시킨다', () => {
    const c = { k1: -0.085, k2: 0 };
    // distort(이상→실제): 실제 반경이 더 작다 = 가장자리가 안으로 들어온다
    expect(distortRadius(0.5, c)).toBeLessThan(0.5);
    // undistort(실제→이상): 다시 밖으로 펴진다
    expect(undistortRadius(0.5, c)).toBeGreaterThan(0.5);
  });

  it('핀쿠션(k1>0)은 반대 방향', () => {
    const c = { k1: 0.05, k2: 0 };
    expect(distortRadius(0.5, c)).toBeGreaterThan(0.5);
    expect(undistortRadius(0.5, c)).toBeLessThan(0.5);
  });

  it('중심점은 어떤 계수에서도 움직이지 않는다', () => {
    const m = mapRadialPx(CX, CY, CX, CY, F, { k1: -0.3, k2: 0.1 }, false);
    expect(m.x).toBe(CX);
    expect(m.y).toBe(CY);
  });

  it('방향을 보존한다 — 반경만 바꾼다', () => {
    const m = mapRadialPx(1500, 800, CX, CY, F, { k1: -0.085, k2: 0 }, false);
    const angleIn = Math.atan2(800 - CY, 1500 - CX);
    const angleOut = Math.atan2(m.y - CY, m.x - CX);
    expect(angleOut).toBeCloseTo(angleIn, 12);
  });

  it('★모델이 접히는(도함수≤0) 계수에서도 발산하지 않는다', () => {
    // 물리적 렌즈가 아닌 계수. 발산해서 조용히 엉뚱한 곳을 조준하느니 보정을 덜 하는 게 낫다.
    const c = { k1: -5, k2: 0 };
    const r = undistortRadius(0.9, c);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(0);
  });
});

describe('LensDistortion 표', () => {
  const d = new LensDistortion([
    { z: 0, k1: -0.085, k2: 0.012 },
    { z: 5129, k1: -0.02, k2: 0 },
    { z: 8000, k1: -0.008 },
  ]);

  it('앵커 사이를 보간하고 양끝은 클램프한다', () => {
    expect(d.coeffsAt(0).k1).toBeCloseTo(-0.085, 12);
    expect(d.coeffsAt(5129).k1).toBeCloseTo(-0.02, 12);
    expect(d.coeffsAt(99999).k1).toBeCloseTo(-0.008, 12); // 외삽 금지
    expect(d.coeffsAt(-100).k1).toBeCloseTo(-0.085, 12);
  });

  it('k2 미지정은 0 으로 채운다', () => {
    expect(d.coeffsAt(8000).k2).toBe(0);
  });

  it('maxShiftPx 는 코너 변위를 픽셀로 준다 — 채택 게이트가 읽는 숫자', () => {
    const shift = d.maxShiftPx({ zoom: 0, focal: F, cx: CX, cy: CY });
    expect(shift).toBeGreaterThan(4); // 눈에 보이는 크기
    expect(shift).toBeLessThan(200); // 그러나 터무니없지는 않다
  });

  it('전부 0 인 표는 hasAnyDistortion=false', () => {
    const zero = new LensDistortion([
      { z: 0, k1: 0, k2: 0 },
      { z: 8000, k1: 0, k2: 0 },
    ]);
    expect(zero.hasAnyDistortion).toBe(false);
    expect(zero.isIdentityAt(4000)).toBe(true);
  });

  it('toJSON 이 메타데이터(adopted/rms/n)를 잃지 않는다', () => {
    const withMeta = new LensDistortion([
      { z: 0, k1: -0.085, k2: 0.012, adopted: true, rms0Px: 6.8, rms1Px: 1.9, n: 58 },
      { z: 8000, k1: 0, k2: 0, adopted: false, reason: 'not_significant', n: 51 },
    ]);
    const json = withMeta.toJSON();
    expect(json[0]).toMatchObject({ adopted: true, rms0Px: 6.8, n: 58 });
    expect(json[1]).toMatchObject({ adopted: false, reason: 'not_significant' });
  });

  it('from(null) 은 null — 곡면율 모델 없음', () => {
    expect(LensDistortion.from(null)).toBeNull();
    expect(LensDistortion.from([])).toBeNull();
    expect(LensDistortion.from(d)).toBe(d);
  });
});
