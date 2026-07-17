import { describe, it, expect, vi } from 'vitest';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CapturedImage, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): CaptureJob 체크포인트 트리거 모드(rounds/time) — 설계서 §3.5·§6, 성공기준 1·2.
 * rounds 회귀(done%K==0) + time 모드(monotonic 경과 ≥ intervalMs) 결정적 검증.
 * checkpoint 발화 감지는 occupancyReviewer.review 스파이로 관찰(주입 시 checkpoint 말미 호출).
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};

const vb = (x: number): VehicleBox => ({ rect: { x, y: 0.2, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });

function fakeCamera(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img'),
    }),
  } as unknown as CameraClient;
}
function fakeVpd(): VpdClient {
  return { detect: async () => [vb(0.2)] } as unknown as VpdClient;
}

// 단일 타깃 → 라운드당 프리셋 이동 페이싱(마지막 제외) 없음 → monotonic 은 트리거 판정에만 영향.
const targets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];

function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const idx = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (idx >= 0) queue.splice(idx, 1);
  };
  const fireNext = async (): Promise<boolean> => {
    const h = queue.shift();
    if (!h) return false;
    h.fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return true;
  };
  return { setTimer, clearTimer, fireNext, queueLen: () => queue.length };
}

/** clock 을 외부에서 제어하는 잡. reviewSpy = occupancyReviewer.review(=checkpoint 발화 감지). */
function makeJob(cfg: ToolsConfig['capture']) {
  const timers = makeManualTimers();
  let clock = 0;
  const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
  const occupancyReviewer = { review: reviewSpy } as unknown as CaptureJobDeps['occupancyReviewer'];
  const deps: CaptureJobDeps = {
    camera: fakeCamera(),
    vpd: fakeVpd(),
    cfg,
    lpdEnabled: false,
    occupancyReviewer,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    now: () => 'T',
    monotonic: () => clock,
  };
  const job = new CaptureJob(deps);
  return { job, timers, reviewSpy, setClock: (v: number) => { clock = v; } };
}

describe('CaptureJob rounds 모드 회귀 (성공기준 1)', () => {
  it('done % checkpointEvery === 0 라운드에서만 checkpoint 발화(K=2 → 라운드 2,4)', async () => {
    const { job, timers, reviewSpy } = makeJob({ ...captureCfg, checkpointTriggerMode: 'rounds', checkpointEvery: 2 });
    job.start({ count: 4, intervalMs: 1000, checkpointEvery: 2, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext(); // 라운드1: done=1, 1%2!=0 → 미발화
    expect(reviewSpy).toHaveBeenCalledTimes(0);
    await timers.fireNext(); // 라운드2: done=2, 2%2==0 → 발화
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    await timers.fireNext(); // 라운드3: 미발화
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    await timers.fireNext(); // 라운드4: done=4 → 발화 + count 도달 done
    expect(reviewSpy).toHaveBeenCalledTimes(2);
    expect(job.getStatus().state).toBe('done');
  });
});

describe('CaptureJob time 모드 (성공기준 2)', () => {
  it('경과 ≥ intervalMs 라운드에서만 발화, 발화 후 기준점 리셋(과다 발화 없음)', async () => {
    // intervalMs=5000. start 시 clock=0 → lastCheckpointMs=0.
    const { job, timers, reviewSpy, setClock } = makeJob({
      ...captureCfg, checkpointTriggerMode: 'time', checkpointIntervalMs: 5000, checkpointEvery: 99,
    });
    setClock(0);
    job.start({ count: 10, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'time', checkpointIntervalMs: 5000, targets });

    setClock(2000);
    await timers.fireNext(); // 라운드1: 2000-0=2000 < 5000 → 미발화(시작 직후 미발화)
    expect(reviewSpy).toHaveBeenCalledTimes(0);

    setClock(6000);
    await timers.fireNext(); // 라운드2: 6000-0=6000 ≥ 5000 → 발화, lastCheckpointMs=6000
    expect(reviewSpy).toHaveBeenCalledTimes(1);

    setClock(8000);
    await timers.fireNext(); // 라운드3: 8000-6000=2000 < 5000 → 미발화(리셋 확인)
    expect(reviewSpy).toHaveBeenCalledTimes(1);

    setClock(12000);
    await timers.fireNext(); // 라운드4: 12000-6000=6000 ≥ 5000 → 발화
    expect(reviewSpy).toHaveBeenCalledTimes(2);

    expect(job.getStatus().state).toBe('running');
    job.stop();
  });

  it('occupancyReviewer 결선: 체크포인트 도달 → review 1회(runId·round·frames·shouldStop·expected 전달)', async () => {
    // rounds K=1 → 라운드1 완료 후 checkpoint 진입 → occupancyReviewer.review 1회 호출.
    const timers = makeManualTimers();
    const occSpy = vi.fn(async () => ({ llmUnavailable: false }));
    const occupancyReviewer = { review: occSpy } as unknown as CaptureJobDeps['occupancyReviewer'];
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(),
      cfg: { ...captureCfg, checkpointTriggerMode: 'rounds', checkpointEvery: 1 },
      lpdEnabled: false, occupancyReviewer,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, sleep: async () => {}, now: () => 'T',
      expectedByPreset: { '1:1': 5 },
    });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(occSpy).toHaveBeenCalledTimes(1);
    // OccupancyReviewer.review(atRound, framesByPreset, occByPreset, shouldStop, expectedByPreset) — CaptureJob.ts checkpoint() 호출 인자 순서.
    const call = occSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe(1); // atRound
    expect(call[1]).toBeInstanceOf(Map); // framesByPreset
    expect(call[2]).toBeInstanceOf(Map); // occByPreset(인메모리 축소 occupancy 누적 대상)
    expect(typeof call[3]).toBe('function'); // shouldStop 콜백
    expect(call[4]).toEqual({ '1:1': 5 }); // expectedByPreset
  });

  it('occupancyReviewer.review llmUnavailable:true → status.llmOccupancyUnavailable 노출', async () => {
    const timers = makeManualTimers();
    const occupancyReviewer = { review: vi.fn(async () => ({ llmUnavailable: true })) } as unknown as CaptureJobDeps['occupancyReviewer'];
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(),
      cfg: { ...captureCfg, checkpointTriggerMode: 'rounds', checkpointEvery: 1 },
      lpdEnabled: false, occupancyReviewer,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, sleep: async () => {}, now: () => 'T',
    });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(job.getStatus().llmOccupancyUnavailable).toBe(true);
  });

  it('occupancyReviewer 미주입 → no-op(정상 완료, 크래시 없음)', async () => {
    const { job, timers } = makeJob({ ...captureCfg, checkpointTriggerMode: 'rounds', checkpointEvery: 1 });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(job.getStatus().state).toBe('done');
    expect(job.getStatus().llmOccupancyUnavailable).toBeUndefined();
  });

  it('time 모드: 경과가 계속 미달이면 count 종료까지 한 번도 발화 안 함', async () => {
    const { job, timers, reviewSpy, setClock } = makeJob({
      ...captureCfg, checkpointTriggerMode: 'time', checkpointIntervalMs: 100000, checkpointEvery: 1,
    });
    setClock(0);
    job.start({ count: 3, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'time', checkpointIntervalMs: 100000, targets });
    setClock(1000); await timers.fireNext();
    setClock(2000); await timers.fireNext();
    setClock(3000); await timers.fireNext(); // count=3 도달 done
    expect(reviewSpy).toHaveBeenCalledTimes(0); // 경과 100s 미달 → 발화 없음(K=1 이어도 time 모드는 시간 기준)
    expect(job.getStatus().state).toBe('done');
  });
});
