import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deconflictPolygons, type FloorPolyItem } from '../src/capture/floorRoi.js';
import { convexIntersectionArea, pointInPolygon, rectCorners } from '../src/domain/polygon.js';
import type { NormalizedPolygon, NormalizedRect } from '../src/domain/types.js';
import { logger } from '../src/util/logger.js';

/**
 * 검증자(qa-tester): deconflictPolygons 비겹침 보장 (설계서 §3 · 테스트계획 T6, 핵심).
 * (a) 상호 교차면적 = 0, (b) 멱등, (c) R3>R4(번호판 자기 폴리곤 잔류), (d) 병리적 plate 충돌 + warn.
 */

const AREA_TOL = 1e-6;
const square = (x: number, y: number, s: number): NormalizedPolygon => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];
const containsRect = (poly: NormalizedPolygon, r: NormalizedRect) =>
  rectCorners(r).every((c) => pointInPolygon(poly, c));

/** 모든 쌍의 교차면적이 tol 이하인지. */
function maxPairOverlap(polys: NormalizedPolygon[]): number {
  let max = 0;
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      max = Math.max(max, convexIntersectionArea(polys[i], polys[j]));
    }
  }
  return max;
}

describe('deconflictPolygons (a) 상호 겹침 = 0', () => {
  it('겹치는 두 폴리곤 → 교차면적 ≈ 0', () => {
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.1, 0.4, 0.4) }, // [0.1..0.5]
      { ref: 'B', polygon: square(0.3, 0.4, 0.4) }, // [0.3..0.7] 겹침
    ];
    const out = deconflictPolygons(items);
    expect(out).toHaveLength(2);
    expect(maxPairOverlap(out)).toBeLessThanOrEqual(AREA_TOL);
    // 각 폴리곤은 여전히 유의미한 면적 보유(완전소멸 아님).
    for (const p of out) expect(p.length).toBeGreaterThanOrEqual(3);
  });

  it('일렬 3개 겹침 → 모든 쌍 교차면적 ≈ 0', () => {
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.05, 0.4, 0.35) },
      { ref: 'B', polygon: square(0.30, 0.4, 0.35) },
      { ref: 'C', polygon: square(0.55, 0.4, 0.35) },
    ];
    const out = deconflictPolygons(items);
    expect(maxPairOverlap(out)).toBeLessThanOrEqual(AREA_TOL);
  });
});

describe('deconflictPolygons (b) 멱등 / 비겹침 불변', () => {
  it('이미 비겹침 입력 → (거의) 불변', () => {
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.05, 0.4, 0.2) }, // [0.05..0.25]
      { ref: 'B', polygon: square(0.5, 0.4, 0.2) },  // [0.5..0.7] 분리
    ];
    const out = deconflictPolygons(items);
    // 분리되어 있으므로 클리핑 발생 안 함 → 원본 좌표 보존.
    expect(out[0]).toEqual(items[0].polygon);
    expect(out[1]).toEqual(items[1].polygon);
  });

  it('멱등: deconflict 결과를 재입력 → 재변형 없음', () => {
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.1, 0.4, 0.4) },
      { ref: 'B', polygon: square(0.3, 0.4, 0.4) },
    ];
    const once = deconflictPolygons(items);
    const twice = deconflictPolygons(once.map((polygon, i) => ({ ref: items[i].ref, polygon })));
    expect(maxPairOverlap(twice)).toBeLessThanOrEqual(AREA_TOL);
    for (let i = 0; i < once.length; i++) {
      // 재적용 시 교차면적이 이미 0 → 클리핑 스킵 → 좌표 동일.
      expect(twice[i]).toEqual(once[i]);
    }
  });
});

describe('deconflictPolygons (c) R3 우선: 번호판 자기 폴리곤 잔류', () => {
  it('각 폴리곤의 번호판 박스가 비겹침 클리핑 후에도 자기 폴리곤 내부', () => {
    const plateA: NormalizedRect = { x: 0.12, y: 0.55, w: 0.06, h: 0.04 };
    const plateB: NormalizedRect = { x: 0.55, y: 0.55, w: 0.06, h: 0.04 };
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.1, 0.4, 0.4), plate: plateA }, // [0.1..0.5]
      { ref: 'B', polygon: square(0.3, 0.4, 0.4), plate: plateB }, // [0.3..0.7]
    ];
    const out = deconflictPolygons(items);
    expect(maxPairOverlap(out)).toBeLessThanOrEqual(AREA_TOL);
    // 분리선이 번호판 사이 창(0.18~0.55)으로 이동 → 각 plate 자기 폴리곤 잔류(R3).
    expect(containsRect(out[0], plateA)).toBe(true);
    expect(containsRect(out[1], plateB)).toBe(true);
  });
});

describe('deconflictPolygons (d) 병리적: 번호판 박스 충돌', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('두 번호판이 실제 겹침 → 비겹침 보장 유지 + warn 1회', () => {
    // 두 plate 가 같은 영역(0.3~0.4)에서 겹침 → 양립 창 없음(병리적).
    const plate: NormalizedRect = { x: 0.3, y: 0.55, w: 0.1, h: 0.04 };
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.1, 0.4, 0.4), plate },
      { ref: 'B', polygon: square(0.3, 0.4, 0.4), plate },
    ];
    const out = deconflictPolygons(items);
    // R4(비겹침) 우선 강등 → 교차면적 여전히 0 보장.
    expect(maxPairOverlap(out)).toBeLessThanOrEqual(AREA_TOL);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('deconflictPolygons 경계', () => {
  it('단일 폴리곤 → 그대로 반환', () => {
    const items: FloorPolyItem[] = [{ ref: 'A', polygon: square(0.1, 0.4, 0.4) }];
    expect(deconflictPolygons(items)[0]).toEqual(items[0].polygon);
  });
  it('빈 입력 → 빈 배열', () => {
    expect(deconflictPolygons([])).toEqual([]);
  });
  it('입력 순서 보존(반환 길이 = 입력 길이)', () => {
    const items: FloorPolyItem[] = [
      { ref: 'A', polygon: square(0.1, 0.4, 0.3) },
      { ref: 'B', polygon: square(0.25, 0.4, 0.3) },
      { ref: 'C', polygon: square(0.7, 0.4, 0.2) },
    ];
    expect(deconflictPolygons(items)).toHaveLength(3);
  });
});
