import { describe, it, expect } from 'vitest';
import {
  groundBand,
  isVehicleOnPlace,
  filterVehiclesOnPlace,
  filterPlatesOnPlace,
  GROUND_BAND_RATIO,
  ON_PLACE_MIN_OVERLAP,
} from '../src/capture/onPlaceFilter.js';
import { pointInPolygon } from '../src/domain/polygon.js';
import { center, quadBoundingRect, quadCentroid } from '../src/domain/geometry.js';
import type { NormalizedPoint, NormalizedQuad, NormalizedRect } from '../src/domain/types.js';
import type { PlateBox } from '../src/clients/LpdClient.js';

/**
 * 검증자(qa-tester): 주차면 위 차량 필터(모드A) 순수 유닛 — 01_architect_plan.md §6 항목 1~7.
 *
 * 봉인 대상은 **규칙의 논리**다(임계값의 *적절성*은 유닛테스트가 봉인하지 못한다 — §7-1, 라이브 검증 소관).
 * 핵심은 항목 2: **중심 규칙(대안 a)을 기각한 설계 결정**이 실제로 성립함을 회귀로부터 봉인한다.
 */

/** 뒷줄 주차면(바닥 quad). 원근으로 가까운 변(y 큰 쪽)이 약간 넓다. 통로는 y > 0.45. */
const BACK_ROW: NormalizedPoint[] = [
  { x: 0.30, y: 0.30 },
  { x: 0.56, y: 0.30 },
  { x: 0.58, y: 0.45 },
  { x: 0.28, y: 0.45 },
];

/** 임계값 산술 검증용 축정렬 폴리곤(면적비를 손으로 계산할 수 있게). */
const AXIS_POLY: NormalizedPoint[] = [
  { x: 0.2, y: 0.5 },
  { x: 0.6, y: 0.5 },
  { x: 0.6, y: 0.7 },
  { x: 0.2, y: 0.7 },
];

const rect = (x: number, y: number, w: number, h: number): NormalizedRect => ({ x, y, w, h });

describe('onPlaceFilter §6-1 — 주차면에 주차된 차량 → keep', () => {
  it('bbox 하단(접지 밴드)이 주차면 폴리곤 내부 → keep', () => {
    // 뒷줄 칸에 주차된 차: 지붕(y=0.18)은 폴리곤 위쪽 밖이지만 접지선(y=0.44)이 폴리곤 안.
    const parked = rect(0.33, 0.18, 0.20, 0.26);
    const band = groundBand(parked); // y 0.375~0.44 → 폴리곤(y 0.30~0.45) 내부
    expect(band.y).toBeCloseTo(0.375, 6);
    expect(isVehicleOnPlace(parked, [BACK_ROW])).toBe(true);
  });
});

describe('★ onPlaceFilter §6-2 — 통로 통행차 → drop (중심규칙 기각의 근거·회귀 봉인)', () => {
  /**
   * VPD rect 는 **지붕까지 포함한 axis-aligned bbox** 라 차량 중심이 원근으로 먼 쪽(뒷줄)으로 밀린다.
   * 통로를 지나가는 차의 **중심은 뒷줄 주차면 폴리곤 안**에 떨어지지만 **접지 밴드는 통로**에 있다.
   * → 중심 규칙(대안 a)이었다면 이 차는 **뒷줄 주차면 위 차량으로 오인**되어 통과했을 것이다(FP).
   *   모드 A 의 1차 목적이 바로 이 통행차 배제이므로, 중심 규칙은 목적 자체를 달성하지 못한다.
   */
  const passing = rect(0.32, 0.28, 0.20, 0.32); // 지붕 y=0.28(뒷줄 위) ~ 접지 y=0.60(통로)

  it('전제: 이 차의 bbox 중심은 뒷줄 주차면 폴리곤 **안**이다 (중심규칙이면 통과했을 케이스)', () => {
    const c = center(passing); // (0.42, 0.44) — 부동소수 오차 → toBeCloseTo(구현 버그 아님).
    expect(c.cx).toBeCloseTo(0.42, 10);
    expect(c.cy).toBeCloseTo(0.44, 10);
    expect(pointInPolygon(BACK_ROW, { x: c.cx, y: c.cy })).toBe(true); // ← 중심규칙: keep(오답)
  });

  it('전제: 접지 밴드는 폴리곤 **밖**(통로 아스팔트)이다', () => {
    const band = groundBand(passing); // y 0.52~0.60 — 폴리곤 하단(0.45)보다 아래 = 통로
    expect(band.y).toBeCloseTo(0.52, 6);
    expect(band.y).toBeGreaterThan(0.45);
  });

  it('★ 접지 밴드 규칙(채택안 d) → **drop**', () => {
    expect(isVehicleOnPlace(passing, [BACK_ROW])).toBe(false);
  });

  it('★ 주차차 + 통행차 혼재 → 주차차만 남는다(필터 본연의 목적)', () => {
    const parked = { rect: rect(0.33, 0.18, 0.20, 0.26), tag: 'parked' };
    const drive = { rect: passing, tag: 'passing' };
    const r = filterVehiclesOnPlace([parked, drive], [BACK_ROW]);
    expect(r.kept.map((v) => v.tag)).toEqual(['parked']);
    expect(r.filteredOut).toBe(1);
    expect(r.degraded).toBe(false);
  });
});

describe('onPlaceFilter §6-3 — 폴리곤을 살짝 스치는 차(밴드 겹침 < 임계) → drop', () => {
  // 밴드 = {x:0.02, y:0.60, w:0.2, h:0.05} → 면적 0.01. 폴리곤(x≥0.2) 과 x 겹침 0.02 → 겹침면적 0.001 → 비 0.10 < 0.15.
  it('겹침비 0.10(<0.15) → drop', () => {
    const grazing = rect(0.02, 0.45, 0.2, 0.2);
    const band = groundBand(grazing);
    expect(band).toEqual({ x: 0.02, y: 0.6, w: 0.2, h: 0.05 });
    expect(isVehicleOnPlace(grazing, [AXIS_POLY])).toBe(false);
  });

  it('같은 형상에서 겹침비만 0.30(>0.15) 로 키우면 → keep (임계가 실제로 판정을 가른다)', () => {
    const overlapping = rect(0.06, 0.45, 0.2, 0.2); // x 겹침 0.06 → 비 0.30
    expect(isVehicleOnPlace(overlapping, [AXIS_POLY])).toBe(true);
  });
});

describe('★ onPlaceFilter §6-4 — 다중 폴리곤 OR (배정이 아니라 *필터*임을 봉인)', () => {
  const OWN: NormalizedPoint[] = [
    { x: 0.30, y: 0.60 },
    { x: 0.50, y: 0.60 },
    { x: 0.51, y: 0.75 },
    { x: 0.29, y: 0.75 },
  ];
  const NEIGHBOR: NormalizedPoint[] = [
    { x: 0.51, y: 0.60 },
    { x: 0.71, y: 0.60 },
    { x: 0.72, y: 0.75 },
    { x: 0.50, y: 0.75 },
  ];
  // 원근 오차로 접지 밴드가 **옆 칸** 위에만 놓인 차(자기 칸과는 겹치지 않는다).
  const shifted = rect(0.55, 0.46, 0.13, 0.24); // 밴드 x 0.55~0.68, y 0.64~0.70

  it('자기 칸 하나만 주면 drop — 즉 "어느 칸인가"(배정) 규칙이었다면 이 차를 잃는다', () => {
    expect(isVehicleOnPlace(shifted, [OWN])).toBe(false);
  });

  it('★ 옆 칸 밴드와만 겹쳐도 keep — 전 폴리곤 OR (주차면 *위*인가만 묻는다)', () => {
    expect(isVehicleOnPlace(shifted, [OWN, NEIGHBOR])).toBe(true);
    // 폴리곤 순서 무관(OR 의 교환법칙).
    expect(isVehicleOnPlace(shifted, [NEIGHBOR, OWN])).toBe(true);
  });
});

describe('onPlaceFilter §6-5 — 강등(폴리곤 부재): 전량 통과 + degraded (드롭 금지)', () => {
  const vehicles = [{ rect: rect(0.1, 0.1, 0.1, 0.1) }, { rect: rect(0.8, 0.8, 0.1, 0.1) }];

  it('polys = null → degraded=true, 전량 통과, filteredOut=0', () => {
    const r = filterVehiclesOnPlace(vehicles, null);
    expect(r.degraded).toBe(true);
    expect(r.kept).toHaveLength(vehicles.length);
    expect(r.filteredOut).toBe(0);
  });

  it('polys = undefined → 동일(강등)', () => {
    const r = filterVehiclesOnPlace(vehicles, undefined);
    expect(r.degraded).toBe(true);
    expect(r.kept).toHaveLength(2);
    expect(r.filteredOut).toBe(0);
  });

  it('polys = [] (해당 프리셋 주차면 0개) → 동일(강등) — 기준 부재로 데이터를 지우지 않는다', () => {
    const r = filterVehiclesOnPlace(vehicles, []);
    expect(r.degraded).toBe(true);
    expect(r.kept).toEqual(vehicles);
    expect(r.filteredOut).toBe(0);
  });

  it('강등 시 kept 는 입력 배열의 **복사본**(호출측 배열 공유로 인한 변형 방지)', () => {
    const r = filterVehiclesOnPlace(vehicles, null);
    expect(r.kept).not.toBe(vehicles);
    expect(r.kept[0]).toBe(vehicles[0]); // 원소는 동일 참조(불필요한 복제 없음).
  });

  it('정상 폴리곤이 있으면 degraded=false (강등과 정상 필터를 혼동하지 않는다)', () => {
    const r = filterVehiclesOnPlace([{ rect: rect(0.33, 0.18, 0.2, 0.26) }], [BACK_ROW]);
    expect(r.degraded).toBe(false);
    expect(r.kept).toHaveLength(1);
    expect(r.filteredOut).toBe(0);
  });
});

describe('onPlaceFilter §6-6 — 방어: 퇴화 rect(밴드 면적 0) → throw 없이 false', () => {
  it('h=0 → false', () => {
    expect(() => isVehicleOnPlace(rect(0.3, 0.6, 0.2, 0), [AXIS_POLY])).not.toThrow();
    expect(isVehicleOnPlace(rect(0.3, 0.6, 0.2, 0), [AXIS_POLY])).toBe(false);
  });

  it('w=0 → false', () => {
    expect(isVehicleOnPlace(rect(0.3, 0.5, 0, 0.2), [AXIS_POLY])).toBe(false);
  });

  it('w=0,h=0 → false', () => {
    expect(isVehicleOnPlace(rect(0.3, 0.5, 0, 0), [AXIS_POLY])).toBe(false);
  });

  it('퇴화 차량은 filterVehiclesOnPlace 에서 제외로 집계(강등 아님)', () => {
    const r = filterVehiclesOnPlace([{ rect: rect(0.3, 0.6, 0.2, 0) }], [AXIS_POLY]);
    expect(r.kept).toHaveLength(0);
    expect(r.filteredOut).toBe(1);
    expect(r.degraded).toBe(false);
  });
});

describe('onPlaceFilter §6-7 — groundBand: bbox 하단 25% 스트립', () => {
  // ⚠️ toEqual 금지: y = 0.2 + 0.4 − 0.1 = 0.5000000000000001 (부동소수) — 구현 버그 아님.
  it('rect(0.2,0.2,0.4,0.4) → band(x=0.2, y=0.5, w=0.4, h=0.1)', () => {
    const b = groundBand(rect(0.2, 0.2, 0.4, 0.4));
    expect(b.x).toBeCloseTo(0.2, 10);
    expect(b.y).toBeCloseTo(0.5, 10);
    expect(b.w).toBeCloseTo(0.4, 10);
    expect(b.h).toBeCloseTo(0.1, 10);
  });

  it('밴드 하단 = rect 하단(접지선 공유), 밴드 높이 = rect 높이 × GROUND_BAND_RATIO', () => {
    const r = rect(0.1, 0.3, 0.25, 0.36);
    const b = groundBand(r);
    expect(b.y + b.h).toBeCloseTo(r.y + r.h, 10); // 하단 일치
    expect(b.h).toBeCloseTo(r.h * GROUND_BAND_RATIO, 10);
    expect(b.x).toBe(r.x); // 좌우 폭은 불변
    expect(b.w).toBe(r.w);
  });

  it('상수 계약: GROUND_BAND_RATIO=0.25, ON_PLACE_MIN_OVERLAP=0.15', () => {
    expect(GROUND_BAND_RATIO).toBe(0.25);
    expect(ON_PLACE_MIN_OVERLAP).toBe(0.15);
  });
});

/**
 * 번호판 필터(모드A) — 06_architect_plan_lpd.md §6 항목 P1~P7.
 *
 * 규칙: `keepPlate = (유지된 차량에 귀속: matchPlatesToSlots) OR (번호판 중심 ∈ 주차면 폴리곤)`.
 * 두 항 각각이 **없으면 무엇이 깨지는지**를 테스트가 직접 말하도록 짠다(P1 = 귀속, P2 = 점유 뒤집힘 방지).
 */
describe('filterPlatesOnPlace — 번호판도 주차면 위 차량 것만 (P1~P7)', () => {
  /** 축정렬 번호판 quad(중심 (cx,cy), 4점 대칭 → bbox 중심 = 4점 평균). */
  const plateQuad = (cx: number, cy: number): NormalizedQuad => [
    { x: cx - 0.02, y: cy - 0.01 },
    { x: cx + 0.02, y: cy - 0.01 },
    { x: cx + 0.02, y: cy + 0.01 },
    { x: cx - 0.02, y: cy + 0.01 },
  ];
  const plate = (cx: number, cy: number): PlateBox => ({ quad: plateQuad(cx, cy), confidence: 0.9, cls: 'car_license_plate' });
  const veh = (r: NormalizedRect, confidence = 0.9) => ({ rect: r, confidence });

  /** 뒷줄 주차면에 주차된 차(접지 밴드가 BACK_ROW 안 — §6-1 과 동일 rect). */
  const PARKED = veh(rect(0.33, 0.18, 0.20, 0.26)); // x 0.33~0.53, y 0.18~0.44

  it('P1 (A 항) — 번호판 중심이 kept 차량 rect 안 · 폴리곤 **밖** → keep (귀속 항이 없으면 죽는 케이스)', () => {
    const p = plate(0.43, 0.22); // PARKED rect 안(y 0.18~0.44) / BACK_ROW(y 0.30~0.45) 밖.
    expect(pointInPolygon(BACK_ROW, { x: 0.43, y: 0.22 })).toBe(false); // 전제: (B) 로는 살아남지 못한다.
    const r = filterPlatesOnPlace([p], [PARKED], [BACK_ROW]);
    expect(r.kept).toEqual([p]);
    expect(r.filteredOut).toBe(0);
    expect(r.degraded).toBe(false);
  });

  it('★ P2 (B 항) — VPD 가 주차차를 **놓쳐도**(keptVehicles=[]) 폴리곤 안 번호판은 keep', () => {
    // 이 항이 없으면: 그 번호판이 필터에서 사라지고 → computeOccupancy(번호판 중심 기반)가
    // 해당 주차면을 occupied:false 로 **뒤집는다**. 점유 회귀 방지의 본체.
    const p = plate(0.43, 0.38); // BACK_ROW 내부.
    expect(pointInPolygon(BACK_ROW, { x: 0.43, y: 0.38 })).toBe(true);
    const r = filterPlatesOnPlace([p], [], [BACK_ROW]);
    expect(r.kept).toEqual([p]);
    expect(r.filteredOut).toBe(0);
  });

  it('P3 (드롭 — 마스터 증상) — 뒷줄 통행차 번호판(kept 차량 밖 + 폴리곤 밖) → drop', () => {
    const p = plate(0.45, 0.97); // 통로 바닥.
    const r = filterPlatesOnPlace([p], [PARKED], [BACK_ROW]);
    expect(r.kept).toHaveLength(0);
    expect(r.filteredOut).toBe(1);
    expect(r.degraded).toBe(false);
  });

  it('★ P4 (거대 병합 박스 봉쇄) — 프레임 절반 rect 안의 배경 번호판 5개 → **정확히 1개만** keep', () => {
    // 리더 실측 V-1: VPD 가 conf 0.39 짜리 (77,0)-(1380,716) 병합 박스를 뱉는다(1920×1080 정규화).
    // matchPlatesToSlots 의 **차량당 번호판 1개** 규칙이 피해를 1건으로 봉쇄한다.
    // 귀속을 "중심 ∈ kept 차량 rect" 로 자체 구현하면 5개가 전부 통과하며 이 단언이 즉시 깨진다.
    const GIANT = veh(rect(0.040, 0.0, 0.679, 0.663), 0.39);
    const bg = [0.10, 0.20, 0.30, 0.40, 0.50].map((x) => plate(x, 0.10)); // 전부 GIANT 안 + BACK_ROW(y≥0.30) 밖.
    for (const p of bg) {
      const c = center(quadBoundingRect(p.quad));
      expect(pointInPolygon(BACK_ROW, { x: c.cx, y: c.cy })).toBe(false); // 전제: (B) 로는 못 산다.
    }
    const r = filterPlatesOnPlace(bg, [GIANT], [BACK_ROW]);
    expect(r.kept).toHaveLength(1);
    expect(r.filteredOut).toBe(4);
  });

  it('P5 (강등) — polys null/[] → degraded=true, 전량 통과, filteredOut=0 (드롭 금지)', () => {
    const plates = [plate(0.45, 0.97), plate(0.43, 0.22)];
    for (const polys of [null, [] as NormalizedPoint[][]]) {
      const r = filterPlatesOnPlace(plates, [PARKED], polys);
      expect(r.degraded).toBe(true);
      expect(r.kept).toHaveLength(plates.length);
      expect(r.filteredOut).toBe(0);
      expect(r.kept).not.toBe(plates); // 복사본(호출측 배열 공유 변형 방지).
    }
    expect(filterPlatesOnPlace(plates, [PARKED], undefined).degraded).toBe(true);
  });

  it('P6 — keptVehicles=[] + 폴리곤 밖 번호판 → drop (귀속 집합이 공집합일 때의 방어)', () => {
    const r = filterPlatesOnPlace([plate(0.45, 0.97)], [], [BACK_ROW]);
    expect(r.kept).toHaveLength(0);
    expect(r.filteredOut).toBe(1);
  });

  it('★ P7 (중심 정의 — D-1 수정) — (B) 항은 quadCentroid(4점 평균)로 판정한다. bbox 중심이 아니다.', () => {
    // 이 테스트는 **수정 전 반대 방향을 단언하고 있었다**(bbox 중심 → keep). D-1 로 뒤집혔다.
    // 4점 평균 y = (0.20+0.20+0.44+0.20)/4 = 0.26 → BACK_ROW(y 0.30~0.45) **밖**.
    // bbox 중심   y = (0.20+0.44)/2       = 0.32 → BACK_ROW **안**.  두 정의가 갈리는 비아핀 quad.
    const skew: NormalizedQuad = [
      { x: 0.40, y: 0.20 },
      { x: 0.44, y: 0.20 },
      { x: 0.44, y: 0.44 },
      { x: 0.42, y: 0.20 },
    ];
    const mean = quadCentroid(skew);
    const bc = center(quadBoundingRect(skew));
    expect(pointInPolygon(BACK_ROW, mean)).toBe(false); // 4점 평균 = **소비처(computeOccupancy) 정의**.
    expect(pointInPolygon(BACK_ROW, { x: bc.cx, y: bc.cy })).toBe(true); // bbox 중심 = 구 서버 정의.

    const p: PlateBox = { quad: skew, confidence: 0.9, cls: 'car_license_plate' };
    const r = filterPlatesOnPlace([p], [], [BACK_ROW]);

    // 서버는 이제 소비처와 **같은** 정의를 쓴다 → drop.
    expect(r.kept).toHaveLength(0);
    expect(r.filteredOut).toBe(1);

    // ★ 이 drop 이 **무해한** 이유(D-1 해소의 핵심): 이 번호판은 프론트 기준으로도 폴리곤 밖이라
    //   애초에 점유를 참으로 만들 수 없다. 즉 "필터가 지우는 번호판은 점유를 참으로 만들 수 없는 것뿐"이
    //   ε 예외 없이 성립한다. (구 정의였다면 keep 되었을 뿐, 점유는 어느 쪽이든 false 였다.)
    expect(pointInPolygon(BACK_ROW, quadCentroid(p.quad))).toBe(false);
  });
});
