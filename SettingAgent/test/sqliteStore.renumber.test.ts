import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetInfoRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa): SqliteStore.renumberSlotIds (전역번호 재번호 — slot_id 라벨만 순열 이동).
 * 설계서 §2: 트랜잭션 DELETE+re-INSERT 전 컬럼 보존, round5/updated_at 재작성 금지,
 * idMap 미커버·new 중복·FK 참조행 방어, changed 반환.
 */

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
};
const presetRow = (over: Partial<PresetInfoRow> = {}): PresetInfoRow => ({
  camId: 1, presetId: 1, presetName: 'Preset 1', placeId: 1, pan: 10, tilt: 5, zoom: 2, updatedAt: 'T', ...over,
});

const roi: NormalizedPoint[] = [
  { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 },
];
const lpdQuad: NormalizedQuad = [
  { x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 },
];
const slot = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi),
  vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
  lpdObb: JSON.stringify(lpdQuad),
  occupyRange: JSON.stringify(roi),
  pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/c1.jpg', slot3dFrontCenter: null, updatedAt: 'T-old', ...over,
});

function seededStore(presets: PresetInfoRow[] = [presetRow()]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([placeRow]);
  s.upsertCameraInfo([cameraRow]);
  s.upsertPresetInfo(presets);
  return s;
}

describe('SqliteStore.renumberSlotIds (전역번호 재번호)', () => {
  it('순열 swap 후 slotId=new 이고 각 물리행의 전 컬럼 보존(라벨만 이동)', () => {
    store = seededStore([presetRow({ presetId: 1 }), presetRow({ presetId: 2 })]);
    store.replaceSlotSetup([
      slot({ slotId: 1, presetId: 1, presetSlotIdx: 1, pan: 10.11111, tilt: 1.1, zoom: 3.3, img1: 'a.jpg' }),
      slot({ slotId: 2, presetId: 2, presetSlotIdx: 1, pan: 20.22222, tilt: 2.2, zoom: 4.4, img1: 'b.jpg' }),
    ]);
    const before = store.getSlotSetup();
    const byPreset1Before = before.find((r) => r.presetKey === '1:1')!;
    const byPreset2Before = before.find((r) => r.presetKey === '1:2')!;

    const { changed } = store.renumberSlotIds(new Map([[1, 2], [2, 1]]));
    expect(changed).toBe(2);

    const after = store.getSlotSetup();
    expect(after.map((r) => r.slotId).sort((a, b) => a - b)).toEqual([1, 2]);

    // 물리 슬롯(cam/preset)별로 데이터가 그대로이고 slotId 라벨만 바뀌었는지 확인.
    const byPreset1After = after.find((r) => r.presetKey === '1:1')!;
    const byPreset2After = after.find((r) => r.presetKey === '1:2')!;
    expect(byPreset1After.slotId).toBe(2); // 1:1 물리행은 new id 2
    expect(byPreset2After.slotId).toBe(1); // 1:2 물리행은 new id 1
    // 전 컬럼 보존(라벨 제외).
    for (const [b, a] of [[byPreset1Before, byPreset1After], [byPreset2Before, byPreset2After]] as const) {
      expect(a.camId).toBe(b.camId);
      expect(a.presetId).toBe(b.presetId);
      expect(a.presetSlotIdx).toBe(b.presetSlotIdx);
      expect(a.roi).toEqual(b.roi);
      expect(a.vpd).toEqual(b.vpd);
      expect(a.lpd).toEqual(b.lpd);
      expect(a.occupyRange).toEqual(b.occupyRange);
      expect(a.pan).toBe(b.pan);
      expect(a.tilt).toBe(b.tilt);
      expect(a.zoom).toBe(b.zoom);
      expect(a.centered).toBe(b.centered);
      expect(a.img1).toBe(b.img1);
      expect(a.updatedAt).toBe(b.updatedAt); // ★ updated_at 재작성 안 함
    }
  });

  it('round5 재적용 안 함 — 이미 저장된 원시값 그대로 재삽입', () => {
    // replaceSlotSetup 이 이미 round5 적용해 저장한 값이 재번호로 추가 변형되지 않는지.
    store = seededStore();
    store.replaceSlotSetup([slot({ slotId: 5, pan: 12.34567, tilt: 1.0, zoom: 2.0 })]);
    const panBefore = store.getSlotSetup()[0].pan;
    store.renumberSlotIds(new Map([[5, 1]]));
    expect(store.getSlotSetup()[0].pan).toBe(panBefore);
  });

  it('idMap 미커버 slot_id → throw & DB 무변경(롤백)', () => {
    store = seededStore();
    store.replaceSlotSetup([slot({ slotId: 1, presetSlotIdx: 1 })]);
    expect(() => store!.renumberSlotIds(new Map([[99, 1]]))).toThrow();
    expect(store.getSlotSetup().map((r) => r.slotId)).toEqual([1]); // 무변경
  });

  it('new id 중복 → throw & DB 무변경', () => {
    store = seededStore([presetRow({ presetId: 1 }), presetRow({ presetId: 2 })]);
    store.replaceSlotSetup([
      slot({ slotId: 1, presetId: 1, presetSlotIdx: 1 }),
      slot({ slotId: 2, presetId: 2, presetSlotIdx: 1 }),
    ]);
    expect(() => store!.renumberSlotIds(new Map([[1, 3], [2, 3]]))).toThrow();
    expect(store.getSlotSetup().map((r) => r.slotId).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('parking_evnt 참조행 존재 → throw & DB 무변경(FK 보호)', () => {
    store = seededStore();
    store.replaceSlotSetup([slot({ slotId: 1, presetSlotIdx: 1 })]);
    // 실제 store 의 db 에 parking_evnt 1행 주입(writer 미작성 테이블 — 방어 카운트 검증).
    (store as unknown as { db: Database.Database }).db
      .prepare(`INSERT INTO parking_evnt (slot_id, is_occupy, update_time) VALUES (1, 0, 'T')`)
      .run();
    expect(() => store!.renumberSlotIds(new Map([[1, 1]]))).toThrow(/not empty/);
    expect(store.getSlotSetup().map((r) => r.slotId)).toEqual([1]); // 무변경
  });
});
