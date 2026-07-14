// ★★ 정합 지표 두 개의 **공통 사각(blind spot)** — 검증자(qa)가 독립 확인한 결과를 봉인한다.
//
// 배경: roiAlignmentSensitivity.test.ts 는 metricErr(가로) + tiltErrDeg(세로) 가 **이미지 평행이동**을
// 상보적으로 잡는다는 것을 봉인했다. 그것은 사실이다(뮤테이션으로 검출력 실증됨).
// 그러나 **"두 지표를 통과했다 = ROI 가 실제 주차면 위에 있다" 는 성립하지 않는다.**
//
// 두 지표가 실제로 재는 것은 이것뿐이다:
//   "이 ROI 는 (PTZ 가 보고한 tilt 를 가진) 어떤 카메라로 본 2.5×5.0m 직사각형 스트립의 상(像)인가?"
// 그런데 **지면 위의 닮음변환(평행이동·수직축 회전·균일 스케일)은 그 성질을 그대로 보존한다.**
// 즉 ROI 를 지면에서 통째로 밀거나/돌리거나/키워도 두 지표는 **미동도 하지 않는다.**
//
// 실측(preset 1, 지면 왕복 변환으로 정확히 구성):
//   | 변환                    | 이미지 평균변위 | metricErr    | tiltErrDeg | 검출 |
//   |------------------------|--------------|--------------|------------|------|
//   | 기준                    |     0px      | 0.19%        | 0.04°      |  –   |
//   | [지면] 평행이동 3m/3m    |   360px      | 0.19% (불변) | 0.04°(불변) | ✗✗  |
//   | [지면] 수직축 회전 30°    |   144px      | 0.23%        | 0.04°      | ✗✗  |
//   | [지면] 균일 스케일 2.0    |   473px      | 0.14%        | 0.03°      | ✗✗  |
//   | [이미지] 회전 10°        |    77px      | 0.57%        | 0.05°      | ✗✗  |
//
// **가장 위험한 것**: 지면 평행이동 2.5m = 주차면 **정확히 한 칸** 이동. ROI 가 옆 칸을 덮어도 두 지표는 침묵한다
// → 점유가 통째로 옆 칸에 찍힌다. 그리고 [지면] 균일 스케일은 **카메라고 d 를 조용히 배수로 틀리게** 만든다
// (k=2 → d 4.96m → 2.48m). d 는 metric 스케일의 유일한 담지자이므로 육면체 높이가 그대로 틀어진다.
//
// 결론(문서·배지에 반드시 반영할 것): 두 지표는 **이미지 평행이동 검출기**이지 정합 보증이 아니다.
// 지면 평행이동(2 DOF)은 **이미지 증거(노면 도색) 없이는 원리적으로 검출 불가** — 2단계 median 배경이 필요하다.
// 반면 회전·스케일 DOF 는 **이미 가진 데이터로 잡을 수 있다**(아래 마지막 describe 가 실증):
//   - 균일 스케일 → **프리셋 간 d 일관성**(카메라는 프리셋 사이에 움직이지 않는다. d 는 상수여야 한다)
//   - 수직축 회전 → **PTZ pan 대조**(camerapos 가 이미 pan 을 준다 — tilt 와 같은 C3-합법 소스)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateGroundModels } from '../src/ground/groundModel.js';
import { buildGroundInputs } from '../src/ground/groundInputs.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import type { GroundCameraInput, GroundOptions, PixelQuad } from '../src/ground/types.js';

const OPTS: GroundOptions = { minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };
/** groundModel.ts 의 경보 임계와 동일(여기서 '침묵'을 판정하는 기준). */
const MET_THRESH = 0.008;
const TILT_THRESH = 1.0;

const placeRoi = JSON.parse(readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8'));
const views = parseCameraViews(JSON.parse(readFileSync('test/fixtures/camerapos.sample.json', 'utf8')));
const baseCam = buildGroundInputs(placeRoi, views)[0];
const TARGET = 1;

const withQuads = (fn: (q: PixelQuad) => PixelQuad): GroundCameraInput => ({
  ...baseCam,
  presets: baseCam.presets.map((p) => (p.presetIdx === TARGET ? { ...p, quads: p.quads.map(fn) } : p)),
});
const modelOf = (cam: GroundCameraInput, preset = TARGET) =>
  estimateGroundModels(cam, OPTS).models.find((m) => m.presetIdx === preset)!;
const base = modelOf(baseCam);

// ── 지면 왕복(역투영 → 지면에서 변환 → 재투영). 기준 모델(f,n,d)을 그대로 쓴다. ──
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

const nrm = base.n as V3;
const F = base.f;
const D = base.d;
const CX = baseCam.imgW / 2;
const CY = baseCam.imgH / 2;
const e1 = unit(cross(nrm, Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
const e2 = unit(cross(nrm, e1));

const toGround = (p: { x: number; y: number }): V3 => {
  const m: V3 = [(p.x - CX) / F, (p.y - CY) / F, 1];
  const s = D / dot(nrm, m);
  return [m[0] * s, m[1] * s, m[2] * s];
};
const toImage = (X: V3) => ({ x: (F * X[0]) / X[2] + CX, y: (F * X[1]) / X[2] + CY });

const targetPts = baseCam.presets.find((p) => p.presetIdx === TARGET)!.quads.flat();
const Cg: V3 = (() => {
  const a: V3 = [0, 0, 0];
  for (const p of targetPts) {
    const X = toGround(p);
    a[0] += X[0];
    a[1] += X[1];
    a[2] += X[2];
  }
  return [a[0] / targetPts.length, a[1] / targetPts.length, a[2] / targetPts.length];
})();

/** 지면 위 평행이동(a·e1 + b·e2 미터). 지면에 남으므로 '2.5×5.0m 직사각형의 상' 성질이 보존된다. */
const groundTranslate = (a: number, b: number) => (q: PixelQuad): PixelQuad =>
  q.map((p) => {
    const X = toGround(p);
    return toImage([X[0] + a * e1[0] + b * e2[0], X[1] + a * e1[1] + b * e2[1], X[2] + a * e1[2] + b * e2[2]]);
  }) as PixelQuad;

/** 지면 법선축(수직축) 회전 — 스트립을 지면 위에서 통째로 돌린다(Rodrigues). */
const groundRotate = (deg: number) => (q: PixelQuad): PixelQuad => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return q.map((p) => {
    const X = toGround(p);
    const r: V3 = [X[0] - Cg[0], X[1] - Cg[1], X[2] - Cg[2]];
    const kx = cross(nrm, r);
    const kd = dot(nrm, r);
    const R: V3 = [
      r[0] * c + kx[0] * s + nrm[0] * kd * (1 - c),
      r[1] * c + kx[1] * s + nrm[1] * kd * (1 - c),
      r[2] * c + kx[2] * s + nrm[2] * kd * (1 - c),
    ];
    return toImage([Cg[0] + R[0], Cg[1] + R[1], Cg[2] + R[2]]);
  }) as PixelQuad;
};

/** 지면 위 균일 스케일(k배) — 주차면이 2.5k × 5.0k m 가 된다(종횡비 보존 → metricErr 는 못 잡는다). */
const groundScale = (k: number) => (q: PixelQuad): PixelQuad =>
  q.map((p) => {
    const X = toGround(p);
    return toImage([Cg[0] + k * (X[0] - Cg[0]), Cg[1] + k * (X[1] - Cg[1]), Cg[2] + k * (X[2] - Cg[2])]);
  }) as PixelQuad;

/** 이미지 평면 회전(ROI 중심 기준). */
const imageRotate = (deg: number) => (q: PixelQuad): PixelQuad => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const mx = targetPts.reduce((a, p) => a + p.x, 0) / targetPts.length;
  const my = targetPts.reduce((a, p) => a + p.y, 0) / targetPts.length;
  return q.map((p) => ({
    x: mx + (p.x - mx) * c - (p.y - my) * s,
    y: my + (p.x - mx) * s + (p.y - my) * c,
  })) as PixelQuad;
};

/** 변환이 만든 이미지상 평균 변위(px) — '얼마나 어긋났는가'. */
function meanShiftPx(fn: (q: PixelQuad) => PixelQuad): number {
  const moved = baseCam.presets.find((p) => p.presetIdx === TARGET)!.quads.map(fn).flat();
  let s = 0;
  for (let i = 0; i < targetPts.length; i++) {
    s += Math.hypot(moved[i].x - targetPts[i].x, moved[i].y - targetPts[i].y);
  }
  return s / targetPts.length;
}

/** 두 정합 지표가 **둘 다 침묵**하는가. */
const bothSilent = (m: { metricErr: number; tiltErrDeg: number | null }) =>
  m.metricErr <= MET_THRESH && Math.abs(m.tiltErrDeg ?? 0) <= TILT_THRESH;

describe('★★ 한계 봉인 (1) — metricErr·tiltErrDeg 자체는 지면 닮음변환에 **원리적으로** 눈이 멀었다', () => {
  // 이 사실은 구현자가 프리셋 간 불변량 검사를 추가한 뒤에도 **변하지 않는다.**
  // 두 지표는 여전히 '이미지 평행이동 검출기' 일 뿐이다 — 잡는 주체가 다른 검사로 옮겨갔을 뿐.
  it.each([
    ['지면 평행이동 e1 +2.5m (주차면 한 칸)', groundTranslate(2.5, 0), 50],
    ['지면 평행이동 e1+e2 +3/+3m', groundTranslate(3, 3), 200],
    ['지면 수직축 회전 +30°', groundRotate(30), 100],
    ['지면 균일 스케일 ×2.0', groundScale(2.0), 300],
  ])('%s → 이미지상 크게 어긋나지만 두 지표는 침묵한다', (_name, fn, minShift) => {
    const shift = meanShiftPx(fn as (q: PixelQuad) => PixelQuad);
    expect(shift).toBeGreaterThan(minShift as number); // 실제로 크게 어긋났다.

    const m = modelOf(withQuads(fn as (q: PixelQuad) => PixelQuad));
    // ↓ '통과' = 두 지표가 이 변환에 눈이 멀었다는 뜻(의도된 한계 봉인).
    expect(bothSilent(m)).toBe(true);
    expect(m.issues.join()).not.toContain('정합 의심'); // 가로/세로 정합 advisory 는 발화하지 않는다.
  });

  it('이미지 평면 회전 10°(평균 77px 어긋남)도 두 지표가 모두 놓친다 — "≳60px 를 잡는다"는 보장은 성립하지 않는다', () => {
    const shift = meanShiftPx(imageRotate(10));
    expect(shift).toBeGreaterThan(60);
    const m = modelOf(withQuads(imageRotate(10)));
    expect(bothSilent(m)).toBe(true); // ← 60px 을 넘겨도 침묵.
  });
});

describe('★ 프리셋 간 불변량 검사가 회전·스케일 2 DOF 를 닫는다(구현자 수정 검증)', () => {
  // 근거: 카메라는 프리셋 사이에 움직이지 않는다 → 카메라고 d 와 슬롯 방위는 **프리셋 불변량**이어야 한다.
  it('지면 균일 스케일 ×2.0 → 카메라고 d 붕괴(4.96→~2.48m)를 프리셋 간 d 일관성이 잡아낸다', () => {
    const m = modelOf(withQuads(groundScale(2.0)));
    expect(bothSilent(m)).toBe(true); // 두 정합 지표는 여전히 침묵하지만…
    expect(m.d).toBeLessThan(base.d * 0.6); // d 가 실제로 절반으로 붕괴했고,
    expect(m.issues.join()).toContain('균일스케일'); // ← 신규 검사가 잡는다.
    expect(Math.abs(m.dDevRel ?? 0)).toBeGreaterThan(0.3);
  });

  it('지면 수직축 회전 +30° → 슬롯 방위 편차를 프리셋 간 일관성이 잡아낸다', () => {
    const m = modelOf(withQuads(groundRotate(30)));
    expect(bothSilent(m)).toBe(true); // 두 정합 지표는 여전히 침묵하지만…
    expect(m.issues.join()).toContain('수직축 회전'); // ← 신규 검사가 잡는다.
    expect(Math.abs(m.bearingDevDeg ?? 0)).toBeGreaterThan(5);
  });

  it('정합된 ROI(Unity 원형) → 신규 검사도 발화하지 않는다(오탐 0)', () => {
    for (const m of estimateGroundModels(baseCam, OPTS).models) {
      expect(m.issues.join()).not.toContain('균일스케일');
      expect(m.issues.join()).not.toContain('수직축 회전');
    }
  });
});

describe('★★ 한계 봉인 (2) — 지면 평행이동 2 DOF 는 **여전히 아무것도 잡지 못한다**', () => {
  // 이것이 확정된 잔여 구멍이다. 지면 평행이동은 d 도 슬롯 방위도 바꾸지 않으므로
  // 프리셋 간 불변량 검사조차 눈이 멀었다. **이미지 증거(노면 도색) 없이는 원리적으로 검출 불가**
  // → 2단계 median 배경이 유일한 해법. 지표로 덮은 척하지 말 것.
  it('지면 평행이동 +3m/+3m(이미지 360px) → 신규 검사를 포함해 **어떤 advisory 도 발화하지 않는다**', () => {
    const fn = groundTranslate(3, 3);
    expect(meanShiftPx(fn)).toBeGreaterThan(200); // 이미지상 크게 어긋났는데도

    const m = modelOf(withQuads(fn));
    expect(bothSilent(m)).toBe(true);
    expect(m.issues.join()).not.toContain('정합 의심');
    expect(m.issues.join()).not.toContain('균일스케일');
    expect(m.issues.join()).not.toContain('수직축 회전');
    // 프리셋 불변량이 그대로 유지된다 — 그래서 원리적으로 검출 불가하다.
    expect(Math.abs(m.dDevRel ?? 0)).toBeLessThan(0.05);
    expect(Math.abs(m.bearingDevDeg ?? 0)).toBeLessThan(2);
  });

  it('주차면 한 칸(2.5m) 이동 → 점유가 옆 칸에 찍히는 상황인데 전 지표가 침묵한다', () => {
    const m = modelOf(withQuads(groundTranslate(2.5, 0)));
    expect(bothSilent(m)).toBe(true);
    expect(m.issues.join()).not.toContain('의심');
  });
});
