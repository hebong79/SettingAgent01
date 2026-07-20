import { describe, it, expect, vi } from 'vitest';
import { logger } from '../src/util/logger.js';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { expandPlateTargets } from '../src/calibrate/slotPtzWriter.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { SlotSetupRow, SlotSetupView } from '../src/capture/types.js';
import { rectToQuad, quadBoundingRect, center } from '../src/domain/geometry.js';
import { scaleGainForZoom, panTiltCorrection } from '../src/calibrate/controlMath.js';
import { round5 } from '../src/util/round.js';
import type { SlotPtzArtifact, Ptz } from '../src/calibrate/types.js';
import type { PlatePtzOpts, PlatePtzResult } from '../src/calibrate/platePtz.js';

/**
 * 검증자(qa-tester): 센터라이징(PtzCalibrator→PlatePtz 위임 + slot_setup 센터라이징 미러).
 * ★ DB 개편: 구 upsertCenteringSlots/getCenteringSlots(문자열 slotId + pos JSON) → 신 upsertSlotCentering
 *   (정수 slot_id=globalIdx + 분해 pan/tilt/zoom, 부분 UPDATE). slot_setup 이 **먼저 존재**해야 UPDATE 반영.
 * 비-DB 계약(T1~T6·T9·체이닝·prior·reason 매핑)은 변경 없음 — 회귀 유지.
 * upsertSlotCentering 단위(구 T12)는 sqliteStore.test.ts 로 이관(중복 제거).
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

/** plateRoiByPreset 1슬롯 fixture(globalIdx=7). */
function artifact(): SetupArtifact {
  return {
    createdAt: 'T', presets: [],
    globalIndex: [{ globalIdx: 7, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    slots: [{
      slotId: 'c1p1s1', zone: 'z',
      roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } },
      plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) },
    }],
  };
}

/** 신 소스(slot_setup) 센터라이징 대상의 LPD OBB 시드(quadBoundingRect → 0.62/0.62). */
const LPD_QUAD = rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 });

/**
 * 구현(PtzCalibrator.preAimPtz)과 동일한 선조준(pre-aim) 계산 미러 — 첫 캡처 명령 기대값 산출용.
 * 슬롯 LPD 박스 중심(LPD_QUAD)→화면중앙으로 base PTZ 를 결정형 1스텝 보정(zoom 불변). PREAIM_MAX_STEP=90.
 * 게인 상수(cfg.fallbackGain*)가 바뀌면 구현·기대값이 함께 움직여 회귀를 감지한다(01_architect_plan §A-1/§B-1).
 */
function preAimOf(base: Ptz): Ptz {
  const g = scaleGainForZoom({ gainPan: cfg.fallbackGainPanDeg, gainTilt: cfg.fallbackGainTiltDeg, zoomRef: 1 }, base.zoom);
  const c = center(quadBoundingRect(LPD_QUAD));
  const pt = panTiltCorrection({ errX: c.cx - 0.5, errY: c.cy - 0.5 }, g, base.pan, base.tilt, 90);
  return { pan: pt.pan, tilt: pt.tilt, zoom: base.zoom };
}

/** lpd 보유 slot_setup 뷰 1건(globalIdx=slotId). PtzCalibrator 센터라이징 소스. */
function viewRow(slotId: number, presetSlotIdx: number): SlotSetupView {
  return {
    slotId, camId: 1, presetId: 1, presetSlotIdx, presetKey: '1:1',
    roi: [], vpd: null, lpd: LPD_QUAD, occupyRange: null,
    pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
  };
}

/** getSlotSetup 만 주입하는 경량 store 시임(비-DB 물리 시나리오용). */
function storeWith(v: SlotSetupView[]): Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'> {
  return { getSlotSetup: () => v, upsertSlotCentering: () => {} } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
}

const roi = [{ x: 0.6, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.7, y: 0.65 }, { x: 0.6, y: 0.65 }];
/** 시드용 slot_setup 행(lpd_obb 포함 — 신 소스가 대상으로 펼치려면 lpd 필수). */
const slotRow = (slotId: number, presetSlotIdx: number, updatedAt = 'T-seed'): SlotSetupRow => ({
  slotId, camId: 1, presetId: 1, presetSlotIdx, slotRoi: JSON.stringify(roi),
  vpdBbox: null, lpdObb: JSON.stringify(LPD_QUAD), occupyRange: null, pan: null, tilt: null, zoom: null,
  centered: 0, img1: null, slot3dFrontCenter: null, updatedAt,
});

/** slot_setup(+FK 부모) 를 시드한 :memory: 스토어 — upsertSlotCentering 은 기존 행만 UPDATE 하므로 필수 선행. */
function seededStore(slots: SlotSetupRow[]): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.upsertPlaceInfo([{ placeId: 1, placeName: 'P' }]);
  s.upsertCameraInfo([{ camId: 1, camName: null, camUuid: null, url: null, userId: null, password: null, rtspUrl: null, camType: 'ptz', camCompany: null, placeId: 1, imgW: 1000, imgH: 1000, updatedAt: 'T' }]);
  s.upsertPresetPos([{ camId: 1, presetId: 1, sname: null, pan: 0, tilt: 0, zoom: 1, updatedAt: 'T' }]);
  s.replaceSlotSetup(slots);
  return s;
}

/** ptzCalibrator.test.ts 와 동일한 모킹 물리(명령 PTZ → 번호판 위치/폭). */
function makeMockModel() {
  const moves: Ptz[] = [];
  const camera = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: Partial<Ptz>) => {
      const pan = ptz?.pan ?? 0, tilt = ptz?.tilt ?? 0, zoom = ptz?.zoom ?? 1;
      moves.push({ pan, tilt, zoom });
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('img') };
    },
  } as unknown as CameraClient;
  const lpd = {
    detect: async (): Promise<PlateBox[]> => {
      const last = moves[moves.length - 1];
      const cx = 0.7 - last.pan * 0.02;
      const cy = 0.8 - last.tilt * 0.02;
      const w = Math.min(0.9, 0.05 * last.zoom);
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - 0.015, w, h: 0.03 }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;
  return { camera, lpd, moves };
}

function makeCalibrator(over: Partial<PtzCalibratorDeps> = {}) {
  const m = makeMockModel();
  let saved: SlotPtzArtifact | undefined;
  let nowCount = 0;
  const deps: PtzCalibratorDeps = {
    // 기본 소스 = lpd 보유 슬롯 1건(globalIdx=7). override 로 seededStore/시나리오 store 주입.
    camera: m.camera, lpd: m.lpd, store: storeWith([viewRow(7, 1)]), cfg,
    writer: (art) => { saved = art; },
    sleep: async () => {},
    now: () => `T${nowCount++}`,
    ...over,
  };
  return { cal: new PtzCalibrator(deps), getSaved: () => saved, moves: m.moves };
}

async function waitDone(cal: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 20000 && cal.getStatus().state === 'running'; i++) await Promise.resolve();
}

/** PlatePtz 팩토리 시임: 생성 opts 와 zoom 호출 인자를 캡처한다. */
function stubFactory(center: PlatePtzResult, zoom?: PlatePtzResult) {
  const opts: PlatePtzOpts[] = [];
  const zoomCalls: Array<{ camIdx: number; presetIdx: number; startPtz: Ptz }> = [];
  const make = (o: PlatePtzOpts) => {
    opts.push(o);
    return {
      centerOnPlate: async (): Promise<PlatePtzResult> => center,
      zoomToPlateWidth: async (c: number, p: number, s: Ptz): Promise<PlatePtzResult> => {
        zoomCalls.push({ camIdx: c, presetIdx: p, startPtz: s });
        return zoom ?? center;
      },
    };
  };
  return { make, opts, zoomCalls };
}

const GAIN = { gainPan: -37.7, gainTilt: -21.4, zoomRef: 1.69341 };
const CENTER_PTZ: Ptz = { pan: 20.5, tilt: 5.5, zoom: 1.69341 };
/** 센터링 後 관측 위치(≈0.47/0.48) — 센터링 前 prior 0.62/0.62 와 명확히 구분되는 값. */
const CENTERED_PLATE = { quad: rectToQuad({ x: 0.47, y: 0.48, w: 0.06, h: 0.03 }), confidence: 0.9, cls: 'plate' as const };

const okCenter: PlatePtzResult = {
  ok: true, ptz: CENTER_PTZ, plate: CENTERED_PLATE, err: { errX: 0.0, errY: 0.0 },
  plateWidth: 0.06, gain: GAIN, iterations: 3,
};
const okZoom: PlatePtzResult = {
  ok: true, ptz: { pan: 20.5, tilt: 5.5, zoom: 6.2 }, plate: CENTERED_PLATE, err: { errX: 0.01, errY: 0.01 },
  plateWidth: 0.2, gain: GAIN, iterations: 4,
};

// ── T1: gain 체이닝 + zoom prior 갱신 (이 작업의 핵심 계약) ──
describe('T1 gain 체이닝 · zoom 단계 prior 갱신', () => {
  it('zoom 인스턴스 opts.gain === center 결과 gain(동일 참조), startPtz === c.ptz, plateRoi = center 결과 boundingRect', async () => {
    const f = stubFactory(okCenter, okZoom);
    const { cal } = makeCalibrator({ makePlatePtz: f.make });
    cal.start();
    await waitDone(cal);

    expect(f.opts).toHaveLength(2);
    // ★ pre-aim 도입(01_architect_plan §A-1/§B-1.2): 센터링 단계는 plateRoi 미전달
    //   (= PlatePtz 기본 {0.5,0.5,0,0} 화면중앙 최근접). 슬롯별 선조준 startPtz 가 대상을 중앙 근처로
    //   끌어오므로 prior ROI(0.62)를 넘기지 않는다 — 이웃 판 latch 차단(anti-latch).
    expect(f.opts[0].plateRoi).toBeUndefined();
    expect(f.opts[0].gain).toBeUndefined();

    expect(f.opts[1].gain).toBe(okCenter.gain);
    expect(f.opts[1].plateRoi).toEqual(quadBoundingRect(CENTERED_PLATE.quad));
    expect(f.opts[1].plateRoi!.x).toBeCloseTo(0.47, 3);
    expect(f.opts[1].plateRoi!.y).toBeCloseTo(0.48, 3);
    // zoom 단계 plateRoi(센터링 후 관측 0.47) 는 센터링 단계 prior(0.62)와 별개 좌표.
    expect(f.opts[1].plateRoi!.x).not.toBeCloseTo(0.62, 3);

    expect(f.zoomCalls).toHaveLength(1);
    expect(f.zoomCalls[0].startPtz).toBe(okCenter.ptz);
    expect(f.zoomCalls[0].camIdx).toBe(1);
    expect(f.zoomCalls[0].presetIdx).toBe(1);
  });
});

// ── T2: 위임 후 수렴 회귀(실 PlatePtz) ──
describe('T2 위임 후 수렴 회귀', () => {
  it('기존 모킹 물리로 centered·converged true, plateWidth≈0.2, globalIdx=7', async () => {
    const { cal, getSaved } = makeCalibrator();
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    const it0 = getSaved()!.items[0];
    expect(it0.centered).toBe(true);
    expect(it0.converged).toBe(true);
    expect(it0.plateWidth).toBeCloseTo(0.2, 1);
    expect(it0.globalIdx).toBe(7);
    expect(it0.reason).toBeUndefined();
  });
});

// ── T3/T4: 시작 PTZ 정본(resolvePresetPtz) · 폴백 ──
describe('T3 시작 PTZ = 프리셋 정본(resolvePresetPtz)', () => {
  it('listCameras 보유 → 첫 캡처 명령이 프리셋 PTZ', async () => {
    const m = makeMockModel();
    const camera = {
      ...m.camera,
      clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
      listCameras: async () => ({ cameras: [{ camIdx: 1, presets: [{ presetIdx: 1, pan: 22, tilt: 6.8, zoom: 1.69341 }] }] }),
      requestImage: m.camera.requestImage.bind(m.camera),
    } as unknown as CameraClient;
    const { cal, moves } = makeCalibrator({ camera, lpd: m.lpd });
    cal.start();
    await waitDone(cal);
    // ★ pre-aim: 첫 캡처 명령의 pan/tilt = 프리셋 정본에서 슬롯 LPD 중심을 화면중앙으로 끄는 선조준 1스텝.
    //   프리셋 base 는 여전히 resolvePresetPtz 로 해석되며(정본), 그 위에 선조준 오프셋이 얹힌다.
    const pre = preAimOf({ pan: 22, tilt: 6.8, zoom: 1.69341 });
    expect(m.moves[0].pan).toBeCloseTo(pre.pan, 6);
    expect(m.moves[0].tilt).toBeCloseTo(pre.tilt, 6);
    // ★ 방안2(줌인 acquire): 첫 캡처 zoom 은 프리셋 base(1.69341)가 아니라 acquireZoom(=1.69341×0.12/0.05=4.064).
    expect(m.moves[0].zoom).toBeCloseTo(1.69341 * 0.12 / 0.05, 4);
    expect(m.moves[0].zoom).toBeGreaterThan(1.69341); // 줌인(acquire) 우선.
    expect(m.moves[0].pan).toBeGreaterThan(22); // 우하단 박스(cx>0.5) → pan↑(우향).
    void moves;
  });
});

describe('T4 시작 PTZ 폴백', () => {
  it('listCameras 부재 → 0/0/1 시작 + 잡 정상 완료', async () => {
    const { cal, moves } = makeCalibrator();
    cal.start();
    await waitDone(cal);
    // ★ pre-aim: 폴백 base(0/0/1)에서도 첫 캡처 pan/tilt 는 선조준된 시작점(박스중심 오프셋).
    const pre = preAimOf({ pan: 0, tilt: 0, zoom: 1 });
    expect(moves[0].pan).toBeCloseTo(pre.pan, 6);
    expect(moves[0].tilt).toBeCloseTo(pre.tilt, 6);
    // ★ 방안2(줌인 acquire): 첫 캡처 zoom 은 presetZoom(1)이 아니라 acquireZoom(=1×0.12/0.05=2.4).
    expect(moves[0].zoom).toBeCloseTo(2.4, 4);
    expect(cal.getStatus().state).toBe('done');
  });

  it('폴백은 warn 을 남긴다(조용한 강등 금지 — 설계서 §2)', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const { cal } = makeCalibrator();
      cal.start();
      await waitDone(cal);
      const warned = spy.mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('프리셋 PTZ 미해결'));
      expect(warned).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── T5: reason 매핑 4종(실 PlatePtz 시나리오 구동) ──
describe('T5 reason 매핑 4종', () => {
  it('no_plate — 시작부터 미검출', async () => {
    const lpd = { detect: async () => [] } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ lpd });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('no_plate');
    expect(it0.centered).toBe(false);
    expect(it0.converged).toBe(false);
  });

  it('plate_lost — 초기 검출 후 소실', async () => {
    const m = makeMockModel();
    let n = 0;
    const lpd = {
      detect: async (jpg: Buffer): Promise<PlateBox[]> => (n++ === 0 ? m.lpd.detect(jpg) : []),
    } as unknown as LpdClient;
    // ★ 방안3(줌아웃 사다리)는 실패 rung 마다 재검출하는데 이 모킹은 최초 1회만 검출(이후 전무) →
    //   사다리가 켜지면 하위 rung 은 no_plate 로 소진돼 plate_lost 가 no_plate 로 묻힌다.
    //   plate_lost 전파(단일 rung 에서 초기검출 후 소실) 자체를 검증하려면 사다리를 끈다(maxSteps=0).
    const { cal, getSaved } = makeCalibrator({ camera: m.camera, lpd, cfg: { ...cfg, acquireLadderMaxSteps: 0 } });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('plate_lost');
    expect(it0.centered).toBe(false);
    expect(it0.converged).toBe(false);
  });

  it('zoom_saturated — 중심은 맞았으나 zoom 상한에서 폭 미달', async () => {
    const camera = {
      clampZoom: () => 1,
      requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') }),
    } as unknown as CameraClient;
    const lpd = {
      detect: async (): Promise<PlateBox[]> => [{ quad: rectToQuad({ x: 0.498, y: 0.4985, w: 0.004, h: 0.003 }), confidence: 0.9, cls: 'plate' }],
    } as unknown as LpdClient;
    const { cal, getSaved } = makeCalibrator({ camera, lpd });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('zoom_saturated');
    expect(it0.centered).toBe(true);
    expect(it0.converged).toBe(false);
  });

  it('max_iterations — center 가 상한 소진(보정 무반응)', async () => {
    const tightCfg = { ...cfg, maxIterations: 1 };
    const { cal, getSaved } = makeCalibrator({ cfg: tightCfg });
    cal.start();
    await waitDone(cal);
    const it0 = getSaved()!.items[0];
    expect(it0.reason).toBe('max_iterations');
    expect(it0.centered).toBe(false);
    expect(it0.converged).toBe(false);
  });
});

// ── T6: center 실패 시 zoom 미시도 ──
describe('T6 center 실패 → zoom 미시도', () => {
  it('centerOnPlate ok:false 면 zoomToPlateWidth 호출 0회', async () => {
    const failCenter: PlatePtzResult = {
      ok: false, ptz: { pan: 1, tilt: 2, zoom: 3 }, plate: CENTERED_PLATE, err: { errX: 0.2, errY: 0.2 },
      plateWidth: null, gain: GAIN, iterations: 15, reason: 'max_iterations',
    };
    const f = stubFactory(failCenter, okZoom);
    // ★ 사다리(방안3) 끄고(maxSteps=0) center→zoom 게이트만 격리 검증 — center 실패면 width(zoom) 미시도.
    //   사다리 ON 이면 실패 rung 마다 centerOnPlate 재호출(makePlatePtz 다회)이라 opts 길이가 rung 수가 된다.
    const { cal, getSaved } = makeCalibrator({ makePlatePtz: f.make, cfg: { ...cfg, acquireLadderMaxSteps: 0 } });
    cal.start();
    await waitDone(cal);
    expect(f.zoomCalls).toHaveLength(0);
    expect(f.opts).toHaveLength(1);
    const it0 = getSaved()!.items[0];
    expect(it0.converged).toBe(false);
    expect(it0.centered).toBe(false);
    expect(it0.reason).toBe('max_iterations');
    expect(it0.ptz).toEqual({ pan: 1, tilt: 2, zoom: 3 });
    expect(it0.plateWidth).toBe(0);
  });

  it('no_plate(plate:null) 도 zoom 미시도', async () => {
    const noPlate: PlatePtzResult = {
      ok: false, ptz: { pan: 0, tilt: 0, zoom: 1 }, plate: null, err: null,
      plateWidth: null, gain: GAIN, iterations: 0, reason: 'no_plate',
    };
    const f = stubFactory(noPlate, okZoom);
    const { cal, getSaved } = makeCalibrator({ makePlatePtz: f.make });
    cal.start();
    await waitDone(cal);
    expect(f.zoomCalls).toHaveLength(0);
    expect(getSaved()!.items[0].reason).toBe('no_plate');
  });
});

// ── T7: slot_setup 센터라이징 미러 멱등(2회 실행) ──
describe('T7 slot_setup 센터라이징 미러 멱등 + 경계면 교차', () => {
  it('동일 잡 2회 → 행수 불변, slot_setup pan/tilt/zoom == item.ptz(정수 slot_id 매핑)', async () => {
    const store = seededStore([slotRow(1, 1), slotRow(2, 2)]);
    const { cal, getSaved } = makeCalibrator({ store });
    cal.start();
    await waitDone(cal);
    const first = store.getSlotSetup();
    expect(first).toHaveLength(2);
    expect(first.filter((r) => r.centered)).toHaveLength(2); // 두 슬롯 모두 센터라이징 반영

    const { cal: cal2 } = makeCalibrator({ store });
    cal2.start();
    await waitDone(cal2);
    const second = store.getSlotSetup();
    expect(second).toHaveLength(2); // 중복 0(replaceSlotSetup 아닌 UPDATE — 행수 불변)

    // 경계면: slot_setup 분해 PTZ ↔ JSON item.ptz shape 교차 비교(정수 slot_id=globalIdx 매핑).
    const item = getSaved()!.items.find((i) => i.globalIdx === 1)!;
    const row = second.find((r) => r.slotId === 1)!;
    // ★ 영속화 5자리: DB REAL pan/tilt/zoom 은 upsertSlotCentering 이 round5 로 저장(예: 9.999999999999995→10,
    //   3.722419436408399→3.72242). in-memory item.ptz 는 롱플로트 → 저장 정밀도(round5)로 맞춰 교차 비교(검증 의도 유지).
    expect({ pan: row.pan, tilt: row.tilt, zoom: row.zoom })
      .toEqual({ pan: round5(item.ptz.pan), tilt: round5(item.ptz.tilt), zoom: round5(item.ptz.zoom) });
    // 1-based 규약 유지.
    expect(row.camId).toBe(1);
    expect(row.presetId).toBe(1);
    expect(row.presetSlotIdx).toBe(1);
  });
});

// ── T8: 기본 소스(단일 lpd 뷰) 잡 완료 + JSON 저장 ──
describe('T8 기본 store 소스 잡 완료', () => {
  it('lpd 1슬롯 소스 → 잡 done + JSON 저장(1건), 예외 없음', async () => {
    const { cal, getSaved } = makeCalibrator(); // 기본 store = viewRow(7,1)
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');
    expect(getSaved()!.items).toHaveLength(1);
  });
});

// ── T9: preset_slotidx 도출(1-based) ──
describe('T9 presetSlotIdx 도출', () => {
  it('coveredSlotIds 순서 1-based, 미포함 시 null', () => {
    const a: SetupArtifact = {
      createdAt: 'T',
      presets: [{ camIdx: 1, presetIdx: 1, label: 'p', coveredSlotIds: ['a', 'b', 'c'] }],
      globalIndex: [],
      slots: [
        { slotId: 'b', zone: 'z', roiByPreset: {}, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.1, y: 0.1, w: 0.05, h: 0.03 }) } },
        { slotId: 'zz', zone: 'z', roiByPreset: {}, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.2, y: 0.2, w: 0.05, h: 0.03 }) } },
      ],
    };
    const targets = expandPlateTargets(a);
    expect(targets.find((t) => t.slotId === 'b')!.presetSlotIdx).toBe(2);
    expect(targets.find((t) => t.slotId === 'zz')!.presetSlotIdx).toBeNull();
  });

  it('프리셋 자체가 없으면 null(0/−1 발명 금지)', () => {
    const targets = expandPlateTargets(artifact());
    expect(targets[0].presetSlotIdx).toBeNull();
  });
});

// ── T10: 부분 캘리브레이션 — 타깃 외 슬롯 불변 ──
describe('T10 부분 캘리브레이션 UPDATE 범위', () => {
  it('2슬롯 전량 → 2행 갱신. 슬롯1만 재실행 → 여전히 2행, 타 슬롯 updated_at·centered 불변', async () => {
    const store = seededStore([slotRow(1, 1), slotRow(2, 2)]);
    const { cal } = makeCalibrator({ store, now: () => 'T-first' });
    cal.start();
    await waitDone(cal);
    const before = store.getSlotSetup();
    expect(before.every((r) => r.centered && r.updatedAt === 'T-first')).toBe(true);

    // 슬롯1(globalIdx=1)만 부분 재실행. ★ 신 소스 slotId=String(정수)='1'(구 'c1p1s1' 아님).
    const { cal: cal2 } = makeCalibrator({ store, now: () => 'T-second' });
    cal2.start(['1']);
    await waitDone(cal2);

    const after = store.getSlotSetup();
    expect(after).toHaveLength(2); // ★ 타 슬롯 전멸 금지
    expect(after.find((r) => r.slotId === 1)!.updatedAt).toBe('T-second'); // 대상만 갱신
    expect(after.find((r) => r.slotId === 2)!.updatedAt).toBe('T-first');  // ★ 타 슬롯 불변
    expect(after.find((r) => r.slotId === 2)!.centered).toBe(true);        // 1회차 값 유지
  });
});

// ── T11: 실패 슬롯 DB 미저장 + last-known-good 보존 ──
describe('T11 실패 슬롯 slot_setup 미갱신', () => {
  it('1회차 성공 → 2회차 no_plate: JSON 엔 reason, slot_setup 은 1회차 PTZ 유지', async () => {
    const store = seededStore([slotRow(7, 1)]); // artifact() globalIdx=7
    const { cal } = makeCalibrator({ store, now: () => 'T-ok' });
    cal.start();
    await waitDone(cal);
    const good = store.getSlotSetup();
    expect(good).toHaveLength(1);
    expect(good[0].centered).toBe(true);
    const goodPtz = { pan: good[0].pan, tilt: good[0].tilt, zoom: good[0].zoom };
    expect(goodPtz.pan).not.toBeNull();

    // 2회차: 같은 슬롯이 no_plate → converged=false → 미갱신(빈 rows → upsert 미호출).
    const lpd = { detect: async () => [] } as unknown as LpdClient;
    const { cal: cal2, getSaved } = makeCalibrator({ store, lpd, now: () => 'T-fail' });
    cal2.start();
    await waitDone(cal2);

    expect(getSaved()!.items[0].reason).toBe('no_plate'); // JSON 은 실패 정직 기록
    const after = store.getSlotSetup();
    expect(after).toHaveLength(1);
    expect({ pan: after[0].pan, tilt: after[0].tilt, zoom: after[0].zoom }).toEqual(goodPtz); // ★ 덮어쓰기 없음
    expect(after[0].updatedAt).toBe('T-ok'); // ★ 실패가 updated_at 도 건드리지 않음
    expect(after[0].centered).toBe(true);
  });
});

// ── T14(가산): items↔globalIdx 매핑 — 슬롯 예외로 어긋나지 않는가 ──
describe('T14 items↔slot_id 매핑(슬롯 예외 혼재)', () => {
  it('앞 슬롯이 예외로 실패해도 뒤 슬롯 PTZ 가 자기 slot_id 에 매핑된다(밀림 없음)', async () => {
    const store = seededStore([slotRow(1, 1), slotRow(2, 2)]);
    const m = makeMockModel();
    let calls = 0;
    const camera = {
      clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
      requestImage: async (c: number, p: number, ptz?: Partial<Ptz>) => {
        if (calls++ === 0) throw new Error('transport boom'); // 첫 슬롯 첫 캡처 폭발
        return m.camera.requestImage(c, p, ptz);
      },
    } as unknown as CameraClient;

    const { cal, getSaved } = makeCalibrator({ store, camera, lpd: m.lpd });
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done');

    const items = getSaved()!.items;
    expect(items).toHaveLength(2);
    expect(items[0].reason).toBe('error'); // 예외 흡수(globalIdx=1)
    expect(items[1].converged).toBe(true); // 성공(globalIdx=2)

    // slot_setup: 성공한 슬롯2(slot_id=2)만 센터라이징, 슬롯1(slot_id=1)은 미갱신.
    const rows = store.getSlotSetup();
    expect(rows.find((r) => r.slotId === 2)!.centered).toBe(true);
    expect(rows.find((r) => r.slotId === 1)!.centered).toBe(false); // ★ 밀림 없음(item.globalIdx 매핑)
  });
});

// ── T13: DB 예외 격리(best-effort) ──
describe('T13 DB 예외 격리', () => {
  it('upsertSlotCentering throw → 잡 done 유지 + JSON 정상', async () => {
    const store = {
      getSlotSetup: () => [viewRow(7, 1)], // 대상 1건 소싱(converged=true 재현) — upsert 는 throw.
      upsertSlotCentering: () => { throw new Error('db down'); },
    } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
    const { cal, getSaved } = makeCalibrator({ store });
    cal.start();
    await waitDone(cal);
    expect(cal.getStatus().state).toBe('done'); // ★ DB 실패가 잡을 죽이지 않는다
    expect(getSaved()!.items[0].converged).toBe(true);
  });
});
