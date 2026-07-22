import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView, SlotCenteringRow } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { PlatePtz, PlatePtzOpts, PlatePtzResult } from '../src/calibrate/platePtz.js';
import type { SlotPtzArtifact } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): **요건5 줌 봉인** (설계서 §11.1 U6 · §"요건5는 검증 대상이지 구현 대상이 아니다").
 *
 * 요건: 줌이 장비 상한에 걸려 목표 판폭(targetPlateWidth)에 도달하지 못해도 —
 *   1) 항목은 `centered:true`(pan/tilt 는 맞았다) · `converged:false`(폭은 못 맞췄다) · `reason` 보유,
 *   2) 그때의 **pan/tilt/zoom 이 slot_setup 에 저장된다**(포기·초기화가 아니라 best-effort 채택).
 * 이 거동은 **이미 구현돼 있다** — 본 파일의 목적은 회귀 봉인이다.
 *
 * 하네스는 ptzCalibratorRecaptureWiring.test.ts 와 동일하게 `makePlatePtz` 시임(카메라·LPD 왕복 0).
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

const PLATE: PlateBox = { quad: rectToQuad({ x: 0.48, y: 0.485, w: 0.05, h: 0.03 }), confidence: 0.9, cls: 'plate' };
const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 2 };
const dummyLpd = { detect: async (): Promise<PlateBox[]> => [] } as unknown as LpdClient;

/** 줌 포화 지점의 실측형 PTZ — 이 값이 slot_setup 까지 그대로 흘러야 한다. */
const SAT_PTZ = { pan: 12.3456, tilt: -4.5678, zoom: 36 };
const SAT_WIDTH = 0.12; // 목표 0.2 미달(상한 도달).

const camera = {
  clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
  requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') }),
  listCameras: async () => ({
    cameras: [{ camIdx: 1, label: 'C1', presets: [{ presetIdx: 1, label: 'C1-P1', pan: 10, tilt: 20, zoom: 2 }] }],
  }),
} as unknown as CameraClient;

/** centerOnPlate 는 성공(pan/tilt 정렬), zoomToPlateWidth 는 zoom_saturated 로 실패. */
function makePlatePtzStub(zoomReason: 'zoom_saturated' | 'max_iterations' = 'zoom_saturated') {
  const zoomCalls: number[] = [];
  const make = (_o: PlatePtzOpts): Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth' | 'centerAndZoomByLadder'> => ({
    centerOnPlate: async (): Promise<PlatePtzResult> => ({
      ok: true, ptz: { pan: 12.3456, tilt: -4.5678, zoom: 4 }, plate: PLATE,
      err: { errX: 0, errY: 0 }, plateWidth: 0.06, gain: GAIN, iterations: 3,
    }),
    zoomToPlateWidth: async (): Promise<PlatePtzResult> => {
      zoomCalls.push(1);
      return {
        ok: false, ptz: SAT_PTZ, plate: PLATE, err: { errX: 0, errY: 0 },
        plateWidth: SAT_WIDTH, gain: GAIN, iterations: 12, reason: zoomReason,
      };
    },
    centerAndZoomByLadder: async (): Promise<PlatePtzResult> => ({
      ok: false, ptz: SAT_PTZ, plate: PLATE, err: { errX: 0, errY: 0 },
      plateWidth: SAT_WIDTH, gain: GAIN, iterations: 12, reason: zoomReason,
    }),
  });
  return { make: make as unknown as PtzCalibratorDeps['makePlatePtz'], zoomCalls };
}

function views(): SlotSetupView[] {
  return [{
    slotId: 7, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null,
    slot3dFrontCenter: null, updatedAt: null,
  }];
}

function build(zoomReason: 'zoom_saturated' | 'max_iterations' = 'zoom_saturated') {
  const sink: SlotCenteringRow[][] = [];
  let artifact: SlotPtzArtifact | undefined;
  const stub = makePlatePtzStub(zoomReason);
  const deps: PtzCalibratorDeps = {
    camera, lpd: dummyLpd, cfg,
    store: {
      getSlotSetup: () => views(),
      upsertSlotCentering: (rows: SlotCenteringRow[]) => { sink.push(rows); },
    } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>,
    makePlatePtz: stub.make,
    writer: (a: SlotPtzArtifact) => { artifact = a; },
    sleep: async () => {}, now: () => 'T',
  };
  return { cal: new PtzCalibrator(deps), sink, getArtifact: () => artifact };
}

async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 40000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

describe('U6. 요건5 줌 봉인 — zoom_saturated 는 정직 실패이되 PTZ 는 채택된다', () => {
  it('slot_ptz 항목: centered:true / converged:false / reason:zoom_saturated', async () => {
    const h = build();
    h.cal.start();
    await waitDone(h.cal);
    expect(h.cal.getStatus().state).toBe('done');

    const items = h.getArtifact()!.items;
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.centered).toBe(true); // pan/tilt 는 맞았다.
    expect(it0.converged).toBe(false); // 폭은 못 맞췄다 — 위장 성공 금지.
    expect(it0.reason).toBe('zoom_saturated');
  });

  it('slot_ptz 항목 PTZ·판폭은 줌 단계(포화 지점) 결과를 그대로 싣는다', async () => {
    const h = build();
    h.cal.start();
    await waitDone(h.cal);
    const it0 = h.getArtifact()!.items[0];
    expect(it0.ptz).toEqual(SAT_PTZ); // 센터 단계 zoom(4) 이 아니라 포화 zoom(36).
    expect(it0.plateWidth).toBe(SAT_WIDTH);
    expect(it0.plateWidth).toBeLessThan(cfg.targetPlateWidth); // 목표 미달을 숨기지 않는다.
  });

  it('★ upsertSlotCentering 에 pan/tilt/zoom 이 저장된다(converged:false 여도 폐기하지 않는다)', async () => {
    const h = build();
    h.cal.start();
    await waitDone(h.cal);

    expect(h.sink).toHaveLength(1); // upsertSlotCentering 1회.
    const rows = h.sink[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      slotId: 7, // globalIdx = slot_setup.slot_id.
      pan: SAT_PTZ.pan,
      tilt: SAT_PTZ.tilt,
      zoom: SAT_PTZ.zoom,
      centered: 1, // ★ 저장 게이트는 centered 뿐 — converged 는 slot_ptz.json 이 정본.
      img1: null,
      updatedAt: 'T',
    });
  });

  it('zoom 실패 사유가 max_iterations 여도 동일 규약(포화만의 특례가 아니다)', async () => {
    const h = build('max_iterations');
    h.cal.start();
    await waitDone(h.cal);
    const it0 = h.getArtifact()!.items[0];
    expect(it0.centered).toBe(true);
    expect(it0.converged).toBe(false);
    expect(it0.reason).toBe('max_iterations');
    expect(h.sink[0][0].zoom).toBe(SAT_PTZ.zoom); // PTZ 저장은 동일.
  });

  it('회귀 대조: 줌이 수렴하면 converged:true + reason 없음 (실패 경로만의 거동임을 고정)', async () => {
    const sink: SlotCenteringRow[][] = [];
    let artifact: SlotPtzArtifact | undefined;
    const okPtz = { pan: 9, tilt: -3, zoom: 10.4 };
    const make = (): Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth'> => ({
      centerOnPlate: async (): Promise<PlatePtzResult> => ({
        ok: true, ptz: { pan: 9, tilt: -3, zoom: 4 }, plate: PLATE,
        err: { errX: 0, errY: 0 }, plateWidth: 0.06, gain: GAIN, iterations: 3,
      }),
      zoomToPlateWidth: async (): Promise<PlatePtzResult> => ({
        ok: true, ptz: okPtz, plate: PLATE, err: { errX: 0, errY: 0 },
        plateWidth: 0.201, gain: GAIN, iterations: 4,
      }),
    });
    const cal = new PtzCalibrator({
      camera, lpd: dummyLpd, cfg,
      store: {
        getSlotSetup: () => views(),
        upsertSlotCentering: (rows: SlotCenteringRow[]) => { sink.push(rows); },
      } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>,
      makePlatePtz: make as unknown as PtzCalibratorDeps['makePlatePtz'],
      writer: (a: SlotPtzArtifact) => { artifact = a; },
      sleep: async () => {}, now: () => 'T',
    });
    cal.start();
    await waitDone(cal);
    const it0 = artifact!.items[0];
    expect(it0.converged).toBe(true);
    expect(it0.reason).toBeUndefined();
    expect(sink[0][0]).toMatchObject({ pan: okPtz.pan, tilt: okPtz.tilt, zoom: okPtz.zoom, centered: 1 });
  });
});
