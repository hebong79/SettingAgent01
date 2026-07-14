import { describe, it, expect, afterEach } from 'vitest';
import { FloorRoiReviewer } from '../src/capture/FloorRoiReviewer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { buildPlateAnchoredQuad, resolveFloorPolygon } from '../src/capture/floorRoi.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { NormalizedRect } from '../src/domain/types.js';
import type { SetupBrain, FloorRoiResult, FloorRoiInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): FloorRoiReviewer (설계서 §5 · 가변 다각형).
 * 프레임 있는 프리셋만 upsert; brain 비활성 → 폴백 다각형; LLM throw → 폴백; maxPerCheckpoint 상한.
 */

/** 점이 볼록 N각형 내부/경계에 있는지 — cross product 부호 일관성(경계 포함). */
function pointInConvex(p: { x: number; y: number }, q: Array<{ x: number; y: number }>): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i += 1) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue; // 변 위 → 통과.
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const slot = (over: Partial<AggregatedSlot> = {}): AggregatedSlot => ({
  presetKey: '1:1', clusterId: 1, camIdx: 1, presetIdx: 1,
  x: 0.2, y: 0.2, w: 0.1, h: 0.1, support: 3, occupancyRate: 0.5,
  plateX: null, plateY: null, plateW: null, plateH: null, plateQuad: null,
  confidence: 0, posSpread: 0, angleSpread: null, status: 'candidate', ...over,
});

const goodResult: FloorRoiResult = {
  polygon: [
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
    // 저장 다각형 = LLM 결과에 결정형 후처리(정규화·마진·예상번호판 포함) 적용값.
    expect(got[0].polygon).toEqual(resolveFloorPolygon(goodResult.polygon, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }));
  });

  it('brain 비활성(enabled=false) → 폴백 생성 + llmUnavailable:true', async () => {
    // no-op 폐기(설계 §5·§7.2 케이스7): brain 비활성이어도 폴백으로 항상 생성 + 경고 플래그.
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ enabled: false }), now: () => 'U' });
    const res = await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].polygon).toEqual(buildPlateAnchoredQuad({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 }));
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('recognizeFloorRoi 미지원 → 폴백 생성 + llmUnavailable:true', async () => {
    // 메서드 부재도 !llmUsable → 폴백 + 경고(설계 §7.2 케이스8).
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ hasMethod: false }), now: () => 'U' });
    const res = await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].polygon).toEqual(buildPlateAnchoredQuad({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('brain 없음(undefined) → 폴백 생성 + llmUnavailable:true', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store, now: () => 'U' }); // brain 미주입
    const res = await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    expect(store.getFloorRois(runId)).toHaveLength(1);
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('LLM throw → 폴백 quad 로 upsert(floor ROI 항상 존재) + attempted>0·succeeded=0 → llmUnavailable:true', async () => {
    // 리더 확정 조건(구현요약 §B): 시도했으나 전 슬롯 실패(succeeded=0) → 경고로 승격.
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ throws: true }), now: () => 'U' });
    const res = await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    const got = store.getFloorRois(runId);
    expect(got).toHaveLength(1);
    expect(got[0].polygon).toEqual(buildPlateAnchoredQuad({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 }));
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('정상 LLM 성공(succeeded>0) → llmUnavailable:false', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({}), now: () => 'U' });
    const res = await reviewer.review(runId, [slot()], frames([['1:1', 'jpg']]));
    expect(res).toEqual({ llmUnavailable: false });
  });

  it('무효 결과(null) → 폴백', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const v = slot({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({ result: null }), now: () => 'U' });
    await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    expect(store.getFloorRois(runId)[0].polygon).toEqual(buildPlateAnchoredQuad({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));
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

  it('shouldStop=()=>true → 첫 슬롯 전 break, recognizeFloorRoi 미호출(진행 중 checkpoint 조기탈출)', async () => {
    // 설계 §1-3(c)/구현 §4: 슬롯 루프 각 반복 시작에서 shouldStop 확인 → true 면 즉시 break.
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const slots = [1, 2, 3].map((id) => slot({ clusterId: id }));
    let calls = 0;
    const reviewer = new FloorRoiReviewer({
      store, brain: fakeBrain({ onCall: () => { calls += 1; } }), now: () => 'U',
    });
    await reviewer.review(runId, slots, frames([['1:1', 'jpg']]), () => true);
    expect(calls).toBe(0); // 첫 슬롯 전에 탈출 → LLM 호출 0
    expect(store.getFloorRois(runId)).toHaveLength(0); // upsert 도 없음
  });

  it('shouldStop 이 2번째 슬롯에서 true → 첫 슬롯만 처리(부분 진행 후 조기탈출)', async () => {
    // 후보 수보다 적게 호출됨을 검증(첫 슬롯 처리 후 stopping 감지).
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const slots = [1, 2, 3, 4].map((id) => slot({ clusterId: id }));
    let calls = 0;
    let stop = false;
    const reviewer = new FloorRoiReviewer({
      store, brain: fakeBrain({ onCall: () => { calls += 1; stop = true; } }), now: () => 'U',
    });
    await reviewer.review(runId, slots, frames([['1:1', 'jpg']]), () => stop);
    expect(calls).toBe(1); // 첫 슬롯 처리 후 shouldStop=true → 2번째 반복 시작에서 break
    expect(calls).toBeLessThan(slots.length); // 후보 수보다 적음
    expect(store.getFloorRois(runId)).toHaveLength(1);
  });

  it('shouldStop 미전달(undefined) → 기존 동작 동일(하위호환, 전 슬롯 처리)', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const slots = [1, 2, 3].map((id) => slot({ clusterId: id }));
    let calls = 0;
    const reviewer = new FloorRoiReviewer({
      store, brain: fakeBrain({ onCall: () => { calls += 1; } }), now: () => 'U',
    });
    await reviewer.review(runId, slots, frames([['1:1', 'jpg']])); // shouldStop 없음
    expect(calls).toBe(3); // 전 슬롯 처리
    expect(store.getFloorRois(runId)).toHaveLength(3);
  });

  it('plate 가 있어도 LLM 입력에 plate/plateQuad 미전달(vehicle 만)', async () => {
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    let received: FloorRoiInput | undefined;
    const reviewer = new FloorRoiReviewer({
      store, brain: fakeBrain({ onCall: (i) => { received = i; } }), now: () => 'U',
    });
    const v = slot({ plateX: 0.3, plateY: 0.6, plateW: 0.05, plateH: 0.03 });
    await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    // 권위 역전: 번호판 신호는 LLM 입력에서 차단. vehicle 은 대상 표시용으로 전달.
    expect(received?.vehicle).toEqual({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 });
    const keys = Object.keys(received as object);
    expect(keys).not.toContain('plate');
    expect(keys).not.toContain('plateQuad');
  });

  it('정상 LLM + plate → 저장 다각형 = LLM 좌표(메인), plate 포함강제 안함', async () => {
    // goodResult.polygon: front y=0.9, rear y=0.6, x∈[0.2..0.5]. plate 를 우측 밖에 둠 → 이제 삼키지 않음.
    const store = mem();
    const runId = store.createRun({ plannedCount: 1, intervalMs: 1, startedAt: 'T' });
    const plate: NormalizedRect = { x: 0.6, y: 0.65, w: 0.1, h: 0.05 }; // 우측(0.6~0.7) > 다각형 우측(0.5)
    const v = slot({ plateX: plate.x, plateY: plate.y, plateW: plate.w, plateH: plate.h });
    const reviewer = new FloorRoiReviewer({ store, brain: fakeBrain({}), now: () => 'U' });
    await reviewer.review(runId, [v], frames([['1:1', 'jpg']]));
    const q = store.getFloorRois(runId)[0].polygon;
    // 저장값 = LLM 유효 폴리곤을 안전망만 통과시킨 결과(번호판 앵커·포함강제 없음).
    expect(q).toEqual(resolveFloorPolygon(goodResult.polygon, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }));
    // 밖 plate 4모서리는 포함되지 않음.
    expect(pointInConvex({ x: 0.7, y: 0.65 }, q)).toBe(false);
  });
});
