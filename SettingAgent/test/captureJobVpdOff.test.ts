// VPD 자동검출 정지(제품 정책 기본 OFF) — CaptureJob 라운드 게이트 검증(설계서 §3 S1).
//
// 주장: vpdEnabled:false 로 시작한 잡은 **매 라운드 vpd.detect 를 한 번도 부르지 않는다**(스파이 0회).
//   그럼에도 LPD 는 계속 동작해 plate det 가 인메모리에 누적된다. cuboidCtx 를 주입해도 seg 게이트로 미호출.
//   vpdEnabled:true(또는 미지정 — 라이브러리 기본 true)면 vpd.detect 가 라운드마다 호출된다(회귀 0 확인).

import { describe, it, expect, vi } from 'vitest';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { CapturedImage, VehicleBox, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

const CAM = 1;
const PRESET = 1;
const targets: SetupTarget[] = [{ camIdx: CAM, presetIdx: PRESET }];

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 0, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: false,
};

const VEHICLE: VehicleBox = { rect: { x: 0.4, y: 0.5, w: 0.06, h: 0.24 }, confidence: 0.9, cls: 'car' };
const PLATE_QUAD: NormalizedQuad = [
  { x: 0.41, y: 0.62 }, { x: 0.45, y: 0.62 }, { x: 0.45, y: 0.65 }, { x: 0.41, y: 0.65 },
];
const PLATE: PlateBox = { quad: PLATE_QUAD, confidence: 0.8, cls: 'car_license_plate' };

const fakeCamera = (): CameraClient => ({
  requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
    camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img'),
  }),
} as unknown as CameraClient);

function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const i = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (i >= 0) queue.splice(i, 1);
  };
  const fireNext = (): boolean => {
    const h = queue.shift();
    if (!h) return false;
    h.fn();
    return true;
  };
  return { setTimer, clearTimer, fireNext };
}

async function waitDone(job: CaptureJob, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = job.getStatus().state;
    if (s === 'done' || s === 'stopped' || s === 'error') return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`라운드가 ${timeoutMs}ms 내 종료되지 않음(state=${job.getStatus().state})`);
}

/** 1라운드 실행 헬퍼. vpd.detect/lpd.detect/cuboidCtx 스파이를 반환. */
async function runOneRound(vpdEnabled: boolean | undefined, opts: { withCuboid?: boolean } = {}) {
  const vpdDetect = vi.fn(async (): Promise<VehicleBox[]> => [VEHICLE]);
  const lpdDetect = vi.fn(async (): Promise<PlateBox[]> => [PLATE]);
  const cuboidCtx = vi.fn(async () => null);
  const timers = makeManualTimers();
  const deps: CaptureJobDeps = {
    camera: fakeCamera(),
    vpd: { detect: vpdDetect } as unknown as VpdClient,
    lpd: { detect: lpdDetect } as unknown as LpdClient,
    cfg: captureCfg,
    lpdEnabled: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    now: () => 'T',
    // vpdOnParkingOnly 는 폴리곤 파일 없이 강등(전량 통과)이므로 필터 자체는 무해 — VPD 게이트만 본다.
    ...(opts.withCuboid ? { cuboidCtx } : {}),
  };
  const job = new CaptureJob(deps);
  job.start({
    count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds',
    checkpointIntervalMs: 60000, targets,
    ...(vpdEnabled === undefined ? {} : { vpdEnabled }),
  });
  timers.fireNext();
  await waitDone(job);
  return { job, vpdDetect, lpdDetect, cuboidCtx };
}

describe('VPD 자동검출 정지 — CaptureJob 라운드 게이트(설계서 S1)', () => {
  it('vpdEnabled:false → vpd.detect 스파이 0회 · LPD plate det 는 그대로 누적', async () => {
    const { job, vpdDetect, lpdDetect } = await runOneRound(false);
    expect(vpdDetect).toHaveBeenCalledTimes(0); // ★ 자동 경로 VPD 정지.
    expect(lpdDetect).toHaveBeenCalledTimes(1); // LPD 는 계속.
    const dets = job.getSnapshot().dets;
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(0); // 차량 검출 없음.
    expect(dets.filter((d) => d.kind === 'plate')).toHaveLength(1); // 번호판은 누적(폴리곤 직접 필터·강등 통과).
  });

  it('vpdEnabled:false + cuboidCtx 주입 → cuboidCtx(seg) 스파이 0회', async () => {
    const { cuboidCtx } = await runOneRound(false, { withCuboid: true });
    expect(cuboidCtx).toHaveBeenCalledTimes(0); // 육면체 seg 문맥 미호출(설계 결정 D).
  });

  it('vpdEnabled:true → vpd.detect 호출 · vehicle det 누적', async () => {
    const { job, vpdDetect } = await runOneRound(true);
    expect(vpdDetect).toHaveBeenCalledTimes(1);
    expect(job.getSnapshot().dets.filter((d) => d.kind === 'vehicle')).toHaveLength(1);
  });

  it('vpdEnabled 미지정 → 라이브러리 기본 true(기존 동작 보존 · 회귀 0)', async () => {
    const { vpdDetect } = await runOneRound(undefined);
    expect(vpdDetect).toHaveBeenCalledTimes(1);
  });

  it('status.vpdEnabled 노출(강등 위장 금지)', async () => {
    const { job } = await runOneRound(false);
    expect(job.getStatus().vpdEnabled).toBe(false);
  });
});
