import { describe, it, expect } from 'vitest';
import { computeCropWindow, toCropPoint, backmapQuad, gridCenter } from '../src/calibrate/cropZoom.js';
import type { NormalizedRect, NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 앞면중심 디지털 크롭-줌 순수 기하(설계서 §2-1·§3·§4, 외부의존 0).
 * - T-1 역계산 왕복 파리티(핵심): 원본 quad → toCropPoint(W) → backmapQuad(W) == 원본(오차<1e-9).
 *   여러 창 W·여러 quad(기운 OBB 포함). 업스케일 배율은 식에 없음 → frac 크기와 무관하게 성립.
 * - T-2 computeCropWindow: frac·aspect 로 h=frac·aspect, 중심 정렬, 모서리 center 클램프(크기 보존·[0,1] 유지),
 *   frac·aspect>1 / frac>1 시 크기 1 클램프.
 * - toCropPoint 창밖 점은 [0,1] 벗어남(그대로).
 */

const EPS = 1e-9;

function expectQuadClose(a: NormalizedQuad, b: NormalizedQuad, eps = EPS): number {
  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    maxErr = Math.max(maxErr, Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
  }
  expect(maxErr).toBeLessThan(eps);
  return maxErr;
}

// 원본 정규화 quad 표본(축정렬 + 기운 OBB + 프레임 넓게 퍼진 것).
const quads: Record<string, NormalizedQuad> = {
  axis: [{ x: 0.30, y: 0.40 }, { x: 0.36, y: 0.40 }, { x: 0.36, y: 0.44 }, { x: 0.30, y: 0.44 }],
  tilted: [{ x: 0.42, y: 0.55 }, { x: 0.58, y: 0.50 }, { x: 0.62, y: 0.60 }, { x: 0.46, y: 0.66 }],
  wide: [{ x: 0.05, y: 0.10 }, { x: 0.95, y: 0.08 }, { x: 0.90, y: 0.92 }, { x: 0.08, y: 0.88 }],
};

// 다양한 창 W: 순수 리터럴 + computeCropWindow 산출(중심/모서리 클램프).
const ASPECT = 1920 / 1080; // 16:9
const windows: Record<string, NormalizedRect> = {
  literalCenter: { x: 0.30, y: 0.15, w: 0.40, h: 0.70 },
  literalSmall: { x: 0.48, y: 0.47, w: 0.05, h: 0.06 },
  computedCenter: computeCropWindow({ x: 0.5, y: 0.5 }, 0.4, ASPECT),
  computedCornerClamp: computeCropWindow({ x: 0.98, y: 0.02 }, 0.4, ASPECT),
  computedTiny: computeCropWindow({ x: 0.5, y: 0.5 }, 0.05, ASPECT),
};

describe('cropZoom · T-1 역계산 왕복 파리티(backmapQuad ∘ toCropPoint == id)', () => {
  for (const [wn, W] of Object.entries(windows)) {
    for (const [qn, Q] of Object.entries(quads)) {
      it(`창=${wn} · quad=${qn} → 왕복 오차 < 1e-9`, () => {
        const cropQuad = Q.map((p) => toCropPoint(p, W)) as unknown as NormalizedQuad;
        const back = backmapQuad(cropQuad, W);
        expectQuadClose(back, Q);
      });
    }
  }

  it('업스케일 배율 무관: 역매핑 식(backmapQuad)에 scale 항이 없음 → frac 크기와 무관하게 파리티 성립', () => {
    // 동일 quad 를 실효줌 다른(=frac 다른) 창들로 왕복해도 전부 <1e-9.
    const Q = quads.tilted;
    const fracs = [0.9, 0.4, 0.144, 0.05];
    let worst = 0;
    for (const frac of fracs) {
      const W = computeCropWindow({ x: 0.5, y: 0.58 }, frac, ASPECT);
      const cropQuad = Q.map((p) => toCropPoint(p, W)) as unknown as NormalizedQuad;
      worst = Math.max(worst, expectQuadClose(backmapQuad(cropQuad, W), Q));
    }
    // 리더 sharp 기하 검증(1.11e-16)과 동급의 부동소수 왕복 오차만 남는다.
    expect(worst).toBeLessThan(1e-12);
  });
});

describe('cropZoom · T-2 computeCropWindow', () => {
  it('중심 정렬 · w=frac · h=frac·aspect(픽셀 정사각)', () => {
    const W = computeCropWindow({ x: 0.5, y: 0.5 }, 0.4, ASPECT);
    expect(W.w).toBeCloseTo(0.4, 12);
    expect(W.h).toBeCloseTo(0.4 * ASPECT, 12); // 0.7111…
    // 중심 유지(클램프 없는 중앙).
    expect(W.x + W.w / 2).toBeCloseTo(0.5, 12);
    expect(W.y + W.h / 2).toBeCloseTo(0.5, 12);
  });

  it('모서리 center 클램프: 창 크기 보존 + [0,1] 내부 유지(밖으로 안 나감)', () => {
    const W = computeCropWindow({ x: 0.98, y: 0.02 }, 0.4, ASPECT);
    // 크기 보존(w=0.4, h=0.711).
    expect(W.w).toBeCloseTo(0.4, 12);
    expect(W.h).toBeCloseTo(0.4 * ASPECT, 12);
    // 위치만 시프트되어 [0,1] 안: x∈[0,1-w], y∈[0,1-h].
    expect(W.x).toBeGreaterThanOrEqual(0);
    expect(W.y).toBeGreaterThanOrEqual(0);
    expect(W.x + W.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(W.y + W.h).toBeLessThanOrEqual(1 + 1e-12);
    // 우상단 모서리 → x 는 오른쪽 끝(1-w=0.6), y 는 위쪽 끝(0).
    expect(W.x).toBeCloseTo(0.6, 12);
    expect(W.y).toBeCloseTo(0, 12);
  });

  it('frac·aspect>1 → 높이 1 클램프 후 0 정렬', () => {
    const W = computeCropWindow({ x: 0.5, y: 0.5 }, 0.7, ASPECT); // 0.7·1.778=1.244 → 1
    expect(W.h).toBe(1);
    expect(W.y).toBe(0);
    expect(W.w).toBeCloseTo(0.7, 12);
  });

  it('frac>1 → 폭 1 클램프 후 0 정렬', () => {
    const W = computeCropWindow({ x: 0.5, y: 0.5 }, 1.5, 1.0);
    expect(W.w).toBe(1);
    expect(W.x).toBe(0);
    expect(W.h).toBe(1);
    expect(W.y).toBe(0);
  });
});

describe('cropZoom · V-1 gridCenter(격자 오프셋 중심 산출)', () => {
  it('off(0,0) → 앵커 그대로(하향된 중심 = k=1 중심)', () => {
    const anchor: NormalizedPoint = { x: 0.42, y: 0.58 };
    const c = gridCenter(anchor, 0.4, ASPECT, { dx: 0, dy: 0 });
    expect(c.x).toBeCloseTo(0.42, 15);
    expect(c.y).toBeCloseTo(0.58, 15);
  });

  it('dy=0.5 → y 가 창높이(min(1,frac·aspect)) 절반만큼 증가', () => {
    const anchor: NormalizedPoint = { x: 0.5, y: 0.5 };
    const frac = 0.3; // frac·aspect = 0.533 < 1 → 클램프 없음
    const c = gridCenter(anchor, frac, ASPECT, { dx: 0, dy: 0.5 });
    expect(c.x).toBeCloseTo(0.5, 15); // dx=0 → x 불변
    expect(c.y).toBeCloseTo(0.5 + 0.5 * (frac * ASPECT), 15); // +0.5·0.5333 = +0.2667
  });

  it('dx=-0.5 → x 가 창폭(min(1,frac)) 절반만큼 감소(좌 이동)', () => {
    const anchor: NormalizedPoint = { x: 0.5, y: 0.5 };
    const frac = 0.4;
    const c = gridCenter(anchor, frac, 1.0, { dx: -0.5, dy: 0 });
    expect(c.x).toBeCloseTo(0.5 - 0.5 * frac, 15); // 0.5 - 0.2 = 0.3
    expect(c.y).toBeCloseTo(0.5, 15);
  });

  it('frac·aspect>1 → dy 이동량이 min(1,·)=1 로 클램프 반영', () => {
    const anchor: NormalizedPoint = { x: 0.5, y: 0.2 };
    const frac = 0.7; // 0.7·1.778 = 1.244 → min(1,·)=1
    const c = gridCenter(anchor, frac, ASPECT, { dx: 0, dy: 0.5 });
    expect(c.y).toBeCloseTo(0.2 + 0.5 * 1, 15); // 창높이 1 의 절반 = +0.5
    // x 는 min(1,frac)=0.7 배(클램프 미발동): dx=0 → 불변.
    expect(c.x).toBeCloseTo(0.5, 15);
  });

  it('frac>1 → dx 이동량이 min(1,frac)=1 로 클램프 반영', () => {
    const c = gridCenter({ x: 0.5, y: 0.5 }, 1.5, 1.0, { dx: 0.5, dy: 0 });
    expect(c.x).toBeCloseTo(0.5 + 0.5 * 1, 15); // +0.5 (창폭 1)
  });
});

describe('cropZoom · V-2 오프셋·클램프 창 왕복 파리티(gridCenter→computeCropWindow→backmapQuad∘toCropPoint==id)', () => {
  const GRID_OFFSETS = [
    { dx: 0, dy: 0 },
    { dx: 0, dy: 0.5 },
    { dx: -0.5, dy: 0.5 },
    { dx: 0.5, dy: 0.5 },
    { dx: 0, dy: 1.0 },
  ];
  // 중앙 앵커(클램프 없음) + 모서리 앵커(클램프 다수 발생) 두 케이스로 오프셋 창 전체 왕복.
  const anchors: Record<string, NormalizedPoint> = {
    center: { x: 0.5, y: 0.5 },
    corner: { x: 0.95, y: 0.9 }, // 하우 오프셋에서 창이 [0,1] 밖 → 클램프 시프트 케이스
  };
  const fracs = [0.4, 0.24]; // 줌 2레벨

  for (const [an, anchor] of Object.entries(anchors)) {
    for (const frac of fracs) {
      for (let oi = 0; oi < GRID_OFFSETS.length; oi++) {
        it(`앵커=${an} · frac=${frac} · off#${oi} → 왕복 오차 < 1e-9`, () => {
          const c = gridCenter(anchor, frac, ASPECT, GRID_OFFSETS[oi]);
          const W = computeCropWindow(c, frac, ASPECT);
          // 오프셋·클램프로 창이 어디로 갔든 backmapQuad 는 창 offset/size 만 쓰므로 왕복 불변.
          for (const [, Q] of Object.entries(quads)) {
            const cropQuad = Q.map((p) => toCropPoint(p, W)) as unknown as NormalizedQuad;
            expectQuadClose(backmapQuad(cropQuad, W), Q);
          }
        });
      }
    }
  }
});

describe('cropZoom · toCropPoint 창밖 점', () => {
  it('창 왼쪽/위 밖 점 → 음수(정규화 [0,1] 벗어남, 클램프 안 함)', () => {
    const W: NormalizedRect = { x: 0.30, y: 0.20, w: 0.40, h: 0.40 };
    const outLeftTop: NormalizedPoint = { x: 0.10, y: 0.05 };
    const p = toCropPoint(outLeftTop, W);
    expect(p.x).toBeLessThan(0); // (0.1-0.3)/0.4 = -0.5
    expect(p.y).toBeLessThan(0); // (0.05-0.2)/0.4 = -0.375
  });

  it('창 오른쪽/아래 밖 점 → 1 초과', () => {
    const W: NormalizedRect = { x: 0.30, y: 0.20, w: 0.40, h: 0.40 };
    const outRightBot: NormalizedPoint = { x: 0.90, y: 0.75 };
    const p = toCropPoint(outRightBot, W);
    expect(p.x).toBeGreaterThan(1); // (0.9-0.3)/0.4 = 1.5
    expect(p.y).toBeGreaterThan(1); // (0.75-0.2)/0.4 = 1.375
  });

  it('창 내부 점 → [0,1] 안, 중심은 0.5', () => {
    const W = computeCropWindow({ x: 0.5, y: 0.5 }, 0.4, ASPECT);
    const c = toCropPoint({ x: 0.5, y: 0.5 }, W);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0.5, 12);
  });
});
