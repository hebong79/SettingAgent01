import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AggregatedSlot,
  CaptureRunRow,
  CheckpointRow,
  DetectionRow,
} from './types.js';

/**
 * 관측·검출·집계 누적용 SQLite DAO (설계서 §5).
 * better-sqlite3(동기·프리빌트). dbPath 주입(':memory:' 또는 파일경로) — 테스트 가능.
 * 좌표·통계 read/write 만 담당하고 비즈니스 로직(클러스터링/판정)은 두지 않는다.
 */
export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  /** 6테이블 + 인덱스 보장(IF NOT EXISTS — 재생성 무해). */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT, ended_at TEXT,
        planned_count INTEGER, done_count INTEGER, interval_ms INTEGER,
        status TEXT, stop_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS observation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER, round_idx INTEGER,
        cam_idx INTEGER, preset_idx INTEGER, captured_at TEXT,
        pan REAL, tilt REAL, zoom REAL, img_name TEXT
      );
      CREATE TABLE IF NOT EXISTS detection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER,
        cam_idx INTEGER, preset_idx INTEGER,
        kind TEXT,
        x REAL, y REAL, w REAL, h REAL, conf REAL
      );
      CREATE TABLE IF NOT EXISTS aggregated_slot (
        run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
        cam_idx INTEGER, preset_idx INTEGER,
        x REAL, y REAL, w REAL, h REAL,
        support INTEGER, occupancy_rate REAL,
        plate_x REAL, plate_y REAL, plate_w REAL, plate_h REAL,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoint (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER, at_round INTEGER, created_at TEXT,
        summary_json TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER, created_at TEXT, artifact_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_det_obs ON detection(observation_id);
      CREATE INDEX IF NOT EXISTS idx_obs_run_preset ON observation(run_id, preset_idx);
    `);
  }

  // ── 런 ──────────────────────────────────────────────────
  createRun(p: { plannedCount: number; intervalMs: number; startedAt: string }): number {
    const info = this.db
      .prepare(
        `INSERT INTO capture_run (started_at, ended_at, planned_count, done_count, interval_ms, status, stop_reason)
         VALUES (?, NULL, ?, 0, ?, 'running', NULL)`,
      )
      .run(p.startedAt, p.plannedCount, p.intervalMs);
    return Number(info.lastInsertRowid);
  }

  updateRunProgress(runId: number, doneCount: number): void {
    this.db.prepare(`UPDATE capture_run SET done_count = ? WHERE id = ?`).run(doneCount, runId);
  }

  endRun(
    runId: number,
    p: { status: 'done' | 'stopped' | 'error'; stopReason: 'count' | 'manual' | 'error'; endedAt: string },
  ): void {
    this.db
      .prepare(`UPDATE capture_run SET status = ?, stop_reason = ?, ended_at = ? WHERE id = ?`)
      .run(p.status, p.stopReason, p.endedAt, runId);
  }

  getRun(runId: number): CaptureRunRow | undefined {
    const r = this.db.prepare(`SELECT * FROM capture_run WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
    return r ? mapRun(r) : undefined;
  }

  listRuns(limit = 50): CaptureRunRow[] {
    const rows = this.db.prepare(`SELECT * FROM capture_run ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  // ── 관측·검출(라운드 단위) ────────────────────────────────
  insertObservation(o: {
    runId: number;
    roundIdx: number;
    camIdx: number;
    presetIdx: number;
    capturedAt: string;
    pan: number;
    tilt: number;
    zoom: number;
    imgName: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO observation (run_id, round_idx, cam_idx, preset_idx, captured_at, pan, tilt, zoom, img_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.runId, o.roundIdx, o.camIdx, o.presetIdx, o.capturedAt, o.pan, o.tilt, o.zoom, o.imgName);
    return Number(info.lastInsertRowid);
  }

  insertDetections(
    observationId: number,
    camIdx: number,
    presetIdx: number,
    dets: Array<{ kind: 'vehicle' | 'plate'; x: number; y: number; w: number; h: number; conf: number }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO detection (observation_id, cam_idx, preset_idx, kind, x, y, w, h, conf)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: typeof dets) => {
      for (const d of rows) stmt.run(observationId, camIdx, presetIdx, d.kind, d.x, d.y, d.w, d.h, d.conf);
    });
    tx(dets);
  }

  // ── 집계 입력·출력 ────────────────────────────────────────
  /** Aggregator 입력: 런의 전체 검출을 평면 배열로(observation 조인으로 round_idx 부여). */
  getDetectionsForRun(runId: number): DetectionRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.observation_id AS observationId, o.round_idx AS roundIdx,
                d.cam_idx AS camIdx, d.preset_idx AS presetIdx,
                d.kind AS kind, d.x AS x, d.y AS y, d.w AS w, d.h AS h, d.conf AS conf
         FROM detection d JOIN observation o ON o.id = d.observation_id
         WHERE o.run_id = ?`,
      )
      .all(runId) as DetectionRow[];
    return rows;
  }

  /** 프리셋별 총 관측 라운드 수(occupancyRate 분모). `${cam}:${preset}` → distinct round 수. */
  getPresetRounds(runId: number): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT cam_idx AS camIdx, preset_idx AS presetIdx, COUNT(DISTINCT round_idx) AS rounds
         FROM observation WHERE run_id = ? GROUP BY cam_idx, preset_idx`,
      )
      .all(runId) as Array<{ camIdx: number; presetIdx: number; rounds: number }>;
    const map = new Map<string, number>();
    for (const r of rows) map.set(`${r.camIdx}:${r.presetIdx}`, r.rounds);
    return map;
  }

  /** run 기준 delete+insert(멱등). 트랜잭션 원자적. */
  replaceAggregatedSlots(runId: number, slots: AggregatedSlot[]): void {
    const del = this.db.prepare(`DELETE FROM aggregated_slot WHERE run_id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO aggregated_slot
        (run_id, preset_key, cluster_id, cam_idx, preset_idx, x, y, w, h, support, occupancy_rate,
         plate_x, plate_y, plate_w, plate_h, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: AggregatedSlot[]) => {
      del.run(runId);
      for (const s of rows) {
        ins.run(
          runId, s.presetKey, s.clusterId, s.camIdx, s.presetIdx,
          s.x, s.y, s.w, s.h, s.support, s.occupancyRate,
          s.plateX, s.plateY, s.plateW, s.plateH, s.status,
        );
      }
    });
    tx(slots);
  }

  getAggregatedSlots(runId: number): AggregatedSlot[] {
    const rows = this.db
      .prepare(
        `SELECT preset_key AS presetKey, cluster_id AS clusterId, cam_idx AS camIdx, preset_idx AS presetIdx,
                x, y, w, h, support, occupancy_rate AS occupancyRate,
                plate_x AS plateX, plate_y AS plateY, plate_w AS plateW, plate_h AS plateH, status
         FROM aggregated_slot WHERE run_id = ? ORDER BY preset_key, cluster_id`,
      )
      .all(runId) as AggregatedSlot[];
    return rows;
  }

  /** 집계 결과의 status 를 cluster 단위로 갱신(좌표 불변 — 메타만). */
  updateAggregatedStatus(runId: number, presetKey: string, clusterId: number, status: AggregatedSlot['status']): void {
    this.db
      .prepare(`UPDATE aggregated_slot SET status = ? WHERE run_id = ? AND preset_key = ? AND cluster_id = ?`)
      .run(status, runId, presetKey, clusterId);
  }

  // ── 체크포인트·스냅샷 ────────────────────────────────────
  insertCheckpoint(runId: number, atRound: number, createdAt: string, summaryJson: string): void {
    this.db
      .prepare(`INSERT INTO checkpoint (run_id, at_round, created_at, summary_json) VALUES (?, ?, ?, ?)`)
      .run(runId, atRound, createdAt, summaryJson);
  }

  getLatestCheckpoint(runId: number): CheckpointRow | undefined {
    const r = this.db
      .prepare(`SELECT id, run_id AS runId, at_round AS atRound, created_at AS createdAt, summary_json AS summaryJson
                FROM checkpoint WHERE run_id = ? ORDER BY at_round DESC, id DESC LIMIT 1`)
      .get(runId) as CheckpointRow | undefined;
    return r;
  }

  getCheckpoints(runId: number): CheckpointRow[] {
    return this.db
      .prepare(`SELECT id, run_id AS runId, at_round AS atRound, created_at AS createdAt, summary_json AS summaryJson
                FROM checkpoint WHERE run_id = ? ORDER BY at_round ASC, id ASC`)
      .all(runId) as CheckpointRow[];
  }

  insertArtifactSnapshot(runId: number, createdAt: string, artifactJson: string): void {
    this.db
      .prepare(`INSERT INTO artifact_snapshot (run_id, created_at, artifact_json) VALUES (?, ?, ?)`)
      .run(runId, createdAt, artifactJson);
  }
}

function mapRun(r: Record<string, unknown>): CaptureRunRow {
  return {
    id: r.id as number,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
    plannedCount: r.planned_count as number,
    doneCount: r.done_count as number,
    intervalMs: r.interval_ms as number,
    status: r.status as CaptureRunRow['status'],
    stopReason: (r.stop_reason as CaptureRunRow['stopReason']) ?? null,
  };
}
