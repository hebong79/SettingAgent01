import { describe, it, expect } from 'vitest';
import { OccupancyJudge } from '../web/occupancy.js';
import { computeOccupancy as webComputeOccupancy } from '../web/core.js';
import { computeOccupancy as srvComputeOccupancy, judgeOccupancy as srvJudge } from '../src/domain/occupancyJudge.js';

/**
 * O1 — 점유 **판정** 포팅 파리티(설계 §5.2 O1, 단계 7).
 *
 * 기준변은 `web/*`(실운영 검증된 쪽)이고 `src/domain/occupancyJudge.ts` 가 그것을 따라간다.
 * 입력은 **`test/occupancyJudge.test.ts` 의 T1~T9 시나리오를 그대로 재사용**한다 — 새 케이스를
 * 발명하면 두 구현이 아니라 새 기대값을 검증하게 된다(§5.1-2).
 * 비교는 `toEqual` 깊은 비교다. `toBeCloseTo` 로 풀지 않는다 — 자구 포팅이므로 부동소수까지
 * 같아야 하고, 다르면 그건 포팅 오류다(§5.1-3).
 */

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

/** 축정렬 사각형 → floor quad(TL,TR,BR,BL). (occupancyJudge.test.ts 와 동일) */
function floorQuad(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** 중심 c 주변 반변 hs 의 작은 번호판 quad. (occupancyJudge.test.ts 와 동일) */
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

const FLOORS = [
  { idx: 1, quad: floorQuad(0.0, 0.0, 0.4, 0.4) },
  { idx: 2, quad: floorQuad(0.4, 0.0, 0.8, 0.4) },
];

const R_IN_S1: Rect = { x: 0.05, y: 0.0, w: 0.25, h: 0.35 };
const R_BELOW_THRESH: Rect = { x: 0.78, y: 0.0, w: 0.17, h: 0.35 };
const R_STRADDLE_S1: Rect = { x: 0.20, y: 0.0, w: 0.34, h: 0.35 };
const R_STRADDLE_TIE: Rect = { x: 0.20, y: 0.0, w: 0.40, h: 0.35 };

const webJudge = new OccupancyJudge();

/** web(JSDoc 타입) ↔ src(구조 타입) 신호 차이를 흡수하는 캐스팅 지점(값은 동일 객체를 넘긴다). */
type WebInput = Parameters<OccupancyJudge['judge']>;

/** 같은 입력을 양쪽에 넣고 `toEqual` 로 비교한다(단일 관용구). */
function parity(floors: unknown, detect: unknown, cfg?: { groundBandRatio?: number; minBandOverlap?: number }) {
  const judge = cfg ? new OccupancyJudge(cfg) : webJudge;
  const web = judge.judge(floors as WebInput[0], detect as WebInput[1]);
  const srv = srvJudge(floors, detect, cfg);
  expect(srv).toEqual(web);
  return srv;
}

describe('judgeOccupancy 파리티 — T1~T9 시나리오 재사용(web ↔ src)', () => {
  it('T1 번호판만(vehicles 없음)', () => {
    const rows = parity(FLOORS, { plates: [plateAt(0.2, 0.2), plateAt(0.6, 0.2)] });
    // 공허한 통과 방지 — 두 슬롯 모두 plate 로 점유된 상태여야 한다.
    expect(rows.map((r) => r.source)).toEqual(['plate', 'plate']);
  });

  it('T2 bbox만(plate 전무) — 임계 미달 차량 포함', () => {
    const rows = parity(FLOORS, { vehicles: [{ rect: R_IN_S1 }, { rect: R_BELOW_THRESH }] });
    expect(rows.map((r) => r.occupied)).toEqual([true, false]);
  });

  it('T3 plate + 같은 차량 bbox', () => {
    parity(FLOORS, { vehicles: [{ rect: R_IN_S1, plate: plateAt(0.2, 0.2) }] });
  });

  it('T4 검출 전무', () => {
    parity(FLOORS, {});
  });

  it('T5a bbox 2슬롯 경계(비대칭 argmax)', () => {
    parity(FLOORS, { vehicles: [{ rect: R_STRADDLE_S1 }] });
  });

  it('T5b bbox 2슬롯 경계(정확 동률) — strict 비교 tie-break 가 양쪽 동일', () => {
    const rows = parity(FLOORS, { vehicles: [{ rect: R_STRADDLE_TIE }] });
    // 동률에서 **어느 쪽을 고르는가**까지 같아야 의미가 있다(개수만 같으면 통과하는 것을 막는다).
    expect(rows.filter((r) => r.occupied).length).toBe(1);
  });

  it('T6 우선순위 혼합(standalone plate + 무번호판 차량)', () => {
    parity(FLOORS, {
      plates: [plateAt(0.2, 0.2)],
      vehicles: [{ rect: { x: 0.5, y: 0.0, w: 0.25, h: 0.35 } }],
    });
  });

  it('T7 plate 중심이 전 폴리곤 밖인 plate 보유 차량', () => {
    parity(FLOORS, { vehicles: [{ rect: R_IN_S1, plate: plateAt(0.2, 0.9) }] });
  });

  it('T8 한 슬롯 bbox 후보 2대 → 겹침 최대 차량 채택', () => {
    parity(FLOORS, {
      vehicles: [{ rect: { x: 0.3, y: 0.0, w: 0.15, h: 0.35 } }, { rect: R_IN_S1 }],
    });
  });

  it('T9 graceful — null/비배열/퇴화 rect', () => {
    parity(null, { vehicles: [{ rect: R_IN_S1 }] });
    parity(undefined, {});
    parity(FLOORS, null);
    parity(FLOORS, undefined);
    parity(FLOORS, { vehicles: [{ rect: { x: 0.05, y: 0.3, w: 0.25, h: 0 } }, { rect: R_IN_S1 }] });
    parity(FLOORS, { vehicles: [{}, { rect: R_IN_S1 }] }); // rect 누락 차량.
  });
});

describe('judgeOccupancy 파리티 — 퇴화 입력(실제 사고는 항상 여기서 났다)', () => {
  it('plates:null / vehicles:null', () => {
    parity(FLOORS, { plates: null, vehicles: null });
  });

  it('plates 비배열 / vehicles 비배열', () => {
    parity(FLOORS, { plates: 'x', vehicles: 7 });
  });

  it('비4점 quad(3점·5점) 번호판 → 중심 null 로 후보 탈락', () => {
    parity(FLOORS, { plates: [{ quad: [{ x: 0.2, y: 0.2 }, { x: 0.21, y: 0.2 }, { x: 0.21, y: 0.21 }] }] });
    parity(FLOORS, {
      plates: [{ quad: [...plateAt(0.2, 0.2).quad, { x: 0.2, y: 0.2 }] }],
    });
  });

  it('비수치 좌표 quad → 중심 null', () => {
    parity(FLOORS, { plates: [{ quad: [{ x: '0.2', y: 0.2 }, { x: 0.21, y: 0.2 }, { x: 0.21, y: 0.21 }, { x: 0.2, y: 0.21 }] }] });
  });

  it('quad 누락 번호판 / plate:null 차량', () => {
    parity(FLOORS, { plates: [{}], vehicles: [{ rect: R_IN_S1, plate: null }] });
  });

  it('w=0 / h=0 / 음수 폭 rect → 밴드 면적 0 스킵', () => {
    parity(FLOORS, { vehicles: [{ rect: { x: 0.05, y: 0.0, w: 0, h: 0.35 } }] });
    parity(FLOORS, { vehicles: [{ rect: { x: 0.05, y: 0.0, w: 0.25, h: 0 } }] });
    parity(FLOORS, { vehicles: [{ rect: { x: 0.05, y: 0.0, w: -0.25, h: 0.35 } }] });
  });

  it('floorPolygons 빈 배열 / quad 퇴화(2점) 폴리곤', () => {
    parity([], { vehicles: [{ rect: R_IN_S1 }], plates: [plateAt(0.2, 0.2)] });
    parity([{ idx: 1, quad: [{ x: 0, y: 0 }, { x: 0.4, y: 0 }] }], { plates: [plateAt(0.2, 0.2)] });
  });

  it('같은 좌표 번호판이 plates[] 와 vehicles[].plate 양쪽에 실린 경우(quadKey 중복 차단)', () => {
    const p = plateAt(0.2, 0.2);
    // JSON 왕복을 흉내내 **참조는 다르고 좌표는 같은** 판을 만든다 — quadKey 로만 걸러진다.
    const clone = JSON.parse(JSON.stringify(p)) as typeof p;
    parity(FLOORS, { plates: [clone], vehicles: [{ rect: R_IN_S1, plate: p }] });
  });
});

describe('judgeOccupancy 파리티 — cfg 오버라이드', () => {
  it('minBandOverlap 상향(0.99)', () => {
    parity(FLOORS, { vehicles: [{ rect: { x: 0.3, y: 0.0, w: 0.15, h: 0.35 } }] }, { minBandOverlap: 0.99 });
  });

  it('minBandOverlap 하향(0.01) — 임계 미달 차량이 점유로 올라온다', () => {
    const rows = parity(FLOORS, { vehicles: [{ rect: R_BELOW_THRESH }] }, { minBandOverlap: 0.01 });
    expect(rows[1].occupied).toBe(true); // 기본 임계(0.15)에서는 false 였던 케이스 — 오버라이드가 실제로 먹었다.
  });

  it('groundBandRatio 오버라이드(1.0 = bbox 전체 / 0.05 = 얇은 밴드)', () => {
    parity(FLOORS, { vehicles: [{ rect: R_STRADDLE_S1 }] }, { groundBandRatio: 1.0 });
    parity(FLOORS, { vehicles: [{ rect: R_STRADDLE_S1 }] }, { groundBandRatio: 0.05 });
  });

  it('두 값 동시 오버라이드', () => {
    parity(FLOORS, { vehicles: [{ rect: R_STRADDLE_TIE }, { rect: R_BELOW_THRESH }] }, {
      groundBandRatio: 0.5,
      minBandOverlap: 0.3,
    });
  });
});

/**
 * ★ 봉인 강화 — 검증자 음성 대조(변이 주입)로 **위 케이스들이 못 잡는 것**이 확인된 자리다.
 *   각 it 은 "이 변이를 잡는다"를 명시한다. 지우면 그 변이가 green 으로 통과하게 된다.
 */
describe('judgeOccupancy 파리티 — 봉인 강화(음성 대조로 발견한 구멍)', () => {
  // 잡는 변이: 2단계 폴백의 인덱스 사영 `rows[openPos[k]]` → `rows[k]`.
  // 위 T1~T9 는 전부 openPos 가 **항등 사영**이었다(1단계 점유가 없거나, 점유가 뒤 슬롯이라 openPos[0]===0).
  // 1단계가 **앞** 슬롯을 먹고 2단계가 **뒤** 슬롯을 채워야 사영이 항등이 아니게 되어 변이가 드러난다.
  it('1단계 bbox=slot1 + 2단계 plate=slot2 — openPos 사영이 항등이 아닌 조합', () => {
    const rows = parity(FLOORS, { plates: [plateAt(0.6, 0.2)], vehicles: [{ rect: R_IN_S1 }] });
    // 사영이 무너지면 slot1 의 bbox 행이 plate 로 덮이고 slot2 가 비어 여기서 갈린다.
    expect(rows.map((r) => r.source)).toEqual(['bbox', 'plate']);
    expect(rows.map((r) => r.occupied)).toEqual([true, true]);
  });

  // 잡는 변이: `groundBand(rect, groundBandRatio)` → `groundBand(rect)`(cfg 오버라이드 무시).
  // ★ 위 'cfg 오버라이드' describe 의 groundBandRatio 케이스 3건은 **폴리곤이 rect 의 y 범위를 전부 덮어**
  //   밴드의 y 위치·높이가 겹침 비율에 영향을 주지 않는 기하다 — 즉 ratio 가 무시돼도 같은 답이 나온다.
  //   여기서는 폴리곤이 y 0.30~0.40 만 덮어 밴드의 y 범위가 결과를 실제로 바꾸게 한다.
  describe('groundBandRatio 가 실제로 결과를 바꾸는 기하(폴리곤이 rect y범위를 부분만 덮음)', () => {
    const PARTIAL = [{ idx: 1, quad: floorQuad(0.0, 0.30, 0.4, 0.40) }];
    const R: Rect = { x: 0.05, y: 0.0, w: 0.25, h: 0.35 };

    it('민감도 자체 확인 — ratio 1.0 과 기본값(0.25)이 서로 다른 답을 낸다', () => {
      // 이 단정이 깨지면 아래 파리티 케이스가 다시 "ratio 에 둔감한 기하"로 퇴화한 것이다.
      const wide = srvJudge(PARTIAL, { vehicles: [{ rect: R }] }, { groundBandRatio: 1.0 });
      const base = srvJudge(PARTIAL, { vehicles: [{ rect: R }] });
      expect(wide[0].occupied).not.toBe(base[0].occupied);
    });

    it('web ↔ src 일치(ratio 1.0 / 0.05 / 기본값)', () => {
      parity(PARTIAL, { vehicles: [{ rect: R }] }, { groundBandRatio: 1.0 });
      parity(PARTIAL, { vehicles: [{ rect: R }] }, { groundBandRatio: 0.05 });
      parity(PARTIAL, { vehicles: [{ rect: R }] });
    });
  });
});

describe('computeOccupancy 파리티(2단계 폴백의 기반 — web/core.js ↔ src)', () => {
  const cases: Array<[string, unknown, unknown]> = [
    ['정상 2슬롯', FLOORS, [plateAt(0.2, 0.2), plateAt(0.6, 0.2)]],
    ['첫 매칭만 채택(같은 슬롯 2판)', FLOORS, [plateAt(0.1, 0.1), plateAt(0.2, 0.2)]],
    ['polygons null', null, [plateAt(0.2, 0.2)]],
    ['polygons 비배열', 'x', [plateAt(0.2, 0.2)]],
    ['plates null', FLOORS, null],
    ['plates 비배열', FLOORS, 3],
    ['plates 빈 배열', FLOORS, []],
    ['비4점 quad', FLOORS, [{ quad: [{ x: 0.2, y: 0.2 }] }]],
    ['quad 누락', FLOORS, [{}]],
    ['폴리곤 quad 누락', [{ idx: 1 }], [plateAt(0.2, 0.2)]],
  ];
  for (const [name, floors, plates] of cases) {
    it(name, () => {
      expect(srvComputeOccupancy(floors, plates)).toEqual(
        webComputeOccupancy(floors as never, plates as never),
      );
    });
  }
});
