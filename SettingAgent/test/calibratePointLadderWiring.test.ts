import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCalibrateRoutes } from '../src/api/calibrateRoutes.js';
import { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { CameraSource, Ptz } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import { rectToQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): **배선 무결성(end-to-end)** — 리더 지시 5·6.
 *
 * 설계·구현이 옳아도 라우트에서 사다리로 가는 길이 끊겨 있으면 마스터 클릭에서 아무 일도 일어나지 않는다.
 * 이 파일만 스텁을 쓰지 않고 **실물 체인**을 조립한다:
 *   POST /calibrate/point {mode:'plate-zoom', source} → CameraSourceClient(라우트 조립)
 *   → PtzCalibrator.centerOnPoint → ladderEnabled(주입 카메라) → PlatePtz.centerAndZoomByLadder
 *   → source.centerOnPoint(setcenter) / source.snapshot(이동+캡처)
 * 동시에 **파이프라인 카메라 접촉 0**(Requirement 5)을 카운터로 증명한다.
 *
 * (뷰어 web/app.js:3413 이 mode='plate-zoom' + source 를 보낸다는 것은 소스 추적으로 확인 — 그 구간은 유닛 밖.)
 */

const GAIN_PAN_REF1 = -62;
const GAIN_TILT_REF1 = -35.5;
const kx = (z: number): number => z / GAIN_PAN_REF1;
const ky = (z: number): number => z / GAIN_TILT_REF1;

const cameraCfg = { zoomMin: 1, zoomMax: 36 } as unknown as ToolsConfig['camera'];
const calCfg: ToolsConfig['calibrate'] = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
  probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, nativeAimSettleMs: 0, outFile: 'data/slot_ptz.json',
};

/** 실카(휴컴스) 상당 소스: 네이티브 setcenter 지원 + 상태 보유. 접촉을 전부 기록한다. */
function makeRealSource(plate: { ax: number; ay: number; w1: number }) {
  let state: Ptz = { pan: 0, tilt: 0, zoom: 1 };
  const log: string[] = [];
  const snapshots: Ptz[] = [];
  const source = {
    kind: 'hucoms',
    listCameras: async () => ({ cameras: [] }),
    snapshot: async (_cam: number, opt: { mode: string; ptz?: Ptz }) => {
      log.push('snapshot');
      if (opt.ptz) state = { ...opt.ptz };
      snapshots.push({ ...state });
      return { jpeg: Buffer.from('img'), ptz: { ...state } };
    },
    move: async (_cam: number, ptz: Ptz) => { log.push('move'); state = { ...ptz }; return true; },
    getPtz: async () => { log.push('getPtz'); return { ...state }; },
    centerOnPoint: async (_cam: number, p: { x: number; y: number }) => {
      log.push('centerOnPoint');
      state = {
        ...state,
        pan: state.pan - (p.x - 0.5) / kx(state.zoom),
        tilt: state.tilt - (p.y - 0.5) / ky(state.zoom),
      };
      return { ...state };
    },
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (p: unknown) => p as Ptz,
  } as unknown as CameraSource;

  /** 소스 상태에서 판이 어디에 보이는지 계산하는 LPD(카메라와 물리적으로 일관). */
  const lpd = {
    detect: async (): Promise<PlateBox[]> => {
      const cx = 0.5 + (plate.ax + state.pan) * kx(state.zoom);
      const cy = 0.5 + (plate.ay + state.tilt) * ky(state.zoom);
      const w = Math.min(0.9, plate.w1 * state.zoom);
      if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return [];
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - w / 6, w, h: w / 3 }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;

  return { source, lpd, log, snapshots, state: () => ({ ...state }) };
}

/** 파이프라인 카메라: 어떤 접촉이든 기록한다(Requirement 5 — 여기로 새면 실패). */
function makePipelineCamera() {
  const touches: string[] = [];
  const rec = <T>(name: string, v: T) => { touches.push(name); return v; };
  const camera = {
    clampZoom: (z: number) => rec('clampZoom', Math.min(36, Math.max(1, z))),
    health: async () => rec('health', true),
    requestImage: async () => rec('requestImage', { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.alloc(0) }),
    getPtz: async () => rec('getPtz', { pan: 0, tilt: 0, zoom: 1 }),
    listCameras: async () => rec('listCameras', { cameras: [] }),
    move: async () => rec('move', true),
    centerOnPoint: async () => rec('centerOnPoint', { pan: 0, tilt: 0, zoom: 1 }),
  } as unknown as ICameraClient;
  return { camera, touches };
}

function buildApp(opts: { plate: { ax: number; ay: number; w1: number }; cfg?: Partial<ToolsConfig['calibrate']> }) {
  const real = makeRealSource(opts.plate);
  const pipe = makePipelineCamera();
  const store = { getSlotSetup: () => [], upsertSlotCentering: () => {} } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  const calibrator = new PtzCalibrator({
    camera: pipe.camera, lpd: real.lpd, cfg: { ...calCfg, ...opts.cfg }, store,
    writer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const app = Fastify({ logger: false });
  registerCalibrateRoutes(app, {
    calibrator, outFile: 'data/slot_ptz.json',
    sources: new Map([['real-camera-1', real.source]]), cameraCfg,
  });
  return { app, real, pipe, calibrator };
}

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });

/** 광각 좌측(0.15,0.45)의 먼 차량 — zoom1 폭 0.01. */
const FAR = { ax: (0.15 - 0.5) / kx(1), ay: (0.45 - 0.5) / ky(1), w1: 0.01 };

describe('배선 무결성 — POST /calibrate/point{mode:plate-zoom} → 사다리', () => {
  it('★라우트에서 사다리까지 실제로 연결된다(setcenter 발화 + 줌 사다리 + 폭 수렴)', async () => {
    const built = buildApp({ plate: FAR });
    app = built.app;

    const r = await app.inject({
      method: 'POST', url: '/calibrate/point',
      payload: { cam: 1, preset: 1, point: { x: 0.15, y: 0.45 }, mode: 'plate-zoom', source: 'real-camera-1' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.plateWidth).toBeGreaterThanOrEqual(0.18);
    expect(body.plateWidth).toBeLessThanOrEqual(0.22);

    // ① 사다리가 실제로 실행됐다: 네이티브 setcenter 가 클릭 지점으로 발화.
    expect(built.real.log.filter((l) => l === 'centerOnPoint').length).toBeGreaterThanOrEqual(1);
    // ② rung 마다 캡처(이동+캡처 원자)가 나갔고 zoom 이 단조 증가했다.
    expect(built.real.snapshots.length).toBeGreaterThan(1);
    for (let i = 1; i < built.real.snapshots.length; i++) {
      expect(built.real.snapshots[i]!.zoom).toBeGreaterThanOrEqual(built.real.snapshots[i - 1]!.zoom);
    }
    expect(built.real.snapshots[built.real.snapshots.length - 1]!.zoom).toBeGreaterThan(1);
  });

  it('★Requirement 5 — 사다리 전 구간이 주입 소스로 간다(파이프라인 카메라 접촉 0)', async () => {
    const built = buildApp({ plate: FAR });
    app = built.app;
    await app.inject({
      method: 'POST', url: '/calibrate/point',
      payload: { cam: 1, preset: 1, point: { x: 0.15, y: 0.45 }, mode: 'plate-zoom', source: 'real-camera-1' },
    });
    expect(built.pipe.touches).toEqual([]); // clampZoom 조차 새지 않는다
    expect(built.real.log.length).toBeGreaterThan(3);
  });

  it("'off' 스위치는 라우트 재배포 없이 사다리를 끈다(기존 경로로 복귀)", async () => {
    const built = buildApp({ plate: FAR, cfg: { pointZoomLadder: 'off' } });
    app = built.app;
    await app.inject({
      method: 'POST', url: '/calibrate/point',
      payload: { cam: 1, preset: 1, point: { x: 0.15, y: 0.45 }, mode: 'plate-zoom', source: 'real-camera-1' },
    });
    expect(built.real.log).not.toContain('centerOnPoint'); // 기존 경로는 setcenter 를 쓰지 않는다
    expect(built.pipe.touches).toEqual([]);
  });

  it("★거짓 성공 제거가 라우트 응답까지 전달된다 — 클릭 좌측 끝·판은 중앙(mode:'plate')", async () => {
    // 클릭점(0.03,0.5)에서 멀리 떨어진 중앙 판만 존재 → no_plate_near_click 으로 실패해야 한다.
    const CENTER = { ax: 0, ay: 0, w1: 0.05 };
    const built = buildApp({ plate: CENTER });
    app = built.app;
    const r = await app.inject({
      method: 'POST', url: '/calibrate/point',
      payload: { cam: 1, preset: 1, point: { x: 0.03, y: 0.5 }, mode: 'plate', source: 'real-camera-1' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('no_plate_near_click'); // UI 는 이 문자열을 `종료(reason)` 로 그대로 노출
    expect(body.plateWidth).toBeNull();
    // 카메라를 엉뚱한 차로 옮기지 않았다(캡처 1회, 이동 명령 0회).
    expect(built.real.log.filter((l) => l === 'move')).toHaveLength(0);
    expect(built.real.snapshots).toHaveLength(1);
  });

  it('source 미지정이면 파이프라인 카메라로 간다(기존 동작 — 회귀 0)', async () => {
    const built = buildApp({ plate: FAR });
    app = built.app;
    await app.inject({
      method: 'POST', url: '/calibrate/point',
      payload: { cam: 1, preset: 1, point: { x: 0.15, y: 0.45 }, mode: 'plate-zoom' },
    });
    expect(built.real.log).toEqual([]);
    expect(built.pipe.touches.length).toBeGreaterThan(0);
  });
});
