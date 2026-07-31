// ★ 25회차 — `cellAreaRatioMin/Max` 배선 봉인 + 거리 불변성 측정 봉인.
//
// 이 테스트가 지키는 것
//   ① 무력 기본값(`0`/`Infinity`) — 이 값이면 칸 필터가 아무것도 거르지 않으므로 **골든 무회귀가
//      측정 결과가 아니라 구조적 보장**이 된다(설계서 §5-2).
//   ② 서비스 미오버라이드 — `roiAuto.ts` 소스에 `cellAreaRatio` 문자열이 **없다**(§5-2 ④).
//   ③ 오라클 봉인 — 신규 계측 도구가 정답 필드를 읽지 않는다.
//   ④ `cellAreaRatio` 의 거리 불변성 — 같은 규격 칸을 두 깊이에 놓아도 비율이 같다.
//   ⑤ 플래그 ON 동작 — 무력값이 아닌 값을 주면 실제로 칸이 걸러진다(무력값이라 안 걸러지는 게 아님을 못 박는다).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_BAY_OPTS, type BayDetectOpts, type BayQuad } from '../src/ground/bayGeometry.js';
import { cellAreaRatioOf, quadGroundAreaM2 } from '../src/ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../src/ground/cameraIntrinsics.js';
import { projectToPixel } from '../src/ground/project.js';
import { canonicalizeQuad } from '../src/ground/groundGrid.js';
import type { GroundModel } from '../src/ground/types.js';
import type { Vec3 } from '../src/ground/contactTypes.js';

const OPTS: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: 4 };

function model(): GroundModel {
  const m = groundModelFromIntrinsics(
    { camIdx: 1, presetIdx: 1, fovDeg: 60, fovAxis: 'horizontal', tiltDeg: 30, heightM: 5, imgW: 1920, imgH: 1080, source: 'test' },
    1,
  );
  expect(m).not.toBeNull();
  return m as GroundModel;
}

/**
 * 지면 위 규격 칸(폭 w · 깊이 d)을 카메라 좌표계 z 방향 `depth` 위치에 놓고 픽셀 quad 로 만든다.
 * 지면은 n·X = dist 평면이므로 `backprojectToGround` 로 얻은 점을 기준으로 평면 위를 이동한다.
 */
function quadAtDepth(g: GroundModel, depthAlong: number, w: number, d: number): BayQuad | null {
  // 지면 평면의 두 접선 방향: n 과 직교하는 임의 정규직교 기저.
  const n = g.n as Vec3;
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0: Vec3 = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
  const un = Math.hypot(u0[0], u0[1], u0[2]);
  const u: Vec3 = [u0[0] / un, u0[1] / un, u0[2] / un];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  // 평면 위의 기준점 = n * dist 에서 v 방향으로 depthAlong 만큼 간 점.
  const o: Vec3 = [n[0] * g.d + v[0] * depthAlong, n[1] * g.d + v[1] * depthAlong, n[2] * g.d + v[2] * depthAlong];
  const P = (su: number, sv: number): Vec3 => [o[0] + u[0] * su + v[0] * sv, o[1] + u[1] * su + v[1] * sv, o[2] + u[2] * su + v[2] * sv];
  const pts = [P(0, 0), P(0, d), P(w, d), P(w, 0)].map((X) => projectToPixel(X, g));
  if (pts.some((p) => p == null)) return null;
  const q = canonicalizeQuad(pts as Array<{ x: number; y: number }>);
  return q ? { latticeIndex: 0, quad: q } : null;
}

describe('25회차 cellAreaRatio 배선', () => {
  it('① 기본값이 무력이다 — 0 / Infinity (골든 무회귀의 구조적 보장)', () => {
    expect(DEFAULT_BAY_OPTS.cellAreaRatioMin).toBe(0);
    expect(DEFAULT_BAY_OPTS.cellAreaRatioMax).toBe(Infinity);
  });

  it('② 서비스가 오버라이드하지 않는다 — roiAuto.ts 에 cellAreaRatio 부재', () => {
    const src = readFileSync('src/rpc/services/roiAuto.ts', 'utf8');
    expect(src.includes('cellAreaRatio')).toBe(false);
  });

  it('③ 신규 계측 도구가 오라클 필드를 읽지 않는다', () => {
    const src = readFileSync('src/tools/gridDiag.ts', 'utf8');
    // `presetIdx`(카메라 제원 필드)는 오라클이 아니므로 `presetId` 뒤에 `x` 가 오면 제외한다.
    for (const re of [/faceSlot/, /presetId(?!x)/, /visible/, /rotY/, /t\.vis/, /\bpos\./]) {
      expect(re.test(src), `gridDiag.ts 에 오라클 토큰 ${re} 가 있다`).toBe(false);
    }
    // 카메라 물리 이동 경로 미사용(설계서 §1-2 함정 A·B).
    expect(src.includes('CameraSourceClient')).toBe(false);
    expect(src.includes('requestImage')).toBe(false);
    expect(src.includes('roi.auto.apply')).toBe(false);
  });

  it('④ cellAreaRatio 는 거리에 불변이다 — 같은 규격 칸을 두 깊이에서', () => {
    const g = model();
    const near = quadAtDepth(g, 8, OPTS.slotWidthM, OPTS.slotDepthM);
    const far = quadAtDepth(g, 40, OPTS.slotWidthM, OPTS.slotDepthM);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    const rn = cellAreaRatioOf(near as BayQuad, g, OPTS);
    const rf = cellAreaRatioOf(far as BayQuad, g, OPTS);
    expect(rn).not.toBeNull();
    expect(rf).not.toBeNull();
    // 픽셀 면적은 크게 다르지만 지상 면적비는 같다 — 이것이 픽셀 면적 축을 버린 이유다.
    expect(Math.abs((rn as number) - 1)).toBeLessThan(1e-6);
    expect(Math.abs((rf as number) - 1)).toBeLessThan(1e-6);
    expect(quadGroundAreaM2(near as BayQuad, g)).toBeCloseTo(OPTS.slotWidthM * OPTS.slotDepthM, 6);
  });

  it('⑤ 플래그 ON 이면 실제로 판정이 바뀐다(무력값이라 안 걸리는 것이 아님)', () => {
    const g = model();
    const q = quadAtDepth(g, 20, OPTS.slotWidthM, OPTS.slotDepthM) as BayQuad;
    const r = cellAreaRatioOf(q, g, OPTS) as number;
    // 무력 기본값: 통과
    expect(r >= DEFAULT_BAY_OPTS.cellAreaRatioMin && r <= DEFAULT_BAY_OPTS.cellAreaRatioMax).toBe(true);
    // 하한 1.5: 탈락 / 상한 0.5: 탈락 — 게이트가 값에 반응한다.
    expect(r >= 1.5).toBe(false);
    expect(r <= 0.5).toBe(false);
    // 절반 크기 칸은 비율 0.5 근방 — 하한 0.75 로 걸러진다.
    const half = quadAtDepth(g, 20, OPTS.slotWidthM / 2, OPTS.slotDepthM) as BayQuad;
    const rh = cellAreaRatioOf(half, g, OPTS) as number;
    expect(Math.abs(rh - 0.5)).toBeLessThan(1e-6);
    expect(rh >= 0.75).toBe(false);
  });

  it('⑥ ★ 25회차 실측 봉인 — 격자 칸의 cellAreaRatio 는 정의상 1 이라 하한/상한이 무력하다', () => {
    // 격자는 `buildAtPhase` 가 slotWidthM × slotDepthM 로 세우므로, 같은 모델로 역투영하면
    // 지상 면적이 **정확히** 규격면적으로 되돌아온다. 실측 결과(시뮬 155칸 · 야간 60칸)에서
    // |ratio − 1| 의 최대가 7.4e-15(배정도 잡음)였다. 이 사실을 테스트로 못 박아
    // 26회차가 이 축으로 「과대 면」을 거를 수 있다고 다시 기대하지 않게 한다.
    const g = model();
    for (const depth of [6, 12, 24, 48, 96]) {
      const q = quadAtDepth(g, depth, OPTS.slotWidthM, OPTS.slotDepthM);
      if (!q) continue;
      const r = cellAreaRatioOf(q, g, OPTS) as number;
      expect(Math.abs(r - 1)).toBeLessThan(1e-9);
    }
  });
});
