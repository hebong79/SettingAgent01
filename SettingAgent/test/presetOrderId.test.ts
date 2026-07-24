// 프리셋 '순서값' 규약 검증:
//  (1) 뷰어 분석탭 '프리셋별 요약' 첫 열 = '순서'(행 번호 1부터), 구 '프리셋 키' 열 재추가 방지.
//  (2) DB preset_info.id = (cam_id, preset_id) 오름차순 1-based 순서값(신규 생성·구 DB 마이그레이션 공통).
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/capture/SqliteStore.js';

// ── (1) 뷰어 소스 가드(DOM 테스트 부재 — cameraKindSelect.test.ts 선례) ──
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');

describe("분석탭 '프리셋별 요약' 첫 열 = 순서(1부터)", () => {
  it("헤더가 '순서' 로 시작하고 '프리셋 키' 열은 없다", () => {
    const headers = app.slice(app.indexOf("['순서'"), app.indexOf("['순서'") + 120);
    expect(headers).toContain("['순서', '카메라', '프리셋', '라벨', '주차면 수', 'PTZ (pan, tilt, zoom)']");
    // 재추가 방지 가드(점유율 표의 '프리셋 키' 열은 별개이므로 이 표의 헤더 전문으로 좁힌다).
    expect(app).not.toContain("['프리셋 키', '카메라', '프리셋', '라벨'");
  });

  it('행 값은 배열 인덱스+1(1-based) 이며 p.key 를 쓰지 않는다', () => {
    const rowMap = app.slice(app.indexOf("['순서'"), app.indexOf("['순서'") + 500);
    expect(rowMap).toMatch(/a\.perPreset\.map\(\(p, i\) => \[\s*i \+ 1, p\.camIdx/);
    expect(rowMap).not.toMatch(/\[\s*p\.key,/);
  });
});

// ── (2) DB preset_info.id ──
let dir: string | undefined;
let store: SqliteStore | undefined;

afterEach(() => {
  store?.close(); store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function rawDb(s: SqliteStore): Database.Database {
  return (s as unknown as { db: Database.Database }).db;
}

/** FK 부모(place/camera) 를 세운 메모리 스토어. */
function freshStore(camIds: number[]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
  s.upsertCameraInfo(camIds.map((camId) => ({
    camId, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
    camType: 'ptz' as const, camCompany: null, placeId: 1, imgW: null, imgH: null, updatedAt: 'T',
  })));
  return s;
}

function preset(camId: number, presetId: number) {
  return { camId, presetId, presetName: `${camId}:${presetId}`, placeId: 1, pan: 1, tilt: 2, zoom: 3, updatedAt: 'T' };
}

/** (cam_id, preset_id) 오름차순으로 읽은 [키, id] 목록. */
function idsOf(s: SqliteStore): Array<[string, number | null]> {
  const rows = rawDb(s).prepare(`SELECT cam_id, preset_id, id FROM preset_info ORDER BY cam_id, preset_id`)
    .all() as Array<{ cam_id: number; preset_id: number; id: number | null }>;
  return rows.map((r) => [`${r.cam_id}:${r.preset_id}`, r.id]);
}

describe('preset_info.id — (cam_id, preset_id) 오름차순 1-based 순서값', () => {
  it('신규 DB 에 id 컬럼이 있고 upsert 순서와 무관하게 1..N 이 매겨진다', () => {
    store = freshStore([1, 2]);
    const cols = (rawDb(store).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('id');

    // 일부러 뒤섞어 넣는다 — id 는 삽입 순서가 아니라 (cam,preset) 정렬 기준.
    store.upsertPresetInfo([preset(2, 1), preset(1, 3), preset(1, 1), preset(1, 2)]);
    expect(idsOf(store)).toEqual([['1:1', 1], ['1:2', 2], ['1:3', 3], ['2:1', 4]]);
  });

  it('행 추가 시 전체가 다시 매겨져 빈틈이 없다', () => {
    store = freshStore([1, 2]);
    store.upsertPresetInfo([preset(1, 1), preset(2, 2)]);
    expect(idsOf(store)).toEqual([['1:1', 1], ['2:2', 2]]);

    store.upsertPresetInfo([preset(1, 5)]); // 중간에 끼어드는 신규 프리셋
    expect(idsOf(store)).toEqual([['1:1', 1], ['1:5', 2], ['2:2', 3]]);
  });

  it('기존 행 갱신(충돌 upsert)은 id 를 유지한다', () => {
    store = freshStore([1]);
    store.upsertPresetInfo([preset(1, 1), preset(1, 2)]);
    store.upsertPresetInfo([{ ...preset(1, 2), presetName: '이름변경', pan: 9 }]);
    expect(idsOf(store)).toEqual([['1:1', 1], ['1:2', 2]]);
    const row = rawDb(store).prepare(`SELECT preset_name FROM preset_info WHERE cam_id=1 AND preset_id=2`)
      .get() as { preset_name: string };
    expect(row.preset_name).toBe('이름변경');
  });

  it('구 DB(id 컬럼 없음) 오픈 시 ALTER 후 기존 행에 순서값이 채워진다', () => {
    dir = mkdtempSync(join(tmpdir(), 'presetid-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE place_info (place_id INTEGER PRIMARY KEY, place_name TEXT NOT NULL);
      CREATE TABLE camera_info (cam_id INTEGER PRIMARY KEY, cam_name TEXT, cam_uuid TEXT, url TEXT,
        user_id TEXT, password TEXT, rtsp_url TEXT, cam_type TEXT NOT NULL DEFAULT 'ptz',
        cam_company TEXT, place_id INTEGER NOT NULL DEFAULT 1 REFERENCES place_info(place_id),
        img_w INTEGER, img_h INTEGER, updated_at TEXT);
      CREATE TABLE preset_info (
        cam_id INTEGER NOT NULL REFERENCES camera_info(cam_id), preset_id INTEGER NOT NULL,
        preset_name TEXT, pan REAL NOT NULL, tilt REAL NOT NULL, zoom REAL NOT NULL,
        place_id INTEGER NOT NULL DEFAULT 1, updated_at TEXT,
        PRIMARY KEY (cam_id, preset_id));
      INSERT INTO place_info VALUES (1,'Place01');
      INSERT INTO camera_info (cam_id, place_id) VALUES (1,1), (2,1);
      INSERT INTO preset_info VALUES (2,1,'C2P1',0,0,1,1,'T0');
      INSERT INTO preset_info VALUES (1,2,'C1P2',0,0,1,1,'T0');
      INSERT INTO preset_info VALUES (1,1,'C1P1',0,0,1,1,'T0');
    `);
    raw.close();

    store = new SqliteStore(dbPath);
    expect(idsOf(store)).toEqual([['1:1', 1], ['1:2', 2], ['2:1', 3]]);

    // 멱등 — 재오픈해도 id 컬럼 1개·값 동일.
    store.close();
    store = new SqliteStore(dbPath);
    const cols = (rawDb(store).prepare(`PRAGMA table_info(preset_info)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'id')).toHaveLength(1);
    expect(idsOf(store)).toEqual([['1:1', 1], ['1:2', 2], ['2:1', 3]]);
  });
});
