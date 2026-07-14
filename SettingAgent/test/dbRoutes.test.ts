import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDbRoutes, clampLimit, clampOffset } from '../src/api/dbRoutes.js';

/**
 * 검증자(qa-tester): src/api/dbRoutes.ts read-only 라우트 (fastify.inject + 임시 sqlite fixture).
 * 근거: 01_architect_plan.md §08 B1~B4 + 02_developer_changes.md 02-K.
 * 검증: /db/tables 목록 · /db/table/:name 컬럼·행·total·페이지네이션 · 전 컬럼 검색(CAST LIKE)
 *       · 보안(화이트리스트 404 · SQL 인젝션 무해 · escapeLike · limit/offset clamp) · DB 오픈 실패 503.
 * 외부 서비스 무관(R4 — DB만). 원본 observations.sqlite 미접근(임시 fixture DB 사용).
 */

let dir: string;
let dbFile: string;
let app: FastifyInstance | undefined;

/** 정수/문자/실수 혼합 fixture DB(테이블 2개). */
function buildFixture(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE detection (id INTEGER, plate TEXT, confidence REAL);
    CREATE TABLE parking_slots (slot_id INTEGER, label TEXT);
  `);
  const ins = db.prepare(`INSERT INTO detection (id, plate, confidence) VALUES (?, ?, ?)`);
  ins.run(1, 'car-A', 0.9);
  ins.run(2, 'car-B', 0.8);
  ins.run(3, 'truck-C', 0.5);
  ins.run(4, 'a_b', 0.1); // escapeLike(언더스코어 와일드카드) 검증용 리터럴.
  ins.run(5, 'aXb', 0.2); // 언더스코어가 와일드카드로 해석되면 매칭될 대조군.
  const ins2 = db.prepare(`INSERT INTO parking_slots (slot_id, label) VALUES (?, ?)`);
  ins2.run(10, 'P-10');
  db.close();
}

async function makeApp(file: string): Promise<FastifyInstance> {
  const a = Fastify();
  registerDbRoutes(a, { dbFile: file });
  await a.ready();
  return a;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbroutes-'));
  dbFile = join(dir, 'fixture.sqlite');
  buildFixture(dbFile);
});
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  // read-only 연결이 프로세스 수명 동안 캐시 오픈 상태(파일 핸들 유지) → Windows 에서 즉시 삭제 불가.
  // 정리는 best-effort(OS 임시 폴더가 후처리). 검증 본문과 무관.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 파일 잠금 무시 */ }
});

describe('GET /db/tables', () => {
  it('생성한 테이블명 목록(정렬)', async () => {
    app = await makeApp(dbFile);
    const r = await app.inject({ method: 'GET', url: '/db/tables' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.tables).toEqual(['detection', 'parking_slots']); // ORDER BY name
  });
});

describe('GET /db/table/:name — 컬럼·행·total·페이지네이션', () => {
  it('columns(PRAGMA 순서) · rows · total · limit · offset', async () => {
    app = await makeApp(dbFile);
    const r = await app.inject({ method: 'GET', url: '/db/table/detection' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.columns).toEqual(['id', 'plate', 'confidence']); // 스키마 순서 보존
    expect(body.total).toBe(5);
    expect(body.rows.length).toBe(5);
    expect(body.limit).toBe(200); // 기본
    expect(body.offset).toBe(0);
    expect(body.rows[0]).toMatchObject({ id: 1, plate: 'car-A', confidence: 0.9 });
  });

  it('페이지네이션: limit/offset 로 슬라이스(total 은 전체 유지)', async () => {
    app = await makeApp(dbFile);
    const p1 = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?limit=2&offset=0' })).body);
    expect(p1.rows.length).toBe(2);
    expect(p1.total).toBe(5);
    expect(p1.limit).toBe(2);
    expect(p1.rows.map((x: { id: number }) => x.id)).toEqual([1, 2]);

    const p3 = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?limit=2&offset=4' })).body);
    expect(p3.rows.length).toBe(1); // 마지막 페이지
    expect(p3.total).toBe(5);
    expect(p3.offset).toBe(4);
    expect(p3.rows[0].id).toBe(5);
  });
});

describe('GET /db/table/:name?search — 전 컬럼 CAST LIKE 필터', () => {
  it('텍스트 컬럼 부분 매칭(매칭 행만, total 도 검색 반영)', async () => {
    app = await makeApp(dbFile);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?search=car' })).body);
    expect(body.total).toBe(2); // car-A, car-B
    expect(body.rows.map((x: { id: number }) => x.id).sort()).toEqual([1, 2]);
  });

  it('숫자 컬럼도 CAST→TEXT 로 매칭(confidence 0.9)', async () => {
    app = await makeApp(dbFile);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?search=0.9' })).body);
    expect(body.total).toBe(1);
    expect(body.rows[0].id).toBe(1);
  });

  it('escapeLike: 언더스코어(_)는 와일드카드가 아니라 리터럴로 매칭', async () => {
    app = await makeApp(dbFile);
    // 'a_b' 검색 → 이스케이프되면 리터럴 'a_b'(id 4)만. 미이스케이프면 'aXb'(id 5)도 매칭될 것.
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?search=' + encodeURIComponent('a_b') })).body);
    expect(body.total).toBe(1);
    expect(body.rows[0].id).toBe(4);
  });
});

describe('보안 — 화이트리스트 / SQL 인젝션 무해', () => {
  it('존재하지 않는 테이블명 → 404', async () => {
    app = await makeApp(dbFile);
    const r = await app.inject({ method: 'GET', url: '/db/table/no_such' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toHaveProperty('error');
  });

  it('sqlite_master 조회 시도 → 화이트리스트(type=table) 밖 → 404', async () => {
    app = await makeApp(dbFile);
    const r = await app.inject({ method: 'GET', url: '/db/table/sqlite_master' });
    expect(r.statusCode).toBe(404);
  });

  it('테이블명 인젝션(; DROP TABLE) → 404 이고 테이블 온전(삭제 안 됨)', async () => {
    app = await makeApp(dbFile);
    const inj = 'detection; DROP TABLE detection';
    const r = await app.inject({ method: 'GET', url: '/db/table/' + encodeURIComponent(inj) });
    expect(r.statusCode).toBe(404);
    // 테이블 여전히 존재 + 행 수 온전.
    const tables = JSON.parse((await app.inject({ method: 'GET', url: '/db/tables' })).body).tables;
    expect(tables).toContain('detection');
    const still = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection' })).body);
    expect(still.total).toBe(5);
  });

  it("search=' OR '1'='1 → SQL 로 해석 안 되고 리터럴 LIKE(전 행 아님 = 0행)", async () => {
    app = await makeApp(dbFile);
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/db/table/detection?search=' + encodeURIComponent("' OR '1'='1") })).body,
    );
    // 리터럴 문자열을 포함하는 행이 없으므로 0행(1=1 로 해석됐다면 5행이 됐을 것).
    expect(body.total).toBe(0);
    expect(body.rows.length).toBe(0);
  });
});

describe('limit/offset clamp (라우트 반영)', () => {
  it('limit=99999 → 1000 상한', async () => {
    app = await makeApp(dbFile);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?limit=99999' })).body);
    expect(body.limit).toBe(1000);
    expect(body.rows.length).toBe(5); // 행이 5개뿐이라 전부
  });

  it('limit=0 → 최소 1', async () => {
    app = await makeApp(dbFile);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?limit=0' })).body);
    expect(body.limit).toBe(1);
    expect(body.rows.length).toBe(1);
  });

  it('limit 음수 → 최소 1, offset 음수 → 0', async () => {
    app = await makeApp(dbFile);
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/db/table/detection?limit=-3&offset=-5' })).body);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
  });
});

describe('DB 오픈 실패', () => {
  it('존재하지 않는 파일(fileMustExist) → 503', async () => {
    const a = Fastify();
    registerDbRoutes(a, { dbFile: join(dir, 'nope', 'missing.sqlite') });
    await a.ready();
    const r = await a.inject({ method: 'GET', url: '/db/tables' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body)).toHaveProperty('error');
    await a.close();
  });
});

describe('clampLimit / clampOffset 단위(경계값)', () => {
  it('clampLimit: 기본/상한/하한/비수치/소수', () => {
    expect(clampLimit(undefined)).toBe(200); // 비수치 → 기본
    expect(clampLimit('abc')).toBe(200);
    expect(clampLimit(0)).toBe(1); // 하한
    expect(clampLimit(-10)).toBe(1);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(500)).toBe(500);
    expect(clampLimit(1000)).toBe(1000);
    expect(clampLimit(1001)).toBe(1000); // 상한
    expect(clampLimit(99999)).toBe(1000);
    expect(clampLimit('250')).toBe(250); // 문자 숫자
    expect(clampLimit(3.9)).toBe(3); // floor
  });

  it('clampOffset: 0 하한/비수치/소수', () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset('abc')).toBe(0);
    expect(clampOffset(-5)).toBe(0); // 음수 → 0
    expect(clampOffset(0)).toBe(0);
    expect(clampOffset(7)).toBe(7);
    expect(clampOffset('42')).toBe(42);
    expect(clampOffset(9.9)).toBe(9); // floor
  });
});
