import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerViewerRoutes } from '../src/viewer/routes.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';
import type { LlmModelSelector } from '../src/brain/llmRegistry.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

const viewerCfg = (over: Partial<ToolsConfig['viewer']> = {}): ToolsConfig['viewer'] => ({
  enabled: true,
  allowMove: true,
  defaultFps: 3,
  staticDir: 'web',
  controlToken: '',
  ...over,
});

type ModelRow = ReturnType<LlmModelSelector['listModels']>[number];

/** selectModel 호출 인자를 기록하는 가짜 LlmModelSelector. */
function fakeSelector(opts: { validIds?: string[] } = {}): LlmModelSelector & {
  calls: { selectModel: string[] };
  activeId: string;
} {
  const valid = opts.validIds ?? ['qwen-vl', 'claude-opus'];
  const state = { activeId: 'qwen-vl' };
  const calls = { selectModel: [] as string[] };
  return {
    calls,
    get activeId() {
      return state.activeId;
    },
    listModels(): ModelRow[] {
      return valid.map((id) => ({
        id,
        name: id.toUpperCase(),
        provider: 'openai-compatible',
        model: `${id}-model`,
        active: id === state.activeId,
      }));
    },
    selectModel(id: string) {
      calls.selectModel.push(id);
      if (!valid.includes(id)) return { ok: false };
      state.activeId = id;
      return { ok: true, activeModel: id };
    },
  };
}

async function mkApp(opts: {
  llm?: LlmModelSelector;
  viewer?: Partial<ToolsConfig['viewer']>;
}): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-llm-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const app = Fastify();
  await registerViewerRoutes(app, {
    sources: new Map<string, CameraSource>(),
    viewer: viewerCfg({ staticDir: dir, ...opts.viewer }),
    llm: opts.llm,
  });
  await app.ready();
  return { app, dir };
}

async function withApp(
  opts: Parameters<typeof mkApp>[0],
  fn: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const { app, dir } = await mkApp(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('GET /viewer/api/llm/models', () => {
  it('목록 + 활성 id 반환(무게이트)', async () => {
    const llm = fakeSelector();
    await withApp({ llm, viewer: { controlToken: 'secret' } }, async (app) => {
      const r = await app.inject({ method: 'GET', url: '/viewer/api/llm/models' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.active).toBe('qwen-vl');
      expect(body.models.map((m: ModelRow) => m.id)).toEqual(['qwen-vl', 'claude-opus']);
      // 경계면: active 플래그가 있는 행의 id 가 active 필드와 일치.
      expect(body.models.find((m: ModelRow) => m.active).id).toBe('qwen-vl');
    });
  });
});

describe('POST /viewer/api/llm/select', () => {
  it('유효 id → 200 {ok:true, active}, selectModel(id) 호출', async () => {
    const llm = fakeSelector();
    await withApp({ llm }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/llm/select', payload: { id: 'claude-opus' } });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true, active: 'claude-opus' });
      expect((llm as ReturnType<typeof fakeSelector>).calls.selectModel).toEqual(['claude-opus']);
    });
  });

  it('무효 id → 404 {ok:false}', async () => {
    const llm = fakeSelector();
    await withApp({ llm }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/llm/select', payload: { id: 'nope' } });
      expect(r.statusCode).toBe(404);
      expect(JSON.parse(r.body).ok).toBe(false);
    });
  });

  it('body id 누락 → 400 invalid body(selectModel 미호출)', async () => {
    const llm = fakeSelector();
    await withApp({ llm }, async (app) => {
      const r = await app.inject({ method: 'POST', url: '/viewer/api/llm/select', payload: {} });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe('invalid body');
      expect((llm as ReturnType<typeof fakeSelector>).calls.selectModel.length).toBe(0);
    });
  });

  it('controlToken 설정 + 토큰 불일치 → 403(게이트, selectModel 미호출)', async () => {
    const llm = fakeSelector();
    await withApp({ llm, viewer: { controlToken: 'secret' } }, async (app) => {
      const r = await app.inject({
        method: 'POST',
        url: '/viewer/api/llm/select',
        headers: { 'x-viewer-token': 'wrong' },
        payload: { id: 'claude-opus' },
      });
      expect(r.statusCode).toBe(403);
      expect((llm as ReturnType<typeof fakeSelector>).calls.selectModel.length).toBe(0);
    });
  });

  it('controlToken 설정 + 토큰 일치 → 200', async () => {
    const llm = fakeSelector();
    await withApp({ llm, viewer: { controlToken: 'secret' } }, async (app) => {
      const r = await app.inject({
        method: 'POST',
        url: '/viewer/api/llm/select',
        headers: { 'x-viewer-token': 'secret' },
        payload: { id: 'claude-opus' },
      });
      expect(r.statusCode).toBe(200);
    });
  });
});

describe('llm 미주입(가산 보존)', () => {
  it('llm 없이 등록 → GET models, POST select 미등록(404)', async () => {
    await withApp({}, async (app) => {
      const g = await app.inject({ method: 'GET', url: '/viewer/api/llm/models' });
      expect(g.statusCode).toBe(404);
      const p = await app.inject({ method: 'POST', url: '/viewer/api/llm/select', payload: { id: 'x' } });
      expect(p.statusCode).toBe(404);
    });
  });
});
