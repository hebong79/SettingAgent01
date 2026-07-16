import { describe, it, expect } from 'vitest';
import { plateAxes, buildTrapezoid, clampToUnit, computeOccupancyRegions } from '../web/occupancyRegion.js';
import { convexIntersectionArea, polygonArea } from '../web/occupancy.js';
import { computeOccupancy, quadCentroid } from '../web/core.js';
import { OccupancyJudge } from '../web/occupancy.js';

/**
 * 점유영역 사다리꼴(번호판 앵커) + 겹침 회피 자동 배율 — 설계 §6 T1~T15.
 * 기하 프리미티브(clip/intersect/area)는 occupancyGeometryParity.test.ts 가 별도로 봉인한다.
 */

type Pt = { x: number; y: number };

const AREA_EPS = 1e-6;

/** 중심 (cx,cy), 폭 0.04 · 높이 0.02 의 축정렬 번호판 quad(TL,TR,BR,BL). */
function plateAt(cx: number, cy: number): Pt[] {
  return [
    { x: cx - 0.02, y: cy - 0.01 },
    { x: cx + 0.02, y: cy - 0.01 },
    { x: cx + 0.02, y: cy + 0.01 },
    { x: cx - 0.02, y: cy + 0.01 },
  ];
}

/** quad 를 중심 c 기준 deg 회전. */
function rotateQuad(quad: Pt[], c: Pt, deg: number): Pt[] {
  const r = (deg * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  return quad.map((p) => ({
    x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn,
    y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs,
  }));
}

/** 점 순서를 k 칸 순환 회전([TL,TR,BR,BL] → k=1 → [TR,BR,BL,TL]). 좌표는 불변 — 라벨만 돈다. */
function rotateOrder(quad: Pt[], k: number): Pt[] {
  return quad.slice(k).concat(quad.slice(0, k));
}

const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a: Pt) => Math.hypot(a.x, a.y);

describe('plateAxes — 번호판 축(§2-1)', () => {
  it('T1 축정렬 plate → u≈(1,0), v≈(0,1), width≈0.04, c=quadCentroid', () => {
    const quad = plateAt(0.5, 0.5);
    const ax = plateAxes(quad)!;
    expect(ax).not.toBeNull();
    expect(ax.u.x).toBeCloseTo(1, 12);
    expect(ax.u.y).toBeCloseTo(0, 12);
    expect(ax.v.x).toBeCloseTo(0, 12);
    expect(ax.v.y).toBeCloseTo(1, 12);
    expect(ax.width).toBeCloseTo(0.04, 12);
    expect(ax.c).toEqual(quadCentroid(quad));
  });

  it('T2 30° 회전 plate → 축도 30° 회전, 사다리꼴 위/아래 변 ∥ û (R3 가로)', () => {
    const c = { x: 0.5, y: 0.5 };
    const ax = plateAxes(rotateQuad(plateAt(c.x, c.y), c, 30))!;
    expect(ax.u.x).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(ax.u.y).toBeCloseTo(Math.sin(Math.PI / 6), 12);
    expect(ax.v.x).toBeCloseTo(-Math.sin(Math.PI / 6), 12);
    expect(ax.v.y).toBeCloseTo(Math.cos(Math.PI / 6), 12);

    const [tl, tr, br, bl] = buildTrapezoid(ax, 4.0);
    expect(cross(sub(tr, tl), ax.u)).toBeCloseTo(0, 12); // 위 변 ∥ û
    expect(cross(sub(br, bl), ax.u)).toBeCloseTo(0, 12); // 아래 변 ∥ û
  });

  it('T16 점 순서 90° 순환 회전(장축 TR→BR) → û 가 장축, width ≈ 장축 길이 (회전 전과 동일 축)', () => {
    const quad = plateAt(0.5, 0.5); // 장축 0.04(가로) · 단축 0.02.
    const base = plateAxes(quad)!;
    const rot = plateAxes(rotateOrder(quad, 1))!; // [TR,BR,BL,TL] — 장축이 TR→BR 로 이동.

    expect(rot.u.x).toBeCloseTo(base.u.x, 12);
    expect(rot.u.y).toBeCloseTo(base.u.y, 12);
    expect(rot.v.x).toBeCloseTo(base.v.x, 12);
    expect(rot.v.y).toBeCloseTo(base.v.y, 12);
    expect(rot.width).toBeCloseTo(base.width, 12);
    expect(rot.width).toBeCloseTo(0.04, 12); // 단축 0.02 가 아님 — 장축을 잡았다.
  });

  it('T17 4가지 순환 회전(0/90/180/270°) 전부 → 동일 축·width, buildTrapezoid 근사 동일', () => {
    // 축정렬은 부호 오류를 가릴 수 있으므로 30° 기운 판으로 검증.
    const c = { x: 0.5, y: 0.5 };
    const quad = rotateQuad(plateAt(c.x, c.y), c, 30);
    const base = plateAxes(quad)!;
    const baseTrap = buildTrapezoid(base, 4.0);

    for (const k of [1, 2, 3]) {
      const ax = plateAxes(rotateOrder(quad, k))!;
      expect(ax.u.x).toBeCloseTo(base.u.x, 12);
      expect(ax.u.y).toBeCloseTo(base.u.y, 12);
      expect(ax.v.x).toBeCloseTo(base.v.x, 12);
      expect(ax.v.y).toBeCloseTo(base.v.y, 12);
      expect(ax.width).toBeCloseTo(base.width, 12);

      const trap = buildTrapezoid(ax, 4.0);
      trap.forEach((p, i) => {
        expect(p.x).toBeCloseTo(baseTrap[i].x, 12);
        expect(p.y).toBeCloseTo(baseTrap[i].y, 12);
      });
    }
  });

  it('T18 실검출 회귀(cam1_p2) — 순환 회전된 실 LPD quad 에서 û 가 장축, width ≈ 장축 길이', () => {
    // _workspace/_qa_data/detect_cam1_p2.json → idx 9 의 실제 번호판 quad(정규화 좌표).
    // 03_qa_report.md §3-1: 픽셀 네 변 17.7 / 56.5 / 17.7 / 56.5 — 장축이 TR→BR(라벨 90° 순환 회전).
    const quad: Pt[] = [
      { x: 0.339532, y: 0.598975 },
      { x: 0.340477, y: 0.582672 },
      { x: 0.311222, y: 0.577311 },
      { x: 0.310277, y: 0.593614 },
    ];
    const LONG = len(sub(quad[2], quad[1])); // TR→BR = 장축(정규화 ≈ 0.02975).
    const SHORT = len(sub(quad[1], quad[0])); // TL→TR = 단축(정규화 ≈ 0.01633).
    expect(LONG).toBeGreaterThan(SHORT); // 픽스처 전제 확인.

    const ax = plateAxes(quad)!;
    expect(ax.width).toBeCloseTo(LONG, 6); // 수정 전 버그: SHORT(0.01633)를 잡았다.
    expect(Math.abs(ax.width - SHORT)).toBeGreaterThan(0.01);
    expect(cross(ax.u, sub(quad[2], quad[1]))).toBeCloseTo(0, 6); // û ∥ 장축.
  });

  it('T15 점 순서 180° 반전 quad → v̂.y > 0 로 보정, 위(−v̂) 일관 → T3 성립', () => {
    const c = { x: 0.5, y: 0.5 };
    const flipped = plateAt(c.x, c.y).map((p) => ({ x: 2 * c.x - p.x, y: 2 * c.y - p.y }));
    const ax = plateAxes(flipped)!;
    expect(ax.v.y).toBeGreaterThan(0);
    expect(ax.u.x).toBeCloseTo(1, 12);
    expect(ax.v.y).toBeCloseTo(1, 12);

    const [tl, tr, br, bl] = buildTrapezoid(ax, 4.0);
    const ct = mid(tl, tr);
    const cb = mid(bl, br);
    expect(ct.y).toBeLessThan(ax.c.y); // 위 변이 화면 위쪽.
    expect(len(sub(ct, ax.c))).toBeGreaterThan(len(sub(cb, ax.c)));
  });
});

describe('buildTrapezoid — 사다리꼴 4점(§2-2)', () => {
  const ax = plateAxes(plateAt(0.5, 0.5))!;

  it('T3 위가 길다 → |Ct−C| / |Cb−C| = upRatio/downRatio (0.90/0.60)', () => {
    const [tl, tr, br, bl] = buildTrapezoid(ax, 4.0);
    const ct = mid(tl, tr);
    const cb = mid(bl, br);
    const ratio = len(sub(ct, ax.c)) / len(sub(cb, ax.c));
    // 불변식(R2): 기본값이 어떻게 바뀌든 위가 아래보다 길어야 한다 — 구현을 베끼지 않는 하드코딩 부등식.
    expect(ratio).toBeGreaterThan(1);
    // 확정 기본값 핀: upRatio 0.90 유지 + 마스터 지시로 downRatio 0.30→0.60(아래쪽 2배) → 비 3.00→1.50.
    expect(ratio).toBeCloseTo(0.9 / 0.6, 9);
  });

  it('T4 폭비 → |TR−TL| = 1.0 × |BR−BL|(평행사변형), 반환 순서 [TL,TR,BR,BL] 볼록', () => {
    const poly = buildTrapezoid(ax, 4.0);
    const [tl, tr, br, bl] = poly;
    // 확정 기본값 핀: 마스터 지시로 topWidthRatio 0.85→1.0. 위/아래 변 등폭 = 평행사변형.
    expect(len(sub(tr, tl))).toBeCloseTo(1.0 * len(sub(br, bl)), 12);
    expect(len(sub(br, bl))).toBeCloseTo(4.0 * 0.04, 12); // bw = s·W

    // 볼록: 연속 변의 외적 부호가 전부 동일.
    const signs = poly.map((_, i) =>
      Math.sign(cross(sub(poly[(i + 1) % 4], poly[i]), sub(poly[(i + 2) % 4], poly[(i + 1) % 4]))),
    );
    expect(new Set(signs).size).toBe(1);
  });

  it('T4b 폭비는 cfg.topWidthRatio 를 실제로 따른다 → 비-1.0 이면 위가 좁은 사다리꼴', () => {
    // T4 의 판별력 보존: 기본값이 1.0 이 되면 "tw = ratio·bw" 모델을 상수 1 이 가려버린다.
    // 비-1.0(구 기본값 0.85 포함)을 주입해 폭비 결합이 살아있음을 봉인 — 사다리꼴 복귀 시에도 유효.
    for (const ratio of [0.85, 0.5]) {
      const [tl, tr, br, bl] = buildTrapezoid(ax, 4.0, { topWidthRatio: ratio });
      expect(len(sub(tr, tl))).toBeCloseTo(ratio * len(sub(br, bl)), 12);
      expect(len(sub(br, bl))).toBeCloseTo(4.0 * 0.04, 12); // 아래 변은 ratio 에 불변(배율 기준변).
      expect(len(sub(tr, tl))).toBeLessThan(len(sub(br, bl))); // 위가 좁다.
    }
  });

  it('T5 중심축 세로 평행 → (Ct−Cb) ∥ v̂ (회전 plate, R3 세로)', () => {
    const c = { x: 0.5, y: 0.5 };
    const rax = plateAxes(rotateQuad(plateAt(c.x, c.y), c, 30))!;
    const [tl, tr, br, bl] = buildTrapezoid(rax, 4.0);
    expect(cross(sub(mid(tl, tr), mid(bl, br)), rax.v)).toBeCloseTo(0, 12);
  });
});

describe('computeOccupancyRegions — 자동 배율 탐색(§3)', () => {
  /** 전 쌍 교차면적 최댓값. */
  function maxPairArea(regions: Array<{ polygon: Pt[] }>): number {
    let m = 0;
    for (let i = 0; i < regions.length; i++)
      for (let j = i + 1; j < regions.length; j++)
        m = Math.max(m, convexIntersectionArea(regions[i].polygon, regions[j].polygon));
    return m;
  }

  it('T6 단독 1개 → globalScale=4.0, regions 1개, overlapPairs=[]', () => {
    const r = computeOccupancyRegions([{ idx: 1, quad: plateAt(0.5, 0.5) }]);
    expect(r.globalScale).toBe(4.0);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].idx).toBe(1);
    expect(r.regions[0].scale).toBe(4.0);
    expect(r.overlapPairs).toEqual([]);
  });

  it('T7 이격 2개(4.0 에서도 비겹침) → globalScale=4.0, 전 쌍 교차면적 ≤ areaEps', () => {
    const r = computeOccupancyRegions([
      { idx: 1, quad: plateAt(0.2, 0.5) },
      { idx: 2, quad: plateAt(0.8, 0.5) },
    ]);
    expect(r.globalScale).toBe(4.0);
    expect(r.regions).toHaveLength(2);
    expect(maxPairArea(r.regions)).toBeLessThanOrEqual(AREA_EPS);
    expect(r.overlapPairs).toEqual([]);
  });

  it('T8 근접 2개(4.0 겹침·3.5 비겹침) → 3.5 ≤ globalScale < 4.0, 0.05 그리드 위, 결과 비겹침', () => {
    // dx=0.15: bw=0.04s 가 dx 를 넘는 s≈3.75 부터 겹침 → 탐색이 [3.5,4.0) 내부값을 고른다.
    const items = [
      { idx: 1, quad: plateAt(0.4, 0.5) },
      { idx: 2, quad: plateAt(0.55, 0.5) },
    ];
    const r = computeOccupancyRegions(items);
    expect(r.globalScale).not.toBeNull();
    expect(r.globalScale!).toBeGreaterThanOrEqual(3.5);
    expect(r.globalScale!).toBeLessThan(4.0);
    expect(Math.abs(r.globalScale! / 0.05 - Math.round(r.globalScale! / 0.05))).toBeLessThan(1e-9);
    expect(maxPairArea(r.regions)).toBeLessThanOrEqual(AREA_EPS);
    expect(r.overlapPairs).toEqual([]);
  });

  it('T9 극근접 2개(3.5 에서도 겹침) → globalScale=null, scale < 3.5, 최종 비겹침', () => {
    const r = computeOccupancyRegions([
      { idx: 1, quad: plateAt(0.475, 0.5) },
      { idx: 2, quad: plateAt(0.525, 0.5) },
    ]);
    expect(r.globalScale).toBeNull();
    expect(r.regions).toHaveLength(2);
    for (const g of r.regions) expect(g.scale).toBeLessThan(3.5);
    expect(maxPairArea(r.regions)).toBeLessThanOrEqual(AREA_EPS);
    expect(r.overlapPairs).toEqual([]);
  });

  it('T10 결정성 → 같은 입력 2회 호출 결과 딥이퀄', () => {
    const items = [
      { idx: 1, quad: plateAt(0.475, 0.5) },
      { idx: 2, quad: plateAt(0.525, 0.5) },
      { idx: 3, quad: plateAt(0.2, 0.2) },
    ];
    expect(computeOccupancyRegions(items)).toEqual(computeOccupancyRegions(items));
  });

  it('T11 경계 클램프 → 전 정점 ∈ [0,1]², 면적 > 0, 정점수 3~8', () => {
    const r = computeOccupancyRegions([{ idx: 1, quad: plateAt(0.02, 0.02) }]);
    expect(r.regions).toHaveLength(1);
    const poly = r.regions[0].polygon;
    expect(poly.length).toBeGreaterThanOrEqual(3);
    expect(poly.length).toBeLessThanOrEqual(8);
    for (const p of poly) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
    expect(polygonArea(poly)).toBeGreaterThan(0);
  });

  it('T12 퇴화(비4점·0길이 엣지) → 해당 인스턴스만 제외, throw 없음, 나머지 정상', () => {
    const zero = { x: 0.3, y: 0.3 };
    const items = [
      { idx: 1, quad: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.15, y: 0.2 }] }, // 3점
      { idx: 2, quad: [zero, zero, zero, zero] }, // 0-길이 엣지
      { idx: 3, quad: plateAt(0.5, 0.5) }, // 정상
    ];
    expect(plateAxes(items[0].quad)).toBeNull();
    expect(plateAxes(items[1].quad)).toBeNull();
    const r = computeOccupancyRegions(items);
    expect(r.regions.map((g) => g.idx)).toEqual([3]);
    expect(r.globalScale).toBe(4.0);
  });
});

describe('clampToUnit — 경계 클립(§2-4)', () => {
  it('T11 전부 이미지 밖 → [] (region 미생성)', () => {
    expect(clampToUnit([{ x: -0.3, y: -0.3 }, { x: -0.1, y: -0.3 }, { x: -0.1, y: -0.1 }, { x: -0.3, y: -0.1 }])).toEqual([]);
  });
});

describe('plateQuad 배선(§5)', () => {
  const FLOORS = [
    { idx: 1, quad: [{ x: 0.0, y: 0.0 }, { x: 0.4, y: 0.0 }, { x: 0.4, y: 0.4 }, { x: 0.0, y: 0.4 }] },
    { idx: 2, quad: [{ x: 0.4, y: 0.0 }, { x: 0.8, y: 0.0 }, { x: 0.8, y: 0.4 }, { x: 0.4, y: 0.4 }] },
  ];

  it('T13 computeOccupancy → occupied 행에 plateQuad=입력 quad, 비점유 행 무변화', () => {
    const plate = { quad: plateAt(0.2, 0.2) };
    const rows = computeOccupancy(FLOORS, [plate]);
    expect(rows[0]).toMatchObject({ idx: 1, occupied: true });
    expect(rows[0].plateQuad).toBe(plate.quad); // 입력 참조 그대로.
    expect(rows[1]).toEqual({ idx: 2, occupied: false }); // 비점유 행은 필드 추가 없음.
  });

  it('T14 judge → plate 행만 plateQuad 보유, bbox 행 미보유', () => {
    const plate = { quad: plateAt(0.2, 0.2) }; // slot1
    const vehicle = { rect: { x: 0.45, y: 0.0, w: 0.25, h: 0.35 } }; // slot2 bbox 폴백
    const rows = new OccupancyJudge().judge(FLOORS, { plates: [plate], vehicles: [vehicle] });
    expect(rows[0]).toEqual({ idx: 1, occupied: true, source: 'plate', center: quadCentroid(plate.quad), plateQuad: plate.quad });
    expect(rows[1]).toEqual({ idx: 2, occupied: true, source: 'bbox', vehicleRect: vehicle.rect });
    expect(rows[1].plateQuad).toBeUndefined();
  });
});
