import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchPlatesToSlots } from '../src/setup/plateMatch.js';
import type { BuiltSlot } from '../src/setup/RoiBuilder.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';
import type { NormalizedQuad } from '../src/domain/types.js';

const slot = (positionIdx: number, x: number, y: number): BuiltSlot => ({
  positionIdx,
  roi: { x, y, w: 0.2, h: 0.2 },
  confidence: 0.9,
});
const plate = (x: number, y: number, w = 0.05, h = 0.03): PlateBox => ({
  quad: rectToQuad({ x, y, w, h }),
  confidence: 0.95,
  cls: 'car_license_plate',
});

describe('matchPlatesToSlots', () => {
  it('번호판 중심이 차량 ROI 안이면 해당 슬롯에 귀속', () => {
    const slots = [slot(1, 0.1, 0.1), slot(2, 0.6, 0.1)];
    // 번호판 중심(0.17,0.22)은 슬롯1 ROI(0.1~0.3,0.1~0.3) 내부
    const m = matchPlatesToSlots(slots, [plate(0.15, 0.2)]);
    expect(m.has(1)).toBe(true);
    expect(m.has(2)).toBe(false);
    // 반환값은 실 OBB quad(방향 보존). 축정렬 fixture 는 boundingRect 유도로 rect 확인.
    expect(m.get(1)).toEqual(rectToQuad({ x: 0.15, y: 0.2, w: 0.05, h: 0.03 }));
    const br = quadBoundingRect(m.get(1)!);
    expect(br.x).toBeCloseTo(0.15);
    expect(br.y).toBeCloseTo(0.2);
    expect(br.w).toBeCloseTo(0.05);
    expect(br.h).toBeCloseTo(0.03);
  });

  it('두 슬롯 각각의 번호판 매칭', () => {
    const slots = [slot(1, 0.1, 0.1), slot(2, 0.6, 0.1)];
    const m = matchPlatesToSlots(slots, [plate(0.15, 0.2), plate(0.65, 0.2)]);
    expect(m.size).toBe(2);
    expect(quadBoundingRect(m.get(2)!).x).toBeCloseTo(0.65);
  });

  it('어느 ROI 에도 안 들면 매칭 없음', () => {
    const slots = [slot(1, 0.1, 0.1)];
    const m = matchPlatesToSlots(slots, [plate(0.9, 0.9)]);
    expect(m.size).toBe(0);
  });

  it('한 슬롯에 번호판 여럿이면 겹침 큰 것 유지', () => {
    const slots = [slot(1, 0.1, 0.1)];
    const small = plate(0.15, 0.2, 0.02, 0.02);
    const big = plate(0.15, 0.2, 0.1, 0.08);
    const m = matchPlatesToSlots(slots, [small, big]);
    expect(quadBoundingRect(m.get(1)!).w).toBeCloseTo(0.1);
  });
});

/**
 * 전역 그리디 배정 봉인(설계 09 §4). 근본 결함: 구 구현은 "번호판별 argmax + 슬롯당 1개 캡 + **폐기**" 라
 * 최적 차량이 이미 점유됐을 때 차선 차량으로 넘기지 않고 판을 버렸다(진단 08 §4-2).
 * 판 bbox 가 두 rect 에 **완전 포함**되면 intersectionArea 가 포화해 완전 동률 → 판별력 0 이 된다.
 * 신 구현: 후보쌍을 (겹침 desc → frontAnchor 거리 asc → pi → si) 정렬 후 **양쪽 미배정일 때만** 확정.
 *
 * 픽스처는 `occupancyAnchor` 동결 실데이터 재사용(신규 픽스처 0) — vehicles[].rect·plates[] 가 그대로 입력.
 */
describe('matchPlatesToSlots — 전역 그리디 + frontAnchor tie-break(설계 09)', () => {
  const FIX = new URL('./fixtures/occupancyAnchor/', import.meta.url);
  type Fixture = {
    vehicles: { rect: { x: number; y: number; w: number; h: number }; confidence: number }[];
    plates: { quad: NormalizedQuad; confidence: number }[];
  };
  const load = (preset: string): Fixture =>
    JSON.parse(readFileSync(new URL(`detect_cam1_${preset}.json`, FIX), 'utf8'));
  /** 픽스처 → matchPlatesToSlots 입력(detectPipeline.ts:278 의 어댑트와 동일 규칙). */
  const asInput = (f: Fixture) => ({
    slots: f.vehicles.map((v, i) => ({ positionIdx: i, roi: v.rect, confidence: v.confidence })),
    plates: f.plates.map((p) => ({ quad: p.quad, confidence: p.confidence, cls: 'car_license_plate' })),
  });

  it('N1 p1 실좌표 완전동률 — veh6 이 자기 판(1559,674)을 얻고 veh0 은 자기 판을 지킨다', () => {
    // 구 구현: plates[4] 가 veh4 와 동률(847.7px² 정확히 동일) → 인덱스 순 veh4 승 → veh4 는
    // 이미 plates[1] 보유 → **폐기** → veh6 미귀속(5/7). 신 구현은 차선 폴백으로 veh6 에 준다.
    const { slots, plates } = asInput(load('p1'));
    const m = matchPlatesToSlots(slots, plates);
    expect(m.size).toBe(6);
    // ★ 근본 수정의 본체: 폐기됐던 plates[4] 가 차선 후보 veh6 에 귀속된다.
    expect(m.get(6)).toBe(plates[4].quad);
    // 동률(plates[5]: veh0 0.06538 vs veh6 0.07111)에서 frontAnchor 가 veh0 을 지킨다 — 옆차로 새지 않는다.
    expect(m.get(0)).toBe(plates[5].quad);
    // 나머지는 현행과 동일(회귀 0).
    expect(m.get(1)).toBe(plates[0].quad);
    expect(m.get(4)).toBe(plates[1].quad);
    expect(m.get(5)).toBe(plates[2].quad);
    expect(m.get(3)).toBe(plates[3].quad);
    // veh2 는 base LPD 가 판을 못 본 차량 → 정당한 미귀속(zoom 재시도가 구제. 진단 08 §5-3).
    expect(m.has(2)).toBe(false);
  });

  it('N2 p2 잠복 결함 — veh5 가 자기 판(408,636)을 base 매칭에서 얻는다(재시도 운 의존 제거)', () => {
    // p2 는 "정상"이 아니라 **D2 미발현으로 은폐된 동일 결함**이었다(진단 08 §5-2).
    // 구 구현: plates[5] 폐기 → veh5 미귀속(5/6) → 재시도가 우연히 자기 판을 되찾음.
    const { slots, plates } = asInput(load('p2'));
    const m = matchPlatesToSlots(slots, plates);
    expect(m.size).toBe(6);
    expect(m.get(5)).toBe(plates[5].quad);
    expect(m.get(2)).toBe(plates[2].quad);
    // plates[4] 도 포화 동률(veh3 0.07046 vs veh4 0.10678)이었다 — frontAnchor 가 veh3 로 확정.
    expect(m.get(3)).toBe(plates[4].quad);
    expect(m.get(0)).toBe(plates[3].quad);
    expect(m.get(1)).toBe(plates[0].quad);
    expect(m.get(4)).toBe(plates[1].quad);
  });

  it('N3 p3 무변화 — 동률이 없는 프리셋은 구 알고리즘과 결과 동일(회귀 0 대조군)', () => {
    // p3 는 모든 판의 후보 차량이 정확히 1개 → 폐기 0. 판별력용 대조군(수정 전에도 통과).
    const { slots, plates } = asInput(load('p3'));
    const m = matchPlatesToSlots(slots, plates);
    expect(m.size).toBe(4);
    expect(m.get(0)).toBe(plates[2].quad);
    expect(m.get(1)).toBe(plates[0].quad);
    expect(m.get(2)).toBe(plates[1].quad);
    expect(m.get(3)).toBe(plates[3].quad);
  });

  it('N4 두 rect 에 동시 완전포함된 판 — 최적 슬롯이 점유되면 차선 슬롯으로 폴백(폐기 아님)', () => {
    // 기존 4건이 통째로 미커버한 영역(진단 08 §3): 슬롯이 전부 비겹침이거나 단일이었다.
    // rect1·rect2 는 x 로 겹치고, B(0.55,0.2) 는 **양쪽에 완전 포함** → 겹침 포화 동률.
    const s1: BuiltSlot = { positionIdx: 1, roi: { x: 0.3, y: 0.1, w: 0.3, h: 0.3 }, confidence: 0.9 };
    const s2: BuiltSlot = { positionIdx: 2, roi: { x: 0.5, y: 0.1, w: 0.3, h: 0.3 }, confidence: 0.9 };
    const A = plate(0.32, 0.2, 0.08, 0.04); // 중심(0.36,0.22) — rect1 전용(rect2 밖), 겹침 0.0032 大
    const B = plate(0.52, 0.2, 0.06, 0.03); // 중심(0.55,0.215) — rect1·rect2 양쪽 내부, 겹침 0.0018
    const m = matchPlatesToSlots([s1, s2], [A, B]);
    expect(m.get(1)).toBe(A.quad);
    expect(m.get(2)).toBe(B.quad); // 구 구현은 여기서 B 를 폐기했다(size 1).
    expect(m.size).toBe(2);
  });

  it('N5 tie-break 메트릭 봉인 — frontAnchor 가 배열 순서·rect 중심 근접을 모두 이긴다', () => {
    // lpdFilterRegression.test.ts:332 의 실좌표. TRUE/NOISE 둘 다 PARKED rect 에 완전 포함 = 포화 동률.
    //   rect 중심(cy 0.31) 기준: NOISE 0.020 < TRUE 0.025 → 노이즈가 이긴다(오답).
    //   frontAnchor(cy 0.3412) 기준: TRUE 0.0062 ≪ NOISE 0.0512 → 진짜 판이 8배 차로 이긴다.
    // 배열도 NOISE 가 앞 — 구 구현은 동률에서 **선착 유지**라 NOISE 를 붙인다(순서 취약성).
    const PARKED: BuiltSlot = { positionIdx: 1, roi: { x: 0.33, y: 0.18, w: 0.2, h: 0.26 }, confidence: 0.8 };
    const noise = plate(0.405, 0.278, 0.05, 0.024); // 중심(0.43,0.29)
    const truth = plate(0.405, 0.323, 0.05, 0.024); // 중심(0.43,0.335)
    const m = matchPlatesToSlots([PARKED], [noise, truth]);
    expect(m.get(1)).toBe(truth.quad);
  });

  it('N6 결정성 — 같은 입력 2회 실행이 같은 결과(난수·외부상태 없음)', () => {
    const { slots, plates } = asInput(load('p1'));
    expect([...matchPlatesToSlots(slots, plates)]).toEqual([...matchPlatesToSlots(slots, plates)]);
  });

  it('N7 차선 후보가 없으면 드롭 보존 — 단일 슬롯 노이즈 제거(상류 성질 유지)', () => {
    // lpdFilterRegression.test.ts:332 의 "드롭은 잡음 제거" 서술이 여전히 참인 영역.
    // 그리디는 maximal 이지만 후보 슬롯이 1개뿐이면 진 판은 갈 곳이 없다.
    const slots = [slot(1, 0.1, 0.1)];
    const small = plate(0.15, 0.2, 0.02, 0.02);
    const big = plate(0.15, 0.2, 0.1, 0.08);
    const m = matchPlatesToSlots(slots, [small, big]);
    expect(m.size).toBe(1);
    expect(m.get(1)).toBe(big.quad);
  });
});
