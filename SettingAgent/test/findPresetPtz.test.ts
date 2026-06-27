import { describe, it, expect } from 'vitest';
import { findPresetPtz } from '../web/core.js';

const cameras = [
  {
    camIdx: 1,
    presets: [
      { presetIdx: 1, pan: 151.9, tilt: 16.5, zoom: 1.7 },
      { presetIdx: 2, pan: 125.2, tilt: 12, zoom: 1.8 },
    ],
  },
  { camIdx: 2, presets: [{ presetIdx: 1, pan: 53.9, tilt: 14.5, zoom: 1.7 }] },
];

describe('findPresetPtz (프리셋 이동 근거 PTZ)', () => {
  it('일치 프리셋의 PTZ 반환', () => {
    expect(findPresetPtz(cameras, 1, 2)).toEqual({ pan: 125.2, tilt: 12, zoom: 1.8 });
    expect(findPresetPtz(cameras, 2, 1)).toEqual({ pan: 53.9, tilt: 14.5, zoom: 1.7 });
  });

  it('카메라/프리셋 없으면 null', () => {
    expect(findPresetPtz(cameras, 9, 1)).toBeNull();
    expect(findPresetPtz(cameras, 1, 9)).toBeNull();
    expect(findPresetPtz(undefined, 1, 1)).toBeNull();
  });

  it('PTZ 일부 누락(예: Hucoms 무PTZ)이면 null → 폴백 유도', () => {
    const noPtz = [{ camIdx: 1, presets: [{ presetIdx: 1, label: 'p1' }] }];
    expect(findPresetPtz(noPtz, 1, 1)).toBeNull();
  });

  it('0 값 PTZ 는 유효(null 아님)', () => {
    const zero = [{ camIdx: 1, presets: [{ presetIdx: 1, pan: 0, tilt: 0, zoom: 1 }] }];
    expect(findPresetPtz(zero, 1, 1)).toEqual({ pan: 0, tilt: 0, zoom: 1 });
  });
});
