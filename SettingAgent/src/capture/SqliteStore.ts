import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AggregatedSlot,
  CaptureRunRow,
  CenteringSlotRow,
  CenteringSlotView,
  CheckpointRow,
  DetectionRow,
  ParkingSlotRow,
  ParkingSlotView,
} from './types.js';
import type { NormalizedQuad, NormalizedPolygon } from '../domain/types.js';

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

  /** 9테이블 + 인덱스 보장(IF NOT EXISTS — 재생성 무해). */
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
        x REAL, y REAL, w REAL, h REAL, conf REAL,
        px0 REAL, py0 REAL, px1 REAL, py1 REAL, px2 REAL, py2 REAL, px3 REAL, py3 REAL
      );
      CREATE TABLE IF NOT EXISTS aggregated_slot (
        run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
        cam_idx INTEGER, preset_idx INTEGER,
        x REAL, y REAL, w REAL, h REAL,
        support INTEGER, occupancy_rate REAL,
        plate_x REAL, plate_y REAL, plate_w REAL, plate_h REAL,
        plate_px0 REAL, plate_py0 REAL, plate_px1 REAL, plate_py1 REAL,
        plate_px2 REAL, plate_py2 REAL, plate_px3 REAL, plate_py3 REAL,
        confidence REAL, pos_spread REAL, angle_spread REAL,
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
      CREATE TABLE IF NOT EXISTS floor_roi (
        run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
        x0 REAL, y0 REAL, x1 REAL, y1 REAL, x2 REAL, y2 REAL, x3 REAL, y3 REAL,
        polygon_json TEXT,
        updated_at TEXT,
        PRIMARY KEY (run_id, preset_key, cluster_id)
      );
      CREATE TABLE IF NOT EXISTS occupancy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER, cam_idx INTEGER, preset_idx INTEGER, at_round INTEGER,
        occupied_count INTEGER, total INTEGER, rate REAL,
        spaces_json TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS parking_slots (
        run_id INTEGER, cam_idx INTEGER, preset_idx INTEGER, preset_key TEXT,
        slot_idx INTEGER,
        roi_json TEXT,
        vpd_json TEXT,
        lpd_json TEXT,
        occupied INTEGER,
        occupancy_rate REAL,
        pan REAL, tilt REAL, zoom REAL,
        updated_at TEXT,
        PRIMARY KEY (run_id, preset_key, slot_idx)
      );
      CREATE TABLE IF NOT EXISTS centering_slot (
        slot_id TEXT NOT NULL,
        cam_id INTEGER NOT NULL,
        preset_id INTEGER NOT NULL,
        preset_slotidx INTEGER,
        pos TEXT NOT NULL,
        updated_at TEXT,
        PRIMARY KEY (cam_id, preset_id, slot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_det_obs ON detection(observation_id);
      CREATE INDEX IF NOT EXISTS idx_obs_run_preset ON observation(run_id, preset_idx);
      CREATE INDEX IF NOT EXISTS idx_occ_run ON occupancy(run_id, cam_idx, preset_idx, at_round);
    `);

    // 기존 파일 DB 마이그레이션: CREATE TABLE IF NOT EXISTS 는 신컬럼을 못 붙임.
    // pragma table_info 로 quad 컬럼 존재 확인 후 없으면 ADD COLUMN(구DB 는 NULL → rectToQuad 폴백).
    this.addColumnsIfMissing('detection', ['px0', 'py0', 'px1', 'py1', 'px2', 'py2', 'px3', 'py3']);
    this.addColumnsIfMissing(
      'aggregated_slot',
      ['plate_px0', 'plate_py0', 'plate_px1', 'plate_py1', 'plate_px2', 'plate_py2', 'plate_px3', 'plate_py3'],
    );
    // 강건 통계 3필드(신뢰도·위치퍼짐·각도분산). 구DB → ALTER(값 NULL, read 시 0/null 폴백).
    this.addColumnsIfMissing('aggregated_slot', ['confidence', 'pos_spread', 'angle_spread']);
    // 구 floor_roi(4점 x0..y3만) 파일 DB → polygon_json 컬럼 추가(NULL → 읽기 시 4점 폴백).
    this.addColumnsIfMissing('floor_roi', ['polygon_json'], 'TEXT');
    // 구 parking_slots(preset PTZ 없음) 파일 DB → pan/tilt/zoom 추가(NULL → 뷰 null 폴백).
    this.addColumnsIfMissing('parking_slots', ['pan', 'tilt', 'zoom'], 'REAL');
  }

  /** 테이블에 없는 컬럼만 ALTER TABLE ADD COLUMN(better-sqlite3 IF NOT EXISTS 미지원 → 존재검사). */
  private addColumnsIfMissing(table: string, columns: string[], type = 'REAL'): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const col of columns) {
      if (!existing.has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
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
    dets: Array<{ kind: 'vehicle' | 'plate'; x: number; y: number; w: number; h: number; conf: number; quad?: NormalizedQuad }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO detection (observation_id, cam_idx, preset_idx, kind, x, y, w, h, conf,
                              px0, py0, px1, py1, px2, py2, px3, py3)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: typeof dets) => {
      for (const d of rows) {
        const q = d.quad;
        stmt.run(
          observationId, camIdx, presetIdx, d.kind, d.x, d.y, d.w, d.h, d.conf,
          q ? q[0].x : null, q ? q[0].y : null, q ? q[1].x : null, q ? q[1].y : null,
          q ? q[2].x : null, q ? q[2].y : null, q ? q[3].x : null, q ? q[3].y : null,
        );
      }
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
                d.kind AS kind, d.x AS x, d.y AS y, d.w AS w, d.h AS h, d.conf AS conf,
                d.px0 AS px0, d.py0 AS py0, d.px1 AS px1, d.py1 AS py1,
                d.px2 AS px2, d.py2 AS py2, d.px3 AS px3, d.py3 AS py3
         FROM detection d JOIN observation o ON o.id = d.observation_id
         WHERE o.run_id = ?`,
      )
      .all(runId) as Array<
      DetectionRow & {
        px0: number | null; py0: number | null; px1: number | null; py1: number | null;
        px2: number | null; py2: number | null; px3: number | null; py3: number | null;
      }
    >;
    return rows.map((r) => {
      const { px0, py0, px1, py1, px2, py2, px3, py3, ...base } = r;
      const quad = quadFromCols(px0, py0, px1, py1, px2, py2, px3, py3);
      return quad ? { ...base, quad } : (base as DetectionRow);
    });
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
         plate_x, plate_y, plate_w, plate_h,
         plate_px0, plate_py0, plate_px1, plate_py1, plate_px2, plate_py2, plate_px3, plate_py3,
         confidence, pos_spread, angle_spread, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: AggregatedSlot[]) => {
      del.run(runId);
      for (const s of rows) {
        const q = s.plateQuad;
        ins.run(
          runId, s.presetKey, s.clusterId, s.camIdx, s.presetIdx,
          s.x, s.y, s.w, s.h, s.support, s.occupancyRate,
          s.plateX, s.plateY, s.plateW, s.plateH,
          q ? q[0].x : null, q ? q[0].y : null, q ? q[1].x : null, q ? q[1].y : null,
          q ? q[2].x : null, q ? q[2].y : null, q ? q[3].x : null, q ? q[3].y : null,
          s.confidence, s.posSpread, s.angleSpread, s.status,
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
                plate_x AS plateX, plate_y AS plateY, plate_w AS plateW, plate_h AS plateH,
                plate_px0 AS px0, plate_py0 AS py0, plate_px1 AS px1, plate_py1 AS py1,
                plate_px2 AS px2, plate_py2 AS py2, plate_px3 AS px3, plate_py3 AS py3,
                confidence, pos_spread AS posSpread, angle_spread AS angleSpread, status
         FROM aggregated_slot WHERE run_id = ? ORDER BY preset_key, cluster_id`,
      )
      .all(runId) as Array<
      Omit<AggregatedSlot, 'plateQuad' | 'confidence' | 'posSpread' | 'angleSpread'> & {
        px0: number | null; py0: number | null; px1: number | null; py1: number | null;
        px2: number | null; py2: number | null; px3: number | null; py3: number | null;
        confidence: number | null; posSpread: number | null; angleSpread: number | null;
      }
    >;
    return rows.map((r) => {
      const { px0, py0, px1, py1, px2, py2, px3, py3, confidence, posSpread, angleSpread, ...base } = r;
      // 구DB(신컬럼 없음) 행은 NULL → (0, 0, null) 폴백(AggregatedSlot 타입 충족).
      return {
        ...base,
        confidence: confidence ?? 0,
        posSpread: posSpread ?? 0,
        angleSpread: angleSpread ?? null,
        plateQuad: quadFromCols(px0, py0, px1, py1, px2, py2, px3, py3) ?? null,
      };
    });
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

  // ── 바닥 점유 영역(floor ROI · 가변 다각형 4~10점) ──────────
  /**
   * floor 다각형을 (run, presetKey, clusterId) 키로 upsert(LLM 산출 — 집계와 수명주기 분리).
   * polygon_json 을 authoritative 로 기록하고, x0..y3 에는 앞 4점을 병행 기록(구 뷰어/구 코드 하위호환).
   */
  upsertFloorRoi(runId: number, presetKey: string, clusterId: number, polygon: NormalizedPolygon, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO floor_roi (run_id, preset_key, cluster_id, x0, y0, x1, y1, x2, y2, x3, y3, polygon_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, preset_key, cluster_id) DO UPDATE SET
           x0=excluded.x0, y0=excluded.y0, x1=excluded.x1, y1=excluded.y1,
           x2=excluded.x2, y2=excluded.y2, x3=excluded.x3, y3=excluded.y3,
           polygon_json=excluded.polygon_json, updated_at=excluded.updated_at`,
      )
      .run(
        runId, presetKey, clusterId,
        polygon[0].x, polygon[0].y, polygon[1].x, polygon[1].y,
        polygon[2].x, polygon[2].y, polygon[3].x, polygon[3].y,
        JSON.stringify(polygon), updatedAt,
      );
  }

  getFloorRois(runId: number): Array<{ presetKey: string; clusterId: number; polygon: NormalizedPolygon }> {
    const rows = this.db
      .prepare(
        `SELECT preset_key AS presetKey, cluster_id AS clusterId, x0, y0, x1, y1, x2, y2, x3, y3, polygon_json AS polygonJson
         FROM floor_roi WHERE run_id = ? ORDER BY preset_key, cluster_id`,
      )
      .all(runId) as Array<{
      presetKey: string;
      clusterId: number;
      x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number;
      polygonJson: string | null;
    }>;
    return rows.map((r) => {
      // polygon_json 우선(가변 정점), 없으면(구 런) x0..y3 → 4점 폴리곤 폴백.
      let polygon: NormalizedPolygon | null = null;
      if (r.polygonJson) {
        try {
          const parsed = JSON.parse(r.polygonJson);
          if (Array.isArray(parsed) && parsed.length >= 4) polygon = parsed as NormalizedPolygon;
        } catch {
          polygon = null;
        }
      }
      if (!polygon) {
        polygon = [
          { x: r.x0, y: r.y0 },
          { x: r.x1, y: r.y1 },
          { x: r.x2, y: r.y2 },
          { x: r.x3, y: r.y3 },
        ];
      }
      return { presetKey: r.presetKey, clusterId: r.clusterId, polygon };
    });
  }

  // ── 차량 점유율(LLM 판정 · 체크포인트별 이력) ──────────────
  /** 점유율 판정 1건 append(체크포인트마다 행 추가 — 점유 변화 추적). 산술(count/rate)은 호출측 결정형 산출. */
  insertOccupancy(
    runId: number,
    o: {
      camIdx: number;
      presetIdx: number;
      atRound: number;
      occupiedCount: number;
      total: number;
      rate: number;
      spacesJson: string;
      updatedAt: string;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO occupancy (run_id, cam_idx, preset_idx, at_round, occupied_count, total, rate, spaces_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, o.camIdx, o.presetIdx, o.atRound, o.occupiedCount, o.total, o.rate, o.spacesJson, o.updatedAt);
  }

  /** 프리셋별 최신(at_round 최대) 점유율 1행씩. */
  getLatestOccupancy(runId: number): Array<{
    camIdx: number;
    presetIdx: number;
    atRound: number;
    occupiedCount: number;
    total: number;
    rate: number;
    spacesJson: string | null;
    updatedAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT o.cam_idx AS camIdx, o.preset_idx AS presetIdx, o.at_round AS atRound,
                o.occupied_count AS occupiedCount, o.total AS total, o.rate AS rate,
                o.spaces_json AS spacesJson, o.updated_at AS updatedAt
         FROM occupancy o
         JOIN (SELECT cam_idx, preset_idx, MAX(at_round) mr FROM occupancy WHERE run_id = ? GROUP BY cam_idx, preset_idx) m
           ON o.cam_idx = m.cam_idx AND o.preset_idx = m.preset_idx AND o.at_round = m.mr
         WHERE o.run_id = ? ORDER BY o.cam_idx, o.preset_idx`,
      )
      .all(runId, runId) as Array<{
      camIdx: number;
      presetIdx: number;
      atRound: number;
      occupiedCount: number;
      total: number;
      rate: number;
      spacesJson: string | null;
      updatedAt: string;
    }>;
  }

  // ── 파일 바닥ROI 기준 주차면(finalize 조립 산출 · §06) ──────
  /** run 기준 delete+insert(멱등, replaceAggregatedSlots 미러). *_json 은 이미 직렬화된 문자열. */
  replaceParkingSlots(runId: number, rows: ParkingSlotRow[]): void {
    const del = this.db.prepare(`DELETE FROM parking_slots WHERE run_id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO parking_slots
        (run_id, cam_idx, preset_idx, preset_key, slot_idx, roi_json, vpd_json, lpd_json, occupied, occupancy_rate, pan, tilt, zoom, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((list: ParkingSlotRow[]) => {
      del.run(runId);
      for (const r of list) {
        ins.run(
          runId, r.camIdx, r.presetIdx, r.presetKey, r.slotIdx,
          r.roiJson, r.vpdJson, r.lpdJson, r.occupied, r.occupancyRate,
          r.pan ?? null, r.tilt ?? null, r.zoom ?? null, r.updatedAt,
        );
      }
    });
    tx(rows);
  }

  // ── 센터라이징된 주차면 PTZ(centering_slot · /calibrate/ptz 산출) ──
  /**
   * 센터라이징 성공 슬롯 PTZ 를 (cam_id, preset_id, slot_id) 키로 upsert(트랜잭션 · upsertFloorRoi 미러).
   * ★ 전량 delete 금지 — 부분 캘리브레이션(start(slotIds))이 타깃 외 성공 행을 전멸시키지 않도록 키 단위 갱신.
   */
  upsertCenteringSlots(rows: CenteringSlotRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO centering_slot (slot_id, cam_id, preset_id, preset_slotidx, pos, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cam_id, preset_id, slot_id) DO UPDATE SET
         preset_slotidx=excluded.preset_slotidx, pos=excluded.pos, updated_at=excluded.updated_at`,
    );
    const tx = this.db.transaction((list: CenteringSlotRow[]) => {
      for (const r of list) {
        stmt.run(r.slotId, r.camIdx, r.presetIdx, r.presetSlotIdx ?? null, r.pos, r.updatedAt);
      }
    });
    tx(rows);
  }

  /** 전체 조회(cam/preset/슬롯순서 정렬). pos 는 JSON 문자열 그대로 — 소비측이 파싱. */
  getCenteringSlots(): CenteringSlotView[] {
    return this.db
      .prepare(
        `SELECT slot_id AS slotId, cam_id AS camIdx, preset_id AS presetIdx,
                preset_slotidx AS presetSlotIdx, pos, updated_at AS updatedAt
         FROM centering_slot ORDER BY cam_id, preset_id, preset_slotidx, slot_id`,
      )
      .all() as CenteringSlotView[];
  }

  getParkingSlots(runId: number): ParkingSlotView[] {
    const rows = this.db
      .prepare(
        `SELECT cam_idx AS camIdx, preset_idx AS presetIdx, preset_key AS presetKey, slot_idx AS slotIdx,
                roi_json AS roiJson, vpd_json AS vpdJson, lpd_json AS lpdJson,
                occupied, occupancy_rate AS occupancyRate, pan, tilt, zoom
         FROM parking_slots WHERE run_id = ? ORDER BY cam_idx, preset_idx, slot_idx`,
      )
      .all(runId) as Array<{
      camIdx: number;
      presetIdx: number;
      presetKey: string;
      slotIdx: number;
      roiJson: string | null;
      vpdJson: string | null;
      lpdJson: string | null;
      occupied: number | null;
      occupancyRate: number | null;
      pan: number | null;
      tilt: number | null;
      zoom: number | null;
    }>;
    return rows.map((r) => ({
      camIdx: r.camIdx,
      presetIdx: r.presetIdx,
      presetKey: r.presetKey,
      slotIdx: r.slotIdx,
      roi: parseJsonOrNull<ParkingSlotView['roi']>(r.roiJson) ?? [],
      vpd: parseJsonOrNull<ParkingSlotView['vpd']>(r.vpdJson),
      lpd: parseJsonOrNull<ParkingSlotView['lpd']>(r.lpdJson),
      occupied: r.occupied === 1,
      occupancyRate: r.occupancyRate ?? null,
      pan: r.pan ?? null,
      tilt: r.tilt ?? null,
      zoom: r.zoom ?? null,
    }));
  }
}

/** JSON 문자열 파싱(널·파싱실패 → null). parking_slots 의 *_json 컬럼 복원용. */
function parseJsonOrNull<T>(s: string | null): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** quad 8컬럼(NULL 가능) → NormalizedQuad. 어느 하나라도 NULL 이면 undefined(구DB·plate 부재). */
function quadFromCols(
  px0: number | null, py0: number | null, px1: number | null, py1: number | null,
  px2: number | null, py2: number | null, px3: number | null, py3: number | null,
): NormalizedQuad | undefined {
  if (
    px0 === null || py0 === null || px1 === null || py1 === null ||
    px2 === null || py2 === null || px3 === null || py3 === null
  ) {
    return undefined;
  }
  return [
    { x: px0, y: py0 },
    { x: px1, y: py1 },
    { x: px2, y: py2 },
    { x: px3, y: py3 },
  ];
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
