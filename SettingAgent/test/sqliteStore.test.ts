import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): SqliteStore DAO (G2 — 적재/조회 단위테스트).
 * :memory: 사용. 스키마 생성·관측/검출 적재·집계 멱등 upsert·체크포인트/스냅샷·인덱스 경로 검증.
 */

const aggSlot = (over: Partial<AggregatedSlot> = {}): AggregatedSlot => ({
  presetKey: '1:1',
  clusterId: 1,
  camIdx: 1,
  presetIdx: 1,
  x: 0.1,
  y: 0.2,
  w: 0.1,
  h: 0.1,
  support: 3,
  occupancyRate: 0.5,
  plateX: null,
  plateY: null,
  plateW: null,
  plateH: null,
  plateQuad: null,
  confidence: 0,
  posSpread: 0,
  angleSpread: null,
  status: 'candidate',
  ...over,
});

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

describe('SqliteStore 스키마/런 (G2)', () => {
  it(':memory: 생성 시 스키마 보장 — createRun → getRun 일치', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 50, intervalMs: 30000, startedAt: 'T0' });
    expect(runId).toBeGreaterThan(0);
    const run = store.getRun(runId);
    expect(run).toMatchObject({
      id: runId,
      startedAt: 'T0',
      endedAt: null,
      plannedCount: 50,
      doneCount: 0,
      intervalMs: 30000,
      status: 'running',
      stopReason: null,
    });
  });

  it('updateRunProgress / endRun 반영', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 5, intervalMs: 1000, startedAt: 'T0' });
    store.updateRunProgress(runId, 3);
    expect(store.getRun(runId)!.doneCount).toBe(3);
    store.endRun(runId, { status: 'done', stopReason: 'count', endedAt: 'T1' });
    const run = store.getRun(runId)!;
    expect(run.status).toBe('done');
    expect(run.stopReason).toBe('count');
    expect(run.endedAt).toBe('T1');
  });

  it('listRuns — 최신 id DESC 정렬 + limit', () => {
    store = new SqliteStore(':memory:');
    const a = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const b = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    const all = store.listRuns();
    expect(all.map((r) => r.id)).toEqual([b, a]); // DESC
    expect(store.listRuns(1).map((r) => r.id)).toEqual([b]);
  });

  it('getRun(없는 id) → undefined', () => {
    store = new SqliteStore(':memory:');
    expect(store.getRun(999)).toBeUndefined();
  });
});

describe('SqliteStore 관측/검출 적재·조회 (G2)', () => {
  it('insertObservation + insertDetections → getDetectionsForRun 평면 배열(round_idx 조인)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T0' });
    const obs = store.insertObservation({
      runId,
      roundIdx: 1,
      camIdx: 1,
      presetIdx: 2,
      capturedAt: 'C0',
      pan: 10,
      tilt: 5,
      zoom: 2,
      imgName: 'img1',
    });
    expect(obs).toBeGreaterThan(0);
    store.insertDetections(obs, 1, 2, [
      { kind: 'vehicle', x: 0.1, y: 0.1, w: 0.1, h: 0.1, conf: 0.9 },
      { kind: 'plate', x: 0.12, y: 0.14, w: 0.03, h: 0.02, conf: 0.8 },
    ]);

    const dets = store.getDetectionsForRun(runId);
    expect(dets).toHaveLength(2);
    // round_idx 가 observation 조인으로 부여되는지(경계면: detection 에는 round 없음).
    expect(dets.every((d) => d.roundIdx === 1)).toBe(true);
    expect(dets.every((d) => d.camIdx === 1 && d.presetIdx === 2)).toBe(true);
    const v = dets.find((d) => d.kind === 'vehicle')!;
    expect(v).toMatchObject({ x: 0.1, y: 0.1, w: 0.1, h: 0.1, conf: 0.9 });
    const p = dets.find((d) => d.kind === 'plate')!;
    expect(p).toMatchObject({ x: 0.12, y: 0.14, conf: 0.8 });
  });

  it('insertDetections 빈 배열은 무행(트랜잭션 안전)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const obs = store.insertObservation({
      runId, roundIdx: 1, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x',
    });
    store.insertDetections(obs, 1, 1, []);
    expect(store.getDetectionsForRun(runId)).toHaveLength(0);
  });

  it('getPresetRounds — 프리셋별 DISTINCT round 수(occupancy 분모, §11-6)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T0' });
    // preset 1:1 → round 1,2,3 (3) ; preset 1:2 → round 1,1 (distinct 1)
    for (const r of [1, 2, 3]) {
      store.insertObservation({ runId, roundIdx: r, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    }
    store.insertObservation({ runId, roundIdx: 1, camIdx: 1, presetIdx: 2, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertObservation({ runId, roundIdx: 1, camIdx: 1, presetIdx: 2, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    const map = store.getPresetRounds(runId);
    expect(map.get('1:1')).toBe(3);
    expect(map.get('1:2')).toBe(1); // DISTINCT round
  });

  it('검출은 run 으로 격리 — 다른 런 검출은 섞이지 않음', () => {
    store = new SqliteStore(':memory:');
    const r1 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'A' });
    const r2 = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'B' });
    const o1 = store.insertObservation({ runId: r1, roundIdx: 1, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(o1, 1, 1, [{ kind: 'vehicle', x: 0.1, y: 0.1, w: 0.1, h: 0.1, conf: 0.9 }]);
    expect(store.getDetectionsForRun(r1)).toHaveLength(1);
    expect(store.getDetectionsForRun(r2)).toHaveLength(0);
  });
});

describe('SqliteStore 집계 멱등 upsert (G2)', () => {
  it('replaceAggregatedSlots 2회 호출 → 멱등(중복 없음, replace)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slots = [aggSlot({ clusterId: 1 }), aggSlot({ clusterId: 2, x: 0.5 })];
    store.replaceAggregatedSlots(runId, slots);
    expect(store.getAggregatedSlots(runId)).toHaveLength(2);
    // 다시 호출 — delete+insert 라 2행 유지(누적 아님).
    store.replaceAggregatedSlots(runId, slots);
    expect(store.getAggregatedSlots(runId)).toHaveLength(2);
    // 더 적은 슬롯으로 replace → 그 수만 남음.
    store.replaceAggregatedSlots(runId, [aggSlot({ clusterId: 1 })]);
    const after = store.getAggregatedSlots(runId);
    expect(after).toHaveLength(1);
    expect(after[0].clusterId).toBe(1);
  });

  it('getAggregatedSlots — snake→camel 매핑 round-trip 동일(경계면)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slot = aggSlot({ occupancyRate: 0.75, plateX: 0.11, plateY: 0.13, plateW: 0.03, plateH: 0.02 });
    store.replaceAggregatedSlots(runId, [slot]);
    const [got] = store.getAggregatedSlots(runId);
    // snake_case 컬럼(occupancy_rate, plate_x ...) → camelCase 필드로 정확히 환원.
    expect(got).toEqual(slot);
  });

  it('updateAggregatedStatus — status 컬럼만 갱신(좌표 불변)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slot = aggSlot({ clusterId: 7, x: 0.42, y: 0.43, w: 0.11, h: 0.12 });
    store.replaceAggregatedSlots(runId, [slot]);
    store.updateAggregatedStatus(runId, '1:1', 7, 'merged');
    const [got] = store.getAggregatedSlots(runId);
    expect(got.status).toBe('merged');
    // 좌표는 그대로(불변식).
    expect({ x: got.x, y: got.y, w: got.w, h: got.h }).toEqual({ x: 0.42, y: 0.43, w: 0.11, h: 0.12 });
  });
});

// 검증자(qa-tester): quad 8컬럼 왕복 + 구스키마 마이그레이션 (설계 케이스 9, 핵심).
describe('SqliteStore quad 왕복·구스키마 마이그레이션 (G2·설계 케이스 9)', () => {
  const quad: NormalizedQuad = [
    { x: 0.31, y: 0.34 },
    { x: 0.36, y: 0.35 },
    { x: 0.33, y: 0.38 },
    { x: 0.30, y: 0.36 },
  ];

  it('detection: plate quad 8값 insert→get 왕복 일치; vehicle 은 quad undefined', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const obs = store.insertObservation({ runId, roundIdx: 1, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(obs, 1, 1, [
      { kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 },
      { kind: 'plate', x: 0.30, y: 0.34, w: 0.06, h: 0.04, conf: 0.8, quad },
    ]);
    const dets = store.getDetectionsForRun(runId);
    const v = dets.find((d) => d.kind === 'vehicle')!;
    const p = dets.find((d) => d.kind === 'plate')!;
    expect(v.quad).toBeUndefined();       // vehicle 행은 quad NULL → undefined
    expect(p.quad).toEqual(quad);         // plate quad 8값 정확 왕복(점순서 보존)
  });

  it('aggregated_slot: plateQuad 8값 왕복; null 은 null 로 복원', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceAggregatedSlots(runId, [
      aggSlot({ clusterId: 1, plateX: 0.30, plateY: 0.34, plateW: 0.06, plateH: 0.04, plateQuad: quad }),
      aggSlot({ clusterId: 2, x: 0.6, plateQuad: null }),
    ]);
    const got = store.getAggregatedSlots(runId);
    expect(got.find((s) => s.clusterId === 1)!.plateQuad).toEqual(quad);
    expect(got.find((s) => s.clusterId === 2)!.plateQuad).toBeNull();
  });

  it('구스키마(quad 컬럼 없는 파일 DB) 최초 오픈 시 ALTER TABLE 마이그레이션 → quad NULL 로 정상 read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-mig-'));
    try {
      const dbPath = join(dir, 'legacy.sqlite');
      // 1) quad 컬럼이 없는 "구 스키마" DB 를 직접 생성(신 SqliteStore 의 CREATE 문 없이).
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE capture_run (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, ended_at TEXT,
          planned_count INTEGER, done_count INTEGER, interval_ms INTEGER, status TEXT, stop_reason TEXT);
        CREATE TABLE observation (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, round_idx INTEGER,
          cam_idx INTEGER, preset_idx INTEGER, captured_at TEXT, pan REAL, tilt REAL, zoom REAL, img_name TEXT);
        CREATE TABLE detection (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER,
          cam_idx INTEGER, preset_idx INTEGER, kind TEXT, x REAL, y REAL, w REAL, h REAL, conf REAL);
        CREATE TABLE aggregated_slot (run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
          cam_idx INTEGER, preset_idx INTEGER, x REAL, y REAL, w REAL, h REAL, support INTEGER, occupancy_rate REAL,
          plate_x REAL, plate_y REAL, plate_w REAL, plate_h REAL, status TEXT);
      `);
      // 구 데이터: quad 컬럼 없는 detection 1행.
      const oid = raw.prepare(`INSERT INTO observation (run_id, round_idx, cam_idx, preset_idx, captured_at, pan, tilt, zoom, img_name)
        VALUES (1,1,1,1,'C',0,0,1,'x')`).run().lastInsertRowid;
      raw.prepare(`INSERT INTO detection (observation_id, cam_idx, preset_idx, kind, x, y, w, h, conf)
        VALUES (?,1,1,'plate',0.3,0.34,0.06,0.04,0.8)`).run(oid);
      raw.close();

      // 2) 신 SqliteStore 로 재오픈 → addColumnsIfMissing 가 quad 8+8 컬럼 ALTER 추가(크래시 없음).
      const s = new SqliteStore(dbPath);
      store = s;
      const dets = s.getDetectionsForRun(1);
      expect(dets).toHaveLength(1);
      expect(dets[0].kind).toBe('plate');
      expect(dets[0].quad).toBeUndefined(); // 구DB quad 컬럼 = NULL → undefined(Finalizer rectToQuad 폴백 대상)
      // 3) 마이그레이션 후 신규 insert(quad 포함)도 정상 왕복.
      const oid2 = s.insertObservation({ runId: 1, roundIdx: 2, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'y' });
      s.insertDetections(oid2, 1, 1, [{ kind: 'plate', x: 0.30, y: 0.34, w: 0.06, h: 0.04, conf: 0.9, quad }]);
      const after = s.getDetectionsForRun(1).find((d) => d.roundIdx === 2)!;
      expect(after.quad).toEqual(quad);
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 검증자(qa-tester): 강건 통계 3필드(confidence/posSpread/angleSpread) 왕복·마이그레이션 하위호환.
describe('SqliteStore 신뢰도 3필드 왕복·마이그레이션 (G2)', () => {
  it('confidence/posSpread/angleSpread 왕복 일치(비영값)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    const slot = aggSlot({ confidence: 0.83, posSpread: 0.012, angleSpread: 0.05 });
    store.replaceAggregatedSlots(runId, [slot]);
    const [got] = store.getAggregatedSlots(runId);
    expect(got.confidence).toBeCloseTo(0.83);
    expect(got.posSpread).toBeCloseTo(0.012);
    expect(got.angleSpread!).toBeCloseTo(0.05);
    expect(got).toEqual(slot);
  });

  it('angleSpread null 은 null 로 복원', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.replaceAggregatedSlots(runId, [aggSlot({ confidence: 0.5, posSpread: 0.02, angleSpread: null })]);
    const [got] = store.getAggregatedSlots(runId);
    expect(got.angleSpread).toBeNull();
  });

  it('구 aggregated_slot(신컬럼 없음) 재오픈 → ALTER 무크래시, read (0,0,null) 폴백', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-agg-mig-'));
    try {
      const dbPath = join(dir, 'legacy-agg.sqlite');
      // 신뢰도 3컬럼·plate quad 컬럼이 없는 구 aggregated_slot 스키마 직접 생성.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE aggregated_slot (run_id INTEGER, preset_key TEXT, cluster_id INTEGER,
          cam_idx INTEGER, preset_idx INTEGER, x REAL, y REAL, w REAL, h REAL, support INTEGER, occupancy_rate REAL,
          plate_x REAL, plate_y REAL, plate_w REAL, plate_h REAL, status TEXT);
      `);
      raw.prepare(`INSERT INTO aggregated_slot
        (run_id, preset_key, cluster_id, cam_idx, preset_idx, x, y, w, h, support, occupancy_rate,
         plate_x, plate_y, plate_w, plate_h, status)
        VALUES (1,'1:1',1,1,1,0.2,0.2,0.1,0.1,3,0.5,NULL,NULL,NULL,NULL,'candidate')`).run();
      raw.close();

      const s = new SqliteStore(dbPath);
      store = s;
      const [got] = s.getAggregatedSlots(1);
      expect(got.confidence).toBe(0);       // 구DB NULL → 0
      expect(got.posSpread).toBe(0);        // 구DB NULL → 0
      expect(got.angleSpread).toBeNull();   // 구DB NULL → null
      expect(got.plateQuad).toBeNull();
      // 마이그레이션 후 신규 insert(3필드 포함)도 정상 왕복.
      s.replaceAggregatedSlots(1, [aggSlot({ confidence: 0.7, posSpread: 0.01, angleSpread: 0.03 })]);
      const [after] = s.getAggregatedSlots(1);
      expect(after.confidence).toBeCloseTo(0.7);
      expect(after.angleSpread!).toBeCloseTo(0.03);
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 검증자(qa-tester): parking_slots preset PTZ(pan/tilt/zoom) 컬럼 마이그레이션 하위호환 (변경1).
// 근거: 01_architect_plan.md 변경1 2단계 + 02_developer_changes.md 마이그레이션 1줄(addColumnsIfMissing).
describe('SqliteStore parking_slots PTZ 마이그레이션 (변경1)', () => {
  it('구 parking_slots(pan/tilt/zoom 없음) 재오픈 → ALTER 추가, 기존 행 NULL, 이후 신규 insert 정상', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-slot-mig-'));
    try {
      const dbPath = join(dir, 'legacy-slots.sqlite');
      // 1) pan/tilt/zoom 컬럼이 없는 "구 스키마" parking_slots 를 직접 생성(구DB 재현).
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE capture_run (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, ended_at TEXT,
          planned_count INTEGER, done_count INTEGER, interval_ms INTEGER, status TEXT, stop_reason TEXT);
        CREATE TABLE parking_slots (
          run_id INTEGER, cam_idx INTEGER, preset_idx INTEGER, preset_key TEXT, slot_idx INTEGER,
          roi_json TEXT, vpd_json TEXT, lpd_json TEXT, occupied INTEGER, occupancy_rate REAL, updated_at TEXT,
          PRIMARY KEY (run_id, preset_key, slot_idx));
      `);
      // 구 데이터: pan/tilt/zoom 컬럼 없는 행 1개(occupied=1).
      raw.prepare(`INSERT INTO parking_slots
        (run_id, cam_idx, preset_idx, preset_key, slot_idx, roi_json, vpd_json, lpd_json, occupied, occupancy_rate, updated_at)
        VALUES (1,1,1,'1:1',1,'[{"x":0.2,"y":0.2}]',NULL,NULL,1,0.5,'T')`).run();
      raw.close();

      // 2) 신 SqliteStore 재오픈 → addColumnsIfMissing 가 pan/tilt/zoom ALTER 추가(크래시 없음).
      const s = new SqliteStore(dbPath);
      store = s;
      // 컬럼이 실제로 추가되었는지 PRAGMA 로 확인.
      const cols = new Set(
        (s as unknown as { db: Database.Database }).db
          .prepare(`PRAGMA table_info(parking_slots)`).all()
          .map((r) => (r as { name: string }).name),
      );
      expect(cols.has('pan')).toBe(true);
      expect(cols.has('tilt')).toBe(true);
      expect(cols.has('zoom')).toBe(true);

      // 기존 행은 신컬럼 NULL 로 읽힘(하위호환).
      const [old] = s.getParkingSlots(1);
      expect(old.slotIdx).toBe(1);
      expect(old.pan).toBeNull();
      expect(old.tilt).toBeNull();
      expect(old.zoom).toBeNull();
      expect(old.occupied).toBe(true); // 구 필드는 정상 유지

      // 3) 마이그레이션 후 신규 insert(PTZ 포함)도 정상 왕복.
      s.replaceParkingSlots(1, [{
        camIdx: 1, presetIdx: 1, presetKey: '1:1', slotIdx: 1,
        roiJson: '[{"x":0.2,"y":0.2}]', vpdJson: null, lpdJson: null,
        occupied: 0, occupancyRate: null, pan: 7, tilt: 8, zoom: 9, updatedAt: 'T2',
      }]);
      const [after] = s.getParkingSlots(1);
      expect([after.pan, after.tilt, after.zoom]).toEqual([7, 8, 9]);
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteStore 체크포인트·스냅샷 (G2)', () => {
  it('insertCheckpoint → getLatestCheckpoint(at_round DESC)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.insertCheckpoint(runId, 10, 'C10', JSON.stringify({ converged: false }));
    store.insertCheckpoint(runId, 20, 'C20', JSON.stringify({ converged: true }));
    const latest = store.getLatestCheckpoint(runId)!;
    expect(latest.atRound).toBe(20);
    expect(JSON.parse(latest.summaryJson)).toEqual({ converged: true });
  });

  it('getCheckpoints → at_round ASC 누적 컨텍스트', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    store.insertCheckpoint(runId, 20, 'C20', '{"b":2}');
    store.insertCheckpoint(runId, 10, 'C10', '{"a":1}');
    const cps = store.getCheckpoints(runId);
    expect(cps.map((c) => c.atRound)).toEqual([10, 20]); // ASC
  });

  it('getLatestCheckpoint(없음) → undefined', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    expect(store.getLatestCheckpoint(runId)).toBeUndefined();
  });

  it('insertArtifactSnapshot — 적재 무예외(감사용 기록)', () => {
    store = new SqliteStore(':memory:');
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
    expect(() => store!.insertArtifactSnapshot(runId, 'C', JSON.stringify({ slots: [] }))).not.toThrow();
  });
});

describe('SqliteStore 파일경로·스키마 재생성 (G2)', () => {
  it('파일 경로 — 디렉터리 자동 생성 + 스키마 IF NOT EXISTS 재생성 무해', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-'));
    try {
      const dbPath = join(dir, 'nested', 'obs.sqlite');
      const s1 = new SqliteStore(dbPath); // dirname 자동 생성
      expect(existsSync(join(dir, 'nested'))).toBe(true);
      const runId = s1.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T0' });
      s1.close();
      // 같은 파일 재오픈 — ensureSchema 가 IF NOT EXISTS 라 재생성 무해, 기존 데이터 보존.
      const s2 = new SqliteStore(dbPath);
      expect(s2.getRun(runId)).toBeDefined();
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
