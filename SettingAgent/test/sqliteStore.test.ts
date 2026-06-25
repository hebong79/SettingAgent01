import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { AggregatedSlot } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): SqliteStore DAO (G2 — 적재/조회 단위테스트).
 * :memory: 사용. 스키마 생성·관측/검출 적재·집계 멱등 upsert·체크포인트/스냅샷·인덱스 경로 검증.
 */

const aggSlot = (over: Partial<AggregatedSlot> = {}): AggregatedSlot => ({
  presetKey: '1:1',
  clusterId: 1,
  camIdx: 1,
  presetIdx: 1,
  x: 0.1,
  y: 0.2,
  w: 0.1,
  h: 0.1,
  support: 3,
  occupancyRate: 0.5,
  plateX: null,
  plateY: null,
  plateW: null,
  plateH: null,
  status: 'candidate',
  ...over,
});

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

describe('SqliteStore 스키마/런 (G2)', () => {
  it(':memory: 생성 시 스키마 보장 — createRun → getRun 일치', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 50, intervalMs: 30000, startedAt: 'T0' });
    expect(runId).toBeGreaterThan(0);
    const run = store.getRun(runId);
    expect(run).toMatchObject({
      id: runId,
      startedAt: 'T0',
      endedAt: null,
      plannedCount: 50,
      doneCount: 0,
      intervalMs: 30000,
      status: 'running',
      stopReason: null,
    });
  });

  it('updateRunProgress / endRun 반영', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 5, intervalMs: 1000, startedAt: 'T0' });
    store.updateRunProgress(runId, 3);
    expect(store.getRun(runId)!.doneCount).toBe(3);
    store.endRun(runId, { status: 'done', stopReason: 'count', endedAt: 'T1' });
    const run = store.getRun(runId)!;
    expect(run.status).toBe('done');
    expect(run.stopReason).toBe('count');
    expect(run.endedAt).toBe('T1');
  });

  it('listRuns — 최신 id DESC 정렬 + limit', () => {
    store = new SqliteStore(':memory:');
    const a = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const b = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    const all = store.listRuns();
    expect(all.map((r) => r.id)).toEqual([b, a]); // DESC
    expect(store.listRuns(1).map((r) => r.id)).toEqual([b]);
  });

  it('getRun(없는 id) → undefined', () => {
    store = new SqliteStore(':memory:');
    expect(store.getRun(999)).toBeUndefined();
  });
});

describe('SqliteStore 관측/검출 적재·조회 (G2)', () => {
  it('insertObservation + insertDetections → getDetectionsForRun 평면 배열(round_idx 조인)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T0' });
    const obs = store.insertObservation({
      runId,
      roundIdx: 1,
      camIdx: 1,
      presetIdx: 2,
      capturedAt: 'C0',
      pan: 10,
      tilt: 5,
      zoom: 2,
      imgName: 'img1',
    });
    expect(obs).toBeGreaterThan(0);
    store.insertDetections(obs, 1, 2, [
      { kind: 'vehicle', x: 0.1, y: 0.1, w: 0.1, h: 0.1, conf: 0.9 },
      { kind: 'plate', x: 0.12, y: 0.14, w: 0.03, h: 0.02, conf: 0.8 },
    ]);

    const dets = store.getDetectionsForRun(runId);
    expect(dets).toHaveLength(2);
    // round_idx 가 observation 조인으로 부여되는지(경계면: detection 에는 round 없음).
    expect(dets.every((d) => d.roundIdx === 1)).toBe(true);
    expect(dets.every((d) => d.camIdx === 1 && d.presetIdx === 2)).toBe(true);
    const v = dets.find((d) => d.kind === 'vehicle')!;
    expect(v).toMatchObject({ x: 0.1, y: 0.1, w: 0.1, h: 0.1, conf: 0.9 });
    const p = dets.find((d) => d.kind === 'plate')!;
    expect(p).toMatchObject({ x: 0.12, y: 0.14, conf: 0.8 });
  });

  it('insertDetections 빈 배열은 무행(트랜잭션 안전)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const obs = store.insertObservation({
      runId, roundIdx: 1, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x',
    });
    store.insertDetections(obs, 1, 1, []);
    expect(store.getDetectionsForRun(runId)).toHaveLength(0);
  });

  it('getPresetRounds — 프리셋별 DISTINCT round 수(occupancy 분모, §11-6)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T0' });
    // preset 1:1 → round 1,2,3 (3) ; preset 1:2 → round 1,1 (distinct 1)
    for (const r of [1, 2, 3]) {
      store.insertObservation({ runId, roundIdx: r, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    }
    store.insertObservation({ runId, roundIdx: 1, camIdx: 1, presetIdx: 2, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertObservation({ runId, roundIdx: 1, camIdx: 1, presetIdx: 2, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    const map = store.getPresetRounds(runId);
    expect(map.get('1:1')).toBe(3);
    expect(map.get('1:2')).toBe(1); // DISTINCT round
  });

  it('검출은 run 으로 격리 — 다른 런 검출은 섞이지 않음', () => {
    store = new SqliteStore(':memory:');
    const r1 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const r2 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    const o1 = store.insertObservation({ runId: r1, roundIdx: 1, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(o1, 1, 1, [{ kind: 'vehicle', x: 0.1, y: 0.1, w: 0.1, h: 0.1, conf: 0.9 }]);
    expect(store.getDetectionsForRun(r1)).toHaveLength(1);
    expect(store.getDetectionsForRun(r2)).toHaveLength(0);
  });
});

describe('SqliteStore 집계 멱등 upsert (G2)', () => {
  it('replaceAggregatedSlots 2회 호출 → 멱등(중복 없음, replace)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slots = [aggSlot({ clusterId: 1 }), aggSlot({ clusterId: 2, x: 0.5 })];
    store.replaceAggregatedSlots(runId, slots);
    expect(store.getAggregatedSlots(runId)).toHaveLength(2);
    // 다시 호출 — delete+insert 라 2행 유지(누적 아님).
    store.replaceAggregatedSlots(runId, slots);
    expect(store.getAggregatedSlots(runId)).toHaveLength(2);
    // 더 적은 슬롯으로 replace → 그 수만 남음.
    store.replaceAggregatedSlots(runId, [aggSlot({ clusterId: 1 })]);
    const after = store.getAggregatedSlots(runId);
    expect(after).toHaveLength(1);
    expect(after[0].clusterId).toBe(1);
  });

  it('getAggregatedSlots — snake→camel 매핑 round-trip 동일(경계면)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slot = aggSlot({ occupancyRate: 0.75, plateX: 0.11, plateY: 0.13, plateW: 0.03, plateH: 0.02 });
    store.replaceAggregatedSlots(runId, [slot]);
    const [got] = store.getAggregatedSlots(runId);
    // snake_case 컬럼(occupancy_rate, plate_x ...) → camelCase 필드로 정확히 환원.
    expect(got).toEqual(slot);
  });

  it('updateAggregatedStatus — status 컬럼만 갱신(좌표 불변)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slot = aggSlot({ clusterId: 7, x: 0.42, y: 0.43, w: 0.11, h: 0.12 });
    store.replaceAggregatedSlots(runId, [slot]);
    store.updateAggregatedStatus(runId, '1:1', 7, 'merged');
    const [got] = store.getAggregatedSlots(runId);
    expect(got.status).toBe('merged');
    // 좌표는 그대로(불변식).
    expect({ x: got.x, y: got.y, w: got.w, h: got.h }).toEqual({ x: 0.42, y: 0.43, w: 0.11, h: 0.12 });
  });
});

describe('SqliteStore 체크포인트·스냅샷 (G2)', () => {
  it('insertCheckpoint → getLatestCheckpoint(at_round DESC)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.insertCheckpoint(runId, 10, 'C10', JSON.stringify({ converged: false }));
    store.insertCheckpoint(runId, 20, 'C20', JSON.stringify({ converged: true }));
    const latest = store.getLatestCheckpoint(runId)!;
    expect(latest.atRound).toBe(20);
    expect(JSON.parse(latest.summaryJson)).toEqual({ converged: true });
  });

  it('getCheckpoints → at_round ASC 누적 컨텍스트', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.insertCheckpoint(runId, 20, 'C20', '{"b":2}');
    store.insertCheckpoint(runId, 10, 'C10', '{"a":1}');
    const cps = store.getCheckpoints(runId);
    expect(cps.map((c) => c.atRound)).toEqual([10, 20]); // ASC
  });

  it('getLatestCheckpoint(없음) → undefined', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    expect(store.getLatestCheckpoint(runId)).toBeUndefined();
  });

  it('insertArtifactSnapshot — 적재 무예외(감사용 기록)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    expect(() => store!.insertArtifactSnapshot(runId, 'C', JSON.stringify({ slots: [] }))).not.toThrow();
  });
});

describe('SqliteStore 파일경로·스키마 재생성 (G2)', () => {
  it('파일 경로 — 디렉터리 자동 생성 + 스키마 IF NOT EXISTS 재생성 무해', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-'));
    try {
      const dbPath = join(dir, 'nested', 'obs.sqlite');
      const s1 = new SqliteStore(dbPath); // dirname 자동 생성
      expect(existsSync(join(dir, 'nested'))).toBe(true);
      const runId = s1.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
      s1.close();
      // 같은 파일 재오픈 — ensureSchema 가 IF NOT EXISTS 라 재생성 무해, 기존 데이터 보존.
      const s2 = new SqliteStore(dbPath);
      expect(s2.getRun(runId)).toBeDefined();
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
