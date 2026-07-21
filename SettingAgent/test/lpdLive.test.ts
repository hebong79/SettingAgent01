import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runDetect, type DetectDeps, type DetectCfg } from '../src/capture/detectPipeline.js';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact, VehicleBox, NormalizedQuad } from '../src/domain/types.js';
import type { PlateBox } from '../src/clients/LpdClient.js';
import type { CameraList } from '../src/viewer/CameraSource.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): "현재화면 그대로 순수 LPD"(lpd-live) 타입.
 * 근거: _workspace/01_architect_plan.md + 02_developer_changes.md.
 *   변경: runDetect args.ptz 오버라이드(resolvePresetPtz 스킵·base/역투영/zoom 재시도 기준을 그 값으로),
 *         DetectBodySchema 옵셔널 ptz, /capture/detect 핸들러 전달.
 * 경계면 교차: 프론트(web/app.js runLiveDetect)는 lpd-live 에서 body.ptz={pan,tilt,zoom:Number} 만 전송 →
 *   서버 응답 basePtz 가 그 오버라이드값(프리셋 PTZ 스냅 아님)이어야 한다.
 */

// readJpegSize 가 파싱 가능한 최소 JPEG(SOF0: 200×100).
const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const PRESET_PTZ = { pan: 56.6, tilt: 7.4, zoom: 1.9 };
const cfg: DetectCfg = { fovBaseV: 24.017, aspect: 16 / 9, frontBias: 0.62, zoomFactors: [2, 3, 4, 5], zoomRef: 1 };

/** camera 스텁(detectPipeline.test 패턴 재사용): listCameras(프리셋 PTZ) + requestImage(echo 0/0/1) + clampZoom. */
function makeCamera() {
  const requestImage = vi.fn(
    async (camIdx: number, presetIdx: number, _ptz?: { pan?: number; tilt?: number; zoom?: number }): Promise<CapturedImage> => {
      // echo 는 항상 0/0/1(프리셋/오버라이드와 다르게) → basePtz 가 echo 가 아님을 검증 가능.
      return { camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG };
    },
  );
  const listCameras = vi.fn(async (): Promise<CameraList> => {
    return { cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'p1', ...PRESET_PTZ }] }] };
  });
  const clampZoom = vi.fn((z: number) => Math.min(10, Math.max(1, z)));
  return { requestImage, listCameras, clampZoom };
}

function makeVpd(vehicles: VehicleBox[]) {
  return { detect: vi.fn(async (_jpg: Buffer) => vehicles) };
}
function makeLpd(byCall: PlateBox[][]) {
  let i = 0;
  return { detect: vi.fn(async (_jpg: Buffer) => byCall[i++] ?? []) };
}

const quad = (cx: number, cy: number): NormalizedQuad => [
  { x: cx - 0.02, y: cy - 0.02 },
  { x: cx + 0.02, y: cy - 0.02 },
  { x: cx + 0.02, y: cy + 0.02 },
  { x: cx - 0.02, y: cy + 0.02 },
];
const plate = (cx: number, cy: number, confidence = 0.9): PlateBox => ({ quad: quad(cx, cy), confidence, cls: 'car_license_plate' });
const vehicle = (x: number, y: number, w: number, h: number, confidence = 0.8): VehicleBox => ({ rect: { x, y, w, h }, confidence, cls: 'vehicle' });

describe('runDetect — args.ptz 오버라이드(lpd-live)', () => {
  // T-1
  it('T-1 완전 ptz {pan,tilt,zoom} → requestImage 가 그 ptz 로 호출 · resolvePresetPtz(listCameras) 미호출 · basePtz=오버라이드', async () => {
    const camera = makeCamera();
    const OV = { pan: 30, tilt: 12, zoom: 5 };
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1, ptz: OV }, cfg);

    // (a) base 프레임 요청이 오버라이드 ptz 로 나갔다(프리셋 PTZ 아님).
    expect(camera.requestImage).toHaveBeenCalledWith(1, 1, OV);
    // (b) resolvePresetPtz 경로(listCameras)는 아예 타지 않는다.
    expect(camera.listCameras).toHaveBeenCalledTimes(0);
    // (c) base 좌표·역투영·zoom 재시도 기준 basePtz 가 오버라이드값.
    expect(out.basePtz).toEqual(OV);
  });

  it('T-1b basePtz 오버라이드가 zoom 재시도(역투영) 기준으로 실제 쓰인다 — 미검출 차량 복원', async () => {
    const camera = makeCamera();
    const OV = { pan: 30, tilt: 12, zoom: 5 };
    const v = vehicle(0.3, 0.5, 0.2, 0.3);
    // base=[] → 1차 뷰에서 번호판 → recovered. 재시도 경로가 basePtz(=OV)를 참조한다.
    const deps: DetectDeps = { camera, vpd: makeVpd([v]), lpd: makeLpd([[], [plate(0.5, 0.5)]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1, ptz: OV }, cfg);

    expect(out.basePtz).toEqual(OV); // 재시도 루프(line 330/336)가 쓰는 그 변수.
    expect(out.vehicles[0].plate!.recovered).toBe(true);
    expect(out.vehicles[0].plate!.attempts).toBe(1);
    // base(1) + 재시도 뷰(1) = 2회. base 요청은 오버라이드 ptz.
    expect(camera.requestImage).toHaveBeenCalledTimes(2);
    expect(camera.requestImage).toHaveBeenNthCalledWith(1, 1, 1, OV);
    expect(camera.listCameras).toHaveBeenCalledTimes(0);
  });

  // T-2
  it('T-2 ptz 미제공 → 기존 resolvePresetPtz(listCameras) 경로 · basePtz=프리셋 PTZ(회귀 불변)', async () => {
    const camera = makeCamera();
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1 }, cfg);

    expect(camera.listCameras).toHaveBeenCalledTimes(1); // 프리셋 경로 진입.
    expect(camera.requestImage).toHaveBeenCalledWith(1, 1, PRESET_PTZ);
    expect(out.basePtz).toEqual(PRESET_PTZ);
  });

  // T-3
  it('T-3 부분 필드 {zoom:8}(pan/tilt 생략) → pan/tilt 기본 0 · zoom 8 로 requestImage · resolvePresetPtz 미호출', async () => {
    const camera = makeCamera();
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1, ptz: { zoom: 8 } }, cfg);

    const EXPECT = { pan: 0, tilt: 0, zoom: 8 };
    expect(camera.requestImage).toHaveBeenCalledWith(1, 1, EXPECT);
    expect(out.basePtz).toEqual(EXPECT);
    expect(camera.listCameras).toHaveBeenCalledTimes(0);
  });

  it('T-3b 부분 필드 {pan:15}(tilt/zoom 생략) → tilt 0 · zoom 1 기본 규약', async () => {
    const camera = makeCamera();
    const deps: DetectDeps = { camera, vpd: makeVpd([]), lpd: makeLpd([[]]) };
    const out = await runDetect(deps, { cam: 1, preset: 1, ptz: { pan: 15 } }, cfg);
    expect(out.basePtz).toEqual({ pan: 15, tilt: 0, zoom: 1 });
    expect(camera.requestImage).toHaveBeenCalledWith(1, 1, { pan: 15, tilt: 0, zoom: 1 });
  });
});

/**
 * T-4/route 경계: DetectBodySchema 는 captureRoutes 내부 const(비export)라 실제 라우트(POST /capture/detect)로 검증한다.
 * 이것이 프론트↔서버의 진짜 경계면이다. 서버는 camera/vpd/lpd 주입 시에만 라우트 등록.
 */
describe('POST /capture/detect — ptz 오버라이드 경계(lpd-live)', () => {
  const captureCfg: ToolsConfig['capture'] = {
    defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
    checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
    clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
  };
  const setupCfg = {
    presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
    accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
  };
  const fakeCamera = () => ({
    health: async () => true,
    requestImage: async (c: number, p: number): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('f') }),
  } as unknown as CameraClient);
  const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
  const fakeRepo = (): Repository => {
    const saved: SetupArtifact[] = [];
    return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
  };

  /** listCameras/requestImage 를 vi.fn 으로 관찰 가능한 detect 카메라(프리셋 PTZ 10/5/1.5). */
  const detectCamera = () => {
    const requestImage = vi.fn(async (c: number, p: number, _ptz?: unknown): Promise<CapturedImage> => ({ camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: VALID_JPEG }));
    const listCameras = vi.fn(async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [{ presetIdx: 1, label: 'p1', pan: 10, tilt: 5, zoom: 1.5 }] }] }));
    const camera = { health: async () => true, clampZoom: (z: number) => Math.min(10, Math.max(1, z)), listCameras, requestImage } as unknown as CameraClient;
    return { camera, requestImage, listCameras };
  };

  function makeDetectServer(camera: CameraClient): FastifyInstance {
    const store = new SqliteStore(':memory:');
    const queue: Array<() => void> = [];
    const job = new CaptureJob({
      camera: fakeCamera(), vpd: fakeVpd(), cfg: captureCfg, lpdEnabled: false,
      setTimer: (fn) => { queue.push(fn); return queue as unknown as NodeJS.Timeout; },
      clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
    });
    const repo = fakeRepo();
    const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
    const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
    return buildServer({
      orchestrator, repo, camera,
      vpd: { health: async () => true, detect: async () => [] } as unknown as VpdClient,
      lpd: { health: async () => true, detect: async () => [] } as unknown as LpdClient,
      captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    });
  }

  // T-4 파싱 성공(완전 ptz) + 오버라이드가 basePtz 로 반영 + resolvePresetPtz 미호출.
  it('T-4 {cam,preset,ptz:{pan,tilt,zoom}} → 200 · basePtz=오버라이드(프리셋 PTZ 아님) · listCameras 미호출', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1, ptz: { pan: 30, tilt: 12, zoom: 5 } } });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.basePtz).toEqual({ pan: 30, tilt: 12, zoom: 5 }); // 프리셋 PTZ(10/5/1.5) 스냅 아님.
      expect(dc.requestImage).toHaveBeenCalledWith(1, 1, { pan: 30, tilt: 12, zoom: 5 });
      expect(dc.listCameras).toHaveBeenCalledTimes(0); // 오버라이드 경로 — 프리셋 조회 스킵.
    } finally {
      await app.close();
    }
  });

  it('T-4b ptz 생략 → 200 · 기존 프리셋 경로(basePtz=프리셋 PTZ · listCameras 호출)', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1 } });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.basePtz).toEqual({ pan: 10, tilt: 5, zoom: 1.5 });
      expect(dc.listCameras).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('T-4c 부분 필드 ptz:{zoom:8} → 200 · basePtz={0,0,8}(옵셔널 필드 파싱 성공)', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1, ptz: { zoom: 8 } } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).basePtz).toEqual({ pan: 0, tilt: 0, zoom: 8 });
    } finally {
      await app.close();
    }
  });

  it('T-4d 빈 ptz:{} → 200 · basePtz={0,0,1}(전 필드 기본값 규약)', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1, ptz: {} } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).basePtz).toEqual({ pan: 0, tilt: 0, zoom: 1 });
    } finally {
      await app.close();
    }
  });

  it('T-4e 잘못된 타입 ptz.pan="x"(문자열) → 400 invalid body (zod 거부)', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1, ptz: { pan: 'x' } } });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe('invalid body');
    } finally {
      await app.close();
    }
  });

  it('T-4f ptz 가 객체 아님(ptz=5) → 400 invalid body', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: { cam: 1, preset: 1, ptz: 5 } });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  /**
   * ★ 경계면 교차(qa 핵심): 프론트 web/app.js:runLiveDetect(false, state.ptz) 가 보내는 정확한 body 형태
   *   { cam, preset, vpdOnParkingOnly, vpdEnabled:false, ptz:{pan:Number,tilt:Number,zoom:Number} } 를 그대로 재현.
   *   → 응답 basePtz 가 그 ptz 여야 프론트가 '현재 화면 그대로' 검출한 것이 맞다.
   */
  it('★ 경계면: 프론트 runLiveDetect(lpd-live) body 재현 → basePtz=현재 뷰어 PTZ · VPD 미실행', async () => {
    const dc = detectCamera();
    const app = makeDetectServer(dc.camera);
    try {
      const frontBody = { cam: 1, preset: 1, vpdOnParkingOnly: true, vpdEnabled: false, ptz: { pan: 42.5, tilt: -3.2, zoom: 2 } };
      const r = await app.inject({ method: 'POST', url: '/capture/detect', payload: frontBody });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.basePtz).toEqual({ pan: 42.5, tilt: -3.2, zoom: 2 });
      expect(body.summary.vpdEnabled).toBe(false); // lpd-live 는 VPD off(순수 LPD).
      expect(dc.requestImage).toHaveBeenCalledWith(1, 1, { pan: 42.5, tilt: -3.2, zoom: 2 });
    } finally {
      await app.close();
    }
  });
});
