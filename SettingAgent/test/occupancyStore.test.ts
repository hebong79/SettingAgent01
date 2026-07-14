import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/capture/SqliteStore.js';

/**
 * 검증자(qa-tester): SqliteStore occupancy 테이블 (설계서 §3.7·§5, 성공기준 5).
 * insertOccupancy(append 이력) → getLatestOccupancy(프리셋별 at_round 최대 1행).
 * 기존 파일 DB(occupancy 없는) 재오픈 시 CREATE TABLE IF NOT EXISTS 자동 생성(마이그레이션 무해).
 */

const rec = (over: Partial<Parameters<SqliteStore['insertOccupancy']>[1]> = {}) => ({
  camIdx: 1, presetIdx: 1, atRound: 1,
  occupiedCount: 1, total: 2, rate: 0.5,
  spacesJson: JSON.stringify([{ id: 1, occupied: true }, { id: 2, occupied: false }]),
  updatedAt: 'T',
  ...over,
});

let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe('SqliteStore occupancy 왕복 (성공기준 5)', () => {
  it('insert → getLatestOccupancy 필드 매핑(snake→camel)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.insertOccupancy(runId, rec({ camIdx: 2, presetIdx: 3, atRound: 4, occupiedCount: 1, total: 3, rate: 1 / 3 }));
    const rows = store.getLatestOccupancy(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      camIdx: 2, presetIdx: 3, atRound: 4, occupiedCount: 1, total: 3, updatedAt: 'T',
    });
    expect(rows[0].rate).toBeCloseTo(1 / 3);
    expect(JSON.parse(rows[0].spacesJson!)).toHaveLength(2);
  });

  it('이력 다건 중 프리셋별 MAX(at_round) 1행만(append 이력 보존)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    // 같은 프리셋 1:1 을 라운드 2,5,3 순으로 저장 → 최신은 at_round=5.
    store.insertOccupancy(runId, rec({ presetIdx: 1, atRound: 2, rate: 0.2 }));
    store.insertOccupancy(runId, rec({ presetIdx: 1, atRound: 5, rate: 0.9 }));
    store.insertOccupancy(runId, rec({ presetIdx: 1, atRound: 3, rate: 0.3 }));
    // 다른 프리셋 1:2 최신 at_round=1.
    store.insertOccupancy(runId, rec({ presetIdx: 2, atRound: 1, rate: 0.1 }));
    const rows = store.getLatestOccupancy(runId);
    expect(rows).toHaveLength(2); // 프리셋별 1행
    const p1 = rows.find((r) => r.presetIdx === 1)!;
    expect(p1.atRound).toBe(5);
    expect(p1.rate).toBeCloseTo(0.9); // 최신 라운드 값
    const p2 = rows.find((r) => r.presetIdx === 2)!;
    expect(p2.atRound).toBe(1);
    // cam_idx, preset_idx 오름차순 정렬.
    expect(rows.map((r) => r.presetIdx)).toEqual([1, 2]);
  });

  it('다른 run 격리 — getLatestOccupancy(run) 는 해당 run 만', () => {
    store = new SqliteStore(':memory:');
    const runA = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const runB = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    store.insertOccupancy(runA, rec({ atRound: 1 }));
    store.insertOccupancy(runB, rec({ atRound: 9 }));
    expect(store.getLatestOccupancy(runA)).toHaveLength(1);
    expect(store.getLatestOccupancy(runA)[0].atRound).toBe(1);
    expect(store.getLatestOccupancy(runB)[0].atRound).toBe(9);
  });

  it('occupancy 없는 run → 빈 배열', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    expect(store.getLatestOccupancy(runId)).toEqual([]);
  });
});

describe('SqliteStore occupancy 마이그레이션 (기존 DB 재오픈)', () => {
  it('occupancy 테이블 없는 파일 DB 재오픈 → 자동 생성(예외 없음)', () => {
    dir = mkdtempSync(join(tmpdir(), 'occ-migrate-'));
    const dbPath = join(dir, 'obs.sqlite');
    // 구 DB 모사: occupancy 테이블 없이 capture_run 만 있는 파일 생성.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE capture_run (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, ended_at TEXT,
      planned_count INTEGER, done_count INTEGER, interval_ms INTEGER, status TEXT, stop_reason TEXT)`);
    raw.close();
    // SqliteStore 로 재오픈 → ensureSchema 가 occupancy 를 IF NOT EXISTS 로 생성해야 함.
    store = new SqliteStore(dbPath);
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    expect(() => store!.insertOccupancy(runId, rec())).not.toThrow();
    expect(store.getLatestOccupancy(runId)).toHaveLength(1);
  });
});
