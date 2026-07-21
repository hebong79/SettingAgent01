import { describe, it, expect } from 'vitest';
import { normalizePolygon, resolveFloorPolygon } from '../src/capture/floorRoi.js';
import { FloorRoiReviewer } from '../src/capture/FloorRoiReviewer.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { SetupBrain, FloorRoiInput } from '../src/brain/SetupBrain.js';
import type { NormalizedPolygon } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): normalizePolygon 근사공선 붕괴 [D1 수정 검증] (설계서 §2·min4 불변식).
 *
 * [이력] 한 점이 다른 3점의 변 위(공선)에 있는 4점 입력이 convexHull 에서 3정점으로 붕괴할 때,
 * 과거 가드(`hull.length < 3`)는 이를 통과시켜 NormalizedPolygon(4~10) 불변식을 깨고
 * (구) SqliteStore.upsertFloorRoi 의 `polygon[3].x` 접근에서 크래시했다(03 리포트 §1 D1).
 * 구현자가 가드를 `hull.length < 4` 로 수정 → 붕괴 시 null → resolveFloorPolygon 이
 * fallbackPolygon(항상 4점 이상)으로 강등한다. 이 파일은 **수정된(정상) 동작**을 단언한다.
 *
 * ★ DB 스키마 개편 후 재작성: 구 SqliteStore.upsertFloorRoi/getFloorRois 는 폐기되었고
 *   FloorRoiReviewer 도 더 이상 영속하지 않는다(캡처 루프 미배선, §6.5). D1 이 막던 "크래시 경로"는
 *   이제 실제로는 FloorRoiReviewer.review()(LLM 이 이 공선 폴리곤을 반환 → 내부에서
 *   resolveFloorPolygon 호출 → void 로 버림)가 유일한 통합 경로다 — 그 경로로 재현해
 *   throw 없이 완주함을 확인한다(구 DB 왕복 검증은 소비측 자체가 사라져 대체 불가·제거).
 */

// (0.5,0.5) 는 (0.2,0.2)-(0.8,0.8) 대각선 위 → 볼록껍질에서 제거되어 3정점으로 붕괴하는 입력.
const collinearRaw = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.5, y: 0.5 },
];

describe('normalizePolygon 근사공선 4점 붕괴 [D1 수정 후]', () => {
  it('붕괴(3정점) 입력 → null 반환(호출측 폴백에 위임, 4~10 불변식 보호)', () => {
    const out = normalizePolygon(collinearRaw);
    expect(out).toBeNull();
  });

  it('불변식: normalizePolygon 결과는 null 이거나 4점 이상이어야 한다', () => {
    const out = normalizePolygon(collinearRaw);
    expect(out === null || out.length >= 4).toBe(true);
  });

  it('resolveFloorPolygon: 번호판이 붕괴 삼각형 내부여도 빌더 강등으로 4점 이상 반환', () => {
    const vehicle = { x: 0.6, y: 0.25, w: 0.1, h: 0.1 };
    const plate = { x: 0.62, y: 0.3, w: 0.04, h: 0.03 };
    const poly = resolveFloorPolygon(collinearRaw, vehicle, undefined, plate);
    expect(poly.length).toBeGreaterThanOrEqual(4);
  });

  it('불변식: resolveFloorPolygon 은 항상 4점 이상·10점 이하', () => {
    const vehicle = { x: 0.6, y: 0.25, w: 0.1, h: 0.1 };
    const plate = { x: 0.62, y: 0.3, w: 0.04, h: 0.03 };
    const poly = resolveFloorPolygon(collinearRaw, vehicle, undefined, plate);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    expect(poly.length).toBeLessThanOrEqual(10);
  });

  it('D1 크래시 경로 차단(엔드투엔드): FloorRoiReviewer.review 가 붕괴 입력을 반환하는 LLM 에도 throw 없이 완주', async () => {
    const vehicle = { x: 0.6, y: 0.25, w: 0.1, h: 0.1 };
    const plate = { x: 0.62, y: 0.3, w: 0.04, h: 0.03 };
    // 사전 확인: 순수 경로가 여전히 4점 이상을 보장(회귀 가드).
    const poly: NormalizedPolygon = resolveFloorPolygon(collinearRaw, vehicle, undefined, plate);
    expect(poly.length).toBeGreaterThanOrEqual(4);

    // brain 이 공선 붕괴 폴리곤을 그대로 반환 → FloorRoiReviewer 내부에서 resolveFloorPolygon 호출.
    const brain = {
      enabled: true,
      recognizeFloorRoi: async (_input: FloorRoiInput) => ({ polygon: collinearRaw, confidence: 0.9 }),
    } as unknown as SetupBrain;
    const slot: AggregatedSlot = {
      presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1,
      x: vehicle.x, y: vehicle.y, w: vehicle.w, h: vehicle.h, support: 3, occupancyRate: 0.5,
      plateX: plate.x, plateY: plate.y, plateW: plate.w, plateH: plate.h, plateQuad: null,
      confidence: 0, posSpread: 0, angleSpread: null, status: 'candidate',
    };
    const reviewer = new FloorRoiReviewer({ store: {} as unknown as SqliteStore, brain, now: () => 'U' });
    const frames = new Map([['1:1', Buffer.from('jpg')]]);
    await expect(reviewer.review(1, [slot], frames)).resolves.toEqual({ llmUnavailable: false });
  });

  it('D1 회귀 방지: plate 없이도(예상 번호판 경로) 붕괴 입력이 크래시 없이 처리', () => {
    const vehicle = { x: 0.6, y: 0.25, w: 0.1, h: 0.1 };
    const poly = resolveFloorPolygon(collinearRaw, vehicle); // plate=undefined → predictPlateRect 경로.
    expect(poly.length).toBeGreaterThanOrEqual(4);
  });
});
