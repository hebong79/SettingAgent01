import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildViewerServer } from '../src/server.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';

/** /mapping 프록시만 검증하므로 빈 소스 레지스트리로 충분(snapshot/move 미사용). */
const emptySources = (): Map<string, CameraSource> => new Map();

const viewerCfg = () => ({ enabled: true, allowMove: true, defaultFps: 3, staticDir: 'web', controlToken: '' });

/** SettingAgent /mapping 응답을 흉내내는 stub. handler 로 케이스별 응답 주입. */
let upstream: Server;
let upstreamUrl: string;
let handler: (url: string, res: import('node:http').ServerResponse) => void;

beforeAll(async () => {
  upstream = createServer((req, res) => handler(req.url ?? '', res));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('/viewer/api/mapping 프록시', () => {
  it('SettingAgent 200 → SetupArtifact JSON 패스스루', async () => {
    handler = (url, res) => {
      expect(url).toBe('/mapping');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ slots: [{ slotId: 's-1' }], globalIndex: [] }));
    };
    app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: upstreamUrl });
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(body.slots[0].slotId).toBe('s-1');
  });

  it('SettingAgent 404(산출물 없음) → 404 패스스루', async () => {
    handler = (_url, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'no setup artifact' }));
    };
    app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: upstreamUrl });
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'no setup artifact' });
  });

  it('SettingAgent 5xx → 502', async () => {
    handler = (_url, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: upstreamUrl });
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body).error).toContain('mapping upstream HTTP 500');
  });

  it('SettingAgent 미가동(연결 불가) → 502 unreachable', async () => {
    // 사용 중이지 않은 포트로 향하게 해 연결 실패를 유발.
    app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: 'http://127.0.0.1:1' });
    const r = await app.inject({ method: 'GET', url: '/viewer/api/mapping' });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body)).toEqual({ error: 'mapping upstream unreachable' });
  });

  // 검증자 보강: upstream 이 응답하지 않아 fetchWithTimeout(5000ms) 의 AbortController 가
  // 발화하는 경로. unreachable 과 동일 catch 분기(502 unreachable)임을 명시적으로 커버한다.
  // (응답을 영영 보내지 않는 핸들러로 abort 를 유도. 5s 타임아웃 대기는 길어 fake timers 사용.)
  it('SettingAgent 무응답(타임아웃) → 502 unreachable', async () => {
    let hung: import('node:http').ServerResponse | undefined;
    handler = (_url, res) => {
      hung = res; // 의도적으로 응답하지 않아 클라이언트 타임아웃 유발
    };
    vi.useFakeTimers();
    try {
      app = buildViewerServer({ sources: emptySources(), viewer: viewerCfg(), settingAgentUrl: upstreamUrl });
      const injectP = app.inject({ method: 'GET', url: '/viewer/api/mapping' });
      // fetchWithTimeout 의 5000ms setTimeout 을 발화시켜 AbortController.abort() 유도.
      await vi.advanceTimersByTimeAsync(5000);
      const r = await injectP;
      expect(r.statusCode).toBe(502);
      expect(JSON.parse(r.body)).toEqual({ error: 'mapping upstream unreachable' });
    } finally {
      vi.useRealTimers();
      hung?.end(); // 매달린 소켓 정리
    }
  });
});
