// §GROUND-SIMILARITY — 지면 위 닮음변환(4 DOF)에 대한 검출력과 **사각지대**를 봉인한다.
//
// 검증자(qa-cuboid) 가 발견한 최상위 결함: metricErr + tiltErrDeg 는 **상보적이지 않다.**
// 두 지표가 실제로 재는 것은 "이 ROI 가 (PTZ tilt 를 가진) 어떤 카메라로 본 2.5×5.0m 직사각형 스트립의 상인가"뿐이고,
// **지면 위 닮음변환(평행이동 2 + 수직축회전 1 + 균일스케일 1 = 4 DOF)은 그 성질을 완전히 보존**한다.
//
// 이 파일이 고정하는 것:
//   1. (사각 봉인) 지면 평행이동 → metricErr·tiltErrDeg **둘 다 침묵**. 원리적 검출 불가.
//   2. (신규 검출) 지면 균일스케일 → 프리셋 간 **카메라고(d) 불일치**로 잡는다.
//   3. (신규 검출) 지면 수직축회전 → 프리셋 간 **슬롯 방위(PTZ pan 보정)** 불일치로 잡는다.
//
// 2·3 은 "카메라가 프리셋 사이에 움직이지 않는다"는 사실만 쓴다 — 신규 입력 0, C3 합법(pan/tilt 는 실카메라도 준다).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import type { GroundCameraInput, GroundOptions, PixelQuad } from '../src/ground/types.js';

const DEG = Math.PI / 180;
const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const placeRoi = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));
const baseCam = buildGroundInputs(placeRoi, views)[0];
const CX = baseCam.imgW / 2;
const CY = baseCam.imgH / 2;

const base = estimateGroundModels(baseCam, OPTS);
const m1 = base.models.find((m) => m.presetIdx === 1)!;

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/**
 * ROI 에 **지면 위 닮음변환**을 정확히 가한다: 역투영(지면) → 변환 → 재투영.
 * 이미지에서 대충 미는 것과 다르다 — 결과는 여전히 '같은 카메라로 본 직사각형 스트립'이라 지표들이 속는다.
 */
function warpOnGround(
  quads: PixelQuad[],
  f: number,
  n: V3,
  d: number,
  t: { tx?: number; ty?: number; rotDeg?: number; scale?: number },
): PixelQuad[] {
  const { tx = 0, ty = 0, rotDeg = 0, scale = 1 } = t;
  const z: V3 = [0, 0, 1];
  const fwd = unit([z[0] - dot(z, n) * n[0], z[1] - dot(z, n) * n[1], z[2] - dot(z, n) * n[2]]);
  const right = unit(cross(n, fwd));
  const c = Math.cos(rotDeg * DEG);
  const s = Math.sin(rotDeg * DEG);
  return quads.map(
    (q) =>
      q.map((p) => {
        const m: V3 = [(p.x - CX) / f, (p.y - CY) / f, 1];
        const k = d / dot(n, m);
        const X: V3 = [k * m[0], k * m[1], k * m[2]]; // 지면점(카메라 좌표).
        const u = dot(X, right);
        const v = dot(X, fwd);
        const u2 = scale * (u * c - v * s) + tx;
        const v2 = scale * (u * s + v * c) + ty;
        const h = dot(X, n); // = d (지면 위 유지).
        const X2: V3 = [
          u2 * right[0] + v2 * fwd[0] + h * n[0],
          u2 * right[1] + v2 * fwd[1] + h * n[1],
          u2 * right[2] + v2 * fwd[2] + h * n[2],
        ];
        return { x: (f * X2[0]) / X2[2] + CX, y: (f * X2[1]) / X2[2] + CY };
      }) as PixelQuad,
  );
}

/** preset 1 ROI 만 지면 변환한 카메라 입력. */
function warpedCam(t: Parameters<typeof warpOnGround>[4]): GroundCameraInput {
  return {
    ...baseCam,
    presets: baseCam.presets.map((p) =>
      p.presetIdx === 1
        ? { ...p, quads: warpOnGround(p.quads, m1.f, m1.n as V3, m1.d, t) }
        : p,
    ),
  };
}
const warped = (t: Parameters<typeof warpOnGround>[4]) =>
  estimateGroundModels(warpedCam(t), OPTS).models.find((m) => m.presetIdx === 1)!;

/** 변환 전후 이미지 평균변위(px) — "얼마나 크게 어긋났는지"의 체감치. */
function meanShiftPx(t: Parameters<typeof warpOnGround>[4]): number {
  const q0 = baseCam.presets.find((p) => p.presetIdx === 1)!.quads;
  const q1 = warpOnGround(q0, m1.f, m1.n as V3, m1.d, t);
  let s = 0;
  let n = 0;
  q0.forEach((q, i) =>
    q.forEach((p, j) => {
      s += Math.hypot(q1[i][j].x - p.x, q1[i][j].y - p.y);
      n += 1;
    }),
  );
  return s / n;
}

describe('★ 사각지대 봉인 — 지면 위 평행이동은 어떤 지표로도 못 잡는다', () => {
  it('지면 3m/3m 평행이동(이미지 ~360px) → metricErr·tiltErrDeg 둘 다 침묵', () => {
    const t = { tx: 3, ty: 3 };
    const m = warped(t);
    expect(meanShiftPx(t)).toBeGreaterThan(200); // 실제로는 크게 어긋났다.
    // ↓ 이 단언들이 '통과'한다는 것은 두 지표가 **눈이 멀었다**는 뜻이다(의도된 봉인).
    expect(Math.abs(m.metricErr - m1.metricErr)).toBeLessThan(0.001);
    expect(Math.abs(m.tiltErrDeg! - m1.tiltErrDeg!)).toBeLessThan(0.1);
    expect(m.issues.join()).not.toContain('정합 의심');
  });

  it('지면 평행이동 2.5m = 주차면 정확히 한 칸 — 옆 칸을 덮어도 경보 0건(점유 오귀속 위험)', () => {
    const m = warped({ tx: 2.5 });
    expect(m.metricErr).toBeLessThan(0.008); // 가로 임계 미달.
    expect(Math.abs(m.tiltErrDeg!)).toBeLessThan(1.0); // 세로 임계 미달.
    expect(Math.abs(m.dDevRel!)).toBeLessThan(0.1); // 스케일 임계 미달.
    expect(Math.abs(m.bearingDevDeg!)).toBeLessThan(8); // 회전 임계 미달.
    // → 4개 지표 전부 침묵. **이것이 원리적 한계다**(노면 도색 대조 = 2단계 median 배경 필요).
  });
});

describe('신규 검출기 1 — 지면 균일스케일 (프리셋 간 카메라고 d 불일치)', () => {
  it('정상: d 스프레드 < 5%', () => {
    const ds = base.models.map((m) => m.d);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    expect((Math.max(...ds) - Math.min(...ds)) / mean).toBeLessThan(0.05);
    for (const m of base.models) expect(Math.abs(m.dDevRel!)).toBeLessThan(0.1);
  });

  it('★ preset 1 만 지면 ×2 스케일 → d 가 절반으로 붕괴 + advisory 발화 (metricErr 는 침묵)', () => {
    const m = warped({ scale: 2 });
    expect(m.d).toBeLessThan(m1.d * 0.6); // 4.96m → ~2.48m.
    expect(Math.abs(m.dDevRel!)).toBeGreaterThan(0.1);
    expect(m.issues.join()).toContain('지면 균일스케일 오류 의심');
    // 기존 두 지표는 이 붕괴에 눈이 멀어 있다 — 그래서 이 검사가 필요하다.
    expect(m.metricErr).toBeLessThan(0.008);
    expect(Math.abs(m.tiltErrDeg!)).toBeLessThan(1.0);
  });

  it('×0.5 스케일도 잡는다(양방향)', () => {
    const m = warped({ scale: 0.5 });
    expect(Math.abs(m.dDevRel!)).toBeGreaterThan(0.1);
    expect(m.issues.join()).toContain('지면 균일스케일 오류 의심');
  });
});

describe('신규 검출기 2 — 지면 수직축 회전 (프리셋 간 슬롯 방위 불일치, PTZ pan 보정)', () => {
  it('정상: 슬롯 방위(mod 90)가 프리셋 불변 — 편차 < 8°', () => {
    for (const m of base.models) {
      expect(m.slotBearingDeg).not.toBeNull();
      expect(Math.abs(m.bearingDevDeg!)).toBeLessThan(8);
    }
  });

  it('★ preset 1 만 지면 30° 회전 → 방위가 정확히 30° 이동 + advisory 발화 (metricErr 는 침묵)', () => {
    const m = warped({ rotDeg: 30 });
    const shift = Math.abs(m.slotBearingDeg! - m1.slotBearingDeg!);
    expect(Math.min(shift, 90 - shift)).toBeGreaterThan(25); // ≈30° 이동.
    expect(Math.abs(m.bearingDevDeg!)).toBeGreaterThan(8);
    expect(m.issues.join()).toContain('수직축 회전 의심');
    expect(m.metricErr).toBeLessThan(0.008); // 기존 지표는 침묵.
  });

  it('작은 회전(15°)도 잡는다', () => {
    const m = warped({ rotDeg: 15 });
    expect(Math.abs(m.bearingDevDeg!)).toBeGreaterThan(8);
    expect(m.issues.join()).toContain('수직축 회전 의심');
  });

  it('PTZ pan 미상 → slotBearingDeg=null, 회전 검출 불가 + 카메라 advisory(강등, throw 없음)', () => {
    const noPan: GroundCameraInput = {
      ...baseCam,
      presets: baseCam.presets.map((p) => ({ ...p, pan: null })),
    };
    const r = estimateGroundModels(noPan, OPTS);
    for (const m of r.models) {
      expect(m.slotBearingDeg).toBeNull();
      expect(m.bearingDevDeg).toBeNull();
    }
    expect(r.issues.join()).toContain('수직축 회전 검출 불가');
  });
});

describe('교차검증 불가 조건', () => {
  it('프리셋 1개 → 닮음변환 교차검증 불가 advisory', () => {
    const one: GroundCameraInput = {
      ...baseCam,
      presets: baseCam.presets.filter((p) => p.presetIdx === 1),
    };
    const r = estimateGroundModels(one, OPTS);
    expect(r.models).toHaveLength(1);
    expect(r.issues.join()).toContain('교차검증 불가');
    expect(r.models[0].dDevRel).toBeNull();
  });
});
