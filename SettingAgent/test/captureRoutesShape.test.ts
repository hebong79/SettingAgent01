import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerCaptureRoutes, type CaptureRouteDeps } from '../src/api/captureRoutes.js';

/**
 * 리팩토링(§4.1 서브등록기 7분할) 후 라우트 등록 형태 불변 스냅샷.
 * registerCaptureRoutes 가 등록하는 (method, url) 목록과 **등록 순서**가 분할 전과 동일해야 한다.
 * 조건부 라우트(pipeline/saveStore/camera/vpd/lpd/refFrameDir 가드)를 전부 켜서 전량 등록시킨다.
 * 핸들러는 실행하지 않으므로 deps 는 등록에 필요한 truthiness 만 채운 스텁이다.
 */

/** 등록 가드가 전부 참이 되도록 채운 스텁 deps(핸들러 미실행 — 캐스팅 안전). */
const fullDeps = {
  job: {},
  finalizer: {},
  store: {},
  cfg: {},
  saveStore: {},
  placeRoiFile: '/tmp/PtzCamRoi.json',
  refFrameDir: '/tmp/refframes',
  camera: {},
  vpd: {},
  lpd: {},
  pipeline: {},
} as unknown as CaptureRouteDeps;

/** onRoute 훅으로 등록 순서 그대로 (method url) 수집(HEAD 그림자 라우트 제외). */
function collectRoutes(deps: CaptureRouteDeps): string[] {
  const app = Fastify({ exposeHeadRoutes: false });
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) routes.push(`${m} ${r.url}`);
  });
  registerCaptureRoutes(app, deps);
  return routes;
}

/** 분할 전 원본 등록 순서(생명주기 → 슬롯 → 저장 → place-roi → 지면 → refframe → detect). */
const EXPECTED_ORDER = [
  'POST /capture/start',
  'GET /capture/status',
  'GET /capture/pipeline',
  'POST /capture/start-precise',
  'POST /capture/warmup',
  'GET /capture/frame',
  'POST /capture/stop',
  'POST /capture/finalize',
  'GET /capture/aggregate',
  'GET /capture/occupancy',
  'GET /capture/slots',
  'POST /capture/slots/reset',
  'POST /capture/slots/load-roi',
  'POST /capture/slots/lpd',
  'POST /capture/slots/occupy',
  'POST /capture/slots/cuboid',
  'POST /capture/save',
  'POST /capture/setup-result',
  'GET /capture/saves',
  'GET /capture/saves/:name',
  'GET /capture/place-roi',
  'PUT /capture/place-roi',
  'GET /capture/ground-model',
  'GET /capture/vehicle-cuboids',
  'GET /capture/job-cuboids',
  'POST /capture/refframe',
  'POST /capture/autocorrect',
  'POST /capture/detect',
];

describe('captureRoutes 라우트 형태(서브등록기 분할 불변)', () => {
  it('전량 등록 시 (method,url) 목록·순서가 원본과 동일', () => {
    expect(collectRoutes(fullDeps)).toEqual(EXPECTED_ORDER);
  });

  it('조건부 deps 미주입 시 해당 라우트만 빠진다(가드 보존)', () => {
    const base = {
      job: {},
      finalizer: {},
      store: {},
      cfg: {},
      placeRoiFile: '/tmp/PtzCamRoi.json',
    } as unknown as CaptureRouteDeps;
    const routes = collectRoutes(base);
    // pipeline/saveStore/camera/vpd/lpd/refFrameDir 미주입 → 가드 라우트 부재.
    expect(routes).not.toContain('GET /capture/pipeline');
    expect(routes).not.toContain('POST /capture/start-precise');
    expect(routes).not.toContain('POST /capture/save');
    expect(routes).not.toContain('GET /capture/vehicle-cuboids');
    expect(routes).not.toContain('POST /capture/refframe');
    expect(routes).not.toContain('POST /capture/detect');
    // 무조건 라우트는 존재.
    expect(routes).toContain('POST /capture/start');
    expect(routes).toContain('GET /capture/slots');
    expect(routes).toContain('GET /capture/job-cuboids');
    expect(routes).toContain('GET /capture/place-roi');
  });
});
