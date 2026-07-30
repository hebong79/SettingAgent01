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
import { registerControlTokenGate } from './controlGate.js';
import { registerCaptureRoutes } from './captureRoutes.js';
import { registerCalibrateRoutes } from './calibrateRoutes.js';
import { registerGroundGridRoutes } from './groundGridRoutes.js';
import { registerDiscoverRoutes } from './discoverRoutes.js';
import { registerLensCalibRoutes } from './lensCalibRoutes.js';
import { registerTourRoutes } from './tourRoutes.js';
import { registerSettingsRoutes } from './settingsRoutes.js';
import { registerDbRoutes } from './dbRoutes.js';
import { DEFAULT_SETTINGS_PATHS, type SettingsPaths } from '../config/settingsStore.js';
import type { PtzCalibrator } from '../calibrate/PtzCalibrator.js';
import type { PlateDiscoveryJob } from '../calibrate/PlateDiscoveryJob.js';
import type { LensCalibrationJob } from '../calibrate/LensCalibrationJob.js';
import type { TourJob } from '../capture/TourJob.js';
import type { SetupPipeline } from '../pipeline/SetupPipeline.js';
import { registerViewerRoutes } from '../viewer/routes.js';
import { registerRpcRoutes } from '../rpc/routes.js';
import type { CameraSource } from '../viewer/CameraSource.js';
import { validateArtifactBody } from './artifactSchema.js';
import { buildArtifactFromSlotSetup } from '../setup/artifactFromSlotSetup.js';
import { insertSlotAt, nextSlotId, removeSlot } from '../setup/artifactSlotEdit.js';
import type { ParkingSlot, SetupArtifact } from '../domain/types.js';
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
 * 슬롯편집 본문(POST /mapping/slot/add · /mapping/slot/delete).
 *
 * `artifact` = **호출자 버퍼**(웹의 메모리 편집본). 미제공이면 서버가 data/setup_artifact.json 을 읽는다.
 * `dryRun` = true 면 편집 결과만 반환하고 **파일을 절대 쓰지 않는다**(웹의 "추가 → 배치 → 저장" 2단계 UX 보존).
 * 기본은 false — 외부 RPC 호출자는 한 번의 호출로 커밋된다.
 *
 * ★ `artifact` 는 **계산 전용**이다 — `dryRun:true` 없이 주면 409 로 거부한다(`rejectBufferCommit`, D-1).
 *   버퍼를 받아 저장까지 하면 "슬롯 1개 추가"가 실제로는 파일 전체 교체가 되기 때문이다.
 *
 * 버퍼의 구조 검증은 여기서 하지 않는다("객체인가"만 본다) — 최종 판정은 편집 **후** `validateArtifactBody`
 * 하나가 소유한다(스키마를 두 벌 쓰지 않는다).
 */
const CallerArtifactSchema = z.object({}).passthrough();

const SlotAddBodySchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  at: z.number().int().positive().optional(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  zone: z.string().optional(),
  artifact: CallerArtifactSchema.optional(),
  dryRun: z.boolean().optional(),
});

const SlotDeleteBodySchema = z.object({
  slotId: z.string().min(1),
  artifact: CallerArtifactSchema.optional(),
  dryRun: z.boolean().optional(),
});

/** 신규 슬롯 기본 rect(화면 중앙 소형) — web/app.js:addSlot 이 갖고 있던 값을 **서버가 소유**한다. */
const DEFAULT_SLOT_RECT = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } as const;

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
  /** 지면 격자 저작 파일(ground_grid.json) 경로. placeRoiFile·ground 와 함께 주입 시 /capture/ground-grid/* 등록(가산). */
  groundGridFile?: string;
  /** 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션 잡(/calibrate/*). 미주입 시 미등록(가산). */
  calibrator?: PtzCalibrator;
  /** calibrate 설정(outFile=GET /calibrate/result 경로). */
  calibrate?: ToolsConfig['calibrate'];
  /** 번호판 탐색·확대반복·역계산 잡(/discover/*). 미주입 시 미등록(가산). */
  plateDiscovery?: PlateDiscoveryJob;
  /** plate_discovery.json 경로(GET /discover/result). */
  discoverOutFile?: string;
  /** 광각 렌즈 캘리브레이션 잡(/calibrate/lens/*). 미주입 시 미등록(가산). */
  lensCalib?: LensCalibrationJob;
  /** 렌즈 보정표 정본 경로(POST /calibrate/lens/apply 대상) + 결과 전문 디렉터리. */
  lensCalibPaths?: { calibFile: string; resultDir: string };
  /** 셋업 결과 순회 잡(/capture/tour/*). 미주입 시 미등록(가산 → RPC 는 -32004 UNAVAILABLE). */
  tourJob?: TourJob;
  /** 원버튼 셋업 파이프라인(옵셔널·가산). 주입 시 /capture/start autoChain 배선 + GET /capture/pipeline. */
  pipeline?: SetupPipeline;
  /** 웹 뷰어 설정. enabled=true && sources 주입 시에만 뷰어 라우트·정적 등록(헤드리스 보존). */
  viewer?: ToolsConfig['viewer'];
  /** 카메라 소스 레지스트리(뷰어 카메라 라우트 + /calibrate/point 의 source 지정용). */
  sources?: Map<string, CameraSource>;
  /** 카메라 설정(zoom 클램프). sources 로 요청별 CameraSourceClient 를 조립할 때 사용. */
  cameraCfg?: ToolsConfig['camera'];
  /** `camera` 가 감싼 소스 id(cameraRuntime.selectedCameraId). RPC 응답의 `usedSource` 표기용. */
  selectedCameraId?: string;
  /** 웹 옵션 페이지(/settings) 편집 대상 config 파일 경로. 미지정 시 기본 config 경로. */
  settingsPaths?: SettingsPaths;
  /** DB 뷰어(/db/*) read-only 조회 대상 SQLite 파일. 주입 시에만 등록(가산·독립, R4). */
  dbFile?: string;
  /** Unity JSON-RPC 프록시 클라이언트. 주입 시 뷰어에 전달되어 /viewer/api/rpc* 라우트 등록(가산). */
  rpc?: CRpcClient;
  /**
   * 전역 카메라 점유 판정(RPC `system.busy` + requiresCamera 게이트).
   * index.ts 가 lensCalib 에 주는 판정과 **같은 클로저**를 넘겨 판정처를 하나로 유지한다.
   * 미주입 시 RPC 는 점유 검사를 건너뛴다(기존 라우트의 자체 409 가 최종 방어선 — 회귀 0).
   */
  isBusy?: () => { busy: boolean; who?: string };
}

/**
 * SettingAgent REST API (설계서 §5).
 * /health, /setup/run, /setup/status, /mapping.
 */
export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // 변이 게이트(전역 onRequest) — 이후 등록되는 capture/calibrate/discover/rpc/뷰어 캡슐 전부에 적용된다.
  // controlToken 이 빈 값이면 훅 자체가 달리지 않는다(현행 동작 보존).
  registerControlTokenGate(app, deps.viewer);

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

  /**
   * 슬롯편집 공통 부가정보. `deps.sqlite` 는 **읽기(getSlotSetup)만** 쓴다 — 쓰기 API 호출 0(R12).
   *
   * ★ R10: `POST /mapping/renumber`·`/mapping/placement` 는 artifact 를 `buildArtifactFromSlotSetup(DB)` 로
   *   통째 재생성한다(위 두 핸들러). 그래서 여기서 추가한 슬롯은 그 호출 이후 **사라진다**.
   *   코드로 막지 않는다(막으면 renumber 가 못 돈다) — 대신 개수 불일치를 warnings 로 알린다.
   */
  function slotEditMeta(edited: SetupArtifact, newPresetKey: string | null): { warnings: string[]; dbSlotCount: number | null } {
    const warnings: string[] = [];
    if (newPresetKey) {
      warnings.push(`preset ${newPresetKey} 을 새로 만들었다(PTZ 없음) — 순회·센터라이징 대상이 아니다`);
    }
    const dbSlotCount = deps.sqlite ? deps.sqlite.getSlotSetup().length : null;
    if (dbSlotCount !== null && dbSlotCount !== edited.slots.length) {
      warnings.push(
        `DB slot_setup(${dbSlotCount}) 과 artifact(${edited.slots.length}) 의 슬롯 수가 다르다 — ` +
          'slot.renumber / slot.placement.update 를 호출하면 이 편집은 DB 기준으로 되돌아간다',
      );
    }
    return { warnings, dbSlotCount };
  }

  /** 편집 대상 artifact 결정: 호출자 버퍼 우선 → 없으면 파일 정본. `resolveMapping()` 은 쓰지 않는다 — DB 폴백 결과를 저장하면 DB 를 파일로 승격시켜 버린다. */
  function baseArtifact(caller: unknown): SetupArtifact | null {
    return (caller as SetupArtifact | undefined) ?? deps.repo.loadArtifact();
  }

  /**
   * ★ D-1 가드 — `artifact`(호출자 버퍼) + 커밋 조합을 **거부**한다(리더 지시, 2026-07-28).
   *
   * 왜: 이 API 는 이름상 "슬롯 1개 추가"지만, 버퍼를 받아 저장까지 하면 실제 사정거리는
   * **파일 전체 교체**다 — 디스크에 있던 다른 슬롯이 조용히 사라지고 호출자가 준 임의 필드가 그대로 안착한다
   * (QA 실측: 파일 2슬롯 + 1슬롯 버퍼로 커밋 → 파일이 2슬롯이 되고 `c1p1s2` 소실).
   * `artifact` 의 존재 이유는 "웹이 미저장 버퍼로 계산만 위임"뿐이고 그건 **항상 dryRun:true** 다.
   * "버퍼를 편집해 파일에 통째로 쓴다"는 정당한 사용처가 없으며, 있다 해도 그건 artifact 저장 API(`PUT /mapping`)의 일이다.
   * → 이 조합을 막아도 **기능 손실 0**, 위험만 사라진다.
   *
   * 거부는 409(BUSY 단어 미포함) → RPC `-32005 CONFLICT`. 편집·저장 이전 단계라 **파일 무변경**이다.
   */
  function rejectBufferCommit(
    caller: unknown,
    dryRun: boolean | undefined,
    reply: { code: (c: number) => void },
  ): { error: string } | null {
    if (caller === undefined || dryRun === true) return null;
    reply.code(409);
    return {
      error:
        'artifact(호출자 버퍼)는 계산 전용이다 — dryRun:true 와 함께만 쓸 수 있다. ' +
        '파일에 커밋하려면 artifact 를 빼고 호출하라(서버가 디스크 정본을 읽는다). 파일 무변경',
    };
  }

  /**
   * 셋업 산출물에 슬롯 엔트리 1개 추가(web/app.js:addSlot 의 서버 정본).
   * ★ 이것은 **artifact 편집**이지 주차면(공간) 추가가 아니다 — 실제 주차면 추가는
   *   `place.space.add`(PtzCamRoi.json) + `slot.roi.sync`(DB 차등 UPDATE) 경로다.
   * 처리 순서: zod → 편집 → **검증** → (dryRun 아니면) 저장. 검증 실패 시 saveArtifact 미도달 = 파일 무변경(R11).
   */
  function slotAddHandler(body: unknown, reply: { code: (c: number) => void }): unknown {
    const parsed = SlotAddBodySchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const { camIdx, presetIdx, rect, zone, dryRun } = parsed.data;
    const guard = rejectBufferCommit(parsed.data.artifact, dryRun, reply);
    if (guard) return guard; // ★ 편집 이전에 끊는다 = 파일 무변경(D-1)
    const base = baseArtifact(parsed.data.artifact);
    if (!base) {
      reply.code(404);
      return { error: 'no setup artifact' };
    }

    const key = `${camIdx}:${presetIdx}`;
    const slotId = nextSlotId(base, camIdx, presetIdx);
    const newSlot: ParkingSlot = {
      slotId,
      zone: zone ?? `cam${camIdx}`,
      roiByPreset: { [key]: rect ?? { ...DEFAULT_SLOT_RECT } },
    };
    const at = parsed.data.at ?? (base.globalIndex?.length ?? 0) + 1; // 미지정 = 맨 끝(insertSlotAt 이 [1,N+1] clamp).
    const presetExisted = (base.presets ?? []).some((p) => p.camIdx === camIdx && p.presetIdx === presetIdx);
    const edited = insertSlotAt(base, at, newSlot);

    const v = validateArtifactBody(edited);
    if (!v.ok) {
      reply.code(v.code);
      return v.body; // ★ 파일 무변경
    }
    if (dryRun !== true) deps.repo.saveArtifact(v.artifact);

    const meta = slotEditMeta(v.artifact, presetExisted ? null : key);
    return {
      ok: true,
      slotId,
      globalIdx: v.artifact.globalIndex.find((g) => g.slotId === slotId)?.globalIdx ?? null,
      slots: v.artifact.slots.length,
      globalCount: v.artifact.globalIndex.length,
      saved: dryRun !== true,
      warnings: meta.warnings,
      dbSlotCount: meta.dbSlotCount,
      artifact: v.artifact,
    };
  }

  /**
   * 셋업 산출물에서 슬롯 엔트리 1개 삭제(web/app.js:deleteSelectedSlot 의 서버 정본).
   * `removeSlot` 은 없는 id 에도 조용히 통과하므로 **사전 존재 확인이 필수**다 → 부재 시 409(파일 무변경).
   * DB·ROI 정본(PtzCamRoi.json)은 건드리지 않는다.
   */
  function slotDeleteHandler(body: unknown, reply: { code: (c: number) => void }): unknown {
    const parsed = SlotDeleteBodySchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const { slotId, dryRun } = parsed.data;
    const guard = rejectBufferCommit(parsed.data.artifact, dryRun, reply);
    if (guard) return guard; // ★ 동일 규약(D-1)
    const base = baseArtifact(parsed.data.artifact);
    if (!base) {
      reply.code(404);
      return { error: 'no setup artifact' };
    }
    if (!(base.slots ?? []).some((s) => s.slotId === slotId)) {
      reply.code(409); // BUSY 단어 미포함 → RPC CONFLICT(-32005).
      return { error: `slotId 없음: ${slotId} — 파일 무변경` };
    }

    const edited = removeSlot(base, slotId);
    const v = validateArtifactBody(edited);
    if (!v.ok) {
      reply.code(v.code);
      return v.body; // ★ 파일 무변경
    }
    if (dryRun !== true) deps.repo.saveArtifact(v.artifact);

    const meta = slotEditMeta(v.artifact, null);
    return {
      ok: true,
      slotId,
      slots: v.artifact.slots.length,
      globalCount: v.artifact.globalIndex.length,
      saved: dryRun !== true,
      warnings: meta.warnings,
      dbSlotCount: meta.dbSlotCount,
      artifact: v.artifact,
    };
  }

  app.post('/mapping/slot/add', async (req, reply) => slotAddHandler(req.body, reply));
  app.post('/mapping/slot/delete', async (req, reply) => slotDeleteHandler(req.body, reply));

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

  // 지면 격자 자동 바닥 ROI(/capture/ground-grid/*). 세 의존성이 모두 있을 때만 등록(가산, 기존 라우트 불변).
  if (deps.placeRoiFile && deps.groundGridFile && deps.ground?.enabled) {
    registerGroundGridRoutes(app, {
      placeRoiFile: deps.placeRoiFile,
      groundGridFile: deps.groundGridFile,
      ground: deps.ground,
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

  // 광각 렌즈 화각·게인·곡면율 실측(/calibrate/lens/*). 주입 시에만 등록(가산).
  if (deps.lensCalib && deps.lensCalibPaths) {
    registerLensCalibRoutes(app, { job: deps.lensCalib, ...deps.lensCalibPaths });
  }

  // 셋업 결과 순회(/capture/tour/*). 주입 시에만 등록(가산). isBusy 는 라우트 직접 호출의 최종 방어선(R5).
  if (deps.tourJob) {
    registerTourRoutes(app, {
      job: deps.tourJob,
      sources: deps.sources,
      cameraCfg: deps.cameraCfg,
      isBusy: deps.isBusy,
    });
  }

  // 웹 옵션 페이지(/settings). 결정형 파일 I/O — 항상 등록(가산, 기존 라우트 불변).
  registerSettingsRoutes(app, deps.settingsPaths ?? DEFAULT_SETTINGS_PATHS);

  // SQLite DB 뷰어(/db/*). read-only 독립 연결 — 캡처 블록과 무관하게 등록(가산, R4).
  if (deps.dbFile) registerDbRoutes(app, { dbFile: deps.dbFile });

  // 외부 제어용 JSON-RPC 평면(/rpc, /rpc/catalog). **항상 등록(가산)** — 개별 메서드의 가용성은
  // 주입된 deps 로 판정된다(미배선 메서드는 카탈로그 available:false + 호출 시 -32004).
  // 실행은 위 라우트들로 위임하거나(bridge) REST 에 없는 승격 기능만 서비스로 처리한다(이중구현 금지).
  registerRpcRoutes(app, {
    viewer: deps.viewer,
    unityRpc: deps.rpc,
    placeRoiFile: deps.placeRoiFile,
    cameraposFile: deps.mapFiles?.cameraposFile,
    sources: deps.sources,
    selectedCameraId: deps.selectedCameraId,
    cameraCfg: deps.cameraCfg,
    lpd: deps.lpd,
    camera: deps.camera,
    store: deps.sqlite,
    isBusy: deps.isBusy,
  });

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
      // 슬롯 엔트리 추가·삭제(뷰어 컨텍스트). 헤드리스 POST /mapping/slot/* 와 동일 closure 핸들러 공유
      // — 웹은 dryRun:true 로 계산만 받고, 영속화는 기존 '저장'(PUT /mapping)이 계속 소유한다.
      instance.post('/viewer/api/mapping/slot/add', async (req, reply) => slotAddHandler(req.body, reply));
      instance.post('/viewer/api/mapping/slot/delete', async (req, reply) => slotDeleteHandler(req.body, reply));
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
