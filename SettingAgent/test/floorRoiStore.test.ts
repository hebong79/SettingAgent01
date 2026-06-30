import { describe, it, expect, afterEach } from 'vitest';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): SqliteStore floor_roi 테이블 (설계서 §6).
 * upsert → get 동일 quad 회수; 같은 키 재upsert 시 갱신(중복 행 없음).
 */

const quad = (n: number): NormalizedQuad => [
  { x: 0.1 * n, y: 0.9 },
  { x: 0.2 * n, y: 0.9 },
  { x: 0.18 * n, y: 0.6 },
  { x: 0.12 * n, y: 0.6 },
];

let store: SqliteStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe('SqliteStore floor_roi', () => {
  it('upsert → get 동일 quad 회수', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const q = quad(1);
    store.upsertFloorRoi(runId, '1:1', 3, q, 'U0');
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ presetKey: '1:1', clusterId: 3, quad: q });
  });

  it('같은 키 재upsert → 갱신(중복 행 없음)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.upsertFloorRoi(runId, '1:1', 3, quad(1), 'U0');
    store.upsertFloorRoi(runId, '1:1', 3, quad(2), 'U1'); // 갱신
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].quad).toEqual(quad(2));
  });

  it('다른 클러스터/런 격리', () => {
    store = new SqliteStore(':memory:');
    const r1 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const r2 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    store.upsertFloorRoi(r1, '1:1', 1, quad(1), 'U');
    store.upsertFloorRoi(r1, '1:1', 2, quad(2), 'U');
    store.upsertFloorRoi(r2, '1:1', 1, quad(3), 'U');
    expect(store.getFloorRois(r1)).toHaveLength(2);
    expect(store.getFloorRois(r2)).toHaveLength(1);
  });
});
