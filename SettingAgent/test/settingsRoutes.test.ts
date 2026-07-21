import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SetupOrchestrator } from '../src/setup/SetupOrchestrator.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { Repository } from '../src/store/Repository.js';
import type { SetupArtifact } from '../src/domain/types.js';
import type { SettingsPaths } from '../src/config/settingsStore.js';

/**
 * 검증자(qa-tester): /settings REST (fastify.inject).
 * GET /settings 200 + shape(키 값 미포함), PUT /settings 유효→{ok,restartRequired:true} / 무효→400+detail.
 * 임시 config 사본만 사용(원본 훼손 금지). 라우트는 항상 등록(결정형 I/O).
 *
 * 경계면 교차: GET 응답 shape 이 프론트 소비(app.js loadSettings)의 필드명과 일치하는지 확인.
 *   loadSettings 는 s.llm.{provider,model,baseUrl,apiKeyEnv}, s.vpd/lpd.{endpoint,detPath,apiKeyEnv} 소비.
 */

const setupCfg = {
  presetSettleMs: 0, betweenPresetMs: 0, minConfidence: 0.5, roiPadding: 0, yBandTolerance: 0.1,
  accumFrames: 1, accumIntervalMs: 0, clusterDist: 0.06, clusterMinSupport: 1, lpdEnabled: false,
};
const fakeCamera = () => ({ health: async () => true, requestImage: async () => ({}) } as unknown as CameraClient);
const fakeVpd = () => ({ health: async () => true, detect: async () => [] } as unknown as VpdClient);
const fakeRepo = (): Repository => {
  const saved: SetupArtifact[] = [];
  return { saveArtifact: (a: SetupArtifact) => saved.push(a), loadArtifact: () => saved.at(-1) ?? null, path: 'mem' } as unknown as Repository;
};

function seedLlm() {
  return {
    _comment: '보존 주석',
    llm: { provider: 'openai-compatible', model: 'M', baseUrl: 'http://a:1/v1', apiKeyEnv: 'LLM_API_KEY', temperature: 0.1, maxTokens: 3072, enabled: true },
    mcp: { enabled: true },
  };
}
function seedTools() {
  return {
    _comment: 'tools 주석',
    camera: { baseUrl: 'http://localhost:13100' },
    cameraRuntime: { executionMode: 'typescript-native', selectedCameraId: 'simulator-1' },
    cameraSources: [
      { id: 'simulator-1', label: '시뮬레이터 1', kind: 'sim', protocol: 'unity-rpc', baseUrl: 'http://localhost:13110', username: '', password: '', rtspUrl: '' },
      { id: 'real-camera-1', label: '리얼 카메라 1', kind: 'hucoms', protocol: 'hucoms-v1.22', baseUrl: 'http://10.0.0.20', username: 'admin', password: 'camera-secret', rtspUrl: 'rtsp://10.0.0.20/stream1', ptz: { panRange: [0, 35999] } },
    ],
    vpd: { endpoint: 'http://v:1', detPath: '/vpd', apiKeyEnv: 'VPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
    lpd: { endpoint: 'http://l:1', detPath: '/lpd', apiKeyEnv: 'LPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
  };
}

let dir: string;
let paths: SettingsPaths;
let app: FastifyInstance | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-routes-'));
  paths = { llmPath: join(dir, 'llm.config.json'), toolsPath: join(dir, 'tools.config.json') };
  writeFileSync(paths.llmPath, JSON.stringify(seedLlm(), null, 2), 'utf-8');
  writeFileSync(paths.toolsPath, JSON.stringify(seedTools(), null, 2), 'utf-8');
});

afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  rmSync(dir, { recursive: true, force: true });
});

function makeServer() {
  const repo = fakeRepo();
  const orchestrator = new SetupOrchestrator({ camera: fakeCamera(), vpd: fakeVpd(), repo, cfg: setupCfg, sleep: async () => {}, now: () => 'T' });
  return buildServer({ orchestrator, repo, camera: fakeCamera(), vpd: fakeVpd(), settingsPaths: paths });
}

describe('GET /settings', () => {
  it('200 + 편집 대상 shape(프론트 loadSettings 필드명 일치)', async () => {
    app = makeServer();
    const r = await app.inject({ method: 'GET', url: '/settings' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    // 프론트(app.js loadSettings)가 소비하는 필드명과 정확히 일치해야 한다.
    expect(body).toEqual({
      llm: { provider: 'openai-compatible', model: 'M', baseUrl: 'http://a:1/v1', apiKeyEnv: 'LLM_API_KEY' },
      vpd: { endpoint: 'http://v:1', detPath: '/vpd', apiKeyEnv: 'VPD_API_KEY' },
      lpd: { endpoint: 'http://l:1', detPath: '/lpd', apiKeyEnv: 'LPD_API_KEY' },
      camera: {
        executionMode: 'typescript-native',
        selectedCameraId: 'simulator-1',
        sources: [
          { id: 'simulator-1', label: '시뮬레이터 1', kind: 'sim', protocol: 'unity-rpc', baseUrl: 'http://localhost:13110', username: '', rtspUrl: '', passwordSet: false },
          { id: 'real-camera-1', label: '리얼 카메라 1', kind: 'hucoms', protocol: 'hucoms-v1.22', baseUrl: 'http://10.0.0.20', username: 'admin', rtspUrl: 'rtsp://10.0.0.20/stream1', passwordSet: true },
        ],
      },
    });
  });

  it('키 값(process.env) 미노출 — apiKeyEnv 이름만', async () => {
    const SECRET = 'ROUTES-SECRET-VALUE';
    const prev = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = SECRET;
    try {
      app = makeServer();
      const r = await app.inject({ method: 'GET', url: '/settings' });
      expect(r.body).not.toContain(SECRET);
      expect(JSON.parse(r.body).llm.apiKeyEnv).toBe('LLM_API_KEY');
    } finally {
      if (prev === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prev;
    }
  });
});

describe('PUT /settings', () => {
  it('유효 patch → 200 {ok:true, restartRequired:true} + 파일 반영', async () => {
    app = makeServer();
    const r = await app.inject({
      method: 'PUT', url: '/settings',
      payload: { llm: { model: 'updated' }, vpd: { endpoint: 'http://new:1234' } },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, restartRequired: true });
    // 왕복: 재조회 시 반영
    const g = await app.inject({ method: 'GET', url: '/settings' });
    const s = JSON.parse(g.body);
    expect(s.llm.model).toBe('updated');
    expect(s.vpd.endpoint).toBe('http://new:1234');
    expect(s.llm.apiKeyEnv).toBe('LLM_API_KEY'); // 키 이름 보존
  });

  it('무효 patch(잘못된 URL) → 400 + detail', async () => {
    app = makeServer();
    const r = await app.inject({ method: 'PUT', url: '/settings', payload: { vpd: { endpoint: 'bogus' } } });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.error).toBe('invalid body');
    expect(body.detail).toBeDefined();
  });

  it('카메라 선택·연결정보 저장 → 비밀번호 GET 미노출 + 기존 ptz 보존', async () => {
    app = makeServer();
    const r = await app.inject({
      method: 'PUT', url: '/settings',
      payload: {
        camera: {
          executionMode: 'typescript-native',
          selectedCameraId: 'real-camera-1',
          source: {
            id: 'real-camera-1', label: '입구 Hucoms', kind: 'hucoms', protocol: 'hucoms-v1.22',
            baseUrl: 'http://10.0.0.21:80', username: 'operator', password: 'new-secret',
            rtspUrl: 'rtsp://10.0.0.21:554/stream1',
          },
        },
      },
    });
    expect(r.statusCode).toBe(200);
    const raw = JSON.parse(readFileSync(paths.toolsPath, 'utf-8'));
    expect(raw.cameraRuntime.selectedCameraId).toBe('real-camera-1');
    expect(raw.cameraSources[1].password).toBe('new-secret');
    expect(raw.cameraSources[1].ptz).toEqual({ panRange: [0, 35999] });

    const get = await app.inject({ method: 'GET', url: '/settings' });
    expect(get.body).not.toContain('new-secret');
    expect(JSON.parse(get.body).camera.sources[1].passwordSet).toBe(true);
  });

  it('허용 밖 섹션(lpr) → 400 (strict)', async () => {
    app = makeServer();
    const r = await app.inject({ method: 'PUT', url: '/settings', payload: { lpr: { endpoint: 'http://x:1', detPath: '/lpr' } } });
    expect(r.statusCode).toBe(400);
  });

  it('빈 body → 200 (patch 없음, no-op)', async () => {
    app = makeServer();
    const r = await app.inject({ method: 'PUT', url: '/settings', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, restartRequired: true });
  });
});
