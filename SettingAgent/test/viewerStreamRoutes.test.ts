import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerViewerRoutes } from '../src/viewer/routes.js';
import type { CameraSource, SnapshotOpts, Ptz } from '../src/viewer/CameraSource.js';
import { CameraApiError } from '../src/clients/CameraClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

function jpeg(payload: number[]): Buffer {
  return Buffer.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);
}

const viewerCfg = (over: Partial<ToolsConfig['viewer']> = {}): ToolsConfig['viewer'] => ({
  enabled: true,
  allowMove: true,
  defaultFps: 3,
  staticDir: 'web',
  controlToken: '',
  ...over,
});

/** streamMjpeg 동작을 주입 가능한 최소 가짜 소스. */
function streamSource(
  streamImpl?: (cam: number, preset: number, signal: AbortSignal) => AsyncGenerator<Buffer>,
): CameraSource {
  const src: CameraSource = {
    kind: 'sim',
    async listCameras() {
      return { cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [] }] };
    },
    async snapshot(_cam: number, _opt: SnapshotOpts) {
      return { jpeg: Buffer.from([0xff, 0xd8]), ptz: { pan: 0, tilt: 0, zoom: 1 } };
    },
    async move(_cam: number, _ptz: Ptz) {
      return true;
    },
    toNativePtz: (p: Ptz) => p,
    fromNativePtz: (n: unknown) => n as Ptz,
  };
  if (streamImpl) src.streamMjpeg = streamImpl;
  return src;
}

async function mkApp(sources: Map<string, CameraSource>): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-stream-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const app = Fastify();
  await registerViewerRoutes(app, { sources, viewer: viewerCfg({ staticDir: dir }) });
  await app.ready();
  return { app, dir };
}

/** 실제 listen 서버 기동 후 base URL 반환(hijack 스트림 검증용). */
async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

/** 완결되는 응답 전체를 받는다(정상 종료 스트림·JSON 용). */
function getFull(url: string): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

/** 열어두는 요청: 첫 data(200) 또는 완결(비200) 시점에 resolve. destroy() 로 클라 disconnect 모사. */
function openStream(url: string): Promise<{ status: number; res: IncomingMessage; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status, res, destroy: () => req.destroy() }));
        return;
      }
      const onData = () => {
        res.off('data', onData);
        resolve({ status, res, destroy: () => req.destroy() });
      };
      res.on('data', onData);
    });
    req.on('error', reject);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GET /viewer/api/stream — 사전판정(inject, hijack 이전 JSON 경로)', () => {
  it('쿼리 누락(cam 없음) → 400', async () => {
    const { app, dir } = await mkApp(new Map([['sim', streamSource(async function* () {})]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/stream?preset=1' });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cam=0(비양수) → 400', async () => {
    const { app, dir } = await mkApp(new Map([['sim', streamSource(async function* () {})]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/stream?cam=0&preset=1' });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('미존재 source → 400', async () => {
    const { app, dir } = await mkApp(new Map([['sim', streamSource(async function* () {})]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/stream?source=nope&cam=1&preset=1' });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toContain('source');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('스트림 미지원 소스(streamMjpeg 없음) → 501 STREAM_UNSUPPORTED', async () => {
    const { app, dir } = await mkApp(new Map([['sim', streamSource(/* no streamImpl */)]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/stream?cam=1&preset=1' });
      expect(r.statusCode).toBe(501);
      expect(JSON.parse(r.body).code).toBe('STREAM_UNSUPPORTED');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('상류 503 전파(첫 next 에서 CameraApiError 503) → 503 TOO_MANY_STREAMS', async () => {
    const src = streamSource(async function* () {
      throw new CameraApiError('TOO_MANY_STREAMS', 'stream 상한 초과', 503);
    });
    const { app, dir } = await mkApp(new Map([['sim', src]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/stream?cam=1&preset=1' });
      expect(r.statusCode).toBe(503);
      expect(JSON.parse(r.body).code).toBe('TOO_MANY_STREAMS');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('상류 일반 오류(첫 next throw) → 502', async () => {
    const src = streamSource(async function* () {
      throw new CameraApiError('INTERNAL', 'stream 연결 실패: 500', 500);
    });
    const { app, dir } = await mkApp(new Map([['sim', src]]));
    try {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/stream?cam=1&preset=1' });
      expect(r.statusCode).toBe(502);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /viewer/api/stream — hijack 멀티파트(실 listen 서버)', () => {
  it('프레임 2개 → 200 multipart/x-mixed-replace; boundary=frame, 본문에 --frame/헤더/JPEG 포함', async () => {
    const f1 = jpeg([0x01, 0x02, 0x03]);
    const f2 = jpeg([0xaa, 0xbb]);
    const src = streamSource(async function* () {
      yield f1;
      yield f2;
    });
    const { app, dir } = await mkApp(new Map([['sim', src]]));
    try {
      const base = await listen(app);
      const r = await getFull(`${base}/viewer/api/stream?cam=1&preset=1`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('multipart/x-mixed-replace; boundary=frame');
      expect(r.headers['cache-control']).toBe('no-store');
      const text = r.body.toString('latin1');
      expect(text).toContain('--frame');
      expect(text).toContain('Content-Type: image/jpeg');
      expect(text).toContain(`Content-Length: ${f1.length}`);
      // 프레임 JPEG 바이트가 본문에 그대로 포함(순서대로 2개).
      expect(r.body.includes(f1)).toBe(true);
      expect(r.body.includes(f2)).toBe(true);
      // 경계 프리앰블 다음 첫 프레임 배치 확인.
      const firstBoundary = r.body.indexOf(Buffer.from('--frame'));
      expect(firstBoundary).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('동시 상한 4: 4개 점유 후 5번째 → 503 TOO_MANY_STREAMS; 해제 후 카운터 복구', async () => {
    // yield 1개 후 abort 까지 대기 → 슬롯 점유.
    const src = streamSource(async function* (_cam, _preset, signal) {
      yield jpeg([0x01]);
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve());
      });
    });
    const { app, dir } = await mkApp(new Map([['sim', src]]));
    try {
      const base = await listen(app);
      const url = `${base}/viewer/api/stream?cam=1&preset=1`;

      // 4개 열어 슬롯 점유(각 첫 data 수신 = activeStreams++ 완료).
      const held = await Promise.all([openStream(url), openStream(url), openStream(url), openStream(url)]);
      for (const h of held) expect(h.status).toBe(200);

      // 5번째 → 로컬 선차단 503.
      const fifth = await getFull(url);
      expect(fifth.status).toBe(503);
      expect(JSON.parse(fifth.body.toString()).code).toBe('TOO_MANY_STREAMS');

      // 1개 해제(클라 disconnect → abort → generator 종료 → activeStreams--).
      held[0].destroy();
      // 카운터 감소가 서버측에 반영될 시간을 준 뒤 폴링 재시도.
      let recovered: { status: number; res: IncomingMessage; destroy: () => void } | null = null;
      for (let i = 0; i < 40; i++) {
        await delay(25);
        const attempt = await openStream(url);
        if (attempt.status === 200) {
          recovered = attempt;
          break;
        }
        // 아직 503 이면 재시도.
      }
      expect(recovered?.status).toBe(200);

      // 정리: 열린 스트림 모두 종료.
      recovered?.destroy();
      for (let i = 1; i < held.length; i++) held[i].destroy();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('클라 disconnect → generator 에 전달된 signal.aborted=true(상류 중단 연쇄)', async () => {
    let capturedSignal: AbortSignal | null = null;
    const src = streamSource(async function* (_cam, _preset, signal) {
      capturedSignal = signal;
      yield jpeg([0x01]);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    });
    const { app, dir } = await mkApp(new Map([['sim', src]]));
    try {
      const base = await listen(app);
      const h = await openStream(`${base}/viewer/api/stream?cam=1&preset=1`);
      expect(h.status).toBe(200);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);
      h.destroy(); // 클라 연결 종료.
      // reply.raw 'close' → ac.abort() 전파 대기.
      for (let i = 0; i < 40 && !capturedSignal!.aborted; i++) await delay(25);
      expect(capturedSignal!.aborted).toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
