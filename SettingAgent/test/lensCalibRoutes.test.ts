import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLensCalibRoutes } from '../src/api/lensCalibRoutes.js';
import { LensCalibrationJob, type RunnerApi } from '../src/calibrate/LensCalibrationJob.js';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';

/** /calibrate/lens/* 라우트 통합(fastify inject). 잡은 실제 인스턴스 + 목 러너. */

const SOURCES = [
  { id: 'real-camera-2', kind: 'hucoms', baseUrl: 'http://192.168.0.154:80', username: 'admin', password: 'x' },
  { id: 'sim-1', kind: 'sim', baseUrl: 'http://localhost:9000' },
] as CameraSourceConfig[];

const VERIFY_OK = { checks: [], unmeasured: [], worstPx: 2.4, verdict: 'pass', calibration: 'cam-001', usable: 17, of: 18 } as never;

let dir: string;
let app: FastifyInstance;
let job: LensCalibrationJob;
let hold: (() => void) | null;

function build(opts: { run?: RunnerApi['run']; isBusy?: () => { busy: boolean; who?: string } } = {}): void {
  job = new LensCalibrationJob({
    sources: SOURCES,
    calibFile: join(dir, 'lens_calibration.json'),
    resultDir: dir,
    ...(opts.isBusy ? { isBusy: opts.isBusy } : {}),
    makeRunner: () =>
      ({
        run: opts.run ?? (async () => VERIFY_OK),
        runDistortion: async () => ({ points: [], skipped: [], samples: [], usable: 0, of: 0 }),
        verifyDistortion: () => ({ perZoom: [], worstOffPx: null, worstOnPx: null, verdict: 'fail', recommendation: 'reject', unmeasured: [] }),
      }) as RunnerApi,
  });
  app = Fastify({ logger: false });
  registerLensCalibRoutes(app, { job, calibFile: join(dir, 'lens_calibration.json'), resultDir: dir });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lenscalibroute-'));
  hold = null;
  build();
});
afterEach(async () => {
  hold?.();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('POST /calibrate/lens/start', () => {
  it('정상 시작 → 200 + total/mode/sourceId', async () => {
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'verify' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, started: true, mode: 'verify', total: 18, sourceId: 'real-camera-2' });
    await settle();
  });

  it('mode 미지정 → 기본 full', async () => {
    build({ run: () => new Promise((r) => (hold = () => r(VERIFY_OK))) });
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2' } });
    expect(res.json()).toMatchObject({ mode: 'full', total: 112 });
  });

  it('source 누락 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid body');
  });

  it('미지 모드 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'nope' } });
    expect(res.statusCode).toBe(400);
  });

  it('시뮬레이터 소스 → 400 (설정 오류이지 일시 충돌이 아니다)', async () => {
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'sim-1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/실카\(hucoms\)가 아닙니다/);
  });

  it('중복 시작 → 409', async () => {
    build({ run: () => new Promise((r) => (hold = () => r(VERIFY_OK))) });
    await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'verify' } });
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'verify' } });
    expect(res.statusCode).toBe(409);
  });

  it('다른 잡 점유 → 409 + 누가 쓰는지', async () => {
    build({ isBusy: () => ({ busy: true, who: '센터라이징' }) });
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/센터라이징/);
  });
});

describe('POST /calibrate/lens/stop', () => {
  it('실행 중 → 200 stopping', async () => {
    build({ run: ({ signal }) => new Promise((_r, rej) => signal?.addEventListener('abort', () => rej(new Error('중지')))) });
    await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'verify' } });
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/stop' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: 'stopping' });
    await settle();
  });

  it('실행 중이 아니면 → 400 not running', async () => {
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/stop' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not running/);
  });
});

describe('GET /calibrate/lens/status', () => {
  it('idle 기본 상태 + no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/calibrate/lens/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ state: 'idle', logs: [], lastSeq: 0 });
  });

  it('sinceSeq → 증분만', async () => {
    build({ run: () => new Promise((r) => (hold = () => r(VERIFY_OK))) });
    await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'verify' } });
    const first = (await app.inject({ method: 'GET', url: '/calibrate/lens/status' })).json();
    expect(first.logs.length).toBeGreaterThan(0);
    const inc = (await app.inject({ method: 'GET', url: `/calibrate/lens/status?sinceSeq=${first.lastSeq}` })).json();
    expect(inc.logs).toEqual([]);
  });

  it('sinceSeq 가 숫자가 아니면 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/calibrate/lens/status?sinceSeq=abc' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /calibrate/lens/result', () => {
  it('source 누락 → 400 · 결과 없음 → 404 · 있으면 전문', async () => {
    expect((await app.inject({ method: 'GET', url: '/calibrate/lens/result' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/calibrate/lens/result?source=real-camera-2' })).statusCode).toBe(404);

    await app.inject({ method: 'POST', url: '/calibrate/lens/start', payload: { source: 'real-camera-2', mode: 'verify' } });
    await settle();
    const res = await app.inject({ method: 'GET', url: '/calibrate/lens/result?source=real-camera-2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sourceId: 'real-camera-2', verdict: 'pass' });
  });
});

describe('POST /calibrate/lens/apply', () => {
  const calibFile = (): string => join(dir, 'lens_calibration.json');

  it('표가 있으면 켠다 + restartRequired 를 반드시 알린다', async () => {
    writeFileSync(calibFile(), JSON.stringify({ cameras: [{ id: 'real-camera-2', model: 'cam-001', enabled: false }] }), 'utf8');
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/apply', payload: { source: 'real-camera-2', enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, enabled: true, restartRequired: true });
    expect(JSON.parse(readFileSync(calibFile(), 'utf8')).cameras[0].enabled).toBe(true);
  });

  it('표 없는 카메라 → 400 (조용한 무동작 금지)', async () => {
    writeFileSync(calibFile(), JSON.stringify({ cameras: [] }), 'utf8');
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/apply', payload: { source: 'real-camera-2', enabled: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/보정표가 없습니다/);
  });

  it('enabled 누락 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/calibrate/lens/apply', payload: { source: 'real-camera-2' } });
    expect(res.statusCode).toBe(400);
  });

  it('다른 카메라 항목을 건드리지 않는다', async () => {
    writeFileSync(
      calibFile(),
      JSON.stringify({ cameras: [{ id: 'other', model: 'cam-001', enabled: true }, { id: 'real-camera-2', model: 'cam-001', enabled: false }] }),
      'utf8',
    );
    await app.inject({ method: 'POST', url: '/calibrate/lens/apply', payload: { source: 'real-camera-2', enabled: true } });
    const cams = JSON.parse(readFileSync(calibFile(), 'utf8')).cameras as Array<{ id: string; enabled: boolean }>;
    expect(cams.find((c) => c.id === 'other')!.enabled).toBe(true);
  });
});
