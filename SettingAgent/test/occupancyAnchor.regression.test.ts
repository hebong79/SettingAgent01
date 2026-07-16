import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OccupancyJudge } from '../web/occupancy.js';
import { normalizePtzCamRoi, selectFloorRoi, presetKey, buildFlatSlotRows } from '../web/core.js';
import { computeOccupancyRegions } from '../web/occupancyRegion.js';

/**
 * 점유 매칭 앵커(plate 중심 → 차량 접지밴드 argmax) 회귀 봉인 — 설계 06 §6.
 * A군 = 합성 케이스(메커니즘 봉인), R군 = 진단 05 의 라이브 실좌표 픽스처 동결(재발 시 FAIL).
 */

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const judge = new OccupancyJudge();

// ===== A군: 합성 케이스(occupancyJudge.test.ts 픽스처 규약 재사용) =====

function floorQuad(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

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
const R_IN_S1: Rect = { x: 0.05, y: 0.0, w: 0.25, h: 0.35 }; // 밴드 전부 slot1 → ratio≈1
const R_PARTIAL_S1: Rect = { x: 0.3, y: 0.0, w: 0.15, h: 0.35 }; // slot1 0.667 / slot2 0.333 → argmax slot1

describe('점유 앵커 A군 — 합성 메커니즘 봉인', () => {
  it('A1 plate 중심이 이웃 슬롯에 든 차량 → 차량 접지 슬롯만 점유(이웃 오귀속 없음)', () => {
    // 시차 재현: 차량은 slot1 에 접지, 그 번호판 중심은 slot2 내부.
    const veh = { rect: R_IN_S1, plate: plateAt(0.6, 0.2) };
    const rows = judge.judge(FLOORS, { vehicles: [veh] });
    expect(rows[0].occupied).toBe(true);
    expect(rows[0].source).toBe('plate');
    expect(rows[0].plateQuad).toEqual(veh.plate.quad);
    expect(rows[1]).toEqual({ idx: 2, occupied: false, source: null }); // 이웃 슬롯 오귀속 금지
  });

  it('A2 plate 중심이 전 폴리곤 밖인 차량 → 접지 슬롯 점유 + source=plate(열끝 소실 봉인)', () => {
    // 구 T7 입력과 동일. 구 구현은 source:'bbox' → 사다리꼴 미생성(=열 끝 차 소실).
    const veh = { rect: R_IN_S1, plate: plateAt(0.2, 0.9) };
    const rows = judge.judge(FLOORS, { vehicles: [veh] });
    expect(rows[0]).toEqual({
      idx: 1,
      occupied: true,
      source: 'plate',
      center: { x: 0.2, y: 0.9 },
      plateQuad: veh.plate.quad,
      vehicleRect: R_IN_S1,
    });
  });

  it('A3 plate quad 퇴화(비4점) 차량 → source=bbox 로 강등, throw 없음', () => {
    const veh = { rect: R_IN_S1, plate: { quad: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }] } };
    let rows: ReturnType<typeof judge.judge> = [];
    expect(() => (rows = judge.judge(FLOORS, { vehicles: [veh as never] }))).not.toThrow();
    expect(rows[0]).toEqual({ idx: 1, occupied: true, source: 'bbox', vehicleRect: R_IN_S1 });
  });

  it('A4 배치 차량의 attached plate 가 plates[] 에도 있으면 폴백 중복 마킹 없음', () => {
    const plate = plateAt(0.6, 0.2); // 중심 slot2 — 좌표키 제외가 없으면 slot2 가 잘못 점유된다.
    const veh = { rect: R_IN_S1, plate };
    const rows = judge.judge(FLOORS, {
      vehicles: [veh],
      plates: [{ quad: plate.quad.map((p) => ({ ...p })) }], // 서버 직렬화 동수치 사본(참조 불일치)
    });
    expect(rows.filter((r) => r.occupied).map((r) => r.idx)).toEqual([1]);
  });

  it('A5 차량 미검출 + standalone plate 만 → 그 슬롯 plate 점유(S2 계약 유지)', () => {
    const rows = judge.judge(FLOORS, { plates: [plateAt(0.6, 0.2)] });
    expect(rows[1].occupied).toBe(true);
    expect(rows[1].source).toBe('plate');
    expect(rows[0].occupied).toBe(false);
  });

  it('A6 슬롯 경합 → 승자는 ratio 최대 차량, 패자 plate 는 빈 이웃 슬롯을 폴백 점유', () => {
    const winner = { rect: R_IN_S1, plate: plateAt(0.1, 0.1) }; // ratio≈1
    const loser = { rect: R_PARTIAL_S1, plate: plateAt(0.6, 0.2) }; // slot1 ratio 0.667 → 경합 패배
    const rows = judge.judge(FLOORS, { vehicles: [winner, loser] });
    expect(rows[0].vehicleRect).toEqual(R_IN_S1);
    expect(rows[0].source).toBe('plate');
    expect(rows[1].occupied).toBe(true); // 패자 plate 가 비점유 slot2 를 폴백 점유
    expect(rows[1].source).toBe('plate');
  });

  it('A7 결정성: 같은 입력 2회 → 딥이퀄', () => {
    const detect = {
      vehicles: [
        { rect: R_IN_S1, plate: plateAt(0.1, 0.1) },
        { rect: R_PARTIAL_S1, plate: plateAt(0.6, 0.2) },
      ],
    };
    expect(judge.judge(FLOORS, detect)).toEqual(judge.judge(FLOORS, detect));
  });
});

// ===== R군: 진단 05 실좌표 픽스처 동결 =====
// 출처: _workspace/_qa_data_iter3(라이브 GET /capture/place-roi + POST /capture/detect) 무가공 동결.
//
// 픽스처 2종 병존(설계 09 §5-5 의 "p1 재동결" 을 **교체가 아니라 병존**으로 이행 — 사유는 아래).
//  ① detect_cam1_p{1,2,3}.json  = **구 서버**(2층 결함 有) 산출. R1~R7 의 1층(앵커) 봉인용.
//  ② detect_cam1_p1_fixed.json  = **수정 서버**(전역 그리디+중복 가드) 라이브 산출(_qa_data_final2).
//                                  R5b 전용 — 2층 수정의 뷰어 레벨 귀결(사다리꼴 겹침 소멸) 봉인.
//
// 왜 ①을 ②로 갈아끼우지 않는가(실측 근거):
//  - 갈아끼워도 1층 판별력은 살아있다(구 judge = computeOccupancy 가 신규 데이터에서도 p1/p2/p3 에서
//    slot 5/10/17 을 동일하게 놓친다 — 1층 결함은 서버가 아니라 뷰어 매칭 문제라 데이터와 무관).
//    즉 교체가 R군을 무력화하지는 않는다.
//  - 그러나 이 파일은 **이중 역할**이다: R군은 서버 산출(vehicles[].plate)을 소비하고,
//    plateMatch.test.ts N1/N2 는 같은 파일을 **matcher 입력**(vehicles[].rect·plates[])으로 소비한다.
//    수정 서버 재검출에서 VPD 차량 반환 순서가 바뀌어(p1 은 7대 중 5대가 재색인) ① 을 교체하면
//    N1 의 단언 5개와 진단 08 실측 서술(동률 847.7px²·상대 veh4)이 통째로 재작성 대상이 된다 —
//    정상 동작 중인 2층 봉인의 불필요한 개작이자, 진단 08 이 분석한 바로 그 장면과의 추적성 상실.
//  - R5b 는 **수정 서버 산출이 반드시 필요**하다(① 의 vehicles[6].plate = 옆차에서 훔친 판(1367,676)은
//    수정 서버가 더는 생성하지 않는 값이라, ① 로는 원리적으로 표현할 수 없다).
//  → 각 픽스처를 그것이 증거인 대상에만 쓴다. place_roi 는 구/신이 의미 동일(JSON 동등)이라 1종 유지.

const FIX = new URL('./fixtures/occupancyAnchor/', import.meta.url);
const readFix = (name: string) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));

const PLACE_ROI = normalizePtzCamRoi(readFix('place_roi.json')).byPreset;
const DETECT: Record<number, any> = {
  1: readFix('detect_cam1_p1.json'),
  2: readFix('detect_cam1_p2.json'),
  3: readFix('detect_cam1_p3.json'),
};
/** 수정 서버(설계 09) 라이브 재검출 p1 — veh6 이 자기 판(1559,674, recovered:false)을 보유. */
const DETECT_P1_FIXED: any = readFix('detect_cam1_p1_fixed.json');
/** 프리셋별 (슬롯 수, 화면상 차량 수) — 진단 05 §1 실측. */
const EXPECTED_IDX: Record<number, number[]> = {
  1: [1, 2, 3, 4, 5, 6, 7],
  2: [13, 12, 11, 10, 9, 8], // 파일 순서(우→좌)
  3: [14, 15, 16, 17],
};

function floorsOf(preset: number) {
  const key = presetKey(1, preset);
  return selectFloorRoi({ useLlm: false, placeRoi: PLACE_ROI, key }).polygons.map((p) => ({
    idx: Number(p.label),
    quad: p.quad,
  }));
}
const judgeOf = (preset: number) => judge.judge(floorsOf(preset), DETECT[preset]);

describe('점유 앵커 R군 — 라이브 실좌표 회귀 봉인(진단 05)', () => {
  for (const preset of [1, 2, 3]) {
    it(`R${preset} cam1 p${preset}: 점유 = 전 슬롯 ${EXPECTED_IDX[preset].length}면, 전행 source=plate`, () => {
      // 구 구현: p1 slot5 소실(5→6·6→7 오귀속), p2 slot10 소실(10→9·9→8), p3 slot17 은 bbox 강등.
      const rows = judgeOf(preset);
      expect(rows.filter((r) => r.occupied).map((r) => r.idx).sort((a, b) => a - b)).toEqual(
        [...EXPECTED_IDX[preset]].sort((a, b) => a - b),
      );
      for (const r of rows) {
        expect(r.source).toBe('plate');
        expect(r.plateQuad).toBeDefined();
      }
    });
  }

  it('R4 슬롯↔차량 귀속 정확성(p1) — 라벨 시프트 봉인', () => {
    const rows = judgeOf(1);
    const vehicles = DETECT[1].vehicles;
    const rectOf = (idx: number) => rows.find((r) => r.idx === idx)?.vehicleRect;
    expect(rectOf(5)).toEqual(vehicles[0].rect); // 구 구현: slot5 미점유(veh0 는 라벨 6 으로 표시)
    expect(rectOf(6)).toEqual(vehicles[6].rect);
    expect(rectOf(7)).toEqual(vehicles[4].rect); // 열 끝 차 — 구 구현에선 아무 표시도 없었음
  });

  const regionsFor = (preset: number, detect: any) =>
    computeOccupancyRegions(
      judge
        .judge(floorsOf(preset), detect)
        .filter((o) => o.source === 'plate' && o.plateQuad)
        .map((o) => ({ idx: o.idx, quad: o.plateQuad as Pt[] })),
    );
  const regionsOf = (preset: number) => regionsFor(preset, DETECT[preset]);

  it('R5 사다리꼴 모집단 1:1(app.js:371 식) — regions 7/6/4', () => {
    // 구 구현: 6/5/3(열 끝 차량의 판이 매칭 실패해 모집단에서 소실).
    for (const preset of [1, 2, 3]) {
      expect(regionsOf(preset).regions.length).toBe(EXPECTED_IDX[preset].length);
    }
  });

  it('R5 겹침 없음(p2·p3)', () => {
    for (const preset of [2, 3]) expect(regionsOf(preset).overlapPairs).toEqual([]);
  });

  // R5b — 2층 결함(상류 recovered plate 오귀속)의 뷰어 레벨 봉인. **it.fails → 양성 전환**(설계 09 §5-5).
  //
  // 구 서버(detect_cam1_p1.json): vehicles[6].plate(recovered:true, 중심 1367,676)가 vehicles[0].plate
  // (1348,678)와 18.8px 거리 — 줌 재시도가 겹침 구간에서 **옆차 판을 회수**했다. veh6 의 진짜 판
  // (1559,674)은 base 매칭에서 폐기돼 standalone 으로 남았고 slot6 이 이미 점유라 폴백도 못 썼다
  // → 사다리꼴 5·6 이 같은 차 위에 겹침(overlapPairs=[[5,6]]).
  // 수정 서버(전역 그리디 + frontAnchor + 재시도 중복 가드, 설계 09): veh6 이 base 에서 **자기 판
  // (1559,674, recovered:false)** 을 얻어 겹침이 소멸한다(검증 11 §2 라이브 실측).
  //
  // 이 테스트는 구 픽스처(detect_cam1_p1.json)를 주입하면 [[5,6]] 로 **FAIL 한다** — 판별력 확인 완료.
  // regions 수를 함께 단언하는 이유: overlapPairs=[] 는 사다리꼴 모집단이 비면 **공허하게 참**이 된다.
  it('R5b p1 겹침 없음 — 수정 서버 산출에서 recovered 오귀속 소멸(설계 09 2층 수정 봉인)', () => {
    const { regions, overlapPairs } = regionsFor(1, DETECT_P1_FIXED);
    expect(regions.length).toBe(EXPECTED_IDX[1].length); // 7 — 공허한 통과 방지
    expect(overlapPairs).toEqual([]);
    // 결함의 본체가 사라졌음을 원인 층에서도 못박는다: veh6 은 자기 판을 base 매칭으로 보유.
    const veh6Plate = DETECT_P1_FIXED.vehicles[6].plate;
    expect(veh6Plate.recovered ?? false).toBe(false);
  });

  it('R6 buildFlatSlotRows judge 주입 → 전역 [1..17] 전량 점유 / 미전달 시 구 경로(하위호환)', () => {
    const detectByKey = { '1:1': DETECT[1], '1:2': DETECT[2], '1:3': DETECT[3] };
    const injected = buildFlatSlotRows({ placeRoi: PLACE_ROI, detectByKey, judge });
    expect(injected.map((r) => r.globalIdx)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(injected.every((r) => r.occupied)).toBe(true);

    // 미전달(하위호환) 경로는 기존 computeOccupancy 결과 그대로 — 구 결함(5·10·17 미점유)이 남는다.
    const legacy = buildFlatSlotRows({ placeRoi: PLACE_ROI, detectByKey });
    expect(legacy.filter((r) => !r.occupied).map((r) => r.globalIdx)).toEqual([5, 10, 17]);
  });

  it('R7 최종화 스냅샷 의미(DB parking_slots.occupied 교정) — 17행 전량 true', () => {
    const snapshot = [1, 2, 3].flatMap((preset) =>
      judgeOf(preset).map((r) => ({ idx: r.idx, occupied: !!r.occupied })),
    );
    expect(snapshot.length).toBe(17);
    expect(snapshot.every((s) => s.occupied)).toBe(true);
  });
});
