import { describe, it, expect, afterEach } from 'vitest';
import { Finalizer } from '../src/capture/Finalizer.js';
import { buildPlateAnchoredQuad } from '../src/capture/floorRoi.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { plateAngleRad, rectToQuad } from '../src/domain/geometry.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): Finalizer floor ROI 가산 (설계서 §7).
 * floor_roi 있는 run finalize → slot.floorRoiByPreset[key]; 없는 run 은 필드 부재.
 * 기존 roiByPreset/plateRoiByPreset 불변.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
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

// 검증자(qa-tester): Finalizer plateRoiByPreset = 실 대표 quad 우선, 부재 시 rectToQuad 폴백 (설계 케이스 10).
describe('Finalizer plateRoiByPreset(실 quad·폴백) (설계 케이스 10)', () => {
  /** 안정 차량 클러스터 + 그 ROI 내부의 번호판(quad 유무 선택). */
  function seedWithPlate(store: SqliteStore, plateQuad?: NormalizedQuad): number {
    const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T' });
    // 번호판 rect(집계용) = quad boundingRect 또는 축정렬. 차량 ROI(0.3~0.4,0.3~0.4) 내부 중심.
    const pr = { x: 0.32, y: 0.34, w: 0.04, h: 0.02 };
    for (const round of [1, 2, 3]) {
      const obs = store.insertObservation({ runId, roundIdx: round, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
      store.insertDetections(obs, 1, 1, [
        { kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 },
        { kind: 'plate', x: pr.x, y: pr.y, w: pr.w, h: pr.h, conf: 0.9, ...(plateQuad ? { quad: plateQuad } : {}) },
      ]);
    }
    return runId;
  }

  it('실 대표 quad 보존 → plateRoiByPreset 값이 합성 quad(방향 보존·축정렬 아님)', async () => {
    const store = mem();
    // 회전 번호판 quad(축정렬 아님).
    const rot: NormalizedQuad = [
      { x: 0.33, y: 0.34 },
      { x: 0.36, y: 0.35 },
      { x: 0.34, y: 0.36 },
      { x: 0.32, y: 0.35 },
    ];
    const runId = seedWithPlate(store, rot);
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    const slot = r.artifact.slots[0];
    expect(slot.plateRoiByPreset).toBeDefined();
    // 강건 합성 대표 quad: 원본 방향(각도) 보존, 축정렬 아님(회전 유지). (representativeQuad → 순환 median 합성으로 대체)
    const got = slot.plateRoiByPreset!['1:1'];
    expect(plateAngleRad(got)).toBeCloseTo(plateAngleRad(rot), 5);
    expect(got[0].y).not.toBeCloseTo(got[1].y);
  });

  it('quad 부재(구데이터·polygon 미보존) → rectToQuad(rect) 폴백', async () => {
    const store = mem();
    const runId = seedWithPlate(store); // plate 에 quad 없음
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    const slot = r.artifact.slots[0];
    expect(slot.plateRoiByPreset).toBeDefined();
    // 집계 대표 plate rect(중앙값 = 0.32,0.34,0.04,0.02) 를 rectToQuad 로 승격.
    expect(slot.plateRoiByPreset!['1:1']).toEqual(rectToQuad({ x: 0.32, y: 0.34, w: 0.04, h: 0.02 }));
  });

  it('plate 부재 → plateRoiByPreset 미부여', async () => {
    const store = mem();
    const runId = seedStableRun(store); // 번호판 없음
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    expect(r.artifact.slots[0].plateRoiByPreset).toBeUndefined();
  });
});

describe('Finalizer floor ROI 가산', () => {
  it('floor_roi 있으면 slot.floorRoiByPreset[key] 에 다각형 부여, roi 불변(단일 슬롯=비겹침 무영향)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    // 집계 전이라도 finalize 가 재집계하므로, finalize 후 clusterId 와 일치하도록 upsert(클러스터 1).
    store.upsertFloorRoi(runId, '1:1', 1, quad, 'U');
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);

    const slot = r.artifact.slots[0];
    expect(slot.floorRoiByPreset).toBeDefined();
    // 프리셋에 슬롯 1개 → 비겹침 클리핑 무영향 → 저장 다각형 그대로.
    expect(slot.floorRoiByPreset!['1:1']).toEqual(quad);
    // 기존 roiByPreset 불변(집계 대표 bbox).
    expect(slot.roiByPreset['1:1']).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });

  it('floor_roi 없으면 bbox 유도 폴백 다각형 부여(항상 존재 — 최종화 시 그려짐)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    const slot = r.artifact.slots[0];
    expect(slot.floorRoiByPreset).toBeDefined();
    // LLM 산출 없으면 차량 bbox(0.3,0.3,0.1,0.1) 유도 폴백 다각형과 일치(단일 슬롯=비겹침 무영향).
    expect(slot.floorRoiByPreset!['1:1']).toEqual(buildPlateAnchoredQuad({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }));
    // roiByPreset 불변.
    expect(slot.roiByPreset['1:1']).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });
});
