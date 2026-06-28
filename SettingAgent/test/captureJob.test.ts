import { describe, it, expect, vi, afterEach } from 'vitest';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CapturedImage, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): CaptureJob 상태머신 (G1 — fake timers).
 * setTimer/sleep/now 주입. idle→running→done(count)/stopped(manual)/error.
 * 중복 start 거부. 프리셋 일부 실패 흡수. 적재 호출(DB) 검증.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, checkpointEvery: 10, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5,
};

const vb = (x: number): VehicleBox => ({ rect: { x, y: 0.2, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });

function fakeCamera(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: `i-${camIdx}-${presetIdx}`, jpg: Buffer.from('img'),
    }),
  } as unknown as CameraClient;
}
function fakeVpd(boxes: VehicleBox[] = [vb(0.2)]): VpdClient {
  return { detect: async () => boxes } as unknown as VpdClient;
}

const targets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }];

/** fake setTimer: 핸들을 큐에 모아 수동 발화(즉시 0 + 주기 모두 동일 처리). */
function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms } as { fn: () => void; ms: number };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const idx = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (idx >= 0) queue.splice(idx, 1);
  };
  /** 가장 오래된 예약을 1개 발화(runRound 는 async — microtask flush 위해 await). */
  const fireNext = async (): Promise<boolean> => {
    const h = queue.shift();
    if (!h) return false;
    h.fn();
    // runRound 의 await 체인을 비우기 위해 여러 틱 flush.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return true;
  };
  return { setTimer, clearTimer, fireNext, queueLen: () => queue.length };
}

function makeJob(over: Partial<CaptureJobDeps> = {}) {
  const store = new SqliteStore(':memory:');
  const timers = makeManualTimers();
  const deps: CaptureJobDeps = {
    camera: fakeCamera(),
    vpd: fakeVpd(),
    store,
    cfg: captureCfg,
    lpdEnabled: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    now: () => 'T',
    ...over,
  };
  return { job: new CaptureJob(deps), store, timers };
}

let openStores: SqliteStore[] = [];
afterEach(() => {
  for (const s of openStores) {
    try { s.close(); } catch { /* noop */ }
  }
  openStores = [];
});

describe('CaptureJob 시작/중복 (G1)', () => {
  it('start → running + runId, DB capture_run 생성', () => {
    const { job, store } = makeJob();
    openStores.push(store);
    const { runId } = job.start({ count: 3, intervalMs: 1000, checkpointEvery: 10, targets });
    expect(runId).toBeGreaterThan(0);
    const st = job.getStatus();
    expect(st.state).toBe('running');
    expect(st.planned).toBe(3);
    expect(st.runId).toBe(runId);
    expect(store.getRun(runId)!.status).toBe('running');
  });

  it('running 중 중복 start → throw (라우트에서 409 매핑)', () => {
    const { job, store } = makeJob();
    openStores.push(store);
    job.start({ count: 3, intervalMs: 1000, checkpointEvery: 10, targets });
    expect(() => job.start({ count: 3, intervalMs: 1000, checkpointEvery: 10, targets })).toThrow('capture already running');
  });
});

describe('CaptureJob 프레임/시각 (수집 관찰·경과)', () => {
  it('라운드 후 getLastFrame = 마지막 타깃 프레임, status에 startedAt/endedAt', async () => {
    const { job, store, timers } = makeJob();
    openStores.push(store);
    expect(job.getLastFrame()).toBeUndefined();
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, targets });
    expect(job.getStatus().startedAt).toBe('T');
    await timers.fireNext(); // 라운드1(두 타깃) → count=1 도달 → done
    const f = job.getLastFrame();
    expect(f).toBeDefined();
    expect(f!.camIdx).toBe(1);
    expect(f!.presetIdx).toBe(2); // 마지막 타깃(순회 마지막 프리셋)
    expect(f!.roundIdx).toBe(1);
    expect(f!.jpeg.toString()).toBe('img');
    const st = job.getStatus();
    expect(st.state).toBe('done');
    expect(st.endedAt).toBe('T');
  });
});

describe('CaptureJob count 종료 (G1)', () => {
  it('count 라운드 도달 → done(stop_reason=count), DB done_count 일치, 적재 검증', async () => {
    const { job, store, timers } = makeJob();
    openStores.push(store);
    const { runId } = job.start({ count: 2, intervalMs: 1000, checkpointEvery: 10, targets });

    // 첫 라운드(setTimer ms=0) 발화.
    await timers.fireNext();
    expect(job.getStatus().done).toBe(1);
    // 2번째 라운드(intervalMs 예약) 발화 → count 도달.
    await timers.fireNext();

    const st = job.getStatus();
    expect(st.state).toBe('done');
    expect(st.done).toBe(2);
    const run = store.getRun(runId)!;
    expect(run.doneCount).toBe(2);
    expect(run.status).toBe('done');
    expect(run.stopReason).toBe('count');
    // 적재: 2라운드 × 2프리셋 = 4 관측, 각 vehicle 1건 → 4 검출.
    const dets = store.getDetectionsForRun(runId);
    expect(dets).toHaveLength(4);
    expect(dets.every((d) => d.kind === 'vehicle')).toBe(true);
    // 더 발화할 타이머 없음(완료 후 미예약).
    expect(timers.queueLen()).toBe(0);
  });
});

describe('CaptureJob 수동 정지 (G1)', () => {
  it('라운드 사이 stop → 현재 라운드 후 stopped(manual), 다음 미예약', async () => {
    const { job, store, timers } = makeJob();
    openStores.push(store);
    const { runId } = job.start({ count: 10, intervalMs: 1000, checkpointEvery: 99, targets });
    await timers.fireNext(); // 라운드 1 완료(다음 라운드 예약됨)
    expect(job.getStatus().state).toBe('running');
    expect(timers.queueLen()).toBe(1); // 다음 라운드 예약 1건

    job.stop(); // 라운드 진행 중 아님 → 즉시 stopped, 예약 취소
    const st = job.getStatus();
    expect(st.state).toBe('stopped');
    expect(timers.queueLen()).toBe(0); // 다음 발화 취소
    expect(store.getRun(runId)!.stopReason).toBe('manual');
    expect(store.getRun(runId)!.status).toBe('stopped');
  });

  it('stop()은 running 이 아닐 때 no-op', () => {
    const { job, store } = makeJob();
    openStores.push(store);
    expect(() => job.stop()).not.toThrow(); // idle
    expect(job.getStatus().state).toBe('idle');
  });
});

describe('CaptureJob 예외/흡수 (G1)', () => {
  it('프리셋 일부 캡처 실패 → 흡수(잡 미중단)', async () => {
    let calls = 0;
    const flakyCamera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        calls += 1;
        if (presetIdx === 2) throw new Error('preset2 캡처 실패');
        return { camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') };
      },
    } as unknown as CameraClient;
    const { job, store, timers } = makeJob({ camera: flakyCamera });
    openStores.push(store);
    const { runId } = job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, targets });
    await timers.fireNext();
    // 잡은 정상 완료(흡수). preset1 적재만 존재.
    expect(job.getStatus().state).toBe('done');
    expect(calls).toBe(2); // 두 프리셋 모두 시도
    const dets = store.getDetectionsForRun(runId);
    expect(dets).toHaveLength(1); // preset1 vehicle 만 적재(preset2 실패)
    expect(dets[0].presetIdx).toBe(1);
  });

  it('라운드 전역 예외(updateRunProgress 실패) → error 상태', async () => {
    const { job, store, timers } = makeJob();
    openStores.push(store);
    // updateRunProgress 가 던지도록 store 를 패치(프리셋 루프 밖 예외 → catch → error).
    const orig = store.updateRunProgress.bind(store);
    let runId = 0;
    vi.spyOn(store, 'updateRunProgress').mockImplementation((id: number, n: number) => {
      throw new Error('DB 적재 폭발');
      orig(id, n);
    });
    ({ runId } = job.start({ count: 2, intervalMs: 1000, checkpointEvery: 99, targets }));
    await timers.fireNext();
    expect(job.getStatus().state).toBe('error');
    expect(store.getRun(runId)!.status).toBe('error');
    expect(store.getRun(runId)!.stopReason).toBe('error');
  });
});

describe('CaptureJob LPD 적재 (G1)', () => {
  it('lpdEnabled=true → vehicle+plate 적재', async () => {
    const lpd = { detect: async () => [{ rect: { x: 0.21, y: 0.21, w: 0.03, h: 0.02 }, confidence: 0.8, cls: 'plate' }] };
    const { job, store, timers } = makeJob({ lpdEnabled: true, lpd: lpd as never });
    openStores.push(store);
    const single: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];
    const { runId } = job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, targets: single });
    await timers.fireNext();
    const dets = store.getDetectionsForRun(runId);
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(1);
    expect(dets.filter((d) => d.kind === 'plate')).toHaveLength(1);
  });

  it('lpdEnabled=true 인데 LPD 실패 → 번호판 생략, 차량은 적재(흡수)', async () => {
    const lpd = { detect: async () => { throw new Error('LPD down'); } };
    const { job, store, timers } = makeJob({ lpdEnabled: true, lpd: lpd as never });
    openStores.push(store);
    const single: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];
    const { runId } = job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, targets: single });
    await timers.fireNext();
    const dets = store.getDetectionsForRun(runId);
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(1);
    expect(dets.filter((d) => d.kind === 'plate')).toHaveLength(0);
  });
});
