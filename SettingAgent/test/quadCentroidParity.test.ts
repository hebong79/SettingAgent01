import { describe, it, expect } from 'vitest';
import { quadCentroid as srvQuadCentroid, center, quadBoundingRect } from '../src/domain/geometry.js';
import { polygonCentroid } from '../src/domain/polygon.js';
import { quadCentroid as webQuadCentroid } from '../web/core.js';
import type { NormalizedQuad } from '../src/domain/types.js';

/**
 * **번호판 중심 정의의 서버(TypeScript) ↔ 뷰어(web/core.js) 파리티** — D-1 봉인.
 * 선례: `test/globalIdxParity.test.ts`(전역번호 규칙 파리티).
 *
 * 왜 이중구현인가: 점유 판정 `web/core.js:computeOccupancy` 는 브라우저에서 돌고,
 * 그 판정을 **선점하는** LPD 필터 `onPlaceFilter.filterPlatesOnPlace` (B)항은 서버에서 돈다.
 * 두 중심 정의가 갈리면 — 실제로 갈려 있었다(D-1: 서버 bbox 중심 vs 뷰어 4점 평균) —
 * *4점평균은 폴리곤 안인데 bbox중심은 밖*인 quad 를 서버가 드롭해 **점유가 경고 없이 false 로 뒤집힌다**.
 * → 같은 quad 에 **같은 중심**임을 못 박는다(HANDOFF §2-5: 불가피한 이중구현은 파리티로 봉인).
 */

/** 두 스택에 같은 quad 를 통과시킨다. web 은 배열 검증 후 null 을 낼 수 있으므로 non-null 을 단언한다. */
function both(q: NormalizedQuad) {
  const web = webQuadCentroid(q);
  expect(web).not.toBeNull(); // 유효 4점 quad 는 web 에서 절대 null 이 아니다.
  return { srv: srvQuadCentroid(q), web: web as { x: number; y: number } };
}

/** 중심 (cx,cy) 를 th 만큼 회전시킨 아핀 OBB(중심대칭). */
function rotatedObb(cx: number, cy: number, hw: number, hh: number, th: number): NormalizedQuad {
  const rot = (dx: number, dy: number) => ({
    x: cx + dx * Math.cos(th) - dy * Math.sin(th),
    y: cy + dx * Math.sin(th) + dy * Math.cos(th),
  });
  return [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
}

const CASES: Array<{ name: string; quad: NormalizedQuad }> = [
  {
    name: '축정렬 직사각형',
    quad: [
      { x: 0.40, y: 0.30 },
      { x: 0.46, y: 0.30 },
      { x: 0.46, y: 0.34 },
      { x: 0.40, y: 0.34 },
    ],
  },
  {
    name: '기울어진 keystone(원근 왜곡 — 비아핀, 두 중심 정의가 갈리는 실측형)',
    quad: [
      { x: 0.408, y: 0.4405 },
      { x: 0.452, y: 0.4420 },
      { x: 0.456, y: 0.4700 },
      { x: 0.404, y: 0.4660 },
    ],
  },
  {
    name: '★ D-1 반례 quad(비아핀 스파이크) — 4점평균 y=0.4325 · bbox중심 y=0.555',
    quad: [
      { x: 0.40, y: 0.31 },
      { x: 0.44, y: 0.31 },
      { x: 0.42, y: 0.31 },
      { x: 0.42, y: 0.80 },
    ],
  },
  {
    name: '퇴화: 4점이 한 점으로 붕괴(면적 0)',
    quad: [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ],
  },
  {
    name: '퇴화: 4점이 일직선(면적 0 — 면적가중 centroid 는 여기서 NaN/0 이 된다)',
    quad: [
      { x: 0.20, y: 0.40 },
      { x: 0.40, y: 0.40 },
      { x: 0.60, y: 0.40 },
      { x: 0.80, y: 0.40 },
    ],
  },
  {
    name: '경계값: 0/1 코너',
    quad: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  },
  {
    name: '점 순서 역방향(CW↔CCW) — 평균은 순서 무관',
    quad: [
      { x: 0.40, y: 0.34 },
      { x: 0.46, y: 0.34 },
      { x: 0.46, y: 0.30 },
      { x: 0.40, y: 0.30 },
    ],
  },
];

describe('quadCentroid 파리티 — 서버(src/domain/geometry.ts) ≡ 뷰어(web/core.js)', () => {
  for (const c of CASES) {
    it(`${c.name} → 동일 입력 · 동일 출력`, () => {
      const { srv, web } = both(c.quad);
      // 부동소수 오차 허용이 아니라 **비트 동일**을 요구한다(같은 누산 순서 → 같은 값).
      expect(srv).toEqual(web);
    });
  }

  it('회전 OBB 24각도 스윕 → 전 각도에서 서버 ≡ 뷰어', () => {
    for (let i = 0; i < 24; i++) {
      const q = rotatedObb(0.43, 0.38, 0.03, 0.012, (i / 24) * Math.PI);
      const { srv, web } = both(q);
      expect(srv).toEqual(web);
    }
  });

  it('무작위 quad 200개(퇴화 포함) → 전량 서버 ≡ 뷰어', () => {
    let seed = 20260714;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const q: NormalizedQuad = [
        { x: rnd(), y: rnd() },
        { x: rnd(), y: rnd() },
        { x: rnd(), y: rnd() },
        { x: rnd(), y: rnd() },
      ];
      const { srv, web } = both(q);
      expect(srv).toEqual(web);
    }
  });

  it('★ quadCentroid 는 bbox 중심(center∘quadBoundingRect) 과 **다른 함수**다 — 혼동 방지', () => {
    const spike = CASES[2].quad; // D-1 반례
    const mean = srvQuadCentroid(spike);
    const bbox = center(quadBoundingRect(spike));
    expect(mean.y).toBeCloseTo(0.4325, 12);
    expect(bbox.cy).toBeCloseTo(0.555, 12);
    expect(mean.y).not.toBeCloseTo(bbox.cy, 3); // 두 정의는 비아핀 quad 에서 실제로 갈린다.

    // 중심대칭(회전 OBB)에서는 두 정의가 **정확히 일치** → 실 LPD OBB 에서 D-1 이 잠복했던 이유.
    const obb = rotatedObb(0.43, 0.38, 0.03, 0.012, 0.7);
    const m2 = srvQuadCentroid(obb);
    const b2 = center(quadBoundingRect(obb));
    expect(m2.x).toBeCloseTo(b2.cx, 12);
    expect(m2.y).toBeCloseTo(b2.cy, 12);
  });

  it('★ quadCentroid 는 polygonCentroid(면적가중) 와도 **다른 함수**다 — 혼동 방지', () => {
    const spike = CASES[2].quad;
    expect(srvQuadCentroid(spike)).not.toEqual(polygonCentroid(spike));
    // 일직선 퇴화(면적 0): 면적가중은 무의미해지지만 4점 평균은 항상 정의된다.
    const line = CASES[4].quad;
    const mean = srvQuadCentroid(line);
    expect(mean).toEqual({ x: 0.5, y: 0.4 });
    expect(Number.isFinite(mean.x) && Number.isFinite(mean.y)).toBe(true);
  });
});
