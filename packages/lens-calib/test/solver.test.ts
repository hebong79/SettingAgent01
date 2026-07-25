import { describe, expect, it } from 'vitest';
import { CalibrationSolver } from '../src/solver.js';
import { basis, dot3 } from '../src/geometry.js';
import { distortRadius, undistortRadius, type Coeffs } from '../src/distortion.js';
import type { Ptz, Sample } from '../src/types.js';

// ── 합성 대응점 생성기 ──────────────────────────────────────────────────────
//
// ★ 이 테스트가 무엇을 검증하고 무엇을 검증하지 **않는지** 분명히 해 둔다.
//   검증하는 것: 주어진 관측으로부터 (f, k1, k2) 가 **식별 가능**하고 최적화가 그것을 되찾는다.
//   검증하지 않는 것: 모델이 실제 렌즈와 맞는가. 그건 렌더를 거치는 runner 의 end-to-end
//   테스트(mock 카메라)가 담당한다 — 거기서는 렌더가 모델을 **역방향으로** 쓰므로 독립적이다.

const W = 1920;
const H = 1080;
const CX = W / 2;
const CY = H / 2;

/** 이 화각의 주변축 초점거리(px). */
function focalOf(hfovDeg: number): number {
  return CX / Math.tan(((hfovDeg / 2) * Math.PI) / 180);
}

/** 이미지 좌표 → (before 자세 광선) → (after 자세) → 이미지 좌표. 왜곡 포함. */
function landingOf(fromX: number, fromY: number, f: number, c: Coeffs, before: Ptz, after: Ptz): { x: number; y: number } | null {
  const dx = fromX - CX;
  const dy = fromY - CY;
  const rpx = Math.hypot(dx, dy);
  const s = rpx > 1e-9 ? undistortRadius(rpx / f, c) / (rpx / f) : 1;
  const ux = (dx * s) / f;
  const uy = -(dy * s) / f;

  const b0 = basis(before.panpos, before.tiltpos);
  const b1 = basis(after.panpos, after.tiltpos);
  const ray: [number, number, number] = [
    b0.F[0] + b0.R[0] * ux + b0.U[0] * uy,
    b0.F[1] + b0.R[1] * ux + b0.U[1] * uy,
    b0.F[2] + b0.R[2] * ux + b0.U[2] * uy,
  ];
  const t = dot3(ray, b1.F);
  if (t <= 1e-9) return null;
  const xi = CX + f * (dot3(ray, b1.R) / t);
  const yi = CY - f * (dot3(ray, b1.U) / t);

  const rIdeal = Math.hypot(xi - CX, yi - CY) / f;
  const s2 = rIdeal > 1e-9 ? distortRadius(rIdeal, c) / rIdeal : 1;
  return { x: CX + (xi - CX) * s2, y: CY + (yi - CY) * s2 };
}

/** 결정적 유사난수 — 관측 노이즈 주입용(테스트가 실행마다 흔들리면 안 된다). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface SynthOptions {
  hfov?: number;
  coeffs?: Coeffs;
  zoom?: number;
  home?: Ptz;
  cols?: number;
  rows?: number;
  margin?: number;
  /** 관측 노이즈 표준편차(px). 매처의 서브픽셀 성능을 흉내낸다. */
  noisePx?: number;
  seed?: number;
}

function synthFlow({
  hfov = 55,
  coeffs = { k1: -0.085, k2: 0.012 },
  zoom = 0,
  home = { panpos: 4500, tiltpos: 1200, zoompos: 0 },
  cols = 5,
  rows = 3,
  margin = 60,
  noisePx = 0,
  seed = 12345,
}: SynthOptions = {}): Sample[] {
  const f = focalOf(hfov);
  const rand = rng(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

  // 회전 4방향, 각각 프레임의 25% 만큼 영상을 민다.
  const panStep = Math.round((Math.atan((W * 0.25) / f) * 18000) / Math.PI);
  const tiltStep = Math.round((Math.atan((H * 0.25) / f) * 18000) / Math.PI);
  const deltas: Array<[number, number]> = [
    [panStep, 0],
    [-panStep, 0],
    [0, tiltStep],
    [0, -tiltStep],
  ];

  const samples: Sample[] = [];
  for (const [dp, dt] of deltas) {
    const before: Ptz = { ...home, zoompos: zoom };
    const after: Ptz = { panpos: before.panpos + dp, tiltpos: before.tiltpos + dt, zoompos: zoom };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const fromX = margin + ((W - 2 * margin) * c) / (cols - 1);
        const fromY = margin + ((H - 2 * margin) * r) / (rows - 1);
        const landed = landingOf(fromX, fromY, f, coeffs, before, after);
        if (!landed) continue;
        if (landed.x < margin || landed.x > W - margin || landed.y < margin || landed.y > H - margin) continue;
        samples.push({
          kind: 'flow',
          zoomAnchor: zoom,
          fromX,
          fromY,
          dx: 0,
          dy: 0,
          ptzBefore: before,
          ptzAfter: after,
          dpanCd: dp,
          dtiltCd: dt,
          landedX: landed.x + noisePx * gauss(),
          landedY: landed.y + noisePx * gauss(),
          residualX: landed.x - CX,
          residualY: landed.y - CY,
          peak: 0.9,
          margin: 0.1,
          contrast: 40,
          usable: true,
        });
      }
    }
  }
  return samples;
}

// ───────────────────────────────────────────────────────────────────────────

describe('fitLens — (f, k1, k2) 복원', () => {
  const solver = new CalibrationSolver();

  it('★잡음 없는 관측에서 정답을 되찾는다', () => {
    const truth = { hfov: 55, coeffs: { k1: -0.085, k2: 0.012 } };
    const samples = synthFlow(truth);
    expect(samples.length).toBeGreaterThanOrEqual(24);

    const fit = solver.fitLens(samples);
    expect(fit).not.toBeNull();
    expect(fit!.dof).toBe(3);
    const fTrue = focalOf(truth.hfov);
    expect(Math.abs(fit!.f - fTrue) / fTrue).toBeLessThan(0.005); // f ≤0.5%
    expect(Math.abs(fit!.k1 - truth.coeffs.k1) / Math.abs(truth.coeffs.k1)).toBeLessThan(0.05); // k1 ≤5%
    expect(fit!.rms).toBeLessThan(0.5);
  });

  it('★관측 노이즈 0.3px 에서도 목표 정확도를 지킨다', () => {
    const truth = { hfov: 55, coeffs: { k1: -0.085, k2: 0.012 } };
    const samples = synthFlow({ ...truth, noisePx: 0.3, seed: 777 });
    const fit = solver.fitLens(samples);
    const fTrue = focalOf(truth.hfov);
    expect(Math.abs(fit!.f - fTrue) / fTrue).toBeLessThan(0.005);
    expect(Math.abs(fit!.k1 - truth.coeffs.k1) / Math.abs(truth.coeffs.k1)).toBeLessThan(0.05);
  });

  it('왜곡이 0 인 렌즈에서는 k1 도 0 근처로 나온다 (없는 것을 만들지 않는다)', () => {
    const samples = synthFlow({ hfov: 55, coeffs: { k1: 0, k2: 0 } });
    const fit = solver.fitLens(samples);
    expect(Math.abs(fit!.k1)).toBeLessThan(0.005);
  });

  it('자유도는 대응점 수가 허락하는 만큼만 준다', () => {
    const many = synthFlow();
    expect(solver.fitLens(many)!.dof).toBe(3);
    expect(solver.fitLens(many.slice(0, 14))!.dof).toBe(2);
    expect(solver.fitLens(many.slice(0, 8))!.dof).toBe(1);
  });

  it('dof 를 명시하면 그 값을 강제한다 (게이트 baseline 용)', () => {
    const samples = synthFlow();
    const base = solver.fitLens(samples, 1)!;
    expect(base.dof).toBe(1);
    expect(base.k1).toBe(0);
    // 왜곡을 못 쓰면 잔차가 훨씬 크다 — 그게 왜곡항이 실재한다는 증거다.
    expect(base.rms).toBeGreaterThan(solver.fitLens(samples)!.rms * 3);
  });
});

describe('solveDistortionZoom — 채택 게이트', () => {
  const solver = new CalibrationSolver();

  it('★유의미한 왜곡은 채택한다', () => {
    const p = solver.solveDistortionZoom(synthFlow({ hfov: 55, coeffs: { k1: -0.085, k2: 0.012 } }))!;
    expect(p.adopted).toBe(true);
    expect(p.k1).toBeLessThan(0); // 배럴
    expect(p.rms1Px!).toBeLessThan(p.rms0Px!);
    expect(p.n).toBeGreaterThanOrEqual(24);
  });

  it('★왜곡이 없으면 재봤다는 사실과 함께 0 으로 기록한다 (과적합 금지)', () => {
    const p = solver.solveDistortionZoom(synthFlow({ hfov: 55, coeffs: { k1: 0, k2: 0 } }))!;
    expect(p.adopted).toBe(false);
    expect(p.reason).toBe('not_significant');
    expect(p.k1).toBe(0);
    expect(p.k2).toBe(0);
    // 미측정과 다르다 — 몇 개를 봤는지 남긴다.
    expect(p.n).toBeGreaterThan(0);
    expect(p.rms0Px).toBeDefined();
  });

  it('★망원(화각이 좁아 3승 항이 사실상 0)에서도 과적합하지 않는다', () => {
    // 같은 k1 이라도 화각이 좁으면 코너 반경이 작아 실제 변위가 무시할 수준이 된다.
    const p = solver.solveDistortionZoom(synthFlow({ hfov: 9.77, coeffs: { k1: -0.085, k2: 0 }, zoom: 12161 }))!;
    expect(p.adopted).toBe(false);
    expect(p.k1).toBe(0);
  });

  it('샘플이 너무 적으면 사유와 함께 0', () => {
    const few = synthFlow().slice(0, 8);
    const p = solver.solveDistortionZoom(few)!;
    expect(p.adopted).toBe(false);
    expect(p.reason).toBe('too_few_samples');
  });

  it('6개 미만이면 앵커 자체가 안 나온다', () => {
    expect(solver.solveDistortionZoom(synthFlow().slice(0, 4))).toBeNull();
  });
});

describe('buildDistortion — 줌별 표 조립', () => {
  it('여러 줌을 모아 표를 만들고, 못 쓴 줌은 skipped 로 보고한다', () => {
    const solver = new CalibrationSolver();
    const samples = [
      ...synthFlow({ hfov: 55, coeffs: { k1: -0.085, k2: 0.012 }, zoom: 0 }),
      ...synthFlow({ hfov: 34.05, coeffs: { k1: -0.03, k2: 0 }, zoom: 5129 }),
      ...synthFlow({ hfov: 22.59, coeffs: { k1: -0.01, k2: 0 }, zoom: 8000 }).slice(0, 3),
    ];
    const { points, skipped } = solver.buildDistortion(samples);
    expect(points.map((p) => p.z)).toEqual([0, 5129]);
    expect(points[0]!.adopted).toBe(true);
    expect(skipped.map((s) => s.zoom)).toEqual([8000]);
  });
});

describe('usable — 광류 샘플에 클릭용 게이트를 걸지 않는다', () => {
  const solver = new CalibrationSolver();

  it('★flow 샘플은 교차축 잔차로 버려지지 않는다', () => {
    const samples = synthFlow();
    // 광류 샘플은 프레임 전역을 재므로 residualX/Y 가 40px 를 훌쩍 넘는 것이 정상이다.
    expect(samples.some((s) => Math.abs(s.residualY) > 40)).toBe(true);
    expect(solver.usable(samples).length).toBe(samples.length);
  });

  it('click 샘플에는 그대로 건다', () => {
    const bad: Sample = {
      ...synthFlow()[0]!,
      kind: 'click',
      dx: 480,
      dy: 0,
      dpanCd: 300,
      residualX: 40,
      residualY: 200, // 가로 클릭인데 세로로 크게 튀었다 = 매처가 엉뚱한 걸 물었다
    };
    expect(solver.usable([bad]).length).toBe(0);
  });

  it('약한 매칭(peak)·모호한 매칭(margin)·명시적 실패를 버린다', () => {
    const base = synthFlow()[0]!;
    expect(solver.usable([{ ...base, peak: 0.3 }]).length).toBe(0);
    expect(solver.usable([{ ...base, margin: 0.001 }]).length).toBe(0);
    expect(solver.usable([{ ...base, usable: false }]).length).toBe(0);
    expect(solver.usable([{ ...base, landedX: NaN }]).length).toBe(0);
  });
});
