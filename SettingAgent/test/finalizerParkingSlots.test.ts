import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
// 뷰어 순수 로직(전역번호 정규화·평면 목록) — 서버 slot_idx 와 같은 체계인지 end-to-end 확인용.
import {
  normalizePtzCamRoi as coreNormalizePtzCamRoi,
  normalizeGlobalIdx as coreNormalizeGlobalIdx,
  buildFlatSlotRows,
} from '../web/core.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { CameraList } from '../src/viewer/CameraSource.js';

/**
 * 검증자(qa-tester): Finalizer parking_slots 조립·저장(§06 H4, D1~D3).
 * 근거: 01_architect_plan.md §06 §3 H4 + 02_developer_changes.md 02-I QA 인계.
 * 파일ROI × accepted(집계대표) × pointInPolygon → occupied/vpd/lpd 배정. best-effort: 파일 없음/저장 실패 시 artifact·좌표·집계 불변.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};

const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

let stores: SqliteStore[] = [];
let dirs: string[] = [];
afterEach(() => {
  for (const s of stores) { try { s.close(); } catch { /* noop */ } }
  stores = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

/** 회전 번호판 quad(축정렬 아님) — 중심 ≈ (0.3375, 0.35), 차량 ROI(0.3~0.4) 내부. */
const plateQuad: NormalizedQuad = [
  { x: 0.33, y: 0.34 }, { x: 0.36, y: 0.35 }, { x: 0.34, y: 0.36 }, { x: 0.32, y: 0.35 },
];

/** cam1 preset1: 안정 차량 클러스터(bbox 0.3,0.3,0.1,0.1 → center 0.35,0.35) + 번호판(quad). */
function seedOccupiedPreset1(store: SqliteStore): number {
  const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T' });
  for (const round of [1, 2, 3]) {
    const obs = store.insertObservation({ runId, roundIdx: round, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(obs, 1, 1, [
      { kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 },
      { kind: 'plate', x: 0.32, y: 0.34, w: 0.04, h: 0.02, conf: 0.9, quad: plateQuad },
    ]);
  }
  return runId;
}

/** 임시 PtzCamRoi 파일 생성(imageWidth/Height=1000 → 픽셀/1000 = 정규화). 반환: 파일 경로. */
function writePlaceRoi(presets: Array<{ preset_idx: number; parking_spaces: Array<{ idx: number; points: number[][] }> }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'finalizer-placeroi-'));
  dirs.push(dir);
  const file = join(dir, 'PtzCamRoi.json');
  writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets }] }));
  return file;
}

// 폴리곤1(0.2~0.5): 차량/번호판 중심 포함 → 점유. 폴리곤2(0.6~0.9): 비어있음 → 미점유.
const POLY_OCCUPIED = [[200, 200], [500, 200], [500, 500], [200, 500]];
const POLY_EMPTY = [[600, 600], [900, 600], [900, 900], [600, 900]];

function makeFinalizer(store: SqliteStore, placeRoiFile?: string, camera?: Pick<CameraClient, 'listCameras'>) {
  return new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile, camera });
}

/** listCameras 스텁: cam1 preset1 → 지정 PTZ, preset2 → PTZ 미보유(null 필드) 시나리오. */
function fakeCamera(list: CameraList, spy?: () => void): Pick<CameraClient, 'listCameras'> {
  return {
    listCameras: async () => { spy?.(); return list; },
  } as unknown as Pick<CameraClient, 'listCameras'>;
}

describe('Finalizer parking_slots 조립 (§06 H4)', () => {
  it('파일ROI 있음 + accepted 클러스터 → idx1 점유(vpd/lpd 배정), idx2 미점유(null), roi 항상 저장', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [
      { idx: 1, points: POLY_OCCUPIED },
      { idx: 2, points: POLY_EMPTY },
    ] }]);
    await makeFinalizer(store, file).finalize(runId);

    const slots = store.getParkingSlots(runId);
    expect(slots).toHaveLength(2);
    const s1 = slots.find((r) => r.slotIdx === 1)!;
    const s2 = slots.find((r) => r.slotIdx === 2)!;

    // idx1: 번호판/차량 중심이 폴리곤 내부 → occupied + vpd(bbox) + lpd(quad) 배정.
    expect(s1.occupied).toBe(true);
    expect(s1.vpd).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }); // accepted 대표 bbox
    expect(s1.lpd).not.toBeNull();
    expect(s1.lpd).toHaveLength(4);
    expect(s1.occupancyRate).not.toBeNull();
    expect(s1.roi).toEqual([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }]); // 파일 폴리곤 정규화

    // idx2: 배정 클러스터 없음 → 미점유, vpd/lpd null. roi 는 여전히 저장.
    expect(s2.occupied).toBe(false);
    expect(s2.vpd).toBeNull();
    expect(s2.lpd).toBeNull();
    expect(s2.occupancyRate).toBeNull();
    expect(s2.roi).toEqual([{ x: 0.6, y: 0.6 }, { x: 0.9, y: 0.6 }, { x: 0.9, y: 0.9 }, { x: 0.6, y: 0.9 }]);
  });

  it('프리셋별 분리 저장: 2프리셋 파일 → preset_key 로 행 분리(검출 없는 프리셋은 미점유)', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([
      { preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY_OCCUPIED }] },
      { preset_idx: 2, parking_spaces: [{ idx: 1, points: POLY_EMPTY }] },
    ]);
    await makeFinalizer(store, file).finalize(runId);

    const slots = store.getParkingSlots(runId);
    const p1 = slots.filter((r) => r.presetKey === '1:1');
    const p2 = slots.filter((r) => r.presetKey === '1:2');
    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(1);
    expect(p1[0].occupied).toBe(true);   // 검출 있는 프리셋
    expect(p2[0].occupied).toBe(false);  // 검출 없는 프리셋 → 미점유(정상)
  });

  it('best-effort skip(파일 미주입): parking_slots 0행 + artifact.slots/globalCount 불변(회귀 0)', async () => {
    // 동일 시드 두 run: with/without placeRoiFile → artifact 결과 동일(부수 저장은 artifact 에 영향 없음).
    const storeA = mem();
    const runA = seedOccupiedPreset1(storeA);
    const rA = await makeFinalizer(storeA).finalize(runA); // placeRoiFile 미주입
    expect(storeA.getParkingSlots(runA)).toHaveLength(0);

    const storeB = mem();
    const runB = seedOccupiedPreset1(storeB);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY_OCCUPIED }] }]);
    const rB = await makeFinalizer(storeB, file).finalize(runB);
    expect(storeB.getParkingSlots(runB)).toHaveLength(1);

    // 불변식: parking_slots 저장 유무와 무관하게 artifact.slots·globalCount 동일.
    expect(rA.slots).toBe(rB.slots);
    expect(rA.globalCount).toBe(rB.globalCount);
    expect(rA.artifact.slots).toEqual(rB.artifact.slots);
  });

  it('best-effort: replaceParkingSlots 저장 실패가 finalize 실패로 전파되지 않음(artifact 정상 반환)', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY_OCCUPIED }] }]);
    const spy = vi.spyOn(store, 'replaceParkingSlots').mockImplementation(() => { throw new Error('boom'); });

    const r = await makeFinalizer(store, file).finalize(runId); // reject 되지 않아야 함
    expect(spy).toHaveBeenCalled();
    expect(r.artifact.slots.length).toBeGreaterThan(0); // artifact 는 정상 조립·반환
    expect(store.getParkingSlots(runId)).toHaveLength(0); // 저장 실패 → 행 없음(격리)
  });

  it('파일ROI 없음(빈 cameras) → graceful skip(parking_slots 0행, artifact 정상)', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const dir = mkdtempSync(join(tmpdir(), 'finalizer-empty-'));
    dirs.push(dir);
    const file = join(dir, 'PtzCamRoi.json');
    writeFileSync(file, JSON.stringify({ cameras: [] }));

    const r = await makeFinalizer(store, file).finalize(runId);
    expect(r.artifact.slots.length).toBeGreaterThan(0);
    expect(store.getParkingSlots(runId)).toHaveLength(0);
  });
});

// 검증자(qa-tester): Finalizer preset PTZ 결합 주입 (변경1 6단계).
// 근거: 01_architect_plan.md 변경1 6단계 + 02_developer_changes.md Finalizer PTZ 주입(resolvePresetPtz 재사용).
describe('Finalizer parking_slots preset PTZ 주입 (변경1)', () => {
  it('camera 주입 시 preset PTZ 조회 → 모든 행(점유·미점유 무관)에 pan/tilt/zoom 채움', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [
      { idx: 1, points: POLY_OCCUPIED },
      { idx: 2, points: POLY_EMPTY },
    ] }]);
    const camera = fakeCamera({
      cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [
        { presetIdx: 1, label: 'P1', pan: 30.5, tilt: -10.25, zoom: 3 },
      ] }],
    });
    await makeFinalizer(store, file, camera).finalize(runId);

    const slots = store.getParkingSlots(runId);
    expect(slots).toHaveLength(2);
    // 점유·미점유 무관하게 프리셋 단위 PTZ 가 동일하게 결합.
    for (const s of slots) {
      expect(s.pan).toBe(30.5);
      expect(s.tilt).toBe(-10.25);
      expect(s.zoom).toBe(3);
    }
  });

  it('camera 미주입 시 pan/tilt/zoom = null(격리·graceful) + parking_slots 정상 저장', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY_OCCUPIED }] }]);
    await makeFinalizer(store, file).finalize(runId); // camera 미주입

    const [s] = store.getParkingSlots(runId);
    expect(s.occupied).toBe(true);   // 저장 자체는 정상
    expect(s.pan).toBeNull();
    expect(s.tilt).toBeNull();
    expect(s.zoom).toBeNull();
  });

  it('preset PTZ 미보유(pan/tilt/zoom 필드 없음) → resolvePresetPtz null → 행 PTZ null', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY_OCCUPIED }] }]);
    // preset 존재하나 PTZ 필드 미보유 → resolvePresetPtz 는 null 반환(부분 보유도 null).
    const camera = fakeCamera({
      cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [
        { presetIdx: 1, label: 'P1' }, // pan/tilt/zoom 없음
      ] }],
    });
    await makeFinalizer(store, file, camera).finalize(runId);

    const [s] = store.getParkingSlots(runId);
    expect(s.pan).toBeNull();
    expect(s.tilt).toBeNull();
    expect(s.zoom).toBeNull();
  });

  it('listCameras 조회 실패(throw) → 격리(PTZ null) + parking_slots 저장 성공', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [{ idx: 1, points: POLY_OCCUPIED }] }]);
    const camera = {
      listCameras: async () => { throw new Error('network'); },
    } as unknown as Pick<CameraClient, 'listCameras'>;
    await makeFinalizer(store, file, camera).finalize(runId);

    const [s] = store.getParkingSlots(runId);
    expect(s.occupied).toBe(true);
    expect(s.pan).toBeNull(); // resolvePresetPtz catch → null
  });

  it('preset_key별 listCameras 1회만 호출(캐시 — spaces 여러 개여도 중복 조회 없음)', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([{ preset_idx: 1, parking_spaces: [
      { idx: 1, points: POLY_OCCUPIED }, { idx: 2, points: POLY_EMPTY }, { idx: 3, points: POLY_EMPTY },
    ] }]);
    let calls = 0;
    const camera = fakeCamera({
      cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [
        { presetIdx: 1, label: 'P1', pan: 1, tilt: 2, zoom: 3 },
      ] }],
    }, () => { calls += 1; });
    await makeFinalizer(store, file, camera).finalize(runId);

    // preset_key '1:1' 단일 → 캐시로 spaces 3개여도 조회 1회.
    expect(calls).toBe(1);
    expect(store.getParkingSlots(runId)).toHaveLength(3);
  });
});

/**
 * slot_idx = 전역번호(1..N) 기록(normalizeGlobalIdx 서버 포팅). Unity 가 만든 0-based 파일 그대로
 * 최종화해도 DB 가 뷰어와 같은 번호 체계를 쓰게 되어, 목록의 DB 태그(VPD/LPD)가 정상 부착된다.
 */
describe('Finalizer parking_slots 전역번호(slot_idx = 1..N)', () => {
  it("0-based 파일(뷰어 '저장' 전 Unity 생성본) → slot_idx 가 전역번호 1..N 으로 재부여", async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([
      { preset_idx: 1, parking_spaces: [{ idx: 0, points: POLY_OCCUPIED }, { idx: 1, points: POLY_EMPTY }] },
      { preset_idx: 2, parking_spaces: [{ idx: 0, points: POLY_EMPTY }] }, // 프리셋 간 idx 중복(0-based)
    ]);
    await makeFinalizer(store, file).finalize(runId);

    const slots = store.getParkingSlots(runId);
    expect(slots.map((r) => r.slotIdx).sort((a, b) => a - b)).toEqual([1, 2, 3]); // cam→preset→배열순 1..3
    expect(slots.find((r) => r.slotIdx === 1)!.presetKey).toBe('1:1');
    expect(slots.find((r) => r.slotIdx === 3)!.presetKey).toBe('1:2');
    // 점유 배정은 폴리곤 기준 유지 — 전역번호 1(=구 idx 0, POLY_OCCUPIED)이 점유.
    expect(slots.find((r) => r.slotIdx === 1)!.occupied).toBe(true);
    expect(slots.find((r) => r.slotIdx === 2)!.occupied).toBe(false);
  });

  it('성공기준: 0-based 파일로 최종화해도 뷰어 목록에 DB 태그(VPD/LPD)가 부착된다', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    const file = writePlaceRoi([
      { preset_idx: 1, parking_spaces: [{ idx: 0, points: POLY_OCCUPIED }, { idx: 1, points: POLY_EMPTY }] },
    ]);
    await makeFinalizer(store, file).finalize(runId);

    // 뷰어 경로 재현: 같은 파일 → core.normalizeGlobalIdx → buildFlatSlotRows(DB 행 = parkingSlotsByKey).
    const { byPreset } = coreNormalizePtzCamRoi(JSON.parse(readFileSync(file, 'utf8')));
    const placeRoi = coreNormalizeGlobalIdx(byPreset).placeRoi;
    // app.js loadParkingSlots 와 동일하게 DB 행을 그대로 담는다(vpd/lpd = 검출 객체 | null).
    const parkingSlotsByKey: Record<string, ReturnType<typeof store.getParkingSlots>> = {};
    for (const r of store.getParkingSlots(runId)) {
      (parkingSlotsByKey[r.presetKey] ??= []).push(r);
    }
    const rows = buildFlatSlotRows({ placeRoi, detectByKey: {}, parkingSlotsByKey });

    expect(rows.map((r) => r.globalIdx)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ globalIdx: 1, occupied: true, vpd: true, lpd: true }); // DB 태그 부착(오귀속 없음)
    expect(rows[1]).toMatchObject({ globalIdx: 2, occupied: false, vpd: false, lpd: false });
  });

  it('이미 1..N 고유한 파일 → 번호 그대로 보존(멱등 — 사용자 재지정 번호 유지)', async () => {
    const store = mem();
    const runId = seedOccupiedPreset1(store);
    // 사용자가 뷰어에서 재지정한 번호(프리셋1 = 2, 프리셋2 = 1) — 파일 전체가 1..2 고유.
    const file = writePlaceRoi([
      { preset_idx: 1, parking_spaces: [{ idx: 2, points: POLY_OCCUPIED }] },
      { preset_idx: 2, parking_spaces: [{ idx: 1, points: POLY_EMPTY }] },
    ]);
    await makeFinalizer(store, file).finalize(runId);

    const slots = store.getParkingSlots(runId);
    expect(slots.find((r) => r.presetKey === '1:1')!.slotIdx).toBe(2); // 재부여 금지
    expect(slots.find((r) => r.presetKey === '1:2')!.slotIdx).toBe(1);
  });
});
