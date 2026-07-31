// ★ 25회차 — `cellAreaRatio` 거리 불변성 측정 봉인 / ★ 26회차 R2 — **배선 부재** 봉인으로 전환.
//
// 26회차 R2 판정: `cellAreaRatio` 축은 **원리적으로 무력**하다(격자를 규격으로 세운 뒤 같은 모델로
// 역투영하니 지상 면적이 정확히 규격으로 되돌아온다 — 실측 |ratio−1| ≤ 5.218048215738236e-15).
// 승격 계획이 없으므로 `BayDetectOpts.cellAreaRatioMin/Max` 와 `bayGrid` 칸 필터 배선을 **제거**했다.
// 그러나 **지식은 남긴다** — 왜 무력한지를 아래 ④⑤⑥ 이 계속 증명하므로 27회차가 같은 시도를 반복하지 않는다.
//
// 이 테스트가 지키는 것
//   ① ★ 배선 부재 — `BayDetectOpts`/`DEFAULT_BAY_OPTS` 에 `cellAreaRatio*` 가 **없다**(재배선 방지).
//   ② 서비스·격자 미사용 — `roiAuto.ts`·`bayGrid.ts` 칸 필터에 `cellAreaRatio` 판정이 **없다**.
//   ③ 오라클 봉인 — 계측 도구가 정답 필드를 읽지 않는다.
//   ④ `cellAreaRatio` 의 거리 불변성 — 같은 규격 칸을 두 깊이에 놓아도 비율이 같다.
//   ⑤ 축이 값에 반응하기는 한다 — 반쪽 칸은 0.5 다. 즉 「함수가 고장나서 1 이 나오는 것」이 아니다.
//   ⑥ ★ 규격 칸은 어느 깊이에서도 정확히 1 — 그래서 어떤 하한/상한도 참·거짓을 가르지 못한다.

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

describe('26회차 R2 — cellAreaRatio 배선 제거 봉인', () => {
  it('① 옵션에 배선이 없다 — BayDetectOpts/DEFAULT_BAY_OPTS 에 cellAreaRatio* 부재', () => {
    expect(Object.keys(DEFAULT_BAY_OPTS)).not.toContain('cellAreaRatioMin');
    expect(Object.keys(DEFAULT_BAY_OPTS)).not.toContain('cellAreaRatioMax');
    const src = readFileSync('src/ground/bayGeometry.ts', 'utf8');
    expect(src.includes('cellAreaRatioMin')).toBe(false);
    expect(src.includes('cellAreaRatioMax')).toBe(false);
  });

  it('② 서비스·격자 칸 필터가 이 축을 쓰지 않는다', () => {
    expect(readFileSync('src/rpc/services/roiAuto.ts', 'utf8').includes('cellAreaRatio')).toBe(false);
    // `bayGrid.ts` 에는 계측 함수 `cellAreaRatioOf` 정의만 남고 **호출(판정)** 은 없다.
    const grid = readFileSync('src/ground/bayGrid.ts', 'utf8');
    expect(/cellAreaRatioOf\(/.test(grid.replace('export function cellAreaRatioOf(', ''))).toBe(false);
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

  it('⑤ 축 자체는 값에 반응한다 — 함수가 고장나서 1 이 나오는 것이 아니다', () => {
    const g = model();
    const q = quadAtDepth(g, 20, OPTS.slotWidthM, OPTS.slotDepthM) as BayQuad;
    const r = cellAreaRatioOf(q, g, OPTS) as number;
    // 규격 칸은 1 — 어떤 하한/상한도 이것을 자투리나 과대 면과 가르지 못한다.
    expect(Math.abs(r - 1)).toBeLessThan(1e-9);
    // 절반 크기 칸은 비율 0.5 근방 — 즉 함수는 정상이고, 격자 칸이 항상 규격이라 상수인 것이다.
    const half = quadAtDepth(g, 20, OPTS.slotWidthM / 2, OPTS.slotDepthM) as BayQuad;
    const rh = cellAreaRatioOf(half, g, OPTS) as number;
    expect(Math.abs(rh - 0.5)).toBeLessThan(1e-6);
    expect(rh >= 0.75).toBe(false);
  });

  it('⑥ ★ 재시도 방지 — cellAreaRatio 는 깊이 붕괴 탐지기가 아니다(무력함이 실측돼 26회차에 배선을 제거했다)', () => {
    // 격자는 `buildAtPhase` 가 slotWidthM × slotDepthM 로 세우므로, 같은 모델로 역투영하면
    // 지상 면적이 **정확히** 규격면적으로 되돌아온다. 25회차 실측(시뮬 155칸 · 야간 60칸)에서
    // |ratio − 1| 의 최대가 시뮬 5.218048215738236e-15 · 야간 7.327471962526033e-15 = 배정도 잡음이었다.
    //
    // ★ 26회차 R2: 이 실측을 근거로 `BayDetectOpts.cellAreaRatioMin/Max` 와 `bayGrid` 칸 필터 배선을
    //   **제거**했다(승격 계획 없음 · CLAUDE.md §2). 배선은 사라졌지만 **이 사실은 배선 없이도 성립**하므로
    //   여기 남긴다 — 야간 「과대 면」은 픽셀 투영이 팽창한 것이지 지상 면적이 커진 것이 아니고,
    //   `cellAreaRatio` 는 붕괴한 그 모델 자신으로 재기 때문에 **원리적으로 붕괴를 볼 수 없다**.
    //   27회차가 이 축으로 「과대 면」을 거를 수 있다고 다시 기대하지 마라. 모델 **밖**의 양이 필요하다
    //   (지평선까지의 픽셀 거리 · 칸의 픽셀 종횡비 · mPerPx 절대값).
    const g = model();
    for (const depth of [6, 12, 24, 48, 96]) {
      const q = quadAtDepth(g, depth, OPTS.slotWidthM, OPTS.slotDepthM);
      if (!q) continue;
      const r = cellAreaRatioOf(q, g, OPTS) as number;
      expect(Math.abs(r - 1)).toBeLessThan(1e-9);
    }
  });
});
