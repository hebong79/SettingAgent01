import { describe, it, expect } from 'vitest';
import { OccupancyJudge } from '../web/occupancy.js';
import { computeOccupancy } from '../web/core.js';

/**
 * OccupancyJudge — 슬롯별 plate 우선 · bbox 폴백 점유 판정(설계 §2, T1~T9).
 * 기하 파리티는 test/occupancyGeometryParity.test.ts 가 별도로 봉인한다.
 */

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

/** 축정렬 사각형 → floor quad(TL,TR,BR,BL). */
function floorQuad(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** 중심 c 주변 반변 hs 의 작은 번호판 quad. */
function plateAt(cx: number, cy: number, hs = 0.02): { quad: Pt[] } {
  return {
    quad: [
      { x: cx - hs, y: cy - hs },
      { x: cx + hs, y: cy - hs },
      { x: cx + hs, y: cy + hs },
      { x: cx - hs, y: cy + hs },
    ],
  };
}

// 인접 두 슬롯: idx1 = x[0,0.4], idx2 = x[0.4,0.8], 공통 y[0,0.4].
const FLOORS = [
  { idx: 1, quad: floorQuad(0.0, 0.0, 0.4, 0.4) },
  { idx: 2, quad: floorQuad(0.4, 0.0, 0.8, 0.4) },
];

// 차량 rect: y[0,0.35] → 접지밴드(하단 25%)가 슬롯 y범위(0~0.4) 안에 든다. 겹침은 x-중첩이 결정.
const R_IN_S1: Rect = { x: 0.05, y: 0.0, w: 0.25, h: 0.35 }; // 밴드 전부 slot1 → ratio≈1
const R_BELOW_THRESH: Rect = { x: 0.78, y: 0.0, w: 0.17, h: 0.35 }; // slot2 오른끝만 살짝(ratio≈0.12<0.15)
const R_STRADDLE_S1: Rect = { x: 0.20, y: 0.0, w: 0.34, h: 0.35 }; // slot1 0.20 vs slot2 0.14 → argmax slot1
const R_STRADDLE_TIE: Rect = { x: 0.20, y: 0.0, w: 0.40, h: 0.35 }; // slot1==slot2 (정확 동률)

const judge = new OccupancyJudge();

describe('OccupancyJudge.judge', () => {
  it('T1 번호판만(vehicles 없음) → computeOccupancy 와 idx·occupied·center 동치 + source=plate', () => {
    const plates = [plateAt(0.2, 0.2), plateAt(0.6, 0.2)]; // slot1, slot2 각각
    const rows = judge.judge(FLOORS, { plates });
    const base = computeOccupancy(FLOORS, plates);
    expect(rows.map((r) => ({ idx: r.idx, occupied: r.occupied, center: r.center }))).toEqual(base);
    for (const r of rows) {
      if (r.occupied) {
        expect(r.source).toBe('plate');
        expect(r.center).toBeDefined();
        expect(r.vehicleRect).toBeUndefined();
      } else {
        expect(r.source).toBeNull();
      }
    }
  });

  it('T2 bbox만(plate 전무) → 밴드 겹침 argmax 슬롯만 occupied·source=bbox, <0.15 은 미점유', () => {
    const vehicles = [{ rect: R_IN_S1 }, { rect: R_BELOW_THRESH }];
    const rows = judge.judge(FLOORS, { vehicles });
    expect(rows[0]).toEqual({ idx: 1, occupied: true, source: 'bbox', vehicleRect: R_IN_S1 });
    expect(rows[1]).toEqual({ idx: 2, occupied: false, source: null });
  });

  it('T3 둘 다: slot1 에 plate + 같은 차량 bbox → slot1=plate, 그 차량이 다른 슬롯 추가점유 안 함', () => {
    const veh = { rect: R_IN_S1, plate: plateAt(0.2, 0.2) }; // plate 중심 slot1 내부
    const rows = judge.judge(FLOORS, { vehicles: [veh] });
    expect(rows[0].occupied).toBe(true);
    expect(rows[0].source).toBe('plate');
    expect(rows[0].center).toEqual({ x: 0.2, y: 0.2 });
    expect(rows[1]).toEqual({ idx: 2, occupied: false, source: null });
  });

  it('T4 둘 다 없음 → 전 슬롯 {occupied:false, source:null}', () => {
    const rows = judge.judge(FLOORS, {});
    expect(rows).toEqual([
      { idx: 1, occupied: false, source: null },
      { idx: 2, occupied: false, source: null },
    ]);
  });

  it('T5a bbox 2슬롯 경계(비대칭) → argmax 한 슬롯만 occupied', () => {
    const rows = judge.judge(FLOORS, { vehicles: [{ rect: R_STRADDLE_S1 }] });
    expect(rows[0]).toEqual({ idx: 1, occupied: true, source: 'bbox', vehicleRect: R_STRADDLE_S1 });
    expect(rows[1].occupied).toBe(false);
  });

  it('T5b bbox 2슬롯 경계(거의 동률) → 정확히 한 슬롯만 occupied(이중점유 없음)', () => {
    // 걸친 차량은 겹침 최대 슬롯 1개만 점유 — 2면 FP 방지. (부동소수상 정확 동률은 실측 발생 확률 0;
    //  코드의 strict-비교 tie-break 는 비트동일 ratio 일 때만 앞 슬롯을 보장하므로 여기선 개수만 단언.)
    const rows = judge.judge(FLOORS, { vehicles: [{ rect: R_STRADDLE_TIE }] });
    const occ = rows.filter((r) => r.occupied);
    expect(occ.length).toBe(1);
    expect(occ[0].source).toBe('bbox');
  });

  it('T6 우선순위 혼합: standalone plate=slot1, 무번호판 차량 bbox=slot2 → 병존', () => {
    const rows = judge.judge(FLOORS, {
      plates: [plateAt(0.2, 0.2)],
      vehicles: [{ rect: { x: 0.5, y: 0.0, w: 0.25, h: 0.35 } }], // 밴드 전부 slot2
    });
    expect(rows[0].source).toBe('plate');
    expect(rows[0].occupied).toBe(true);
    expect(rows[1].source).toBe('bbox');
    expect(rows[1].occupied).toBe(true);
  });

  it('T7 plate 중심이 모든 폴리곤 밖인 plate 보유 차량 → 2단계 bbox 판정', () => {
    const veh = { rect: R_IN_S1, plate: plateAt(0.2, 0.9) }; // plate 중심 y=0.9 → 슬롯 밖
    const rows = judge.judge(FLOORS, { vehicles: [veh] });
    expect(rows[0]).toEqual({ idx: 1, occupied: true, source: 'bbox', vehicleRect: R_IN_S1 });
  });

  it('T8 한 슬롯 bbox 후보 2대 → occupied 1회, vehicleRect=겹침 최대 차량', () => {
    const big = { rect: R_IN_S1 }; // ratio≈1
    const small = { rect: { x: 0.3, y: 0.0, w: 0.15, h: 0.35 } }; // slot1 부분(ratio<1) 이지만 ≥0.15
    const rows = judge.judge(FLOORS, { vehicles: [small, big] });
    expect(rows[0].occupied).toBe(true);
    expect(rows[0].source).toBe('bbox');
    expect(rows[0].vehicleRect).toEqual(R_IN_S1); // 최대 겹침 차량
  });

  it('T9 graceful: null/비배열/퇴화 rect(h=0) → [] 또는 skip, throw 없음', () => {
    expect(judge.judge(null, { vehicles: [{ rect: R_IN_S1 }] })).toEqual([]);
    expect(judge.judge(undefined, {})).toEqual([]);
    // detect null → 전 슬롯 미점유
    expect(judge.judge(FLOORS, null)).toEqual([
      { idx: 1, occupied: false, source: null },
      { idx: 2, occupied: false, source: null },
    ]);
    // 퇴화 rect(h=0) skip + 정상 rect 는 판정
    const rows = judge.judge(FLOORS, {
      vehicles: [{ rect: { x: 0.05, y: 0.3, w: 0.25, h: 0 } }, { rect: R_IN_S1 }],
    });
    expect(rows[0].occupied).toBe(true); // 정상 차량으로 slot1 점유
    // rect 누락 차량도 throw 없이 skip
    expect(() => judge.judge(FLOORS, { vehicles: [{} as never, { rect: R_IN_S1 }] })).not.toThrow();
  });

  it('config: minBandOverlap 상향 시 임계 미달 차량 미점유(생성자 임계 한 곳)', () => {
    const strict = new OccupancyJudge({ minBandOverlap: 0.99 });
    const rows = strict.judge(FLOORS, { vehicles: [{ rect: { x: 0.3, y: 0.0, w: 0.15, h: 0.35 } }] });
    expect(rows.every((r) => !r.occupied)).toBe(true);
  });
});
