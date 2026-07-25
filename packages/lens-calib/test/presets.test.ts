import { describe, expect, it } from 'vitest';
import { getPreset, PRESETS, registerPreset } from '../src/presets.js';
import { CameraCalibration } from '../src/calibration.js';

// ★ 황금값 테스트.
//   이 숫자들은 `unity/centering/src/calibration.mjs` 의 실기 검증 운영값(cam-001 / HNR-2036LA,
//   2026-07-14, 105샘플)을 **이식**한 것이다. 손으로 고치면 여기가 먼저 깨져야 한다 —
//   재측정 없이 표가 바뀌는 것을 막는 것이 이 테스트의 유일한 목적이다.

describe('PRESETS cam-001 (참조본 이식 황금값)', () => {
  const p = getPreset('cam-001');

  it('화각 앵커 13점이 참조본과 자릿수까지 같다', () => {
    expect(p.zoomHfov).toEqual([
      { z: 0, h: 57.14 },
      { z: 2000, h: 47.89 },
      { z: 3000, h: 43.37 },
      { z: 5129, h: 34.05 },
      { z: 8000, h: 22.59 },
      { z: 10338, h: 14.68 },
      { z: 12161, h: 9.77 },
      { z: 14000, h: 6.29 },
      { z: 15000, h: 4.88 },
      { z: 15400, h: 4.32 },
      { z: 15800, h: 3.74 },
      { z: 16100, h: 3.16 },
      { z: 16384, h: 2.39 },
    ]);
  });

  it('게인 앵커 14점이 참조본과 자릿수까지 같다', () => {
    expect(p.centeringGain).toEqual([
      { z: 0, k: 0.988 },
      { z: 2000, k: 1.053 },
      { z: 3000, k: 1.071 },
      { z: 5129, k: 1.09 },
      { z: 8000, k: 1.11 },
      { z: 10338, k: 1.111 },
      { z: 12161, k: 1.113 },
      { z: 14000, k: 1.11 },
      { z: 15000, k: 1.106 },
      { z: 15400, k: 1.075 },
      { z: 15800, k: 1.05 },
      { z: 16100, k: 0.935 },
      { z: 16384, k: 0.765 },
      { z: 22000, k: 0.75 },
    ]);
  });

  it('★게인은 단조가 아니다 — 망원 끝에서 부호가 뒤집힌다', () => {
    const cal = CameraCalibration.from('cam-001');
    // 중간 대역은 언더슈트(k>1: 덜 도니까 더 밀어준다)
    expect(cal.gainAt(12161)).toBeGreaterThan(1.1);
    // z16384 너머는 오버슈트(k<1: 과회전하니까 덜 민다). 1.11 을 끝까지 유지하는 표는 오차를 키운다.
    expect(cal.gainAt(16384)).toBeLessThan(0.8);
    expect(cal.gainAt(22000)).toBeLessThan(0.8);
  });

  it('곡면율은 아직 어느 프리셋에도 없다(참조본이 미모델링으로 남긴 축)', () => {
    expect(p.lensDistortion).toBeUndefined();
    expect(CameraCalibration.from('cam-001').hasDistortion).toBe(false);
  });

  it('알 수 없는 프리셋은 등록 목록과 함께 던진다', () => {
    expect(() => getPreset('없는기종')).toThrow(/등록된 것/);
  });

  it('registerPreset 은 zoomHfov 없는 프리셋을 거부한다', () => {
    expect(() => registerPreset('bad', { label: 'x', zoomHfov: [] })).toThrow();
    expect(PRESETS.bad).toBeUndefined();
  });
});
