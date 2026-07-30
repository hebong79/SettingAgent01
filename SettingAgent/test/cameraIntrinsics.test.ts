// 3회차 — 제원 주입 경로(cameraIntrinsics · placeMetaIntrinsics · bayGrid) 유닛테스트.
//
// 핵심 봉인: 제원 로더가 **주차면을 읽지 않는다**(hold-out 구조 봉인 — 타입에 담을 필드가 없다).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  chainProviders,
  focalPxOf,
  groundModelFromIntrinsics,
  interpolateHfov,
  lensCalibrationProvider,
  staticProvider,
  type PresetIntrinsics,
} from '../src/ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../src/ground/placeMetaIntrinsics.js';
import { rowFrameFromLine, widthCoordOf } from '../src/ground/bayGrid.js';
import { backprojectToGround, projectToPixel } from '../src/ground/project.js';
import { lineThrough } from '../src/ground/floorPaint.js';

const SIM: PresetIntrinsics = {
  camIdx: 1,
  presetIdx: 1,
  fovDeg: 20.86546,
  fovAxis: 'vertical',
  tiltDeg: 8.7,
  heightM: 5,
  imgW: 1920,
  imgH: 1080,
  source: 'test',
};

describe('cameraIntrinsics — 화각 → f', () => {
  it('수직 화각은 imgH 로 환산한다(리더 예측 2932.8px 와 일치)', () => {
    expect(focalPxOf(SIM)!).toBeCloseTo(2932.8, 0);
  });

  it('수평 화각은 imgW 로 환산한다', () => {
    const f = focalPxOf({ ...SIM, fovAxis: 'horizontal', fovDeg: 57.66 })!;
    expect(f).toBeCloseTo(1920 / 2 / Math.tan((57.66 * Math.PI) / 360), 6);
  });

  it('비정상 화각은 null(throw 금지)', () => {
    expect(focalPxOf({ ...SIM, fovDeg: 0 })).toBeNull();
    expect(focalPxOf({ ...SIM, fovDeg: 180 })).toBeNull();
    expect(focalPxOf({ ...SIM, imgH: 0 })).toBeNull();
  });
});

describe('cameraIntrinsics — 지면모델 조립', () => {
  it('n = [0, cos t, +sin t] 이고 d = 설치고다', () => {
    const g = groundModelFromIntrinsics(SIM, 1.7)!;
    expect(g.n[0]).toBe(0);
    expect(g.n[1]).toBeCloseTo(Math.cos((8.7 * Math.PI) / 180), 9);
    expect(g.n[2]).toBeCloseTo(Math.sin((8.7 * Math.PI) / 180), 9);
    expect(g.d).toBe(5);
    expect(g.source).toBe('auto');
    expect(g.issues.join(' ')).toContain('지면모델 주입');
  });

  it('법선 부호가 맞으면 화면 아래쪽이 지면으로 역투영된다', () => {
    const g = groundModelFromIntrinsics(SIM, 1)!;
    const X = backprojectToGround({ x: 960, y: 900 }, g)!;
    expect(X).not.toBeNull();
    expect(X[2]).toBeGreaterThan(0); // 카메라 앞
    const back = projectToPixel(X, g)!;
    expect(back.x).toBeCloseTo(960, 6);
    expect(back.y).toBeCloseTo(900, 6);
  });

  it('상향/수평 시선(tilt ≤ 0)은 null — 지면을 만나지 않는다', () => {
    expect(groundModelFromIntrinsics({ ...SIM, tiltDeg: 0 }, 1)).toBeNull();
    expect(groundModelFromIntrinsics({ ...SIM, tiltDeg: -5 }, 1)).toBeNull();
  });

  it('설치고가 0 이하면 null', () => {
    expect(groundModelFromIntrinsics({ ...SIM, heightM: 0 }, 1)).toBeNull();
  });

  it('먼 지면점일수록 화면 위쪽에 맺힌다(깊이 방향 부호 검산)', () => {
    const g = groundModelFromIntrinsics(SIM, 1)!;
    const near = backprojectToGround({ x: 960, y: 900 }, g)!;
    const far = backprojectToGround({ x: 960, y: 700 }, g)!;
    expect(far[2]).toBeGreaterThan(near[2]);
  });
});

describe('placeMetaIntrinsics — ★ 주차면을 읽지 않는다(hold-out 구조 봉인)', () => {
  const raw = {
    cameras: [
      {
        camera: { cam_id: 1, position: [-9.5, 5, -7.1], eulerAngles: [35.8, 90.1, 0], fov: 34.63484, imageWidth: 1920, imageHeight: 1080 },
        presets: [
          { preset_idx: 1, pan: 19.8, tilt: 8.7, zoom: 1.69341, eulerAngles: [8.7, 19.8, 0], fov: 20.86546, parking_spaces: [{ idx: 1, points: [[1, 2]] }] },
          { preset_idx: 2, parking_spaces: [{ idx: 2, points: [[3, 4]] }] },
        ],
      },
    ],
  };

  it('반환 구조 어디에도 주차면 좌표가 없다', () => {
    const meta = readPlaceMeta(raw);
    const dump = JSON.stringify(meta);
    expect(dump).not.toContain('parking_spaces');
    expect(dump).not.toContain('points');
    expect(dump).not.toContain('idx');
  });

  it('메타 전용 타입에는 주차면을 담을 필드가 없다(정적 봉인)', () => {
    const src = readFileSync('src/ground/placeMetaIntrinsics.ts', 'utf8');
    // 주차면 배열을 읽거나 복사하는 코드가 있으면 안 된다(주석의 언급은 허용).
    const code = src
      .split('\n')
      .filter((ln) => !ln.trim().startsWith('//') && !ln.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toContain('parking_spaces');
    expect(code).not.toContain('PlaceRoiSpace');
    expect(code).not.toContain('normalizePtzCamRoi');
  });

  it('프리셋 fov 를 우선하고 없으면 카메라 fov 로 폴백하며 출처를 남긴다', () => {
    const p = placeMetaProvider(readPlaceMeta(raw));
    const a = p.get(1, 1)!;
    expect(a.fovDeg).toBeCloseTo(20.86546, 5);
    expect(a.tiltDeg).toBeCloseTo(8.7, 5);
    expect(a.heightM).toBe(5);
    expect(a.source).toContain('preset');
    const b = p.get(1, 2)!;
    expect(b.fovDeg).toBeCloseTo(34.63484, 5);
    expect(b.source).toContain('camera');
  });

  it('없는 카메라·프리셋은 null', () => {
    const p = placeMetaProvider(readPlaceMeta(raw));
    expect(p.get(9, 1)).toBeNull();
    expect(p.get(1, 9)).toBeNull();
  });

  it('malformed 입력도 throw 하지 않고 issues 로 강등한다', () => {
    expect(readPlaceMeta(null).issues.length).toBeGreaterThan(0);
    expect(readPlaceMeta({ cameras: [{ camera: {} }] }).cameras).toEqual([]);
  });

  it('실제 정본에서 5개 프리셋 제원이 전부 나온다(읽기 전용)', () => {
    const p = placeMetaProvider(readPlaceMeta(JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'))));
    for (const [c, k] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]] as Array<[number, number]>) {
      const i = p.get(c, k);
      expect(i, `cam${c}:preset${k}`).not.toBeNull();
      expect(groundModelFromIntrinsics(i!, 1), `cam${c}:preset${k} 모델`).not.toBeNull();
    }
  });
});

describe('cameraIntrinsics — 실카 공급자(R10: 시뮬 전용 경로 금지)', () => {
  const table = [{ z: 0, h: 57.66 }, { z: 2000, h: 47.98 }, { z: 3000, h: 43.54 }];

  it('zoomHfov 를 선형보간하고 표 밖은 클램프한다', () => {
    expect(interpolateHfov(table, 0)).toBeCloseTo(57.66, 6);
    expect(interpolateHfov(table, 1000)).toBeCloseTo((57.66 + 47.98) / 2, 6);
    expect(interpolateHfov(table, 2500)).toBeCloseTo((47.98 + 43.54) / 2, 6);
    expect(interpolateHfov(table, -5)).toBeCloseTo(57.66, 6);
    expect(interpolateHfov(table, 99999)).toBeCloseTo(43.54, 6);
    expect(interpolateHfov([], 100)).toBeNull();
  });

  it('실카 공급자는 시뮬과 **같은 인터페이스**를 만족한다', () => {
    const real = lensCalibrationProvider({
      zoomHfov: table,
      states: [{ camIdx: 1, presetIdx: 1, zoomRaw: 1000, tiltDeg: 12 }],
      heightM: 4.8,
      imgW: 1920,
      imgH: 1080,
    });
    const i = real.get(1, 1)!;
    expect(i.fovAxis).toBe('horizontal');
    expect(i.tiltDeg).toBe(12);
    expect(i.heightM).toBe(4.8);
    expect(groundModelFromIntrinsics(i, 1)).not.toBeNull();
    expect(real.get(2, 1)).toBeNull();
  });

  it('chainProviders 는 앞선 공급자를 우선한다', () => {
    const a = staticProvider('a', [{ ...SIM, fovDeg: 10 }]);
    const b = staticProvider('b', [{ ...SIM, fovDeg: 20 }]);
    expect(chainProviders(a, b).get(1, 1)!.fovDeg).toBe(10);
    expect(chainProviders(b, a).get(1, 1)!.fovDeg).toBe(20);
    expect(chainProviders(a, b).id).toBe('a>b');
  });
});

describe('bayGrid — 행 좌표계', () => {
  const model = groundModelFromIntrinsics(SIM, 1)!;

  it('근변선에서 만든 행 좌표계의 깊이축은 카메라에서 멀어진다', () => {
    const line = lineThrough({ x: 200, y: 900 }, { x: 1700, y: 880 })!;
    const fr = rowFrameFromLine(model, line)!;
    expect(fr).not.toBeNull();
    const here = projectToPixel(fr.origin, model)!;
    const ahead = projectToPixel(
      [fr.origin[0] + fr.v[0] * 3, fr.origin[1] + fr.v[1] * 3, fr.origin[2] + fr.v[2] * 3],
      model,
    )!;
    expect(ahead.y).toBeLessThan(here.y); // 멀수록 화면 위
  });

  it('u·v 는 서로 직교하고 지면 법선과도 직교한다', () => {
    const line = lineThrough({ x: 200, y: 900 }, { x: 1700, y: 880 })!;
    const fr = rowFrameFromLine(model, line)!;
    const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(fr.u, fr.v)).toBeCloseTo(0, 9);
    expect(dot(fr.u, model.n)).toBeCloseTo(0, 9);
    expect(dot(fr.v, model.n)).toBeCloseTo(0, 9);
  });

  it('폭방향 좌표는 실제 미터 거리와 일치한다', () => {
    const line = lineThrough({ x: 200, y: 900 }, { x: 1700, y: 880 })!;
    const fr = rowFrameFromLine(model, line)!;
    const target: [number, number, number] = [
      fr.origin[0] + fr.u[0] * 7.5,
      fr.origin[1] + fr.u[1] * 7.5,
      fr.origin[2] + fr.u[2] * 7.5,
    ];
    const px = projectToPixel(target, model)!;
    expect(widthCoordOf(fr, model, px)!).toBeCloseTo(7.5, 4);
  });

  it('지평선 위 직선은 행 좌표계를 만들 수 없다(null)', () => {
    const horizon = lineThrough({ x: 0, y: 10 }, { x: 1919, y: 10 })!;
    expect(rowFrameFromLine(model, horizon)).toBeNull();
  });
});
