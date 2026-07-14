import { describe, it, expect, afterEach } from 'vitest';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { ParkingSlotRow } from '../src/capture/types.js';
import { presetKey } from '../web/core.js';

/**
 * 검증자(qa-tester): SqliteStore parking_slots(§06 H1) — replaceParkingSlots/getParkingSlots 왕복·멱등.
 * 근거: 01_architect_plan.md §06 §3 H1 + 02_developer_changes.md 02-I QA 인계.
 * :memory: 주입. roi/vpd/lpd JSON 파싱 복원·occupied 0/1↔boolean·nullable·멱등(delete+insert)·정렬.
 * 경계면: roi_json 형식(정규화 점배열)이 프론트 renderSlotList DB 분기 소비 shape 과 정합, presetKey 형식 동일.
 */

let store: SqliteStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const roiPts = [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }];
const lpdQuad = [{ x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 }];

const row = (over: Partial<ParkingSlotRow> = {}): ParkingSlotRow => ({
  camIdx: 1,
  presetIdx: 1,
  presetKey: '1:1',
  slotIdx: 1,
  roiJson: JSON.stringify(roiPts),
  vpdJson: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
  lpdJson: JSON.stringify(lpdQuad),
  occupied: 1,
  occupancyRate: 0.8,
  pan: null,
  tilt: null,
  zoom: null,
  updatedAt: 'T',
  ...over,
});

describe('SqliteStore parking_slots 왕복 (§06 H1)', () => {
  it('replaceParkingSlots → getParkingSlots: roi/vpd/lpd 파싱 복원, occupied boolean, occupancyRate 보존', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [row()]);
    const got = store.getParkingSlots(runId);
    expect(got).toHaveLength(1);
    const s = got[0];
    expect(s.roi).toEqual(roiPts); // 정규화 점배열 복원(프론트 소비 shape)
    expect(s.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect(s.lpd).toEqual(lpdQuad);
    expect(s.occupied).toBe(true); // 0/1 → boolean
    expect(s.occupancyRate).toBe(0.8);
    // 경계면: presetKey 형식이 프론트 presetKey(cam,preset) 와 동일.
    expect(s.presetKey).toBe(presetKey(1, 1));
    expect(s.camIdx).toBe(1);
    expect(s.presetIdx).toBe(1);
    expect(s.slotIdx).toBe(1);
  });

  it('nullable vpd/lpd/occupancyRate + occupied=0 → null/false 복원', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [row({ slotIdx: 2, vpdJson: null, lpdJson: null, occupied: 0, occupancyRate: null })]);
    const [s] = store.getParkingSlots(runId);
    expect(s.vpd).toBeNull();
    expect(s.lpd).toBeNull();
    expect(s.occupied).toBe(false);
    expect(s.occupancyRate).toBeNull();
    expect(s.roi).toEqual(roiPts); // roi 는 항상 존재
  });

  it('멱등: 2회 replace → 중복 없음(delete+insert)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const rows = [row({ slotIdx: 1 }), row({ slotIdx: 2, occupied: 0, vpdJson: null, lpdJson: null })];
    store.replaceParkingSlots(runId, rows);
    expect(store.getParkingSlots(runId)).toHaveLength(2);
    store.replaceParkingSlots(runId, rows); // 재호출
    expect(store.getParkingSlots(runId)).toHaveLength(2); // 누적 아님
    // 더 적은 행으로 replace → 그 수만 남음.
    store.replaceParkingSlots(runId, [row({ slotIdx: 1 })]);
    expect(store.getParkingSlots(runId)).toHaveLength(1);
  });

  it('정렬: cam_idx, preset_idx, slot_idx ASC', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [
      row({ presetKey: '1:2', presetIdx: 2, slotIdx: 5 }),
      row({ presetKey: '1:1', presetIdx: 1, slotIdx: 3 }),
      row({ presetKey: '1:1', presetIdx: 1, slotIdx: 1 }),
    ]);
    const got = store.getParkingSlots(runId);
    expect(got.map((r) => [r.presetIdx, r.slotIdx])).toEqual([[1, 1], [1, 3], [2, 5]]);
  });

  it('run 격리: 다른 run 의 주차면은 섞이지 않음', () => {
    store = new SqliteStore(':memory:');
    const r1 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const r2 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    store.replaceParkingSlots(r1, [row()]);
    expect(store.getParkingSlots(r1)).toHaveLength(1);
    expect(store.getParkingSlots(r2)).toHaveLength(0);
  });

  it('roi_json 파싱 실패(손상) → 빈 배열 폴백(getParkingSlots throw 없음)', () => {
    // parseJsonOrNull 강등 경로: 직접 손상 문자열 저장 후 조회.
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [row({ roiJson: '{bad', vpdJson: 'nope', lpdJson: null })]);
    let got: ReturnType<SqliteStore['getParkingSlots']>;
    expect(() => { got = store!.getParkingSlots(runId); }).not.toThrow();
    expect(got![0].roi).toEqual([]); // roi 파싱 실패 → [] 폴백
    expect(got![0].vpd).toBeNull();  // vpd 파싱 실패 → null
  });
});

// 검증자(qa-tester): preset PTZ(pan/tilt/zoom) 결합 저장 왕복 (변경1).
// 근거: 01_architect_plan.md 변경1 5단계 + 02_developer_changes.md replaceParkingSlots/getParkingSlots.
describe('SqliteStore parking_slots preset PTZ 왕복 (변경1)', () => {
  it('pan/tilt/zoom 값 저장 → 동일 값 복원(REAL 정밀)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [row({ pan: 12.5, tilt: -3.25, zoom: 4 })]);
    const [s] = store.getParkingSlots(runId);
    expect(s.pan).toBe(12.5);
    expect(s.tilt).toBe(-3.25);
    expect(s.zoom).toBe(4);
  });

  it('pan/tilt/zoom 미주입(null) → null 복원(하위호환·격리 폴백)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [row({ pan: null, tilt: null, zoom: null })]);
    const [s] = store.getParkingSlots(runId);
    expect(s.pan).toBeNull();
    expect(s.tilt).toBeNull();
    expect(s.zoom).toBeNull();
  });

  it('zoom=0(falsy)도 null 로 뭉개지 않고 0 으로 복원(?? 널병합 경계)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [row({ pan: 0, tilt: 0, zoom: 0 })]);
    const [s] = store.getParkingSlots(runId);
    expect(s.pan).toBe(0);
    expect(s.tilt).toBe(0);
    expect(s.zoom).toBe(0);
  });

  it('행별 독립: 한 프리셋 PTZ 보유 + 다른 프리셋 null 혼재 왕복', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceParkingSlots(runId, [
      row({ presetKey: '1:1', presetIdx: 1, slotIdx: 1, pan: 10, tilt: 5, zoom: 2 }),
      row({ presetKey: '1:2', presetIdx: 2, slotIdx: 1, pan: null, tilt: null, zoom: null }),
    ]);
    const got = store.getParkingSlots(runId);
    const p1 = got.find((r) => r.presetKey === '1:1')!;
    const p2 = got.find((r) => r.presetKey === '1:2')!;
    expect([p1.pan, p1.tilt, p1.zoom]).toEqual([10, 5, 2]);
    expect([p2.pan, p2.tilt, p2.zoom]).toEqual([null, null, null]);
  });
});
