import { describe, it, expect } from 'vitest';
// 순수 ESM(브라우저 API 미참조) 직접 import — 전역 인덱스(PtzCamRoi.idx) 순수 로직.
import {
  normalizeGlobalIdx,
  reindexPlaceSpace,
  removePlaceSpace,
  buildFlatSlotRows,
  selectFloorRoi,
  type PlaceRoiMap,
} from '../web/core.js';
// 경계면 교차검증용 서버 실함수(모킹 아님).
import { applyPlaceRoiUpdate, normalizePtzCamRoi } from '../src/capture/placeRoi.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 검증자(qa-tester): 정밀수집 우측 패널 — 전체 주차면 리스트 + 전역 인덱스(R2/R3/R4).
 * 근거: 01_architect_plan.md §3/§6 + 02_developer_changes.md §2.
 * 포함:
 *  - normalizeGlobalIdx / reindexPlaceSpace / removePlaceSpace 경계·불변식·불변성
 *  - buildFlatSlotRows — 삭제된 buildSlotListGroups.test.ts 의 동등 커버리지 복원
 *    (점유 재계산 · DB 태그 우선 · 빈/malformed 입력 강등=throw 금지)
 *  - 경계면 교차: web/core.js 정규화 출력 ↔ src/capture/placeRoi.ts applyPlaceRoiUpdate 입력(왕복)
 *  - 동결 픽스처 test/fixtures/PtzCamRoi.unity.json 왕복(스키마 키 보존). 런타임 가변 데이터(data/Place01) 미사용.
 * 브라우저 라이브(행 클릭 물리 이동·오버레이 하이라이트)는 DOM 의존 — 여기서 미검증(리포트에 명시).
 */

type Pt = { x: number; y: number };

/** 4점 정사각 quad(좌상 (x,y), 한 변 s). */
function quad(x: number, y: number, s = 0.08): Pt[] {
  return [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
}

/** 프리셋 하나: n개 space(0-based idx — Unity 생성 형태), 서로 겹치지 않는 quad. */
function preset0Based(n: number, row: number): { idx: number; points: Pt[] }[] {
  return Array.from({ length: n }, (_, i) => ({ idx: i, points: quad(0.02 + i * 0.1, row) }));
}

/** 실데이터형(cam1: preset1=7, preset2=6, preset3=4 / 전부 0-based idx → 총 17면). */
function makeRealShaped(): PlaceRoiMap {
  return {
    '1:1': preset0Based(7, 0.1),
    '1:2': preset0Based(6, 0.3),
    '1:3': preset0Based(4, 0.5),
  };
}

/** 각 프리셋의 idx 배열(배열 순서 그대로). */
function idxOf(pr: PlaceRoiMap, key: string): number[] {
  return (pr[key] ?? []).map((s) => s.idx);
}

/** 사후조건 불변식: 전 주차면 idx 집합 === {1..N}, 중복 0. */
function expectIdxSetIs1toN(pr: PlaceRoiMap): void {
  const all = Object.values(pr).flat().map((s) => s.idx);
  const n = all.length;
  expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  expect(new Set(all).size).toBe(n);
}

// ===== normalizeGlobalIdx (계획 §6 1~6) =====

describe('normalizeGlobalIdx — 전역 인덱스 정규화(R3)', () => {
  it('실데이터형(프리셋별 0-based 중복) → cam asc→preset asc→배열순 기준 1..17 재부여', () => {
    const { placeRoi, changed, issues } = normalizeGlobalIdx(makeRealShaped());
    expect(changed).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    expect(idxOf(placeRoi, '1:1')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(idxOf(placeRoi, '1:2')).toEqual([8, 9, 10, 11, 12, 13]);
    expect(idxOf(placeRoi, '1:3')).toEqual([14, 15, 16, 17]);
    expectIdxSetIs1toN(placeRoi);
  });

  it('멱등 — 이미 1..N 고유면 무변경(changed:false, 커스텀 번호 보존)', () => {
    const once = normalizeGlobalIdx(makeRealShaped()).placeRoi;
    const twice = normalizeGlobalIdx(once);
    expect(twice.changed).toBe(false);
    expect(twice.issues).toEqual([]);
    expect(twice.placeRoi).toEqual(once);
  });

  it('사용자 재지정(1..N 고유·순서 뒤섞임) → 재부여하지 않고 그대로 보존', () => {
    const custom: PlaceRoiMap = {
      '1:1': [
        { idx: 3, points: quad(0.1, 0.1) },
        { idx: 1, points: quad(0.2, 0.1) },
      ],
      '1:2': [{ idx: 2, points: quad(0.3, 0.3) }],
    };
    const { placeRoi, changed } = normalizeGlobalIdx(custom);
    expect(changed).toBe(false);
    expect(idxOf(placeRoi, '1:1')).toEqual([3, 1]); // 순서·번호 그대로.
    expect(idxOf(placeRoi, '1:2')).toEqual([2]);
  });

  it('누락(1,2,4 — N=3 초과값) → 재부여 + issues 기록', () => {
    const gappy: PlaceRoiMap = {
      '1:1': [
        { idx: 1, points: quad(0.1, 0.1) },
        { idx: 2, points: quad(0.2, 0.1) },
        { idx: 4, points: quad(0.3, 0.1) }, // N=3 이므로 범위 이탈.
      ],
    };
    const { placeRoi, changed, issues } = normalizeGlobalIdx(gappy);
    expect(changed).toBe(true);
    expect(issues.some((s) => s.includes('4'))).toBe(true);
    expect(idxOf(placeRoi, '1:1')).toEqual([1, 2, 3]);
  });

  it('malformed idx(비정수·0·음수·NaN·문자열) → throw 없이 재부여(강등)', () => {
    const bad = {
      '1:1': [
        { idx: 1.5, points: quad(0.1, 0.1) },
        { idx: 0, points: quad(0.2, 0.1) },
        { idx: -3, points: quad(0.3, 0.1) },
        { idx: Number.NaN, points: quad(0.4, 0.1) },
        { idx: '2', points: quad(0.5, 0.1) },
      ],
    } as unknown as PlaceRoiMap;
    const { placeRoi, changed, issues } = normalizeGlobalIdx(bad);
    expect(changed).toBe(true);
    expect(issues.length).toBe(5);
    expect(idxOf(placeRoi, '1:1')).toEqual([1, 2, 3, 4, 5]);
    expectIdxSetIs1toN(placeRoi);
  });

  it('빈 입력 / null / undefined → 무크래시(강등)', () => {
    expect(normalizeGlobalIdx({})).toEqual({ placeRoi: {}, changed: false, issues: [] });
    expect(normalizeGlobalIdx(null)).toEqual({ placeRoi: {}, changed: false, issues: [] });
    expect(normalizeGlobalIdx(undefined)).toEqual({ placeRoi: {}, changed: false, issues: [] });
    // 키는 있으나 space 0개 → N=0, 재부여 없음.
    const empties = normalizeGlobalIdx({ '1:1': [], '1:2': [] });
    expect(empties.changed).toBe(false);
  });

  it('malformed 프리셋 값(배열 아님) → throw 없이 [] 로 강등, 키 보존', () => {
    const broken = { '1:1': null, '1:2': [{ idx: 5, points: quad(0.1, 0.1) }] } as unknown as PlaceRoiMap;
    const { placeRoi } = normalizeGlobalIdx(broken);
    expect(Object.keys(placeRoi).sort()).toEqual(['1:1', '1:2']);
    expect(placeRoi['1:1']).toEqual([]);
    expect(idxOf(placeRoi, '1:2')).toEqual([1]);
  });

  it('객체 키 순서가 뒤섞여도 (cam asc → preset asc) 기준으로 번호 부여', () => {
    const shuffled: PlaceRoiMap = {
      '1:3': preset0Based(2, 0.5),
      '1:1': preset0Based(2, 0.1),
      '1:2': preset0Based(2, 0.3),
    };
    const { placeRoi } = normalizeGlobalIdx(shuffled);
    expect(idxOf(placeRoi, '1:1')).toEqual([1, 2]);
    expect(idxOf(placeRoi, '1:2')).toEqual([3, 4]);
    expect(idxOf(placeRoi, '1:3')).toEqual([5, 6]);
  });

  it('좌표(points) 보존 + 원본 불변', () => {
    const src = makeRealShaped();
    const before = JSON.stringify(src);
    const { placeRoi } = normalizeGlobalIdx(src);
    expect(JSON.stringify(src)).toBe(before); // 원본 미변형.
    expect(placeRoi['1:2'][0].points).toEqual(src['1:2'][0].points); // 좌표 동일.
  });
});

// ===== reindexPlaceSpace (계획 §6 7~13) =====

describe('reindexPlaceSpace — 전역 인덱스 수정(R4, 밀어내기)', () => {
  const base = () => normalizeGlobalIdx(makeRealShaped()).placeRoi; // 1:1=1..7, 1:2=8..13, 1:3=14..17

  it('from<to (3→7): 사이 값이 -1 씩 당겨지고 대상이 7', () => {
    const out = reindexPlaceSpace(base(), 3, 7);
    // 1:1 배열순(pos)은 유지되고 idx 만 갱신: 원래 [1,2,3,4,5,6,7] → [1,2,7,3,4,5,6]
    expect(idxOf(out, '1:1')).toEqual([1, 2, 7, 3, 4, 5, 6]);
    expect(idxOf(out, '1:2')).toEqual([8, 9, 10, 11, 12, 13]); // 뒤쪽 프리셋 무영향.
    expectIdxSetIs1toN(out);
  });

  it('from>to (7→3): 사이 값이 +1 씩 밀리고 대상이 3', () => {
    const out = reindexPlaceSpace(base(), 7, 3);
    expect(idxOf(out, '1:1')).toEqual([1, 2, 4, 5, 6, 7, 3]);
    expectIdxSetIs1toN(out);
  });

  it('프리셋 경계를 넘는 이동(14→1): 소속 프리셋·좌표 불변, 번호만 전역 재부여', () => {
    const src = base();
    const out = reindexPlaceSpace(src, 14, 1);
    expect(idxOf(out, '1:3')).toEqual([1, 15, 16, 17]); // 대상은 여전히 1:3 소속.
    expect(idxOf(out, '1:1')).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(idxOf(out, '1:2')).toEqual([9, 10, 11, 12, 13, 14]);
    expect(out['1:3'].length).toBe(4); // 프리셋 소속 불변(이동 없음).
    expect(out['1:3'][0].points).toEqual(src['1:3'][0].points); // 좌표 불변.
    expectIdxSetIs1toN(out);
  });

  it('from===to → 원본 그대로(no-op)', () => {
    const src = base();
    expect(reindexPlaceSpace(src, 5, 5)).toBe(src);
  });

  it('경계: to<1 → 1 로 clamp / to>N → N 으로 clamp', () => {
    const lo = reindexPlaceSpace(base(), 5, -99);
    expect(idxOf(lo, '1:1')).toEqual([2, 3, 4, 5, 1, 6, 7]); // 5번이 1번으로.
    expectIdxSetIs1toN(lo);
    const hi = reindexPlaceSpace(base(), 5, 999);
    expect(idxOf(hi, '1:1')).toEqual([1, 2, 3, 4, 17, 5, 6]); // 5번이 마지막(17)로.
    expectIdxSetIs1toN(hi);
  });

  it('존재하지 않는 from / 비수치 to → 원본 그대로', () => {
    const src = base();
    expect(reindexPlaceSpace(src, 999, 1)).toBe(src);
    expect(reindexPlaceSpace(src, 3, Number.NaN)).toBe(src);
    expect(reindexPlaceSpace(null, 1, 2)).toEqual({});
  });

  it('불변성 — 원본 미변형', () => {
    const src = base();
    const before = JSON.stringify(src);
    reindexPlaceSpace(src, 14, 1);
    expect(JSON.stringify(src)).toBe(before);
  });

  it('재정규화 멱등 — 수정 결과는 이미 1..N 이므로 normalizeGlobalIdx 가 손대지 않음', () => {
    const out = reindexPlaceSpace(base(), 14, 1);
    expect(normalizeGlobalIdx(out).changed).toBe(false);
  });
});

// ===== removePlaceSpace (계획 §6 14~18) =====

describe('removePlaceSpace — 주차면 삭제 + 1..N 재압축(R4)', () => {
  const base = () => normalizeGlobalIdx(makeRealShaped()).placeRoi;

  it('중간 삭제(8) → 9..17 이 8..16 으로 재압축, 총 16면', () => {
    const out = removePlaceSpace(base(), 8);
    expect(idxOf(out, '1:1')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(idxOf(out, '1:2')).toEqual([8, 9, 10, 11, 12]); // 6→5면.
    expect(idxOf(out, '1:3')).toEqual([13, 14, 15, 16]);
    expectIdxSetIs1toN(out);
  });

  it('첫(1) / 마지막(17) 삭제', () => {
    const first = removePlaceSpace(base(), 1);
    expect(idxOf(first, '1:1')).toEqual([1, 2, 3, 4, 5, 6]);
    expectIdxSetIs1toN(first);
    const last = removePlaceSpace(base(), 17);
    expect(idxOf(last, '1:3')).toEqual([14, 15, 16]);
    expectIdxSetIs1toN(last);
  });

  it('프리셋의 마지막 1개 삭제 → 키는 [] 로 유지(저장 시 spaces:[] PUT 필요 — 키 삭제 금지)', () => {
    const single: PlaceRoiMap = {
      '1:1': [{ idx: 1, points: quad(0.1, 0.1) }],
      '1:2': [
        { idx: 2, points: quad(0.2, 0.3) },
        { idx: 3, points: quad(0.4, 0.3) },
      ],
    };
    const out = removePlaceSpace(single, 1);
    expect(Object.keys(out).sort()).toEqual(['1:1', '1:2']); // 키 보존.
    expect(out['1:1']).toEqual([]);
    expect(idxOf(out, '1:2')).toEqual([1, 2]);
  });

  it('없는 idx → 원본 그대로', () => {
    const src = base();
    expect(removePlaceSpace(src, 999)).toBe(src);
    expect(removePlaceSpace(src, 0)).toBe(src);
    expect(removePlaceSpace(null, 1)).toEqual({});
  });

  it('불변성 — 원본 미변형', () => {
    const src = base();
    const before = JSON.stringify(src);
    removePlaceSpace(src, 8);
    expect(JSON.stringify(src)).toBe(before);
  });
});

// ===== buildFlatSlotRows — 삭제된 buildSlotListGroups.test.ts 동등 커버리지 복원 =====

describe('buildFlatSlotRows — 전체 주차면 평면 목록(R2)', () => {
  // 1:1 = 전역 1,2 / 1:2 = 전역 3 (키 순서를 일부러 뒤집어 정렬을 검증).
  const placeRoi: PlaceRoiMap = {
    '1:2': [{ idx: 3, points: quad(0.1, 0.5) }],
    '1:1': [
      { idx: 1, points: quad(0.1, 0.1) },
      { idx: 2, points: quad(0.5, 0.1) },
    ],
  };

  it('globalIdx 오름차순 평면 정렬(프리셋 그룹 헤더·경계 없음)', () => {
    const rows = buildFlatSlotRows({ placeRoi });
    expect(rows.map((r) => r.globalIdx)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.key)).toEqual(['1:1', '1:1', '1:2']);
    expect(rows[2]).toMatchObject({ globalIdx: 3, cam: 1, preset: 2, key: '1:2' });
  });

  it('점유 재계산 — 번호판(plates) 중심이 폴리곤 내부면 occupied:true (computeOccupancy 재사용)', () => {
    const detectByKey = {
      // quad(0.1,0.1) 의 중심 ≈ (0.14, 0.14) → 전역 1 점유. 전역 2(0.5~) 는 비점유.
      '1:1': { plates: [{ quad: quad(0.12, 0.12, 0.04) }] },
    };
    const rows = buildFlatSlotRows({ placeRoi, detectByKey });
    expect(rows.find((r) => r.globalIdx === 1)?.occupied).toBe(true);
    expect(rows.find((r) => r.globalIdx === 2)?.occupied).toBe(false);
    expect(rows.find((r) => r.globalIdx === 3)?.occupied).toBe(false);
  });

  it('점유 재계산 — vehicles[].plate 도 번호판 소스에 합집합으로 포함', () => {
    const detectByKey = {
      '1:1': { vehicles: [{ plate: { quad: quad(0.52, 0.12, 0.04) } }] }, // 전역 2 내부.
    };
    const rows = buildFlatSlotRows({ placeRoi, detectByKey });
    expect(rows.find((r) => r.globalIdx === 2)?.occupied).toBe(true);
    expect(rows.find((r) => r.globalIdx === 1)?.occupied).toBe(false);
  });

  it('DB 태그 우선 — parkingSlotsByKey 의 slotIdx===globalIdx 행이 occupied/vpd/lpd 를 덮어씀', () => {
    const detectByKey = { '1:1': { plates: [{ quad: quad(0.12, 0.12, 0.04) }] } }; // 파일 계산상 1 = 점유.
    const parkingSlotsByKey = {
      // 실제 GET /capture/runs/:id/slots 행 shape: vpd/lpd 는 객체 또는 null(불리언 아님).
      '1:1': [
        { slotIdx: 1, occupied: false, vpd: null, lpd: null }, // DB 가 '공차' → 파일 계산(점유)을 덮어씀.
        { slotIdx: 2, occupied: true, vpd: { x: 0, y: 0, w: 1, h: 1 }, lpd: [{ x: 0, y: 0 }] },
      ],
    } as unknown as Parameters<typeof buildFlatSlotRows>[0]['parkingSlotsByKey'];
    const rows = buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey });
    expect(rows.find((r) => r.globalIdx === 1)).toMatchObject({ occupied: false, vpd: false, lpd: false });
    expect(rows.find((r) => r.globalIdx === 2)).toMatchObject({ occupied: true, vpd: true, lpd: true });
    // DB 행이 없는 전역 3 → 파일 계산 폴백, 태그 없음.
    expect(rows.find((r) => r.globalIdx === 3)).toMatchObject({ occupied: false, vpd: false, lpd: false });
  });

  it('빈/누락/malformed 입력 → [] 또는 무크래시(강등 — throw 금지)', () => {
    expect(buildFlatSlotRows({ placeRoi: {} })).toEqual([]);
    expect(buildFlatSlotRows({ placeRoi: null })).toEqual([]);
    expect(buildFlatSlotRows({ placeRoi: undefined })).toEqual([]);
    expect(buildFlatSlotRows({} as Parameters<typeof buildFlatSlotRows>[0])).toEqual([]);
    // 프리셋 값이 배열 아님 / detect·db 누락 → 무크래시.
    const broken = { '1:1': null } as unknown as PlaceRoiMap;
    expect(buildFlatSlotRows({ placeRoi: broken, detectByKey: null, parkingSlotsByKey: null })).toEqual([]);
  });
});

// ===== 개발자 인계 #2: 구 run 의 0-based slot_idx ↔ 신 전역 idx 매칭 (오귀속 방지 회귀 감시) =====

describe('구 run(0-based slot_idx) × 신 전역 인덱스 — 오귀속 금지 · graceful 미부착', () => {
  // 배경: 최종화(Finalizer.ts:240)는 slotIdx = 파일의 raw idx 를 그대로 기록한다(서버엔 normalizeGlobalIdx 없음).
  // 파일이 0-based(미저장)인 채 최종화된 run 의 DB 행은 slot_idx 0..n-1 → 신 전역번호(1..N)와 '부분만' 겹친다.
  // 요구: 부분 겹침으로 한 칸 밀린 값을 붙이지 말고(오귀속 금지), 그 프리셋의 DB 행을 통째 기각해 파일 계산으로 폴백.
  const placeRoi = normalizeGlobalIdx(makeRealShaped()).placeRoi; // 1:1=1..7, 1:2=8..13, 1:3=14..17

  // 판별력 있는 fixture: 파일 계산과 '오귀속된 DB 값'이 서로 반대가 되도록 구성.
  //  - 파일 계산: globalIdx 1(quad(0.02,0.1)) 안에 번호판 → occupied=true 가 진실.
  //  - 구 run DB: slotIdx 1(= 배열 위치 1 = 신 globalIdx 2 의 데이터)은 occupied=false.
  //  ⇒ 오귀속이 되살아나면 globalIdx 1 이 false 가 되어 이 테스트가 실패한다.
  const detectByKey = { '1:1': { plates: [{ quad: quad(0.04, 0.12, 0.04) }] } }; // 중심 (0.06,0.14) ∈ globalIdx 1.
  const legacyDb = {
    '1:1': [
      { slotIdx: 0, occupied: true, vpd: {}, lpd: [{ x: 0, y: 0 }] }, // 배열 위치 0(= 신 globalIdx 1)의 진짜 데이터.
      ...Array.from({ length: 6 }, (_, i) => ({ slotIdx: i + 1, occupied: false, vpd: null, lpd: null })),
    ],
    '1:2': Array.from({ length: 6 }, (_, i) => ({ slotIdx: i, occupied: true, vpd: {}, lpd: null })),
  } as unknown as Parameters<typeof buildFlatSlotRows>[0]['parkingSlotsByKey'];

  it('오귀속 금지 — 0-based DB 행은 통째 기각되어 한 칸 밀린 값이 붙지 않는다(파일 계산으로 폴백)', () => {
    const rows = buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey: legacyDb });
    const g1 = rows.find((r) => r.globalIdx === 1);
    // DB 를 부분 매칭했다면 slotIdx 1(다른 주차면의 값) 때문에 occupied=false 가 됐을 것.
    expect(g1?.occupied).toBe(true); // 파일 계산(진실)이 살아남음.
    expect(g1?.vpd).toBe(false); // 체계가 다른 DB 태그는 채택하지 않음(미부착).
    expect(g1?.lpd).toBe(false);
  });

  it('graceful 미부착 — 구 run 프리셋 전체에 VPD/LPD 태그가 붙지 않고 크래시도 없다', () => {
    const rows = buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey: legacyDb });
    for (const r of rows) {
      expect(r.vpd).toBe(false);
      expect(r.lpd).toBe(false);
    }
    // 1:2 의 DB 는 전부 occupied:true 였지만 체계 불일치로 기각 → 파일 계산(번호판 없음) = 공차.
    for (const r of rows.filter((x) => x.key === '1:2')) expect(r.occupied).toBe(false);
    expect(rows.length).toBe(17); // 목록 자체는 파일(placeRoi) 소스이므로 전부 표시됨.
  });

  it('신 run(정규화 파일 저장 후 재최종화, slot_idx = 전역 idx) → 태그가 정확히 정합 부착', () => {
    // DB 행 집합이 그 프리셋의 파일 전역번호 집합(1..7)과 완전히 일치.
    const freshDb = {
      '1:1': [
        { slotIdx: 1, occupied: false, vpd: null, lpd: null }, // 파일 계산은 점유지만 DB(정합)가 우선 → 공차.
        { slotIdx: 2, occupied: true, vpd: { x: 0, y: 0, w: 1, h: 1 }, lpd: [{ x: 0, y: 0 }] },
        ...Array.from({ length: 5 }, (_, i) => ({ slotIdx: i + 3, occupied: false, vpd: null, lpd: null })),
      ],
    } as unknown as Parameters<typeof buildFlatSlotRows>[0]['parkingSlotsByKey'];
    const rows = buildFlatSlotRows({ placeRoi, detectByKey, parkingSlotsByKey: freshDb });
    expect(rows.find((r) => r.globalIdx === 1)).toMatchObject({ occupied: false, vpd: false, lpd: false }); // DB 우선.
    expect(rows.find((r) => r.globalIdx === 2)).toMatchObject({ occupied: true, vpd: true, lpd: true }); // 태그 부착.
  });

  it('부분 불일치(파일에서 1면 삭제 후 구 DB 잔존) → 그 프리셋 DB 행 통째 기각', () => {
    // 파일: 1:1 에서 1면 삭제 → 전역번호 재압축(N=16). DB 에는 삭제 전 번호(예: 17)가 남아 있음.
    const edited = removePlaceSpace(placeRoi, 3);
    const staleDb = {
      '1:1': [{ slotIdx: 1, occupied: true, vpd: {}, lpd: null }, { slotIdx: 99, occupied: true, vpd: {}, lpd: null }],
    } as unknown as Parameters<typeof buildFlatSlotRows>[0]['parkingSlotsByKey'];
    const rows = buildFlatSlotRows({ placeRoi: edited, parkingSlotsByKey: staleDb });
    expect(rows.find((r) => r.globalIdx === 1)).toMatchObject({ occupied: false, vpd: false, lpd: false }); // 기각.
    expect(rows.length).toBe(16);
  });
});

// ===== selectFloorRoi — idx 가산(회귀 0) =====

describe('selectFloorRoi — 파일 모드 idx 가산(선택 하이라이트용)', () => {
  it('파일 모드: quad/label 기존 필드 불변 + idx 추가', () => {
    const placeRoi: PlaceRoiMap = { '1:1': [{ idx: 5, points: quad(0.1, 0.1) }] };
    const out = selectFloorRoi({ useLlm: false, slots: [], placeRoi, key: '1:1' });
    expect(out.source).toBe('file');
    expect(out.polygons[0].quad).toEqual(placeRoi['1:1'][0].points);
    expect(out.polygons[0].label).toBe('5'); // 기존 필드 불변(String(idx)).
    expect(out.polygons[0].idx).toBe(5); // 신규 가산.
  });

  it('LLM 모드: 무변경(idx 미부여)', () => {
    const slots = [{ slotId: 'A-1', floorRoiByPreset: { '1:1': quad(0.2, 0.2) } }];
    const out = selectFloorRoi({ useLlm: true, slots, placeRoi: {}, key: '1:1' });
    expect(out.source).toBe('llm');
    expect(out.polygons[0]).toEqual({ quad: quad(0.2, 0.2), label: '', slotId: 'A-1' });
    expect(out.polygons[0].idx).toBeUndefined();
  });
});

// ===== 경계면 교차검증: web/core.js 정규화 출력 ↔ 서버 applyPlaceRoiUpdate 입력(왕복) =====

describe('경계면 교차 — 정규화 출력 shape ↔ applyPlaceRoiUpdate 입력 shape(왕복)', () => {
  /** savePlaceRoi(app.js:1142~1149) 와 동일한 순차 PUT 을 서버 실함수로 재현. */
  function saveAllPresets(json: unknown, placeRoi: PlaceRoiMap): unknown {
    let cur = json;
    for (const key of Object.keys(placeRoi)) {
      const [camId, presetIdx] = key.split(':').map(Number);
      cur = applyPlaceRoiUpdate(cur, { camId, presetIdx, spaces: placeRoi[key] }); // shape 그대로 소비.
      }
    return cur;
  }

  it('동결 픽스처 PtzCamRoi(Unity 원형): GET→정규화→저장(전 프리셋 순차 PUT)→재파싱 왕복에서 전역번호 1..17 보존', () => {
    const path = fileURLToPath(new URL('./fixtures/PtzCamRoi.unity.json', import.meta.url));
    const raw = JSON.parse(readFileSync(path, 'utf8'));

    // 1) GET → 서버/웹 동일 정규화. (원본은 프리셋별 0-based)
    const web = normalizePtzCamRoi(raw); // src(서버) 구현 — byPreset 은 Map.
    const byPreset: PlaceRoiMap = Object.fromEntries(web.byPreset) as PlaceRoiMap;
    expect(Object.keys(byPreset).sort()).toEqual(['1:1', '1:2', '1:3']);

    // 2) 전역 인덱스 정규화(웹).
    const norm = normalizeGlobalIdx(byPreset);
    expect(norm.changed).toBe(true);
    expect(idxOf(norm.placeRoi, '1:1')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(idxOf(norm.placeRoi, '1:3')).toEqual([14, 15, 16, 17]);

    // 3) 편집(수정 14→1) 후 4) 저장(전 프리셋 순차 PUT — 서버 실함수).
    const edited = reindexPlaceSpace(norm.placeRoi, 14, 1);
    const saved = saveAllPresets(raw, edited);

    // 5) 재파싱(GET 재조회 상당) → 전역번호가 파일에 그대로 보존.
    const reread = normalizePtzCamRoi(saved);
    const rr: PlaceRoiMap = Object.fromEntries(reread.byPreset) as PlaceRoiMap;
    expect(idxOf(rr, '1:3')).toEqual([1, 15, 16, 17]);
    expect(idxOf(rr, '1:1')).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(idxOf(rr, '1:2')).toEqual([9, 10, 11, 12, 13, 14]);
    expectIdxSetIs1toN(rr);
    expect(normalizeGlobalIdx(rr).changed).toBe(false); // 저장 후 재로드는 멱등(재부여 없음).

    // 좌표 왕복 정합(정규화→픽셀→정규화).
    const src14 = norm.placeRoi['1:3'][0].points;
    rr['1:3'][0].points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(src14[i].x, 10);
      expect(p.y).toBeCloseTo(src14[i].y, 10);
    });
  });

  it('스키마 키 보존 — cameras/camera/presets/preset_idx/parking_spaces/idx/points 불변', () => {
    const path = fileURLToPath(new URL('./fixtures/PtzCamRoi.unity.json', import.meta.url));
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const byPreset: PlaceRoiMap = Object.fromEntries(normalizePtzCamRoi(raw).byPreset) as PlaceRoiMap;
    const saved = saveAllPresets(raw, normalizeGlobalIdx(byPreset).placeRoi) as {
      cameras: Array<{
        camera: Record<string, unknown>;
        presets: Array<{ preset_idx: number; parking_spaces: Array<Record<string, unknown>> }>;
      }>;
    };
    expect(Object.keys(saved)).toEqual(Object.keys(raw));
    expect(Object.keys(saved.cameras[0])).toEqual(['camera', 'presets']);
    expect(saved.cameras[0].camera).toEqual(raw.cameras[0].camera); // 카메라 메타(fov/imageWidth 등) 보존.
    for (const p of saved.cameras[0].presets) {
      expect(Object.keys(p)).toEqual(['preset_idx', 'parking_spaces']);
      for (const sp of p.parking_spaces) {
        expect(Object.keys(sp)).toEqual(['idx', 'points']); // space 키 소실/추가 없음.
        expect((sp.points as number[][]).length).toBe(4);
        expect(Array.isArray((sp.points as number[][])[0])).toBe(true); // 픽셀 [x,y] 배열 형태 유지.
      }
    }
    // 파일 전체 전역번호 1..17.
    const allIdx = saved.cameras[0].presets.flatMap((p) => p.parking_spaces.map((s) => s.idx as number));
    expect([...allIdx].sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });

  it('빈 프리셋(spaces:[]) PUT — 삭제로 비워진 프리셋도 서버가 빈 배열로 반영(키 유지가 필요한 이유)', () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL('./fixtures/PtzCamRoi.unity.json', import.meta.url)), 'utf8'),
    );
    const out = applyPlaceRoiUpdate(raw, { camId: 1, presetIdx: 3, spaces: [] }) as {
      cameras: Array<{ presets: Array<{ preset_idx: number; parking_spaces: unknown[] }> }>;
    };
    const p3 = out.cameras[0].presets.find((p) => p.preset_idx === 3);
    expect(p3?.parking_spaces).toEqual([]); // 프리셋 키는 남고 주차면만 비워짐.
  });
});
