import { describe, it, expect } from 'vitest';
import { FloorRoiReviewer } from '../src/capture/FloorRoiReviewer.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SetupBrain, FloorRoiResult, FloorRoiInput } from '../src/brain/SetupBrain.js';

/**
 * 검증자(qa-tester): FloorRoiReviewer (설계서 §5 · 가변 다각형 — DB 스키마 개편 후 재작성).
 * ★ FloorRoiReviewer 는 더 이상 영속하지 않는다(구 store.upsertFloorRoi/getFloorRois 폐기 —
 *   산출 폴리곤은 resolveFloorPolygon 호출 후 void 로 버려진다, 캡처 루프 배선 제거·설계서 §6.5).
 *   따라서 이 스위트는 저장 결과가 아니라 **반환값({llmUnavailable})과 brain 호출 상호작용**만 검증한다.
 *   store 의존성은 타입만 요구되고 미사용 — 최소 fake 로 대체(실 DB 연결 불필요).
 */

const fakeStore = {} as unknown as SqliteStore;

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

const frames = (entries: Array<[string, string]>) =>
  new Map(entries.map(([k, v]) => [k, Buffer.from(v)] as [string, Buffer]));

describe('FloorRoiReviewer', () => {
  it('프레임 있는 프리셋만 호출(없으면 skip)', async () => {
    const slots = [slot({ presetKey: '1:1', clusterId: 1 }), slot({ presetKey: '1:2', clusterId: 1, camIdx: 1, presetIdx: 2 })];
    let calls = 0;
    const reviewer = new FloorRoiReviewer({ store: fakeStore, brain: fakeBrain({ onCall: () => { calls += 1; } }), now: () => 'U' });
    const res = await reviewer.review(1, slots, frames([['1:1', 'jpg']])); // 1:2 프레임 없음 → skip
    expect(calls).toBe(1); // 프레임 있는 1:1 만 시도
    expect(res).toEqual({ llmUnavailable: false });
  });

  it('brain 비활성(enabled=false) → 폴백 사용 + llmUnavailable:true, LLM 미호출', async () => {
    // brain 비활성이어도 결정형 폴백으로 항상 floor ROI 산출(내부, 미영속) + 경고 플래그.
    let calls = 0;
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store: fakeStore, brain: fakeBrain({ enabled: false, onCall: () => { calls += 1; } }), now: () => 'U' });
    const res = await reviewer.review(1, [v], frames([['1:1', 'jpg']]));
    expect(res).toEqual({ llmUnavailable: true });
    expect(calls).toBe(0); // enabled=false → llmUsable=false → recognizeFloorRoi 미호출
  });

  it('recognizeFloorRoi 미지원 → 폴백 사용 + llmUnavailable:true, LLM 미호출', async () => {
    // 메서드 부재도 !llmUsable → 폴백 + 경고(설계 §7.2 케이스8).
    let calls = 0;
    const v = slot({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const reviewer = new FloorRoiReviewer({ store: fakeStore, brain: fakeBrain({ hasMethod: false, onCall: () => { calls += 1; } }), now: () => 'U' });
    const res = await reviewer.review(1, [v], frames([['1:1', 'jpg']]));
    expect(res).toEqual({ llmUnavailable: true });
    expect(calls).toBe(0);
  });

  it('brain 없음(undefined) → 폴백 사용 + llmUnavailable:true', async () => {
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store: fakeStore, now: () => 'U' }); // brain 미주입
    const res = await reviewer.review(1, [v], frames([['1:1', 'jpg']]));
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('LLM throw → attempted>0·succeeded=0 → llmUnavailable:true(폴백은 내부에서 항상 산출·미영속)', async () => {
    // 리더 확정 조건(구현요약 §B): 시도했으나 전 슬롯 실패(succeeded=0) → 경고로 승격.
    let calls = 0;
    const v = slot({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    const reviewer = new FloorRoiReviewer({ store: fakeStore, brain: fakeBrain({ throws: true, onCall: () => { calls += 1; } }), now: () => 'U' });
    const res = await reviewer.review(1, [v], frames([['1:1', 'jpg']]));
    expect(calls).toBe(1); // 시도는 함
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('정상 LLM 성공(succeeded>0) → llmUnavailable:false', async () => {
    const reviewer = new FloorRoiReviewer({ store: fakeStore, brain: fakeBrain({}), now: () => 'U' });
    const res = await reviewer.review(1, [slot()], frames([['1:1', 'jpg']]));
    expect(res).toEqual({ llmUnavailable: false });
  });

  it('무효 결과(null) → attempted>0·succeeded=0 → llmUnavailable:true', async () => {
    const v = slot({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    let calls = 0;
    const reviewer = new FloorRoiReviewer({ store: fakeStore, brain: fakeBrain({ result: null, onCall: () => { calls += 1; } }), now: () => 'U' });
    const res = await reviewer.review(1, [v], frames([['1:1', 'jpg']]));
    expect(calls).toBe(1);
    expect(res).toEqual({ llmUnavailable: true });
  });

  it('rejected/merged 슬롯은 제외(호출 대상에서 빠짐)', async () => {
    const slots = [
      slot({ clusterId: 1, status: 'candidate' }),
      slot({ clusterId: 2, status: 'rejected' }),
      slot({ clusterId: 3, status: 'merged' }),
    ];
    const seenClusters: number[] = [];
    const reviewer = new FloorRoiReviewer({
      store: fakeStore, brain: fakeBrain({ onCall: (i) => { seenClusters.push(Number(i.slotHint?.split('#')[1])); } }), now: () => 'U',
    });
    const res = await reviewer.review(1, slots, frames([['1:1', 'jpg']]));
    expect(seenClusters).toEqual([1]); // candidate(clusterId=1) 만 호출됨
    expect(res).toEqual({ llmUnavailable: false });
  });

  it('maxPerCheckpoint 상한 준수', async () => {
    const slots = [1, 2, 3, 4, 5].map((id) => slot({ clusterId: id }));
    let calls = 0;
    const reviewer = new FloorRoiReviewer({
      store: fakeStore, brain: fakeBrain({ onCall: () => { calls += 1; } }), maxPerCheckpoint: 2, now: () => 'U',
    });
    await reviewer.review(1, slots, frames([['1:1', 'jpg']]));
    expect(calls).toBe(2);
  });

  it('shouldStop=()=>true → 첫 슬롯 전 break, recognizeFloorRoi 미호출(진행 중 checkpoint 조기탈출)', async () => {
    // 설계 §1-3(c)/구현 §4: 슬롯 루프 각 반복 시작에서 shouldStop 확인 → true 면 즉시 break.
    const slots = [1, 2, 3].map((id) => slot({ clusterId: id }));
    let calls = 0;
    const reviewer = new FloorRoiReviewer({
      store: fakeStore, brain: fakeBrain({ onCall: () => { calls += 1; } }), now: () => 'U',
    });
    await reviewer.review(1, slots, frames([['1:1', 'jpg']]), () => true);
    expect(calls).toBe(0); // 첫 슬롯 전에 탈출 → LLM 호출 0
  });

  it('shouldStop 이 2번째 슬롯에서 true → 첫 슬롯만 처리(부분 진행 후 조기탈출)', async () => {
    // 후보 수보다 적게 호출됨을 검증(첫 슬롯 처리 후 stopping 감지).
    const slots = [1, 2, 3, 4].map((id) => slot({ clusterId: id }));
    let calls = 0;
    let stop = false;
    const reviewer = new FloorRoiReviewer({
      store: fakeStore, brain: fakeBrain({ onCall: () => { calls += 1; stop = true; } }), now: () => 'U',
    });
    await reviewer.review(1, slots, frames([['1:1', 'jpg']]), () => stop);
    expect(calls).toBe(1); // 첫 슬롯 처리 후 shouldStop=true → 2번째 반복 시작에서 break
    expect(calls).toBeLessThan(slots.length); // 후보 수보다 적음
  });

  it('shouldStop 미전달(undefined) → 기존 동작 동일(하위호환, 전 슬롯 처리)', async () => {
    const slots = [1, 2, 3].map((id) => slot({ clusterId: id }));
    let calls = 0;
    const reviewer = new FloorRoiReviewer({
      store: fakeStore, brain: fakeBrain({ onCall: () => { calls += 1; } }), now: () => 'U',
    });
    await reviewer.review(1, slots, frames([['1:1', 'jpg']])); // shouldStop 없음
    expect(calls).toBe(3); // 전 슬롯 처리
  });

  it('plate 가 있어도 LLM 입력에 plate/plateQuad 미전달(vehicle 만)', async () => {
    let received: FloorRoiInput | undefined;
    const reviewer = new FloorRoiReviewer({
      store: fakeStore, brain: fakeBrain({ onCall: (i) => { received = i; } }), now: () => 'U',
    });
    const v = slot({ plateX: 0.3, plateY: 0.6, plateW: 0.05, plateH: 0.03 });
    await reviewer.review(1, [v], frames([['1:1', 'jpg']]));
    // 권위 역전: 번호판 신호는 LLM 입력에서 차단. vehicle 은 대상 표시용으로 전달.
    expect(received?.vehicle).toEqual({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 });
    const keys = Object.keys(received as object);
    expect(keys).not.toContain('plate');
    expect(keys).not.toContain('plateQuad');
  });
});
