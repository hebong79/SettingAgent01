import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { CameraApiError } from '../clients/CameraClient.js';
import type { CameraSource } from './CameraSource.js';
import type { CRpcClient } from '../clients/CRpcClient.js';
import type { LlmModelSelector } from '../brain/llmRegistry.js';
import { parseCameraViews } from '../setup/mapTargets.js';
import { writeCamerapos } from '../setup/cameraposWriter.js';
import { StreamAdapterError } from '../stream/StreamAdapter.js';

export interface ViewerDeps {
  sources: Map<string, CameraSource>;
  viewer: ToolsConfig['viewer'];
  /** Unity JSON-RPC 프록시 클라이언트. 주입 시에만 /viewer/api/rpc* 라우트 등록(가산·graceful). */
  rpc?: CRpcClient;
  /** 런타임 LLM 모델 선택기(AgentRuntime). 주입 시에만 /viewer/api/llm/* 라우트 등록(가산). */
  llm?: LlmModelSelector;
  /** 카메라 PTZ 프리셋 파일(camerapos.json) 경로. 주입 시에만 /viewer/api/camerapos GET/PUT 등록(가산). */
  cameraposFile?: string;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 36;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const CamerasQuery = z.object({ source: z.string().optional() });
const PtzQuery = z.object({
  source: z.string().optional(),
  cam: z.coerce.number().int().positive(),
});

/** 동시 스트림 상한(스펙 고정값, 설계서 §8 가정 A3). */
const MAX_STREAMS = 4;

const StreamQuery = z.object({
  source: z.string().optional(),
  cam: z.coerce.number().int().positive(),
  preset: z.coerce.number().int().positive(),
  // 수동 PTZ override(루프3). 제공 시 Unity /stream 이 그 각도를 프레임마다 렌더. 미제공 시 preset 기본.
  pan: z.coerce.number().optional(),
  tilt: z.coerce.number().optional(),
  zoom: z.coerce.number().optional(),
});

const SnapshotQuery = z.object({
  source: z.string().optional(),
  cam: z.coerce.number().int().positive(),
  preset: z.coerce.number().int().positive(),
  mode: z.enum(['preset', 'manual']),
  pan: z.coerce.number().optional(),
  tilt: z.coerce.number().optional(),
  zoom: z.coerce.number().optional(),
  t: z.coerce.number().optional(),
});

const MoveBody = z.object({
  source: z.string().optional(),
  cam: z.number().int().positive(),
  pan: z.number(),
  tilt: z.number(),
  zoom: z.number(),
});

const LoginBody = z.object({
  source: z.string().min(1),
  user: z.string(),
  pass: z.string(),
});

/** Unity RPC 프록시 body. params 는 객체(Record)만 지원(CRpcClient.callRpc 계약과 정합). */
const RpcBody = z.object({
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

/** 런타임 LLM 모델 전환 body. */
const LlmSelectBody = z.object({ id: z.string().min(1) });

/** 카메라 PTZ 프리셋 저장 body(정규화 views[]). 파일 원본 중첩 포맷은 writeCamerapos 가 생성. */
const CameraposBody = z.object({
  views: z.array(
    z.object({
      camIdx: z.number().int().positive(),
      presetIdx: z.number().int().positive(),
      label: z.string(),
      pan: z.number(),
      tilt: z.number(),
      zoom: z.number(),
    }),
  ),
});

/**
 * 뷰어 라우트 등록(설계서 §6.2).
 * 라우트 순서 필수: /viewer/api/* (정확 경로) 먼저 → @fastify/static (와일드카드) 나중.
 */
export async function registerViewerRoutes(app: FastifyInstance, deps: ViewerDeps): Promise<void> {
  const { sources, viewer, rpc, llm, cameraposFile } = deps;

  /** 진행 중 스트림 수(우리 프록시 계층 카운터, 수용기준 4). */
  let activeStreams = 0;

  /** source 쿼리 → CameraSource. 미지정 시 첫 소스. */
  const pickSource = (id?: string): CameraSource | undefined => {
    if (id) return sources.get(id);
    return sources.values().next().value;
  };

  app.get('/viewer/api/cameras', async (req, reply) => {
    const parsed = CamerasQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid query', detail: parsed.error.flatten() };
    }
    const source = pickSource(parsed.data.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    try {
      return await source.listCameras();
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  /** 장비가 보고하는 현재 PTZ 조회. 실카메라 제어 UI의 상태 동기화에만 사용한다. */
  app.get('/viewer/api/ptz', async (req, reply) => {
    const parsed = PtzQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid query', detail: parsed.error.flatten() };
    }
    const source = pickSource(parsed.data.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    if (!source.getPtz) {
      reply.code(501);
      return { error: 'ptz state unsupported', code: 'PTZ_STATE_UNSUPPORTED' };
    }
    try {
      return { ptz: await source.getPtz(parsed.data.cam) };
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  app.get('/viewer/api/snapshot', async (req, reply) => {
    const parsed = SnapshotQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid query', detail: parsed.error.flatten() };
    }
    const q = parsed.data;
    const source = pickSource(q.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    try {
      const opt =
        q.mode === 'manual'
          ? {
              mode: 'manual' as const,
              presetIdx: q.preset,
              ptz: { pan: q.pan ?? 0, tilt: q.tilt ?? 0, zoom: clampZoom(q.zoom ?? ZOOM_MIN) },
            }
          : { mode: 'preset' as const, presetIdx: q.preset };
      const result = await source.snapshot(q.cam, opt);
      reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'no-store')
        .header('X-PTZ-Pan', String(result.ptz.pan))
        .header('X-PTZ-Tilt', String(result.ptz.tilt))
        .header('X-PTZ-Zoom', String(result.ptz.zoom));
      return reply.send(result.jpeg);
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  app.get('/viewer/api/stream', async (req, reply) => {
    const parsed = StreamQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid query', detail: parsed.error.flatten() };
    }
    const q = parsed.data;
    const source = pickSource(q.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    // 스트림 미지원 소스 → 501 → 프론트가 폴링으로 폴백. 실카메라는 RTSP adapter를 사용한다.
    if (!source.streamMjpeg) {
      reply.code(501);
      return { error: 'stream unsupported', code: 'STREAM_UNSUPPORTED' };
    }
    // 로컬 선차단(수용기준 4): 상한 초과면 상류 연결 없이 즉시 503.
    if (activeStreams >= MAX_STREAMS) {
      reply.code(503);
      return { error: 'too many streams', code: 'TOO_MANY_STREAMS' };
    }

    const ac = new AbortController();
    // 클라 disconnect → 상류 fetch 중단(수용기준 3).
    reply.raw.on('close', () => ac.abort());

    // pan/tilt/zoom 이 모두 있으면 수동 PTZ override 전달(루프3), 아니면 preset 기본.
    const ptz =
      q.pan !== undefined && q.tilt !== undefined && q.zoom !== undefined
        ? { pan: q.pan, tilt: q.tilt, zoom: clampZoom(q.zoom) }
        : undefined;
    const it = source.streamMjpeg(q.cam, q.preset, ac.signal, ptz);
    // 첫 프레임/에러를 헤더 전송 전에 판정(503 전파를 위해).
    let first: IteratorResult<Buffer>;
    try {
      first = await it.next();
    } catch (err) {
      if (err instanceof CameraApiError && err.httpStatus === 503) {
        reply.code(503);
        return { error: err.message, code: 'TOO_MANY_STREAMS' };
      }
      reply.code(502);
      if (err instanceof StreamAdapterError) return { error: err.message, code: err.code };
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }

    activeStreams++; // 실제 연결 성립 후 카운트.
    reply.hijack(); // Fastify 응답 위임(raw 직접 제어).
    reply.raw.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    const writeFrame = (jpeg: Buffer): void => {
      reply.raw.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      reply.raw.write(jpeg);
      reply.raw.write('\r\n');
    };
    try {
      if (!first.done) writeFrame(first.value);
      for await (const f of it) writeFrame(f);
    } catch {
      // abort/상류 종료 무시(정상 종료 경로).
    } finally {
      activeStreams--;
      reply.raw.end();
    }
  });

  app.post('/viewer/api/move', async (req, reply) => {
    if (viewer.allowMove === false) {
      reply.code(403);
      return { error: 'move disabled' };
    }
    if (viewer.controlToken && req.headers['x-viewer-token'] !== viewer.controlToken) {
      reply.code(403);
      return { error: 'invalid token' };
    }
    const parsed = MoveBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const b = parsed.data;
    const source = pickSource(b.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    try {
      const ok = await source.move(b.cam, { pan: b.pan, tilt: b.tilt, zoom: clampZoom(b.zoom) });
      return { ok };
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  });

  app.post('/viewer/api/camera/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const source = pickSource(parsed.data.source);
    if (!source) {
      reply.code(400);
      return { error: 'source not found' };
    }
    if (!source.login) {
      reply.code(400);
      return { error: 'login unsupported' };
    }
    try {
      // 자격증명은 통과만 — 응답/로그에 노출하지 않는다.
      const ok = await source.login(parsed.data.user, parsed.data.pass);
      return { ok };
    } catch {
      reply.code(502);
      return { error: 'login failed' };
    }
  });

  // ── 스트림 1: Unity JSON-RPC 프록시(방식 B). rpc 주입 시에만 등록(가산·graceful). ──
  // 브라우저 → 13020 → Unity 13110 단순 패스스루(결정형 제어 평면).
  if (rpc) {
    app.post('/viewer/api/rpc', async (req, reply) => {
      // 변이 게이트: controlToken 설정 시 x-viewer-token 일치 필요(/move 와 동일 선택 게이트).
      if (viewer.controlToken && req.headers['x-viewer-token'] !== viewer.controlToken) {
        reply.code(403);
        return { error: 'invalid token' };
      }
      const parsed = RpcBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid body', detail: parsed.error.flatten() };
      }
      try {
        const result = await rpc.callRpc(parsed.data.method, parsed.data.params);
        return { ok: true, result };
      } catch (err) {
        reply.code(502);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // RPC 카탈로그(읽기 — 무게이트, method 드롭다운 로딩용).
    app.get('/viewer/api/rpc/catalog', async (_req, reply) => {
      try {
        return await rpc.getCatalog();
      } catch (err) {
        reply.code(502);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  // ── 스트림 2: 런타임 LLM 모델 전환. llm(selector) 주입 시에만 등록(가산). ──
  // 메모리 전환(재시작 없이) — 재시작 시 config activeModel 로 복귀(파일 미기록).
  if (llm) {
    app.get('/viewer/api/llm/models', async () => {
      const models = llm.listModels();
      return { models, active: models.find((m) => m.active)?.id };
    });

    app.post('/viewer/api/llm/select', async (req, reply) => {
      // 변이 게이트: controlToken 설정 시 x-viewer-token 일치 필요.
      if (viewer.controlToken && req.headers['x-viewer-token'] !== viewer.controlToken) {
        reply.code(403);
        return { error: 'invalid token' };
      }
      const parsed = LlmSelectBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid body', detail: parsed.error.flatten() };
      }
      const r = llm.selectModel(parsed.data.id);
      if (!r.ok) {
        reply.code(404);
        return { ok: false, error: 'unknown model id' };
      }
      return { ok: true, active: r.activeModel };
    });
  }

  // ── 카메라 PTZ 프리셋(camerapos.json) 편집. cameraposFile 주입 시에만 등록(가산). ──
  // GET(무게이트, 읽기): 파일 → 정규화 views[]. PUT(controlToken 게이트): 전체 파일 저장(왕복 호환).
  if (cameraposFile) {
    app.get('/viewer/api/camerapos', async () => {
      if (!existsSync(cameraposFile)) return { views: [] };
      try {
        return { views: parseCameraViews(JSON.parse(readFileSync(cameraposFile, 'utf-8'))) };
      } catch {
        return { views: [] };
      }
    });

    app.put('/viewer/api/camerapos', async (req, reply) => {
      // 변이 게이트: controlToken 설정 시 x-viewer-token 일치 필요(/move 와 동일 선택 게이트).
      if (viewer.controlToken && req.headers['x-viewer-token'] !== viewer.controlToken) {
        reply.code(403);
        return { error: 'invalid token' };
      }
      const parsed = CameraposBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid body', detail: parsed.error.flatten() };
      }
      // 서버측 zoom clamp(1~36) — writeCamerapos 로 전체 파일 기록(중첩 포맷 생성).
      const views = parsed.data.views.map((v) => ({ ...v, zoom: clampZoom(v.zoom) }));
      writeCamerapos(views, cameraposFile);
      return { ok: true, count: views.length };
    });
  }

  app.get('/viewer/api/health', async () => ({
    status: 'ok',
    sources: [...sources.keys()],
    sourceDetails: [...sources.entries()].map(([id, source]) => ({ id, kind: source.kind, streamTransport: source.streamTransport })),
  }));

  // GET /viewer → /viewer/ (트레일링 슬래시) redirect.
  app.get('/viewer', async (_req, reply) => reply.redirect('/viewer/'));

  // 정적 SPA 서빙(와일드카드) — 반드시 API 라우트 등록 뒤에.
  // 캐시 무효화(루프4): 코드 변경 후 하드새로고침 없이 최신 자산을 로드하도록 모든 정적 응답에 no-store.
  await app.register(fastifyStatic, {
    root: resolve(viewer.staticDir),
    prefix: '/viewer/',
    redirect: true,
    cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  });
}
