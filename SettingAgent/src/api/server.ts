import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupOrchestrator, SetupTarget } from '../setup/SetupOrchestrator.js';
import type { Repository } from '../store/Repository.js';
import type { ICameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
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
import { registerCalibrateRoutes } from './calibrateRoutes.js';
import { registerDiscoverRoutes } from './discoverRoutes.js';
import { registerSettingsRoutes } from './settingsRoutes.js';
import { registerDbRoutes } from './dbRoutes.js';
import { DEFAULT_SETTINGS_PATHS, type SettingsPaths } from '../config/settingsStore.js';
import type { PtzCalibrator } from '../calibrate/PtzCalibrator.js';
import type { PlateDiscoveryJob } from '../calibrate/PlateDiscoveryJob.js';
import type { SetupPipeline } from '../pipeline/SetupPipeline.js';
import { registerViewerRoutes } from '../viewer/routes.js';
import type { CameraSource } from '../viewer/CameraSource.js';
import { validateArtifactBody } from './artifactSchema.js';
import { buildArtifactFromSlotSetup } from '../setup/artifactFromSlotSetup.js';
import type { SetupArtifact } from '../domain/types.js';
import type { SaveStore } from '../store/SaveStore.js';
import type { CRpcClient } from '../clients/CRpcClient.js';
import { validateRenumberMapping } from '../setup/renumberMapping.js';
import { validateSlotPlacement } from '../setup/placementMapping.js';
import { renumberSlotPtzFile } from '../calibrate/slotPtzRenumber.js';
import { writeSetupResultFiles } from '../store/setupResult.js';
import { logger } from '../util/logger.js';

const TargetSchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  label: z.string().optional(),
  ptz: z.object({ pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().optional() }).optional(),
});

const RunBodySchema = z.object({ targets: z.array(TargetSchema).min(1) });

const RenumberBodySchema = z.object({
  mapping: z
    .array(
      z.object({
        oldSlotId: z.number().int().positive(),
        newSlotId: z.number().int().positive(),
      }),
    )
    .min(1),
});

const PlacementBodySchema = z.object({
  placements: z
    .array(
      z.object({
        slotId: z.number().int().positive(),
        camId: z.number().int().positive(),
        presetId: z.number().int().positive(),
        presetSlotIdx: z.number().int().positive(),
      }),
    )
    .min(1),
});

/**
 * PUT /mapping 공유 핸들러(헤드리스·뷰어 동일 로직).
 * validateArtifactBody(shape+coverage) 통과 시 repo.saveArtifact, { ok, slots, globalCount } 반환.
 * 실패 시 400 + { error, ... }(invalid artifact | coverage mismatch).
 */
function saveMappingHandler(repo: Repository, body: unknown, reply: { code: (c: number) => void }) {
  const v = validateArtifactBody(body);
  if (!v.ok) {
    reply.code(v.code);
    return v.body;
  }
  repo.saveArtifact(v.artifact);
  return { ok: true, slots: v.artifact.slots.length, globalCount: v.artifact.globalIndex.length };
}

export interface ApiDeps {
  orchestrator: SetupOrchestrator;
  repo: Repository;
  camera: ICameraClient;
  vpd: VpdClient;
  /** 번호판 검출(LPD) 클라이언트. 라이브 검출(POST /capture/detect) 주입용. */
  lpd?: LpdClient;
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
  /** 정밀수집 결과 저장/열기(save/*) 스토어. 주입 시 /capture/save·saves 라우트 등록(가산). */
  saveStore?: SaveStore;
  /** 미리 정의된 주차면 폴리곤 파일(Place01/PtzCamRoi.json) 경로. GET/PUT /capture/place-roi 서빙용. */
  placeRoiFile?: string;
  /** 주차면 자동보정 기준 프레임 저장 디렉터리(data/refframes). /capture/refframe·autocorrect 용. */
  refFrameDir?: string;
  /** 지면모델 설정(GET /capture/ground-model). 3D 육면체 렌더 근거. */
  ground?: ToolsConfig['ground'];
  /** 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션 잡(/calibrate/*). 미주입 시 미등록(가산). */
  calibrator?: PtzCalibrator;
  /** calibrate 설정(outFile=GET /calibrate/result 경로). */
  calibrate?: ToolsConfig['calibrate'];
  /** 번호판 탐색·확대반복·역계산 잡(/discover/*). 미주입 시 미등록(가산). */
  plateDiscovery?: PlateDiscoveryJob;
  /** plate_discovery.json 경로(GET /discover/result). */
  discoverOutFile?: string;
  /** 원버튼 셋업 파이프라인(옵셔널·가산). 주입 시 /capture/start autoChain 배선 + GET /capture/pipeline. */
  pipeline?: SetupPipeline;
  /** 웹 뷰어 설정. enabled=true && sources 주입 시에만 뷰어 라우트·정적 등록(헤드리스 보존). */
  viewer?: ToolsConfig['viewer'];
  /** 카메라 소스 레지스트리(뷰어 카메라 라우트 + /calibrate/point 의 source 지정용). */
  sources?: Map<string, CameraSource>;
  /** 카메라 설정(zoom 클램프). sources 로 요청별 CameraSourceClient 를 조립할 때 사용. */
  cameraCfg?: ToolsConfig['camera'];
  /** 웹 옵션 페이지(/settings) 편집 대상 config 파일 경로. 미지정 시 기본 config 경로. */
  settingsPaths?: SettingsPaths;
  /** DB 뷰어(/db/*) read-only 조회 대상 SQLite 파일. 주입 시에만 등록(가산·독립, R4). */
  dbFile?: string;
  /** Unity JSON-RPC 프록시 클라이언트. 주입 시 뷰어에 전달되어 /viewer/api/rpc* 라우트 등록(가산). */
  rpc?: CRpcClient;
}

/**
 * SettingAgent REST API (설계서 §5).
 * /health, /setup/run, /setup/status, /mapping.
 */
export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  /**
   * 매핑 소스 결정: 파일에 slots 가 있으면 파일 우선(수동 PUT /mapping 편집 보존),
   * 없거나 비면 slot_setup(DB) 즉석 조립. 파일·DB 모두 비면 null(→404).
   * ★ 순수 읽기(getSlotSetup)만 — replaceSlotSetup/finalize 미호출(파괴 금지).
   */
  function resolveMapping(): SetupArtifact | null {
    const file = deps.repo.loadArtifact();
    if (file && Array.isArray(file.slots) && file.slots.length > 0) return file; // 파일 우선
    const views = deps.sqlite ? deps.sqlite.getSlotSetup() : [];
    if (views.length > 0) return buildArtifactFromSlotSetup(views); // DB 폴백
    return null; // 404
  }

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
    const artifact = resolveMapping();
    if (!artifact) {
      reply.code(404);
      return { error: 'no setup artifact' };
    }
    return artifact;
  });

  // 편집된 SetupArtifact 영속화(주차면 ROI 편집·전역 인덱스 수동 매핑). GET /mapping 은 불변.
  app.put('/mapping', async (req, reply) => saveMappingHandler(deps.repo, req.body, reply));

  /**
   * 전역번호 재번호(A안): 수동매핑 → DB slot_id 재번호 + json 전파.
   * 처리 순서(원자성): 검증(실패→400·DB무변경) → DB 재번호(트랜잭션·all-or-nothing) →
   * slot_ptz → setup_result → setup_artifact. DB 커밋이 진실의 기준; 파일 3종은 순차 best-effort.
   * 헤드리스 POST /mapping/renumber + 뷰어 /viewer/api/mapping/renumber 가 이 핸들러를 공유한다.
   */
  function renumberHandler(body: unknown, reply: { code: (c: number) => void }): unknown {
    if (!deps.sqlite) {
      reply.code(501);
      return { error: 'sqlite not configured' };
    }
    const parsed = RenumberBodySchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }

    // 1) 검증(순수). currentIds = DB 현재 slot_id 전량.
    const currentIds = deps.sqlite.getSlotSetup().map((s) => s.slotId);
    const v = validateRenumberMapping(currentIds, parsed.data.mapping);
    if (!v.ok) {
      reply.code(400);
      return { error: v.error }; // ★ DB 무변경(원자성)
    }

    // 2) DB 재번호(트랜잭션·전 컬럼 보존). throw 시 롤백.
    let changed: number;
    try {
      changed = deps.sqlite.renumberSlotIds(v.idMap!).changed;
    } catch (e) {
      reply.code(500);
      return { error: 'renumber failed', detail: String(e) };
    }

    // 3) 파일 전파(각 격리·best-effort — DB 커밋 후엔 파일 실패가 요청을 실패시키지 않음).
    let slotPtz: 'written' | 'skipped' = 'skipped';
    if (deps.calibrate?.outFile) slotPtz = renumberSlotPtzFile(deps.calibrate.outFile, v.idMap!);

    let setupResult: { archive: string | null; fixed: string | null } | null = null;
    if (deps.saveStore) {
      try {
        const w = writeSetupResultFiles(deps.sqlite.getSlotSetup(), deps.saveStore);
        setupResult = { archive: w.archive, fixed: w.fixed };
      } catch (e) {
        logger.warn({ err: e }, 'setup_result 재생성 실패(격리 — DB 정본은 무관)');
      }
    }

    let artifactSaved = false;
    try {
      deps.repo.saveArtifact(buildArtifactFromSlotSetup(deps.sqlite.getSlotSetup()));
      artifactSaved = true;
    } catch (e) {
      logger.warn({ err: e }, 'setup_artifact 재빌드 저장 실패(격리 — DB 정본은 무관)');
    }

    return { ok: true, renumbered: changed, slotPtz, setupResult, artifactSaved };
  }

  app.post('/mapping/renumber', async (req, reply) => renumberHandler(req.body, reply));

  /**
   * 슬롯 배치 수동 변경: 전역 인덱스 수동 매핑 화면에서 행별로 고친
   * (카메라, 프리셋, 프리셋내 위치)를 DB slot_setup 에 반영한다.
   * 처리 순서(renumber 와 동일 규약): 검증(실패→400·DB무변경) → DB UPDATE(트랜잭션) →
   * setup_result → setup_artifact 재빌드. DB 커밋이 진실의 기준; 파일 2종은 순차 best-effort.
   *
   * ★ 기하(slot_roi)는 변환하지 않는다 — ROI 는 원래 프리셋 화면 기준 정규화 좌표이므로,
   *   다른 카메라·프리셋으로 옮기면 좌표는 그대로 남는다(재수집·재센터라이징이 필요).
   *   센터링 PTZ(pan/tilt/zoom)도 지우지 않는다 — 데이터 파괴 금지, 대신 UI 가 경고한다.
   */
  function placementHandler(body: unknown, reply: { code: (c: number) => void }): unknown {
    if (!deps.sqlite) {
      reply.code(501);
      return { error: 'sqlite not configured' };
    }
    const parsed = PlacementBodySchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }

    // 1) 검증(순수). current = DB 현재 배치 전량, presetKeys = FK 부모.
    const current = deps.sqlite.getSlotSetup().map((s) => ({
      slotId: s.slotId, camId: s.camId, presetId: s.presetId, presetSlotIdx: s.presetSlotIdx,
    }));
    const v = validateSlotPlacement(current, parsed.data.placements, deps.sqlite.getPresetKeys());
    if (!v.ok) {
      reply.code(400);
      return { error: v.error }; // ★ DB 무변경(원자성)
    }

    // 2) DB 배치 갱신(트랜잭션). throw 시 롤백.
    let changed: number;
    try {
      changed = deps.sqlite.updateSlotPlacement(parsed.data.placements).changed;
    } catch (e) {
      reply.code(500);
      return { error: 'placement update failed', detail: String(e) };
    }

    // 3) 파일 전파(각 격리·best-effort — DB 커밋 후엔 파일 실패가 요청을 실패시키지 않음).
    let setupResult: { archive: string | null; fixed: string | null } | null = null;
    if (deps.saveStore) {
      try {
        const w = writeSetupResultFiles(deps.sqlite.getSlotSetup(), deps.saveStore);
        setupResult = { archive: w.archive, fixed: w.fixed };
      } catch (e) {
        logger.warn({ err: e }, 'setup_result 재생성 실패(격리 — DB 정본은 무관)');
      }
    }

    let artifactSaved = false;
    try {
      deps.repo.saveArtifact(buildArtifactFromSlotSetup(deps.sqlite.getSlotSetup()));
      artifactSaved = true;
    } catch (e) {
      logger.warn({ err: e }, 'setup_artifact 재빌드 저장 실패(격리 — DB 정본은 무관)');
    }

    return { ok: true, updated: changed, setupResult, artifactSaved };
  }

  app.post('/mapping/placement', async (req, reply) => placementHandler(req.body, reply));

  // 장기 관측·반복 수집(/capture/*). 의존성 주입 시에만 등록(가산, 기존 라우트 불변).
  if (deps.captureJob && deps.finalizer && deps.sqlite && deps.capture) {
    registerCaptureRoutes(app, {
      job: deps.captureJob,
      finalizer: deps.finalizer,
      store: deps.sqlite,
      cfg: deps.capture,
      mapFiles: deps.mapFiles,
      presetProvider: deps.presetProvider,
      brain: deps.brain,
      saveStore: deps.saveStore,
      placeRoiFile: deps.placeRoiFile,
      refFrameDir: deps.refFrameDir,
      ground: deps.ground,
      camera: deps.camera,
      vpd: deps.vpd,
      lpd: deps.lpd,
      pipeline: deps.pipeline,
      // sources/cameraCfg 는 옵셔널 전달 — 주입돼야 POST /capture/start-precise 의 source 지정이 살아난다(헤드리스 보존).
      sources: deps.sources,
      cameraCfg: deps.cameraCfg,
    });
  }

  // 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션(/calibrate/*). 의존성 주입 시에만 등록(가산).
  if (deps.calibrator && deps.calibrate) {
    // sources/cameraCfg 는 옵셔널 전달 — 주입돼야 POST /calibrate/point 의 source 지정이 살아난다(헤드리스 보존).
    registerCalibrateRoutes(app, {
      calibrator: deps.calibrator,
      outFile: deps.calibrate.outFile,
      sources: deps.sources,
      cameraCfg: deps.cameraCfg,
    });
  }

  // 번호판 탐색·확대반복·역계산(/discover/*). 센터라이징 상류 잡. 주입 시에만 등록(가산).
  if (deps.plateDiscovery && deps.discoverOutFile) {
    registerDiscoverRoutes(app, { discovery: deps.plateDiscovery, outFile: deps.discoverOutFile });
  }

  // 웹 옵션 페이지(/settings). 결정형 파일 I/O — 항상 등록(가산, 기존 라우트 불변).
  registerSettingsRoutes(app, deps.settingsPaths ?? DEFAULT_SETTINGS_PATHS);

  // SQLite DB 뷰어(/db/*). read-only 독립 연결 — 캡처 블록과 무관하게 등록(가산, R4).
  if (deps.dbFile) registerDbRoutes(app, { dbFile: deps.dbFile });

  // 웹 뷰어 통합(SettingViewer). viewer.enabled && sources 주입 시에만 등록(헤드리스 보존, 가산).
  // registerViewerRoutes 는 async(내부 @fastify/static register) → app.register 로 감싸 buildServer 동기 유지.
  if (deps.viewer?.enabled && deps.sources) {
    const viewer = deps.viewer;
    const sources = deps.sources;
    app.register(async (instance) => {
      // /viewer/api/mapping 직접 읽기(프록시 폐기) — 파일 우선, 없으면 DB 즉석 조립(resolveMapping), 404 보존.
      instance.get('/viewer/api/mapping', async (_req, reply) => {
        const artifact = resolveMapping();
        if (!artifact) {
          reply.code(404);
          return { error: 'no setup artifact' };
        }
        return artifact;
      });
      // 편집된 SetupArtifact 영속화(뷰어 컨텍스트). 헤드리스 PUT /mapping 과 동일 로직.
      instance.put('/viewer/api/mapping', async (req, reply) => saveMappingHandler(deps.repo, req.body, reply));
      // 전역번호 재번호(뷰어 컨텍스트). 헤드리스 POST /mapping/renumber 와 동일 closure 핸들러 공유.
      instance.post('/viewer/api/mapping/renumber', async (req, reply) => renumberHandler(req.body, reply));
      // 슬롯 배치 수동 변경(뷰어 컨텍스트). 헤드리스 POST /mapping/placement 와 동일 closure 핸들러 공유.
      instance.post('/viewer/api/mapping/placement', async (req, reply) => placementHandler(req.body, reply));
      // 카메라 라우트 + 정적 SPA(와일드카드는 내부에서 API 라우트 뒤에 register).
      // rpc(Unity 프록시)·llm(모델 선택기=brain)은 주입 시에만 해당 라우트 등록(가산).
      await registerViewerRoutes(instance, {
        sources,
        viewer,
        rpc: deps.rpc,
        llm: deps.brain,
        cameraposFile: deps.mapFiles?.cameraposFile,
      });
    });
  }

  return app;
}
