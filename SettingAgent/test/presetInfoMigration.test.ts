// preset_pos → preset_info 멱등 마이그레이션 검증(설계서 §7-T3).
// 레거시 파일 DB(구 preset_pos + slot_setup FK→preset_pos)를 raw 로 시드한 뒤 SqliteStore 오픈 →
// 테이블/컬럼 리네임·place_id 추가·기존 데이터 보존·FK 자동 추종·재오픈 멱등을 확인한다.
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/capture/SqliteStore.js';

let dir: string | undefined;
let store: SqliteStore | undefined;

afterEach(() => {
  store?.close(); store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 구 스키마(preset_pos + sname, place_id 없음) + slot_setup FK→preset_pos 를 직접 생성한 파일 DB 경로. */
function seedLegacyDb(): string {
  dir = mkdtempSync(join(tmpdir(), 'presetmigr-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE place_info (place_id INTEGER PRIMARY KEY, place_name TEXT NOT NULL);
    CREATE TABLE camera_info (cam_id INTEGER PRIMARY KEY, cam_name TEXT, cam_uuid TEXT, url TEXT,
      user_id TEXT, password TEXT, rtsp_url TEXT, cam_type TEXT NOT NULL DEFAULT 'ptz',
      cam_company TEXT, place_id INTEGER NOT NULL DEFAULT 1 REFERENCES place_info(place_id),
      img_w INTEGER, img_h INTEGER, updated_at TEXT);
    CREATE TABLE preset_pos (
      cam_id INTEGER NOT NULL REFERENCES camera_info(cam_id), preset_id INTEGER NOT NULL,
      sname TEXT, pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL, updated_at TEXT,
      PRIMARY KEY (cam_id, preset_id));
    CREATE TABLE slot_setup (
      slot_id INTEGER PRIMARY KEY, cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL,
      preset_slotidx INTEGER, slot_roi TEXT NOT NULL, vpd_bbox TEXT, lpd_obb TEXT,
      occupy_range TEXT, pan REAL, tilt REAL, zoom REAL,
      centered INTEGER NOT NULL DEFAULT 0 CHECK (centered IN (0,1)), img1 TEXT,
      slot3d_front_center TEXT, updated_at TEXT,
      FOREIGN KEY (cam_id, preset_id) REFERENCES preset_pos(cam_id, preset_id),
      UNIQUE (cam_id, preset_id, preset_slotidx));
    INSERT INTO place_info VALUES (1,'Place01');
    INSERT INTO camera_info (cam_id, place_id) VALUES (1, 1);
    INSERT INTO preset_pos VALUES (1,1,'Preset 1',22,6.8,1.6,'T0');
    INSERT INTO slot_setup (slot_id,cam_id,preset_id,preset_slotidx,slot_roi,centered,updated_at)
      VALUES (7,1,1,1,'[{"x":0.2,"y":0.2}]',0,'T0');
  `);
  raw.close();
  return dbPath;
}

/** 스토어 내부 db 핸들(테스트 전용 raw 조회). */
function rawDb(s: SqliteStore): Database.Database {
  return (s as unknown as { db: Database.Database }).db;
}

describe('preset_pos → preset_info 마이그레이션', () => {
  it('테이블/컬럼 리네임 + place_id 추가 + 기존 데이터 보존', () => {
    const dbPath = seedLegacyDb();
    store = new SqliteStore(dbPath);
    const db = rawDb(store);

    // (a) preset_info 로 리네임, (d) preset_pos 부재.
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    expect(tables).toContain('preset_info');
    expect(tables).not.toContain('preset_pos');

    // (b)(c) preset_name·place_id 컬럼 존재, sname 부재.
    const cols = (db.prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('preset_name');
    expect(cols).toContain('place_id');
    expect(cols).not.toContain('sname');

    // 기존 행 보존 + place_id 기본값 1.
    const row = db.prepare(`SELECT preset_name, place_id, pan, tilt, zoom FROM preset_info WHERE cam_id=1 AND preset_id=1`)
      .get() as { preset_name: string | null; place_id: number; pan: number; tilt: number; zoom: number };
    expect(row).toEqual({ preset_name: 'Preset 1', place_id: 1, pan: 22, tilt: 6.8, zoom: 1.6 });

    // (e) slot_setup 행 보존.
    const slots = store.getSlotSetup();
    expect(slots).toHaveLength(1);
    expect(slots[0].slotId).toBe(7);
  });

  it('RENAME TO 가 slot_setup FK 부모 참조를 preset_info 로 자동 추종', () => {
    const dbPath = seedLegacyDb();
    store = new SqliteStore(dbPath);

    // 부모 있는 (1,1) 은 통과.
    store.replaceSlotSetup([{
      slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, slotRoi: '[{"x":0.1,"y":0.1}]',
      vpdBbox: null, lpdObb: null, occupyRange: null, pan: null, tilt: null, zoom: null,
      centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T1',
    }]);
    expect(store.getSlotSetup()).toHaveLength(1);

    // 부모 없는 (1,9) 는 FK 위반 → throw + 롤백(이전 확정본 보존).
    expect(() => store!.replaceSlotSetup([{
      slotId: 2, camId: 1, presetId: 9, presetSlotIdx: 1, slotRoi: '[{"x":0.1,"y":0.1}]',
      vpdBbox: null, lpdObb: null, occupyRange: null, pan: null, tilt: null, zoom: null,
      centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T2',
    }])).toThrow();
    expect(store.getSlotSetup()).toHaveLength(1);
  });

  it('멱등 — 재오픈 시 무변경·무오류', () => {
    const dbPath = seedLegacyDb();
    const s1 = new SqliteStore(dbPath);
    s1.close();

    store = new SqliteStore(dbPath); // 두 번째 오픈: 마이그레이션 no-op.
    const cols = (rawDb(store).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('preset_name');
    expect(cols.filter((c) => c === 'place_id')).toHaveLength(1);
    expect(store.getPresetKeys()).toEqual(new Set(['1:1']));
    expect(store.getSlotSetup()).toHaveLength(1);
  });

  it('신규 DB 는 CREATE 만으로 preset_info 완비(마이그레이션 no-op)', () => {
    store = new SqliteStore(':memory:');
    const db = rawDb(store);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    expect(tables).toContain('preset_info');
    expect(tables).not.toContain('preset_pos');

    store.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
    store.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: null, imgH: null, updatedAt: 'T',
    }]);
    store.upsertPresetInfo([{
      camId: 1, presetId: 1, presetName: 'Preset 1', placeId: 1,
      pan: 1.234567, tilt: 2, zoom: 3, updatedAt: 'T',
    }]);
    const row = db.prepare(`SELECT preset_name, place_id, pan FROM preset_info WHERE cam_id=1 AND preset_id=1`)
      .get() as { preset_name: string; place_id: number; pan: number };
    expect(row).toEqual({ preset_name: 'Preset 1', place_id: 1, pan: 1.23457 }); // round5
  });
});
