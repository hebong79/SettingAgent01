import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointReviewer, clusterRef, advisoryLines } from '../src/capture/CheckpointReviewer.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SaveStore } from '../src/store/SaveStore.js';
import type { AggregatedSlot, DetectionRow } from '../src/capture/types.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { SetupBrain, CheckpointResult, FinalizeCaptureResult } from '../src/brain/SetupBrain.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import { stringify5 } from '../src/util/round.js';

/**
 * 검증자(qa-tester): CheckpointReviewer/Finalizer (G4 — fake brain).
 * 핵심: merges/labels/rejects 가 status/zone 에 반영되되 ROI 좌표는 불변(§8 좌표 불변식).
 * Finalizer → SetupArtifact shape·globalIndex·saveArtifact.
 * llm.enabled=false 결정형 강등(체크포인트 no-op, 집계만 산출).
 * ★ 설계서 §2.3: DB 중간테이블(run/observation/detection/aggregated_slot/checkpoint) 전면 폐기.
 *   CheckpointReviewer.review 는 인메모리 slots 배열을 직접 mutate(참조 동일성) — DB 무접촉.
 *   Finalizer.finalize 는 runId 대신 인메모리 CaptureSnapshot 을 받는다(DB 재조회 없음).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};

const slot = (over: Partial<AggregatedSlot> = {}): AggregatedSlot => ({
  presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1,
  x: 0.2, y: 0.2, w: 0.1, h: 0.1, support: 3, occupancyRate: 0.5,
  plateX: null, plateY: null, plateW: null, plateH: null, plateQuad: null,
  confidence: 0, posSpread: 0, angleSpread: null, status: 'candidate', ...over,
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

// ── CheckpointReviewer (좌표 불변, 인메모리 slots 직접 mutate) ─────────────────────
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
    const slots = [
      slot({ clusterId: 1, x: 0.20, y: 0.21, w: 0.10, h: 0.11 }),
      slot({ clusterId: 2, x: 0.50, y: 0.51, w: 0.12, h: 0.13 }),
      slot({ clusterId: 3, x: 0.80, y: 0.81, w: 0.14, h: 0.15 }),
    ];

    const result: CheckpointResult = {
      merges: [['1:1#2', '1:1#3']], // 2번째(#3)부터 merged
      labels: {}, rejects: ['1:1#1'], // #1 rejected
      coverage: [], convergence: { converged: false, advice: '' },
    };
    const reviewer = new CheckpointReviewer({ store, brain: fakeBrain(result), now: () => 'C' });
    const out = await reviewer.review(1, 10, 10, slots, 2);
    expect(out).not.toBeNull();

    // review 는 인메모리 slots 배열을 참조 동일성으로 직접 mutate(구 DB 재조회 대체).
    const byCluster = new Map(slots.map((s) => [s.clusterId, s]));
    expect(byCluster.get(1)!.status).toBe('rejected');
    expect(byCluster.get(3)!.status).toBe('merged');
    expect(byCluster.get(2)!.status).toBe('candidate'); // merges 그룹 첫 항목은 유지

    // ★ 좌표 불변식: status 만 바뀌고 bbox 좌표는 그대로.
    expect({ x: byCluster.get(1)!.x, y: byCluster.get(1)!.y, w: byCluster.get(1)!.w, h: byCluster.get(1)!.h })
      .toEqual({ x: 0.20, y: 0.21, w: 0.10, h: 0.11 });
    expect({ x: byCluster.get(3)!.x, y: byCluster.get(3)!.y, w: byCluster.get(3)!.w, h: byCluster.get(3)!.h })
      .toEqual({ x: 0.80, y: 0.81, w: 0.14, h: 0.15 });
  });

  it('LLM 비활성(enabled=false) → null no-op, status 미변경', async () => {
    const store = mem();
    const slots = [slot({ clusterId: 1, status: 'candidate' })];
    const disabledBrain = { enabled: false, reviewCheckpoint: async () => ({ merges: [], labels: {}, rejects: ['1:1#1'], coverage: [], convergence: { converged: false, advice: '' } }) } as unknown as SetupBrain;
    const reviewer = new CheckpointReviewer({ store, brain: disabledBrain });
    const out = await reviewer.review(1, 10, 10, slots, 1);
    expect(out).toBeNull();
    expect(slots[0].status).toBe('candidate'); // 미변경
  });

  it('brain 미주입 → null no-op', async () => {
    const store = mem();
    const reviewer = new CheckpointReviewer({ store });
    expect(await reviewer.review(1, 10, 10, [slot()], 1)).toBeNull();
  });

  it('brain.reviewCheckpoint 예외 → null(장애 격리)', async () => {
    const store = mem();
    const slots = [slot({ clusterId: 1 })];
    const throwingBrain = { enabled: true, reviewCheckpoint: async () => { throw new Error('LLM 실패'); } } as unknown as SetupBrain;
    const reviewer = new CheckpointReviewer({ store, brain: throwingBrain });
    expect(await reviewer.review(1, 10, 10, slots, 1)).toBeNull();
  });
});

// ── Finalizer ─────────────────────────────────────────
/** 안정 클러스터(support>=3) 1개분 DetectionRow + presetRounds(구 seedStableRun DB 시드 대체). */
function detsStable(presetIdx = 1): { dets: DetectionRow[]; presetRounds: Map<string, number> } {
  const dets: DetectionRow[] = [1, 2, 3].map((round) => ({
    observationId: round, roundIdx: round, camIdx: 1, presetIdx, kind: 'vehicle', x: 0.3, y: 0.3, w: 0.1, h: 0.1, conf: 0.9,
  }));
  return { dets, presetRounds: new Map([[`1:${presetIdx}`, 3]]) };
}

/** dets/presetRounds(+선택적 prior aggregated) → CaptureSnapshot. aggregated 미지정 시 빈 배열(= prior status 없음). */
function snapshotOf(dets: DetectionRow[], presetRounds: Map<string, number>, aggregated: AggregatedSlot[] = []): CaptureSnapshot {
  return { dets, presetRounds, aggregated, occByPreset: new Map() };
}

describe('Finalizer 결정형 강등 (G4 — LLM off)', () => {
  it('brain 미주입 → 결정형 산출(candidate 채택, zone=cam{N}, report 없음)', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    const { repo, saved } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));

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
    // 저장 호출.
    expect(saved).toHaveLength(1);
  });

  it('rejected 클러스터는 채택 제외(노이즈)', async () => {
    const store = mem();
    // 안정 클러스터 1 + 노이즈(1회) 1.
    const { dets, presetRounds } = detsStable();
    dets.push({ observationId: 4, roundIdx: 1, camIdx: 1, presetIdx: 1, kind: 'vehicle', x: 0.8, y: 0.8, w: 0.1, h: 0.1, conf: 0.9 });

    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));
    expect(r.slots).toBe(1); // 노이즈 제외, 안정 1개만
  });
});

describe('Finalizer 자동 스냅샷 저장(save/)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

  it('saveStore 주입 → finalize 시 save/ 에 스냅샷 1건 생성(내용=artifact)', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    const { repo } = fakeRepo();
    dir = mkdtempSync(join(tmpdir(), 'fin-save-'));
    const saveStore = new SaveStore(dir);
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T', saveStore });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));
    const list = saveStore.list();
    expect(list).toHaveLength(1);
    // ★ 영속화 5자리: SaveStore.save 가 stringify5 로 기록 → 로드본은 floorRoi 등 좌표가 5자리(예:
    //   0.39999999999999997→0.4). in-memory artifact 를 동일 stringify5 정규화(JSON 왕복)한 값과 비교 —
    //   저장 내용이 artifact 와 (5자리 영속화 규약 하에서) 일치함을 검증(구조·shape 검증 의도 유지).
    expect(saveStore.load(list[0].name)).toEqual(JSON.parse(stringify5(r.artifact)));
  });

  it('saveStore 미주입 → 예외 없이 finalize(기존 동작 불변)', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));
    expect(r.slots).toBe(1);
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
    const { dets, presetRounds } = detsStable();
    const { repo } = fakeRepo();
    // 집계 후 slotId 예측: c1p1s1.
    const brain = finalizeBrain({ duplicates: [], zoneLabels: { c1p1s1: 'A구역' }, rejects: [], report_ko: '정밀 수집 리포트' });
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, brain, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));

    expect(r.artifact.slots[0].zone).toBe('A구역'); // 라벨 반영
    expect(r.artifact.report).toBe('정밀 수집 리포트');
    // ★ 좌표 불변식: roi = 집계 대표 bbox(0.3,0.3,0.1,0.1) — roiPadding 0.
    const roi = r.artifact.slots[0].roiByPreset['1:1'];
    expect(roi).toEqual({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 });
  });

  it('LLM rejects → 채택 제외(좌표 미생성)', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    const { repo } = fakeRepo();
    const brain = finalizeBrain({ duplicates: [], zoneLabels: {}, rejects: ['1:1#1'], report_ko: '' });
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, brain, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));
    expect(r.slots).toBe(0); // LLM 이 유일 클러스터 거부 → 채택 0
  });

  it('finalizeCapture 예외 → 결정형 강등(채택 유지, report 없음)', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    const { repo } = fakeRepo();
    const brain = { enabled: true, finalizeCapture: async () => { throw new Error('LLM 폭발'); } } as unknown as SetupBrain;
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, brain, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds));
    expect(r.slots).toBe(1);
    expect(r.artifact.report).toBeUndefined();
  });

  it('체크포인트 status(merged/rejected) 보존 — 재집계가 덮어쓰지 않음', async () => {
    const store = mem();
    const { dets, presetRounds } = detsStable();
    // 체크포인트가 이미 남긴 status(merged)를 snapshot.aggregated 로 전달 → finalize 의 fresh 재집계가 덮어쓰지 않고 보존해야 함.
    const priorAggregated = [slot({ clusterId: 1, presetKey: '1:1', x: 0.3, y: 0.3, w: 0.1, h: 0.1, status: 'merged' })];
    const { repo } = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const r = await finalizer.finalize(snapshotOf(dets, presetRounds, priorAggregated));
    // merged 는 채택(candidate)이 아니므로 제외 → slots 0.
    expect(r.slots).toBe(0);
  });
});
