import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { CaptureJob } from '../src/capture/CaptureJob.js';
import { Finalizer } from '../src/capture/Finalizer.js';
import { SqliteStore } from '../src/capture/SqliteStore.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import { isUsableQuad, MIN_EDGE_PX, MIN_AREA_PX } from '../src/ground/groundModel.js';
import { diagnoseQuad } from '../src/ground/quadDiag.js';
import type { PixelQuad } from '../src/ground/types.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { CapturedImage, SetupArtifact } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * Stage 2 — POST /capture/place-roi/validate (읽기 전용 — 파일을 쓰지 않는다. W/H 조회로 읽기는 한다).
 * ★ 핵심 봉인: 이 라우트는 판정을 **재구현하지 않는다** — 무작위 200케이스에서 `resp.ok === isUsableQuad(quadPx)` 100% 일치.
 */

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

function makeServer(placeRoiFile?: string) {
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
  const app = buildServer({
    orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(),
    captureJob: job, finalizer, sqlite: store, capture: captureCfg, placeRoiFile,
  });
  return { app, store };
}

const W = 1920;
const H = 1080;
/** 픽셀 → 정규화(라우트 입력은 정규화 좌표다). */
const norm = (pts: Array<[number, number]>) => pts.map(([x, y]) => ({ x: x / W, y: y / H }));

let app: FastifyInstance | undefined;
let store: SqliteStore | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  if (store) { store.close(); store = undefined; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

async function validate(body: Record<string, unknown>) {
  const r = await app!.inject({ method: 'POST', url: '/capture/place-roi/validate', payload: body });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

describe('POST /capture/place-roi/validate', () => {
  it('T1 정상 사다리꼴 → ok:true, reasons 없음', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    const quad = norm([[100, 800], [140, 600], [420, 620], [400, 830]]);
    const { status, body } = await validate({ camId: 1, presetIdx: 1, quad, imageWidth: W, imageHeight: H });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reasons).toEqual([]);
    expect(body.metrics.convex).toBe(true);
    expect(body.metrics.areaPx2).toBeGreaterThan(MIN_AREA_PX);
  });

  it('T2 bowtie(자기교차) → ok:false + 자기교차 사유', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    const quad = norm([[100, 800], [400, 830], [140, 600], [420, 620]]); // 대각선 교차 순서.
    const { body } = await validate({ camId: 1, presetIdx: 1, quad, imageWidth: W, imageHeight: H });
    expect(body.ok).toBe(false);
    expect(body.metrics.convex).toBe(false);
    expect(body.reasons.join(' ')).toContain('꼬였습니다');
  });

  it('T3 짧은 변 / 작은 면적 → 각각의 사유가 임계값과 함께 나온다', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    // 4px 변(임계 8px 미만) + 면적도 400px² 미만인 작은 사각형.
    const tiny = norm([[100, 100], [100, 104], [104, 104], [104, 100]]);
    const t = await validate({ camId: 1, presetIdx: 1, quad: tiny, imageWidth: W, imageHeight: H });
    expect(t.body.ok).toBe(false);
    expect(t.body.reasons.join(' ')).toContain(`${MIN_EDGE_PX}px`);
    expect(t.body.reasons.join(' ')).toContain(`${MIN_AREA_PX}px²`);

    // 변은 충분히 길지만 면적만 미달(가늘고 긴 띠: 100 × 3px = 300px² < 400).
    const thin = norm([[100, 100], [100, 103], [200, 103], [200, 100]]);
    const th = await validate({ camId: 1, presetIdx: 1, quad: thin, imageWidth: W, imageHeight: H });
    expect(th.body.ok).toBe(false);
    expect(th.body.reasons.join(' ')).toContain('면적이 너무 작습니다');

    // 연속 3점 공선(퇴화).
    const line = norm([[100, 100], [200, 100], [300, 100], [200, 400]]);
    const l = await validate({ camId: 1, presetIdx: 1, quad: line, imageWidth: W, imageHeight: H });
    expect(l.body.ok).toBe(false);
    expect(l.body.reasons.join(' ')).toContain('일직선');
  });

  it('T4 무작위(고정 시드) 200케이스에서 resp.ok === isUsableQuad(quadPx) 100% 일치', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    // 결정론 LCG(시드 고정) — 무작위지만 매 실행 동일 입력.
    let seed = 20260728;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let okCount = 0;
    let rejectCount = 0;
    for (let i = 0; i < 200; i++) {
      // 넓은 분포(작은 면적·꼬인 순서·정상 사다리꼴이 모두 나오게).
      const scale = i % 3 === 0 ? 6 : i % 3 === 1 ? 60 : 400;
      const px: Array<[number, number]> = Array.from({ length: 4 }, () => [
        100 + rnd() * scale,
        100 + rnd() * scale,
      ]);
      const quadPx = px.map(([x, y]) => ({ x, y })) as PixelQuad;
      const expected = isUsableQuad(quadPx);
      const { body } = await validate({ camId: 1, presetIdx: 1, quad: norm(px), imageWidth: W, imageHeight: H });
      expect(body.ok, `case ${i} ${JSON.stringify(px)}`).toBe(expected);
      // 진단 모듈도 같은 판정을 낸다(단일 원천).
      expect(diagnoseQuad(quadPx).ok).toBe(expected);
      if (expected) okCount++; else rejectCount++;
    }
    // 한쪽으로만 쏠린 표본이면 일치 주장이 무의미하다 — 양쪽이 모두 나왔음을 확인.
    expect(okCount).toBeGreaterThan(0);
    expect(rejectCount).toBeGreaterThan(0);
  });

  it('T5 PtzCamRoi.json 부재 + body 의 imageWidth/imageHeight 만으로 동작(신규 주차장)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placevalidate-'));
    const s = makeServer(join(dir, 'nope', 'PtzCamRoi.json')); app = s.app; store = s.store;
    const quad = norm([[100, 800], [140, 600], [420, 620], [400, 830]]);
    const { status, body } = await validate({ camId: 1, presetIdx: 1, quad, imageWidth: W, imageHeight: H });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('T5-b 크기 출처가 하나도 없으면 ok:false + 라이브 시작 안내(추측하지 않는다)', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    const quad = norm([[100, 800], [140, 600], [420, 620], [400, 830]]);
    const { body } = await validate({ camId: 1, presetIdx: 1, quad });
    expect(body.ok).toBe(false);
    expect(body.reasons.join(' ')).toContain('이미지 크기 미상');
  });

  it('T5-c 파일에 카메라가 있으면 파일의 imageWidth/imageHeight 를 우선한다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placevalidate-'));
    const file = join(dir, 'PtzCamRoi.json');
    // 파일 크기 40x40 → 정규화 0.1 크기 quad 는 4px 짜리가 되어 거부된다(body 의 1920x1080 을 썼다면 통과했을 것).
    writeFileSync(file, JSON.stringify({ cameras: [{ camera: { cam_id: 1, imageWidth: 40, imageHeight: 40 }, presets: [] }] }), 'utf8');
    const s = makeServer(file); app = s.app; store = s.store;
    const quad = [{ x: 0.1, y: 0.8 }, { x: 0.1, y: 0.6 }, { x: 0.3, y: 0.6 }, { x: 0.3, y: 0.8 }];
    const { body } = await validate({ camId: 1, presetIdx: 1, quad, imageWidth: W, imageHeight: H });
    expect(body.ok).toBe(false);
    expect(body.metrics.minEdgePx).toBeCloseTo(8, 5); // 0.2(정규화 변) x 40(파일 폭) = 8px — body 의 1920 을 썼다면 384px 였다.
  });

  it('T6 4점이 아니면 400(스키마 거부 — 라우트는 파일을 건드리지 않는다)', async () => {
    const s = makeServer(undefined); app = s.app; store = s.store;
    const r = await app.inject({
      method: 'POST', url: '/capture/place-roi/validate',
      payload: { camId: 1, presetIdx: 1, quad: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('임계값 봉인(export 로 가시성만 바뀌었고 값은 그대로)', () => {
  it('MIN_EDGE_PX=8 · MIN_AREA_PX=400', () => {
    expect(MIN_EDGE_PX).toBe(8);
    expect(MIN_AREA_PX).toBe(400);
  });

  it('경계 바로 위/아래에서 isUsableQuad 가 그대로 갈린다(값 변경 시 즉시 실패)', () => {
    // 변 8.0px 정사각형: 면적 64px² < 400 → 거부. 변 20px 정사각형: 400px² 는 면적 임계 미만이 아니어야 통과.
    const sq = (a: number): PixelQuad => [{ x: 0, y: 0 }, { x: 0, y: a }, { x: a, y: a }, { x: a, y: 0 }];
    expect(isUsableQuad(sq(7.99))).toBe(false); // 변 < 8
    expect(isUsableQuad(sq(19.99))).toBe(false); // 면적 399.6 < 400
    expect(isUsableQuad(sq(20.01))).toBe(true); // 면적 400.4 ≥ 400, 변 ≥ 8
  });
});
