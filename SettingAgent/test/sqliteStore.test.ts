import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetPosRow,
  SlotCenteringRow,
  SlotLpdRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): SqliteStore 신 6테이블 DAO (설계서 §1 DDL · §2.5 표면).
 * 구 10테이블/구 메서드(createRun/insertObservation/replaceParkingSlots/...) 전면 폐기 → 신 계약 재작성.
 * 검증: 스키마 생성·foreign_keys=ON 실효·replaceSlotSetup 트랜잭션 원자성·getSlotSetup presetKey/roi 파싱·
 *       upsertSlotCentering 부분 UPDATE(타 슬롯 불변)·slot_setup UNIQUE(cam,preset,preset_slotidx).
 */

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

// ── 픽스처 헬퍼 ─────────────────────────────────────────────
const placeRow = (over: Partial<PlaceInfoRow> = {}): PlaceInfoRow => ({ placeId: 1, placeName: 'Place01', ...over });

const cameraRow = (over: Partial<CameraInfoRow> = {}): CameraInfoRow => ({
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T', ...over,
});

const presetRow = (over: Partial<PresetPosRow> = {}): PresetPosRow => ({
  camId: 1, presetId: 1, sname: 'Preset 1', pan: 10, tilt: 5, zoom: 2, updatedAt: 'T', ...over,
});

const roi: NormalizedPoint[] = [
  { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 },
];
const lpdQuad: NormalizedQuad = [
  { x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 },
];

const slotRow = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi), vpdBbox: null, lpdObb: null, occupyRange: null,
  pan: null, tilt: null, zoom: null, centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: 'T', ...over,
});

/** place/camera/preset(FK 부모) 를 시드한 :memory: 스토어. slot_setup FK(→preset_pos) 충족용. */
function seededStore(presets: PresetPosRow[] = [presetRow()]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([placeRow()]);
  s.upsertCameraInfo([cameraRow()]);
  s.upsertPresetPos(presets);
  return s;
}

// ── 스키마 · 부모 upsert ─────────────────────────────────────
describe('SqliteStore 스키마/부모 테이블 (신 6테이블)', () => {
  it(':memory: 생성 → 신 6테이블 존재', () => {
    store = new SqliteStore(':memory:');
    const names = new Set(
      (store as unknown as { db: Database.Database }).db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
        .map((r) => (r as { name: string }).name),
    );
    for (const t of ['place_info', 'camera_info', 'preset_pos', 'slot_setup', 'parking_evnt', 'parking_slot']) {
      expect(names.has(t)).toBe(true);
    }
    // 구 테이블은 없어야 한다(clean-cut).
    for (const t of ['capture_run', 'observation', 'detection', 'aggregated_slot', 'parking_slots', 'floor_roi', 'occupancy', 'centering_slot']) {
      expect(names.has(t)).toBe(false);
    }
  });

  it('upsertPlaceInfo/upsertCameraInfo/upsertPresetPos — PK 충돌 시 갱신(멱등)', () => {
    store = new SqliteStore(':memory:');
    store.upsertPlaceInfo([placeRow()]);
    store.upsertCameraInfo([cameraRow({ password: 'secret', camName: 'C1' })]);
    store.upsertPresetPos([presetRow()]);
    const db = (store as unknown as { db: Database.Database }).db;
    // password 는 store 계층에선 평문 저장(마스킹은 dbRoutes 조회계층 책임).
    expect((db.prepare(`SELECT password, cam_name FROM camera_info WHERE cam_id=1`).get() as { password: string; cam_name: string }))
      .toEqual({ password: 'secret', cam_name: 'C1' });
    // 재-upsert(같은 PK) → 행 증가 없이 갱신.
    store.upsertCameraInfo([cameraRow({ password: 'rotated', camName: 'C1b' })]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM camera_info`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT password FROM camera_info WHERE cam_id=1`).get() as { password: string }).password).toBe('rotated');
  });
});

// ── foreign_keys=ON 실효 ────────────────────────────────────
describe('SqliteStore FK 무결성 (foreign_keys=ON 실효)', () => {
  it('부모(preset_pos) 없는 slot_setup INSERT 거부 → throw + 확정본 미변경(롤백)', () => {
    // preset_pos 는 (1,1)만 시드. (1,9) 는 부모 부재 → FK 위반.
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1 })]);
    expect(store.getSlotSetup()).toHaveLength(1);

    // 부모 없는 (cam1,preset9) 슬롯 삽입 시도 → FK 위반으로 트랜잭션 전체 롤백.
    expect(() => store!.replaceSlotSetup([slotRow({ slotId: 2, presetId: 9, presetSlotIdx: 1 })])).toThrow();
    // 롤백으로 DELETE 도 취소 → 이전 확정본(slotId 1) 보존.
    const after = store.getSlotSetup();
    expect(after).toHaveLength(1);
    expect(after[0].slotId).toBe(1);
  });

  it('foreign_keys PRAGMA 가 실제로 ON', () => {
    store = new SqliteStore(':memory:');
    const fk = (store as unknown as { db: Database.Database }).db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });
});

// ── replaceSlotSetup 트랜잭션 원자성 ────────────────────────
describe('SqliteStore replaceSlotSetup 원자성 (설계 배경 A.3)', () => {
  it('정상 교체 → 전량 반영(멱등 replace)', () => {
    store = seededStore([presetRow({ presetId: 1 }), presetRow({ presetId: 2, sname: 'Preset 2' })]);
    store.replaceSlotSetup([
      slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
      slotRow({ slotId: 2, presetId: 2, presetSlotIdx: 1 }),
    ]);
    expect(store.getSlotSetup()).toHaveLength(2);
    // 더 적은 슬롯으로 교체 → 그 수만 남음(DELETE 후 INSERT).
    store.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 })]);
    const after = store.getSlotSetup();
    expect(after).toHaveLength(1);
    expect(after[0].slotId).toBe(1);
  });

  it('중간 throw(PK 중복) → DELETE 포함 전체 롤백 → 이전 확정본 보존', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 })]);
    // slot_id(PK) 중복을 유발 → 두 번째 INSERT 에서 throw. DELETE 는 이미 실행됐으나 트랜잭션 롤백.
    expect(() =>
      store!.replaceSlotSetup([
        slotRow({ slotId: 5, presetId: 1, presetSlotIdx: 2 }),
        slotRow({ slotId: 5, presetId: 1, presetSlotIdx: 3 }), // PK 5 중복 → throw
      ]),
    ).toThrow();
    // 롤백 → 이전 확정본(slotId 1) 그대로.
    const after = store.getSlotSetup();
    expect(after).toHaveLength(1);
    expect(after[0].slotId).toBe(1);
  });

  it('slot_setup UNIQUE(cam_id,preset_id,preset_slotidx) 위반 거부', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    expect(() =>
      store!.replaceSlotSetup([
        slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
        slotRow({ slotId: 2, presetId: 1, presetSlotIdx: 1 }), // 동일 (1,1,1) → UNIQUE 위반
      ]),
    ).toThrow();
    expect(store.getSlotSetup()).toHaveLength(0); // 롤백(애초에 빈 상태)
  });
});

// ── getSlotSetup: presetKey 파생 · JSON 파싱 · 정렬 ─────────
describe('SqliteStore getSlotSetup (presetKey 파생 · roi/vpd/lpd 파싱)', () => {
  it('presetKey=`${camId}:${presetId}` 파생 + *_json → 객체/배열 복원 + centered boolean', () => {
    store = seededStore([presetRow({ presetId: 2, sname: 'Preset 2' })]);
    store.replaceSlotSetup([
      slotRow({
        slotId: 8, camId: 1, presetId: 2, presetSlotIdx: 6,
        slotRoi: JSON.stringify(roi),
        vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
        lpdObb: JSON.stringify(lpdQuad),
        occupyRange: JSON.stringify(roi),
        pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/c1.jpg',
      }),
    ]);
    const [v] = store.getSlotSetup();
    expect(v.slotId).toBe(8);
    expect(v.presetKey).toBe('1:2'); // 파생필드(뷰어 오버레이 키 정합)
    expect(v.roi).toEqual(roi); // NormalizedPoint[] 복원(객체형)
    expect(v.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect(v.lpd).toEqual(lpdQuad);
    expect(v.occupyRange).toEqual(roi);
    expect(v.centered).toBe(true); // 0/1 → boolean
    expect([v.pan, v.tilt, v.zoom]).toEqual([51.5, 9.3, 14.4]);
    expect(v.img1).toBe('shots/c1.jpg');
  });

  it('null 가변정점 → null 로 복원(미점유 슬롯)', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 })]);
    const [v] = store.getSlotSetup();
    expect(v.vpd).toBeNull();
    expect(v.lpd).toBeNull();
    expect(v.occupyRange).toBeNull();
    expect(v.pan).toBeNull();
    expect(v.centered).toBe(false);
    expect(v.roi).toEqual(roi); // slot_roi 는 NOT NULL — 항상 존재
  });

  it('ORDER BY cam_id, preset_id, preset_slotidx', () => {
    store = seededStore([presetRow({ presetId: 1 }), presetRow({ presetId: 2, sname: 'P2' })]);
    store.replaceSlotSetup([
      slotRow({ slotId: 3, presetId: 2, presetSlotIdx: 1 }),
      slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
      slotRow({ slotId: 2, presetId: 1, presetSlotIdx: 2 }),
    ]);
    expect(store.getSlotSetup().map((r) => r.slotId)).toEqual([1, 2, 3]);
  });
});

// ── upsertSlotCentering: slot_id 키 부분 UPDATE ────────────
describe('SqliteStore upsertSlotCentering (부분 UPDATE · 타 슬롯 불변)', () => {
  const centerRow = (over: Partial<SlotCenteringRow> = {}): SlotCenteringRow => ({
    slotId: 1, pan: 20, tilt: 6, zoom: 12, centered: 1, img1: 'c1.jpg', updatedAt: 'T2', ...over,
  });

  it('slot_id 키로 pan/tilt/zoom/centered/img1/updated_at 만 갱신 — roi/vpd 등 기하 불변', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([
      slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1, vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }) }),
    ]);
    store.upsertSlotCentering([centerRow({ slotId: 1 })]);
    const [v] = store.getSlotSetup();
    expect(v.centered).toBe(true);
    expect([v.pan, v.tilt, v.zoom]).toEqual([20, 6, 12]);
    expect(v.img1).toBe('c1.jpg');
    expect(v.updatedAt).toBe('T2');
    // 기하(roi/vpd)는 센터라이징이 건드리지 않는다.
    expect(v.roi).toEqual(roi);
    expect(v.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });

  it('부분 캘리브레이션: 대상 슬롯만 갱신, 타 슬롯 전멸 금지(불변)', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([
      slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1, updatedAt: 'T-first' }),
      slotRow({ slotId: 2, presetId: 1, presetSlotIdx: 2, updatedAt: 'T-first' }),
    ]);
    // 슬롯1만 센터라이징 갱신.
    store.upsertSlotCentering([centerRow({ slotId: 1, updatedAt: 'T-second' })]);
    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(2); // ★ 타 슬롯 전멸 금지
    const s1 = rows.find((r) => r.slotId === 1)!;
    const s2 = rows.find((r) => r.slotId === 2)!;
    expect(s1.centered).toBe(true);
    expect(s1.updatedAt).toBe('T-second');
    expect(s2.centered).toBe(false); // ★ 타 슬롯 불변
    expect(s2.pan).toBeNull();
    expect(s2.updatedAt).toBe('T-first');
  });

  it('미존재 slot_id → UPDATE 0건(조용히 무시, throw 없음)', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 })]);
    expect(() => store!.upsertSlotCentering([centerRow({ slotId: 999 })])).not.toThrow();
    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(1);
    expect(rows[0].centered).toBe(false); // slotId 1 은 미갱신
  });
});

// ── upsertSlotLpd: slot_id 키 부분 UPDATE(wipe-safety 봉인) ──
describe('SqliteStore upsertSlotLpd (부분 UPDATE · 타 컬럼·타 슬롯 불변)', () => {
  const lpdRow = (over: Partial<SlotLpdRow> = {}): SlotLpdRow => ({
    slotId: 1, lpdObb: JSON.stringify(lpdQuad), updatedAt: 'T-lpd', ...over,
  });

  /** 검출·센터링·기하 컬럼이 전부 채워진 슬롯을 시드(변경 격리 검증용 fixture). */
  function seedEnriched(): SqliteStore {
    const s = seededStore([presetRow({ presetId: 1 })]);
    s.replaceSlotSetup([
      slotRow({
        slotId: 1, presetId: 1, presetSlotIdx: 1,
        vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
        lpdObb: null, // 검출 실패로 비어 있던 lpd → discovery 가 채운다
        occupyRange: JSON.stringify(roi),
        pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/c1.jpg',
        slot3dFrontCenter: JSON.stringify({ x: 0.4, y: 0.55 }),
        updatedAt: 'T-orig',
      }),
      slotRow({ slotId: 2, presetId: 1, presetSlotIdx: 2, updatedAt: 'T-orig' }),
    ]);
    return s;
  }

  it('대상 슬롯의 lpd_obb·updated_at 만 갱신 — vpd/occupy/ptz/센터링/slot_roi/front_center 전부 불변', () => {
    store = seedEnriched();
    const newQuad: NormalizedQuad = [
      { x: 0.61, y: 0.62 }, { x: 0.67, y: 0.61 }, { x: 0.68, y: 0.65 }, { x: 0.62, y: 0.66 },
    ];
    store.upsertSlotLpd([lpdRow({ slotId: 1, lpdObb: JSON.stringify(newQuad), updatedAt: 'T-lpd' })]);
    const [v] = store.getSlotSetup();
    // 갱신된 것.
    expect(v.lpd).toEqual(newQuad);
    expect(v.updatedAt).toBe('T-lpd');
    // ★ 그 외 컬럼 전부 불변(wipe-safety).
    expect(v.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect(v.occupyRange).toEqual(roi);
    expect([v.pan, v.tilt, v.zoom]).toEqual([51.5, 9.3, 14.4]);
    expect(v.centered).toBe(true);
    expect(v.img1).toBe('shots/c1.jpg');
    expect(v.slot3dFrontCenter).toEqual({ x: 0.4, y: 0.55 });
    expect(v.roi).toEqual(roi);
  });

  it('부분 갱신: 대상 슬롯만 lpd 채움, 타 슬롯 전멸/변경 금지', () => {
    store = seedEnriched();
    store.upsertSlotLpd([lpdRow({ slotId: 1, updatedAt: 'T-lpd' })]);
    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(2); // ★ DELETE+INSERT 아님 — 행 보존
    const s1 = rows.find((r) => r.slotId === 1)!;
    const s2 = rows.find((r) => r.slotId === 2)!;
    expect(s1.lpd).toEqual(lpdQuad);
    expect(s1.updatedAt).toBe('T-lpd');
    // 타 슬롯(2) 완전 불변.
    expect(s2.lpd).toBeNull();
    expect(s2.updatedAt).toBe('T-orig');
    expect(s2.vpd).toBeNull();
  });

  it('lpdObb=null 전달 → 해당 슬롯 lpd 를 null 로 클리어(updated_at 만 함께)', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1, lpdObb: JSON.stringify(lpdQuad) })]);
    store.upsertSlotLpd([lpdRow({ slotId: 1, lpdObb: null, updatedAt: 'T-clr' })]);
    const [v] = store.getSlotSetup();
    expect(v.lpd).toBeNull();
    expect(v.updatedAt).toBe('T-clr');
  });

  it('미존재 slot_id → 조용히 무시(throw 없음, 타 슬롯 불변)', () => {
    store = seedEnriched();
    expect(() => store!.upsertSlotLpd([lpdRow({ slotId: 999 })])).not.toThrow();
    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.slotId === 1)!.lpd).toBeNull(); // slot1 미갱신(원래 null)
  });

  it('여러 행 트랜잭션 일괄 갱신', () => {
    store = seedEnriched();
    store.upsertSlotLpd([
      lpdRow({ slotId: 1, lpdObb: JSON.stringify(lpdQuad), updatedAt: 'T-a' }),
      lpdRow({ slotId: 2, lpdObb: JSON.stringify(lpdQuad), updatedAt: 'T-b' }),
    ]);
    const rows = store.getSlotSetup();
    expect(rows.find((r) => r.slotId === 1)!.lpd).toEqual(lpdQuad);
    expect(rows.find((r) => r.slotId === 2)!.lpd).toEqual(lpdQuad);
    expect(rows.find((r) => r.slotId === 2)!.updatedAt).toBe('T-b');
  });

  // ── occupy_range 조건부 부분 UPDATE(이터레이션 2, plan §I) ──
  const newOccupy: NormalizedQuad = [
    { x: 0.60, y: 0.60 }, { x: 0.72, y: 0.60 }, { x: 0.72, y: 0.70 }, { x: 0.60, y: 0.70 },
  ];

  it('occupyRange 제공 행 → occupy_range 갱신(+lpd_obb) · 타 컬럼(ptz/센터링/roi/front_center) 불변', () => {
    store = seedEnriched(); // slot1 occupy_range = roi(기존값)
    const newQuad: NormalizedQuad = [
      { x: 0.61, y: 0.62 }, { x: 0.67, y: 0.61 }, { x: 0.68, y: 0.65 }, { x: 0.62, y: 0.66 },
    ];
    store.upsertSlotLpd([
      { slotId: 1, lpdObb: JSON.stringify(newQuad), occupyRange: JSON.stringify(newOccupy), updatedAt: 'T-occ' },
    ]);
    const [v] = store.getSlotSetup();
    // ★ occupy_range 가 discovery 판 quad 로 갱신됨.
    expect(v.occupyRange).toEqual(newOccupy);
    expect(v.lpd).toEqual(newQuad);
    expect(v.updatedAt).toBe('T-occ');
    // 그 외 컬럼 불변(wipe-safety).
    expect(v.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
    expect([v.pan, v.tilt, v.zoom]).toEqual([51.5, 9.3, 14.4]);
    expect(v.centered).toBe(true);
    expect(v.img1).toBe('shots/c1.jpg');
    expect(v.slot3dFrontCenter).toEqual({ x: 0.4, y: 0.55 });
    expect(v.roi).toEqual(roi);
  });

  it('occupyRange 미제공(undefined) 행 → occupy_range 보존(무접촉) · lpd 만 갱신', () => {
    // ★ wipe-safety 불변: 수동 /capture/slots/lpd 경로(occupyRange 미전달)가 discovery 점유영역을 파괴하지 않는다.
    store = seedEnriched(); // slot1 occupy_range = roi
    store.upsertSlotLpd([lpdRow({ slotId: 1, lpdObb: JSON.stringify(lpdQuad), updatedAt: 'T-noocc' })]);
    const [v] = store.getSlotSetup();
    expect(v.lpd).toEqual(lpdQuad); // lpd 는 갱신
    expect(v.occupyRange).toEqual(roi); // ★ occupy_range 는 기존값 그대로 보존(wipe 없음)
    expect(v.updatedAt).toBe('T-noocc');
  });

  it('occupyRange=null 명시 제공 → occupy_range 를 null 로 클리어(undefined 와 구분)', () => {
    store = seedEnriched(); // slot1 occupy_range = roi
    store.upsertSlotLpd([
      { slotId: 1, lpdObb: JSON.stringify(lpdQuad), occupyRange: null, updatedAt: 'T-nullocc' },
    ]);
    const [v] = store.getSlotSetup();
    expect(v.occupyRange).toBeNull(); // 명시 null → 클리어(제공됨이므로 무접촉 아님)
  });
});

// ── 파일경로 · 재오픈 ───────────────────────────────────────
describe('SqliteStore 파일경로·스키마 재생성', () => {
  it('중첩 디렉터리 자동 생성 + 재오픈 시 IF NOT EXISTS 무해(데이터 보존)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-'));
    try {
      const dbPath = join(dir, 'nested', 'setting.sqlite');
      const s1 = new SqliteStore(dbPath);
      expect(existsSync(join(dir, 'nested'))).toBe(true);
      s1.upsertPlaceInfo([placeRow()]);
      s1.upsertCameraInfo([cameraRow()]);
      s1.upsertPresetPos([presetRow()]);
      s1.replaceSlotSetup([slotRow({ slotId: 1, presetId: 1, presetSlotIdx: 1 })]);
      s1.close();
      // 재오픈 → ensureSchema IF NOT EXISTS 재생성 무해, 기존 데이터 보존.
      const s2 = new SqliteStore(dbPath);
      store = s2;
      expect(s2.getSlotSetup()).toHaveLength(1);
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
