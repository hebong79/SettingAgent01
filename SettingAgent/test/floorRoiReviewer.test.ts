import { describe, it, expect, afterEach } from 'vitest';
import { FloorRoiReviewer } from '../src/capture/FloorRoiReviewer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { fallbackQuadFromRect } from '../src/capture/floorRoi.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { SetupBrain, FloorRoiResult, FloorRoiInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): FloorRoiReviewer (설계서 §5.2).
 * 프레임 있는 프리셋만 upsert; brain 비활성 no-op; LLM throw → 폴백 quad; maxPerCheckpoint 상한.
 */

const slot = (over: Partial<AggregatedSlot> = {}): AggregatedSlot => ({
  presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1,
  x: 0.2, y: 0.2, w: 0.1, h: 0.1, support: 3, occupancyRate: 0.5,
  plateX: null, plateY: null, plateW: null, plateH: null, status: 'candidate', ...over,
});

const goodResult: FloorRoiResult = {
  quad: [
    { x: 0.2, y: 0.9 },
    { x: 0.5, y: 0.9 },
    { x: 0.45, y: 0.6 },
    { x: 0.25, y: 0.6 },
  ],
  confidence: 0.8,
};

function fakeBrain(opts: {
  enabled?: boolean;
  hasMethod?: boolean;
  result?: FloorRoiResult | null; // 키 자체가 없으면 goodResult, null 이면 명시적 null 반환.
  throws?: boolean;
  onCall?: (input: FloorRoiInput) => void;
}): SetupBrain {
  const hasResultKey = Object.prototype.hasOwnProperty.call(opts, 'result');
  const base: Record<string, unknown> = { enabled: opts.enabled ?? true };
  if (opts.hasMethod !== false) {
    base.recognizeFloorRoi = async (input: FloorRoiInput) => {
      opts.onCall?.(input);
      if (opts.throws) throw new Error('LLM 폭발');
      return hasResultKey ? opts.result : goodResult;
    };
  }
  return base as unknown as SetupBrain;
}

let stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* noop */ } } stores = []; });
function mem(): SqliteStore { const s = new SqliteStore(':memory:'); stores.push(s); return s; }

const frames = (entries: Array<[string, string]>) =>
  new Map(entries.map(([k, v]) => [k, Buffer.from(v)] as [string, Buffer]));

describe('FloorRoiReviewer', () => {
  it('프레임 있는 프리셋만 upsert(없으면 skip)', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const slots = [slot({ presetKey: '1:1', clusterId: 1 }), slot({ presetKey: '1:2', clusterId: 1, camIdx: 1, presetIdx: 2 })];
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({}), now: () => 'U' });
    await reviewer.review(runId, slots, frames([['1:1', 'jpg']])); // 1:2 프레임 없음 → skip
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].presetKey).toBe('1:1');
    expect(got[0].quad).toEqual(goodResult.quad);
  });

  it('brain 비활성(enabled=false) → no-op', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ enabled: false }) });
    await reviewer.review(runId, [slot()], frames([['1:1', 'jpg']]));
    expect(store.getFloorRois(runId)).toHaveLength(0);
  });

  it('recognizeFloorRoi 미지원 → no-op', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ hasMethod: false }) });
    await reviewer.review(runId, [slot()], frames([['1:1', 'jpg']]));
    expect(store.getFloorRois(runId)).toHaveLength(0);
  });

  it('LLM throw → 폴백 quad 로 upsert(floor ROI 항상 존재)', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ throws: true }), now: () => 'U' });
    await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].quad).toEqual(fallbackQuadFromRect({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 }));
  });

  it('무효 quad(null) → 폴백', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ result: null }), now: () => 'U' });
    await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    expect(store.getFloorRois(runId)[0].quad).toEqual(fallbackQuadFromRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));
  });

  it('rejected/merged 슬롯은 제외', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const slots = [
      slot({ clusterId: 1, status: 'candidate' }),
      slot({ clusterId: 2, status: 'rejected' }),
      slot({ clusterId: 3, status: 'merged' }),
    ];
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({}), now: () => 'U' });
    await reviewer.review(runId, slots, frames([['1:1', 'jpg']]));
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].clusterId).toBe(1);
  });

  it('maxPerCheckpoint 상한 준수', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const slots = [1, 2, 3, 4, 5].map((id) => slot({ clusterId: id }));
    let calls = 0;
    const reviewer = new FloorRoiReviewer({
      store, brain: fakeBrain({ onCall: () => { calls += 1; } }), maxPerCheckpoint: 2, now: () => 'U',
    });
    await reviewer.review(runId, slots, frames([['1:1', 'jpg']]));
    expect(calls).toBe(2);
    expect(store.getFloorRois(runId)).toHaveLength(2);
  });

  it('plate 가 있으면 input.plate 로 전달', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    let received: FloorRoiInput | undefined;
    const reviewer = new FloorRoiReviewer({
      store, brain: fakeBrain({ onCall: (i) => { received = i; } }), now: () => 'U',
    });
    const v = slot({ plateX: 0.3, plateY: 0.6, plateW: 0.05, plateH: 0.03 });
    await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    expect(received?.plate).toEqual({ x: 0.3, y: 0.6, w: 0.05, h: 0.03 });
  });
});
