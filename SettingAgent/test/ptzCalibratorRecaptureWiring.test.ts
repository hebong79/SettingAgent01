import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { CameraClient, ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { PlatePtz, PlatePtzOpts, PlatePtzResult } from '../src/calibrate/platePtz.js';
import type { NormalizedPoint, NormalizedRect } from '../src/domain/types.js';
import type { Ptz } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): **재포착 옵션 주입 경계면 + P1(줌 실패 삼킴 제거)** 고정.
 *
 * 관례는 `ptzCalibrator.point.test.ts` / `centeringPreAim.test.ts` 와 동일하게 `makePlatePtz` 팩토리를
 * 시임으로 주입해 **생성 opts** 를 캡처한다. 재포착이 개별(클릭) 경로에만 도달하고 배치·사다리에는
 * **코드가 닿지 않는다**는 것을 논증이 아니라 관측으로 고정한다(설계 §6.2·§6.3).
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

const RECAPTURE_KEYS = ['plateRecaptureDitherNorm', 'plateRecaptureRetries', 'plateRecaptureZoomStep'] as const;
const hasAnyRecaptureKey = (o: PlatePtzOpts): boolean => RECAPTURE_KEYS.some((k) => k in o);

const PLATE: PlateBox = { quad: rectToQuad({ x: 0.48, y: 0.485, w: 0.05, h: 0.03 }), confidence: 0.9, cls: 'plate' };
const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 2 };
const dummyLpd = { detect: async (): Promise<PlateBox[]> => [] } as unknown as LpdClient;

function makeCamera(over: Partial<Record<string, unknown>> = {}): CameraClient {
  return {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') }),
    listCameras: async () => ({
      cameras: [{ camIdx: 1, label: 'C1', presets: [{ presetIdx: 1, label: 'C1-P1', pan: 10, tilt: 20, zoom: 2 }] }],
    }),
    ...over,
  } as unknown as CameraClient;
}

/** makePlatePtz 시임: 생성 opts 를 전부 기록하고 center/zoom/ladder 결과를 주입한다. */
function optsSpy(res: { center?: Partial<PlatePtzResult>; zoom?: Partial<PlatePtzResult>; ladder?: Partial<PlatePtzResult> } = {}) {
  const optsSeen: PlatePtzOpts[] = [];
  const ok = (over: Partial<PlatePtzResult>): PlatePtzResult => ({
    ok: true, ptz: { pan: 11, tilt: 21, zoom: 4 }, plate: PLATE, err: { errX: 0, errY: 0 },
    plateWidth: 0.2, gain: GAIN, iterations: 1, ...over,
  });
  const make = (opts: PlatePtzOpts): Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth' | 'centerAndZoomByLadder'> => {
    optsSeen.push(opts);
    return {
      centerOnPlate: async (): Promise<PlatePtzResult> => ok({ ptz: { pan: 11, tilt: 21, zoom: 2 }, plateWidth: 0.05, ...res.center }),
      zoomToPlateWidth: async (): Promise<PlatePtzResult> => ok(res.zoom ?? {}),
      centerAndZoomByLadder: async (): Promise<PlatePtzResult> => ok(res.ladder ?? {}),
    };
  };
  return { make: make as unknown as PtzCalibratorDeps['makePlatePtz'], optsSeen };
}

function view(slotId: number, lpdRect: NormalizedRect): SlotSetupView {
  return {
    slotId, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad(lpdRect), occupyRange: null,
    pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
  };
}

function build(over: { makePlatePtz: PtzCalibratorDeps['makePlatePtz']; camera?: CameraClient; views?: SlotSetupView[]; cfg?: ToolsConfig['calibrate'] }) {
  const store = {
    getSlotSetup: () => over.views ?? [],
    upsertSlotCentering: () => {},
  } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  const deps: PtzCalibratorDeps = {
    camera: over.camera ?? makeCamera(), lpd: dummyLpd, cfg: over.cfg ?? cfg, store,
    makePlatePtz: over.makePlatePtz, writer: () => {}, sleep: async () => {}, now: () => 'T',
  };
  return new PtzCalibrator(deps);
}

async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 20000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

const PT: NormalizedPoint = { x: 0.42, y: 0.58 };

// ══════════════════════════════════════════════════════════════════════════════
// W1. 주입 경로 — 개별(클릭)에만, 배치·사다리에는 도달하지 않는다
// ══════════════════════════════════════════════════════════════════════════════
describe('W1. 재포착 옵션 주입 범위', () => {
  it('centerOnPoint 의 center·zoom 두 PlatePtz 모두 재포착 옵션(6 / 0.0014 / 0.01)을 받는다', async () => {
    const spy = optsSpy();
    const cal = build({ makePlatePtz: spy.make });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });

    expect(spy.optsSeen).toHaveLength(2);
    for (const o of spy.optsSeen) {
      expect(o.plateRecaptureRetries).toBe(6);
      expect(o.plateRecaptureDitherNorm).toBe(0.0014);
      expect(o.plateRecaptureZoomStep).toBe(0.01);
    }
  });

  it('cfg 로 튜닝 가능(pointRecapture* → PlatePtz 옵션)', async () => {
    const spy = optsSpy();
    const cal = build({
      makePlatePtz: spy.make,
      cfg: { ...cfg, pointRecaptureRetries: 4, pointRecaptureDitherNorm: 0.003, pointRecaptureZoomStep: 0.02 },
    });
    await cal.centerOnPoint(1, 1, PT, { zoom: false });
    expect(spy.optsSeen[0]!.plateRecaptureRetries).toBe(4);
    expect(spy.optsSeen[0]!.plateRecaptureDitherNorm).toBe(0.003);
    expect(spy.optsSeen[0]!.plateRecaptureZoomStep).toBe(0.02);
  });

  it('★ 배치(calibrateSlot) 경로의 어떤 PlatePtz 도 재포착 키를 받지 않는다(구조적 무회귀)', async () => {
    const spy = optsSpy();
    const cal = build({ makePlatePtz: spy.make, views: [view(7, { x: 0.62, y: 0.62, w: 0.05, h: 0.03 })] });
    cal.start();
    await waitDone(cal);

    expect(spy.optsSeen.length).toBeGreaterThan(0);
    for (const o of spy.optsSeen) expect(hasAnyRecaptureKey(o)).toBe(false);
  });

  it('★ 사다리 경로(centerAndZoomByLadder)의 opts 에도 재포착 키가 없다', async () => {
    const spy = optsSpy();
    // 네이티브 센터링 지원 소스 → cfg.pointZoomLadder 'auto' 에서 사다리가 켜진다.
    const camera = makeCamera({ centerOnPoint: async (_c: number, _p: NormalizedPoint): Promise<Ptz> => ({ pan: 1, tilt: 2, zoom: 3 }) });
    const cal = build({ makePlatePtz: spy.make, camera });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });

    expect(spy.optsSeen).toHaveLength(1); // 사다리 한 호출로 완결
    expect(hasAnyRecaptureKey(spy.optsSeen[0]!)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W2. ★ P1 — 줌 실패 삼킴(위장 성공) 제거 회귀 가드
// ══════════════════════════════════════════════════════════════════════════════
describe('W2. P1 위장 성공 제거(줌 결과가 정본)', () => {
  /** 리더 라이브 실측 재현: 센터링은 성공했으나 줌 단계가 실패 → 구 코드는 ok:true 로 위장했다. */
  const centerOk: Partial<PlatePtzResult> = { ok: true, ptz: { pan: 12, tilt: 11, zoom: 1.6934 }, plateWidth: 0.032 };

  it.each([
    ['plate_lost', { ok: false, ptz: { pan: 12, tilt: 11, zoom: 1.6934 }, plateWidth: 0.032, reason: 'plate_lost' as const }],
    ['zoom_saturated', { ok: false, ptz: { pan: 12, tilt: 11, zoom: 36 }, plateWidth: 0.12, reason: 'zoom_saturated' as const }],
    ['max_iterations', { ok: false, ptz: { pan: 12, tilt: 11, zoom: 9 }, plateWidth: 0.1, reason: 'max_iterations' as const }],
  ])('줌 실패(%s) → ok:false + 줌 단계 reason·ptz·plateWidth 전파(센터링 결과로 위장하지 않는다)', async (_name, zoom) => {
    const spy = optsSpy({ center: centerOk, zoom });
    const cal = build({ makePlatePtz: spy.make });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe(zoom.reason);
    expect(r.ptz).toEqual(zoom.ptz);
    expect(r.plateWidth).toBe(zoom.plateWidth);
  });

  it('★ 라이브 위장 성공 재현 — zoom 1.69 / plateWidth 0.032 인데 ok:true 가 되는 경로가 없다', async () => {
    const spy = optsSpy({ center: centerOk, zoom: { ok: false, ptz: { pan: 12, tilt: 11, zoom: 1.6934 }, plateWidth: 0.032, reason: 'plate_lost' } });
    const cal = build({ makePlatePtz: spy.make });
    for (const opts of [undefined, { zoom: true }]) {
      const r = await cal.centerOnPoint(1, 1, PT, opts);
      expect(r.ok).toBe(false);
      expect(r.plateWidth).toBe(0.032);
      expect(r.reason).toBeDefined(); // UI 는 `종료(${reason})` 로 사유를 표시한다
    }
  });

  it('줌 성공은 종전과 동일하게 줌 결과를 반환(반전이 성공 경로를 건드리지 않았다)', async () => {
    const spy = optsSpy({ center: centerOk, zoom: { ok: true, ptz: { pan: 12, tilt: 11, zoom: 10.4 }, plateWidth: 0.226 } });
    const cal = build({ makePlatePtz: spy.make });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(r).toEqual({ ok: true, ptz: { pan: 12, tilt: 11, zoom: 10.4 }, plateWidth: 0.226 });
  });

  it('zoom:false(줌 미시도)는 센터링 결과가 정본 — P1 반전의 적용 대상이 아니다', async () => {
    const spy = optsSpy({ center: centerOk });
    const cal = build({ makePlatePtz: spy.make });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: false });
    expect(r).toEqual({ ok: true, ptz: centerOk.ptz, plateWidth: 0.032 });
  });
});
