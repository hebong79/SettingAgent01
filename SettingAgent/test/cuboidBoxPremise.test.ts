// ★★ **직육면체 전제의 사각(blind spot)** — Loop 2 실데이터 실패를 봉인한다.
//
// 배경: v1/v2 는 "육면체 8점 투영의 min y 를 마스크 상단에 맞추는 역문제"로 차량 높이 H 를 **관측**했다
// (`solveHeight`, 이분탐색). 수학은 옳았다. **전제가 틀렸다: 차는 직육면체가 아니다.**
//
//   · 마스크 상단에 맞춰지는 접점은 **언제나 모델의 뒤-상단 코너**(= tFront + PRIOR_L, 4.7m 뒤)다.
//   · 그러나 차의 최상단 실루엣 점(**지붕**)은 4.7m 뒤에 없다 — 지붕은 **짧고 안쪽으로 물러난 슬래브**다.
//   · 뒤-상단 코너가 실제 지붕보다 멀리 있어 이미지에서 **더 위로** 투영된다
//     → 마스크 상단에 맞추려면 h 를 **낮춰야** 한다 → **계통적 H 과소.**
//
// 실데이터 실측(refframe 3장 × 실 VPD seg, GT = 시뮬레이터 차량 전고 1.445m):
//   H 오차 중앙값 −0.30(p1) / −0.31(p2) / −0.40(p3) m — near-edge 적합으로 고쳐도 **그대로였다**
//   (tFront 는 애초에 밀려 있지 않았다: v1 최빈 vs v2 near-edge 차이 0.00~0.24m, 재투영 앞선 오차 2.7~5.6px).
//   GT 높이 육면체를 재투영하면 상단이 실제 마스크 상단보다 **29~66px 위**에 있었다.
//
// ∴ **H = 차종 prior 고정**(`CuboidSource.H: 'prior'` 리터럴). `solveHeight` 는 제거됐다.
//    배치 성공기준은 **G2b(앞선 픽셀거리 ≤ 8px)** 이지 H 가 아니다.
//    원리적으로 옳은 길은 육면체 실루엣 ↔ 마스크 정합이다(**후속 과제** — 지금 만들지 않는다, CLAUDE.md §2).
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ **픽스처 자기복사 함정 — 이번 Loop 의 가장 값진 교훈. 다음 사람은 반드시 읽어라.**
//
//   최초 구현의 합성 픽스처는 마스크를 **직육면체 8점의 볼록껍질**로 만들었다.
//   그러면 실루엣 최상단이 **정의상** 뒤-상단 코너가 되므로 `solveHeight` 는 **항상 GT 를 정확히 복원**했다.
//   → **픽스처가 검증 대상의 가정(차=직육면체)을 그대로 복사하고 있었다.** 테스트는 통과했고, 실데이터는 실패했다.
//   → 이 파일의 `carLikeMask()` 는 **지붕 슬래브를 짧고 물러나게** 만들어 그 가정을 의도적으로 깬다.
//   **H·실루엣 관련 로직을 육면체-껍질 픽스처로 검증하지 마라.**
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { buildVehicleCuboids, type SegVehicle } from '../src/ground/contact.js';
import { computeAnchorMetrics } from '../src/ground/anchor.js';
import { DEFAULT_ANCHOR_OPTIONS, DEFAULT_CONTACT_OPTIONS } from '../src/ground/contactTypes.js';
import type { Px, Vec3 } from '../src/ground/contactTypes.js';
import { projectCuboidPixels, projectToPixel } from '../src/ground/project.js';
import { convexHull } from '../src/domain/polygon.js';
import { iou } from '../src/domain/geometry.js';
import type { GroundModel } from '../src/ground/types.js';

/** ★ 검증용 GT — **이 파일에만 존재한다.** 프로덕션 `PRIOR_H`(1.45) 와 물리적으로 분리(순환논법 금지). */
const GT_HEIGHT_M = 1.445;

const DEG = Math.PI / 180;

function makeGround(tiltDeg: number): GroundModel {
  const t = tiltDeg * DEG;
  return {
    camIdx: 1, presetIdx: 1, imgW: 1920, imgH: 1080, zoom: 1, f: 1500,
    n: [0, Math.cos(t), Math.sin(t)], d: 5.0, tiltDeg, ptzTiltDeg: null, tiltErrDeg: null,
    slotBearingDeg: null, bearingDevDeg: null, dDevRel: null, depthEdgePx: 400,
    metricErr: 0, conf: 1, source: 'file', issues: [],
  };
}

/** 지면 기저(폭축 u / 깊이축 w = 카메라에서 멀어지는 쪽) + 지면점 생성기. */
function basis(g: GroundModel) {
  const t = g.tiltDeg * DEG;
  const O: Vec3 = [0, g.d * g.n[1], g.d * g.n[2]];
  const u: Vec3 = [1, 0, 0];
  const w: Vec3 = [0, -Math.sin(t), Math.cos(t)];
  const X = (a: number, b: number): Vec3 => [
    O[0] + a * u[0] + b * w[0],
    O[1] + a * u[1] + b * w[1],
    O[2] + a * u[2] + b * w[2],
  ];
  const up = (p: Vec3, h: number): Vec3 => [p[0] - h * g.n[0], p[1] - h * g.n[1], p[2] - h * g.n[2]];
  const P = (p: Vec3): Px => projectToPixel(p, g)!;
  return { X, up, P };
}

/** 슬롯 스트립 5칸(2.5 × 5.0m). PixelQuad 규약 p0=근좌, p1=원좌, p2=원우, p3=근우. */
function slotStrip(g: GroundModel, da = 0, db = 0): Px[][] {
  const { X, P } = basis(g);
  const out: Px[][] = [];
  for (let k = -2; k <= 2; k++) {
    const a0 = k * 2.5 - 1.25 + da;
    const a1 = a0 + 2.5;
    out.push([P(X(a0, 3 + db)), P(X(a0, 8 + db)), P(X(a1, 8 + db)), P(X(a1, 3 + db))]);
  }
  return out;
}

const CAR = { W: 1.85, L: 4.7, B_FRONT: 3.5 };
/** 지붕 슬래브: 앞범퍼에서 1.9~4.0m(= 길이 2.1m, 뒤끝이 차 뒤끝보다 **0.7m 앞**). 세단의 실제 형상. */
const ROOF = { back: 1.9, front: 4.0, halfW: 0.72 };

/**
 * ⚠️ **함정 픽스처** — 육면체 8점의 볼록껍질. 실루엣 최상단이 **정의상** 뒤-상단 코너다.
 * 검증 대상의 가정을 복사하므로 **H 검증에 쓰면 안 된다**(그 사실을 아래 테스트가 봉인한다).
 */
function boxHullMask(g: GroundModel, aC: number, h: number): Px[] {
  const { X, up, P } = basis(g);
  const pts: Vec3[] = [];
  for (const [a, b] of [
    [aC - CAR.W / 2, CAR.B_FRONT], [aC + CAR.W / 2, CAR.B_FRONT],
    [aC + CAR.W / 2, CAR.B_FRONT + CAR.L], [aC - CAR.W / 2, CAR.B_FRONT + CAR.L],
  ] as const) {
    const gp = X(a, b);
    pts.push(gp, up(gp, h));
  }
  return convexHull(pts.map(P)) as Px[];
}

/**
 * ★ **차다운 마스크** — 바닥면(4점, z=0) + **짧고 물러난 지붕 슬래브**(4점, z=h).
 * 이것이 실제 차의 실루엣에 가깝다. 최상단 점은 **지붕 뒤끝(b = 앞범퍼 + 4.0m)** 이지
 * **차 뒤끝(+4.7m)이 아니다** — 바로 이 0.7m 차이가 H 를 계통적으로 무너뜨린 원인이다.
 */
function carLikeMask(g: GroundModel, aC: number, h: number): Px[] {
  const { X, up, P } = basis(g);
  const pts: Vec3[] = [];
  for (const [a, b] of [
    [aC - CAR.W / 2, CAR.B_FRONT], [aC + CAR.W / 2, CAR.B_FRONT],
    [aC + CAR.W / 2, CAR.B_FRONT + CAR.L], [aC - CAR.W / 2, CAR.B_FRONT + CAR.L],
  ] as const) {
    pts.push(X(a, b)); // 바닥면 4점.
  }
  for (const [a, b] of [
    [aC - ROOF.halfW, CAR.B_FRONT + ROOF.back], [aC + ROOF.halfW, CAR.B_FRONT + ROOF.back],
    [aC + ROOF.halfW, CAR.B_FRONT + ROOF.front], [aC - ROOF.halfW, CAR.B_FRONT + ROOF.front],
  ] as const) {
    pts.push(up(X(a, b), h)); // 지붕 슬래브 4점(짧고 물러남).
  }
  return convexHull(pts.map(P)) as Px[];
}

/** 앞범퍼 접지선(b = B_FRONT)에 정확히 놓인 GT footprint. */
function trueFootprint(g: GroundModel, aC: number): [Vec3, Vec3, Vec3, Vec3] {
  const { X } = basis(g);
  return [
    X(aC - CAR.W / 2, CAR.B_FRONT),
    X(aC + CAR.W / 2, CAR.B_FRONT),
    X(aC + CAR.W / 2, CAR.B_FRONT + CAR.L),
    X(aC - CAR.W / 2, CAR.B_FRONT + CAR.L),
  ];
}

/** 육면체 8점 재투영의 최상단 y. `solveHeight` 가 마스크 상단과 맞추려 했던 바로 그 값. */
function cuboidTopY(g: GroundModel, floor: readonly Vec3[], h: number): number {
  return Math.min(...projectCuboidPixels(floor, h, g)!.map((p) => p.y));
}

const maskTopY = (mask: Px[]): number => Math.min(...mask.map((p) => p.y));

describe('직육면체 전제의 사각 — H 는 마스크 상단으로 관측할 수 없다', () => {
  // ★ 핵심 봉인. **정확한 footprint + 정확한 높이**를 줘도, 재투영 상단은 마스크 상단보다 **위**에 있다.
  //   → 옛 solveHeight 는 이 간극을 h 를 낮춰서 메웠다(= 계통적 과소추정). 그 인과를 여기서 못 박는다.
  it.each([
    { preset: 'p1(얕은 tilt)', tiltDeg: 6.9 },
    { preset: 'p3(급 tilt)', tiltDeg: 18.8 },
  ])('$preset: GT footprint + GT 높이여도 재투영 상단이 마스크 상단보다 **위**에 있다', ({ tiltDeg }) => {
    const g = makeGround(tiltDeg);
    const mask = carLikeMask(g, 0, GT_HEIGHT_M);
    const floor = trueFootprint(g, 0);

    const topY = cuboidTopY(g, floor, GT_HEIGHT_M);
    const deltaPx = topY - maskTopY(mask);

    // 음수 = 모델의 뒤-상단 코너가 실제 지붕보다 **위**로 투영된다(실데이터: −29 ~ −66px).
    expect(deltaPx).toBeLessThan(-5);
  });

  it('그 간극은 h 를 낮춰야만 메워진다 — 즉 옛 역문제는 H 를 **계통적으로 과소**추정한다', () => {
    const g = makeGround(18.8);
    const mask = carLikeMask(g, 0, GT_HEIGHT_M);
    const floor = trueFootprint(g, 0);
    const target = maskTopY(mask);

    // 옛 solveHeight 의 재현(단조 이분탐색) — 제거된 로직을 여기서만 복원해 **틀렸음을 증명**한다.
    let lo = 0.05;
    let hi = 6.0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (cuboidTopY(g, floor, mid) - target > 0) lo = mid;
      else hi = mid;
    }
    const hSolved = (lo + hi) / 2;

    expect(hSolved).toBeLessThan(GT_HEIGHT_M - 0.1); // 과소. (실데이터 −0.30 ~ −0.42m)
    expect(hSolved).toBeGreaterThan(0.5); // 그럴듯해 보이는 값이라 **조용히** 틀린다 — 그래서 위험했다.
  });

  // ⚠️ 픽스처 자기복사 함정의 봉인. 육면체-껍질 마스크는 **가정을 복사**하므로 항상 통과한다.
  it('⚠️ 육면체-껍질 픽스처는 이 오류를 **못 잡는다**(자기복사) — H 검증에 쓰지 말 것', () => {
    const g = makeGround(18.8);
    const boxMask = boxHullMask(g, 0, GT_HEIGHT_M);
    const floor = trueFootprint(g, 0);

    // 껍질 마스크의 상단 = 정의상 뒤-상단 코너 → 간극이 0 → 옛 역문제가 GT 를 "정확히" 복원한다(거짓 안심).
    expect(Math.abs(cuboidTopY(g, floor, GT_HEIGHT_M) - maskTopY(boxMask))).toBeLessThan(1);
  });

  it('현재 구현: H 는 관측하지 않고 차종 prior 를 쓴다 — source.H 는 항상 prior', () => {
    const g = makeGround(6.9);
    const vehicles: SegVehicle[] = [-2.5, 0, 2.5].map((aC) => ({
      vpdIdx: 0,
      mask: carLikeMask(g, aC, GT_HEIGHT_M),
      cls: 'car',
      confidence: 0.9,
    }));
    const r = buildVehicleCuboids({
      vehicles, slotPolysPx: slotStrip(g), ground: g,
      slotWidthM: 2.5, slotDepthM: 5.0, opts: DEFAULT_CONTACT_OPTIONS,
    });
    expect(r.cuboids.length).toBe(3);
    for (const c of r.cuboids) {
      expect(c.source.H).toBe('prior'); // 타입도 리터럴로 막지만, 런타임도 봉인한다.
      expect(c.heightM).toBe(DEFAULT_CONTACT_OPTIONS.priorH);
      expect(c.source.L).toBe('prior');
      expect(c.source.position).toBe('observed');
    }
    // ★ PRIOR_H 는 GT 가 아니다(순환논법 금지). 우연히 가깝더라도 **같은 값이면 안 된다**.
    expect(DEFAULT_CONTACT_OPTIONS.priorH).not.toBe(GT_HEIGHT_M);
  });
});

describe('IoU 를 성공기준으로 쓰지 말 것 — 실제로 일어난 실패를 통과시킨다', () => {
  // ⚠️ **주장을 정확히 한다(과장 금지).** IoU 가 *모든* 배치 오류에 둔감한 것은 아니다 —
  //    footprint 를 크게 밀면 IoU 도 떨어진다(합성 확인: 깊이 2m 밀림 → IoU 0.30).
  //    봉인하는 사실은 **실제로 일어난 실패 모드**에 대한 것이다:
  //    **H 가 0.30~0.44m 과소인 육면체(= 우리가 실데이터에서 만든 바로 그것)가 IoU 0.65~0.74 를 받았다.**
  //    IoU 는 그 실패를 통과시켰고, 육안(G3)은 통과시키지 않았다. → **게이트로 부적합.**
  it('H 가 과소한 육면체(실제 실패 모드)를 IoU 는 높은 점수로 통과시킨다', () => {
    const g = makeGround(18.8);
    const mask = carLikeMask(g, 0, GT_HEIGHT_M);
    const floor = trueFootprint(g, 0); // ★ footprint(배치)는 정확하다 — 틀린 건 H 뿐이다(실데이터와 동일 상황).
    const xs = mask.map((p) => p.x);
    const ys = mask.map((p) => p.y);
    const maskRect = {
      x: Math.min(...xs) / g.imgW, y: Math.min(...ys) / g.imgH,
      w: (Math.max(...xs) - Math.min(...xs)) / g.imgW, h: (Math.max(...ys) - Math.min(...ys)) / g.imgH,
    };
    const iouAt = (h: number) => {
      const px = projectCuboidPixels(floor, h, g)!;
      const bx = px.map((p) => p.x);
      const by = px.map((p) => p.y);
      return iou(
        {
          x: Math.min(...bx) / g.imgW, y: Math.min(...by) / g.imgH,
          w: (Math.max(...bx) - Math.min(...bx)) / g.imgW, h: (Math.max(...by) - Math.min(...by)) / g.imgH,
        },
        maskRect,
      );
    };

    // 옛 solveHeight 가 뱉던 과소 높이(실데이터: 1.00~1.09m @ p3).
    const hUnder = 1.05;
    expect(GT_HEIGHT_M - hUnder).toBeGreaterThan(0.3); // 0.4m 나 틀렸다.
    expect(iouAt(hUnder)).toBeGreaterThan(0.6); // 그런데 IoU 는 높다 → **실패를 통과시킨다**(실데이터 0.74).
  });

  // 🔴 **삭제된 테스트 — "G2b 는 배치 밀림에 반응한다. 이것이 배치 성공기준이다"** (구현자, Loop 2)
  //
  //   그 테스트는 재투영 앞선을 **`trueFrontPx`(합성 GT)** 와 비교하는 로컬 헬퍼를 재고 있었다.
  //   그러나 **프로덕션 `frontFitResidPx` 에는 GT 가 없다** — 앞선을 **자기가 적합된 관측 밴드**와 비교한다.
  //   ∴ **테스트가 프로덕션과 다른 함수를 검증했다.** 통과했고, 실제 지표에는 그 성질이 **없다**.
  //
  //   ⚠️⚠️ **이 파일 헤더가 경고한 "픽스처 자기복사 함정"이 한 단계 위에서 그대로 재발했다**
  //         (검증자 D-1 이 발견, 구현자 재현). 함정을 봉인하면서 같은 함정에 빠졌다는 것이
  //         이 교훈의 위력이자 이번 Loop 의 결론이다: **테스트는 반드시 프로덕션 함수를 호출해야 한다.**
  //
  //   실증(프로덕션 `frontFitResidPx` 호출, tilt 12°): 마스크 하단이 z 만큼 뜨면 접지선이 `D·z/(d−z)` 뒤로 밀리는데
  //       z=0.10m → 배치 +0.43m 오차 / frontFitResidPx **0.00px** (8px 게이트 통과)
  //       z=0.30m → 배치 **+1.34m** 오차 / frontFitResidPx **0.00px** (통과)
  //   → 봉인 위치: **`test/cuboidBoundary.test.ts` §5 「★★ G2b 의 사각」**(검증자 작성, 프로덕션 함수 직접 호출).
  //   → `frontFitResidPx` 는 **배치 게이트가 아니라 앞선 직선성 advisory** 다. 배치 정확도 지표는 **미해결**(리더 판단 대기).
});

describe('앵커 Δ 회귀 — H 를 prior 로 고정해도 불변(앵커는 H 를 쓰지 않는다)', () => {
  const g = makeGround(20);
  const vehicles: SegVehicle[] = [-2.5, 0, 2.5].map((aC) => ({
    vpdIdx: 0,
    mask: carLikeMask(g, aC, GT_HEIGHT_M),
    cls: 'car',
    confidence: 0.9,
  }));
  const anchorAt = (da: number, db: number) => {
    const slots = slotStrip(g, da, db);
    const r = buildVehicleCuboids({
      vehicles, slotPolysPx: slots, ground: g,
      slotWidthM: 2.5, slotDepthM: 5.0, opts: DEFAULT_CONTACT_OPTIONS,
    });
    return computeAnchorMetrics(r.cuboids, slots, g, r.axes, { ...DEFAULT_ANCHOR_OPTIONS, periodM: 2.5 });
  };
  const base = anchorAt(0, 0);

  it('깊이축 +2.5m → Δ depthDevM = −2.500 (비주기 → 선형·정확)', () => {
    const a = anchorAt(0, 2.5);
    expect(a.depthDevM! - base.depthDevM!).toBeCloseTo(-2.5, 6);
  });

  it('폭축 +1.25m(반 칸) → Δ phaseDevM = ∓1.250 (최대 반응)', () => {
    const a = anchorAt(1.25, 0);
    expect(Math.abs(a.phaseDevM! - base.phaseDevM!)).toBeCloseTo(1.25, 6);
    expect(a.depthDevM! - base.depthDevM!).toBeCloseTo(0, 6); // 깊이축은 폭축 밀림에 불변.
  });

  // ★ 원리적 한계 — **통과 테스트로 봉인**(은닉 금지). 폭축 정수배는 격자가 자기 자신과 겹쳐 침묵한다.
  it('★ 폭축 +2.5m(정수배) → 3지표 **전부 침묵**(원리적 한계 — 과대보고 금지)', () => {
    const a = anchorAt(2.5, 0);
    expect(a.phaseDevM! - base.phaseDevM!).toBeCloseTo(0, 6); // 주기 2.5m → 위상 불변.
    expect(a.depthDevM! - base.depthDevM!).toBeCloseTo(0, 6);
    expect(a.unmatchedRate).toBe(0); // ⚠️ unmatchedRate 도 0 이다(설계 §6-5 의 "약한 반응" 예측은 **틀렸다**).
  });
});
