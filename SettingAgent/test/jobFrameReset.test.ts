import { describe, it, expect } from 'vitest';
import { PtzCalibrator, type PtzCalibratorDeps } from '../src/calibrate/PtzCalibrator.js';
import { PlateDiscoveryJob } from '../src/calibrate/PlateDiscoveryJob.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { LpdClient } from '../src/clients/LpdClient.js';
import type { SqliteStore } from '../src/capture/SqliteStore.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { Ptz } from '../src/calibrate/types.js';

/**
 * 수정 22 — **직전 실행의 프레임이 새 실행 화면에 뜨는 표시 버그** 회귀 고정.
 *
 * 마스터 신고: "36배줌 상태에서 UI 로 줌값을 줄여 다른 곳을 클릭하면 원래 36배줌이 다시 보인다."
 * 원인은 제어가 아니라 **표시**였다 — 잡의 `lastFrame` 버퍼가 한 번도 무효화되지 않아,
 * 새 실행이 첫 캡처를 넣기 전까지 `/…/frame` 이 **직전 실행의 마지막 프레임**을 계속 서빙했다.
 * 뷰어는 그 사이 라이브를 끊고 이 라우트를 폴링하므로 **카메라는 새 위치인데 화면만 과거**가 된다.
 *
 * 계약: 카메라를 움직이는 잡이 **시작되는 순간** 버퍼는 비어야 한다(라우트는 404 = "버퍼 없음").
 * 같은 `getLastFrame` 패턴을 쓰는 **세 잡 전부**를 고정한다 — 한 곳만 고치면 다른 탭에서 같은 혼란이 남는다.
 */

const STALE = { jpeg: Buffer.from('OLD-36X-FRAME'), camIdx: 1, presetIdx: 1 };

const stubCamera = {
  clampZoom: (z: number) => Math.min(36, Math.max(1, z)),
  getPtz: async (): Promise<Ptz> => ({ pan: 0, tilt: 0, zoom: 1 }),
  requestImage: async () => ({ camIdx: 1, presetIdx: 1, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('new') }),
  move: async () => true,
  listCameras: async () => ({ cameras: [] }),
  health: async () => true,
} as unknown as ICameraClient;

const stubLpd = { detect: async () => [] } as unknown as LpdClient;

const calCfg = {
  targetPlateWidth: 0.2, centerTol: 0.03, widthTol: 0.02, maxIterations: 5,
  probeStepDeg: 1, maxStepDeg: 5, fallbackGainPanDeg: -62, fallbackGainTiltDeg: -35.5,
  settleMs: 0, outFile: 'x.json',
} as unknown as ToolsConfig['calibrate'];

function calibrator(): PtzCalibrator {
  const store = { getSlotSetup: () => [], upsertSlotCentering: () => {} } as unknown as Pick<SqliteStore, 'upsertSlotCentering' | 'getSlotSetup'>;
  const deps: PtzCalibratorDeps = {
    camera: stubCamera, lpd: stubLpd, cfg: calCfg, store,
    // 카메라를 실제로 돌리지 않는 스텁(프레임 버퍼 수명만 관측한다).
    makePlatePtz: () => ({
      centerOnPlate: async () => ({ ok: false, ptz: { pan: 0, tilt: 0, zoom: 1 }, plate: null, err: null, plateWidth: null, gain: { gainPan: -62, gainTilt: -35.5, zoomRef: 1 }, iterations: 0, reason: 'no_plate' as const }),
      zoomToPlateWidth: async () => ({ ok: false, ptz: { pan: 0, tilt: 0, zoom: 1 }, plate: null, err: null, plateWidth: null, gain: { gainPan: -62, gainTilt: -35.5, zoomRef: 1 }, iterations: 0, reason: 'no_plate' as const }),
    }),
    writer: () => {}, sleep: async () => {}, now: () => 'T',
  };
  return new PtzCalibrator(deps);
}

/** 직전 실행이 남긴 프레임을 심는다(private 필드 — 라우트가 읽는 그 버퍼). */
function seedStale(job: object): void {
  Reflect.set(job, 'lastFrame', STALE);
}

describe('수정 22 — 잡 시작 시 직전 실행 프레임 무효화', () => {
  it('★개별(클릭) center+zoom 시작 → 직전 실행 프레임을 서빙하지 않는다', async () => {
    const c = calibrator();
    seedStale(c);
    expect(c.getLastFrame()).toEqual(STALE); // 사전 조건: 과거 프레임이 남아 있다

    await c.centerOnPoint(1, 1, { x: 0.5, y: 0.5 }, { zoom: true });

    // 스텁이 캡처를 만들지 않으므로 새 프레임은 없다 → 라우트는 404(버퍼 없음)를 돌려야 한다.
    expect(c.getLastFrame()).toBeUndefined();
  });

  it('★개별 클릭 지점 조준(mode point) 시작 → 검출이 없어도 프레임은 무효화된다', async () => {
    const c = calibrator();
    seedStale(c);
    await c.aimPointToCenter(1, 1, { x: 0.3, y: 0.4 });
    // 이 경로는 캡처를 하지 않지만 **카메라는 움직인다** → 직전 프레임은 그 시점부터 과거다.
    expect(c.getLastFrame()).toBeUndefined();
  });

  it('★배치 센터라이징 start() → 즉시 무효화된다(백그라운드 실행 전에)', () => {
    const c = calibrator();
    seedStale(c);
    c.start();
    expect(c.getLastFrame()).toBeUndefined();
  });

  it('★discovery start() → 직전 탐색 프레임을 서빙하지 않는다', () => {
    const job = makeDiscovery();
    seedStale(job);
    expect(job.getLastFrame()).toEqual(STALE);
    job.start();
    expect(job.getLastFrame()).toBeUndefined();
  });

  it('무효화는 시작 시점에만 일어난다 — 새 프레임이 들어오면 그대로 보존된다', () => {
    const c = calibrator();
    c.start();
    const fresh = { jpeg: Buffer.from('NEW'), camIdx: 2, presetIdx: 3 };
    Reflect.set(c, 'lastFrame', fresh); // 잡 진행 중 onFrame 이 채우는 자리
    expect(c.getLastFrame()).toEqual(fresh); // 조회가 버퍼를 지우지 않는다(폴링 계약)
  });
});

/** PlateDiscoveryJob 생성(필수 deps 최소 구성 — 대상 0건이라 즉시 완료된다). */
function makeDiscovery(): PlateDiscoveryJob {
  const deps = {
    store: { getSlotSetup: () => [], upsertSlotLpd: () => {} },
    camera: stubCamera,
    lpd: stubLpd,
    outFile: 'x.json',
    sleep: async () => {},
    now: () => 'T',
  };
  return new PlateDiscoveryJob(deps as unknown as ConstructorParameters<typeof PlateDiscoveryJob>[0]);
}
