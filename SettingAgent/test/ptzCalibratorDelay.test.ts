import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { CameraClient, ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { PlatePtz, PlatePtzOpts, PlatePtzResult } from '../src/calibrate/platePtz.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): W4 대기·카메라 오버라이드 배선 (설계서 §11.1 U5 — 요구6 센터링 슬롯당 1.0s).
 *
 * ★ 이 유닛이 **유일한 증거**다: 구현자는 센터링 슬롯 간격 1.0s 를 라이브로 실측하지 못했다고 보고했다
 *   (02_developer_changes.md §6 "확인 못 한 항목" 2). fake sleep 으로 인자·횟수를 직접 센다.
 *
 * makePlatePtz 는 시임(카메라·LPD 왕복 0) — sleep 호출은 오직 run() 슬롯 루프에서만 나온다.
 * 미지정(수동 `/calibrate/ptz`) 시 sleep **0회**(회귀 0)도 같은 하네스로 봉인한다.
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

const PLATE: PlateBox = { quad: rectToQuad({ x: 0.48, y: 0.485, w: 0.05, h: 0.03 }), confidence: 0.9, cls: 'plate' };
const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 2 };
const dummyLpd = { detect: async (): Promise<PlateBox[]> => [] } as unknown as LpdClient;

function makeCamera(label = 'boot'): CameraClient {
  return {
    label,
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') }),
    listCameras: async () => ({
      cameras: [{ camIdx: 1, label: 'C1', presets: [{ presetIdx: 1, label: 'C1-P1', pan: 10, tilt: 20, zoom: 2 }] }],
    }),
  } as unknown as CameraClient;
}

/** 항상 수렴하는 PlatePtz 시임 + 생성 시 받은 카메라를 기록. */
function platePtzSpy() {
  const camerasSeen: Array<ICameraClient | undefined> = [];
  const ok = (over: Partial<PlatePtzResult>): PlatePtzResult => ({
    ok: true, ptz: { pan: 11, tilt: 21, zoom: 4 }, plate: PLATE, err: { errX: 0, errY: 0 },
    plateWidth: 0.2, gain: GAIN, iterations: 1, ...over,
  });
  const make = (_opts: PlatePtzOpts, camera?: ICameraClient): Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth' | 'centerAndZoomByLadder'> => {
    camerasSeen.push(camera);
    return {
      centerOnPlate: async (): Promise<PlatePtzResult> => ok({ ptz: { pan: 11, tilt: 21, zoom: 2 }, plateWidth: 0.05 }),
      zoomToPlateWidth: async (): Promise<PlatePtzResult> => ok({}),
      centerAndZoomByLadder: async (): Promise<PlatePtzResult> => ok({}),
    };
  };
  return { make: make as unknown as PtzCalibratorDeps['makePlatePtz'], camerasSeen };
}

function view(slotId: number): SlotSetupView {
  return {
    slotId, camId: 1, presetId: 1, presetSlotIdx: slotId, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.3 + slotId * 0.1, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null,
    slot3dFrontCenter: null, updatedAt: null,
  };
}

function build(n: number) {
  const sleeps: number[] = [];
  const spy = platePtzSpy();
  const views = Array.from({ length: n }, (_, i) => view(i + 1));
  const deps: PtzCalibratorDeps = {
    camera: makeCamera(), lpd: dummyLpd, cfg,
    store: { getSlotSetup: () => views, upsertSlotCentering: () => {} } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>,
    makePlatePtz: spy.make,
    writer: () => {},
    sleep: async (ms: number) => { sleeps.push(ms); },
    now: () => 'T',
  };
  return { cal: new PtzCalibrator(deps), sleeps, camerasSeen: spy.camerasSeen };
}

async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 40000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

describe('U5. PtzCalibrator 대기 배선 — 지정 시', () => {
  it('betweenSlotMs:1000 → 슬롯 N(=4)개에 대해 sleep(1000) 정확히 N회', async () => {
    const { cal, sleeps } = build(4);
    expect(cal.start(undefined, { betweenSlotMs: 1000 }).total).toBe(4);
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  it('슬롯 1개면 1회(마지막 슬롯 뒤에도 대기 — 루프 말미 무조건 대기)', async () => {
    const { cal, sleeps } = build(1);
    cal.start(undefined, { betweenSlotMs: 1000 });
    await waitDone(cal);
    expect(sleeps).toEqual([1000]);
  });

  it('slotIds 필터로 대상이 줄면 대기 횟수도 같이 준다', async () => {
    const { cal, sleeps } = build(4);
    expect(cal.start(['2', '3'], { betweenSlotMs: 1000 }).total).toBe(2);
    await waitDone(cal);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('camera 오버라이드 → 배치 경로의 모든 PlatePtz 가 그 카메라로 생성된다(W4 통로)', async () => {
    const { cal, camerasSeen } = build(2);
    const override = makeCamera('override') as unknown as ICameraClient;
    cal.start(undefined, { betweenSlotMs: 1000, camera: override });
    await waitDone(cal);
    expect(camerasSeen.length).toBeGreaterThan(0);
    for (const c of camerasSeen) expect(c).toBe(override);
  });
});

describe('U5. PtzCalibrator 대기 배선 — 미지정 시 회귀 0', () => {
  it('start() (수동 /calibrate/ptz 경로) → sleep 0회 + PlatePtz 카메라 오버라이드 undefined', async () => {
    const { cal, sleeps, camerasSeen } = build(4);
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    expect(sleeps).toEqual([]); // ★ sleep 코드에 도달조차 하지 않는다.
    for (const c of camerasSeen) expect(c).toBeUndefined(); // 부팅 카메라 사용(기존 동작).
  });

  it('start(undefined, {}) 빈 opts 도 0회', async () => {
    const { cal, sleeps } = build(3);
    cal.start(undefined, {});
    await waitDone(cal);
    expect(sleeps).toEqual([]);
  });

  it('betweenSlotMs:0 은 falsy → 대기 없음', async () => {
    const { cal, sleeps } = build(3);
    cal.start(undefined, { betweenSlotMs: 0 });
    await waitDone(cal);
    expect(sleeps).toEqual([]);
  });
});
