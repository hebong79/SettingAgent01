import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupOrchestrator, SetupTarget } from '../setup/SetupOrchestrator.js';
import type { Repository } from '../store/Repository.js';
import type { CameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { AgentRuntime } from '../brain/AgentRuntime.js';
import { loadSetupTargets, loadExpectedFaces, viewsToTargets, type MapFiles } from '../setup/mapTargets.js';
import { discoverViews } from '../setup/discover.js';
import { writeCamerapos } from '../setup/cameraposWriter.js';
import type { PresetProvider } from '../setup/presetProvider.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CaptureJob } from '../capture/CaptureJob.js';
import type { Finalizer } from '../capture/Finalizer.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import { registerCaptureRoutes } from './captureRoutes.js';
import { registerViewerRoutes } from '../viewer/routes.js';
import type { CameraSource } from '../viewer/CameraSource.js';

const TargetSchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  label: z.string().optional(),
  ptz: z.object({ pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().optional() }).optional(),
});

const RunBodySchema = z.object({ targets: z.array(TargetSchema).min(1) });

export interface ApiDeps {
  orchestrator: SetupOrchestrator;
  repo: Repository;
  camera: CameraClient;
  vpd: VpdClient;
  brain?: AgentRuntime;
  /** mapConfig 자동 프리셋 로딩 파일 경로(#1, 기본 소스). */
  mapFiles?: MapFiles;
  /** 프리셋 자동 탐색(B) 설정. enabled=true 면 camerapos 대신 카메라 probing 으로 목록 구성. */
  discovery?: ToolsConfig['discovery'];
  /** camerapos export 용 공급자(B=discovery 또는 A=unity-api). camerapos(수동)면 null. */
  presetProvider?: PresetProvider | null;
  /** 셋업 직전 공급자로 camerapos.json 을 자동 갱신할지(2번 옵션). */
  refreshOnRun?: boolean;
  /** 장기 관측·반복 수집 잡(/capture/*). 미주입 시 capture 라우트 미등록(가산). */
  captureJob?: CaptureJob;
  finalizer?: Finalizer;
  sqlite?: SqliteStore;
  /** capture 라우트 설정·targets 로딩용. */
  capture?: ToolsConfig['capture'];
  /** 웹 뷰어 설정. enabled=true && sources 주입 시에만 뷰어 라우트·정적 등록(헤드리스 보존). */
  viewer?: ToolsConfig['viewer'];
  /** 카메라 소스 레지스트리(뷰어 카메라 라우트용). */
  sources?: Map<string, CameraSource>;
}

/**
 * SettingAgent REST API (설계서 §5).
 * /health, /setup/run, /setup/status, /mapping.
 */
export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => {
    const [cam, vpd] = await Promise.all([deps.camera.health(), deps.vpd.health()]);
    return { status: 'ok', camera: cam, vpd, brain: deps.brain?.enabled ?? false };
  });

  app.post('/setup/run', async (req, reply) => {
    const parsed = RunBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const targets: SetupTarget[] = parsed.data.targets;
    try {
      const artifact = await deps.orchestrator.run(targets);
      const review = deps.brain?.enabled ? await deps.brain.reviewSetup(artifact).catch(() => null) : null;
      return { ok: true, status: deps.orchestrator.getStatus(), slots: artifact.slots.length, globalCount: artifact.globalIndex.length, review };
    } catch (err) {
      reply.code(500);
      return { ok: false, status: deps.orchestrator.getStatus(), error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 프리셋 목록을 확보해 셋업 실행. discovery.enabled=true 면 자동 탐색(B), 아니면 camerapos(A, 기본).
  app.post('/setup/run-from-map', async (_req, reply) => {
    const useDiscovery = deps.discovery?.enabled === true;
    let targets: SetupTarget[];
    let refreshed: false | string = false; // 갱신 시 공급자명
    try {
      // 2번 옵션: 셋업 시작 시 공급자(A/B)로 camerapos.json 자동 갱신(파일 경로 입력일 때만).
      if (!useDiscovery && deps.refreshOnRun && deps.presetProvider && deps.mapFiles?.cameraposFile) {
        const views = await deps.presetProvider.listViews();
        writeCamerapos(views, deps.mapFiles.cameraposFile);
        refreshed = deps.presetProvider.name;
      }
      if (useDiscovery) {
        targets = viewsToTargets(await discoverViews(deps.camera, deps.discovery!));
      } else {
        if (!deps.mapFiles) {
          reply.code(400);
          return { error: 'mapFiles not configured (discovery 도 비활성)' };
        }
        targets = loadSetupTargets(deps.mapFiles);
      }
    } catch (err) {
      reply.code(400);
      return { error: 'target resolve failed', detail: err instanceof Error ? err.message : String(err) };
    }
    if (targets.length === 0) {
      reply.code(400);
      return { error: useDiscovery ? '자동 탐색 결과 카메라/프리셋 없음' : 'camerapos 비어 있음' };
    }
    try {
      const expectedFaces = deps.mapFiles?.presetFile ? loadExpectedFaces(deps.mapFiles.presetFile) : {};
      const artifact = await deps.orchestrator.run(targets, expectedFaces);
      return {
        ok: true,
        mode: useDiscovery ? 'discovery' : 'camerapos',
        refreshed, // false 또는 갱신 공급자명(예: 'unity-api')
        loadedTargets: targets.length,
        status: deps.orchestrator.getStatus(),
        slots: artifact.slots.length,
        globalCount: artifact.globalIndex.length,
        warnings: artifact.warnings ?? [],
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, status: deps.orchestrator.getStatus(), error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 자동 탐색(B) 결과를 camerapos.json 으로 저장(export). 이후엔 파일(A)로 정확·빠르게 재사용.
  // (벤더 API 공급자 A 가 생기면 동일하게 이 파일로 저장 → 수동/A/B 모두 같은 포맷 공유.)
  app.post('/setup/export-camerapos', async (_req, reply) => {
    if (!deps.presetProvider) {
      reply.code(400);
      return { error: 'presetProvider 없음(camerapos=수동). discovery 또는 unity-api 로 설정' };
    }
    if (!deps.mapFiles?.cameraposFile) {
      reply.code(400);
      return { error: 'cameraposFile 경로 미설정' };
    }
    try {
      const views = await deps.presetProvider.listViews();
      writeCamerapos(views, deps.mapFiles.cameraposFile);
      return { ok: true, provider: deps.presetProvider.name, count: views.length, path: deps.mapFiles.cameraposFile, views: views.map((v) => `${v.camIdx}:${v.presetIdx}`) };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/setup/status', async () => deps.orchestrator.getStatus());

  // #3: LLM 두뇌 연결 점검 / 산출물 검토.
  app.get('/brain/ping', async (_req, reply) => {
    if (!deps.brain?.enabled) {
      reply.code(503);
      return { enabled: false };
    }
    const ok = await deps.brain.ping().catch(() => false);
    return { enabled: true, reachable: ok };
  });

  app.post('/brain/review', async (_req, reply) => {
    const artifact = deps.repo.loadArtifact();
    if (!artifact) {
      reply.code(404);
      return { error: 'no setup artifact' };
    }
    if (!deps.brain?.enabled) {
      reply.code(503);
      return { error: 'brain disabled' };
    }
    const review = await deps.brain.reviewSetup(artifact).catch((e) => `검토 실패: ${e}`);
    return { review };
  });

  app.get('/mapping', async (_req, reply) => {
    const artifact = deps.repo.loadArtifact();
    if (!artifact) {
      reply.code(404);
      return { error: 'no setup artifact' };
    }
    return artifact;
  });

  // 장기 관측·반복 수집(/capture/*). 의존성 주입 시에만 등록(가산, 기존 라우트 불변).
  if (deps.captureJob && deps.finalizer && deps.sqlite && deps.capture) {
    registerCaptureRoutes(app, {
      job: deps.captureJob,
      finalizer: deps.finalizer,
      store: deps.sqlite,
      cfg: deps.capture,
      mapFiles: deps.mapFiles,
    });
  }

  // 웹 뷰어 통합(SettingViewer). viewer.enabled && sources 주입 시에만 등록(헤드리스 보존, 가산).
  // registerViewerRoutes 는 async(내부 @fastify/static register) → app.register 로 감싸 buildServer 동기 유지.
  if (deps.viewer?.enabled && deps.sources) {
    const viewer = deps.viewer;
    const sources = deps.sources;
    app.register(async (instance) => {
      // /viewer/api/mapping 직접 읽기(프록시 폐기) — repo.loadArtifact() 그대로 반환, 404 보존.
      instance.get('/viewer/api/mapping', async (_req, reply) => {
        const artifact = deps.repo.loadArtifact();
        if (!artifact) {
          reply.code(404);
          return { error: 'no setup artifact' };
        }
        return artifact;
      });
      // 카메라 라우트 + 정적 SPA(와일드카드는 내부에서 API 라우트 뒤에 register).
      await registerViewerRoutes(instance, { sources, viewer });
    });
  }

  return app;
}
