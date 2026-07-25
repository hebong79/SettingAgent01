// 내장 프리셋 — 실기 Hucoms 실측표.
//
// ★ 이 숫자들은 새로 만든 것이 아니라 `unity/centering/src/calibration.mjs` 의 **운영 검증값을
//   그대로 이식**한 것이다(cam-001 / HNR-2036LA, 2026-07-14, 105샘플). 자릿수까지 동일해야 하며
//   test/presets.test.ts 가 황금값으로 고정한다. 여기를 손으로 고치면 그 테스트가 먼저 깨진다.
//
// ★ **다른 개체에 그냥 쓰면 위험하다.** k = f_펌웨어 / f_렌즈 에서 분자는 펌웨어에 박힌 상수라
//   같은 모델·펌웨어면 공통이지만, 분모는 개체차를 탄다. 그 개체의 오차가 여기 값의 절반보다
//   작으면 보정이 오히려 오차를 키운다. 새 카메라에는 반드시 **검증(verify)부터** 돌려라.

import type { DistortionPoint, GainPoint, HfovPoint } from './types.js';

export interface Preset {
  label: string;
  zoomHfov: HfovPoint[];
  centeringGain?: GainPoint[];
  /** 곡면율은 아직 어느 프리셋에도 없다 — 참조본이 미모델링으로 남긴 축이다(설계서 §3). */
  lensDistortion?: DistortionPoint[];
}

export const PRESETS: Record<string, Preset> = {
  'cam-001': {
    label: 'HNR-2036LA (cam-001 실측 2026-07-14)',
    // z≈16384 에서 광학이 포화하고, z15000→16384 에서 화각이 절반으로 꺾인다.
    // 그 밴드의 앵커가 촘촘한 이유 — 성글게 재면 보간이 절벽을 직선으로 뭉갠다.
    zoomHfov: [
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
    ],
    // ★ 단조가 아니다. 펌웨어의 줌→초점 모델이 z16384 부근에서 먼저 포화하는 반면 렌즈는 계속
    //   좁아지므로, 그 너머에서는 카메라가 자기가 더 넓게 본다고 믿고 **과회전**한다
    //   (z22000 에서 무보정 −33% 오버슈트 실측). 1.11 을 망원 끝까지 유지하는 표는 오차를 키운다.
    centeringGain: [
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
    ],
  },
};

/** 프리셋 조회. 없으면 등록된 목록과 함께 던진다(오타를 조용히 삼키지 않는다). */
export function getPreset(name: string): Preset {
  const p = PRESETS[name];
  if (!p) {
    throw new Error(`알 수 없는 프리셋 "${name}". 등록된 것: ${Object.keys(PRESETS).join(', ') || '(없음)'}`);
  }
  return p;
}

/** 새 기종을 재고 나면 프리셋으로 등록한다. */
export function registerPreset(name: string, preset: Preset): Preset {
  if (!preset?.zoomHfov?.length) throw new TypeError('프리셋에는 최소한 zoomHfov 가 있어야 합니다.');
  PRESETS[name] = preset;
  return preset;
}
