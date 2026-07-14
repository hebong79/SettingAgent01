import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import.
import { computeOccupancy, quadCentroid, selectFloorRoi, normalizePtzCamRoi, presetKey } from '../web/core.js';

/**
 * 검증자(qa-tester): `computeOccupancy(floorPolygons, plates)` + `quadCentroid(quad)` 순수 함수 유닛테스트.
 * 근거: 01_architect_plan.md §05 G3 검증 기준 + 02_developer_changes.md 02-H(§3 G3) QA 인계.
 * - computeOccupancy: 각 바닥 폴리곤에 번호판 중심(quadCentroid)이 내부(pointInQuad)면 occupied+center(첫 매칭).
 * - quadCentroid: 4점 산술평균, 비4점/좌표 비수치 → null.
 * - 방어성(비배열/누락 → [], throw 없음), pointInQuad 재사용 확인.
 * - 경계면 교차: floorPolygons.quad 형식이 프론트 소비(selectFloorRoi.polygons → {idx,quad}) 와 일치.
 */

/** (0,0)-(0.2,0.2) 사각 바닥, idx 0. */
const floorA = { idx: 0, quad: [{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0, y: 0.2 }] };
/** (0.5,0.5)-(0.7,0.7) 사각 바닥, idx 1. */
const floorB = { idx: 1, quad: [{ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }, { x: 0.7, y: 0.7 }, { x: 0.5, y: 0.7 }] };

/** 중심이 (cx,cy) 인 소형 번호판 quad. */
const plateAt = (cx: number, cy: number) => ({
  quad: [
    { x: cx - 0.02, y: cy - 0.01 },
    { x: cx + 0.02, y: cy - 0.01 },
    { x: cx + 0.02, y: cy + 0.01 },
    { x: cx - 0.02, y: cy + 0.01 },
  ],
});

describe('quadCentroid — 4점 산술평균 중심', () => {
  it('정사각 4점 → 정확한 중심', () => {
    const c = quadCentroid([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    expect(c).not.toBeNull();
    expect(c!.x).toBeCloseTo(0.5, 12);
    expect(c!.y).toBeCloseTo(0.5, 12);
  });

  it('비대칭 4점 → x/y 평균', () => {
    const c = quadCentroid([{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.3, y: 0.6 }, { x: 0.1, y: 0.6 }]);
    expect(c!.x).toBeCloseTo(0.2, 12);
    expect(c!.y).toBeCloseTo(0.4, 12);
  });

  it('4점 아님(3점/5점) → null', () => {
    expect(quadCentroid([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(quadCentroid([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.5, y: 0.5 }])).toBeNull();
  });

  it('좌표 비수치/누락 → null (throw 없음)', () => {
    expect(quadCentroid([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0 } as unknown as { x: number; y: number }])).toBeNull();
    expect(quadCentroid(null)).toBeNull();
    expect(quadCentroid(undefined)).toBeNull();
    expect(quadCentroid('nope' as unknown as never)).toBeNull();
  });
});

describe('computeOccupancy — 점유/비점유 판정', () => {
  it('점유: 번호판 중심이 floor quad 내부 → occupied:true, center=해당 중심', () => {
    const out = computeOccupancy([floorA, floorB], [plateAt(0.1, 0.1)]);
    expect(out).toHaveLength(2);
    // A(idx 0): 번호판 중심 (0.1,0.1) 이 내부 → 점유.
    expect(out[0]).toMatchObject({ idx: 0, occupied: true });
    expect(out[0].center!.x).toBeCloseTo(0.1, 12);
    expect(out[0].center!.y).toBeCloseTo(0.1, 12);
    // B(idx 1): 번호판 없음 → 미점유, center 미부착.
    expect(out[1]).toEqual({ idx: 1, occupied: false });
    expect(out[1]).not.toHaveProperty('center');
  });

  it('비점유: 모든 번호판 중심이 모든 floor 밖 → 전면 occupied:false', () => {
    const out = computeOccupancy([floorA, floorB], [plateAt(0.9, 0.9)]);
    expect(out.map((o) => o.occupied)).toEqual([false, false]);
    expect(out.every((o) => !('center' in o))).toBe(true);
  });

  it('다면·다판: 각 면이 자기 내부 번호판에만 매칭(교차 오귀속 없음)', () => {
    const out = computeOccupancy([floorA, floorB], [plateAt(0.6, 0.6), plateAt(0.1, 0.1)]);
    // A ← (0.1,0.1), B ← (0.6,0.6). 순서 무관하게 올바른 면에 귀속.
    expect(out[0]).toMatchObject({ idx: 0, occupied: true });
    expect(out[0].center!.x).toBeCloseTo(0.1, 12);
    expect(out[1]).toMatchObject({ idx: 1, occupied: true });
    expect(out[1].center!.x).toBeCloseTo(0.6, 12);
  });

  it('한 면에 번호판 다수 → 첫 매칭 중심 채택', () => {
    // 둘 다 A 내부. plates 순서상 첫 매칭(0.05,0.05) 이 center.
    const out = computeOccupancy([floorA], [plateAt(0.05, 0.05), plateAt(0.15, 0.15)]);
    expect(out[0].occupied).toBe(true);
    expect(out[0].center!.x).toBeCloseTo(0.05, 12);
    expect(out[0].center!.y).toBeCloseTo(0.05, 12);
  });

  it('pointInQuad 재사용: 면 밖 인접 중심은 비점유(경계 바깥)', () => {
    // 중심 (0.25,0.1) 은 A(0..0.2) 우측 바깥.
    const out = computeOccupancy([floorA], [plateAt(0.25, 0.1)]);
    expect(out[0].occupied).toBe(false);
  });
});

describe('computeOccupancy — 방어성(throw 없음)', () => {
  it('plates:[] → 전면 미점유', () => {
    const out = computeOccupancy([floorA, floorB], []);
    expect(out.map((o) => o.occupied)).toEqual([false, false]);
  });

  it('floorPolygons:null / 비배열 → []', () => {
    expect(computeOccupancy(null, [plateAt(0.1, 0.1)])).toEqual([]);
    expect(computeOccupancy(undefined, [])).toEqual([]);
    expect(computeOccupancy('x' as unknown as never, [])).toEqual([]);
  });

  it('plates 비배열/누락 → 전면 미점유(내부적으로 [] 취급, throw 없음)', () => {
    let out!: ReturnType<typeof computeOccupancy>;
    expect(() => {
      out = computeOccupancy([floorA], null);
    }).not.toThrow();
    expect(out).toEqual([{ idx: 0, occupied: false }]);
  });

  it('quad 손상 번호판(centroid null) 은 무시하고 계속 진행', () => {
    const badPlate = { quad: [{ x: 0.1, y: 0.1 }] }; // 4점 아님 → centroid null → 필터.
    const out = computeOccupancy([floorA], [badPlate, plateAt(0.1, 0.1)]);
    expect(out[0].occupied).toBe(true); // 정상 번호판으로 점유.
  });
});

describe('computeOccupancy — 경계면 교차(프론트 소비 shape 일치)', () => {
  const REAL_FILE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'PtzCamRoi.unity.json'); // 동결 픽스처(런타임 데이터 의존 제거).

  it('selectFloorRoi(파일 모드).polygons → {idx:Number(label),quad} 매핑이 computeOccupancy floorPolygons 형식과 정합', () => {
    // app.js updateLogicOccupancy 와 동일 배선: placeRoi → selectFloorRoi → {idx,quad}.
    const placeRoi = normalizePtzCamRoi(JSON.parse(readFileSync(REAL_FILE, 'utf8'))).byPreset;
    const key = presetKey(1, 1); // "1:1"
    const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({
      idx: Number(p.label),
      quad: p.quad,
    }));
    expect(floorPolys.length).toBeGreaterThan(0);
    // 각 floorPoly 는 idx(수치) + quad(4점 {x,y}) — computeOccupancy 소비 계약.
    for (const f of floorPolys) {
      expect(Number.isFinite(f.idx)).toBe(true);
      expect(Array.isArray(f.quad)).toBe(true);
      expect(f.quad).toHaveLength(4);
      expect(typeof f.quad[0].x).toBe('number');
      expect(typeof f.quad[0].y).toBe('number');
    }
    // 실제 파일 폴리곤 중심을 번호판으로 넣으면 그 면이 점유로 판정(형식 왕복 검증).
    const target = floorPolys[0];
    const c = quadCentroid(target.quad as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }])!;
    const out = computeOccupancy(floorPolys, [plateAt(c.x, c.y)]);
    const hit = out.find((o) => o.idx === target.idx)!;
    expect(hit.occupied).toBe(true);
    expect(hit.center!.x).toBeCloseTo(c.x, 6);
  });

  it('plates 소스 = state.detect.plates + vehicles[].plate 합집합의 {quad} 형식과 정합', () => {
    // drawDetectOverlay/updateLogicOccupancy 가 구성하는 plate shape: { quad:[{x,y}×4], ... }.
    const detectLikePlates = [
      { quad: plateAt(0.1, 0.1).quad, confidence: 0.9 }, // base LPD(plates[])
      { quad: plateAt(0.6, 0.6).quad, recovered: true }, // vehicles[].plate(복원분)
    ];
    const out = computeOccupancy([floorA, floorB], detectLikePlates);
    expect(out[0].occupied).toBe(true); // A ← base plate
    expect(out[1].occupied).toBe(true); // B ← recovered plate
  });
});
