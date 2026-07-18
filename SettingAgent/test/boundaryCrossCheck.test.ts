import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { aggregate } from '../src/capture/Aggregator.js';
import {
  normalizePtzCamRoi as coreNormalizePtzCamRoi,
  normalizeGlobalIdx as coreNormalizeGlobalIdx,
  buildFlatSlotRows,
} from '../web/core.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { DetectionRow, SlotSetupRow } from '../src/capture/types.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): 경계면 교차 검증(설계 §8.2 · 태스크 3).
 * (#1) slot_setup.slot_id(정수, Finalizer) ↔ setup_artifact.globalIndex.globalIdx — 단일 정수 넘버링 정합.
 * (#2) /capture/slots(store.getSlotSetup: SlotSetupView) ↔ 뷰어 소비(web/core.js buildFlatSlotRows) — slotId·vpd shape.
 * (PtzCalibrator SlotCenteringRow(정수 slot_id) ↔ slot_setup 정합은 centeringSlot.test.ts T7 이 담당.)
 * 1-based 규약 유지 확인.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
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

/** FK 부모(place/camera/preset) 시드 + :memory: 스토어. */
function seededStore(presets: Array<{ presetId: number }>): SqliteStore {
  const s = new SqliteStore(':memory:');
  stores.push(s);
  s.upsertPlaceInfo([{ placeId: 1, placeName: 'Place01' }]);
  s.upsertCameraInfo([{ camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null, camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T' }]);
  s.upsertPresetPos(presets.map((p) => ({ camId: 1, presetId: p.presetId, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' })));
  return s;
}

/** 안정 차량 클러스터(bbox 0.3,0.3,0.1,0.1 → center 0.35,0.35)를 프리셋별 3라운드 관측으로 생성. */
function detsForPresets(presetIdxs: number[]): { dets: DetectionRow[]; presetRounds: Map<string, number> } {
  const dets: DetectionRow[] = [];
  const presetRounds = new Map<string, number>();
  let obs = 0;
  for (const presetIdx of presetIdxs) {
    for (const round of [1, 2, 3]) {
      obs += 1;
      dets.push({ observationId: obs, roundIdx: round, camIdx: 1, presetIdx, kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 });
    }
    presetRounds.set(`1:${presetIdx}`, 3);
  }
  return { dets, presetRounds };
}

function snapshotFor(presetIdxs: number[]): CaptureSnapshot {
  const { dets, presetRounds } = detsForPresets(presetIdxs);
  const aggregated = aggregate(dets, presetRounds, { clusterDist: captureCfg.clusterDist, clusterMinSupport: captureCfg.clusterMinSupport, minConfidence: captureCfg.minConfidence });
  return { dets, presetRounds, aggregated, occByPreset: new Map() };
}

/** 각 프리셋에 1개 주차면(차량 중심 0.35,0.35 포함하는 0.2~0.5 폴리곤). idx 는 비-1..N(재부여 유도). */
function writePlaceRoi(spec: Array<{ presetIdx: number; idx: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-placeroi-'));
  dirs.push(dir);
  const file = join(dir, 'PtzCamRoi.json');
  const poly = [[200, 200], [500, 200], [500, 500], [200, 500]];
  const presets = spec.map((s) => ({ preset_idx: s.presetIdx, parking_spaces: [{ idx: s.idx, points: poly }] }));
  writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets }] }));
  return file;
}

function makeFinalizer(store: SqliteStore, placeRoiFile: string) {
  return new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile });
}

describe('경계면 #1: slot_setup.slot_id ↔ artifact.globalIndex.globalIdx (정수 단일 넘버링)', () => {
  it('모든 파일 주차면이 검출로 점유 → 두 넘버링 집합 동일 + 1..N 연속', async () => {
    // 파일 idx 는 비-1..N(preset1=5, preset2=3) → normalizeGlobalIdx 가 cam→preset 순서로 1,2 재부여.
    const store = seededStore([{ presetId: 1 }, { presetId: 2 }]);
    const file = writePlaceRoi([{ presetIdx: 1, idx: 5 }, { presetIdx: 2, idx: 3 }]);
    const r = await makeFinalizer(store, file).finalize(snapshotFor([1, 2]));

    const slotSetupIds = store.getSlotSetup().map((s) => s.slotId).sort((a, b) => a - b);
    const globalIdxs = r.artifact.globalIndex.map((g) => g.globalIdx).sort((a, b) => a - b);
    // slot_setup 는 파일 전 주차면(2개), globalIndex 는 채택 클러스터(2개) — 모두 점유되므로 집합 동일.
    expect(slotSetupIds).toEqual([1, 2]);
    expect(globalIdxs).toEqual([1, 2]); // ★ 동일 정수 넘버링(1-based, cam→preset 순서)
    expect(slotSetupIds).toEqual(globalIdxs);
    // 정수형 확인(문자열 c{c}p{p}s{n} 아님).
    expect(store.getSlotSetup().every((s) => Number.isInteger(s.slotId))).toBe(true);
  });

  it('slot_setup 의 (cam,preset,presetSlotIdx) 는 1-based, 파일 순서와 정합', async () => {
    const store = seededStore([{ presetId: 1 }, { presetId: 2 }]);
    const file = writePlaceRoi([{ presetIdx: 1, idx: 5 }, { presetIdx: 2, idx: 3 }]);
    await makeFinalizer(store, file).finalize(snapshotFor([1, 2]));
    const rows = store.getSlotSetup();
    const s1 = rows.find((r) => r.presetKey === '1:1')!;
    const s2 = rows.find((r) => r.presetKey === '1:2')!;
    expect(s1.slotId).toBe(1);
    expect(s1.presetSlotIdx).toBe(1); // 1-based
    expect(s2.slotId).toBe(2);
    expect(s2.presetSlotIdx).toBe(1);
  });
});

describe('경계면 #2: getSlotSetup(SlotSetupView) ↔ 뷰어 buildFlatSlotRows 소비', () => {
  it('DB 태그(vpd 유무) → 뷰어 occupied/vpd/lpd, globalIdx 1-based 오름차순', async () => {
    // preset1: 점유(idx 5). preset2: 미점유(파일엔 있으나 검출 없음 → vpd null).
    const store = seededStore([{ presetId: 1 }, { presetId: 2 }]);
    const file = writePlaceRoi([{ presetIdx: 1, idx: 5 }, { presetIdx: 2, idx: 3 }]);
    // 검출은 preset1 에만 → preset1 슬롯만 vpd 배정.
    await makeFinalizer(store, file).finalize(snapshotFor([1]));

    // 뷰어 경로 재현: 같은 파일 → core.normalizeGlobalIdx → buildFlatSlotRows(DB 행 = getSlotSetup).
    const { byPreset } = coreNormalizePtzCamRoi(JSON.parse(readFileSync(file, 'utf8')));
    const placeRoi = coreNormalizeGlobalIdx(byPreset).placeRoi;
    // app.js loadParkingSlots 와 동일하게 SlotSetupView 를 presetKey 로 담는다.
    const parkingSlotsByKey: Record<string, ReturnType<typeof store.getSlotSetup>> = {};
    for (const r of store.getSlotSetup()) (parkingSlotsByKey[r.presetKey] ??= []).push(r);

    const rows = buildFlatSlotRows({ placeRoi, detectByKey: {}, parkingSlotsByKey });
    // globalIdx 오름차순 1..2(1-based).
    expect(rows.map((r) => r.globalIdx)).toEqual([1, 2]);
    // slot_setup 은 occupied 를 저장하지 않는다 → 뷰어는 vpd 유무로 점유 표시(경계 규약).
    expect(rows[0]).toMatchObject({ globalIdx: 1, occupied: true, vpd: true }); // preset1 점유(vpd 배정)
    expect(rows[1]).toMatchObject({ globalIdx: 2, occupied: false, vpd: false }); // preset2 미점유
  });

  it('SlotSetupView 필드 계약: presetKey 파생·vpd 객체·slotId 정수(뷰어가 읽는 키 존재)', async () => {
    const store = seededStore([{ presetId: 1 }]);
    const file = writePlaceRoi([{ presetIdx: 1, idx: 5 }]);
    await makeFinalizer(store, file).finalize(snapshotFor([1]));
    const [v] = store.getSlotSetup();
    // 뷰어(app.js/core.js)가 의존하는 필드가 모두 존재.
    expect(typeof v.slotId).toBe('number');
    expect(v.presetKey).toBe('1:1');
    expect(v.vpd).toMatchObject({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
    expect(v.roi.length).toBe(4); // 정규화 4점 폴리곤(오버레이 소비)
  });
});
