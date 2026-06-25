import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildViewerServer } from '../src/server.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';

/**
 * 검증자(qa-tester): /viewer/api/capture/* 프록시 (G5).
 * mappingProxy 패턴 — 200/400/409 패스스루 + 5xx→502 + unreachable→502.
 * 경계면: GET status/runs/runs:id/aggregate, POST start/stop/finalize 의 메서드·경로·본문 전달.
 */

const emptySources = (): Map<string, CameraSource> => new Map();
const viewerCfg = () => ({ enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' });

let upstream: Server;
let upstreamUrl: string;
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

let app: FastifyInstance | undefined;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });

function mk() {
  app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: upstreamUrl });
  return app;
}

describe('GET /viewer/api/capture/status 패스스루', () => {
  it('200 → JSON 패스스루(경로 /capture/status)', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/capture/status');
      expect(req.method).toBe('GET');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ state: 'running', done: 2, planned: 5 }));
    };
    const r = await mk().inject({ method: 'GET', url: '/viewer/api/capture/status' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ state: 'running', done: 2, planned: 5 });
  });

  it('5xx → 502', async () => {
    handler = (_req, res) => { res.statusCode = 500; res.end('boom'); };
    const r = await mk().inject({ method: 'GET', url: '/viewer/api/capture/status' });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body).error).toContain('capture upstream HTTP 500');
  });

  it('미가동(연결 불가) → 502 unreachable', async () => {
    app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: 'http://127.0.0.1:1' });
    const r = await app.inject({ method: 'GET', url: '/viewer/api/capture/status' });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body)).toEqual({ error: 'capture upstream unreachable' });
  });
});

describe('GET /viewer/api/capture/runs·aggregate', () => {
  it('runs → 200 패스스루', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/capture/runs');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 1, plannedCount: 5 }]));
    };
    const r = await mk().inject({ method: 'GET', url: '/viewer/api/capture/runs' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)[0].id).toBe(1);
  });

  it('runs/:id/aggregate → 경로 :id 치환 후 패스스루', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/capture/runs/7/aggregate'); // :id=7 치환
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ presetKey: '1:1', clusterId: 1 }]));
    };
    const r = await mk().inject({ method: 'GET', url: '/viewer/api/capture/runs/7/aggregate' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)[0].presetKey).toBe('1:1');
  });

  it('aggregate 404 → 404 패스스루', async () => {
    handler = (_req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: 'run not found' })); };
    const r = await mk().inject({ method: 'GET', url: '/viewer/api/capture/runs/9/aggregate' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'run not found' });
  });
});

describe('POST /viewer/api/capture/start (본문 전달·409 패스스루)', () => {
  it('start → 200, body JSON 전달(경로 /capture/start)', async () => {
    handler = (req, res, body) => {
      expect(req.url).toBe('/capture/start');
      expect(req.method).toBe('POST');
      expect(JSON.parse(body)).toEqual({ count: 5 }); // 본문 패스스루
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, runId: 3 }));
    };
    const r = await mk().inject({ method: 'POST', url: '/viewer/api/capture/start', payload: { count: 5 } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).runId).toBe(3);
  });

  it('409(중복 시작) → 409 + 본문 패스스루', async () => {
    handler = (_req, res) => { res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'capture already running' })); };
    const r = await mk().inject({ method: 'POST', url: '/viewer/api/capture/start', payload: { count: 5 } });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toContain('already running');
  });

  it('400(잘못된 body) → 400 패스스루', async () => {
    handler = (_req, res) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'invalid body' })); };
    const r = await mk().inject({ method: 'POST', url: '/viewer/api/capture/start', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toContain('invalid body');
  });
});

describe('POST /viewer/api/capture/stop·finalize', () => {
  it('stop 400(not running) → 400 패스스루', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/capture/stop');
      res.statusCode = 400; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'not running' }));
    };
    const r = await mk().inject({ method: 'POST', url: '/viewer/api/capture/stop' });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toContain('not running');
  });

  it('finalize 200 → 패스스루', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/capture/finalize');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, slots: 4, globalCount: 4 }));
    };
    const r = await mk().inject({ method: 'POST', url: '/viewer/api/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).slots).toBe(4);
  });

  it('finalize 409(아직 running) → 409 패스스루', async () => {
    handler = (_req, res) => { res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'capture still running' })); };
    const r = await mk().inject({ method: 'POST', url: '/viewer/api/capture/finalize', payload: {} });
    expect(r.statusCode).toBe(409);
  });
});

describe('기존 /viewer/api/mapping 프록시 회귀(capture 가산 후)', () => {
  it('mapping 200 → 패스스루(capture 프록시 추가가 mapping 을 깨지 않음)', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/mapping');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ slots: [], globalIndex: [] }));
    };
    const r = await mk().inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toHaveProperty('slots');
  });
});
