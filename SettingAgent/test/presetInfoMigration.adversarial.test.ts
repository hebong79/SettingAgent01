// 검증자(qa-tester) 적대적 검증 — preset_pos → preset_info 스키마 리팩토링.
// 기존 test/presetInfoMigration.test.ts 가 덮지 않는 지점을 실증한다:
//  1) 3회 연속 재오픈 멱등(레거시 파일 DB / 신규 파일 DB 양 경로, 스키마 SQL + 데이터 스냅샷 동일)
//  2) 데이터 보존 — 다중 행·유니코드·NULL·정밀 실수의 값 + SQLite 스토리지 클래스(typeof) 보존
//  3) FK 정합 — PRAGMA foreign_key_list(slot_setup) 가 preset_info 를 가리키는지 + 실제 강제 여부
//  4) place_id — 마이그레이션 기본값 1 / NOT NULL / 신규 CREATE 경로의 REFERENCES 실효성(+수용된 divergence)
//  5) 부분 마이그레이션 중간 상태(크래시 재개) — 모자란 것만 채우는지
//  6) 외부 JSON 계약 — camerapos.json 의 `sname` 키 불변(writer→parser→builder→DB 컬럼 경계 교차)
//  8) renumberSlotIds 가 리네임 후에도 동작
//  9) /db/tables 노출 테이블명 전환
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { registerDbRoutes } from '../src/api/dbRoutes.js';
import { writeCamerapos } from '../src/setup/cameraposWriter.js';
import { parseCameraViews } from '../src/setup/mapTargets.js';
import { buildPresets } from '../src/capture/roiDbLoad.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  for (const s of stores.splice(0)) {
    try { s.close(); } catch { /* 이미 닫힘 */ }
  }
  if (app) { await app.close(); app = undefined; }
  // dbRoutes 의 read-only 연결은 프로세스 수명 동안 캐시 오픈(파일 핸들 유지) → Windows 에서 즉시 삭제 불가.
  // 정리는 best-effort(OS 임시 폴더가 후처리) — dbRoutes.test.ts 와 동일 패턴. 검증 본문과 무관.
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 파일 잠금 무시 */ }
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'presetadv-'));
  dirs.push(d);
  return d;
}

function open(dbPath: string): SqliteStore {
  const s = new SqliteStore(dbPath);
  stores.push(s);
  return s;
}

/** 스토어 내부 db 핸들(테스트 전용 raw 조회). */
function rawDb(s: SqliteStore): Database.Database {
  return (s as unknown as { db: Database.Database }).db;
}

/** 값 + SQLite 스토리지 클래스(typeof)를 함께 뽑아 "바이트 보존"을 판정한다. */
function dumpWithTypes(db: Database.Database, table: string, cols: string[]): Record<string, unknown>[] {
  const sel = cols.map((c) => `"${c}" AS "${c}", typeof("${c}") AS "${c}__type"`).join(', ');
  return db.prepare(`SELECT ${sel} FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
}

/** 스키마(오브젝트 SQL) + preset/slot 데이터 전체 스냅샷 — 멱등 비교용. */
function snapshot(db: Database.Database): unknown {
  const objects = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`)
    .all();
  const presetCols = (db.prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
  const slotCols = (db.prepare(`PRAGMA table_info(slot_setup)`).all() as { name: string }[]).map((c) => c.name);
  return {
    objects,
    presetTableInfo: db.prepare(`PRAGMA table_info(preset_info)`).all(),
    slotTableInfo: db.prepare(`PRAGMA table_info(slot_setup)`).all(),
    slotFk: db.prepare(`PRAGMA foreign_key_list(slot_setup)`).all(),
    presetRows: dumpWithTypes(db, 'preset_info', presetCols),
    slotRows: dumpWithTypes(db, 'slot_setup', slotCols),
  };
}

/**
 * 구 스키마(preset_pos + sname, place_id 없음) 파일 DB 시드.
 * 프리셋 5행 — 유니코드/빈문자열/NULL 라벨 + 정밀 실수 + 정수형 실수.
 * slot_setup 3행 — FK → preset_pos, 전 컬럼 채움.
 */
function seedLegacy(): string {
  const dbPath = join(tmpDir(), 'legacy.sqlite');
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
    CREATE TABLE parking_evnt (evnt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL REFERENCES slot_setup(slot_id),
      is_occupy INTEGER NOT NULL CHECK (is_occupy IN (0,1)), update_time TEXT NOT NULL,
      plate_num TEXT, img1 TEXT, img2 TEXT);
    CREATE TABLE parking_slot (slot_id INTEGER PRIMARY KEY REFERENCES slot_setup(slot_id),
      last_evnt_id INTEGER REFERENCES parking_evnt(evnt_id));

    INSERT INTO place_info VALUES (1,'Place01');
    INSERT INTO camera_info (cam_id, place_id) VALUES (1, 1), (2, 1);
  `);
  const insP = raw.prepare(`INSERT INTO preset_pos (cam_id,preset_id,sname,pan,tilt,zoom,updated_at) VALUES (?,?,?,?,?,?,?)`);
  insP.run(1, 1, '주차장 A동 1층 — "정문" 쪽', 19.8, 8.7, 1.69341, '2026-07-17T16:00:31.982Z');
  insP.run(1, 2, '', 90.10001, 35.8, 1, '2026-07-17T16:00:31.982Z');   // 빈 문자열 라벨
  insP.run(1, 3, null, -0.000012345, 1e-7, 2.03134, '2026-07-17T16:00:31.982Z'); // NULL 라벨 + 극소 실수
  insP.run(2, 1, 'Preset 1', 113.8, 10, 1.80643, null);                // updated_at NULL
  insP.run(2, 2, 'ラベル\\n改行', 139, 17, 1.80643, 'T0');               // 비ASCII + 백슬래시
  const insS = raw.prepare(
    `INSERT INTO slot_setup (slot_id,cam_id,preset_id,preset_slotidx,slot_roi,vpd_bbox,lpd_obb,occupy_range,
      pan,tilt,zoom,centered,img1,slot3d_front_center,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insS.run(7, 1, 1, 1, '[{"x":0.2,"y":0.2}]', '[0.1,0.1,0.3,0.3]', '[{"x":0.11,"y":0.12}]',
    '[{"x":0.05,"y":0.05}]', 19.8, 8.7, 1.69341, 1, 'img/a.png', '{"x":0.5,"y":0.6}', 'T0');
  insS.run(8, 1, 2, 1, '[{"x":0.4,"y":0.4}]', null, null, null, null, null, null, 0, null, null, null);
  insS.run(9, 2, 1, 1, '[{"x":0.6,"y":0.6}]', null, null, null, 113.8, 10, 1.80643, 1, 'img/b.png', null, 'T1');
  raw.close();
  return dbPath;
}

// ────────────────────────────────────────────────────────────────
// 1) 멱등성 — 3회 연속 재오픈
// ────────────────────────────────────────────────────────────────
describe('적대적 1: 3회 연속 재오픈 멱등', () => {
  it('레거시 파일 DB — 1회차 마이그레이션 후 2·3회차 스냅샷 완전 동일', () => {
    const dbPath = seedLegacy();

    const s1 = open(dbPath);
    const snap1 = snapshot(rawDb(s1));
    s1.close();

    const s2 = open(dbPath);
    const snap2 = snapshot(rawDb(s2));
    s2.close();

    const s3 = open(dbPath);
    const snap3 = snapshot(rawDb(s3));
    s3.close();

    expect(snap2).toEqual(snap1);
    expect(snap3).toEqual(snap1);

    // place_id 가 두 번 추가되지 않았음(컬럼 1개).
    const s4 = open(dbPath);
    const cols = (rawDb(s4).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'place_id')).toHaveLength(1);
    expect(cols).not.toContain('sname');
  });

  it('신규 파일 DB — 3회 오픈해도 스키마·데이터 불변', () => {
    const dbPath = join(tmpDir(), 'fresh.sqlite');

    const s1 = open(dbPath);
    s1.upsertPlaceInfo([{ placeId: 1, placeName: 'Place01' }]);
    s1.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
    }]);
    s1.upsertPresetInfo([{ camId: 1, presetId: 1, presetName: '신규', placeId: 1, pan: 1, tilt: 2, zoom: 3, updatedAt: 'T' }]);
    const snap1 = snapshot(rawDb(s1));
    s1.close();

    const s2 = open(dbPath);
    const snap2 = snapshot(rawDb(s2));
    s2.close();

    const s3 = open(dbPath);
    const snap3 = snapshot(rawDb(s3));
    s3.close();

    expect(snap2).toEqual(snap1);
    expect(snap3).toEqual(snap1);
  });

  it(':memory: 신규 DB 는 마이그레이션이 no-op(preset_pos 미생성, sname 컬럼 없음)', () => {
    const s = open(':memory:');
    const db = rawDb(s);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    expect(tables).toContain('preset_info');
    expect(tables).not.toContain('preset_pos');
    const cols = (db.prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['cam_id', 'preset_id', 'preset_name', 'pan', 'tilt', 'zoom', 'place_id', 'updated_at']);
  });
});

// ────────────────────────────────────────────────────────────────
// 2) 데이터 보존 — 값 + 스토리지 클래스
// ────────────────────────────────────────────────────────────────
describe('적대적 2: 레거시 데이터 바이트 보존', () => {
  it('preset 5행 — 유니코드/빈문자열/NULL 라벨·정밀 실수가 sname→preset_name 으로 손실 없이 이동', () => {
    const dbPath = seedLegacy();

    // 마이그레이션 전 원본 덤프(raw 연결).
    const before = new Database(dbPath, { readonly: true });
    const beforeRows = dumpWithTypes(before, 'preset_pos', ['cam_id', 'preset_id', 'sname', 'pan', 'tilt', 'zoom', 'updated_at']);
    const beforeSlots = dumpWithTypes(before, 'slot_setup', [
      'slot_id', 'cam_id', 'preset_id', 'preset_slotidx', 'slot_roi', 'vpd_bbox', 'lpd_obb', 'occupy_range',
      'pan', 'tilt', 'zoom', 'centered', 'img1', 'slot3d_front_center', 'updated_at',
    ]);
    before.close();
    expect(beforeRows).toHaveLength(5);

    const s = open(dbPath);
    const db = rawDb(s);
    const afterRows = dumpWithTypes(db, 'preset_info', ['cam_id', 'preset_id', 'preset_name', 'pan', 'tilt', 'zoom', 'updated_at']);
    const afterSlots = dumpWithTypes(db, 'slot_setup', [
      'slot_id', 'cam_id', 'preset_id', 'preset_slotidx', 'slot_roi', 'vpd_bbox', 'lpd_obb', 'occupy_range',
      'pan', 'tilt', 'zoom', 'centered', 'img1', 'slot3d_front_center', 'updated_at',
    ]);

    // 행 수 보존.
    expect(afterRows).toHaveLength(beforeRows.length);
    expect(afterSlots).toEqual(beforeSlots); // slot_setup 은 컬럼명도 동일 → 완전 일치

    // preset: sname 키만 preset_name 으로 번역해 완전 비교(값 + typeof 스토리지 클래스).
    const translated = beforeRows.map((r) => {
      const { sname, sname__type, ...rest } = r as Record<string, unknown> & { sname: unknown; sname__type: unknown };
      return { ...rest, preset_name: sname, preset_name__type: sname__type };
    });
    const norm = (rows: Record<string, unknown>[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))));
    expect(norm(afterRows)).toEqual(norm(translated));

    // 개별 대표값 명시 검증(유니코드·빈문자열·NULL·극소 실수).
    const byKey = new Map(afterRows.map((r) => [`${r.cam_id}:${r.preset_id}`, r]));
    expect(byKey.get('1:1')!.preset_name).toBe('주차장 A동 1층 — "정문" 쪽');
    expect(byKey.get('1:2')!.preset_name).toBe('');
    expect(byKey.get('1:2')!.preset_name__type).toBe('text'); // 빈문자열이 NULL 로 변질되지 않음
    expect(byKey.get('1:3')!.preset_name).toBeNull();
    expect(byKey.get('1:3')!.pan).toBe(-0.000012345); // round5 재적용 없음(마이그레이션은 값 미변조)
    expect(byKey.get('1:3')!.tilt).toBe(1e-7);
    expect(byKey.get('2:1')!.updated_at).toBeNull();
    expect(byKey.get('2:2')!.preset_name).toBe('ラベル\\n改行');
  });

  it('마이그레이션 후 getPresetKeys / getSlotSetup 가 전 행을 그대로 본다', () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    expect(s.getPresetKeys()).toEqual(new Set(['1:1', '1:2', '1:3', '2:1', '2:2']));
    expect(s.getSlotSetup().map((r) => r.slotId).sort((a, b) => a - b)).toEqual([7, 8, 9]);
  });
});

// ────────────────────────────────────────────────────────────────
// 3) FK 정합
// ────────────────────────────────────────────────────────────────
describe('적대적 3: slot_setup FK 가 preset_info 를 참조', () => {
  it('PRAGMA foreign_key_list(slot_setup) 의 부모 테이블이 preset_info(마이그레이션 DB)', () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    const fks = rawDb(s).prepare(`PRAGMA foreign_key_list(slot_setup)`).all() as Array<{ table: string; from: string; to: string }>;
    expect(fks.map((f) => f.table)).toEqual(['preset_info', 'preset_info']);
    expect(fks.map((f) => `${f.from}->${f.to}`)).toEqual(['cam_id->cam_id', 'preset_id->preset_id']);
    // 구 이름이 스키마 텍스트에 남아있지 않다.
    const sql = (rawDb(s).prepare(`SELECT sql FROM sqlite_master WHERE name='slot_setup'`).get() as { sql: string }).sql;
    expect(sql).toContain('preset_info');
    expect(sql).not.toContain('preset_pos');
  });

  it('신규 DB 도 동일하게 preset_info 를 부모로 갖는다', () => {
    const s = open(':memory:');
    const fks = rawDb(s).prepare(`PRAGMA foreign_key_list(slot_setup)`).all() as Array<{ table: string }>;
    expect(fks.map((f) => f.table)).toEqual(['preset_info', 'preset_info']);
  });

  it('마이그레이션 DB — 부모 없는 (cam,preset) INSERT 는 throw, 부모 있으면 통과', () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    const db = rawDb(s);
    const ins = db.prepare(
      `INSERT INTO slot_setup (slot_id,cam_id,preset_id,preset_slotidx,slot_roi,centered) VALUES (?,?,?,?,?,0)`,
    );
    expect(() => ins.run(100, 1, 99, 1, '[]')).toThrow(/FOREIGN KEY/i); // 부모 없음
    expect(() => ins.run(101, 1, 1, 77, '[]')).not.toThrow();           // 부모 있음(1:1)
    expect(db.prepare(`SELECT COUNT(*) c FROM slot_setup`).get()).toEqual({ c: 4 });
  });

  it('foreign_keys PRAGMA 가 실제로 ON', () => {
    const s = open(':memory:');
    expect(rawDb(s).pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 4) place_id
// ────────────────────────────────────────────────────────────────
describe('적대적 4: place_id 기본값·제약', () => {
  it('마이그레이션된 기존 5행 모두 place_id=1(NOT NULL 위반 없음)', () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    const rows = rawDb(s).prepare(`SELECT cam_id, preset_id, place_id FROM preset_info`).all() as Array<{ place_id: number }>;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.place_id === 1)).toBe(true);
    // NOT NULL 이 실효
    expect(() => rawDb(s).exec(`UPDATE preset_info SET place_id=NULL WHERE cam_id=1 AND preset_id=1`))
      .toThrow(/NOT NULL/i);
  });

  it('신규 CREATE 경로 — place_id REFERENCES place_info 가 실제로 강제된다', () => {
    const s = open(':memory:');
    const db = rawDb(s);
    s.upsertPlaceInfo([{ placeId: 1, placeName: 'Place01' }]);
    s.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: null, imgH: null, updatedAt: 'T',
    }]);
    // 존재하지 않는 place_id → FK 위반
    expect(() => s.upsertPresetInfo([{
      camId: 1, presetId: 1, presetName: 'x', placeId: 999, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T',
    }])).toThrow(/FOREIGN KEY/i);
    // 존재하는 place_id → 통과
    expect(() => s.upsertPresetInfo([{
      camId: 1, presetId: 1, presetName: 'x', placeId: 1, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T',
    }])).not.toThrow();
    expect(db.prepare(`SELECT place_id FROM preset_info`).get()).toEqual({ place_id: 1 });
  });

  it('설계서가 수용한 divergence 를 실증 — 마이그레이션 DB 의 place_id 에는 FK 가 없다', () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    const db = rawDb(s);
    const fks = db.prepare(`PRAGMA foreign_key_list(preset_info)`).all() as Array<{ table: string; from: string }>;
    expect(fks.some((f) => f.from === 'place_id')).toBe(false); // 신규 DB 와 달리 place_id FK 없음
    // 따라서 존재하지 않는 place_id 도 통과한다(수용된 divergence — 값은 항상 1이라 실무 무해).
    expect(() => s.upsertPresetInfo([{
      camId: 1, presetId: 1, presetName: 'x', placeId: 999, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T',
    }])).not.toThrow();

    // 신규 DB 는 place_id FK 를 갖는다(대조군).
    const fresh = open(':memory:');
    const freshFks = rawDb(fresh).prepare(`PRAGMA foreign_key_list(preset_info)`).all() as Array<{ from: string }>;
    expect(freshFks.some((f) => f.from === 'place_id')).toBe(true);
  });

  it('컬럼 순서 divergence — 마이그레이션 DB 는 place_id 가 맨 뒤(신규는 zoom 다음)', () => {
    const dbPath = seedLegacy();
    const migrated = (rawDb(open(dbPath)).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    const fresh = (rawDb(open(':memory:')).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(migrated).toEqual(['cam_id', 'preset_id', 'preset_name', 'pan', 'tilt', 'zoom', 'updated_at', 'place_id']);
    expect(fresh).toEqual(['cam_id', 'preset_id', 'preset_name', 'pan', 'tilt', 'zoom', 'place_id', 'updated_at']);
    expect(migrated).not.toEqual(fresh); // 순서는 다르지만 집합은 같다
    expect([...migrated].sort()).toEqual([...fresh].sort());
  });
});

// ────────────────────────────────────────────────────────────────
// 5) 부분 마이그레이션 중간 상태(크래시 재개)
// ────────────────────────────────────────────────────────────────
describe('적대적 5: 부분 마이그레이션 중간 상태에서 모자란 것만 채운다', () => {
  /** 임의 preset 테이블 DDL 로 최소 DB 를 만든다. */
  function seedCustom(presetDdl: string, insert: string): string {
    const dbPath = join(tmpDir(), 'partial.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE place_info (place_id INTEGER PRIMARY KEY, place_name TEXT NOT NULL);
      CREATE TABLE camera_info (cam_id INTEGER PRIMARY KEY, cam_name TEXT, cam_uuid TEXT, url TEXT,
        user_id TEXT, password TEXT, rtsp_url TEXT, cam_type TEXT NOT NULL DEFAULT 'ptz',
        cam_company TEXT, place_id INTEGER NOT NULL DEFAULT 1 REFERENCES place_info(place_id),
        img_w INTEGER, img_h INTEGER, updated_at TEXT);
      ${presetDdl}
      INSERT INTO place_info VALUES (1,'Place01');
      INSERT INTO camera_info (cam_id, place_id) VALUES (1,1);
      ${insert}
    `);
    raw.close();
    return dbPath;
  }

  it('상태 A: 테이블만 리네임됨(preset_info + sname, place_id 없음) → 컬럼 2건만 보충', () => {
    const dbPath = seedCustom(
      `CREATE TABLE preset_info (cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL, sname TEXT,
        pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL, updated_at TEXT,
        PRIMARY KEY (cam_id, preset_id));`,
      `INSERT INTO preset_info VALUES (1,1,'라벨A',1,2,3,'T');`,
    );
    const s = open(dbPath);
    const cols = (rawDb(s).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('preset_name');
    expect(cols).not.toContain('sname');
    expect(cols).toContain('place_id');
    expect(rawDb(s).prepare(`SELECT preset_name, place_id FROM preset_info`).get())
      .toEqual({ preset_name: '라벨A', place_id: 1 });
  });

  it('상태 B: 컬럼 리네임까지 됨(preset_name 有, place_id 無) → place_id 만 추가', () => {
    const dbPath = seedCustom(
      `CREATE TABLE preset_info (cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL, preset_name TEXT,
        pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL, updated_at TEXT,
        PRIMARY KEY (cam_id, preset_id));`,
      `INSERT INTO preset_info VALUES (1,1,'라벨B',1,2,3,'T');`,
    );
    const s = open(dbPath);
    const cols = (rawDb(s).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'place_id')).toHaveLength(1);
    expect(rawDb(s).prepare(`SELECT preset_name, place_id FROM preset_info`).get())
      .toEqual({ preset_name: '라벨B', place_id: 1 });
  });

  it('상태 C: 구 preset_pos 인데 place_id 는 이미 있음 → 리네임 2건만, place_id 중복 추가 없음', () => {
    const dbPath = seedCustom(
      `CREATE TABLE preset_pos (cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL, sname TEXT,
        pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL, place_id INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT, PRIMARY KEY (cam_id, preset_id));`,
      `INSERT INTO preset_pos (cam_id,preset_id,sname,pan,tilt,zoom,place_id,updated_at) VALUES (1,1,'라벨C',1,2,3,1,'T');`,
    );
    const s = open(dbPath);
    const cols = (rawDb(s).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'place_id')).toHaveLength(1);
    expect(cols).toContain('preset_name');
    expect(rawDb(s).prepare(`SELECT preset_name, place_id FROM preset_info`).get())
      .toEqual({ preset_name: '라벨C', place_id: 1 });
  });

  it('상태 D(적대적): preset_pos 와 preset_info 가 동시 존재 → throw 없이 preset_info 만 정비, preset_pos 는 잔존', () => {
    const dbPath = seedCustom(
      `CREATE TABLE preset_pos (cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL, sname TEXT,
        pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL, updated_at TEXT,
        PRIMARY KEY (cam_id, preset_id));
       CREATE TABLE preset_info (cam_id INTEGER NOT NULL, preset_id INTEGER NOT NULL, preset_name TEXT,
        pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL, updated_at TEXT,
        PRIMARY KEY (cam_id, preset_id));`,
      `INSERT INTO preset_pos VALUES (1,1,'구',1,2,3,'T');
       INSERT INTO preset_info VALUES (1,2,'신',4,5,6,'T');`,
    );
    const s = open(dbPath); // throw 하지 않아야 한다
    const tables = (rawDb(s).prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    // 문서화된 현재 동작: 리네임을 건너뛰므로 구 테이블이 남고, 그 안의 행(1:1)은 preset_info 로 합쳐지지 않는다.
    expect(tables).toContain('preset_pos');
    expect(tables).toContain('preset_info');
    expect(s.getPresetKeys()).toEqual(new Set(['1:2'])); // 구 테이블의 1:1 은 보이지 않음
  });
});

// ────────────────────────────────────────────────────────────────
// 6) 외부 JSON 계약 — camerapos.json 의 sname 키 불변
// ────────────────────────────────────────────────────────────────
describe('적대적 6: 외부 JSON(camerapos.json) 의 sname 키는 변경되지 않았다', () => {
  it('cameraposWriter 는 여전히 sname 키로 쓰고 preset_name 키를 쓰지 않는다', () => {
    const path = join(tmpDir(), 'camerapos.json');
    writeCamerapos([
      { camIdx: 1, presetIdx: 1, label: 'Preset 1', pan: 19.8, tilt: 8.7, zoom: 1.69341 },
      { camIdx: 2, presetIdx: 1, label: 'Preset 1', pan: 113.8, tilt: 10, zoom: 1.80643 },
    ], path);
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('"sname"');
    expect(text).not.toContain('preset_name');
    expect(text).not.toContain('presetName');

    const json = JSON.parse(text) as { datas: Array<{ datas: Array<Record<string, unknown>> }> };
    const entry = json.datas[0].datas[0];
    expect(Object.keys(entry).sort()).toEqual(['cam_id', 'pan', 'preset_id', 'sname', 'tilt', 'zoom']);
    expect(entry.sname).toBe('Preset 1');
  });

  it('mapTargets.parseCameraViews 는 여전히 sname 키를 읽는다(writer↔parser 왕복)', () => {
    const path = join(tmpDir(), 'camerapos.json');
    writeCamerapos([{ camIdx: 1, presetIdx: 2, label: '정문 좌측', pan: 1, tilt: 2, zoom: 3 }], path);
    const views = parseCameraViews(JSON.parse(readFileSync(path, 'utf-8')));
    expect(views).toEqual([{ camIdx: 1, presetIdx: 2, label: '정문 좌측', pan: 1, tilt: 2, zoom: 3 }]);

    // preset_name 키로 바꿔치면 라벨을 못 읽는다(= sname 이 계약임을 반증적으로 확인).
    const broken = { datas: [{ cam_id: 1, datas: [{ cam_id: 1, preset_id: 2, preset_name: '정문 좌측', pan: 1, tilt: 2, zoom: 3 }] }] };
    expect(parseCameraViews(broken)[0].label).toBe('Preset 2'); // 폴백 라벨
  });

  it('경계 교차: JSON sname → PresetInfoRow.presetName → DB 컬럼 preset_name', () => {
    const path = join(tmpDir(), 'camerapos.json');
    writeCamerapos([{ camIdx: 1, presetIdx: 1, label: 'A동 정문', pan: 1.234567, tilt: 2, zoom: 3 }], path);
    const rows = buildPresets(JSON.parse(readFileSync(path, 'utf-8')), 'T');
    expect(rows).toEqual([{ camId: 1, presetId: 1, presetName: 'A동 정문', placeId: 1, pan: 1.23457, tilt: 2, zoom: 3, updatedAt: 'T' }]);

    const s = open(':memory:');
    s.upsertPlaceInfo([{ placeId: 1, placeName: 'Place01' }]);
    s.upsertCameraInfo([{
      camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
      camType: 'ptz', camCompany: null, placeId: 1, imgW: null, imgH: null, updatedAt: 'T',
    }]);
    s.upsertPresetInfo(rows);
    expect(rawDb(s).prepare(`SELECT preset_name, place_id FROM preset_info`).get())
      .toEqual({ preset_name: 'A동 정문', place_id: 1 });
  });

  it('고정 픽스처 camerapos JSON 도 sname 키 유지', () => {
    for (const f of ['test/fixtures/camerapos.sample.json', 'test/fixtures/camerapos.rpc.json']) {
      const text = readFileSync(f, 'utf-8');
      expect(text).toContain('sname');
      expect(text).not.toContain('preset_name');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 8) renumber 경로
// ────────────────────────────────────────────────────────────────
describe('적대적 8: 마이그레이션된 DB 에서 renumberSlotIds 정상 동작', () => {
  it('슬롯 3건 재번호 후 FK 부모(preset_info) 판정·데이터 보존', () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    const before = s.getSlotSetup();
    expect(before.map((r) => r.slotId).sort((a, b) => a - b)).toEqual([7, 8, 9]);

    const res = s.renumberSlotIds(new Map([[7, 1], [8, 2], [9, 3]]));
    expect(res.changed).toBe(3);

    const after = s.getSlotSetup();
    expect(after.map((r) => r.slotId).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // (cam,preset) 조합 보존 = FK 부모 판정이 preset_info 로도 유효
    expect(after.map((r) => `${r.camId}:${r.presetId}`).sort()).toEqual(['1:1', '1:2', '2:1']);
    // 재오픈 후에도 유지(멱등 마이그레이션이 재번호 결과를 훼손하지 않음)
    s.close();
    const s2 = open(dbPath);
    expect(s2.getSlotSetup().map((r) => r.slotId).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

// ────────────────────────────────────────────────────────────────
// 9) DB 뷰어
// ────────────────────────────────────────────────────────────────
describe('적대적 9: /db/tables 노출 테이블명 전환', () => {
  it('레거시 DB 오픈 후 /db/tables 에 preset_info 가 나오고 preset_pos 는 사라진다', async () => {
    const dbPath = seedLegacy();
    const s = open(dbPath);
    s.close(); // WAL 체크포인트 후 read-only 오픈

    app = Fastify();
    registerDbRoutes(app, { dbFile: dbPath });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/db/tables' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tables: string[] };
    expect(body.tables).toContain('preset_info');
    expect(body.tables).not.toContain('preset_pos');

    // 행 조회도 preset_name/place_id 컬럼을 노출한다.
    const rows = await app.inject({ method: 'GET', url: '/db/table/preset_info' });
    expect(rows.statusCode).toBe(200);
    const rb = rows.json() as { columns: string[]; total: number };
    expect(rb.columns).toContain('preset_name');
    expect(rb.columns).toContain('place_id');
    expect(rb.total).toBe(5);

    // 구 이름은 화이트리스트에서 404.
    const old = await app.inject({ method: 'GET', url: '/db/table/preset_pos' });
    expect(old.statusCode).toBe(404);
  });
});
