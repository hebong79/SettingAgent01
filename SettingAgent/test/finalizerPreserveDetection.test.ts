import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { aggregate } from '../src/capture/Aggregator.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { DetectionRow } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): finalize 방어 가드 — 검출 hit 없는 슬롯의 기존 vpd/lpd/occupy 보존.
 * 근거: 01_architect_plan.md(A 선형) + 02_developer_changes.md.
 * 규칙: hit 있으면 새 값 / hit 없고 기존행 있으면 기존값 보존 / 둘 다 없으면 null(정상 강등).
 * 실 SqliteStore(:memory:) + 실 Finalizer 왕복 검증(코드 존재가 아닌 정상 동작 증명).
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
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

/** FK 부모(place_info/camera_info/preset_pos) 시드 — slot_setup FK(cam_id,preset_id)→preset_pos 전제. */
function seedFkParents(store: SqliteStore, presets: Array<{ camId: number; presetId: number }>): void {
  store.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
  const camIds = [...new Set(presets.map((p) => p.camId))];
  store.upsertCameraInfo(camIds.map((camId) => ({
    camId, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null,
    camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T',
  })));
  store.upsertPresetPos(presets.map((p) => ({ camId: p.camId, presetId: p.presetId, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' })));
}

/** dets/presetRounds → CaptureSnapshot(finalize 가 fresh 재집계). */
function snapshotFromDets(dets: DetectionRow[], presetRounds: Map<string, number>): CaptureSnapshot {
  const aggregated = aggregate(dets, presetRounds, {
    clusterDist: captureCfg.clusterDist, clusterMinSupport: captureCfg.clusterMinSupport, minConfidence: captureCfg.minConfidence,
  });
  return { dets, presetRounds, aggregated, occByPreset: new Map() };
}

/** 검출 0 스냅샷(accepted=0) — 빈 finalize. */
function emptySnapshot(): CaptureSnapshot {
  return { dets: [], presetRounds: new Map(), aggregated: [], occByPreset: new Map() };
}

/** 회전 번호판 quad(중심 명시). 차량 rep ROI 내부에 중심. */
function plateQuadAt(cx: number, cy: number): NormalizedQuad {
  return [
    { x: cx - 0.01, y: cy - 0.005 }, { x: cx + 0.01, y: cy - 0.005 },
    { x: cx + 0.01, y: cy + 0.005 }, { x: cx - 0.01, y: cy + 0.005 },
  ];
}

/**
 * cam1:preset1 에 차량 클러스터 1개(3라운드 + 번호판 quad) 생성.
 * bbox center 는 (bx+bw/2, by+bh/2). obsBase 로 관측 id 충돌 회피.
 */
function clusterDets(bbox: { x: number; y: number; w: number; h: number }, obsBase: number): DetectionRow[] {
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const dets: DetectionRow[] = [];
  for (const round of [1, 2, 3]) {
    dets.push({ observationId: obsBase + round * 10 + 1, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h, conf: 0.9 });
    dets.push({ observationId: obsBase + round * 10 + 2, roundIdx: round, camIdx: 1, presetIdx: 1, kind: 'plate', x: cx - 0.02, y: cy - 0.01, w: 0.04, h: 0.02, conf: 0.9, quad: plateQuadAt(cx, cy) });
  }
  return dets;
}

/** 임시 PtzCamRoi 파일 생성(imageWidth/Height=1000 → 픽셀/1000 = 정규화). */
function writePlaceRoi(spaces: Array<{ idx: number; points: number[][] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'finalizer-preserve-'));
  dirs.push(dir);
  const file = join(dir, 'PtzCamRoi.json');
  writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 1000, imageHeight: 1000 }, presets: [{ preset_idx: 1, parking_spaces: spaces }] }] }));
  return file;
}

function makeFinalizer(store: SqliteStore, placeRoiFile: string) {
  return new Finalizer({ store, repo: fakeRepo(), cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', placeRoiFile });
}

// 폴리곤 A(0.2~0.5): 차량/번호판 중심 포함. 폴리곤 B(0.6~0.9): 별도 슬롯.
const POLY_A = [[200, 200], [500, 200], [500, 500], [200, 500]];
const POLY_B = [[600, 600], [900, 600], [900, 900], [600, 900]];

describe('Finalizer 방어 가드: 검출 없는 슬롯의 기존 vpd/lpd/occupy 보존', () => {
  it('1. 보존(핵심): 채워진 슬롯 → 검출0 2차 finalize → 기존 vpd/lpd/occupy 유지(null 아님)', async () => {
    const store = mem();
    seedFkParents(store, [{ camId: 1, presetId: 1 }]);
    const file = writePlaceRoi([{ idx: 1, points: POLY_A }]);

    // 1차: 검출 hit → slot 1 에 vpd/lpd/occupy 적재.
    await makeFinalizer(store, file).finalize(snapshotFromDets(clusterDets({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, 0), new Map([['1:1', 3]])));
    const before = store.getSlotSetup().find((r) => r.slotId === 1)!;
    expect(before.vpd).not.toBeNull();
    expect(before.lpd).not.toBeNull();
    expect(before.occupyRange).not.toBeNull();

    // 2차: 검출 0(accepted=0) → 같은 파일로 finalize. hit 없음 → prev 보존.
    await makeFinalizer(store, file).finalize(emptySnapshot());

    const after = store.getSlotSetup().find((r) => r.slotId === 1)!;
    expect(after.vpd).not.toBeNull();
    expect(after.lpd).not.toBeNull();
    expect(after.occupyRange).not.toBeNull();
    // 왕복 보존: 값 동일(재직렬화 후 파싱 shape 일치).
    expect(after.vpd).toEqual(before.vpd);
    expect(after.lpd).toEqual(before.lpd);
    expect(after.occupyRange).toEqual(before.occupyRange);
  });

  it('2. 갱신(회귀0): hit 있는 2차 finalize → vpd/lpd 가 새 검출값으로 대체(기존값 아님)', async () => {
    const store = mem();
    seedFkParents(store, [{ camId: 1, presetId: 1 }]);
    const file = writePlaceRoi([{ idx: 1, points: POLY_A }]);

    // 1차: bbox (0.3,0.3) → vpd.x = 0.3.
    await makeFinalizer(store, file).finalize(snapshotFromDets(clusterDets({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, 0), new Map([['1:1', 3]])));
    expect(store.getSlotSetup().find((r) => r.slotId === 1)!.vpd!.x).toBeCloseTo(0.3, 5);

    // 2차: bbox (0.32,0.32) → 같은 폴리곤 A 배정, vpd.x = 0.32(대체).
    await makeFinalizer(store, file).finalize(snapshotFromDets(clusterDets({ x: 0.32, y: 0.32, w: 0.1, h: 0.1 }, 1000), new Map([['1:1', 3]])));

    const after = store.getSlotSetup().find((r) => r.slotId === 1)!;
    expect(after.vpd!.x).toBeCloseTo(0.32, 5); // 새 값
    expect(after.vpd!.x).not.toBeCloseTo(0.3, 5); // 기존값 아님
    expect(after.lpd).not.toBeNull();
  });

  it('3. 혼합: 일부 슬롯만 hit → hit 슬롯 갱신 / 무-hit 슬롯 기존 보존 동시', async () => {
    const store = mem();
    seedFkParents(store, [{ camId: 1, presetId: 1 }]);
    const file = writePlaceRoi([{ idx: 1, points: POLY_A }, { idx: 2, points: POLY_B }]);

    // 1차: 두 폴리곤 모두 채움(A center 0.35, B center 0.75).
    const detsBoth = [
      ...clusterDets({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, 0),
      ...clusterDets({ x: 0.7, y: 0.7, w: 0.1, h: 0.1 }, 5000),
    ];
    await makeFinalizer(store, file).finalize(snapshotFromDets(detsBoth, new Map([['1:1', 3]])));
    const b1 = store.getSlotSetup();
    const before1 = b1.find((r) => r.slotId === 1)!;
    const before2 = b1.find((r) => r.slotId === 2)!;
    expect(before1.vpd).not.toBeNull();
    expect(before2.vpd).not.toBeNull();

    // 2차: 폴리곤 A(slot1)만 hit(bbox 0.32 이동), 폴리곤 B(slot2) 검출 없음.
    await makeFinalizer(store, file).finalize(snapshotFromDets(clusterDets({ x: 0.32, y: 0.32, w: 0.1, h: 0.1 }, 8000), new Map([['1:1', 3]])));

    const a2 = store.getSlotSetup();
    const after1 = a2.find((r) => r.slotId === 1)!;
    const after2 = a2.find((r) => r.slotId === 2)!;
    // slot1: hit → 갱신(0.32).
    expect(after1.vpd!.x).toBeCloseTo(0.32, 5);
    // slot2: 무-hit → 기존 보존(0.7, null 아님).
    expect(after2.vpd).not.toBeNull();
    expect(after2.vpd!.x).toBeCloseTo(0.7, 5);
    expect(after2.lpd).toEqual(before2.lpd);
    expect(after2.occupyRange).toEqual(before2.occupyRange);
  });

  it('4. 신규 슬롯: 기존행 없음 + hit 없음 → null(파괴 아님, 정상 강등)', async () => {
    const store = mem();
    seedFkParents(store, [{ camId: 1, presetId: 1 }]);
    const file = writePlaceRoi([{ idx: 1, points: POLY_A }]);

    // 선적재 없이 검출 0 finalize → 행 생성되지만 검출 컬럼 null(정상 신규).
    await makeFinalizer(store, file).finalize(emptySnapshot());

    const rows = store.getSlotSetup();
    expect(rows).toHaveLength(1);
    const s1 = rows.find((r) => r.slotId === 1)!;
    expect(s1.roi).not.toBeNull(); // roi 는 항상 저장(파일 폴리곤).
    expect(s1.vpd).toBeNull();
    expect(s1.lpd).toBeNull();
    expect(s1.occupyRange).toBeNull();
  });
});
