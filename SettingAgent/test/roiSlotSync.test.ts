import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { syncRoiToDb, diffRoiSlots } from '../src/capture/roiSlotSync.js';
import { buildSlots } from '../src/capture/roiDbLoad.js';
import { stringify5 } from '../src/util/round.js';
import type { CameraInfoRow, PlaceInfoRow, PresetInfoRow, SlotSetupRow } from '../src/capture/types.js';

/**
 * `src/capture/roiSlotSync.ts` — ROIMaker 저장 경로(정본 파일 → slot_setup 차등 동기).
 * 설계서 §9.2.
 *
 * ★ 이 파일의 최우선 명제: **기하만 갱신하고 검출·점유·센터링은 한 바이트도 건드리지 않는다.**
 *   (memory: finalize-slotsetup-wipe-fragility — replaceSlotSetup 의 DELETE+INSERT 파괴를 피하려고 만든 경로다.)
 *
 * 임시 DB 는 `:memory:`, 임시 파일은 os.tmpdir() 아래에만. 실 data/ 는 쓰지 않는다.
 */

const NOW = '2026-07-28T00:00:00.000Z';
const OLD = 'T-old';

let store: SqliteStore | undefined;
let tmp: string | undefined;
afterEach(() => {
  if (store) { store.close(); store = undefined; }
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; }
});

function newStore(): SqliteStore {
  store = new SqliteStore(':memory:');
  return store;
}
function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'roisync-'));
  return tmp;
}

/** 픽셀 사각형(1920×1080 기준). */
function pxRect(x: number, y: number, w: number, h: number): number[][] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** cam1 에 preset 1·2, 각 2면/1면인 PtzCamRoi 픽스처. */
function roiFixture(spacesByPreset: Record<number, Array<{ idx: number; points: number[][] }>>) {
  return {
    cameras: [
      {
        camera: { cam_id: 1, imageWidth: 1920, imageHeight: 1080 },
        presets: Object.entries(spacesByPreset).map(([presetIdx, parking_spaces]) => ({
          preset_idx: Number(presetIdx),
          pan: 10,
          tilt: 5,
          zoom: 2,
          parking_spaces,
        })),
      },
    ],
  };
}

const BASE_FIXTURE = roiFixture({
  1: [
    { idx: 1, points: pxRect(100, 100, 200, 200) },
    { idx: 2, points: pxRect(400, 100, 200, 200) },
  ],
  2: [{ idx: 3, points: pxRect(100, 600, 200, 200) }],
});

function writeRoi(dir: string, json: unknown, name = 'PtzCamRoi.json'): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(json, null, 2), 'utf-8');
  return path;
}

/** FK 부모 + 파일과 동일한 slot_setup 을 심고, enrichment(검출·점유·센터링)를 채워 넣는다. */
function seedFromFixture(s: SqliteStore, fixture: unknown): SlotSetupRow[] {
  const place: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
  const camera: CameraInfoRow = {
    camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
    camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: OLD,
  };
  const presets: PresetInfoRow[] = [1, 2].map((presetId) => ({
    camId: 1, presetId, presetName: `P${presetId}`, placeId: 1, pan: 10, tilt: 5, zoom: 2, updatedAt: OLD,
  }));
  s.upsertPlaceInfo([place]);
  s.upsertCameraInfo([camera]);
  s.upsertPresetInfo(presets);

  const rows = buildSlots(fixture, OLD).map((r) => ({
    ...r,
    vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
    lpdObb: JSON.stringify([{ x: 0.31, y: 0.36 }, { x: 0.35, y: 0.36 }, { x: 0.35, y: 0.38 }, { x: 0.31, y: 0.38 }]),
    occupyRange: JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }, { x: 0.2, y: 0.6 }]),
    pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: `shots/s${r.slotId}.jpg`,
    slot3dFrontCenter: JSON.stringify({ x: 0.4, y: 0.45 }),
  }));
  s.replaceSlotSetup(rows);
  return rows;
}

/** 검출·점유·센터링 컬럼만 뽑아 비교용 지문 생성. */
function enrichmentFingerprint(s: SqliteStore) {
  return s.getSlotSetup().map((v) => ({
    slotId: v.slotId,
    vpd: JSON.stringify(v.vpd),
    lpd: JSON.stringify(v.lpd),
    occupyRange: JSON.stringify(v.occupyRange),
    pan: v.pan, tilt: v.tilt, zoom: v.zoom,
    centered: v.centered, img1: v.img1,
    slot3dFrontCenter: JSON.stringify(v.slot3dFrontCenter),
  }));
}

describe('syncRoiToDb — 기하만 갱신(비파괴)', () => {
  it('1. 폴리곤 좌표 변경 → slot_roi 만 갱신, 검출·점유·센터링은 전부 보존', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const before = enrichmentFingerprint(s);

    // #1 의 좌표만 옮긴 파일을 쓴다.
    const moved = roiFixture({
      1: [
        { idx: 1, points: pxRect(150, 150, 200, 200) },
        { idx: 2, points: pxRect(400, 100, 200, 200) },
      ],
      2: [{ idx: 3, points: pxRect(100, 600, 200, 200) }],
    });
    const res = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, moved), now: NOW });

    expect(res.ok).toBe(true);
    expect(res.updates).toBe(1);
    expect(res.inserts).toBe(0);
    expect(res.unchanged).toBe(2);
    expect(res.orphans).toEqual([]);

    const after = s.getSlotSetup();
    expect(after).toHaveLength(3); // 행 수 불변(삭제 없음)
    // 영속화는 소수 5자리(stringify5 규약) — 150/1920=0.078125 → 0.07813.
    expect(after.find((v) => v.slotId === 1)?.roi[0]).toEqual({ x: 0.07813, y: 0.13889 });
    // ★ 핵심: enrichment 전 컬럼 동일.
    expect(enrichmentFingerprint(s)).toEqual(before);
    // updated_at 은 갱신된 행만 바뀐다.
    expect(after.find((v) => v.slotId === 1)?.updatedAt).toBe(NOW);
    expect(after.find((v) => v.slotId === 2)?.updatedAt).toBe(OLD);
  });

  it('2. 신규 1건 append → INSERT 1행, 기존 행 무변경', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const before = enrichmentFingerprint(s);

    const added = roiFixture({
      1: [
        { idx: 1, points: pxRect(100, 100, 200, 200) },
        { idx: 2, points: pxRect(400, 100, 200, 200) },
        { idx: 4, points: pxRect(700, 100, 200, 200) }, // 신규 = 전역 N+1
      ],
      2: [{ idx: 3, points: pxRect(100, 600, 200, 200) }],
    });
    const res = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, added), now: NOW });

    expect(res.ok).toBe(true);
    expect(res.inserts).toBe(1);
    expect(res.updates).toBe(0);
    expect(res.unchanged).toBe(3);

    const after = s.getSlotSetup();
    expect(after).toHaveLength(4);
    const fresh = after.find((v) => v.slotId === 4);
    expect(fresh).toMatchObject({ camId: 1, presetId: 1, presetSlotIdx: 3, centered: false });
    expect(fresh?.vpd).toBeNull(); // 신규는 enrichment 없음.
    expect(fresh?.roi).toHaveLength(4);
    // 기존 3행의 enrichment 는 그대로.
    expect(enrichmentFingerprint(s).filter((r) => r.slotId !== 4)).toEqual(before);
  });

  it('삭제(마스터 지시 #13) = points 비우기 → slot_roi 만 "[]" 로, 행·검출·센터링 보존', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const before = enrichmentFingerprint(s);

    const emptied = roiFixture({
      1: [
        { idx: 1, points: [] }, // ROI 만 지운 슬롯
        { idx: 2, points: pxRect(400, 100, 200, 200) },
      ],
      2: [{ idx: 3, points: pxRect(100, 600, 200, 200) }],
    });
    const res = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, emptied), now: NOW });

    expect(res.ok).toBe(true);
    expect(res.updates).toBe(1);
    const after = s.getSlotSetup();
    expect(after).toHaveLength(3); // ★ 행이 사라지지 않는다.
    expect(after.find((v) => v.slotId === 1)?.roi).toEqual([]);
    expect(enrichmentFingerprint(s)).toEqual(before); // 검출·센터링 보존.
  });

  it('3. DB 에만 있는 행은 삭제하지 않고 orphans 로 보고한다', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);

    // 파일에서 preset2 를 통째로 뺀다(= 슬롯 #3 이 파일에 없음).
    const shrunk = roiFixture({
      1: [
        { idx: 1, points: pxRect(100, 100, 200, 200) },
        { idx: 2, points: pxRect(400, 100, 200, 200) },
      ],
    });
    const res = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, shrunk), now: NOW });

    expect(res.ok).toBe(true);
    expect(res.orphans).toHaveLength(1);
    expect(res.orphans[0]).toMatchObject({ slotId: 3, camId: 1, presetId: 2 });
    expect(res.issues.join()).toMatch(/자동 삭제하지 않음/);
    expect(s.getSlotSetup()).toHaveLength(3); // ★ 그대로 살아 있다.
  });

  it('4. slot_id 아이덴티티 불일치 → 0건 반영 + ok:false', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const before = s.getSlotSetup();

    // 같은 자리(1:1#1)에 다른 전역번호가 온 파일 — 외부에서 행 제거·재부여가 일어난 상태의 재현.
    // ★ idx 를 9/8/7 같은 '비순열'로 주면 buildSlots 의 normalizeGlobalIdx 가 1..N 으로 되돌려
    //   불일치가 발생하지 않는다(1차 방어선). 불일치를 만들려면 **유효한 순열이면서 배치가 다른** 경우여야 한다.
    const renumbered = roiFixture({
      1: [
        { idx: 2, points: pxRect(100, 100, 200, 200) }, // 1↔2 가 자리 교환된 상태
        { idx: 1, points: pxRect(400, 100, 200, 200) },
      ],
      2: [{ idx: 3, points: pxRect(100, 600, 200, 200) }],
    });
    const res = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, renumbered), now: NOW });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/아이덴티티 불일치/);
    expect(res.updates + res.inserts).toBe(0);
    expect(s.getSlotSetup()).toEqual(before); // DB 완전 무변경.
  });

  it('5. 파일 없음 / 파싱 실패 / 주차면 0건 → DB 무변경 + ok:false', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const before = s.getSlotSetup();

    const missing = syncRoiToDb(s, { placeRoiFile: join(dir, 'nope.json'), now: NOW });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/파일 없음/);

    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{ not json', 'utf-8');
    const bad = syncRoiToDb(s, { placeRoiFile: badPath, now: NOW });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/파싱 실패/);

    const empty = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, { cameras: [] }, 'empty.json'), now: NOW });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/유효한 주차면 없음/);

    expect(s.getSlotSetup()).toEqual(before);
  });

  it('6. 멱등: 같은 파일로 두 번 호출하면 두 번째는 updates 0', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const moved = roiFixture({
      1: [
        { idx: 1, points: pxRect(150, 150, 200, 200) },
        { idx: 2, points: pxRect(400, 100, 200, 200) },
      ],
      2: [{ idx: 3, points: pxRect(100, 600, 200, 200) }],
    });
    const file = writeRoi(dir, moved);

    expect(syncRoiToDb(s, { placeRoiFile: file, now: NOW }).updates).toBe(1);
    const second = syncRoiToDb(s, { placeRoiFile: file, now: NOW });
    expect(second.updates).toBe(0);
    expect(second.inserts).toBe(0);
    expect(second.unchanged).toBe(3);
  });

  it('INSERT 가 PK 충돌로 실패하면 전량 롤백되고 기존 행은 한 줄도 사라지지 않는다', () => {
    const s = newStore();
    const dir = newTmp();
    seedFromFixture(s, BASE_FIXTURE);
    const before = s.getSlotSetup();
    // 파일이 전혀 다른 프리셋(1:3)만 담고 있는 경우 — 그 슬롯의 전역번호 1 은 이미 (1:1#1) 이 쓰고 있다.
    // → 신규 INSERT 가 PK(slot_id) 충돌 → 트랜잭션 롤백 → ok:false. **기존 3행은 그대로.**
    s.upsertPresetInfo([{ camId: 1, presetId: 3, presetName: 'P3', placeId: 1, pan: 0, tilt: 0, zoom: 1, updatedAt: OLD }]);
    const other = roiFixture({ 3: [{ idx: 1, points: pxRect(100, 100, 200, 200) }] });
    const res = syncRoiToDb(s, { placeRoiFile: writeRoi(dir, other), now: NOW });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/DB 쓰기 실패/);
    expect(res.updates + res.inserts).toBe(0);
    expect(s.getSlotSetup()).toEqual(before); // ★ 파괴 0.
  });
});

describe('diffRoiSlots — 순수 차등 계산', () => {
  const row = (slotId: number, presetSlotIdx: number, roi: Array<{ x: number; y: number }>): SlotSetupRow => ({
    slotId, camId: 1, presetId: 1, presetSlotIdx, slotRoi: stringify5(roi),
    vpdBbox: null, lpdObb: null, occupyRange: null, pan: null, tilt: null, zoom: null,
    centered: 0, img1: null, slot3dFrontCenter: null, updatedAt: NOW,
  });
  const quad = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }];

  it('빈 입력끼리는 전부 0', () => {
    expect(diffRoiSlots([], [])).toEqual({ updates: [], inserts: [], orphans: [], mismatches: [], unchanged: 0 });
  });

  it('DB 가 비어 있으면 전부 insert(update 0)', () => {
    const d = diffRoiSlots([row(1, 1, quad)], []);
    expect(d.inserts).toHaveLength(1);
    expect(d.updates).toHaveLength(0);
  });

  it('stringify5 동치면 unchanged — 소수 6자리 이하 차이는 갱신을 유발하지 않는다', () => {
    const expected = [row(1, 1, [{ x: 0.123456789, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }])];
    const current = [{
      slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
      roi: [{ x: 0.12346, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }],
      vpd: null, lpd: null, occupyRange: null, pan: null, tilt: null, zoom: null,
      centered: false, img1: null, slot3dFrontCenter: null, updatedAt: NOW,
    }];
    expect(diffRoiSlots(expected, current).unchanged).toBe(1);
  });
});
