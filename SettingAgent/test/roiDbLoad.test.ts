import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { loadRoiIntoDb, buildSlots, loadSetupTargetsFromRoi } from '../src/capture/roiDbLoad.js';
import type { CameraInfoRow, PlaceInfoRow, PresetPosRow, SlotSetupRow } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): `src/capture/roiDbLoad.ts` — PtzCamRoi.json → DB slot_setup 전량 재구성.
 * 설계서 01_architect_plan.md "검증(qa)" 1~3번.
 *
 * ★ 최우선 회귀 가드: 실패 경로(파일 없음/빈 cameras/파싱 실패/FK 잔여 0건)에서
 *   기존 slot_setup 이 **한 행도 사라지지 않아야** 한다(memory: finalize-slotsetup-wipe-fragility).
 *
 * 임시 DB 는 `:memory:`, 임시 입력 파일은 os.tmpdir() 아래에만 만든다.
 * 실제 `data/setting.sqlite` 는 절대 열지 않는다(읽기 대상은 data/Place01/PtzCamRoi.json 뿐).
 */

const REAL_ROI = resolve(__dirname, '../data/Place01/PtzCamRoi.json');
const REAL_CAMERAPOS = resolve(__dirname, '../config/camerapos.json');
const NOW = '2026-07-22T00:00:00.000Z';

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
  tmp = mkdtempSync(join(tmpdir(), 'roidbload-'));
  return tmp;
}

/** 실제 ROI 파일의 모든 (cam,preset) 을 커버하는 camerapos 픽스처 생성(FK 부모 확보). */
function cameraposCoveringAll(roiPath: string, dir: string): string {
  const raw = JSON.parse(readFileSync(roiPath, 'utf-8')) as {
    cameras: Array<{ camera: { cam_id: number }; presets: Array<{ preset_idx: number }> }>;
  };
  const datas = raw.cameras.flatMap((c) =>
    c.presets.map((p) => ({ cam_id: c.camera.cam_id, preset_id: p.preset_idx, sname: `P${p.preset_idx}`, pan: 0, tilt: 0, zoom: 1 })),
  );
  const path = join(dir, 'camerapos-all.json');
  writeFileSync(path, JSON.stringify({ datas: [{ datas }] }));
  return path;
}

// ── 기존 데이터 시드(파괴 여부 판정용) ──────────────────────
const placeRow: PlaceInfoRow = { placeId: 1, placeName: 'Place01' };
const cameraRow: CameraInfoRow = {
  camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
  camType: 'ptz', camCompany: null, placeId: 1, imgW: 1920, imgH: 1080, updatedAt: 'T',
};
const presetRow: PresetPosRow = { camId: 1, presetId: 1, sname: 'Preset 1', pan: 10, tilt: 5, zoom: 2, updatedAt: 'T' };
const existingSlot = (slotId: number): SlotSetupRow => ({
  slotId, camId: 1, presetId: 1, presetSlotIdx: slotId,
  slotRoi: JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]),
  vpdBbox: JSON.stringify({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }), lpdObb: null, occupyRange: null,
  pan: 51.5, tilt: 9.3, zoom: 14.4, centered: 1, img1: 'shots/c1.jpg', slot3dFrontCenter: null, updatedAt: 'T-old',
});
function seedExisting(s: SqliteStore, n = 3): void {
  s.upsertPlaceInfo([placeRow]);
  s.upsertCameraInfo([cameraRow]);
  s.upsertPresetPos([presetRow]);
  s.replaceSlotSetup(Array.from({ length: n }, (_, i) => existingSlot(i + 1)));
}

describe('loadRoiIntoDb — 정상 로딩(실제 data/Place01/PtzCamRoi.json)', () => {
  it('파일의 전 주차면이 slot_setup 으로 재구성된다(slot_id 1..N 고유·연속)', () => {
    const s = newStore();
    const dir = newTmp();
    const expected = buildSlots(JSON.parse(readFileSync(REAL_ROI, 'utf-8')), NOW).length;

    const res = loadRoiIntoDb(s, { placeRoiFile: REAL_ROI, cameraposFile: cameraposCoveringAll(REAL_ROI, dir), now: NOW });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.skipped).toEqual([]);
    expect(res.slots).toBe(expected);

    const views = s.getSlotSetup();
    expect(views).toHaveLength(expected);
    const ids = views.map((v) => v.slotId).sort((a, b) => a - b);
    expect(new Set(ids).size).toBe(expected); // 고유
    expect(ids).toEqual(Array.from({ length: expected }, (_, i) => i + 1)); // 1..N 연속
  });

  it('preset_slotidx 는 프리셋별 1-based 연속, slot_roi 는 4점 정규화(프레임 밖 점은 보존·issues 보고)', () => {
    const s = newStore();
    const dir = newTmp();
    const res = loadRoiIntoDb(s, { placeRoiFile: REAL_ROI, cameraposFile: cameraposCoveringAll(REAL_ROI, dir), now: NOW });

    const byPreset = new Map<string, number[]>();
    let outOfRange = 0;
    for (const v of s.getSlotSetup()) {
      const key = `${v.camId}:${v.presetId}`;
      byPreset.set(key, [...(byPreset.get(key) ?? []), v.presetSlotIdx as number]);
      expect(v.roi).toHaveLength(4);
      for (const p of v.roi) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        // 정규화 스케일 정합(픽셀/W·H) — 프레임 밖도 소폭 이탈에 그친다.
        expect(p.x).toBeGreaterThan(-0.2);
        expect(p.x).toBeLessThan(1.2);
        expect(p.y).toBeGreaterThan(-0.2);
        expect(p.y).toBeLessThan(1.2);
        if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) outOfRange += 1;
      }
    }
    expect(byPreset.size).toBeGreaterThan(0);
    for (const [, idxs] of byPreset) {
      expect(idxs.sort((a, b) => a - b)).toEqual(Array.from({ length: idxs.length }, (_, i) => i + 1));
    }
    // ★ 실데이터에는 프레임 밖 점이 존재한다(placeRoi.ts 규약: 클램프·드롭 금지). 대신 issues 로 보고돼야 한다.
    if (outOfRange > 0) expect(res.issues.join(' ')).toContain('프레임 밖');
  });

  it('합성 픽스처(전 점 프레임 내)에서는 slot_roi 4점이 모두 0~1', () => {
    const s = newStore();
    const dir = newTmp();
    const p = join(dir, 'inframe.json');
    writeFileSync(p, JSON.stringify({
      cameras: [{
        camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
        presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: [[100, 100], [300, 100], [300, 300], [100, 300]] }] }],
      }],
    }));
    s.upsertPlaceInfo([placeRow]);
    s.upsertCameraInfo([cameraRow]);
    s.upsertPresetPos([presetRow]);

    const res = loadRoiIntoDb(s, { placeRoiFile: p, now: NOW });
    expect(res.ok).toBe(true);
    const roi = s.getSlotSetup()[0].roi;
    expect(roi).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }]);
  });

  it('검출/센터링 컬럼은 초기값(vpd/lpd/occupy/pan/tilt/zoom/img1 = NULL, centered=0)', () => {
    const s = newStore();
    const dir = newTmp();
    loadRoiIntoDb(s, { placeRoiFile: REAL_ROI, cameraposFile: cameraposCoveringAll(REAL_ROI, dir), now: NOW });

    for (const v of s.getSlotSetup()) {
      expect(v.vpd).toBeNull();
      expect(v.lpd).toBeNull();
      expect(v.occupyRange).toBeNull();
      expect(v.pan).toBeNull();
      expect(v.tilt).toBeNull();
      expect(v.zoom).toBeNull();
      expect(v.img1).toBeNull();
      expect(v.centered).toBe(false);
    }
  });

  it('기존 검출·센터링이 있는 DB 에 로딩하면 전량 교체된다(centered 전부 해제)', () => {
    const s = newStore();
    const dir = newTmp();
    seedExisting(s, 3);
    expect(s.getSlotSetup().filter((v) => v.centered)).toHaveLength(3);

    const res = loadRoiIntoDb(s, { placeRoiFile: REAL_ROI, cameraposFile: cameraposCoveringAll(REAL_ROI, dir), now: NOW });
    expect(res.ok).toBe(true);
    expect(s.getSlotSetup().some((v) => v.centered)).toBe(false);
    expect(s.getSlotSetup()).toHaveLength(res.slots);
  });

  // ★ 마스터 확인 기준: 실 정본(ROI + 현행 camerapos.json)으로 파일의 **전 주차면**이 적재돼야 한다.
  //   camerapos.json 은 cam1 3프리셋만 담고 있지만, ROI 파일이 프리셋 PTZ 를 직접 담으므로
  //   cam2 도 FK 부모가 서고 하나도 skipped 되지 않는다.
  it('실 정본 로딩 — 파일의 전 주차면이 적재되고 skipped 0건', () => {
    const s = newStore();
    const raw = JSON.parse(readFileSync(REAL_ROI, 'utf-8')) as {
      cameras: Array<{ camera: { cam_id: number }; presets: Array<{ preset_idx: number; parking_spaces: unknown[] }> }>;
    };
    const fileSpaces = raw.cameras.reduce((n, c) => n + c.presets.reduce((m, p) => m + p.parking_spaces.length, 0), 0);
    const filePresets = raw.cameras.reduce((n, c) => n + c.presets.length, 0);

    const res = loadRoiIntoDb(s, { placeRoiFile: REAL_ROI, cameraposFile: REAL_CAMERAPOS, now: NOW });

    expect(res.ok).toBe(true);
    expect(res.skipped).toEqual([]); // ★ 하나도 버리지 않는다
    expect(res.slots).toBe(fileSpaces);
    expect(res.cameras).toBe(raw.cameras.length);
    expect(res.presets).toBe(filePresets);
    expect(s.getSlotSetup()).toHaveLength(fileSpaces);
  });
});

describe('★ wipe 금지 회귀 가드 — 실패 시 기존 slot_setup 무손실', () => {
  const before = 3;

  it('ROI 파일 없음 → ok:false, 기존 행 그대로', () => {
    const s = newStore();
    seedExisting(s, before);
    const res = loadRoiIntoDb(s, { placeRoiFile: join(newTmp(), 'no-such-file.json'), now: NOW });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.slots).toBe(0);
    expect(s.getSlotSetup()).toHaveLength(before);
  });

  it('{"cameras":[]} (유효 주차면 0건) → ok:false, 기존 행 그대로', () => {
    const s = newStore();
    seedExisting(s, before);
    const dir = newTmp();
    const p = join(dir, 'empty.json');
    writeFileSync(p, JSON.stringify({ cameras: [] }));
    const res = loadRoiIntoDb(s, { placeRoiFile: p, now: NOW });
    expect(res.ok).toBe(false);
    expect(s.getSlotSetup()).toHaveLength(before);
  });

  it('JSON 파싱 실패 → ok:false, 기존 행 그대로', () => {
    const s = newStore();
    seedExisting(s, before);
    const dir = newTmp();
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{ this is not json ');
    const res = loadRoiIntoDb(s, { placeRoiFile: p, now: NOW });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('파싱 실패');
    expect(s.getSlotSetup()).toHaveLength(before);
  });

  it('기존 슬롯의 검출·센터링 값도 실패 경로에서 손상되지 않는다', () => {
    const s = newStore();
    seedExisting(s, before);
    loadRoiIntoDb(s, { placeRoiFile: join(newTmp(), 'nope.json'), now: NOW });
    const v = s.getSlotSetup().find((r) => r.slotId === 1)!;
    expect(v.centered).toBe(true);
    expect(v.pan).toBeCloseTo(51.5);
    expect(v.vpd).not.toBeNull();
  });
});

describe('FK 스킵 — preset_pos 부모 없는 (cam,preset)', () => {
  /** cam1:preset1(2면) + cam9:preset9(1면) 소형 ROI. */
  function writeMixedRoi(dir: string): string {
    const poly = (o: number): number[][] => [[100 + o, 100], [300 + o, 100], [300 + o, 300], [100 + o, 300]];
    const p = join(dir, 'mixed.json');
    writeFileSync(p, JSON.stringify({
      cameras: [
        {
          camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 },
          presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: poly(0) }, { idx: 2, points: poly(400) }] }],
        },
        {
          camera: { cam_id: 9, imageWidth: 1000, imageHeight: 1000 },
          presets: [{ preset_idx: 9, parking_spaces: [{ idx: 1, points: poly(0) }] }],
        },
      ],
    }));
    return p;
  }

  // 계약 변경(마스터 요청): camerapos.json 이 뒤처져 부모가 없어도 주차면을 버리지 않는다.
  // ROI 파일이 정의한 (cam,preset) 은 preset_pos 자리표시자(PTZ 미상)를 만들어 **전량 적재**한다.
  it('부모 없는 (cam,preset) 은 자리표시자를 만들어 전량 INSERT 된다(skipped 없음)', () => {
    const s = newStore();
    const dir = newTmp();
    s.upsertPlaceInfo([placeRow]);
    s.upsertCameraInfo([cameraRow]);
    s.upsertPresetPos([presetRow]); // cam1:preset1 만 실측 부모 존재

    const res = loadRoiIntoDb(s, { placeRoiFile: writeMixedRoi(dir), now: NOW });

    expect(res.ok).toBe(true);
    expect(res.slots).toBe(3); // cam1 2면 + cam9 1면 — 하나도 버리지 않는다
    expect(res.skipped).toHaveLength(0);
    expect(res.presets).toBe(2); // ROI 가 정의한 (cam,preset) 그룹 수
    const views = s.getSlotSetup();
    expect(views).toHaveLength(3);
    expect(views.some((v) => v.camId === 9 && v.presetId === 9)).toBe(true);
    // 자리표시자 생성 사실을 숨기지 않는다.
    expect(res.issues.join(' ')).toContain('자리표시자');
    expect(res.issues.join(' ')).toContain('cam9:preset9');
    expect(res.issues.join(' ')).toContain('camerapos');
  });

  it('자리표시자는 camerapos 실측 PTZ 를 덮어쓰지 않는다', () => {
    const dir = newTmp();
    const dbPath = join(dir, 'fk.sqlite'); // preset_pos 직접 검사를 위해 파일 DB(:memory: 는 2차 연결 불가).
    const s = new SqliteStore(dbPath);
    s.upsertPlaceInfo([placeRow]);
    s.upsertCameraInfo([cameraRow]);
    const camerapos = join(dir, 'camerapos.json');
    writeFileSync(camerapos, JSON.stringify({
      datas: [{ datas: [{ cam_id: 1, preset_id: 1, sname: '실측', pan: 51.5, tilt: 9.3, zoom: 14.4 }] }],
    }));

    const res = loadRoiIntoDb(s, { placeRoiFile: writeMixedRoi(dir), cameraposFile: camerapos, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.slots).toBe(3);
    s.close();

    // cam1:preset1 은 실측값 유지, cam9:preset9 만 자리표시자.
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT cam_id, preset_id, sname, pan, tilt, zoom FROM preset_pos').all() as Array<
      { cam_id: number; preset_id: number; sname: string | null; pan: number; tilt: number; zoom: number }
    >;
    db.close();
    expect(rows.find((r) => r.cam_id === 1 && r.preset_id === 1)).toMatchObject({ sname: '실측', pan: 51.5, tilt: 9.3, zoom: 14.4 });
    expect(rows.find((r) => r.cam_id === 9 && r.preset_id === 9)).toMatchObject({ pan: 0, tilt: 0, zoom: 1 });
    expect(res.issues.join(' ')).not.toContain('cam1:preset1');
  });

  // camerapos.json 대체 경로: 시뮬레이터가 ROI 파일에 프리셋 PTZ 를 함께 내보내면 그것이 정본.
  it('ROI 파일이 프리셋 PTZ 를 담고 있으면 자리표시자 없이 실값으로 부모가 선다', () => {
    const dir = newTmp();
    const dbPath = join(dir, 'roiptz.sqlite');
    const s = new SqliteStore(dbPath);

    const poly: number[][] = [[100, 100], [300, 100], [300, 300], [100, 300]];
    const p = join(dir, 'withptz.json');
    writeFileSync(p, JSON.stringify({
      cameras: [{
        camera: { cam_id: 2, imageWidth: 1000, imageHeight: 1000 },
        presets: [
          // 형태 A: 중첩 ptz 객체
          { preset_idx: 1, sname: 'C2-P1', ptz: { pan: 139, tilt: 17, zoom: 2.5 }, parking_spaces: [{ idx: 1, points: poly }] },
          // 형태 B: 평면 필드
          { preset_idx: 2, pan: 150.5, tilt: 20, zoom: 3, parking_spaces: [{ idx: 2, points: poly }] },
        ],
      }],
    }));

    const res = loadRoiIntoDb(s, { placeRoiFile: p, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.slots).toBe(2);
    expect(res.presets).toBe(2);
    expect(res.issues.join(' ')).toContain('ROI 파일의 프리셋 PTZ 2건 채택');
    expect(res.issues.join(' ')).not.toContain('자리표시자'); // 실값이 있으므로 자리표시자 불필요
    s.close();

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT cam_id, preset_id, sname, pan, tilt, zoom FROM preset_pos ORDER BY preset_id').all();
    db.close();
    expect(rows).toEqual([
      { cam_id: 2, preset_id: 1, sname: 'C2-P1', pan: 139, tilt: 17, zoom: 2.5 },
      { cam_id: 2, preset_id: 2, sname: null, pan: 150.5, tilt: 20, zoom: 3 },
    ]);
  });

  it('loadSetupTargetsFromRoi — ROI 프리셋 PTZ 를 수집 순회 대상으로 변환(cam→preset 정렬)', () => {
    // 실데이터: 재생성된 PtzCamRoi.json 은 프리셋별 pan/tilt/zoom 을 담는다.
    const targets = loadSetupTargetsFromRoi(REAL_ROI);
    expect(targets).toHaveLength(5); // cam1 3프리셋 + cam2 2프리셋
    expect(targets.map((t) => `${t.camIdx}:${t.presetIdx}`)).toEqual(['1:1', '1:2', '1:3', '2:1', '2:2']);
    for (const t of targets) {
      expect(Number.isFinite(t.ptz?.pan)).toBe(true);
      expect(Number.isFinite(t.ptz?.tilt)).toBe(true);
      expect(Number.isFinite(t.ptz?.zoom)).toBe(true);
    }
  });

  it('loadSetupTargetsFromRoi — PTZ 미보유/없는 파일이면 빈 배열(camerapos 폴백 유지)', () => {
    const dir = newTmp();
    const poly: number[][] = [[100, 100], [300, 100], [300, 300], [100, 300]];
    const p = join(dir, 'noptz.json');
    writeFileSync(p, JSON.stringify({
      cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [{ preset_idx: 1, parking_spaces: [{ idx: 1, points: poly }] }] }],
    }));
    expect(loadSetupTargetsFromRoi(p)).toEqual([]);
    expect(loadSetupTargetsFromRoi(join(dir, 'nope.json'))).toEqual([]);
  });

  it('부모가 전무해도 자리표시자로 적재된다(기존 행은 교체)', () => {
    const s = newStore();
    const dir = newTmp();
    seedExisting(s, 3); // 부모: cam1:preset1, 기존 슬롯 3행

    const poly: number[][] = [[100, 100], [300, 100], [300, 300], [100, 300]];
    const p = join(dir, 'orphan.json');
    writeFileSync(p, JSON.stringify({
      cameras: [{
        camera: { cam_id: 9, imageWidth: 1000, imageHeight: 1000 },
        presets: [{ preset_idx: 9, parking_spaces: [{ idx: 1, points: poly }] }],
      }],
    }));

    const res = loadRoiIntoDb(s, { placeRoiFile: p, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.slots).toBe(1);
    expect(res.skipped).toHaveLength(0);
    const views = s.getSlotSetup();
    expect(views).toHaveLength(1); // 전량 교체(설계된 파괴적 동작)
    expect(views[0]).toMatchObject({ camId: 9, presetId: 9 });
  });
});
