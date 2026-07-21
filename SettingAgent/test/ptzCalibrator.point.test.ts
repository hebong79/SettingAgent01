import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SaveStore } from '../src/store/SaveStore.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import type { PlatePtzOpts } from '../src/calibrate/platePtz.js';
import type { PlateTarget, Ptz } from '../src/calibrate/types.js';
import { rectToQuad, quadBoundingRect } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): PtzCalibrator.centerOnPoint (개별·클릭 센터라이징, 설계서 §5-A).
 *
 * makePlatePtz(팩토리 시임)를 스파이로 주입해 centerOnPlate/zoomToPlateWidth 호출 인자·opts 를 캡처한다.
 * 핵심 회귀 가드: store.upsertSlotCentering·writer·saveStore.saveSnapshot 호출 0회(저장 없음).
 * 경계면: centerOnPoint 반환 타입 ↔ 라우트 응답 shape 은 calibrateRoutes.point.test.ts 에서 교차.
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

/** 프리셋 PTZ 소스(startPtzFor → resolvePresetPtz → listCameras). cam1/preset1 = pan10/tilt20/zoom2. */
const PRESET_PTZ: Ptz = { pan: 10, tilt: 20, zoom: 2 };

function makeCamera(): CameraClient {
  return {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    listCameras: async () => ({
      cameras: [{ camIdx: 1, label: 'C1', presets: [{ presetIdx: 1, label: 'C1-P1', pan: 10, tilt: 20, zoom: 2 }] }],
    }),
  } as unknown as CameraClient;
}

const stubLpd = { detect: async (): Promise<PlateBox[]> => [] } as unknown as LpdClient;

function plateBox(rect = { x: 0.5, y: 0.5, w: 0.05, h: 0.03 }): PlateBox {
  return { quad: rectToQuad(rect), confidence: 0.9, cls: 'plate' };
}

interface PlatePtzResultLike {
  ok: boolean;
  ptz: Ptz;
  plate: PlateBox | null;
  err: null;
  plateWidth: number | null;
  gain: { gainPan: number; gainTilt: number; zoomRef: number };
  iterations: number;
  reason?: string;
}

const PLATE = plateBox();
const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 2 };

const centerOkResult: PlatePtzResultLike = {
  ok: true, ptz: { pan: 11, tilt: 21, zoom: 2 }, plate: PLATE, err: null,
  plateWidth: 0.05, gain: GAIN, iterations: 3,
};
const centerFailResult: PlatePtzResultLike = {
  ok: false, ptz: { pan: 10.5, tilt: 20.5, zoom: 2 }, plate: null, err: null,
  plateWidth: null, gain: GAIN, iterations: 30, reason: 'no_plate',
};
const zoomOkResult: PlatePtzResultLike = {
  ok: true, ptz: { pan: 11, tilt: 21, zoom: 4 }, plate: PLATE, err: null,
  plateWidth: 0.2, gain: GAIN, iterations: 2,
};
const zoomLostResult: PlatePtzResultLike = {
  ok: false, ptz: { pan: 11, tilt: 21, zoom: 3 }, plate: null, err: null,
  plateWidth: 0.15, gain: GAIN, iterations: 5, reason: 'plate_lost',
};

interface FactoryRec {
  opts: PlatePtzOpts;
  centerArgs?: { cam: number; preset: number; startPtz: Ptz };
  zoomArgs?: { cam: number; preset: number; startPtz: Ptz };
}

/** makePlatePtz 스파이 팩토리. center/zoom 결과를 주입하고 호출 opts·인자를 캡처. */
function spyFactory(centerResult: PlatePtzResultLike, zoomResult: PlatePtzResultLike) {
  const recs: FactoryRec[] = [];
  let centerCalls = 0;
  let zoomCalls = 0;
  const makePlatePtz = (opts: PlatePtzOpts) => {
    const rec: FactoryRec = { opts };
    recs.push(rec);
    return {
      centerOnPlate: async (cam: number, preset: number, startPtz: Ptz) => {
        centerCalls += 1;
        rec.centerArgs = { cam, preset, startPtz };
        return centerResult as never;
      },
      zoomToPlateWidth: async (cam: number, preset: number, startPtz: Ptz) => {
        zoomCalls += 1;
        rec.zoomArgs = { cam, preset, startPtz };
        return zoomResult as never;
      },
    };
  };
  return { makePlatePtz: makePlatePtz as unknown as PtzCalibratorDeps['makePlatePtz'], recs, counts: () => ({ centerCalls, zoomCalls }) };
}

/** 저장 스파이(3종) + calibrator 조립. views 는 배치 소스(centerOnPoint 은 미사용, 배치 running 가드용). */
function build(opts: {
  center?: PlatePtzResultLike;
  zoom?: PlatePtzResultLike;
  makePlatePtz?: PtzCalibratorDeps['makePlatePtz'];
  views?: SlotSetupView[];
  camera?: CameraClient;
}) {
  const upserts: unknown[][] = [];
  const writes: unknown[] = [];
  const snaps: unknown[] = [];
  const store = {
    getSlotSetup: () => opts.views ?? [],
    upsertSlotCentering: (rows: unknown[]) => { upserts.push(rows); },
  } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  const saveStore = { saveSnapshot: (name: string, payload: unknown) => { snaps.push({ name, payload }); } } as unknown as Pick<SaveStore, 'saveSnapshot'>;

  const spy = opts.makePlatePtz
    ? { makePlatePtz: opts.makePlatePtz, recs: [] as FactoryRec[], counts: () => ({ centerCalls: 0, zoomCalls: 0 }) }
    : spyFactory(opts.center ?? centerOkResult, opts.zoom ?? zoomOkResult);

  const deps: PtzCalibratorDeps = {
    camera: opts.camera ?? makeCamera(), lpd: stubLpd, cfg, store,
    makePlatePtz: spy.makePlatePtz,
    writer: (art, out) => { writes.push({ art, out }); },
    saveStore,
    sleep: async () => {}, now: () => 'T',
  };
  return { cal: new PtzCalibrator(deps), spy, upserts, writes, snaps };
}

const PT = { x: 0.42, y: 0.58 };

/** slot_setup fixture(배치 running 가드 테스트용 — lpd 보유 1슬롯). */
function views(): SlotSetupView[] {
  return [{
    slotId: 7, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
  }];
}

describe('centerOnPoint — 클릭 point = plateRoi prior (§5-A-1)', () => {
  it('makePlatePtz 첫 호출 opts.plateRoi={x,y,w:0,h:0}, centerOnPlate(cam,preset,프리셋 startPtz)', async () => {
    const { cal, spy } = build({ zoom: zoomOkResult });
    await cal.centerOnPoint(1, 1, PT, { zoom: false });

    expect(spy.recs.length).toBeGreaterThanOrEqual(1);
    expect(spy.recs[0].opts.plateRoi).toEqual({ x: PT.x, y: PT.y, w: 0, h: 0 });
    // startPtz 는 프리셋 정본(listCameras) — echo 아님.
    expect(spy.recs[0].centerArgs).toEqual({ cam: 1, preset: 1, startPtz: PRESET_PTZ });
  });
});

describe('centerOnPoint — 기준 PTZ = 현재 PTZ (실카 안전장치)', () => {
  it('camera.getPtz 를 호출해 그 값을 centerOnPlate 시작 PTZ 로 쓴다(프리셋 테이블 없는 실카 대비)', async () => {
    const CUR: Ptz = { pan: -141.479, tilt: -3.2, zoom: 2 };
    const getPtzCalls: number[] = [];
    const camera = {
      ...makeCamera(),
      getPtz: async (cam: number) => { getPtzCalls.push(cam); return CUR; },
    } as unknown as CameraClient;
    const { cal, spy } = build({ camera, center: centerOkResult });
    await cal.centerOnPoint(1, 1, PT, { zoom: false });

    expect(getPtzCalls).toEqual([1]);
    expect(spy.recs[0].centerArgs?.startPtz).toEqual(CUR); // 프리셋(PRESET_PTZ)이 아니라 현재 PTZ.
  });
});

describe('centerOnPoint — 저장 스파이 0회 (§5-A-2 핵심 회귀 가드)', () => {
  it('성공 경로: upsertSlotCentering·writer·saveSnapshot 전부 0회', async () => {
    const { cal, upserts, writes, snaps } = build({ center: centerOkResult, zoom: zoomOkResult });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(r.ok).toBe(true);
    expect(upserts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(snaps).toHaveLength(0);
  });

  it('실패 경로(no_plate): 저장 여전히 0회', async () => {
    const { cal, upserts, writes, snaps } = build({ center: centerFailResult });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(r.ok).toBe(false);
    expect(upserts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(snaps).toHaveLength(0);
  });
});

describe('centerOnPoint — zoom 분기 (§5-A-3)', () => {
  it('기본(opts 미지정) → zoomToPlateWidth 체이닝(gain 전달·plateRoi=boundingRect), z.ok 결과 반환', async () => {
    const { cal, spy } = build({ center: centerOkResult, zoom: zoomOkResult });
    const r = await cal.centerOnPoint(1, 1, PT); // opts 미지정 = zoom 기본 on

    const c = spy.counts();
    expect(c.centerCalls).toBe(1);
    expect(c.zoomCalls).toBe(1);
    // 2번째 팩토리 호출(zoom)의 opts: gain 체이닝 + plateRoi=center.plate boundingRect.
    expect(spy.recs).toHaveLength(2);
    expect(spy.recs[1].opts.gain).toEqual(GAIN);
    expect(spy.recs[1].opts.plateRoi).toEqual(quadBoundingRect(PLATE.quad));
    // zoomToPlateWidth 는 center.ptz 를 startPtz 로 받음.
    expect(spy.recs[1].zoomArgs).toEqual({ cam: 1, preset: 1, startPtz: centerOkResult.ptz });
    // 반환은 zoom 성공 결과 기반.
    expect(r).toEqual({ ok: true, ptz: zoomOkResult.ptz, plateWidth: 0.2 });
  });

  it('zoom:true 명시 → zoomToPlateWidth 호출', async () => {
    const { cal, spy } = build({ center: centerOkResult, zoom: zoomOkResult });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(spy.counts().zoomCalls).toBe(1);
  });

  it('zoom:false → zoomToPlateWidth 미호출, center 결과 반환', async () => {
    const { cal, spy } = build({ center: centerOkResult, zoom: zoomOkResult });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: false });
    expect(spy.counts().zoomCalls).toBe(0);
    expect(spy.counts().centerCalls).toBe(1);
    expect(r).toEqual({ ok: true, ptz: centerOkResult.ptz, plateWidth: 0.05 });
  });
});

describe('centerOnPoint — 줌 실패 시맨틱 (§5-A-4, 구현이 정본)', () => {
  it('center ok + zoom plate_lost → center 결과 기반 반환(ok:true, zoom reason 미전파)', async () => {
    const { cal, spy } = build({ center: centerOkResult, zoom: zoomLostResult });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    // 구현: z.ok=false 이면 낙하해 center 결과 반환. z.reason('plate_lost')는 전파 안 됨.
    expect(spy.counts().zoomCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.ptz).toEqual(centerOkResult.ptz);
    expect(r.plateWidth).toBe(centerOkResult.plateWidth);
    expect(r.reason).toBeUndefined();
  });
});

describe('centerOnPoint — 상호배타 (§5-A-5)', () => {
  it('배치 state===running 중 호출 → throw(메시지에 running)', async () => {
    // 배치가 running 을 유지하도록 centerOnPlate 가 영원히 pending 인 팩토리 주입.
    const hangFactory = ((_opts: PlatePtzOpts) => ({
      centerOnPlate: () => new Promise(() => {}),
      zoomToPlateWidth: () => new Promise(() => {}),
    })) as unknown as PtzCalibratorDeps['makePlatePtz'];
    const { cal } = build({ makePlatePtz: hangFactory, views: views() });
    cal.start(); // state='running'(동기 설정), run() 은 centerOnPlate 에서 영구 보류.
    expect(cal.getStatus().state).toBe('running');
    await expect(cal.centerOnPoint(1, 1, PT)).rejects.toThrow(/running/);
  });

  it('pointBusy 재진입(await 없이 2회) → 2번째 throw(busy)', async () => {
    const { cal } = build({ center: centerOkResult, zoom: zoomOkResult });
    const p1 = cal.centerOnPoint(1, 1, PT, { zoom: false }); // pointBusy=true 후 startPtzFor await 로 보류.
    const p2 = cal.centerOnPoint(1, 1, PT, { zoom: false }); // 동기 prefix 에서 pointBusy=true 관측 → throw.
    await expect(p2).rejects.toThrow(/busy/);
    await expect(p1).resolves.toMatchObject({ ok: true }); // 첫 호출은 정상 완료.
  });
});

describe('centerOnPoint — centerOnPlate 실패 (§5-A-6)', () => {
  it('no_plate → {ok:false, reason:"no_plate"}, zoom 미호출, 저장 0회', async () => {
    const { cal, spy, upserts, writes, snaps } = build({ center: centerFailResult });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_plate');
    expect(r.ptz).toEqual(centerFailResult.ptz);
    expect(r.plateWidth).toBeNull();
    expect(spy.counts().zoomCalls).toBe(0); // center 실패 → zoom 분기 진입 안 함.
    expect(upserts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(snaps).toHaveLength(0);
  });
});
