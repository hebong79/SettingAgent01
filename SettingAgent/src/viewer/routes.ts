import type { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { CameraApiError } from '../clients/CameraClient.js';
import type { CameraSource } from './CameraSource.js';
import { parseOr400, sendJpeg } from '../api/routeHelpers.js';
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

/** source id → CameraSource. 미지정 시 첫 소스(뷰어 라우트 공통 규약). */
function pickSource(sources: Map<string, CameraSource>, id?: string): CameraSource | undefined {
  if (id) return sources.get(id);
  return sources.values().next().value;
}

/**
 * 카메라 GET 핸들러 공통 스캐폴드(설계서 §4.2) — 파일내 비export 고차함수.
 * 쿼리 검증 실패→400('invalid query'), 소스 해석 실패→400('source not found'),
 * 핸들러 내 throw 된 CameraApiError→502 를 래퍼가 흡수한다. 핸들러는 (parsed, source, req, reply)만 처리.
 * 502 응답 본문은 기존 문자열 그대로(`err instanceof CameraApiError ? err.message : String(err)`).
 * 소스 id 는 스키마의 `source` 필드(전 카메라 스키마 공통, 옵셔널). 미지정 시 첫 소스(pickSource 규약 동일).
 */
function withSource<S extends z.ZodTypeAny>(
  deps: ViewerDeps,
  schema: S,
  handler: (parsed: z.infer<S>, source: CameraSource, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): RouteHandlerMethod {
  return async (req, reply) => {
    const parsed = parseOr400(reply, schema, req.query, 'invalid query');
    if (!parsed) return;
    const id = (parsed as { source?: string }).source;
    const source = pickSource(deps.sources, id);
    if (!source) {
      reply.code(400).send({ error: 'source not found' });
      return;
    }
    try {
      return await handler(parsed, source, req, reply);
    } catch (err) {
      reply.code(502);
      return { error: err instanceof CameraApiError ? err.message : String(err) };
    }
  };
}

/**
 * 뷰어 라우트 등록(설계서 §6.2).
 * 라우트 순서 필수: /viewer/api/* (정확 경로) 먼저 → @fastify/static (와일드카드) 나중.
 */
export async function registerViewerRoutes(app: FastifyInstance, deps: ViewerDeps): Promise<void> {
  const { sources, viewer, rpc, llm, cameraposFile } = deps;

  /** 진행 중 스트림 수(우리 프록시 계층 카운터, 수용기준 4). 홀더로 감싸 추출 핸들러와 공유. */
  const streamState = { active: 0 };

  app.get('/viewer/api/cameras', withSource(deps, CamerasQuery, handleCameras));

  /** 장비가 보고하는 현재 PTZ 조회. 실카메라 제어 UI의 상태 동기화에만 사용한다. */
  app.get('/viewer/api/ptz', withSource(deps, PtzQuery, handlePtz));

  app.get('/viewer/api/snapshot', withSource(deps, SnapshotQuery, handleSnapshot));

  app.get('/viewer/api/stream', (req, reply) => handleStream(deps, streamState, req, reply));

  app.post('/viewer/api/move', (req, reply) => handleMove(deps, req, reply));

  app.post('/viewer/api/camera/login', (req, reply) => handleLogin(deps, req, reply));

  // ── 스트림 1: Unity JSON-RPC 프록시(방식 B). rpc 주입 시에만 등록(가산·graceful). ──
  // 브라우저 → 13020 → Unity 13110 단순 패스스루(결정형 제어 평면).
  if (rpc) {
    app.post('/viewer/api/rpc', (req, reply) => handleRpc(deps, req, reply));
    // RPC 카탈로그(읽기 — 무게이트, method 드롭다운 로딩용).
    app.get('/viewer/api/rpc/catalog', (req, reply) => handleRpcCatalog(deps, req, reply));
  }

  // ── 스트림 2: 런타임 LLM 모델 전환. llm(selector) 주입 시에만 등록(가산). ──
  // 메모리 전환(재시작 없이) — 재시작 시 config activeModel 로 복귀(파일 미기록).
  if (llm) {
    app.get('/viewer/api/llm/models', () => handleLlmModels(deps));
    app.post('/viewer/api/llm/select', (req, reply) => handleLlmSelect(deps, req, reply));
  }

  // ── 카메라 PTZ 프리셋(camerapos.json) 편집. cameraposFile 주입 시에만 등록(가산). ──
  // GET(무게이트, 읽기): 파일 → 정규화 views[]. PUT(controlToken 게이트): 전체 파일 저장(왕복 호환).
  if (cameraposFile) {
    app.get('/viewer/api/camerapos', () => handleCameraposGet(deps));
    app.put('/viewer/api/camerapos', (req, reply) => handleCameraposPut(deps, req, reply));
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

/** GET /viewer/api/cameras 핸들러(withSource 콜백). */
async function handleCameras(_parsed: z.infer<typeof CamerasQuery>, source: CameraSource): Promise<unknown> {
  return await source.listCameras();
}

/** GET /viewer/api/ptz 핸들러(withSource 콜백). */
async function handlePtz(
  parsed: z.infer<typeof PtzQuery>,
  source: CameraSource,
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
    if (!source.getPtz) {
      reply.code(501);
      return { error: 'ptz state unsupported', code: 'PTZ_STATE_UNSUPPORTED' };
    }
    return { ptz: await source.getPtz(parsed.cam) };
}

/** GET /viewer/api/snapshot 핸들러(withSource 콜백). */
async function handleSnapshot(
  q: z.infer<typeof SnapshotQuery>,
  source: CameraSource,
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
    const opt =
      q.mode === 'manual'
        ? {
            mode: 'manual' as const,
            presetIdx: q.preset,
            ptz: { pan: q.pan ?? 0, tilt: q.tilt ?? 0, zoom: clampZoom(q.zoom ?? ZOOM_MIN) },
          }
        : { mode: 'preset' as const, presetIdx: q.preset };
    const result = await source.snapshot(q.cam, opt);
    sendJpeg(reply, result.jpeg, {
      'X-PTZ-Pan': String(result.ptz.pan),
      'X-PTZ-Tilt': String(result.ptz.tilt),
      'X-PTZ-Zoom': String(result.ptz.zoom),
    });
    return reply;
}

/** GET /viewer/api/stream 핸들러. streamState 는 등록기 지역 카운터(홀더 공유). */
async function handleStream(
  deps: ViewerDeps,
  streamState: { active: number },
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
    const parsed = parseOr400(reply, StreamQuery, req.query, 'invalid query');
    if (!parsed) return;
    const q = parsed;
    const source = pickSource(deps.sources, q.source);
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
    if (streamState.active >= MAX_STREAMS) {
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

    streamState.active++; // 실제 연결 성립 후 카운트.
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
      streamState.active--;
      reply.raw.end();
    }
}

/** POST /viewer/api/move 핸들러. */
async function handleMove(deps: ViewerDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (deps.viewer.allowMove === false) {
      reply.code(403);
      return { error: 'move disabled' };
    }
    if (deps.viewer.controlToken && req.headers['x-viewer-token'] !== deps.viewer.controlToken) {
      reply.code(403);
      return { error: 'invalid token' };
    }
    const parsed = parseOr400(reply, MoveBody, req.body);
    if (!parsed) return;
    const b = parsed;
    const source = pickSource(deps.sources, b.source);
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
}

/** POST /viewer/api/camera/login 핸들러. */
async function handleLogin(deps: ViewerDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const parsed = parseOr400(reply, LoginBody, req.body);
    if (!parsed) return;
    const source = pickSource(deps.sources, parsed.source);
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
      const ok = await source.login(parsed.user, parsed.pass);
      return { ok };
    } catch {
      reply.code(502);
      return { error: 'login failed' };
    }
}

/** POST /viewer/api/rpc 핸들러. deps.rpc 는 등록 가드가 존재 보장. */
async function handleRpc(deps: ViewerDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      // 변이 게이트: controlToken 설정 시 x-viewer-token 일치 필요(/move 와 동일 선택 게이트).
      if (deps.viewer.controlToken && req.headers['x-viewer-token'] !== deps.viewer.controlToken) {
        reply.code(403);
        return { error: 'invalid token' };
      }
      const parsed = parseOr400(reply, RpcBody, req.body);
      if (!parsed) return;
      try {
        const result = await deps.rpc!.callRpc(parsed.method, parsed.params);
        return { ok: true, result };
      } catch (err) {
        reply.code(502);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
}

/** GET /viewer/api/rpc/catalog 핸들러. deps.rpc 는 등록 가드가 존재 보장. */
async function handleRpcCatalog(deps: ViewerDeps, _req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      try {
        return await deps.rpc!.getCatalog();
      } catch (err) {
        reply.code(502);
        return { error: err instanceof Error ? err.message : String(err) };
      }
}

/** GET /viewer/api/llm/models 핸들러. deps.llm 은 등록 가드가 존재 보장. */
async function handleLlmModels(deps: ViewerDeps): Promise<unknown> {
      const models = deps.llm!.listModels();
      return { models, active: models.find((m) => m.active)?.id };
}

/** POST /viewer/api/llm/select 핸들러. deps.llm 은 등록 가드가 존재 보장. */
async function handleLlmSelect(deps: ViewerDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      // 변이 게이트: controlToken 설정 시 x-viewer-token 일치 필요.
      if (deps.viewer.controlToken && req.headers['x-viewer-token'] !== deps.viewer.controlToken) {
        reply.code(403);
        return { error: 'invalid token' };
      }
      const parsed = parseOr400(reply, LlmSelectBody, req.body);
      if (!parsed) return;
      const r = deps.llm!.selectModel(parsed.id);
      if (!r.ok) {
        reply.code(404);
        return { ok: false, error: 'unknown model id' };
      }
      return { ok: true, active: r.activeModel };
}

/** GET /viewer/api/camerapos 핸들러. deps.cameraposFile 은 등록 가드가 존재 보장. */
async function handleCameraposGet(deps: ViewerDeps): Promise<unknown> {
      const cameraposFile = deps.cameraposFile!;
      if (!existsSync(cameraposFile)) return { views: [] };
      try {
        return { views: parseCameraViews(JSON.parse(readFileSync(cameraposFile, 'utf-8'))) };
      } catch {
        return { views: [] };
      }
}

/** PUT /viewer/api/camerapos 핸들러. deps.cameraposFile 은 등록 가드가 존재 보장. */
async function handleCameraposPut(deps: ViewerDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      const cameraposFile = deps.cameraposFile!;
      // 변이 게이트: controlToken 설정 시 x-viewer-token 일치 필요(/move 와 동일 선택 게이트).
      if (deps.viewer.controlToken && req.headers['x-viewer-token'] !== deps.viewer.controlToken) {
        reply.code(403);
        return { error: 'invalid token' };
      }
      const parsed = parseOr400(reply, CameraposBody, req.body);
      if (!parsed) return;
      // 서버측 zoom clamp(1~36) — writeCamerapos 로 전체 파일 기록(중첩 포맷 생성).
      const views = parsed.views.map((v) => ({ ...v, zoom: clampZoom(v.zoom) }));
      writeCamerapos(views, cameraposFile);
      return { ok: true, count: views.length };
}
