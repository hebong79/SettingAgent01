import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { NormalizedPolygon } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): floor_roi 하위호환·마이그레이션 (설계서 §5 · 테스트계획 T7).
 * (1) 구 런(polygon_json 컬럼 없음, x0..y3만) → 마이그레이션 후 4점 폴리곤 복원.
 * (2) ALTER 존재 가드 → SqliteStore 재오픈 시 재실행 안전(중복 ADD COLUMN 없음).
 * (3) polygon_json NULL 이지만 컬럼 존재하는 구 런 행 → 4점 폴백.
 */

let dir: string | undefined;
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* noop */ } }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

/** 구 스키마(polygon_json 컬럼 없음)로 floor_roi 테이블만 생성하고 4점 행 1개 삽입. */
function makeLegacyDb(): { path: string } {
  dir = mkdtempSync(join(tmpdir(), 'floorcompat-'));
  const path = join(dir, 'legacy.db');
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE capture_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, ended_at TEXT,
      planned_count INTEGER, done_count INTEGER, interval_ms INTEGER, status TEXT, stop_reason TEXT
    );
    CREATE TABLE floor_roi (
      run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
      x0 REAL, y0 REAL, x1 REAL, y1 REAL, x2 REAL, y2 REAL, x3 REAL, y3 REAL,
      updated_at TEXT,
      PRIMARY KEY (run_id, preset_key, cluster_id)
    );
  `);
  raw.prepare(
    `INSERT INTO floor_roi (run_id, preset_key, cluster_id, x0,y0,x1,y1,x2,y2,x3,y3, updated_at)
     VALUES (1,'1:1',5, 0.2,0.9, 0.6,0.9, 0.55,0.6, 0.25,0.6, 'legacy')`,
  ).run();
  raw.close();
  return { path };
}

describe('floor_roi 하위호환', () => {
  it('구 런(polygon_json 컬럼 없음) → 마이그레이션 후 x0..y3 로 4점 폴리곤 복원', () => {
    const { path } = makeLegacyDb();
    const store = new SqliteStore(path);
    stores.push(store);
    const got = store.getFloorRois(1);
    expect(got).toHaveLength(1);
    expect(got[0].presetKey).toBe('1:1');
    expect(got[0].clusterId).toBe(5);
    expect(got[0].polygon).toEqual<NormalizedPolygon>([
      { x: 0.2, y: 0.9 },
      { x: 0.6, y: 0.9 },
      { x: 0.55, y: 0.6 },
      { x: 0.25, y: 0.6 },
    ]);
  });

  it('마이그레이션 재실행 안전(ALTER 존재 가드) — 재오픈해도 예외 없음·데이터 유지', () => {
    const { path } = makeLegacyDb();
    const s1 = new SqliteStore(path); stores.push(s1);
    expect(s1.getFloorRois(1)).toHaveLength(1);
    s1.close();
    // 두 번째 오픈: polygon_json 이 이미 존재 → ADD COLUMN 스킵(예외 없어야 함).
    const s2 = new SqliteStore(path); stores.push(s2);
    const got = s2.getFloorRois(1);
    expect(got).toHaveLength(1);
    expect(got[0].polygon).toHaveLength(4);
  });

  it('신 런 polygon_json(7점) 왕복 후에도 구 런 4점 폴백 공존', () => {
    const { path } = makeLegacyDb();
    const store = new SqliteStore(path); stores.push(store);
    const poly7: NormalizedPolygon = Array.from({ length: 7 }, (_, i) => ({
      x: 0.5 + 0.2 * Math.cos((2 * Math.PI * i) / 7),
      y: 0.5 + 0.2 * Math.sin((2 * Math.PI * i) / 7),
    }));
    store.upsertFloorRoi(1, '2:2', 9, poly7, 'new');
    const got = store.getFloorRois(1);
    // run 1 에 구 런 4점(1:1#5) + 신 런 7점(2:2#9) 공존.
    expect(got).toHaveLength(2);
    const byKey = new Map(got.map((g) => [`${g.presetKey}#${g.clusterId}`, g.polygon]));
    expect(byKey.get('1:1#5')).toHaveLength(4);
    expect(byKey.get('2:2#9')).toEqual(poly7);
  });
});
