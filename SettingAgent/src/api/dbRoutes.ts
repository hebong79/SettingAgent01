import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';

export interface DbRoutesDeps {
  /** 조회 대상 SQLite 파일 경로(SqliteStore 와 동일 경로이나 연결은 독립·read-only). */
  dbFile: string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * 조회 응답에서 마스킹할 민감 컬럼(테이블명 → 컬럼 집합). read-only 뷰어의 평문 노출 차단(설계 §4).
 * 마스킹 대상 컬럼은 검색(LIKE) 대상에서도 제외해 값 존재여부 유출을 막는다.
 */
const SENSITIVE: Record<string, Set<string>> = {
  camera_info: new Set(['password']),
};

/** limit 정수 clamp 1..1000(기본 200). 비수치 → 기본값. */
export function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** offset ≥0 정수. 비수치·음수 → 0. */
export function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** SQLite 식별자 큰따옴표 quote(내부 " 는 "" 로 이스케이프). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** LIKE 패턴 특수문자(\ % _) 이스케이프 — ESCAPE '\' 절과 함께 사용(리터럴 매칭). */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQLite 테이블 뷰어 REST(설계서 §08, read-only). 캡처 잡/SqliteStore 와 별개의 독립 연결(R4).
 * - GET /db/tables            → sqlite_master 테이블 목록.
 * - GET /db/table/:name       → 컬럼·행·total(검색·페이지네이션). 테이블명 화이트리스트 + 전부 파라미터 바인딩.
 * 연결은 지연 오픈 후 캐시(readonly:true, fileMustExist:true). write 라우트 없음.
 */
export function registerDbRoutes(app: FastifyInstance, deps: DbRoutesDeps): void {
  let db: Database.Database | null = null;

  /** 지연 오픈 후 재사용. 파일 부재·오픈 실패 시 throw(호출측 503). */
  const getDb = (): Database.Database => {
    if (!db) {
      db = new Database(deps.dbFile, { readonly: true, fileMustExist: true });
    }
    return db;
  };

  /** sqlite_master 실재 테이블명(화이트리스트 소스 + 목록 응답 공용). */
  const getTableNames = (d: Database.Database): string[] =>
    (
      d.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
    ).map((r) => r.name);

  app.get('/db/tables', async (_req, reply) => {
    let d: Database.Database;
    try {
      d = getDb();
    } catch (err) {
      reply.code(503);
      return { error: 'DB 열기 실패', detail: err instanceof Error ? err.message : String(err) };
    }
    return { tables: getTableNames(d) };
  });

  app.get('/db/table/:name', async (req, reply) => {
    let d: Database.Database;
    try {
      d = getDb();
    } catch (err) {
      reply.code(503);
      return { error: 'DB 열기 실패', detail: err instanceof Error ? err.message : String(err) };
    }

    const { name } = req.params as { name: string };
    // 화이트리스트: sqlite_master 실재 목록과 정확히 일치할 때만 진행(임의 문자열의 식별자 삽입 원천 차단).
    if (!new Set(getTableNames(d)).has(name)) {
      reply.code(404);
      return { error: '존재하지 않는 테이블' };
    }

    const q = req.query as { search?: string; limit?: string; offset?: string };
    const search = typeof q.search === 'string' ? q.search : '';
    const limit = clampLimit(q.limit);
    const offset = clampOffset(q.offset);

    try {
      const quoted = quoteIdent(name); // 화이트리스트 통과 + 방어적 quote.
      const columns = (
        d.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>
      ).map((r) => r.name);

      // 검색: 전 컬럼 CAST→TEXT LIKE(값은 100% 바인딩, 컬럼명은 신뢰 스키마값 + quote).
      // 민감 컬럼은 검색 대상에서 제외(마스킹된 값과 매칭돼도 행이 노출되면 존재여부 유출).
      const sensitive = SENSITIVE[name];
      const searchCols = sensitive ? columns.filter((c) => !sensitive.has(c)) : columns;
      let where = '';
      const searchBinds: string[] = [];
      if (search && searchCols.length > 0) {
        const like = `%${escapeLike(search)}%`;
        const clauses = searchCols.map((c) => `CAST(${quoteIdent(c)} AS TEXT) LIKE ? ESCAPE '\\'`);
        where = ` WHERE (${clauses.join(' OR ')})`;
        for (let i = 0; i < searchCols.length; i++) searchBinds.push(like);
      }

      const total = (
        d.prepare(`SELECT COUNT(*) AS n FROM ${quoted}${where}`).get(...searchBinds) as { n: number }
      ).n;
      const rows = d
        .prepare(`SELECT * FROM ${quoted}${where} LIMIT ? OFFSET ?`)
        .all(...searchBinds, limit, offset) as Array<Record<string, unknown>>;

      // 민감 컬럼 마스킹: 값이 있으면 '****', null 은 null 유지(존재여부만 노출, 평문 차단).
      if (sensitive) {
        for (const row of rows) {
          for (const col of sensitive) {
            if (col in row) row[col] = row[col] != null ? '****' : null;
          }
        }
      }

      return { columns, rows, total, limit, offset };
    } catch (err) {
      reply.code(500);
      return { error: '조회 실패', detail: err instanceof Error ? err.message : String(err) };
    }
  });
}
