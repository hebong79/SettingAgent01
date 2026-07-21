import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import type { CameraClient, ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { PlatePtzOpts } from '../src/calibrate/platePtz.js';
import type { Ptz } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): `PtzCalibrator.centerOnPoint` 의 **사다리 진입 분기**(설계 §2.4 · 구현 §7 T4/T7).
 * 핵심 회귀 가드(Requirement 4): `pointZoomLadder='auto'` + 네이티브 없는 카메라 →
 * 신규 코드가 **한 줄도 실행되지 않고** 기존 centerOnPlate→zoomToPlateWidth 경로를 탄다.
 *
 * ptzCalibrator.point.test.ts 의 스파이 팩토리 패턴을 따르되, 팩토리에 centerAndZoomByLadder 를 추가하고
 * 호출 순서를 문자열 로그로 남겨 "무엇이 실행되었는가"를 순서까지 대조한다.
 */

const baseCfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

const CUR: Ptz = { pan: -141.479, tilt: -3.2, zoom: 2 };
const PLATE: PlateBox = { quad: rectToQuad({ x: 0.5, y: 0.5, w: 0.05, h: 0.03 }), confidence: 0.9, cls: 'plate' };
const GAIN = { gainPan: -62, gainTilt: -35.5, zoomRef: 2 };
const PT = { x: 0.05, y: 0.5 };

const centerOk = { ok: true, ptz: { pan: 1, tilt: 1, zoom: 2 }, plate: PLATE, err: null, plateWidth: 0.05, gain: GAIN, iterations: 3 };
const zoomOk = { ok: true, ptz: { pan: 1, tilt: 1, zoom: 4 }, plate: PLATE, err: null, plateWidth: 0.2, gain: GAIN, iterations: 2 };
const ladderOk = { ok: true, ptz: { pan: 9, tilt: 9, zoom: 8 }, plate: PLATE, err: null, plateWidth: 0.2, gain: GAIN, iterations: 5 };
const ladderFail = { ok: false, ptz: { pan: 9, tilt: 9, zoom: 36 }, plate: null, err: null, plateWidth: null, gain: GAIN, iterations: 9, reason: 'plate_not_found_at_max_zoom' as const };

/** 네이티브(centerOnPoint) 유무만 다른 카메라 스텁. getPtz 는 항상 현재 PTZ 를 준다. */
function makeCamera(native: boolean): CameraClient {
  const cam: Record<string, unknown> = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    getPtz: async () => CUR,
    listCameras: async () => ({ cameras: [{ camIdx: 1, label: 'C1', presets: [{ presetIdx: 1, label: 'P1', pan: 10, tilt: 20, zoom: 2 }] }] }),
  };
  if (native) cam.centerOnPoint = async (_c: number, _p: unknown) => CUR;
  return cam as unknown as CameraClient;
}

const stubLpd = { detect: async (): Promise<PlateBox[]> => [] } as unknown as LpdClient;

interface Rec { opts: PlatePtzOpts; camera?: ICameraClient }

/** 3메서드 전부를 가진 스파이 팩토리 + 호출 순서 로그. */
function spyFactory(res: { ladder?: typeof ladderOk | typeof ladderFail } = {}) {
  const recs: Rec[] = [];
  const order: string[] = [];
  const makePlatePtz = (opts: PlatePtzOpts, camera?: ICameraClient) => {
    recs.push({ opts, ...(camera ? { camera } : {}) });
    return {
      centerOnPlate: async () => { order.push('center'); return centerOk as never; },
      zoomToPlateWidth: async () => { order.push('zoom'); return zoomOk as never; },
      centerAndZoomByLadder: async () => { order.push('ladder'); return (res.ladder ?? ladderOk) as never; },
    };
  };
  return { makePlatePtz: makePlatePtz as unknown as PtzCalibratorDeps['makePlatePtz'], recs, order };
}

/** centerAndZoomByLadder 를 **구현하지 않은** 구형 스텁(설계 §7 하위호환 함정 검증). */
function legacyFactory() {
  const order: string[] = [];
  const makePlatePtz = (_opts: PlatePtzOpts) => ({
    centerOnPlate: async () => { order.push('center'); return centerOk as never; },
    zoomToPlateWidth: async () => { order.push('zoom'); return zoomOk as never; },
  });
  return { makePlatePtz: makePlatePtz as unknown as PtzCalibratorDeps['makePlatePtz'], order };
}

function build(opts: { cfg?: Partial<ToolsConfig['calibrate']>; native: boolean; factory: { makePlatePtz: PtzCalibratorDeps['makePlatePtz'] } }) {
  const store = {
    getSlotSetup: () => [],
    upsertSlotCentering: () => {},
  } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  const deps: PtzCalibratorDeps = {
    camera: makeCamera(opts.native), lpd: stubLpd,
    cfg: { ...baseCfg, ...opts.cfg }, store,
    makePlatePtz: opts.factory.makePlatePtz,
    writer: () => {}, sleep: async () => {}, now: () => 'T',
  };
  return new PtzCalibrator(deps);
}

// ══════════════════════════════════════════════════════════════════════════════
// T4 — Requirement 4: 시뮬 경로 기존 동작 불변(신규 코드 0줄 실행)
// ══════════════════════════════════════════════════════════════════════════════
describe('T4. pointZoomLadder 미설정(auto) + 네이티브 없는 카메라 = 시뮬', () => {
  it('★기존 경로 그대로 — centerOnPlate → zoomToPlateWidth, 사다리 미호출', async () => {
    const f = spyFactory();
    const cal = build({ native: false, factory: f });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });

    expect(f.order).toEqual(['center', 'zoom']); // 순서까지 기존과 동일
    expect(f.order).not.toContain('ladder');
    expect(r).toEqual({ ok: true, ptz: zoomOk.ptz, plateWidth: 0.2 });
    // 사다리 전용 opts 가 기존 경로 opts 로 새지 않는다.
    expect(f.recs[0]!.opts.ladderMaxRungs).toBeUndefined();
    expect(f.recs[0]!.opts.nativeAimSettleMs).toBeUndefined();
  });

  it('Requirement 1 은 시뮬 클릭 경로에도 적용 — 첫 centerOnPlate 에 initialRadiusNorm=0.10 주입', async () => {
    const f = spyFactory();
    const cal = build({ native: false, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: false });
    expect(f.recs[0]!.opts.plateRoi).toEqual({ x: PT.x, y: PT.y, w: 0, h: 0 });
    expect(f.recs[0]!.opts.initialRadiusNorm).toBe(0.1);
  });

  it('체이닝 zoomToPlateWidth 에는 게이트를 주입하지 않는다(설계 §1.4 — 배치 회귀 위험 회피)', async () => {
    const f = spyFactory();
    const cal = build({ native: false, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.recs[1]!.opts.initialRadiusNorm).toBeUndefined();
  });

  it('cfg.pointMatchRadiusNorm 이 있으면 그 값이 쓰인다(코드 수정 없는 라이브 튜닝)', async () => {
    const f = spyFactory();
    const cal = build({ native: false, cfg: { pointMatchRadiusNorm: 0.13 }, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: false });
    expect(f.recs[0]!.opts.initialRadiusNorm).toBe(0.13);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T2/T5/T7 — 진입 분기표
// ══════════════════════════════════════════════════════════════════════════════
describe('사다리 진입 분기(cfg × 네이티브 × mode)', () => {
  it("auto + 네이티브 카메라(실카) → 사다리 1회, 기존 2메서드 0회", async () => {
    const f = spyFactory();
    const cal = build({ native: true, factory: f });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.order).toEqual(['ladder']);
    expect(r).toEqual({ ok: true, ptz: ladderOk.ptz, plateWidth: 0.2 });
    // 사다리 opts: 게이트 + (cfg 미설정이므로) 코드 기본값을 쓰도록 미전달.
    expect(f.recs[0]!.opts.initialRadiusNorm).toBe(0.1);
    expect(f.recs[0]!.opts.ladderMaxRungs).toBeUndefined();
    // plateRoi 는 주지 않는다(조준 후 클릭점 = 화면중앙).
    expect(f.recs[0]!.opts.plateRoi).toBeUndefined();
  });

  it("'always' + 네이티브 없는 카메라 → 사다리(기하 폴백 경로 실험 스위치)", async () => {
    const f = spyFactory();
    const cal = build({ native: false, cfg: { pointZoomLadder: 'always' }, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.order).toEqual(['ladder']);
  });

  it("T7. 'off' + 네이티브 카메라 → 기존 경로(배포 없는 롤백 안전핀)", async () => {
    const f = spyFactory();
    const cal = build({ native: true, cfg: { pointZoomLadder: 'off' }, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.order).toEqual(['center', 'zoom']);
  });

  it("mode:'plate'(zoom:false) 는 네이티브여도 사다리를 타지 않는다(범위 밖)", async () => {
    const f = spyFactory();
    const cal = build({ native: true, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: false });
    expect(f.order).toEqual(['center']);
    expect(f.recs[0]!.opts.initialRadiusNorm).toBe(0.1); // 단 게이트는 적용
  });

  it('cfg.ladderMaxRungs·nativeAimSettleMs 는 지정 시에만 전달된다', async () => {
    const f = spyFactory();
    const cal = build({ native: true, cfg: { ladderMaxRungs: 5, nativeAimSettleMs: 250 }, factory: f });
    await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.recs[0]!.opts.ladderMaxRungs).toBe(5);
    expect(f.recs[0]!.opts.nativeAimSettleMs).toBe(250);
  });

  it('★하위호환: 사다리 미구현 스텁 + 네이티브 카메라 → 타입/런타임 에러 없이 기존 경로 폴백', async () => {
    const f = legacyFactory();
    const cal = build({ native: true, factory: f });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.order).toEqual(['center', 'zoom']);
    expect(r.ok).toBe(true);
  });
});

describe('사다리 실패는 실패로 보고한다(조용한 기존 경로 재시도 금지)', () => {
  it('사다리 실패 시 reason 을 그대로 반환하고 centerOnPlate 로 되돌아가지 않는다', async () => {
    const f = spyFactory({ ladder: ladderFail });
    const cal = build({ native: true, factory: f });
    const r = await cal.centerOnPoint(1, 1, PT, { zoom: true });
    expect(f.order).toEqual(['ladder']); // 실패 후 기존 경로 재시도 없음(거짓 성공 방지)
    expect(r).toEqual({ ok: false, ptz: ladderFail.ptz, plateWidth: null, reason: 'plate_not_found_at_max_zoom' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Requirement 5 — source 라우팅(주입 카메라)이 사다리 판정·실행 전 구간에 쓰인다
// ══════════════════════════════════════════════════════════════════════════════
describe('R5. opts.camera(뷰어 소스) 우선', () => {
  it('파이프라인 카메라가 네이티브여도 주입 카메라가 비네이티브면 사다리를 타지 않는다', async () => {
    const f = spyFactory();
    const cal = build({ native: true, factory: f }); // 파이프라인 = 네이티브
    await cal.centerOnPoint(1, 1, PT, { zoom: true, camera: makeCamera(false) as unknown as ICameraClient });
    expect(f.order).toEqual(['center', 'zoom']); // 판정 기준이 주입 카메라다
  });

  it('주입 카메라가 네이티브면(파이프라인은 아님) 사다리를 타고 그 카메라가 PlatePtz 로 전달된다', async () => {
    const f = spyFactory();
    const cal = build({ native: false, factory: f }); // 파이프라인 = 비네이티브(시뮬)
    const injected = makeCamera(true) as unknown as ICameraClient;
    await cal.centerOnPoint(1, 1, PT, { zoom: true, camera: injected });
    expect(f.order).toEqual(['ladder']);
    expect(f.recs[0]!.camera).toBe(injected); // ★ 사다리가 쓰는 카메라 = 주입 소스
  });
});
