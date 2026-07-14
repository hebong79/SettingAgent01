import { describe, it, expect, afterEach } from 'vitest';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { NormalizedPolygon } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): SqliteStore floor_roi 테이블 (설계서 §5 · 가변 다각형 4~10점).
 * upsert → get 동일 다각형 회수(polygon_json 왕복, 4·7점); 같은 키 재upsert 갱신; 런/클러스터 격리.
 */

const poly4 = (n: number): NormalizedPolygon => [
  { x: 0.1 * n, y: 0.9 },
  { x: 0.2 * n, y: 0.9 },
  { x: 0.18 * n, y: 0.6 },
  { x: 0.12 * n, y: 0.6 },
];

const poly7: NormalizedPolygon = Array.from({ length: 7 }, (_, i) => ({
  x: 0.5 + 0.2 * Math.cos((2 * Math.PI * i) / 7),
  y: 0.5 + 0.2 * Math.sin((2 * Math.PI * i) / 7),
}));

let store: SqliteStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe('SqliteStore floor_roi', () => {
  it('upsert → get 동일 4점 다각형 회수', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const p = poly4(1);
    store.upsertFloorRoi(runId, '1:1', 3, p, 'U0');
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ presetKey: '1:1', clusterId: 3, polygon: p });
  });

  it('7점 다각형 polygon_json 왕복(가변 정점 보존)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.upsertFloorRoi(runId, '1:1', 1, poly7, 'U0');
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].polygon).toEqual(poly7);
  });

  it('같은 키 재upsert → 갱신(중복 행 없음)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.upsertFloorRoi(runId, '1:1', 3, poly4(1), 'U0');
    store.upsertFloorRoi(runId, '1:1', 3, poly4(2), 'U1');
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].polygon).toEqual(poly4(2));
  });

  it('다른 클러스터/런 격리', () => {
    store = new SqliteStore(':memory:');
    const r1 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const r2 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    store.upsertFloorRoi(r1, '1:1', 1, poly4(1), 'U');
    store.upsertFloorRoi(r1, '1:1', 2, poly4(2), 'U');
    store.upsertFloorRoi(r2, '1:1', 1, poly4(3), 'U');
    expect(store.getFloorRois(r1)).toHaveLength(2);
    expect(store.getFloorRois(r2)).toHaveLength(1);
  });
});
