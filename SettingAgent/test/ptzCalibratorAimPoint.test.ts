import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import { aimPtzForPoint } from '../src/calibrate/controlMath.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SaveStore } from '../src/store/SaveStore.js';
import type { PlatePtzOpts } from '../src/calibrate/platePtz.js';
import type { Ptz } from '../src/calibrate/types.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): PtzCalibrator.aimPointToCenter — 설계서 §1(b)·§2 테스트 계획 2번.
 *
 * 신규 시맨틱: "클릭 지점 자체를 화면 중앙으로"(개방루프 1샷). 번호판 기준 centerOnPoint 와 목적이 다르다.
 * 불변(Goal/Requirements):
 *   - 저장 0회(writer · store.upsertSlotCentering · saveStore.saveSnapshot)
 *   - 검출 0회(lpd.detect · makePlatePtz 팩토리 미진입)
 *   - camera.move 정확히 1회, zoom = 조회한 현재 zoom 그대로(불변)
 *   - 네이티브(camera.centerOnPoint) 지원 시 그것을 우선, move 미호출
 * 경계면 교차: 이 메서드의 반환 {ok,ptz,plateWidth,mode,reason?} ↔ POST /calibrate/point 200 응답 shape
 *   은 calibrateRoutes.point.test.ts 에서 대조한다.
 *
 * ★ 라이브 한계(은닉 금지): 실카메라(휴컴스) 네이티브 setcenter 의 물리 정확도는 장비 미선택으로 미검증.
 */

const cfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'data/slot_ptz.json',
};

/** 구현이 쓰는 폴백 게인(zoomRef=1)·PREAIM_MAX_STEP(=90) 미러 — 기대값을 독립 계산한다. */
const GAIN_REF = { gainPan: cfg.fallbackGainPanDeg, gainTilt: cfg.fallbackGainTiltDeg, zoomRef: 1 };
const MAX_STEP = 90;

/** 프리셋 PTZ(listCameras 정본) — getPtz 실패 폴백 경로의 기대값. */
const PRESET_PTZ: Ptz = { pan: 10, tilt: 20, zoom: 2 };
/** 장비 현재 PTZ(getPtz 정본) — 정상 경로의 기준. 프리셋과 일부러 다르게 둔다. */
const CURRENT_PTZ: Ptz = { pan: 33, tilt: -4, zoom: 1.6934098 };
const NATIVE_PTZ: Ptz = { pan: 40, tilt: 1, zoom: 1.6934098 };

const PT = { x: 0.117, y: 0.690 }; // 리더 라이브 검증에 쓰인 클릭 좌표 중 하나.

interface CamSpy {
  camera: CameraClient;
  moves: Array<{ cam: number; pan: number; tilt: number; zoom: number }>;
  getPtzCalls: number;
  nativeCalls: Array<{ cam: number; point: { x: number; y: number } }>;
}

/**
 * 카메라 시임. getPtz(현재 PTZ) / move(스파이) / listCameras(프리셋 폴백 소스).
 * native 옵션을 주면 centerOnPoint 프로퍼티를 정의해 "능력 있음" 소스를 모사한다(CameraSourceClient 조건부 할당 대응).
 */
function makeCamera(opts: { getPtzFails?: boolean; native?: boolean; moveOk?: boolean } = {}): CamSpy {
  const moves: CamSpy['moves'] = [];
  const nativeCalls: CamSpy['nativeCalls'] = [];
  const spy = { moves, getPtzCalls: 0, nativeCalls } as unknown as CamSpy;
  const camera = {
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    listCameras: async () => ({
      cameras: [{ camIdx: 1, label: 'C1', presets: [{ presetIdx: 1, label: 'C1-P1', pan: PRESET_PTZ.pan, tilt: PRESET_PTZ.tilt, zoom: PRESET_PTZ.zoom }] }],
    }),
    getPtz: async () => {
      spy.getPtzCalls += 1;
      if (opts.getPtzFails) throw new Error('device offline');
      return CURRENT_PTZ;
    },
    move: async (cam: number, pan: number, tilt: number, zoom: number) => {
      moves.push({ cam, pan, tilt, zoom });
      return opts.moveOk ?? true;
    },
    ...(opts.native
      ? {
          centerOnPoint: async (cam: number, point: { x: number; y: number }) => {
            nativeCalls.push({ cam, point });
            return NATIVE_PTZ;
          },
        }
      : {}),
  } as unknown as CameraClient;
  spy.camera = camera;
  return spy;
}

/** 저장 3종 + LPD + PlatePtz 팩토리 전부 스파이. 클릭 조준은 이 중 무엇도 건드리면 안 된다. */
function build(camSpy: CamSpy, views: SlotSetupView[] = []) {
  const upserts: unknown[][] = [];
  const writes: unknown[] = [];
  const snaps: unknown[] = [];
  const detects: unknown[] = [];
  const factoryCalls: PlatePtzOpts[] = [];

  const store = {
    getSlotSetup: () => views,
    upsertSlotCentering: (rows: unknown[]) => { upserts.push(rows); },
  } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  const saveStore = { saveSnapshot: (name: string, payload: unknown) => { snaps.push({ name, payload }); } } as unknown as Pick<SaveStore, 'saveSnapshot'>;
  const lpd = { detect: async (): Promise<PlateBox[]> => { detects.push(1); return []; } } as unknown as LpdClient;

  // 팩토리에 들어오기만 해도 실패로 보이도록 영구 pending 반환(클릭 조준은 진입 자체가 없어야 한다).
  const makePlatePtz = ((o: PlatePtzOpts) => {
    factoryCalls.push(o);
    return { centerOnPlate: () => new Promise(() => {}), zoomToPlateWidth: () => new Promise(() => {}) };
  }) as unknown as PtzCalibratorDeps['makePlatePtz'];

  const deps: PtzCalibratorDeps = {
    camera: camSpy.camera, lpd, cfg, store, makePlatePtz,
    writer: (art, out) => { writes.push({ art, out }); },
    saveStore, sleep: async () => {}, now: () => 'T',
  };
  return { cal: new PtzCalibrator(deps), upserts, writes, snaps, detects, factoryCalls };
}

/** slot_setup fixture(배치 running 가드용). */
function views(): SlotSetupView[] {
  return [{
    slotId: 7, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
  }];
}

describe('aimPointToCenter — 기하 폴백 경로(시뮬, §1-b-4)', () => {
  it('현재 PTZ 기준 aimPtzForPoint 결과로 move 1회, 반환 {ok,ptz,plateWidth:null,mode:"geometric"}', async () => {
    const cam = makeCamera();
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);

    const expected = aimPtzForPoint(PT, CURRENT_PTZ, GAIN_REF, MAX_STEP);
    expect(cam.moves).toHaveLength(1); // ★ 개방루프 1샷
    expect(cam.moves[0].cam).toBe(1);
    expect(cam.moves[0].pan).toBeCloseTo(expected.pan, 9);
    expect(cam.moves[0].tilt).toBeCloseTo(expected.tilt, 9);
    expect(cam.moves[0].zoom).toBe(CURRENT_PTZ.zoom);
    expect(r).toEqual({ ok: true, ptz: expected, plateWidth: null, mode: 'geometric' });
    expect(r.reason).toBeUndefined();
  });

  it('zoom 불변: move 인자 zoom·반환 ptz.zoom == 조회 시점 zoom (Goal 핵심)', async () => {
    const cam = makeCamera();
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, { x: 0.943, y: 0.479 });
    expect(r.ptz.zoom).toBe(CURRENT_PTZ.zoom);
    expect(cam.moves[0].zoom).toBe(CURRENT_PTZ.zoom);
  });

  it('기준은 프리셋이 아니라 현재 PTZ — getPtz 1회 호출, 반환 pan/tilt 가 현재 PTZ 기반', async () => {
    const cam = makeCamera();
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);
    expect(cam.getPtzCalls).toBe(1);
    // 프리셋(pan10/tilt20/zoom2) 기준으로 계산했다면 나올 값과 달라야 한다.
    const presetBased = aimPtzForPoint(PT, PRESET_PTZ, GAIN_REF, MAX_STEP);
    expect(r.ptz.pan).not.toBeCloseTo(presetBased.pan, 3);
    expect(r.ptz.zoom).not.toBe(PRESET_PTZ.zoom);
  });

  it('중앙 클릭(0.5,0.5) → 현재 PTZ 그대로 move(델타 0)', async () => {
    const cam = makeCamera();
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, { x: 0.5, y: 0.5 });
    expect(r.ptz.pan).toBeCloseTo(CURRENT_PTZ.pan, 9);
    expect(r.ptz.tilt).toBeCloseTo(CURRENT_PTZ.tilt, 9);
    expect(r.ptz.zoom).toBe(CURRENT_PTZ.zoom);
  });

  it('move 실패(false) → ok:false 정직 전파(위장 금지), ptz 는 계산값 그대로', async () => {
    const cam = makeCamera({ moveOk: false });
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);
    expect(r.ok).toBe(false);
    expect(r.mode).toBe('geometric');
  });
});

describe('aimPointToCenter — 저장·검출 0회 (Goal 불변)', () => {
  it('기하 경로: writer·upsertSlotCentering·saveSnapshot·lpd.detect·makePlatePtz 전부 0회', async () => {
    const cam = makeCamera();
    const { cal, upserts, writes, snaps, detects, factoryCalls } = build(cam);
    await cal.aimPointToCenter(1, 1, PT);
    expect(writes).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(snaps).toHaveLength(0);
    expect(detects).toHaveLength(0);   // ★ 검출 의존 없음
    expect(factoryCalls).toHaveLength(0); // ★ 폐루프(PlatePtz) 미진입
  });

  it('네이티브 경로: 저장·검출 0회 유지', async () => {
    const cam = makeCamera({ native: true });
    const { cal, upserts, writes, snaps, detects, factoryCalls } = build(cam);
    await cal.aimPointToCenter(1, 1, PT);
    expect([writes.length, upserts.length, snaps.length, detects.length, factoryCalls.length]).toEqual([0, 0, 0, 0, 0]);
  });

  it('move 실패 경로에서도 저장 0회', async () => {
    const cam = makeCamera({ moveOk: false });
    const { cal, upserts, writes, snaps } = build(cam);
    await cal.aimPointToCenter(1, 1, PT);
    expect([writes.length, upserts.length, snaps.length]).toEqual([0, 0, 0]);
  });
});

describe('aimPointToCenter — 네이티브 우선(능력 협상, §1-c)', () => {
  it('camera.centerOnPoint 존재 → 네이티브 1회 위임, move 미호출, mode:"native", ptz=네이티브 반환', async () => {
    const cam = makeCamera({ native: true });
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);
    expect(cam.nativeCalls).toEqual([{ cam: 1, point: PT }]); // 정규화 좌표 그대로 전달(변환은 소스 책임).
    expect(cam.moves).toHaveLength(0);  // ★ 기하 move 미발화
    expect(r).toEqual({ ok: true, ptz: NATIVE_PTZ, plateWidth: null, mode: 'native' });
  });

  it('centerOnPoint 미정의(시뮬) → mode:"geometric" 로 폴백(무조건 native 로 오판하지 않음)', async () => {
    const cam = makeCamera(); // centerOnPoint 프로퍼티 자체가 없음.
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);
    expect(r.mode).toBe('geometric');
    expect(cam.nativeCalls).toHaveLength(0);
    expect(cam.moves).toHaveLength(1);
  });
});

describe('aimPointToCenter — 현재 PTZ 조회 실패 폴백 (§1-b-2)', () => {
  it('getPtz throw → 프리셋 PTZ 기준으로 조준(강등하되 진행), move 1회', async () => {
    const cam = makeCamera({ getPtzFails: true });
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);
    const expected = aimPtzForPoint(PT, PRESET_PTZ, GAIN_REF, MAX_STEP);
    expect(cam.moves).toHaveLength(1);
    expect(r.ptz.pan).toBeCloseTo(expected.pan, 9);
    expect(r.ptz.tilt).toBeCloseTo(expected.tilt, 9);
    expect(r.ptz.zoom).toBe(PRESET_PTZ.zoom); // 폴백 base 의 zoom 도 불변 유지.
  });

  it('getPtz throw + 네이티브 지원 → 여전히 네이티브 위임(기준 PTZ 는 네이티브가 자체 처리)', async () => {
    const cam = makeCamera({ getPtzFails: true, native: true });
    const { cal } = build(cam);
    const r = await cal.aimPointToCenter(1, 1, PT);
    expect(r.mode).toBe('native');
    expect(cam.moves).toHaveLength(0);
  });
});

describe('aimPointToCenter — 상호배타 가드 (Requirements 5)', () => {
  it('배치 state==="running" 중 호출 → throw(/running/), move 미발화', async () => {
    const cam = makeCamera();
    const { cal } = build(cam, views());
    cal.start(); // makePlatePtz 스텁이 영구 pending → state 는 running 유지.
    expect(cal.getStatus().state).toBe('running');
    await expect(cal.aimPointToCenter(1, 1, PT)).rejects.toThrow(/running/);
    expect(cam.moves).toHaveLength(0);
  });

  it('중복 진입(await 없이 2회) → 2번째 throw(/busy/), 첫 호출은 정상 완료', async () => {
    const cam = makeCamera();
    const { cal } = build(cam);
    const p1 = cal.aimPointToCenter(1, 1, PT); // pointBusy=true 후 getPtz await 로 보류.
    const p2 = cal.aimPointToCenter(1, 1, PT);
    await expect(p2).rejects.toThrow(/busy/);
    await expect(p1).resolves.toMatchObject({ ok: true, mode: 'geometric' });
    expect(cam.moves).toHaveLength(1); // 2번째는 진입조차 못 함.
  });

  it('busy 락은 finally 해제 — 순차 2회 호출 모두 성공(락 누수 없음)', async () => {
    const cam = makeCamera();
    const { cal } = build(cam);
    await cal.aimPointToCenter(1, 1, PT);
    await expect(cal.aimPointToCenter(1, 1, PT)).resolves.toMatchObject({ ok: true });
    expect(cam.moves).toHaveLength(2);
  });

  it('getPtz·move 예외로 throw 해도 락 해제(다음 호출 busy 아님)', async () => {
    const cam = makeCamera({ native: true });
    // 네이티브가 throw 하는 소스로 교체해 예외 경로의 finally 해제를 확인.
    (cam.camera as unknown as { centerOnPoint: () => Promise<Ptz> }).centerOnPoint = async () => { throw new Error('setcenter failed'); };
    const { cal } = build(cam);
    await expect(cal.aimPointToCenter(1, 1, PT)).rejects.toThrow(/setcenter failed/);
    await expect(cal.aimPointToCenter(1, 1, PT)).rejects.toThrow(/setcenter failed/); // busy 가 아니라 동일 원인.
  });
});

describe('aimPointToCenter — 번호판 경로 회귀 0 (Requirements 1)', () => {
  it('클릭 조준 호출 후에도 centerOnPoint(번호판) 경로는 정상 진입 가능(락 공유·상태 오염 없음)', async () => {
    const cam = makeCamera();
    const { cal, factoryCalls } = build(cam);
    await cal.aimPointToCenter(1, 1, PT);
    expect(factoryCalls).toHaveLength(0);
    // 번호판 경로는 makePlatePtz(영구 pending 스텁) 로 진입한다 = 락이 풀려 있다는 증거.
    void cal.centerOnPoint(1, 1, PT, { zoom: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(factoryCalls.length).toBeGreaterThanOrEqual(1);
    expect(factoryCalls[0].plateRoi).toEqual({ x: PT.x, y: PT.y, w: 0, h: 0 }); // 번호판 prior 시맨틱 불변.
  });
});
