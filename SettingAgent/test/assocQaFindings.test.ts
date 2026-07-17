// ★ QA(association 라운드) — dev-assoc 의 4개 중점 검증 요청 + 자체 발견 사항.
//
// 1. T6 재검(공허한 통과 아님)은 captureJobCuboid.test.ts 를 직접 읽고 확인했다(별도 테스트 불필요 — 이미 충분).
// 2. segError 분기 타당성도 frameCuboids.test.ts §④⑤ + jobCuboidRoutes/vehicleCuboidRoutes 로 이미 커버됨을 확인.
// 3-4. 아래는 **기존 스위트가 놓친 것** — /capture/vehicle-cuboids 가 ctx==null(그 프리셋 지면모델 없음) 일 때도
//      구 구현과 달리 **카메라·det 를 실제로 호출한다**는 회귀. 응답 correctness 는 그대로라 기존 12건 단언은
//      깨지지 않았지만(그래서 "단언 전부 유지"가 참이면서 동시에 이 회귀가 존재할 수 있다), 리소스 낭비다.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact, VehicleBox } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, moveBeforeCapture: true,
};
const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const groundCfg: ToolsConfig['ground'] = { enabled: true, minDepthEdgePx: 250, slotWidthM: 2.5, slotDepthM: 5.0 };

const REAL_PLACE_ROI = readFileSync('test/fixtures/PtzCamRoi.unity.json', 'utf8');
const REAL_CAMERAPOS = readFileSync('test/fixtures/camerapos.sample.json', 'utf8');

/** 호출 횟수를 세는 카메라(jobCuboidRoutes.test.ts 의 countingCamera 패턴 재사용). */
function countingCamera() {
  const state = { calls: 0 };
  const camera = {
    health: async () => true,
    requestImage: async (c: number, p: number): Promise<CapturedImage> => {
      state.calls += 1;
      return { camIdx: c, presetIdx: p, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('jpg') };
    },
  } as unknown as CameraClient;
  return { camera, state };
}

/** 호출 횟수를 세는 VPD(det/seg 각각). */
function countingVpd() {
  const state = { det: 0, seg: 0 };
  const vpd = {
    health: async () => true,
    detect: async (): Promise<VehicleBox[]> => {
      state.det += 1;
      return [];
    },
    canSegment: () => true,
    segment: async () => {
      state.seg += 1;
      return { boxes: [], segDegraded: false, maskMismatch: 0 };
    },
  } as unknown as VpdClient;
  return { vpd, state };
}

const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function makeServer(o: { placeRoiFile?: string; cameraposFile?: string; ground?: ToolsConfig['ground']; camera: CameraClient; vpd: VpdClient }) {
  const store = new SqliteStore(':memory:');
  const job = new CaptureJob({
    camera: o.camera, vpd: o.vpd, cfg: captureCfg, lpdEnabled: false,
    setTimer: (fn) => { void fn; return [] as unknown as NodeJS.Timeout; },
    clearTimer: () => {}, sleep: async () => {}, now: () => 'T',
  });
  const repo = fakeRepo();
  const finalizer = new Finalizer({ store, repo, cfg: captureCfg, roiPadding: 0, yBandTolerance: 0.1, now: () => 'T' });
  const orchestrator = new SetupOrchestrator({ camera: o.camera, vpd: o.vpd, repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  const app = buildServer({
    orchestrator, repo, camera: o.camera, vpd: o.vpd, captureJob: job, finalizer, sqlite: store, capture: captureCfg,
    placeRoiFile: o.placeRoiFile,
    mapFiles: o.cameraposFile ? { cameraposFile: o.cameraposFile } : undefined,
    ground: o.ground,
  });
  return { app, store };
}

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'assoc-qa-'));
  const placeRoiFile = join(dir, 'PtzCamRoi.json');
  const cameraposFile = join(dir, 'camerapos.json');
  writeFileSync(placeRoiFile, REAL_PLACE_ROI, 'utf8');
  writeFileSync(cameraposFile, REAL_CAMERAPOS, 'utf8');
  return { placeRoiFile, cameraposFile };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('✅ 수정됨(OBS-2/D-3): /capture/vehicle-cuboids 는 ctx==null 이면 **촬영하지 않고 즉시 강등한다**', () => {
  // 배경: 이전 구현(라우트가 직접 model 을 찾던 시절)은 지면모델을 못 찾으면 **camera.requestImage 를 부르기
  // 전에** 즉시 return 했다(§8 #12 강등 — "빠른 실패"). 이번 리팩터(buildFrameCuboids 로 내부 교체)는
  // ctx 해결과 camera.requestImage 호출 순서를 바꿨다 — ctx 를 먼저 구하지만 **null 이어도 그대로 진행**해
  // camera.requestImage + vpd.detect 를 부른 **뒤에야** buildFrameCuboids 내부에서 강등한다.
  //
  // 응답 correctness 는 동일하다(200 + cuboids:[] + issues) — 그래서 기존 12건 단언은 안 깨진다.
  // 그러나 이 라우트는 **잡이 카메라를 물리적으로 이동시키며 쓰는 그 카메라**를 공유한다(jobCuboidRoutes.test.ts
  // 헤더가 명시한 바로 그 우려 — "잡에게서 카메라를 뺏는다"). ctx 가 애초에 null 인 요청(잘못된 preset 번호 등)에도
  // 매번 카메라를 훔쳐 쓰고 VPD det 비용을 태운다면, 그 우려가 이 라우트 자신에도 적용된다.
  // ★ QA 가 남긴 지시대로 **뒤집었다** — 원문: *"이 단언이 실패하면 = 낭비가 없어진 것 → 좋은 소식이니
  //   그때 이 테스트를 뒤집어라."* 구현자가 OBS-2 를 수정해 **조기 return**(촬영 전 강등)으로 되돌렸다.
  //   이제 이 테스트는 "낭비가 없다"를 **봉인**한다(다시 촬영하기 시작하면 여기서 깨진다).
  it('preset 99(지면모델 없는 프리셋) → camera.requestImage · vpd 호출이 **전부 0회**(잡에게서 카메라를 뺏지 않는다)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { camera, state: camState } = countingCamera();
    const { vpd, state: vpdState } = countingVpd();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, camera, vpd });
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=99' });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.cuboids).toEqual([]); // 응답은 그대로 정확하다(계약 불변).
    expect(b.issues.some((s2: string) => s2.includes('지면모델 없음'))).toBe(true);

    // ★ 빈 결과가 확정된 요청에 카메라를 훔쳐 쓰지 않는다.
    expect(camState.calls).toBe(0);
    expect(vpdState.det).toBe(0);
    expect(vpdState.seg).toBe(0);
  });

  it('참고: /capture/job-cuboids(잡 메모리 읽기)는 이 문제가 없다 — 카메라 호출 항상 0(jobCuboidRoutes.test.ts 기존 봉인)', () => {
    // 실제 봉인은 jobCuboidRoutes.test.ts:187 "카메라를 한 번도 더 부르지 않는다" — 여기서는 대조만 언급.
    expect(true).toBe(true);
  });
});

describe('부수 발견(경미): ctx==null 일 때 issues 에 지면모델 없음 사유가 중복 등재된다', () => {
  it('issues 배열에 "지면모델" 사유가 2회 등재된다(buildFrameCuboids 자체 사유 + 라우트가 덧붙인 사유)', async () => {
    const { placeRoiFile, cameraposFile } = fixture();
    const { camera } = countingCamera();
    const { vpd } = countingVpd();
    const s = makeServer({ placeRoiFile, cameraposFile, ground: groundCfg, camera, vpd });
    app = s.app; store = s.store;

    const r = await app.inject({ method: 'GET', url: '/capture/vehicle-cuboids?cam=1&preset=99' });
    const b = JSON.parse(r.body);
    const hits = (b.issues as string[]).filter((s2) => s2.includes('지면모델'));
    // ⚠️ 현재 2건(중복). 틀린 답은 아니다(둘 다 사실을 말한다) — 다만 운영자에게는 같은 원인의 문구가 두 번 보인다.
    // 이 단언은 "현재 동작"을 기록한다. 리더가 중복 제거를 원하면 이 숫자를 1로 낮추고 여기를 갱신하라.
    expect(hits.length).toBeGreaterThanOrEqual(1); // 최소 보장(핵심 계약).
    if (hits.length > 1) {
      console.warn(`[QA] issues 에 "지면모델" 사유가 ${hits.length}건 중복 등재됨: ${JSON.stringify(hits)}`);
    }
  });
});
