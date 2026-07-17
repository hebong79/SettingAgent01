import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDbRoutes } from '../src/api/dbRoutes.js';

/**
 * 검증자(qa-tester): dbRoutes 민감 컬럼 마스킹(설계서 §4). read-only 뷰어의 평문 노출 차단.
 * 검증: camera_info.password 응답에서 '****'(널은 널 유지) · 검색에서 민감 컬럼 제외(존재여부 유출 차단) ·
 *       타 테이블 무영향. 기존 dbRoutes.test.ts(라우트 일반)는 회귀 유지 — 이 파일은 마스킹 고유 계약만.
 */

let dir: string;
let dbFile: string;
let app: FastifyInstance | undefined;

/** 신 6테이블 부분 fixture: camera_info(password 평문 2행 + null 1행) + place_info(민감 컬럼 없음). */
function buildFixture(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE place_info (place_id INTEGER PRIMARY KEY, place_name TEXT);
    CREATE TABLE camera_info (
      cam_id INTEGER PRIMARY KEY, cam_name TEXT, user_id TEXT, password TEXT, url TEXT
    );
  `);
  db.prepare(`INSERT INTO place_info VALUES (?, ?)`).run(1, 'Place01');
  const ins = db.prepare(`INSERT INTO camera_info (cam_id, cam_name, user_id, password, url) VALUES (?, ?, ?, ?, ?)`);
  ins.run(1, 'CamFront', 'admin', 'topsecret', 'http://cam1');
  ins.run(2, 'CamBack', 'operator', 'hunter2', 'http://cam2');
  ins.run(3, 'CamNoPw', 'guest', null, 'http://cam3'); // password NULL → 마스킹 후에도 null 유지.
  db.close();
}

async function makeApp(file: string): Promise<FastifyInstance> {
  const a = Fastify();
  registerDbRoutes(a, { dbFile: file });
  await a.ready();
  return a;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbmask-'));
  dbFile = join(dir, 'setting.sqlite');
  buildFixture(dbFile);
});
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 파일 잠금 무시 */ }
});

describe('dbRoutes 마스킹 — camera_info.password', () => {
  it('평문 password → "****", NULL 은 null 유지(존재여부만 노출)', async () => {
    app = await makeApp(dbFile);
    const r = await app.inject({ method: 'GET', url: '/db/table/camera_info' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { columns: string[]; rows: Array<Record<string, unknown>> };
    // 컬럼 목록엔 password 가 그대로 있으나(스키마 노출은 정상),
    expect(body.columns).toContain('password');
    const byCam = new Map(body.rows.map((row) => [row.cam_id, row]));
    // 값이 있던 행은 '****'.
    expect(byCam.get(1)!.password).toBe('****');
    expect(byCam.get(2)!.password).toBe('****');
    // 원문은 어디에도 노출되지 않는다.
    expect(r.body).not.toContain('topsecret');
    expect(r.body).not.toContain('hunter2');
    // NULL 행은 null 유지(값 존재여부만 정직하게).
    expect(byCam.get(3)!.password).toBeNull();
    // 민감하지 않은 컬럼은 평문 유지(과잉 마스킹 아님).
    expect(byCam.get(1)!.user_id).toBe('admin');
    expect(byCam.get(1)!.cam_name).toBe('CamFront');
  });

  it('검색에서 민감 컬럼 제외 — password 값으로 검색해도 행 비노출(존재여부 유출 차단)', async () => {
    app = await makeApp(dbFile);
    // 'topsecret' 는 password 에만 존재 → 민감 컬럼이 검색 대상이면 1행이 매칭될 것.
    const r = await app.inject({ method: 'GET', url: '/db/table/camera_info?search=topsecret' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { rows: unknown[]; total: number };
    expect(body.total).toBe(0); // 민감 컬럼 검색 제외 → 매칭 0.
    expect(body.rows).toHaveLength(0);

    // 대조: 비민감 컬럼(cam_name)으로는 정상 검색.
    const r2 = await app.inject({ method: 'GET', url: '/db/table/camera_info?search=CamFront' });
    const body2 = JSON.parse(r2.body) as { rows: Array<Record<string, unknown>>; total: number };
    expect(body2.total).toBe(1);
    expect(body2.rows[0].password).toBe('****'); // 검색 결과에서도 마스킹 유지.
  });

  it('타 테이블(place_info) 무영향 — 민감 컬럼 맵 없음', async () => {
    app = await makeApp(dbFile);
    const r = await app.inject({ method: 'GET', url: '/db/table/place_info' });
    const body = JSON.parse(r.body) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toEqual({ place_id: 1, place_name: 'Place01' }); // 마스킹 미적용.
  });
});
