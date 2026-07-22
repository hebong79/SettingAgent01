import { describe, it, expect, vi } from 'vitest';
import { SetupPipeline, type SetupPipelineDeps } from '../src/pipeline/SetupPipeline.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { CalibrateStatus } from '../src/calibrate/types.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): SetupPipeline.startPrecise (설계서 §11.1 U1·U2·U3).
 *
 * 정밀수집 '시작' 경로는 수집(CaptureJob)·최종화(Finalizer) 를 **거치지 않는다**:
 *   idle → discovering → (1s 대기) → calibrating → done
 * 외부(카메라/LPD/DB/파일) 전부 스텁. `sleep` 은 deps 시임으로 가로채 **호출 인자·횟수**를 관측한다
 * (실시간 대기 없음 — 테스트 결정성).
 *
 * 경계면 교차: discovery.start / calibrator.start 의 **실제 시그니처**와 대조한다.
 *   - PlateDiscoveryJob.start(filter, {betweenSlotMs, occupySettleMs})
 *   - PtzCalibrator.start(slotIds?, {betweenSlotMs, camera})
 */

/** 앞면중심 보유 뷰(=expandDiscoveryTargets 대상). withLpd → 센터라이징 대상(expandPlateTargetsFromSlotSetup). */
function view(slotId: number, opts: { front?: boolean; lpd?: boolean } = {}): SlotSetupView {
  const front = opts.front ?? true;
  return {
    slotId, camId: 1, presetId: 1, presetSlotIdx: slotId, presetKey: '1:1',
    roi: [], vpd: null,
    lpd: opts.lpd ? rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) : null,
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null,
    slot3dFrontCenter: front ? { x: 0.5, y: 0.5 } : null,
    updatedAt: null,
  };
}

interface Harness {
  pipeline: SetupPipeline;
  discoverStart: ReturnType<typeof vi.fn>;
  calStart: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
  sleeps: number[];
}

function makeHarness(opts: { views?: SlotSetupView[]; discoverThrows?: string } = {}): Harness {
  const views = opts.views ?? [view(1, { lpd: true })];
  const sleeps: number[] = [];
  const discoverStart = vi.fn(() => {
    if (opts.discoverThrows) throw new Error(opts.discoverThrows);
    return { total: views.length };
  });
  const calStart = vi.fn(() => ({ total: 1 }));
  const finalize = vi.fn(async () => ({ artifact: {}, slots: 0, globalCount: 0 } as never));
  const getSnapshot = vi.fn(
    (): CaptureSnapshot => ({ dets: [], presetRounds: new Map(), aggregated: [], occByPreset: new Map() }),
  );
  const deps: SetupPipelineDeps = {
    job: { getSnapshot },
    finalizer: { finalize },
    discovery: { start: discoverStart, getStatus: vi.fn(() => ({ state: 'idle' as const, done: 0, total: 0, found: 0 })) },
    calibrator: { start: calStart, getStatus: vi.fn((): CalibrateStatus => ({ state: 'idle', done: 0, total: 0 })) },
    store: { getSlotSetup: vi.fn(() => views) },
    now: () => 'T',
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  return { pipeline: new SetupPipeline(deps), discoverStart, calStart, finalize, getSnapshot, sleeps };
}

/** 비동기 발화(beginCalibrateAfterDelay) 소진. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ══════════════════════════════════════════════════════════════════
// U1 — 정상 체인 (discovering → calibrating → done)
// ══════════════════════════════════════════════════════════════════
describe('U1. startPrecise 정상 체인', () => {
  it('startPrecise() → discovery.start 1회 + stage discovering (수집·최종화 미경유)', () => {
    const h = makeHarness();
    const st = h.pipeline.startPrecise();

    expect(h.discoverStart).toHaveBeenCalledTimes(1);
    expect(st.stage).toBe('discovering');
    expect(st.armed).toBe(true);
    expect(st.precise).toBe(true); // D4 — 정밀수집 run 표식(프론트 완료 메시지 분기).
    expect(st.startedAt).toBe('T');
    // ★ 수집·최종화는 한 번도 닿지 않는다(경로 자체가 다르다).
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.getSnapshot).not.toHaveBeenCalled();
  });

  it('discovery.start 는 (filter={}, {betweenSlotMs:500, occupySettleMs:300}) 로 호출된다', () => {
    const h = makeHarness();
    h.pipeline.startPrecise();
    expect(h.discoverStart.mock.calls[0][0]).toEqual({});
    expect(h.discoverStart.mock.calls[0][1]).toEqual({ betweenSlotMs: 500, occupySettleMs: 300 });
  });

  it('onDiscoverFinished("done") → sleep(1000) 1회 후 calibrator.start 1회 + stage calibrating', async () => {
    const h = makeHarness();
    h.pipeline.startPrecise();
    h.pipeline.onDiscoverFinished('done');

    // 대기 전에는 아직 센터라이징이 발화하지 않는다(요구3).
    expect(h.calStart).not.toHaveBeenCalled();
    await flush();

    expect(h.sleeps).toEqual([1000]); // 요구3: 탐색→센터링 1.0s.
    expect(h.calStart).toHaveBeenCalledTimes(1);
    // 경계면: PtzCalibrator.start(slotIds?, opts) — 전 대상(undefined) + 슬롯간 1.0s(요구6).
    expect(h.calStart.mock.calls[0][0]).toBeUndefined();
    expect(h.calStart.mock.calls[0][1]).toEqual({ betweenSlotMs: 1000 });
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('calibrating');
    expect(st.coverage).toEqual({ targets: 1, totalSlots: 1, uncovered: 0 });
  });

  it('onCalibrateFinished("done") → stage done + endedAt', async () => {
    const h = makeHarness();
    h.pipeline.startPrecise();
    h.pipeline.onDiscoverFinished('done');
    await flush();
    h.pipeline.onCalibrateFinished('done');
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('done');
    expect(st.endedAt).toBe('T');
    expect(st.precise).toBe(true);
  });

  it('camera 오버라이드 주입 시 calibrator.start 2번째 인자에 그대로 실려 간다(W4 통로)', async () => {
    const h = makeHarness();
    const camera = { clampZoom: (z: number) => z } as unknown as ICameraClient;
    h.pipeline.startPrecise({ camera });
    h.pipeline.onDiscoverFinished('done');
    await flush();
    expect(h.calStart.mock.calls[0][1]).toEqual({ betweenSlotMs: 1000, camera });
    expect(h.calStart.mock.calls[0][1].camera).toBe(camera); // 동일 참조(어댑터 재조립 없음).
  });

  it('LPD 대상 0(=lpd null) → calibrator.start 미호출 + done + note (F6 가드 유지)', async () => {
    const h = makeHarness({ views: [view(1, { lpd: false })] });
    h.pipeline.startPrecise();
    h.pipeline.onDiscoverFinished('done');
    await flush();
    expect(h.calStart).not.toHaveBeenCalled();
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('done');
    expect(st.note).toBe('센터라이징 스킵 — LPD 보유 슬롯 0');
  });

  it('대기 중 단계가 바뀌면(실패로 종결) 센터라이징을 발화하지 않는다', async () => {
    const h = makeHarness();
    h.pipeline.startPrecise();
    h.pipeline.onDiscoverFinished('done'); // 1s 대기 예약
    h.pipeline.onDiscoverFinished('error'); // 대기 중 실패 종결 → stage=failed
    await flush();
    expect(h.calStart).not.toHaveBeenCalled();
    expect(h.pipeline.getStatus().stage).toBe('failed');
  });

  it('진행 중 재호출은 throw(pipeline busy) — 라우트 409 소스', () => {
    const h = makeHarness();
    h.pipeline.startPrecise();
    expect(() => h.pipeline.startPrecise()).toThrow(/busy/);
    expect(h.discoverStart).toHaveBeenCalledTimes(1);
  });

  it('discovery.start throw(수동 경합) → failed{discover} + 사유 전파', () => {
    const h = makeHarness({ discoverThrows: 'discover already running' });
    const st = h.pipeline.startPrecise();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'discover', reason: 'discover already running' });
  });
});

// ══════════════════════════════════════════════════════════════════
// U2 — preflight 정직 실패(앞면중심 0)
// ══════════════════════════════════════════════════════════════════
describe('U2. preflight — 앵커 0 이면 잡을 발화하지 않는다', () => {
  it('slot3dFrontCenter 전무 → discovery.start 미호출 + failed{discover}', () => {
    const h = makeHarness({ views: [view(1, { front: false }), view(2, { front: false })] });
    const st = h.pipeline.startPrecise();

    expect(h.discoverStart).not.toHaveBeenCalled(); // ★ "돌았는데 아무것도 안 나왔다" 오독 차단.
    expect(st.stage).toBe('failed');
    expect(st.failure?.stage).toBe('discover');
    expect(st.failure?.reason).toContain('앞면중심 0');
    expect(st.failure?.reason).toContain('ROI 파일 로딩');
    expect(st.endedAt).toBe('T');
  });

  it('slot_setup 자체가 비어도 동일하게 정직 실패(빈 성공 위장 없음)', () => {
    const h = makeHarness({ views: [] });
    const st = h.pipeline.startPrecise();
    expect(h.discoverStart).not.toHaveBeenCalled();
    expect(st.stage).toBe('failed');
  });

  it('preflight 실패 후에도 busy 가 아니므로 재시작 가능(잠금 없음)', () => {
    const h = makeHarness({ views: [view(1, { front: false })] });
    h.pipeline.startPrecise();
    expect(h.pipeline.isBusy()).toBe(false);
    expect(() => h.pipeline.startPrecise()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// U3 — 수집(autoChain) 경로 회귀 0
// ══════════════════════════════════════════════════════════════════
describe('U3. 수집 경로 회귀 0', () => {
  it('onCaptureStart(false) → 비무장 no-op 유지(모든 콜백 무반응)', () => {
    const h = makeHarness();
    h.pipeline.onCaptureStart(false);
    expect(h.pipeline.getStatus()).toEqual({ armed: false, stage: 'idle' }); // precise 키 미부착.
    h.pipeline.onCaptureFinished('done');
    h.pipeline.onDiscoverFinished('done');
    h.pipeline.onCalibrateFinished('done');
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.discoverStart).not.toHaveBeenCalled();
    expect(h.calStart).not.toHaveBeenCalled();
    expect(h.pipeline.getStatus().stage).toBe('idle');
  });

  it('onCaptureStart(true) 상태 shape 에 precise 키가 붙지 않는다(수집 응답 불변)', () => {
    const h = makeHarness();
    h.pipeline.onCaptureStart(true);
    const st = h.pipeline.getStatus();
    expect(st).toEqual({ armed: true, stage: 'capturing', startedAt: 'T' });
    expect('precise' in st).toBe(false);
  });

  it('수집 경로(autoChain)에서는 discovery.start 가 인자 1개(=filter만)로 호출된다 — 대기 미주입', async () => {
    const h = makeHarness({ views: [view(1, { lpd: true })] });
    h.pipeline.onCaptureStart(true, false); // vpdEnabled=false → dets 0 가드 우회.
    h.pipeline.onCaptureFinished('done');
    await flush();
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.discoverStart).toHaveBeenCalledTimes(1);
    expect(h.discoverStart.mock.calls[0]).toEqual([{}]); // ★ opts 미전달 → 잡 내부 sleep 미도달(회귀 0).
  });

  it('수집 경로 onDiscoverFinished("done") 은 대기 없이 즉시 calibrator.start() (인자 0개)', async () => {
    const h = makeHarness({ views: [view(1, { lpd: true })] });
    h.pipeline.onCaptureStart(true, false);
    h.pipeline.onCaptureFinished('done');
    await flush();
    h.pipeline.onDiscoverFinished('done');
    // ★ 동기 발화 — flush 이전에 이미 호출돼 있어야 한다(1s 대기 삽입 금지).
    expect(h.calStart).toHaveBeenCalledTimes(1);
    expect(h.calStart.mock.calls[0].length).toBe(0);
    expect(h.sleeps).toEqual([]); // 수집 경로 sleep 0회.
  });

  it('정밀수집 run 뒤 수집 run 을 시작하면 precise 표식·오버라이드가 해제된다(상태 누수 없음)', async () => {
    const h = makeHarness({ views: [view(1, { lpd: true })] });
    const camera = { clampZoom: (z: number) => z } as unknown as ICameraClient;
    h.pipeline.startPrecise({ camera });
    h.pipeline.onDiscoverFinished('done');
    await flush();
    h.pipeline.onCalibrateFinished('done');
    h.calStart.mockClear();
    h.sleeps.length = 0;

    h.pipeline.onCaptureStart(true, false);
    h.pipeline.onCaptureFinished('done');
    await flush();
    h.pipeline.onDiscoverFinished('done');
    expect(h.calStart.mock.calls[0].length).toBe(0); // 카메라 오버라이드·대기 모두 사라짐.
    expect(h.sleeps).toEqual([]);
    expect('precise' in h.pipeline.getStatus()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 센터라이징 분리(마스터 지시 2026-07-22) — 탐색·점유영역까지만 진행
// ══════════════════════════════════════════════════════════════════
describe('센터라이징 분리 — skipCentering', () => {
  it('skipCentering:true → 탐색 완료 시 calibrator 미발화 + done + note', async () => {
    const h = makeHarness();
    h.pipeline.startPrecise({ skipCentering: true });
    h.pipeline.onDiscoverFinished('done');
    await flush();
    const st = h.pipeline.getStatus();
    expect(h.calStart).not.toHaveBeenCalled(); // setup_result.json·slot_ptz.json 도 생성되지 않는다.
    expect(st.stage).toBe('done');
    expect(st.note).toMatch(/^센터라이징 분리/);
    expect(st.coverage).toEqual({ targets: 1, totalSlots: 1, uncovered: 0 }); // 커버리지는 그대로 보고.
  });

  it('skipCentering:true → 요구3 의 1s 진입 대기도 발생하지 않는다(센터라이징에 안 들어가므로)', async () => {
    const h = makeHarness();
    h.pipeline.startPrecise({ skipCentering: true });
    h.pipeline.onDiscoverFinished('done');
    await flush();
    expect(h.sleeps).toEqual([]);
  });

  it('탐색 대기(0.5s/0.3s)는 분리 여부와 무관하게 그대로 전달된다', () => {
    const h = makeHarness();
    h.pipeline.startPrecise({ skipCentering: true });
    expect(h.discoverStart.mock.calls[0][1]).toEqual({ betweenSlotMs: 500, occupySettleMs: 300 });
  });

  it('★ 미지정·false → 기존 거동 유지(1s 대기 후 calibrator 발화) — 회귀 0', async () => {
    for (const opts of [{}, { skipCentering: false }]) {
      const h = makeHarness();
      h.pipeline.startPrecise(opts);
      h.pipeline.onDiscoverFinished('done');
      await flush();
      expect(h.sleeps).toEqual([1000]);
      expect(h.calStart).toHaveBeenCalledTimes(1);
      expect(h.pipeline.getStatus().stage).toBe('calibrating');
    }
  });

  it('★ 분리 run 다음에 수집 경로가 오면 플래그가 남지 않는다', async () => {
    const h = makeHarness();
    h.pipeline.startPrecise({ skipCentering: true });
    h.pipeline.onDiscoverFinished('done');
    await flush();
    h.pipeline.onCaptureStart(true, false); // 수집 경로 — precise/skip 전부 해제.
    h.pipeline.onCaptureFinished('done');
    await flush();
    h.pipeline.onDiscoverFinished('done');
    expect(h.calStart).toHaveBeenCalledTimes(1); // 수집 경로에선 센터라이징이 정상 발화.
  });
});
