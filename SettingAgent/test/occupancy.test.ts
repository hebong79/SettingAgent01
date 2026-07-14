import { describe, it, expect } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import — 뷰어 차량 점유율 표시 순수 로직(설계 §6, §8).
import {
  formatRatePct,
  occupancyByKey,
  occupancyRows,
  occupancyAverage,
} from '../web/core.js';

// GET /capture/runs/:id/occupancy 응답(=SqliteStore.getLatestOccupancy L411-441) 실제 shape.
// { camIdx, presetIdx, atRound, occupiedCount, total, rate, spacesJson: string|null, updatedAt }
// spacesJson 파싱 요소(OccupancySpaceSchema, SetupBrain.ts): { id:int, occupied:boolean, polygon?:[{x,y}×4] }
function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    camIdx: 1,
    presetIdx: 2,
    atRound: 3,
    occupiedCount: 2,
    total: 3,
    rate: 0.667,
    spacesJson: null,
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...over,
  };
}

describe('formatRatePct (rate 0~1 → NN%, 경계·반올림)', () => {
  it('0 → 0%', () => expect(formatRatePct(0)).toBe('0%'));
  it('1 → 100%', () => expect(formatRatePct(1)).toBe('100%'));
  it('0.5 → 50%', () => expect(formatRatePct(0.5)).toBe('50%'));
  it('0.732 → 73% (반올림 내림)', () => expect(formatRatePct(0.732)).toBe('73%'));
  it('0.735 → 74% (반올림 올림)', () => expect(formatRatePct(0.735)).toBe('74%'));
  it('0.005 → 1% (경계 반올림)', () => expect(formatRatePct(0.005)).toBe('1%'));
  it('null → 0% (방어)', () => expect(formatRatePct(null)).toBe('0%'));
  it('undefined → 0% (방어)', () => expect(formatRatePct(undefined)).toBe('0%'));
  it('NaN → 0% (방어)', () => expect(formatRatePct(NaN)).toBe('0%'));
  it('비수치 문자열 → 0% (방어)', () => expect(formatRatePct('abc')).toBe('0%'));
  it('Infinity → 0% (비유한 방어)', () => expect(formatRatePct(Infinity)).toBe('0%'));
});

describe('occupancyByKey (rows[] → cam:preset 맵, spacesJson JSON.parse·graceful)', () => {
  it('정상 row(spacesJson 문자열·polygon 포함) → key "1:2"에 spaces 1개·polygon 보존', () => {
    const rows = [
      makeRow({
        camIdx: 1,
        presetIdx: 2,
        occupiedCount: 1,
        total: 1,
        rate: 1,
        spacesJson:
          '[{"id":1,"occupied":true,"polygon":[{"x":0.1,"y":0.5},{"x":0.3,"y":0.5},{"x":0.3,"y":0.35},{"x":0.1,"y":0.35}]}]',
      }),
    ];
    const out = occupancyByKey(rows);
    expect(Object.keys(out)).toEqual(['1:2']);
    const o = out['1:2'];
    expect(o.camIdx).toBe(1);
    expect(o.presetIdx).toBe(2);
    expect(o.occupiedCount).toBe(1);
    expect(o.total).toBe(1);
    expect(o.rate).toBe(1);
    expect(o.spaces).toHaveLength(1);
    expect(o.spaces[0]).toEqual({
      id: 1,
      occupied: true,
      polygon: [
        { x: 0.1, y: 0.5 },
        { x: 0.3, y: 0.5 },
        { x: 0.3, y: 0.35 },
        { x: 0.1, y: 0.35 },
      ],
    });
  });

  it('spacesJson=null → spaces:[] (카운트/rate 필드 보존)', () => {
    const out = occupancyByKey([makeRow({ spacesJson: null, occupiedCount: 2, total: 5, rate: 0.4 })]);
    expect(out['1:2'].spaces).toEqual([]);
    expect(out['1:2'].occupiedCount).toBe(2);
    expect(out['1:2'].total).toBe(5);
    expect(out['1:2'].rate).toBe(0.4);
  });

  it('spacesJson="{잘못된json" → try/catch → spaces:[] (throw 안 함)', () => {
    expect(() => occupancyByKey([makeRow({ spacesJson: '{잘못된json' })])).not.toThrow();
    const out = occupancyByKey([makeRow({ spacesJson: '{잘못된json' })]);
    expect(out['1:2'].spaces).toEqual([]);
  });

  it('spacesJson 이 JSON 이지만 배열이 아님(객체) → spaces:[] (비배열 강등)', () => {
    const out = occupancyByKey([makeRow({ spacesJson: '{"id":1}' })]);
    expect(out['1:2'].spaces).toEqual([]);
  });

  it('polygon 미보유 요소(optional) → 그대로 통과(오버레이가 skip)', () => {
    const out = occupancyByKey([makeRow({ spacesJson: '[{"id":1,"occupied":false}]' })]);
    expect(out['1:2'].spaces[0]).toEqual({ id: 1, occupied: false });
    expect(out['1:2'].spaces[0].polygon).toBeUndefined();
  });

  it('여러 프리셋 → 키별 분리', () => {
    const rows = [
      makeRow({ camIdx: 1, presetIdx: 2 }),
      makeRow({ camIdx: 1, presetIdx: 3 }),
      makeRow({ camIdx: 2, presetIdx: 1 }),
    ];
    const out = occupancyByKey(rows);
    expect(Object.keys(out).sort()).toEqual(['1:2', '1:3', '2:1']);
  });

  it('null/undefined rows → 빈 맵(방어)', () => {
    expect(occupancyByKey(null)).toEqual({});
    expect(occupancyByKey(undefined)).toEqual({});
  });
});

describe('occupancyRows (occByKey → 정렬된 표 rows: [key,cam,preset,occ,total,NN%])', () => {
  it('cam→preset 뒤섞인 입력 → cam ASC → preset ASC 정렬, 6열, rate 포맷', () => {
    const byKey = occupancyByKey([
      makeRow({ camIdx: 2, presetIdx: 1, occupiedCount: 1, total: 4, rate: 0.25 }),
      makeRow({ camIdx: 1, presetIdx: 3, occupiedCount: 3, total: 4, rate: 0.75 }),
      makeRow({ camIdx: 1, presetIdx: 2, occupiedCount: 8, total: 11, rate: 0.732 }),
    ]);
    const rows = occupancyRows(byKey);
    expect(rows).toEqual([
      ['1:2', 1, 2, 8, 11, '73%'],
      ['1:3', 1, 3, 3, 4, '75%'],
      ['2:1', 2, 1, 1, 4, '25%'],
    ]);
  });

  it('각 행은 정확히 6열', () => {
    const byKey = occupancyByKey([makeRow()]);
    expect(occupancyRows(byKey)[0]).toHaveLength(6);
  });

  it('빈 맵 → 빈 배열', () => {
    expect(occupancyRows({})).toEqual([]);
    expect(occupancyRows(null)).toEqual([]);
  });
});

describe('occupancyAverage (평균 rate, 0분모·빈 배열 방어)', () => {
  it('2프리셋(3/5, 4/6) → occupied 7, total 11, rate≈0.636', () => {
    const byKey = occupancyByKey([
      makeRow({ camIdx: 1, presetIdx: 1, occupiedCount: 3, total: 5, rate: 0.6 }),
      makeRow({ camIdx: 1, presetIdx: 2, occupiedCount: 4, total: 6, rate: 0.667 }),
    ]);
    const avg = occupancyAverage(byKey);
    expect(avg.occupied).toBe(7);
    expect(avg.total).toBe(11);
    expect(avg.rate).toBeCloseTo(7 / 11, 5);
  });

  it('빈 입력 → {occupied:0,total:0,rate:0} (0분모 방어)', () => {
    expect(occupancyAverage({})).toEqual({ occupied: 0, total: 0, rate: 0 });
    expect(occupancyAverage(null)).toEqual({ occupied: 0, total: 0, rate: 0 });
  });

  it('total 0 프리셋만 → rate 0 (0분모, NaN 아님)', () => {
    const byKey = occupancyByKey([makeRow({ occupiedCount: 0, total: 0, rate: 0 })]);
    const avg = occupancyAverage(byKey);
    expect(avg.total).toBe(0);
    expect(avg.rate).toBe(0);
    expect(Number.isNaN(avg.rate)).toBe(false);
  });

  it('formatRatePct 로 감싸면 평균이 % 문자열로 정상 표기', () => {
    const byKey = occupancyByKey([
      makeRow({ camIdx: 1, presetIdx: 1, occupiedCount: 3, total: 5, rate: 0.6 }),
      makeRow({ camIdx: 1, presetIdx: 2, occupiedCount: 4, total: 6, rate: 0.667 }),
    ]);
    expect(formatRatePct(occupancyAverage(byKey).rate)).toBe('64%'); // 7/11=0.636 → 64%
  });
});

describe('경계면 shape 교차검증 — GET /capture/runs/:id/occupancy(getLatestOccupancy) 응답을 occupancyByKey 가 정확히 소비', () => {
  // getLatestOccupancy 반환 필드명(camIdx,presetIdx,atRound,occupiedCount,total,rate,spacesJson,updatedAt)을
  // 그대로 넣어 core.js 소비 필드(camIdx,presetIdx,occupiedCount,total,rate,spacesJson)가 일치함을 증명.
  it('백엔드 필드명 그대로 → 소비 필드 전부 정상 매핑(불일치 시 실패)', () => {
    const backendRows = [
      {
        camIdx: 3,
        presetIdx: 5,
        atRound: 7,
        occupiedCount: 2,
        total: 4,
        rate: 0.5,
        spacesJson:
          '[{"id":10,"occupied":true,"polygon":[{"x":0.05,"y":0.35},{"x":0.25,"y":0.35},{"x":0.25,"y":0.05},{"x":0.05,"y":0.05}]},{"id":11,"occupied":false}]',
        updatedAt: '2026-07-05T01:23:45.000Z',
      },
    ];
    const out = occupancyByKey(backendRows);
    const o = out['3:5'];
    expect(o).toBeDefined();
    // 카운트/rate 는 백엔드 값 그대로.
    expect(o.occupiedCount).toBe(2);
    expect(o.total).toBe(4);
    expect(o.rate).toBe(0.5);
    // spaces 요소 shape {id,occupied,polygon?} 파싱.
    expect(o.spaces).toHaveLength(2);
    expect(o.spaces[0]).toEqual({
      id: 10,
      occupied: true,
      polygon: [
        { x: 0.05, y: 0.35 },
        { x: 0.25, y: 0.35 },
        { x: 0.25, y: 0.05 },
        { x: 0.05, y: 0.05 },
      ],
    });
    expect(o.spaces[1]).toEqual({ id: 11, occupied: false }); // polygon 없음 → 통과(오버레이 skip 대상)
    // 표/평균까지 end-to-end.
    expect(occupancyRows(out)).toEqual([['3:5', 3, 5, 2, 4, '50%']]);
    expect(occupancyAverage(out)).toEqual({ occupied: 2, total: 4, rate: 0.5 });
  });

  it('spacesJson=null(구DB/판정없음) 응답도 graceful(설계 §데이터계약)', () => {
    const out = occupancyByKey([
      { camIdx: 1, presetIdx: 1, atRound: 1, occupiedCount: 0, total: 3, rate: 0, spacesJson: null, updatedAt: 'x' },
    ]);
    expect(out['1:1'].spaces).toEqual([]);
    expect(occupancyRows(out)).toEqual([['1:1', 1, 1, 0, 3, '0%']]);
  });
});
