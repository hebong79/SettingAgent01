import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/**
 * 검증자(qa-tester): migrateToSettingDb 1회성 이관 CLI 종단 테스트(설계서 §5, §5.4).
 * 소형 fixture 트리(config/data)를 임시 cwd 에 만들고 실제 CLI 를 구동한다.
 * 검증: 행수(place/camera/preset/slot)·slot_id 1..N 유일·FK 무결(foreign_key_check 빈 결과)·
 *       0-based idx 재부여·센터라이징 UPDATE·멱등 재실행.
 *
 * ★ 실 CLI(`src/tools/migrateToSettingDb.ts`)를 child process(tsx)로 구동 — 파일 파싱·매핑까지 실제 경로 검증.
 */

const SCRIPT = resolve(__dirname, '../src/tools/migrateToSettingDb.ts');

let workDir: string;
let dbPath: string;

/** 소형 fixture: cam1, preset1(idx 0,1), preset2(idx 0) → 0-based → migrate 가 slot_id 1..3 재부여. */
function writeFixtures(dir: string): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'data', 'Place01'), { recursive: true });

  // 실 tools.config.json 을 그대로 복사(상대경로 규약 동일 — cwd 기준으로 fixture 를 읽는다).
  copyFileSync(resolve(__dirname, '../config/tools.config.json'), join(dir, 'config', 'tools.config.json'));

  // camerapos: cam1 preset1/2 PTZ.
  writeFileSync(
    join(dir, 'config', 'camerapos.json'),
    JSON.stringify({
      datas: [
        {
          datas: [
            { cam_id: 1, preset_id: 1, sname: 'Preset 1', pan: 10, tilt: 5, zoom: 2 },
            { cam_id: 1, preset_id: 2, sname: 'Preset 2', pan: 20, tilt: 6, zoom: 3 },
          ],
        },
      ],
    }),
  );

  // PtzCamRoi: imageWidth/Height=1000 → 픽셀/1000 정규화. 0-based idx(프리셋 간 중복) → 재부여 유도.
  const poly = (o: number): number[][] => [
    [100 + o, 100], [300 + o, 100], [300 + o, 300], [100 + o, 300],
  ];
  writeFileSync(
    join(dir, 'data', 'Place01', 'PtzCamRoi.json'),
    JSON.stringify({
      cameras: [
        {
          camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
          presets: [
            { preset_idx: 1, parking_spaces: [{ idx: 0, points: poly(0) }, { idx: 1, points: poly(400) }] },
            { preset_idx: 2, parking_spaces: [{ idx: 0, points: poly(0) }] },
          ],
        },
      ],
    }),
  );

  // slot_ptz: globalIdx=1 센터라이징 성공 항목 → slot_setup(slot_id=1) UPDATE.
  writeFileSync(
    join(dir, 'data', 'slot_ptz.json'),
    JSON.stringify({
      items: [
        { globalIdx: 1, slotId: 'c1p1s1', ptz: { pan: 51.5, tilt: 9.3, zoom: 14.4 }, centered: true, converged: true },
      ],
    }),
  );
}

function runMigrate(): string {
  return execFileSync('npx', ['tsx', SCRIPT, dbPath], {
    cwd: workDir,
    encoding: 'utf-8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'migrate-e2e-'));
  dbPath = join(workDir, 'out', 'setting.sqlite');
  writeFixtures(workDir);
  runMigrate();
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('migrateToSettingDb 종단(소형 fixture)', () => {
  function openDb(): Database.Database {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  it('행수: place=1, camera=1, preset=2, slot=3(Σ parking_spaces)', () => {
    const db = openDb();
    try {
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(count('place_info')).toBe(1);
      expect(count('camera_info')).toBe(1);
      expect(count('preset_info')).toBe(2);
      expect(count('slot_setup')).toBe(3); // preset1:2 + preset2:1
      expect(count('parking_evnt')).toBe(0);
      expect(count('parking_slot')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('slot_id 1..N 유일·연속(0-based 파일 → 전역 재부여)', () => {
    const db = openDb();
    try {
      const ids = (db.prepare(`SELECT slot_id FROM slot_setup ORDER BY slot_id`).all() as Array<{ slot_id: number }>)
        .map((r) => r.slot_id);
      expect(ids).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it('FK 무결성(foreign_key_check 빈 결과)', () => {
    const db = openDb();
    try {
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('camera_info: cam_type=ptz, img_w/img_h 보존, 자동탐색 필드 NULL', () => {
    const db = openDb();
    try {
      const cam = db.prepare(`SELECT cam_type, img_w, img_h, place_id, cam_name, url, password FROM camera_info WHERE cam_id=1`).get() as Record<string, unknown>;
      expect(cam.cam_type).toBe('ptz');
      expect(cam.img_w).toBe(1000);
      expect(cam.img_h).toBe(1000);
      expect(cam.place_id).toBe(1);
      expect(cam.cam_name).toBeNull();
      expect(cam.url).toBeNull();
      expect(cam.password).toBeNull();
    } finally {
      db.close();
    }
  });

  it('preset_slotidx 배열순 1-based; slot_roi 정규화 0~1', () => {
    const db = openDb();
    try {
      const rows = db.prepare(`SELECT slot_id, cam_id, preset_id, preset_slotidx, slot_roi FROM slot_setup ORDER BY slot_id`).all() as Array<Record<string, unknown>>;
      // slot_id 1,2 는 preset1 의 배열순 1,2 ; slot_id 3 은 preset2 의 1.
      expect(rows[0].preset_slotidx).toBe(1);
      expect(rows[1].preset_slotidx).toBe(2);
      expect(rows[2].preset_id).toBe(2);
      expect(rows[2].preset_slotidx).toBe(1);
      // slot_roi 는 정규화(0.1~0.3 범위)된 4점.
      const roi = JSON.parse(rows[0].slot_roi as string) as Array<{ x: number; y: number }>;
      expect(roi).toHaveLength(4);
      for (const p of roi) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    } finally {
      db.close();
    }
  });

  it('센터라이징 UPDATE: slot_id=1(globalIdx) 에 pan/tilt/zoom·centered=1 반영, 타 슬롯 미변경', () => {
    const db = openDb();
    try {
      const s1 = db.prepare(`SELECT pan, tilt, zoom, centered FROM slot_setup WHERE slot_id=1`).get() as Record<string, number>;
      expect(s1.centered).toBe(1);
      expect(s1.pan).toBeCloseTo(51.5);
      expect(s1.tilt).toBeCloseTo(9.3);
      expect(s1.zoom).toBeCloseTo(14.4);
      const s2 = db.prepare(`SELECT pan, centered FROM slot_setup WHERE slot_id=2`).get() as Record<string, number | null>;
      expect(s2.centered).toBe(0);
      expect(s2.pan).toBeNull();
    } finally {
      db.close();
    }
  });

  it('멱등 재실행 → 행수·slot_id·FK 불변', () => {
    runMigrate(); // 2회차
    const db = openDb();
    try {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM slot_setup`).get() as { n: number }).n).toBe(3);
      const ids = (db.prepare(`SELECT slot_id FROM slot_setup ORDER BY slot_id`).all() as Array<{ slot_id: number }>).map((r) => r.slot_id);
      expect(ids).toEqual([1, 2, 3]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // 센터라이징도 멱등 유지.
      expect((db.prepare(`SELECT centered FROM slot_setup WHERE slot_id=1`).get() as { centered: number }).centered).toBe(1);
    } finally {
      db.close();
    }
  });
});
