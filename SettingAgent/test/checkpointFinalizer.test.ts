import { describe, it, expect, afterEach } from 'vitest';
import { CheckpointReviewer, clusterRef, advisoryLines } from '../src/capture/CheckpointReviewer.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { SetupBrain, CheckpointResult, FinalizeCaptureResult } from '../src/brain/SetupBrain.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): CheckpointReviewer/Finalizer (G4 — fake brain).
 * 핵심: merges/labels/rejects 가 status/zone 에 반영되되 ROI 좌표는 불변(§8 좌표 불변식).
 * Finalizer → SetupArtifact shape·globalIndex·saveArtifact·artifact_snapshot.
 * llm.enabled=false 결정형 강등(체크포인트 no-op, 집계만 산출).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, checkpointEvery: 10, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5,
};

const slot = (over: Partial<AggregatedSlot> = {}): AggregatedSlot => ({
  presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1,
  x: 0.2, y: 0.2, w: 0.1, h: 0.1, support: 3, occupancyRate: 0.5,
  plateX: null, plateY: null, plateW: null, plateH: null, status: 'candidate', ...over,
});

const fakeRepo = (): { repo: Repository; saved: SetupArtifact[] } => {
  const saved: SetupArtifact[] = [];
  return { saved, repo: { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository };
};

let stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* noop */ } } stores = []; });
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

// ── 순수 헬퍼 ──────────────────────────────────────────
describe('clusterRef / advisoryLines (순수 헬퍼)', () => {
  it('clusterRef → presetKey#clusterId 포맷', () => {
    expect(clusterRef({ presetKey: '1:2', clusterId: 3 })).toBe('1:2#3');
  });

  it('advisoryLines — coverage short + convergence advice 표시 문자열', () => {
    const r: CheckpointResult = {
      merges: [], labels: {}, rejects: [],
      coverage: [
        { preset: '1:1', expected: 5, got: 2, short: true },
        { preset: '1:2', expected: 3, got: 3, short: false },
      ],
      convergence: { converged: true, advice: '조기 종료 가능' },
    };
    const lines = advisoryLines(r);
    expect(lines.some((l) => l.includes('1:1') && l.includes('부족'))).toBe(true);
    expect(lines.some((l) => l.includes('1:2'))).toBe(false); // short=false 는 표시 안 함
    expect(lines.some((l) => l.includes('수렴됨') && l.includes('조기 종료'))).toBe(true);
  });

  it('advisoryLines — 미수렴 + advice → advice 만 표시', () => {
    const r: CheckpointResult = {
      merges: [], labels: {}, rejects: [], coverage: [],
      convergence: { converged: false, advice: '더 수집 필요' },
    };
    expect(advisoryLines(r)).toEqual(['더 수집 필요']);
  });
});

// ── CheckpointReviewer (좌표 불변) ─────────────────────
describe('CheckpointReviewer 좌표 불변 (G4·§8)', () => {
  function fakeBrain(result: CheckpointResult | null): SetupBrain {
    return {
      enabled: true,
      judgePreset: async () => null, dedupeAndLabel: async () => null, finalReport: async () => null,
      reviewCheckpoint: async () => result,
    } as unknown as SetupBrain;
  }

  it('rejects/merges → status 갱신, ROI 좌표는 입력=출력 동일', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 10, intervalMs: 1, startedAt: 'T' });
    const slots = [
      slot({ clusterId: 1, x: 0.20, y: 0.21, w: 0.10, h: 0.11 }),
      slot({ clusterId: 2, x: 0.50, y: 0.51, w: 0.12, h: 0.13 }),
      slot({ clusterId: 3, x: 0.80, y: 0.81, w: 0.14, h: 0.15 }),
    ];
    store.replaceAggregatedSlots(runId, slots);

    const result: CheckpointResult = {
      merges: [['1:1#2', '1:1#3']], // 2번째(#3)부터 merged
      labels: {}, rejects: ['1:1#1'], // #1 rejected
      coverage: [], convergence: { converged: false, advice: '' },
    };
    const reviewer = new CheckpointReviewer({ store, brain: fakeBrain(result), now: () => 'C' });
    const out = await reviewer.review(runId, 10, 10, slots, 2);
    expect(out).not.toBeNull();

    const after = store.getAggregatedSlots(runId);
    const byCluster = new Map(after.map((s) => [s.clusterId, s]));
    expect(byCluster.get(1)!.status).toBe('rejected');
    expect(byCluster.get(3)!.status).toBe('merged');
    expect(byCluster.get(2)!.status).toBe('candidate'); // merges 그룹 첫 항목은 유지

    // ★ 좌표 불변식: status 만 바뀌고 bbox 좌표는 그대로.
    expect({ x: byCluster.get(1)!.x, y: byCluster.get(1)!.y, w: byCluster.get(1)!.w, h: byCluster.get(1)!.h })
      .toEqual({ x: 0.20, y: 0.21, w: 0.10, h: 0.11 });
    expect({ x: byCluster.get(3)!.x, y: byCluster.get(3)!.y, w: byCluster.get(3)!.w, h: byCluster.get(3)!.h })
      .toEqual({ x: 0.80, y: 0.81, w: 0.14, h: 0.15 });

    // checkpoint 행 저장.
    expect(store.getLatestCheckpoint(runId)).toBeDefined();
  });

  it('LLM 비활성(enabled=false) → null no-op, status 미변경, checkpoint 미저장', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 10, intervalMs: 1, startedAt: 'T' });
    const slots = [slot({ clusterId: 1, status: 'candidate' })];
    store.replaceAggregatedSlots(runId, slots);
    const disabledBrain = { enabled: false, reviewCheckpoint: async () => ({ merges: [], labels: {}, rejects: ['1:1#1'], coverage: [], convergence: { converged: false, advice: '' } }) } as unknown as SetupBrain;
    const reviewer = new CheckpointReviewer({ store, brain: disabledBrain });
    const out = await reviewer.review(runId, 10, 10, slots, 1);
    expect(out).toBeNull();
    expect(store.getAggregatedSlots(runId)[0].status).toBe('candidate'); // 미변경
    expect(store.getLatestCheckpoint(runId)).toBeUndefined();
  });

  it('brain 미주입 → null no-op', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 10, intervalMs: 1, startedAt: 'T' });
    const reviewer = new CheckpointReviewer({ store });
    expect(await reviewer.review(runId, 10, 10, [slot()], 1)).toBeNull();
  });

  it('brain.reviewCheckpoint 예외 → null(장애 격리)', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 10, intervalMs: 1, startedAt: 'T' });
    const slots = [slot({ clusterId: 1 })];
    store.replaceAggregatedSlots(runId, slots);
    const throwingBrain = { enabled: true, reviewCheckpoint: async () => { throw new Error('LLM 실패'); } } as unknown as SetupBrain;
    const reviewer = new CheckpointReviewer({ store, brain: throwingBrain });
    expect(await reviewer.review(runId, 10, 10, slots, 1)).toBeNull();
    expect(store.getLatestCheckpoint(runId)).toBeUndefined();
  });
});

// ── Finalizer ─────────────────────────────────────────
/** 런에 안정 클러스터(support>=3) 1개를 만들도록 검출 적재. */
function seedStableRun(store: SqliteStore, presetIdx = 1): number {
  const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T' });
  for (const round of [1, 2, 3]) {
    const obs = store.insertObservation({ runId, roundIdx: round, camIdx: 1, presetIdx, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(obs, 1, presetIdx, [{ kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 }]);
  }
  return runId;
}

describe('Finalizer 결정형 강등 (G4 — LLM off)', () => {
  it('brain 미주입 → 결정형 산출(candidate 채택, zone=cam{N}, report 없음)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    const { repo, saved } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);

    expect(r.slots).toBe(1);
    expect(r.globalCount).toBe(1);
    // SetupArtifact shape.
    expect(r.artifact.slots).toHaveLength(1);
    expect(r.artifact.globalIndex).toHaveLength(1);
    expect(r.artifact.createdAt).toBe('T');
    expect(r.artifact.report).toBeUndefined(); // LLM off → report 없음
    // zone 기본값.
    expect(r.artifact.slots[0].zone).toBe('cam1');
    // globalIndex 1-based.
    expect(r.artifact.globalIndex[0].globalIdx).toBe(1);
    // 저장 호출 + 스냅샷 기록.
    expect(saved).toHaveLength(1);
    expect(store.getAggregatedSlots(runId).length).toBeGreaterThan(0);
  });

  it('rejected 클러스터는 채택 제외(노이즈)', async () => {
    const store = mem();
    // 안정 클러스터 1 + 노이즈(1회) 1.
    const runId = store.createRun({ plannedCount: 3, intervalMs: 1, startedAt: 'T' });
    for (const round of [1, 2, 3]) {
      const obs = store.insertObservation({ runId, roundIdx: round, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
      store.insertDetections(obs, 1, 1, [{ kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9 }]);
    }
    const obsN = store.insertObservation({ runId, roundIdx: 1, camIdx: 1, presetIdx: 1, capturedAt: 'C', pan: 0, tilt: 0, zoom: 1, imgName: 'x' });
    store.insertDetections(obsN, 1, 1, [{ kind: 'vehicle', x: 0.8, y: 0.8, w: 0.1, h: 0.1, conf: 0.9 }]);

    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    expect(r.slots).toBe(1); // 노이즈 제외, 안정 1개만
  });
});

describe('Finalizer LLM 활성 (G4 — fake brain)', () => {
  function finalizeBrain(result: FinalizeCaptureResult): SetupBrain {
    return {
      enabled: true,
      judgePreset: async () => null, dedupeAndLabel: async () => null, finalReport: async () => null,
      finalizeCapture: async () => result,
    } as unknown as SetupBrain;
  }

  it('zoneLabels/report 반영, ROI 좌표는 집계 대표 bbox 그대로(불변)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    const { repo } = fakeRepo();
    // 집계 후 slotId 예측: c1p1s1.
    const brain = finalizeBrain({ duplicates: [], zoneLabels: { c1p1s1: 'A구역' }, rejects: [], report_ko: '정밀 수집 리포트' });
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, brain, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);

    expect(r.artifact.slots[0].zone).toBe('A구역'); // 라벨 반영
    expect(r.artifact.report).toBe('정밀 수집 리포트');
    // ★ 좌표 불변식: roi = 집계 대표 bbox(0.3,0.3,0.1,0.1) — roiPadding 0.
    const roi = r.artifact.slots[0].roiByPreset['1:1'];
    expect(roi).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });

  it('LLM rejects → 채택 제외(좌표 미생성)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    const { repo } = fakeRepo();
    const brain = finalizeBrain({ duplicates: [], zoneLabels: {}, rejects: ['1:1#1'], report_ko: '' });
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, brain, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    expect(r.slots).toBe(0); // LLM 이 유일 클러스터 거부 → 채택 0
  });

  it('finalizeCapture 예외 → 결정형 강등(채택 유지, report 없음)', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    const { repo } = fakeRepo();
    const brain = { enabled: true, finalizeCapture: async () => { throw new Error('LLM 폭발'); } } as unknown as SetupBrain;
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, brain, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    expect(r.slots).toBe(1);
    expect(r.artifact.report).toBeUndefined();
  });

  it('체크포인트 status(merged/rejected) 보존 — 재집계가 덮어쓰지 않음', async () => {
    const store = mem();
    const runId = seedStableRun(store);
    // 사전 집계 후 status 를 merged 로 표시(체크포인트 효과 모사).
    const dets = store.getDetectionsForRun(runId);
    expect(dets.length).toBeGreaterThan(0);
    // finalize 가 fresh 집계 후 prior status 를 병합 보존하는지: 미리 aggregated_slot 에 merged 기록.
    store.replaceAggregatedSlots(runId, [slot({ clusterId: 1, presetKey: '1:1', x: 0.3, y: 0.3, w: 0.1, h: 0.1, status: 'merged' })]);
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(runId);
    // merged 는 채택(candidate)이 아니므로 제외 → slots 0.
    expect(r.slots).toBe(0);
  });
});
