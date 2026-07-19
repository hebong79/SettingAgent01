import { describe, it, expect, vi } from 'vitest';
import { SetupPipeline, type SetupPipelineDeps } from '../src/pipeline/SetupPipeline.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { FinalizeResult } from '../src/capture/Finalizer.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { CalibrateStatus } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): SetupPipeline 순수 상태머신·가드 (설계서 §6a T1~T9).
 * camera/vpd/lpd/finalizer/calibrator/job 전부 스텁·스파이. 실제 시그니처와 정합(경계면 교차):
 *   - finalizer.finalize(snapshot, {}) → FinalizeResult{slots,globalCount}(pipeline 이 읽는 필드).
 *   - calibrator.start() (인자 없음 → 전 대상 펼침).
 *   - store.getSlotSetup() → SlotSetupView[] → expandPlateTargetsFromSlotSetup(lpd!=null 카운트).
 *
 * ★ 비동기 주의: onCaptureFinished('done') 후 finalize 는 void 비동기 발화 → 단언 전 microtask flush.
 */

/** 검출 N건짜리 인메모리 스냅샷(pipeline 은 dets.length 만 본다 — 나머지는 finalize 로 그대로 전달). */
function snap(detCount: number): CaptureSnapshot {
  return {
    dets: Array.from({ length: detCount }, () => ({})) as unknown as CaptureSnapshot['dets'],
    presetRounds: new Map(),
    aggregated: [],
    occByPreset: new Map(),
  };
}

/** SlotSetupView 1행. withLpd=true → expandPlateTargetsFromSlotSetup 이 센터라이징 대상으로 셈. */
function view(slotId: number, withLpd: boolean): SlotSetupView {
  return {
    slotId, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null,
    lpd: withLpd ? rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) : null,
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null,
    slot3dFrontCenter: null, updatedAt: null,
  };
}

interface MakeOpts {
  snapshot?: CaptureSnapshot;
  views?: SlotSetupView[];
  finalizeResult?: { slots: number; globalCount: number };
  finalizeImpl?: (s: CaptureSnapshot, o?: unknown) => Promise<FinalizeResult>;
  startImpl?: () => { total: number };
}

function makePipeline(opts: MakeOpts = {}) {
  const getSnapshot = vi.fn((): CaptureSnapshot => opts.snapshot ?? snap(1));
  const finalize = vi.fn(
    opts.finalizeImpl ??
      (async (): Promise<FinalizeResult> => ({
        artifact: {} as FinalizeResult['artifact'],
        slots: opts.finalizeResult?.slots ?? 3,
        globalCount: opts.finalizeResult?.globalCount ?? 5,
      })),
  );
  const start = vi.fn(opts.startImpl ?? (() => ({ total: 1 })));
  const getStatus = vi.fn((): CalibrateStatus => ({ state: 'idle', done: 0, total: 0 }));
  const getSlotSetup = vi.fn((): SlotSetupView[] => opts.views ?? [view(1, true)]);
  const deps: SetupPipelineDeps = {
    job: { getSnapshot },
    finalizer: { finalize },
    calibrator: { start, getStatus },
    store: { getSlotSetup },
    now: () => 'T',
  };
  return { pipeline: new SetupPipeline(deps), getSnapshot, finalize, start, getStatus, getSlotSetup };
}

/** finalize 의 void 비동기 발화(runFinalizeThenCalibrate)를 소진하기 위한 microtask flush. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('SetupPipeline T1 정상 체인 (capturing→finalizing→calibrating→done)', () => {
  it('finalize→calibrate 순서·상태 전이·coverage·finalize 요약', async () => {
    const h = makePipeline({ snapshot: snap(2), views: [view(1, true)], finalizeResult: { slots: 3, globalCount: 5 } });
    h.pipeline.onCaptureStart(true);
    expect(h.pipeline.getStatus()).toEqual({ armed: true, stage: 'capturing', startedAt: 'T' });

    h.pipeline.onCaptureFinished('done');
    await flush();

    // 경계면: finalize 는 (snapshot, {}) 로 호출된다(logicOccupancy 미전달 — 헤드리스 체인).
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.finalize.mock.calls[0][0].dets.length).toBe(2);
    expect(h.finalize.mock.calls[0][1]).toEqual({});
    // 경계면: calibrator.start 는 인자 없이(전 대상) 호출된다.
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0].length).toBe(0);
    // 순서: finalize 가 start 보다 먼저.
    expect(h.finalize.mock.invocationCallOrder[0]).toBeLessThan(h.start.mock.invocationCallOrder[0]);

    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('calibrating'); // 완료 콜백 대기 중.
    expect(st.finalize).toEqual({ slots: 3, globalCount: 5 });
    expect(st.coverage).toEqual({ targets: 1, totalSlots: 1, uncovered: 0 });

    h.pipeline.onCalibrateFinished('done');
    const done = h.pipeline.getStatus();
    expect(done.stage).toBe('done');
    expect(done.endedAt).toBe('T');
  });
});

describe('SetupPipeline T2 비무장(autoChain=false) — 수동 흐름 회귀 0', () => {
  it('콜백 no-op: finalize/start 미호출, stage idle 유지', async () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(false);
    expect(h.pipeline.getStatus()).toEqual({ armed: false, stage: 'idle' });

    h.pipeline.onCaptureFinished('done');
    await flush();
    h.pipeline.onCalibrateFinished('done'); // 이것도 no-op.

    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.pipeline.getStatus()).toEqual({ armed: false, stage: 'idle' });
  });
});

describe('SetupPipeline T3 수집 실패(stopped/error) → failed{capture}', () => {
  it('stopped → failed{capture}, finalize 미호출', async () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('stopped');
    await flush();
    expect(h.finalize).not.toHaveBeenCalled();
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'capture', reason: 'stopped(수동 정지)' });
  });

  it('error → failed{capture}, finalize 미호출', async () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('error');
    await flush();
    expect(h.finalize).not.toHaveBeenCalled();
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'capture', reason: 'capture error' });
  });
});

describe('SetupPipeline T4 검출 0 → finalize 미호출 (F10 DB 보호)', () => {
  it('dets 0 → failed{finalize} · finalizer.finalize 스파이 0회', async () => {
    const h = makePipeline({ snapshot: snap(0) });
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    // ★ replaceSlotSetup DELETE+INSERT 데이터 파괴 차단 — finalize 를 아예 부르지 않는다.
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'finalize', reason: '검출 0건 — finalize 미실행(DB 보호)' });
  });

  // 설계 결정 E — VPD off 흐름에서는 F10 dets 가드를 우회한다(finalize 가 slot_setup 행+front_center 부트스트랩 유일 경로).
  it('vpdEnabled:false + dets 0 → 가드 우회 → finalize 진행(부트스트랩)', async () => {
    const h = makePipeline({ snapshot: snap(0) });
    h.pipeline.onCaptureStart(true, false); // VPD off.
    h.pipeline.onCaptureFinished('done');
    await flush();
    // ★ 우회: 검출 0 이어도 finalize 호출(front_center 는 VPD 무관 기하 — hit 없으면 검출 컬럼 prev 보존).
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.pipeline.getStatus().stage).not.toBe('failed');
  });

  it('vpdEnabled:true(기본) + dets 0 → 종전대로 finalize 미호출·failed', async () => {
    const h = makePipeline({ snapshot: snap(0) });
    h.pipeline.onCaptureStart(true, true); // VPD on(명시).
    h.pipeline.onCaptureFinished('done');
    await flush();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.pipeline.getStatus().failure).toEqual({ stage: 'finalize', reason: '검출 0건 — finalize 미실행(DB 보호)' });
  });
});

describe('SetupPipeline T5 finalize throw → calibrate 미발화', () => {
  it('finalize throw → failed{finalize, err.message} · calibrator.start 미호출', async () => {
    const h = makePipeline({ finalizeImpl: async () => { throw new Error('finalize boom'); } });
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.start).not.toHaveBeenCalled();
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'finalize', reason: 'finalize boom' });
  });
});

describe('SetupPipeline T6 LPD 타깃 0 → 센터라이징 스킵 (F6)', () => {
  it('전 슬롯 lpd=null → done+note · calibrator.start 미호출 · coverage{0,2,2}', async () => {
    const h = makePipeline({ views: [view(1, false), view(2, false)] });
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    expect(h.finalize).toHaveBeenCalledTimes(1); // finalize 는 정상 수행.
    expect(h.start).not.toHaveBeenCalled(); // ★ 빈 slot_ptz.json 덮어쓰기 방지.
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('done');
    expect(st.note).toBe('센터라이징 스킵 — LPD 보유 슬롯 0');
    expect(st.coverage).toEqual({ targets: 0, totalSlots: 2, uncovered: 2 });
  });
});

describe('SetupPipeline T7 센터라이징 실패 → failed{calibrate}', () => {
  it('calibrator.start throw(수동 경합) → failed{calibrate}', async () => {
    const h = makePipeline({ startImpl: () => { throw new Error('calibrate already running'); } });
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'calibrate', reason: 'calibrate already running' });
  });

  it('onCalibrateFinished("error") → failed{calibrate}', async () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    expect(h.pipeline.getStatus().stage).toBe('calibrating');
    h.pipeline.onCalibrateFinished('error');
    const st = h.pipeline.getStatus();
    expect(st.stage).toBe('failed');
    expect(st.failure).toEqual({ stage: 'calibrate', reason: 'calibrate error' });
  });
});

describe('SetupPipeline T8 종단 후 재무장(리셋)·disarm', () => {
  it('failed 종단 후 재무장 → failure/coverage/note/endedAt 클리어 + capturing', async () => {
    const h = makePipeline({ snapshot: snap(0) });
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done'); // dets 0 → failed.
    await flush();
    expect(h.pipeline.getStatus().stage).toBe('failed');

    h.pipeline.onCaptureStart(true); // 재무장.
    expect(h.pipeline.getStatus()).toEqual({ armed: true, stage: 'capturing', startedAt: 'T' });
  });

  it('종단 후 disarm(false) → idle·armed=false·필드 클리어', async () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    h.pipeline.onCalibrateFinished('done');
    expect(h.pipeline.getStatus().stage).toBe('done');

    h.pipeline.onCaptureStart(false);
    expect(h.pipeline.getStatus()).toEqual({ armed: false, stage: 'idle' });
  });
});

describe('SetupPipeline coverage 리포트 정확성', () => {
  it('혼합 lpd(3행 중 2행 보유) → targets 2 / totalSlots 3 / uncovered 1', async () => {
    const h = makePipeline({ views: [view(1, true), view(2, false), view(3, true)] });
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    expect(h.start).toHaveBeenCalledTimes(1); // targets>0 → 센터라이징 발화.
    expect(h.pipeline.getStatus().coverage).toEqual({ targets: 2, totalSlots: 3, uncovered: 1 });
  });
});

describe('SetupPipeline isBusy — /capture/start 409 가드 소스', () => {
  it('idle/capturing=false, finalizing·calibrating=true, done=false', async () => {
    // finalize 를 수동 게이트로 잡아 finalizing 상태를 관측.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = makePipeline({
      finalizeImpl: async (): Promise<FinalizeResult> => {
        await gate;
        return { artifact: {} as FinalizeResult['artifact'], slots: 1, globalCount: 1 };
      },
    });
    expect(h.pipeline.isBusy()).toBe(false); // idle.
    h.pipeline.onCaptureStart(true);
    expect(h.pipeline.isBusy()).toBe(false); // capturing.

    h.pipeline.onCaptureFinished('done'); // → finalizing(게이트 대기).
    await flush();
    expect(h.pipeline.getStatus().stage).toBe('finalizing');
    expect(h.pipeline.isBusy()).toBe(true); // finalizing.

    release();
    await flush();
    expect(h.pipeline.getStatus().stage).toBe('calibrating');
    expect(h.pipeline.isBusy()).toBe(true); // calibrating.

    h.pipeline.onCalibrateFinished('done');
    expect(h.pipeline.isBusy()).toBe(false); // done.
  });
});

describe('SetupPipeline 콜백 가드(비-대응 stage 에서 no-op)', () => {
  it('capturing 중 onCalibrateFinished 는 no-op(stage 불변)', () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCalibrateFinished('done'); // stage=capturing → 무시.
    expect(h.pipeline.getStatus().stage).toBe('capturing');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('done 종단 후 onCaptureFinished 재호출은 no-op(finalize 재실행 없음)', async () => {
    const h = makePipeline();
    h.pipeline.onCaptureStart(true);
    h.pipeline.onCaptureFinished('done');
    await flush();
    h.pipeline.onCalibrateFinished('done');
    expect(h.pipeline.getStatus().stage).toBe('done');

    h.pipeline.onCaptureFinished('done'); // stage!=='capturing' → no-op.
    await flush();
    expect(h.finalize).toHaveBeenCalledTimes(1); // 재실행 안 됨.
    expect(h.pipeline.getStatus().stage).toBe('done');
  });
});
