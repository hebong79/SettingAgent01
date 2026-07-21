import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetPosRow,
  SlotCenteringRow,
  SlotLpdRow,
  SlotSetupRow,
  SlotSetupView,
} from './types.js';
import type { NormalizedPoint, NormalizedQuad } from '../domain/types.js';
import { round5 } from '../util/round.js';

/**
 * SettingAgent 셋업 정본 SQLite DAO (설계서 §1 신 6테이블).
 * better-sqlite3(동기·프리빌트). dbPath 주입(':memory:' 또는 파일경로) — 테스트 가능.
 * 좌표 read/write 만 담당하고 비즈니스 로직(클러스터링/판정)은 두지 않는다.
 *
 * 좌표계 규약: 가변정점(slot_roi/vpd_bbox/lpd_obb/occupy_range)은 **정규화 0~1**(원점 좌상단)
 * JSON TEXT. 픽셀 저장 컬럼 없음. 원본 픽셀 역변환 기준은 camera_info.img_w/img_h.
 */
export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON'); // SQLite 기본 OFF — 연결마다 명시(설계서 §1).
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  /** 신 6테이블 + 인덱스 보장(IF NOT EXISTS — 재생성 무해). DDL 순서 = FK 부모 우선. */
  private ensureSchema(): void {
    this.db.exec(`
      -- 1) 주차장(장소) — 현재 place_id=1 고정
      CREATE TABLE IF NOT EXISTS place_info (
        place_id    INTEGER PRIMARY KEY,
        place_name  TEXT NOT NULL
      );

      -- 2) 카메라 — img_w/img_h 는 PtzCamRoi 픽셀↔정규화 0~1 역변환 기준
      CREATE TABLE IF NOT EXISTS camera_info (
        cam_id       INTEGER PRIMARY KEY,
        cam_name     TEXT,
        cam_uuid     TEXT,
        url          TEXT,
        user_id      TEXT,
        password     TEXT,
        rtsp_url     TEXT,
        cam_type     TEXT NOT NULL DEFAULT 'ptz'
                       CHECK (cam_type IN ('ptz','static')),
        cam_company  TEXT,
        place_id     INTEGER NOT NULL DEFAULT 1
                       REFERENCES place_info(place_id),
        img_w        INTEGER,
        img_h        INTEGER,
        updated_at   TEXT
      );

      -- 3) 프리셋 위치 PTZ = P1 존. PTZ 는 REAL 3컬럼
      CREATE TABLE IF NOT EXISTS preset_pos (
        cam_id      INTEGER NOT NULL
                      REFERENCES camera_info(cam_id),
        preset_id   INTEGER NOT NULL,
        sname       TEXT,
        pan         REAL NOT NULL,
        tilt        REAL NOT NULL,
        zoom        REAL NOT NULL,
        updated_at  TEXT,
        PRIMARY KEY (cam_id, preset_id)
      );

      -- 4) 슬롯 셋업 = floor_ROI + centering 병합. 슬롯당 1행(run_id 없음)
      --    가변정점 컬럼은 정규화 0~1 JSON TEXT, pan/tilt/zoom REAL, img1 상대경로
      CREATE TABLE IF NOT EXISTS slot_setup (
        slot_id        INTEGER PRIMARY KEY,
        cam_id         INTEGER NOT NULL,
        preset_id      INTEGER NOT NULL,
        preset_slotidx INTEGER,
        slot_roi       TEXT NOT NULL,
        vpd_bbox       TEXT,
        lpd_obb        TEXT,
        occupy_range   TEXT,
        pan            REAL,
        tilt           REAL,
        zoom           REAL,
        centered       INTEGER NOT NULL DEFAULT 0
                         CHECK (centered IN (0,1)),
        img1           TEXT,
        slot3d_front_center TEXT,
        updated_at     TEXT,
        FOREIGN KEY (cam_id, preset_id)
          REFERENCES preset_pos(cam_id, preset_id),
        UNIQUE (cam_id, preset_id, preset_slotidx)
      );
      CREATE INDEX IF NOT EXISTS idx_slot_setup_campreset
        ON slot_setup(cam_id, preset_id);

      -- 5) 주차 이벤트 이력 — ActionAgent 소비, 지금은 스키마만(writer/reader 미작성)
      CREATE TABLE IF NOT EXISTS parking_evnt (
        evnt_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id      INTEGER NOT NULL
                       REFERENCES slot_setup(slot_id),
        is_occupy    INTEGER NOT NULL
                       CHECK (is_occupy IN (0,1)),
        update_time  TEXT NOT NULL,
        plate_num    TEXT,
        img1         TEXT,
        img2         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evnt_slot_time
        ON parking_evnt(slot_id, update_time DESC);

      -- 6) 현재 주차면 상태 = 최신 이벤트 포인터 — 스키마만
      CREATE TABLE IF NOT EXISTS parking_slot (
        slot_id       INTEGER PRIMARY KEY
                        REFERENCES slot_setup(slot_id),
        last_evnt_id  INTEGER
                        REFERENCES parking_evnt(evnt_id)
      );
    `);

    // 멱등 마이그레이션: 기존 DB(컬럼 부재)에 3D 앞면 중심 컬럼 추가. 신규 DB 는 CREATE 에 포함 → no-op.
    const slotSetupCols = this.db.prepare(`PRAGMA table_info(slot_setup)`).all() as { name: string }[];
    if (!slotSetupCols.some((c) => c.name === 'slot3d_front_center')) {
      this.db.exec(`ALTER TABLE slot_setup ADD COLUMN slot3d_front_center TEXT`);
    }
  }

  // ── place_info ──────────────────────────────────────────
  /** 장소 upsert(마이그레이션·export 역경로). PK place_id 충돌 시 place_name 갱신. */
  upsertPlaceInfo(rows: PlaceInfoRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO place_info (place_id, place_name)
       VALUES (?, ?)
       ON CONFLICT(place_id) DO UPDATE SET place_name = excluded.place_name`,
    );
    const tx = this.db.transaction((list: PlaceInfoRow[]) => {
      for (const r of list) stmt.run(r.placeId, r.placeName);
    });
    tx(rows);
  }

  // ── camera_info ─────────────────────────────────────────
  /** 카메라 upsert(마이그레이션·export 역경로). PK cam_id 충돌 시 전 컬럼 갱신. */
  upsertCameraInfo(rows: CameraInfoRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO camera_info
         (cam_id, cam_name, cam_uuid, url, user_id, password, rtsp_url, cam_type, cam_company, place_id, img_w, img_h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cam_id) DO UPDATE SET
         cam_name=excluded.cam_name, cam_uuid=excluded.cam_uuid, url=excluded.url,
         user_id=excluded.user_id, password=excluded.password, rtsp_url=excluded.rtsp_url,
         cam_type=excluded.cam_type, cam_company=excluded.cam_company, place_id=excluded.place_id,
         img_w=excluded.img_w, img_h=excluded.img_h, updated_at=excluded.updated_at`,
    );
    const tx = this.db.transaction((list: CameraInfoRow[]) => {
      for (const r of list) {
        stmt.run(
          r.camId, r.camName, r.camUuid, r.url, r.userId, r.password, r.rtspUrl,
          r.camType, r.camCompany, r.placeId, r.imgW, r.imgH, r.updatedAt,
        );
      }
    });
    tx(rows);
  }

  // ── preset_pos ──────────────────────────────────────────
  /** 프리셋 PTZ upsert(마이그레이션·export 역경로). PK (cam_id,preset_id) 충돌 시 갱신. */
  upsertPresetPos(rows: PresetPosRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO preset_pos (cam_id, preset_id, sname, pan, tilt, zoom, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cam_id, preset_id) DO UPDATE SET
         sname=excluded.sname, pan=excluded.pan, tilt=excluded.tilt, zoom=excluded.zoom,
         updated_at=excluded.updated_at`,
    );
    const tx = this.db.transaction((list: PresetPosRow[]) => {
      for (const r of list) stmt.run(r.camId, r.presetId, r.sname, round5(r.pan), round5(r.tilt), round5(r.zoom), r.updatedAt);
    });
    tx(rows);
  }

  // ── slot_setup ──────────────────────────────────────────
  /**
   * 확정본 전량 교체(finalize). DELETE 후 INSERT 전량을 **단일 트랜잭션**으로 —
   * 예외 시 better-sqlite3 transaction 이 자동 롤백 → 이전 확정본 보존(설계서 배경 A.3).
   */
  replaceSlotSetup(rows: SlotSetupRow[]): void {
    const del = this.db.prepare(`DELETE FROM slot_setup`);
    const ins = this.db.prepare(
      `INSERT INTO slot_setup
         (slot_id, cam_id, preset_id, preset_slotidx, slot_roi, vpd_bbox, lpd_obb, occupy_range,
          pan, tilt, zoom, centered, img1, slot3d_front_center, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((list: SlotSetupRow[]) => {
      del.run();
      for (const r of list) {
        ins.run(
          r.slotId, r.camId, r.presetId, r.presetSlotIdx ?? null,
          r.slotRoi, r.vpdBbox ?? null, r.lpdObb ?? null, r.occupyRange ?? null,
          r.pan == null ? null : round5(r.pan), r.tilt == null ? null : round5(r.tilt), r.zoom == null ? null : round5(r.zoom),
          r.centered, r.img1 ?? null,
          r.slot3dFrontCenter ?? null, r.updatedAt ?? null,
        );
      }
    });
    tx(rows);
  }

  /** 전체 조회(뷰어/`/capture/slots` 소스). *_json 파싱 + presetKey 파생. */
  getSlotSetup(): SlotSetupView[] {
    const rows = this.db
      .prepare(
        `SELECT slot_id AS slotId, cam_id AS camId, preset_id AS presetId,
                preset_slotidx AS presetSlotIdx, slot_roi AS slotRoi,
                vpd_bbox AS vpdBbox, lpd_obb AS lpdObb, occupy_range AS occupyRange,
                pan, tilt, zoom, centered, img1,
                slot3d_front_center AS slot3dFrontCenter, updated_at AS updatedAt
         FROM slot_setup ORDER BY cam_id, preset_id, preset_slotidx`,
      )
      .all() as Array<{
      slotId: number;
      camId: number;
      presetId: number;
      presetSlotIdx: number | null;
      slotRoi: string;
      vpdBbox: string | null;
      lpdObb: string | null;
      occupyRange: string | null;
      pan: number | null;
      tilt: number | null;
      zoom: number | null;
      centered: number;
      img1: string | null;
      slot3dFrontCenter: string | null;
      updatedAt: string | null;
    }>;
    return rows.map((r) => ({
      slotId: r.slotId,
      camId: r.camId,
      presetId: r.presetId,
      presetSlotIdx: r.presetSlotIdx ?? null,
      presetKey: `${r.camId}:${r.presetId}`,
      roi: parseJsonOrNull<NormalizedPoint[]>(r.slotRoi) ?? [],
      vpd: parseJsonOrNull<SlotSetupView['vpd']>(r.vpdBbox),
      lpd: parseJsonOrNull<NormalizedQuad>(r.lpdObb),
      occupyRange: parseJsonOrNull<NormalizedPoint[]>(r.occupyRange),
      pan: r.pan ?? null,
      tilt: r.tilt ?? null,
      zoom: r.zoom ?? null,
      centered: r.centered === 1,
      img1: r.img1 ?? null,
      slot3dFrontCenter: parseJsonOrNull<SlotSetupView['slot3dFrontCenter']>(r.slot3dFrontCenter),
      updatedAt: r.updatedAt ?? null,
    }));
  }

  /**
   * 센터라이징 결과를 slot_id 키로 부분 UPDATE(pan/tilt/zoom/centered/img1/updated_at 만).
   * ★ 전량 delete 금지 — 부분 캘리브레이션이 타깃 외 슬롯 기하/센터링을 지우지 않도록 키 단위 갱신.
   * slot_id 미존재 행은 조용히 무시(slot_setup 이 먼저 채워져야 함).
   */
  upsertSlotCentering(rows: SlotCenteringRow[]): void {
    const stmt = this.db.prepare(
      `UPDATE slot_setup
         SET pan = ?, tilt = ?, zoom = ?, centered = ?, img1 = ?, updated_at = ?
       WHERE slot_id = ?`,
    );
    const tx = this.db.transaction((list: SlotCenteringRow[]) => {
      for (const r of list) {
        stmt.run(
          r.pan == null ? null : round5(r.pan), r.tilt == null ? null : round5(r.tilt), r.zoom == null ? null : round5(r.zoom),
          r.centered, r.img1 ?? null, r.updatedAt, r.slotId,
        );
      }
    });
    tx(rows);
  }

  /**
   * 번호판 디스커버리/수동추가 결과를 slot_id 키로 부분 UPDATE(lpd_obb/updated_at, occupyRange 제공 시 occupy_range 도).
   * ★ 전량 delete 금지(메모리 노트 "finalize slot_setup wipe fragility") — 키 단위 UPDATE 로
   *   타깃 외 슬롯·타 컬럼(slot_roi/vpd/pan/tilt/센터링) 불변. slot_id 미존재 행은 조용히 무시.
   * lpdObb·occupyRange 는 이미 stringify5 직렬화된 정규화 OBB JSON TEXT(호출측 규약).
   * ★ occupyRange 미제공(undefined) 행은 occupy_range 컬럼 무접촉(기존 값 보존) — 수동 /capture/slots/lpd
   *   경로(occupyRange 없음)가 finalize·discovery 산출 occupy_range 를 덮어쓰지 않게 한다(wipe 방지).
   *   discovery(found 판 quad)만 occupyRange 를 동봉해 결정형 점유영역을 갱신한다.
   */
  upsertSlotLpd(rows: SlotLpdRow[]): void {
    const stmtLpd = this.db.prepare(`UPDATE slot_setup SET lpd_obb = ?, updated_at = ? WHERE slot_id = ?`);
    const stmtLpdOccupy = this.db.prepare(`UPDATE slot_setup SET lpd_obb = ?, occupy_range = ?, updated_at = ? WHERE slot_id = ?`);
    const tx = this.db.transaction((list: SlotLpdRow[]) => {
      for (const r of list) {
        if (r.occupyRange === undefined) stmtLpd.run(r.lpdObb ?? null, r.updatedAt, r.slotId);
        else stmtLpdOccupy.run(r.lpdObb ?? null, r.occupyRange ?? null, r.updatedAt, r.slotId);
      }
    });
    tx(rows);
  }

  /** slot_setup 검출·센터링 컬럼 전량 초기화(수동 '초기화' 버튼). slot_roi·행은 보존. 반환=초기화 행수. */
  clearSlotSetupEnrichment(updatedAt: string): number {
    const info = this.db.prepare(
      `UPDATE slot_setup SET vpd_bbox=NULL, lpd_obb=NULL, occupy_range=NULL,
       pan=NULL, tilt=NULL, zoom=NULL, centered=0, img1=NULL, updated_at=?`,
    ).run(updatedAt);
    return info.changes;
  }
}

/** JSON 문자열 파싱(널·파싱실패 → null). slot_setup 의 *_json 컬럼 복원용. */
function parseJsonOrNull<T>(s: string | null): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
