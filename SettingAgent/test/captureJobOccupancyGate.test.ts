import { describe, it, expect, vi } from 'vitest';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CapturedImage, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): CaptureJob checkpoint occupancyReviewer 게이트 (설계 §05 G6-①).
 * 기존 floorReviewer 게이트(§03-F10)를 occupancyReviewer 로 확장한 1줄:
 *   if (this.deps.occupancyReviewer && this.floorRoiUseLlm !== false)
 * - floorRoiUseLlm:false(파일 모드) → occupancyReviewer.review 미호출(캡처 중 LLM 점유 스킵, R3).
 * - true/미지정(기본 true) → 호출(회귀 0).
 * floorReviewer 게이트는 별도 파일(floorRoiUseLlmWiring.test.ts)에서 커버 — 여기선 occupancy 확장분만.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};

function fakeCameraJob(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: `i-${camIdx}-${presetIdx}`, jpg: Buffer.from('img'),
    }),
  } as unknown as CameraClient;
}
const vb = (x: number): VehicleBox => ({ rect: { x, y: 0.2, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });
function fakeVpdJob(): VpdClient {
  return { detect: async () => [vb(0.2)] } as unknown as VpdClient;
}
const jobTargets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];

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
  return { setTimer, clearTimer, fireNext };
}

function makeJob(over: Partial<CaptureJobDeps> = {}) {
  const timers = makeManualTimers();
  const deps: CaptureJobDeps = {
    camera: fakeCameraJob(), vpd: fakeVpdJob(), cfg: captureCfg, lpdEnabled: false,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, sleep: async () => {}, now: () => 'T',
    ...over,
  };
  return { job: new CaptureJob(deps), timers };
}

/** occupancyReviewer.review 스텁(체크포인트 시 호출). 반환 { llmUnavailable }. */
function makeOccReviewer() {
  const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
  return { occupancyReviewer: { review: reviewSpy } as unknown as CaptureJobDeps['occupancyReviewer'], reviewSpy };
}

describe('CaptureJob checkpoint occupancyReviewer 게이트 (G6-①)', () => {
  it('floorRoiUseLlm:false(파일 모드) → occupancyReviewer.review 미호출(LLM 점유 스킵)', async () => {
    const { occupancyReviewer, reviewSpy } = makeOccReviewer();
    const { job, timers } = makeJob({ occupancyReviewer });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: jobTargets, floorRoiUseLlm: false });
    await timers.fireNext();
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it('floorRoiUseLlm:true → occupancyReviewer.review 호출(LLM 모드)', async () => {
    const { occupancyReviewer, reviewSpy } = makeOccReviewer();
    const { job, timers } = makeJob({ occupancyReviewer });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: jobTargets, floorRoiUseLlm: true });
    await timers.fireNext();
    expect(reviewSpy).toHaveBeenCalledTimes(1);
  });

  it('floorRoiUseLlm 미지정(기본 true) → occupancyReviewer.review 호출(회귀 0)', async () => {
    const { occupancyReviewer, reviewSpy } = makeOccReviewer();
    const { job, timers } = makeJob({ occupancyReviewer });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: jobTargets });
    await timers.fireNext();
    expect(reviewSpy).toHaveBeenCalledTimes(1);
  });
});
