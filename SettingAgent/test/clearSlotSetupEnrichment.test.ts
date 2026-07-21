import { describe, it, expect, afterEach } from 'vitest';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type {
  CameraInfoRow,
  PlaceInfoRow,
  PresetPosRow,
  SlotSetupRow,
} from '../src/capture/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): SqliteStore.clearSlotSetupEnrichment (신규 '검출·센터링 초기화' 버튼의 서버 근거).
 * 설계서 01/구현 02: slot_setup 의 vpd/lpd/occupy/pan/tilt/zoom/centered/img1 만 비우고
 * slot_roi(바닥 geometry)·행 자체·slotId 는 보존해야 한다(초기화 ≠ 삭제). 반환=초기화 행수.
 */

let store: SqliteStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

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
const roi2: NormalizedPoint[] = [
  { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.6 }, { x: 0.8, y: 0.8 }, { x: 0.6, y: 0.8 },
];
const lpdQuad: NormalizedQuad = [
  { x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 },
];

/** vpd/lpd/occupy/ptz/centered/img1 이 모두 채워진 '풍부한' 슬롯 행. */
const enrichedSlot = (over: Partial<SlotSetupRow> = {}): SlotSetupRow => ({
  slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
  slotRoi: JSON.stringify(roi),
  vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
  lpdObb: JSON.stringify(lpdQuad),
  occupyRange: JSON.stringify(roi),
  pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/c1.jpg', slot3dFrontCenter: null, updatedAt: 'T-old', ...over,
});

/** place/camera/preset(FK 부모) 시드 :memory: 스토어. */
function seededStore(presets: PresetPosRow[] = [presetRow()]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([placeRow()]);
  s.upsertCameraInfo([cameraRow()]);
  s.upsertPresetPos(presets);
  return s;
}

describe('SqliteStore.clearSlotSetupEnrichment (검출·센터링 초기화)', () => {
  it('풍부한 슬롯 → clear 후 vpd/lpd/occupy/ptz/centered/img1 전부 null/false, roi·행·slotId 보존', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([enrichedSlot({ slotId: 7, presetId: 1, presetSlotIdx: 1 })]);

    // 사전 확인: 실제로 채워진 상태에서 시작(빈 값 초기화라는 위양성 방지).
    const before = store.getSlotSetup()[0];
    expect(before.vpd).not.toBeNull();
    expect(before.lpd).not.toBeNull();
    expect(before.occupyRange).not.toBeNull();
    expect(before.pan).toBe(51.5);
    expect(before.centered).toBe(true);
    expect(before.img1).toBe('shots/c1.jpg');

    const changes = store.clearSlotSetupEnrichment('T-new');
    expect(changes).toBe(1); // 반환 = 초기화 행수

    const after = store.getSlotSetup();
    expect(after).toHaveLength(1); // ★ 행 삭제 아님
    const v = after[0];
    // 초기화 대상 8필드.
    expect(v.vpd).toBeNull();
    expect(v.lpd).toBeNull();
    expect(v.occupyRange).toBeNull();
    expect(v.pan).toBeNull();
    expect(v.tilt).toBeNull();
    expect(v.zoom).toBeNull();
    expect(v.centered).toBe(false);
    expect(v.img1).toBeNull();
    // ★ 보존: slot_roi(바닥 geometry)·slotId·행 식별자.
    expect(v.roi).toEqual(roi);
    expect(v.slotId).toBe(7);
    expect(v.presetKey).toBe('1:1');
    expect(v.presetSlotIdx).toBe(1);
    // updated_at 갱신.
    expect(v.updatedAt).toBe('T-new');
  });

  it('changes = 전체 행수(여러 슬롯 전량 초기화), 각 행 roi 개별 보존', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([
      enrichedSlot({ slotId: 1, presetId: 1, presetSlotIdx: 1, slotRoi: JSON.stringify(roi) }),
      enrichedSlot({ slotId: 2, presetId: 1, presetSlotIdx: 2, slotRoi: JSON.stringify(roi2) }),
      enrichedSlot({ slotId: 3, presetId: 1, presetSlotIdx: 3, slotRoi: JSON.stringify(roi) }),
    ]);
    const changes = store.clearSlotSetupEnrichment('T-new');
    expect(changes).toBe(3); // ★ 반환 = 행수

    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(3);
    // 전 행 enrichment null + centered false.
    for (const v of rows) {
      expect(v.vpd).toBeNull();
      expect(v.lpd).toBeNull();
      expect(v.occupyRange).toBeNull();
      expect(v.pan).toBeNull();
      expect(v.tilt).toBeNull();
      expect(v.zoom).toBeNull();
      expect(v.centered).toBe(false);
      expect(v.img1).toBeNull();
    }
    // 각 슬롯 고유 roi 보존(초기화가 geometry 를 동일값으로 덮어쓰지 않음).
    expect(rows.find((r) => r.slotId === 1)!.roi).toEqual(roi);
    expect(rows.find((r) => r.slotId === 2)!.roi).toEqual(roi2);
    expect(rows.find((r) => r.slotId === 3)!.roi).toEqual(roi);
  });

  it('빈 slot_setup → changes 0(throw 없음)', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    let changes = -1;
    expect(() => { changes = store!.clearSlotSetupEnrichment('T-new'); }).not.toThrow();
    expect(changes).toBe(0);
    expect(store.getSlotSetup()).toHaveLength(0);
  });

  it('일부 컬럼만 채워진 슬롯(vpd 만) → clear 후에도 정합(부분 채움 안전)', () => {
    store = seededStore([presetRow({ presetId: 1 })]);
    store.replaceSlotSetup([
      enrichedSlot({
        slotId: 1, presetId: 1, presetSlotIdx: 1,
        lpdObb: null, occupyRange: null, pan: null, tilt: null, zoom: null, centered: 0, img1: null,
      }),
    ]);
    const changes = store.clearSlotSetupEnrichment('T-new');
    expect(changes).toBe(1);
    const v = store.getSlotSetup()[0];
    expect(v.vpd).toBeNull();
    expect(v.centered).toBe(false);
    expect(v.roi).toEqual(roi); // roi 보존
  });
});
