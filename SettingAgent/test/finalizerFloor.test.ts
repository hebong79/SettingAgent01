import { describe, it, expect, afterEach } from 'vitest';
import { Finalizer } from '../src/capture/Finalizer.js';
import { fallbackQuadFromRect } from '../src/capture/floorRoi.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): Finalizer floor ROI 가산 (설계서 §7).
 * floor_roi 있는 run finalize → slot.floorRoiByPreset[key]; 없는 run 은 필드 부재.
 * 기존 roiByPreset/plateRoiByPreset 불변.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, checkpointEvery: 10, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5,
};

const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};

let stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* noop */ } } stores = []; });
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

/** 안정 클러스터(support>=3) 1개. 집계 후 clusterId 는 1, presetKey '1:1', slotId c1p1s1. */
function seedStableRun(store: SqliteStore): number {
  const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T' });
  for (const round of [1, 2, 3]) {
    const obs = store.insertObservation({ runId, roundIdx: round, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(obs, 1, 1, [{ kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 }]);
  }
  return runId;
}

const quad: NormalizedQuad = [
  { x: 0.3, y: 0.42 },
  { x: 0.4, y: 0.42 },
  { x: 0.38, y: 0.3 },
  { x: 0.32, y: 0.3 },
];

describe('Finalizer floor ROI 가산', () => {
  it('floor_roi 있으면 slot.floorRoiByPreset[key] 에 4점 포함, roi 불변', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    // 집계 전이라도 finalize 가 재집계하므로, finalize 후 clusterId 와 일치하도록 upsert(클러스터 1).
    store.upsertFloorRoi(runId, '1:1', 1, quad, 'U');
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);

    const slot = r.artifact.slots[0];
    expect(slot.floorRoiByPreset).toBeDefined();
    expect(slot.floorRoiByPreset!['1:1']).toEqual(quad);
    // 기존 roiByPreset 불변(집계 대표 bbox).
    expect(slot.roiByPreset['1:1']).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });

  it('floor_roi 없으면 bbox 유도 폴백 사변형 부여(항상 존재 — 최종화 시 그려짐)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    const slot = r.artifact.slots[0];
    expect(slot.floorRoiByPreset).toBeDefined();
    // LLM 산출 없으면 차량 bbox(0.3,0.3,0.1,0.1) 유도 폴백과 일치.
    expect(slot.floorRoiByPreset!['1:1']).toEqual(fallbackQuadFromRect({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }));
    // roiByPreset 불변.
    expect(slot.roiByPreset['1:1']).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });
});
