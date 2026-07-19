import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { PtzCalibrator } from '../src/calibrate/PtzCalibrator.js';
import { PlatePtz, type PlatePtzOpts } from '../src/calibrate/platePtz.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient, ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient, PlateBox } from '../src/clients/LpdClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { SetupArtifact } from '../src/domain/types.js';
import { rectToQuad } from '../src/domain/geometry.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { Ptz } from '../src/calibrate/types.js';

/**
 * 검증자(qa-tester): 센터라이징 실시간 프레임 버퍼 + GET /calibrate/frame + platePtz.onFrame 훅.
 * 설계 01_architect_plan.md §A / 구현 02_developer_changes.md §A1~A3.
 *
 * ★ 핵심 불변식 "추가 카메라 패킷 0": onFrame 은 이미 찍은 cap.jpg 를 재사용하므로
 *   프레임 버퍼링이 camera.requestImage 호출 수를 늘려선 안 된다. 라우트는 버퍼 반환만(카메라 재명령 없음).
 *   → 세 계층(PtzCalibrator 잡 / REST 라우트 / PlatePtz 훅) 각각에서 교차 검증한다.
 *
 * 픽스처는 calibrateRoutes.test.ts(카메라/LPD 가 명령 PTZ 를 jpg 로 인코딩)와 동일 모델을 재사용한다.
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};

function calCfg(outFile: string): ToolsConfig['calibrate'] {
  return {
    targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 30,
    probeStepDeg: 1.0, maxStepDeg: 5.0, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
    settleMs: 0, outFile,
  };
}

function artifact(): SetupArtifact {
  return {
    createdAt: 'T', presets: [],
    globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    slots: [{ slotId: 'c1p1s1', zone: 'z', roiByPreset: { '1:1': { x: 0.6, y: 0.6, w: 0.1, h: 0.05 } }, plateRoiByPreset: { '1:1': rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }) } }],
  };
}
function repoWith(a: SetupArtifact): Repository {
  return { loadArtifact: () => a } as unknown as Repository;
}

/** lpd 보유 1슬롯 slot_setup fixture(slot_id=1). PtzCalibrator 센터라이징 소스(총 대상 1건). */
function storeWith(): Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'> {
  const v: SlotSetupView[] = [{
    slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [], vpd: null, lpd: rectToQuad({ x: 0.62, y: 0.62, w: 0.05, h: 0.03 }),
    occupyRange: null, pan: null, tilt: null, zoom: null, centered: false, img1: null, slot3dFrontCenter: null, updatedAt: null,
  }];
  return { getSlotSetup: () => v, upsertSlotCentering: () => {} } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
}

/** 명령 PTZ 를 jpg 로 인코딩하는 카메라 + 호출 카운터/마지막 반환 버퍼 노출. */
function countingCamera() {
  const state = { calls: 0, lastJpg: undefined as Buffer | undefined };
  const camera = {
    health: async () => true,
    clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
    requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
      state.calls++;
      const pan = ptz?.pan ?? 0, tilt = ptz?.tilt ?? 0, zoom = ptz?.zoom ?? 1;
      const jpg = Buffer.from(JSON.stringify({ pan, tilt, zoom }));
      state.lastJpg = jpg;
      return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg };
    },
  } as unknown as CameraClient;
  return { camera, state };
}
function fakeLpd(): LpdClient {
  return {
    detect: async (jpg: Buffer): Promise<PlateBox[]> => {
      const { pan, tilt, zoom } = JSON.parse(jpg.toString());
      const cx = 0.7 - pan * 0.02, cy = 0.8 - tilt * 0.02, w = Math.min(0.9, 0.05 * zoom), h = 0.03;
      return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: 0.9, cls: 'plate' }];
    },
  } as unknown as LpdClient;
}
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);

/** 백그라운드 잡이 running 을 벗어날 때까지 대기(마이크로태스크 양보). */
async function waitJob(c: PtzCalibrator): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (c.getStatus().state !== 'running') return;
    await Promise.resolve();
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  vi.restoreAllMocks();
});

// ── 1. PtzCalibrator 프레임 버퍼 ────────────────────────────────────────────────
describe('1. PtzCalibrator 프레임 버퍼 (getLastFrame)', () => {
  it('시작 전 undefined → 잡 진행 중 캡처마다 갱신 → 종료 후 최신 프레임 유지', async () => {
    const { camera, state } = countingCamera();
    const c = new PtzCalibrator({ camera, lpd: fakeLpd(), store: storeWith(), cfg: calCfg('x'), sleep: async () => {}, now: () => 'T', writer: () => {} });
    expect(c.getLastFrame()).toBeUndefined(); // 시작 전엔 버퍼 없음
    c.start();
    await waitJob(c);
    expect(c.getStatus().state).toBe('done');
    const lf = c.getLastFrame();
    expect(lf).toBeDefined();
    expect(Buffer.isBuffer(lf!.jpeg)).toBe(true);
    expect(lf!.camIdx).toBe(1);
    expect(lf!.presetIdx).toBe(1);
    // onFrame 은 cap.jpg 를 그대로 버퍼링 → 마지막 캡처가 반환한 버퍼와 참조 동일(복사/재캡처 없음).
    expect(lf!.jpeg).toBe(state.lastJpg);
    expect(state.calls).toBeGreaterThan(1); // 최소 초기캡처+probe
  });

  it('★불변식: 프레임 버퍼가 카메라 requestImage 호출 수를 늘리지 않는다 (기본 팩토리 onFrame vs onFrame 미배선)', async () => {
    // A: 기본 팩토리 → onFrame 배선(버퍼 갱신).
    const A = countingCamera();
    const lpdA = fakeLpd();
    const ca = new PtzCalibrator({ camera: A.camera, lpd: lpdA, store: storeWith(), cfg: calCfg('x'), sleep: async () => {}, now: () => 'T', writer: () => {} });
    ca.start();
    await waitJob(ca);
    expect(ca.getLastFrame()).toBeDefined();

    // B: makePlatePtz 주입 → onFrame 없는 PlatePtz(프레임 버퍼 비활성). 동일 결정형 모델 → 동일 궤적.
    const B = countingCamera();
    const lpdB = fakeLpd();
    const cb = new PtzCalibrator({
      camera: B.camera, lpd: lpdB, store: storeWith(), cfg: calCfg('x'),
      sleep: async () => {}, now: () => 'T', writer: () => {},
      makePlatePtz: (opts) => new PlatePtz({ camera: B.camera, lpd: lpdB, sleep: async () => {} }, opts),
    });
    cb.start();
    await waitJob(cb);
    expect(cb.getLastFrame()).toBeUndefined(); // onFrame 미배선 → 버퍼 없음

    expect(A.state.calls).toBeGreaterThan(0);
    expect(A.state.calls).toBe(B.state.calls); // 프레임 버퍼 = 카메라 패킷 0 증가
  });
});

// ── 2. GET /calibrate/frame 라우트 ──────────────────────────────────────────────
describe('2. GET /calibrate/frame', () => {
  function makeServer(outFile: string) {
    const repo = repoWith(artifact());
    const { camera } = countingCamera();
    const calibrator = new PtzCalibrator({ camera, lpd: fakeLpd(), store: storeWith(), cfg: calCfg(outFile), sleep: async () => {}, now: () => 'T', writer: () => {} });
    const orchestrator = new SetupOrchestrator({ camera, vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    const a = buildServer({ orchestrator, repo, camera, vpd: fakeVpd(), calibrator, calibrate: calCfg(outFile) });
    return { app: a, calibrator, camera };
  }

  it('버퍼 있음 → 200 + image/jpeg + no-store + X-Cal-Cam/X-Cal-Preset + body=jpeg', async () => {
    const s = makeServer('x'); app = s.app;
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    vi.spyOn(s.calibrator, 'getLastFrame').mockReturnValue({ jpeg: buf, camIdx: 2, presetIdx: 3 });
    const r = await app.inject({ method: 'GET', url: '/calibrate/frame' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toContain('image/jpeg');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-cal-cam']).toBe('2');
    expect(r.headers['x-cal-preset']).toBe('3');
    expect(r.rawPayload.equals(buf)).toBe(true); // body 가 버퍼 그대로
  });

  it('버퍼 없음(getLastFrame undefined) → 404 {error:"no frame"}', async () => {
    const s = makeServer('x'); app = s.app;
    // 잡 미실행 → lastFrame undefined.
    const r = await app.inject({ method: 'GET', url: '/calibrate/frame' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('no frame');
  });

  it('★불변식: 라우트 호출이 camera.requestImage 를 부르지 않는다(버퍼 반환만)', async () => {
    const s = makeServer('x'); app = s.app;
    const buf = Buffer.from([0xff, 0xd8]);
    vi.spyOn(s.calibrator, 'getLastFrame').mockReturnValue({ jpeg: buf, camIdx: 1, presetIdx: 1 });
    const spy = vi.spyOn(s.camera, 'requestImage');
    const r = await app.inject({ method: 'GET', url: '/calibrate/frame' });
    expect(r.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled(); // 카메라 재명령 0
  });
});

// ── 3. platePtz onFrame 훅 단위 ─────────────────────────────────────────────────
describe('3. platePtz onFrame 훅', () => {
  const OPTS: PlatePtzOpts = { settleMs: 0 };
  const START: Ptz = { pan: 0, tilt: 0, zoom: 1 };

  /** 명령 PTZ 를 jpg 로 인코딩하는 camera + lpd. requestJpgs = 캡처가 반환한 버퍼 궤적. */
  function frameMock() {
    const requestJpgs: Buffer[] = [];
    const camera = {
      clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
      requestImage: async (_c: number, _p: number, ptz?: { pan?: number; tilt?: number; zoom?: number }) => {
        const pan = ptz?.pan ?? 0, tilt = ptz?.tilt ?? 0, zoom = ptz?.zoom ?? 1;
        const jpg = Buffer.from(JSON.stringify({ pan, tilt, zoom }));
        requestJpgs.push(jpg);
        return { camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg };
      },
    } as unknown as ICameraClient;
    const lpd = {
      detect: async (jpg: Buffer): Promise<PlateBox[]> => {
        const { pan, tilt, zoom } = JSON.parse(jpg.toString());
        const cx = 0.7 - pan * 0.02, cy = 0.8 - tilt * 0.02, w = Math.min(0.9, 0.05 * zoom), h = 0.03;
        return [{ quad: rectToQuad({ x: cx - w / 2, y: cy - h / 2, w, h }), confidence: 0.9, cls: 'plate' }];
      },
    } as unknown as LpdClient;
    return { camera, lpd, requestJpgs };
  }

  it('centerOnPlate: 매 requestImage 직후 onFrame(cap.jpg, cam, preset) — 호출수·버퍼 참조 일치', async () => {
    const mk = frameMock();
    const onFrameJpgs: Buffer[] = [];
    const cams: number[] = []; const presets: number[] = [];
    const p = new PlatePtz({
      camera: mk.camera, lpd: mk.lpd, sleep: async () => {},
      onFrame: (jpeg, cam, preset) => { onFrameJpgs.push(jpeg); cams.push(cam); presets.push(preset); },
    }, OPTS);
    await p.centerOnPlate(1, 1, START);

    expect(mk.requestJpgs.length).toBeGreaterThan(1);
    // onFrame 은 캡처마다 정확히 1회 = requestImage 횟수와 동일(추가 캡처 없음).
    expect(onFrameJpgs.length).toBe(mk.requestJpgs.length);
    // 각 프레임은 그 캡처의 cap.jpg 재사용(참조 동일).
    onFrameJpgs.forEach((b, i) => expect(b).toBe(mk.requestJpgs[i]));
    expect(cams.every((c) => c === 1)).toBe(true);
    expect(presets.every((x) => x === 1)).toBe(true);
  });

  it('★onFrame 유무가 requestImage 호출 수에 영향 없음(onFrame 있음 == 없음)', async () => {
    const withHook = frameMock();
    await new PlatePtz({ camera: withHook.camera, lpd: withHook.lpd, sleep: async () => {}, onFrame: () => {} }, OPTS).centerOnPlate(1, 1, START);
    const without = frameMock();
    await new PlatePtz({ camera: without.camera, lpd: without.lpd, sleep: async () => {} }, OPTS).centerOnPlate(1, 1, START);
    expect(withHook.requestJpgs.length).toBe(without.requestJpgs.length);
    expect(withHook.requestJpgs.length).toBeGreaterThan(1);
  });
});
