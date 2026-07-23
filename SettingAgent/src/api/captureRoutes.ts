import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { estimateAlign } from '../capture/frameAlign.js';
import { applyPlaceRoiUpdate, loadNormalizedPlaceRoi } from '../capture/placeRoi.js';
import type { CaptureJob } from '../capture/CaptureJob.js';
import type { Finalizer } from '../capture/Finalizer.js';
import type { SetupPipeline } from '../pipeline/SetupPipeline.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { ICameraClient } from '../clients/CameraClient.js';
import type { CameraSource } from '../viewer/CameraSource.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import { runDetect, loadDetectCfg } from '../capture/detectPipeline.js';
import { loadRoiIntoDb, loadSetupTargetsFromRoi, roiToCameraViews } from '../capture/roiDbLoad.js';
import type { SetupTarget } from '../setup/SetupOrchestrator.js';
import { loadSetupTargets, viewsToTargets, parseCameraViews, type MapFiles } from '../setup/mapTargets.js';
import { buildGroundInputs } from '../ground/groundInputs.js';
import { estimateGroundModels } from '../ground/groundModel.js';
import { buildFrameCuboids } from '../ground/frameCuboids.js';
import { buildSlotFrontCenters } from '../ground/frontCenterBuild.js';
import { makeCuboidContextResolver, type CuboidContextResolver } from '../ground/cuboidContext.js';
import { filterVehiclesOnPlace } from '../capture/onPlaceFilter.js';
import { assignPlatesToSlotViews } from '../setup/plateMatch.js';
import type { NormalizedQuad } from '../domain/types.js';
import type { PlateBox } from '../clients/LpdClient.js';
import type { GroundModel } from '../ground/types.js';
import { writeCamerapos } from '../setup/cameraposWriter.js';
import type { PresetProvider } from '../setup/presetProvider.js';
import type { SetupBrain } from '../brain/SetupBrain.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { SaveStore } from '../store/SaveStore.js';
import { validateArtifactBody } from './artifactSchema.js';
import { stringify5 } from '../util/round.js';
import { buildOccupyRegionsBySlot } from '../domain/occupancyRegion.js';
import { writeSetupResultFiles } from '../store/setupResult.js';
import type { SlotLpdRow } from '../capture/types.js';
import { parseOr400, fileErrorReply, parseCamPreset, sendJpeg, resolveSourceCamera } from './routeHelpers.js';

/** POST /capture/slots/lpd — 라이브 LPD 검출을 slot_setup.lpd 에 저장. plates 빈 배열 허용(0건). */
const SlotLpdSaveSchema = z.object({
  cam: z.number().int().positive(),
  preset: z.number().int().positive(),
  plates: z.array(
    z.object({
      quad: z.array(z.object({ x: z.number(), y: z.number() })).length(4),
      confidence: z.number().optional(),
    }),
  ),
});

/** POST /capture/slots/occupy — DB lpd 로 점유영역 생성. cam/preset 미지정 시 전 프리셋. */
const SlotOccupyBuildSchema = z
  .object({
    cam: z.number().int().positive().optional(),
    preset: z.number().int().positive().optional(),
  })
  .default({});

/** POST /capture/slots/cuboid — 지면모델로 3D 육면체 앞면 중심 산출·저장. heightM 미지정 시 H_CONST. */
const SlotCuboidBuildSchema = z
  .object({
    heightM: z.number().min(0.5).max(3.0).optional(),
  })
  .default({});

const TargetSchema = z.object({
  camIdx: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  label: z.string().optional(),
  ptz: z.object({ pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().optional() }).optional(),
});

const StartBodySchema = z.object({
  count: z.number().int().positive(),
  intervalMs: z.number().int().positive().optional(),
  checkpointEvery: z.number().int().positive().optional(),
  checkpointTriggerMode: z.enum(['rounds', 'time']).optional(),
  checkpointIntervalMs: z.number().int().positive().optional(),
  targets: z.array(TargetSchema).min(1).optional(),
  /** 바닥 ROI 소스 모드(옵셔널·하위호환). 미지정/true=LLM 생성, false=파일 모드(LLM floor 스킵). */
  floorRoiUseLlm: z.boolean().optional(),
  /** VPD 검출 모드(옵셔널·하위호환). 미지정/true=주차면 위 차량만, false=모든 차량. */
  vpdOnParkingOnly: z.boolean().optional(),
  /** VPD(차량) 검출 게이트(옵셔널). 라우트 기본 false(제품 정책 — 자동 경로 VPD 정지). LPD 는 계속. */
  vpdEnabled: z.boolean().optional(),
  /** 원버튼 셋업: 수집 done 후 자동 최종화+센터라이징 연쇄(옵셔널·기본 false, 명시적 옵트인). */
  autoChain: z.boolean().optional(),
});

/** POST /capture/start-precise — 정밀수집 파이프라인 시작. source 미지정 시 파이프라인 카메라(기존 동작). */
const StartPreciseBodySchema = z
  .object({
    source: z.string().min(1).optional(),
    /** 센터라이징 분리(옵셔널·기본 false) — true 면 탐색·점유영역까지만 돌고 센터라이징 전에 done. */
    skipCentering: z.boolean().optional(),
  })
  .default({});

const FinalizeBodySchema = z
  .object({
    /** 프론트 로직 점유 스냅샷(옵셔널, R4) — Finalizer 가 LLM 인메모리 저장분과 1회 비교(best-effort). */
    occupancy: z
      .array(
        z.object({
          key: z.string(),
          spaces: z.array(z.object({ idx: z.number().int(), occupied: z.boolean() })),
        }),
      )
      .optional(),
  })
  .default({});

const DetectBodySchema = z.object({
  cam: z.number().int().positive(),
  preset: z.number().int().positive(),
  /** VPD 검출 모드(옵셔널). 미지정/true=주차면 위 차량만, false=모든 차량. */
  vpdOnParkingOnly: z.boolean().optional(),
  /** VPD(차량) 검출 게이트(옵셔널). 라우트 기본 false(제품 정책). '검출 실행'=LPD only, 'VPD 검출' 버튼만 true. */
  vpdEnabled: z.boolean().optional(),
  /** base 프레임 PTZ 오버라이드(옵셔널, lpd-live). 제공 시 프리셋 대신 이 PTZ 로 재렌더 후 검출. 미지정=프리셋 경로. */
  ptz: z.object({ pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().optional() }).optional(),
});

// 주차면 자동보정(§04): 기준 저장·자동보정은 {cam,preset}, place-roi 저장은 {camId,presetIdx,spaces}.
const RefFrameBodySchema = z.object({ cam: z.number().int().positive(), preset: z.number().int().positive() });
const PlaceRoiPutSchema = z.object({
  camId: z.number().int().positive(),
  presetIdx: z.number().int().positive(),
  spaces: z.array(
    z.object({
      idx: z.number().int(),
      points: z.array(z.object({ x: z.number(), y: z.number() })),
    }),
  ),
});

// 자동보정 다운스케일 그리드·탐색 파라미터(정규화 오프셋은 다운스케일 불변). 이동+스케일만(회전·원근 미보정).
const ALIGN_W = 128;
const ALIGN_H = 72;
const ALIGN_MAX_SHIFT = 12; // ±12/128 ≈ ±9.4% 이동 탐색.
const ALIGN_SCALES = Array.from({ length: 11 }, (_, i) => 0.9 + i * 0.02); // 0.9~1.1 step 0.02.

/** JPEG 버퍼 → 고정 그리드 그레이 배열(sharp 픽셀 추출만; 상호상관은 순수 함수). */
async function jpegToGray(jpg: Buffer, w: number, h: number): Promise<Uint8Array> {
  const raw = await sharp(jpg).greyscale().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

export interface CaptureRouteDeps {
  job: CaptureJob;
  finalizer: Finalizer;
  store: SqliteStore;
  cfg: ToolsConfig['capture'];
  /** targets 미지정 시 camerapos 파일에서 로드(공급자 없을 때의 폴백). */
  mapFiles?: MapFiles;
  /**
   * 라이브 프리셋 공급자(A=unity-api 등). 주입되면 start 시 캐시(camerapos.json) 대신
   * 항상 새로 받아 사용한다(이전 프리셋 순서 캐싱 제거). cameraposFile 이 있으면 받은 목록으로 갱신도 한다.
   */
  presetProvider?: PresetProvider | null;
  /** LLM 두뇌(옵셔널 — POST /capture/warmup 수동 강제 구동용). */
  brain?: SetupBrain;
  /** 정밀수집 결과 저장/열기(save/*) 스토어. 주입 시 save/saves 라우트 등록(가산). */
  saveStore?: SaveStore;
  /** 미리 정의된 주차면 폴리곤 파일(Place01/PtzCamRoi.json) 경로. 주입 시 GET/PUT /capture/place-roi 서빙(가산). */
  placeRoiFile?: string;
  /** 자동보정 기준 프레임 저장 디렉터리(data/refframes). camera 와 함께 주입 시 refframe/autocorrect 등록(가산). */
  refFrameDir?: string;
  /** 지면모델 설정. placeRoiFile 과 함께 주입 시 GET /capture/ground-model 등록(가산). */
  ground?: ToolsConfig['ground'];
  /** 라이브 검출(POST /capture/detect)·자동보정용 카메라 클라이언트. fov 메타는 placeRoiFile 에서 도출. */
  camera?: ICameraClient;
  vpd?: VpdClient;
  lpd?: LpdClient;
  /** 원버튼 셋업 파이프라인(옵셔널·가산). 주입 시 autoChain 배선 + GET /capture/pipeline 등록. */
  pipeline?: SetupPipeline;
  /** 카메라 소스 레지스트리(옵셔널·가산). 주입 시에만 POST /capture/start-precise 의 source 지정을 처리한다. */
  sources?: Map<string, CameraSource>;
  /** CameraSourceClient 조립용 카메라 설정(zoom 클램프). sources 와 함께 주입된다. */
  cameraCfg?: ToolsConfig['camera'];
}

/**
 * /capture/* 라우트 등록(설계서 §6.1). 기존 /setup/* 불변·가산.
 * 좌표·집계·LLM 로직은 CaptureJob/Finalizer 소유. 라우트는 얇은 진입점.
 */
export function registerCaptureRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  registerCaptureLifecycle(app, deps);
  registerSlotRoutes(app, deps);
  registerSaveRoutes(app, deps);
  registerPlaceRoiRoutes(app, deps);
  registerGroundRoutes(app, deps);
  registerRefframeRoutes(app, deps);
  registerDetectRoute(app, deps);
}

/** 수집 생명주기(start/status/pipeline/warmup/frame/stop/finalize/aggregate/occupancy). */
function registerCaptureLifecycle(app: FastifyInstance, deps: CaptureRouteDeps): void {
  app.post('/capture/start', (req, reply) => handleCaptureStart(deps, req, reply));

  app.get('/capture/status', async () => deps.job.getStatus());

  // 원버튼 셋업 파이프라인 상태(가산). 주입 시에만 등록 — CaptureStatus shape 은 불변(회귀 0).
  if (deps.pipeline) {
    const pipeline = deps.pipeline;
    app.get('/capture/pipeline', async () => pipeline.getStatus());

    // ★ 정밀수집 '시작'(W2) — 반복 관측 수집 없이 **LPD 탐색 → 점유영역 → 센터라이징 → setup_result** 만 돈다.
    //   얇은 진입점: 대기시간·단계전이·가드는 전부 SetupPipeline.startPrecise 소유. source 해석은
    //   POST /calibrate/point(calibrateRoutes.ts)의 관용구를 그대로 복제한다(요청마다 얇은 어댑터, 상태 없음).
    app.post('/capture/start-precise', (req, reply) => handleStartPrecise(deps, req, reply));
  }

  // LLM 강제 구동(warm-up). 사용자가 필요할 때 즉시 모델 로드. best-effort — { ok } 반환(미주입/비활성 시 false).
  app.post('/capture/warmup', async () => {
    const ok = await deps.brain?.warmup?.();
    return { ok: ok ?? false };
  });

  // 최근 캡처 프레임(수집 과정 관찰용). 카메라 재명령 없이 잡이 방금 찍은 JPEG 그대로.
  app.get('/capture/frame', (req, reply) => handleCaptureFrame(deps, req, reply));

  app.post('/capture/stop', async (_req, reply) => {
    const st = deps.job.getStatus();
    if (st.state !== 'running') {
      reply.code(400);
      return { error: 'not running', state: st.state };
    }
    deps.job.stop();
    return { ok: true, state: deps.job.getStatus().state };
  });

  app.post('/capture/finalize', (req, reply) => handleCaptureFinalize(deps, req, reply));

  // 현재 잡 인메모리 집계(구 /capture/runs/:id/aggregate — run_id 폐기, 설계서 §3). AggregatedSlot[] 동일 shape.
  app.get('/capture/aggregate', async () => deps.job.getAggregated());

  // 차량 점유율(축소 보조·인메모리) 프리셋별 조회(구 /capture/runs/:id/occupancy). LLM off 시 []. rows shape 유지.
  app.get('/capture/occupancy', async () => deps.job.getOccupancy());
}

/** POST /capture/start 핸들러 본문(등록기에서 분리 — 로직 불변). */
async function handleCaptureStart(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const parsed = parseOr400(reply, StartBodySchema, req.body ?? {});
    if (!parsed) return;
    let targets: SetupTarget[];
    if (parsed.targets && parsed.targets.length > 0) {
      targets = parsed.targets;
    } else if (deps.presetProvider) {
      // 항상 라이브 갱신: 공급자(Unity /cameras 등)에서 새 프리셋 목록을 받아 사용한다.
      // → 캐시된 camerapos.json 의 옛 프리셋 순서를 쓰지 않는다. cameraposFile 이 있으면 함께 갱신.
      try {
        const views = await deps.presetProvider.listViews();
        if (deps.mapFiles?.cameraposFile) writeCamerapos(views, deps.mapFiles.cameraposFile);
        targets = viewsToTargets(views);
      } catch (err) {
        reply.code(400);
        return { error: 'live preset refresh failed', detail: err instanceof Error ? err.message : String(err) };
      }
    } else if (deps.placeRoiFile && loadSetupTargetsFromRoi(deps.placeRoiFile).length > 0) {
      // ROI 정본이 프리셋 PTZ 를 담고 있으면 그것이 순회 대상 — camerapos.json 보다 우선한다.
      // "ROI 로딩 → 시작" 이 같은 파일 하나를 공유하게 되어 프리셋 집합이 어긋나지 않는다.
      // (PTZ 미보유 구형 ROI 파일이면 길이 0 → 아래 camerapos 폴백 유지, 하위호환.)
      targets = loadSetupTargetsFromRoi(deps.placeRoiFile);
    } else if (deps.mapFiles) {
      try {
        targets = loadSetupTargets(deps.mapFiles);
      } catch (err) {
        reply.code(400);
        return { error: 'target resolve failed', detail: err instanceof Error ? err.message : String(err) };
      }
    } else {
      reply.code(400);
      return { error: 'targets 미지정 + presetProvider/mapFiles 미설정' };
    }
    if (targets.length === 0) {
      reply.code(400);
      return { error: 'targets 비어 있음' };
    }
    // 자동 체인 진행(finalize/calibrate) 중이면 새 수집 거부(F9 스냅샷 참조 안전하나 의미 혼선 방지, §3.5).
    if (deps.pipeline?.isBusy()) {
      reply.code(409);
      return { error: 'pipeline busy', stage: deps.pipeline.getStatus().stage };
    }
    try {
      const { runId } = deps.job.start({
        count: parsed.count,
        intervalMs: parsed.intervalMs ?? deps.cfg.intervalMs,
        checkpointEvery: parsed.checkpointEvery ?? deps.cfg.checkpointEvery,
        checkpointTriggerMode: parsed.checkpointTriggerMode ?? deps.cfg.checkpointTriggerMode,
        checkpointIntervalMs: parsed.checkpointIntervalMs ?? deps.cfg.checkpointIntervalMs,
        targets,
        floorRoiUseLlm: parsed.floorRoiUseLlm,
        vpdOnParkingOnly: parsed.vpdOnParkingOnly,
        vpdEnabled: parsed.vpdEnabled ?? false, // 제품 정책: 자동 경로 VPD 정지(라우트 기본 OFF).
      });
      // 자동 체인 무장/해제(옵트인 — 기본 false). 비무장이면 파이프라인 콜백 전부 no-op(수동 흐름 회귀 0).
      // vpdEnabled 도 함께 전달 — F10 가드가 VPD off 흐름에서 finalize 부트스트랩을 막지 않도록(결정 E).
      deps.pipeline?.onCaptureStart(parsed.autoChain ?? false, parsed.vpdEnabled ?? false);
      return { ok: true, runId };
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : 'capture already running' };
    }
}

/** POST /capture/start-precise 핸들러 본문. deps.pipeline 은 등록 가드가 존재 보장. */
async function handleStartPrecise(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const pipeline = deps.pipeline!;
    const parsed = parseOr400(reply, StartPreciseBodySchema, req.body ?? {});
    if (!parsed) return;
    if (pipeline.isBusy()) {
      reply.code(409);
      return { error: 'pipeline busy', stage: pipeline.getStatus().stage };
    }
    const resolved = resolveSourceCamera(deps, parsed.source, reply);
    if (!resolved) return;
    const { camera, src } = resolved;
    // 요건13 분기 B — **조용한 강등 금지**. 리얼 소스는 프리셋 테이블이 없어(현재 위치 1개뿐) 프리셋 해석이
    // echo/0-0-1 폴백으로 떨어지고, 카메라를 엉뚱한 곳으로 보내며 잡이 끝까지 돈다. 시작 전에 끊는다.
    if (src) {
      let have: Set<string>;
      try {
        const list = await src.listCameras();
        have = new Set(list.cameras.flatMap((c) => c.presets.map((p) => `${c.camIdx}:${p.presetIdx}`)));
      } catch (err) {
        reply.code(502);
        return { error: 'source listCameras failed', detail: err instanceof Error ? err.message : String(err) };
      }
      const want = new Set(deps.store.getSlotSetup().map((v) => `${v.camId}:${v.presetId}`));
      const missing = [...want].filter((k) => !have.has(k));
      if (missing.length > 0) {
        reply.code(400);
        return {
          error: `리얼 소스는 프리셋 순회 미지원(소스 프리셋 ${have.size}개) — 시뮬레이터 소스로 실행하거나 슬롯을 현재 위치로 한정하세요`,
          missing,
        };
      }
    }
    try {
      const status = pipeline.startPrecise({
        ...(camera ? { camera } : {}),
        ...(parsed.skipCentering ? { skipCentering: true } : {}),
      });
      return { ok: status.stage !== 'failed', ...status };
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : String(err) };
    }
}

/** GET /capture/frame 핸들러 본문. */
async function handleCaptureFrame(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const q = req.query as { cam?: string; preset?: string };
    const latest = deps.job.getLastFrame();
    const presets = deps.job.getFramePresets();
    // ?cam=&preset= 지정 시 해당 프리셋 프레임(미리보기 순환용). 없으면 최신 프레임.
    let jpeg: Buffer | undefined;
    let camIdx: number | undefined;
    let presetIdx: number | undefined;
    if (q.cam !== undefined && q.preset !== undefined) {
      const c = Number(q.cam);
      const p = Number(q.preset);
      const buf = deps.job.getFrameByPreset(c, p);
      if (buf) {
        jpeg = buf;
        camIdx = c;
        presetIdx = p;
      }
    }
    if (!jpeg && latest) {
      jpeg = latest.jpeg;
      camIdx = latest.camIdx;
      presetIdx = latest.presetIdx;
    }
    if (!jpeg) {
      reply.code(404);
      return { error: 'no frame' };
    }
    sendJpeg(reply, jpeg, {
      'X-Cap-Cam': String(camIdx),
      'X-Cap-Preset': String(presetIdx),
      'X-Cap-Round': String(latest?.roundIdx ?? 0),
      // 이번 run 에서 캡처된 모든 프리셋(cam:preset) — 뷰어가 양쪽 카메라를 순환 표시.
      'X-Cap-Presets': presets.map((x) => `${x.camIdx}:${x.presetIdx}`).join(','),
    });
    return reply;
}

/** POST /capture/finalize 핸들러 본문. */
async function handleCaptureFinalize(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const parsed = parseOr400(reply, FinalizeBodySchema, req.body ?? {});
    if (!parsed) return;
    const st = deps.job.getStatus();
    if (st.state === 'running' || st.state === 'stopping' || st.state === 'finalizing') {
      reply.code(409);
      return { error: 'capture still running', state: st.state };
    }
    // run_id 폐기(설계서 §3) — 현재 잡의 인메모리 스냅샷으로 finalize(단일 현재 셋업 전제).
    try {
      const r = await deps.finalizer.finalize(deps.job.getSnapshot(), { logicOccupancy: parsed.occupancy });
      return {
        ok: true,
        slots: r.slots,
        globalCount: r.globalCount,
        ...(r.occupancyAgreement ? { occupancyAgreement: r.occupancyAgreement } : {}),
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** 슬롯 셋업 조회·검출 저장·점유·육면체·초기화·ROI 로딩(slots/reset/load-roi/lpd/occupy/cuboid). */
function registerSlotRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  // 슬롯 셋업(slot_setup) 정본 직접 조회(구 /capture/runs/:id/slots). presetKey 파생·slotId 포함(SlotSetupView).
  app.get('/capture/slots', async () => deps.store.getSlotSetup());

  // 검출·센터링 초기화(수동 버튼). slot_setup 의 vpd/lpd/occupy/ptz/centered/img1 만 비움 — slot_roi·행은 보존.
  app.post('/capture/slots/reset', async () => {
    const cleared = deps.store.clearSlotSetupEnrichment(new Date().toISOString());
    return { ok: true, cleared };
  });

  // ROI 파일 로딩(수동 버튼): PtzCamRoi.json → slot_setup 전량 재구성(검출·점유·센터링은 초기값).
  // 실패 시(파일 없음/파싱 실패/유효 슬롯 0건) DB 무변경 — 안전 규약은 loadRoiIntoDb 소유.
  app.post('/capture/slots/load-roi', (req, reply) => handleSlotsLoadRoi(deps, req, reply));

  // 라이브 LPD 검출 → 슬롯 공간배정 → slot_setup.lpd 부분 UPDATE(수동 "DB에 추가" 버튼). VPD 미접촉.
  app.post('/capture/slots/lpd', (req, reply) => handleSlotsLpd(deps, req, reply));

  // slot_setup.lpd(정본) → 점유영역(occupy_range) 결정형 재생성(수동 "점유영역 생성" 버튼).
  // 소스는 DB lpd 뿐 — 라이브 검출·차량 VPD 무관. lpd 없는 슬롯은 스킵(위장 생성 금지, 기존 값 무접촉).
  // 생성식은 뷰어 라이브 오버레이와 같은 번호판 기준 사다리꼴(domain/occupancyRegion) — 표시=저장 정합.
  app.post('/capture/slots/occupy', (req, reply) => handleSlotsOccupy(deps, req, reply));

  // 지면모델 → 슬롯별 3D 육면체 앞면 중심(slot3d_front_center) 산출·저장(수동 "3D육면체 ROI생성" 버튼).
  // 산출식은 finalize 와 **같은 단일 구현**(ground/slotFrontCenter), 지면모델 조합도 /capture/ground-model 과 동일.
  // 모델 없음/퇴화 슬롯은 skipped[] 로 드러내고 **저장하지 않는다**(기존 값 미파괴 — null 로 지우지 않음).
  app.post('/capture/slots/cuboid', (req, reply) => handleSlotsCuboid(deps, req, reply));
}

/** POST /capture/slots/load-roi 핸들러 본문. */
async function handleSlotsLoadRoi(deps: CaptureRouteDeps, _req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (!deps.placeRoiFile) {
      reply.code(404);
      return { ok: false, error: 'placeRoiFile 미설정' };
    }
    // 프리셋 라이브 선갱신(/capture/start 와 동일 패턴). slot_setup 은 preset_pos 를 FK 부모로 요구하므로,
    // camerapos.json 이 옛 프리셋만 담고 있으면 신규 카메라 주차면이 통째로 skipped 된다. 공급자가 있으면
    // 먼저 최신 프리셋을 받아 camerapos.json 을 갱신해 FK 부모를 확보한다. 실패는 강등(기존 파일로 진행).
    let presetRefresh: string | undefined;
    if (deps.presetProvider && deps.mapFiles?.cameraposFile) {
      try {
        writeCamerapos(await deps.presetProvider.listViews(), deps.mapFiles.cameraposFile);
      } catch (err) {
        presetRefresh = `프리셋 라이브 갱신 실패(기존 camerapos.json 사용): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const result = loadRoiIntoDb(deps.store, {
      placeRoiFile: deps.placeRoiFile,
      cameraposFile: deps.mapFiles?.cameraposFile,
      now: new Date().toISOString(),
    });
    if (presetRefresh) result.issues.push(presetRefresh);

    // ★ camerapos.json 을 ROI 정본에서 파생 재생성한다.
    // 뷰어의 카메라·프리셋 드롭다운과 프리셋 이동 PTZ 는 CameraposSource → camerapos.json 이 정본이다
    // (`src/viewer/CameraposSource.ts` — cam.list 는 연결·이름 확인용일 뿐, 목록은 파일 기준).
    // 이 파일이 뒤처지면 **화면은 옛 PTZ 로 이동하는데 오버레이·지면모델은 새 ROI 기준**이라
    // 육면체·주차면이 실제 장면과 어긋난 위치에 그려진다(실측: cam1 preset3 pan 43.5 vs 90.1).
    // ROI 가 프리셋 PTZ 를 담고 있을 때만 덮어쓴다(구형 ROI 파일이면 기존 파일 보존).
    if (result.ok && deps.mapFiles?.cameraposFile) {
      try {
        const views = roiToCameraViews(JSON.parse(await readFile(deps.placeRoiFile, 'utf8')));
        if (views.length > 0) {
          writeCamerapos(views, deps.mapFiles.cameraposFile);
          result.issues.push(`camerapos.json 을 ROI 정본으로 갱신(${views.length} 프리셋) — 카메라·프리셋 목록 정합`);
        }
      } catch (err) {
        result.issues.push(`camerapos.json 갱신 실패(기존 파일 유지): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ★ 앞면 중심(slot3d_front_center) 자동 산출·저장 — W6 공유(수동 '3D육면체 ROI생성' 버튼과 같은 함수).
    // 근거: 화면의 육면체·앞면중심은 클라이언트 라이브 오버레이라 DB 컬럼이 비어 있어도 "이미 있다"고 보인다.
    // 그런데 LPD 탐색 대상 조건은 그 컬럼이다(plateDiscoveryWriter.expandDiscoveryTargets) → 대상 0.
    // 로딩이 성공(result.ok)했을 때만 수행하고, 실패는 **로딩을 죽이지 않고** issues[] 로 강등한다
    // (위 presetRefresh·camerapos 갱신과 동일 규약). 슬롯 단위 실패는 skipped[] 로 드러난다(위장 저장 금지).
    if (result.ok) {
      if (!deps.ground?.enabled) {
        result.issues.push('앞면 중심 미산출 — 지면모델 비활성(ground.enabled=false)');
      } else {
        try {
          const fc = await buildSlotFrontCenters(deps.store, {
            placeRoiFile: deps.placeRoiFile,
            cameraposFile: deps.mapFiles?.cameraposFile,
            ground: deps.ground,
          });
          result.issues.push(`앞면 중심 산출 ${fc.updated}건 / 스킵 ${fc.skipped.length}건(h=${fc.heightM}m)`);
        } catch (err) {
          result.issues.push(`앞면 중심 미산출 — 지면모델 산출 실패: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (!result.ok) reply.code(409);
    return result;
}

/** POST /capture/slots/lpd 핸들러 본문. */
async function handleSlotsLpd(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const parsed = SlotLpdSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'invalid body' };
    }
    const { cam, preset, plates } = parsed.data;
    const views = deps.store
      .getSlotSetup()
      .filter((v) => v.camId === cam && v.presetId === preset && v.roi?.length >= 3);
    const plateBoxes: PlateBox[] = plates.map((p) => ({
      quad: p.quad as NormalizedQuad,
      confidence: p.confidence ?? 0,
      cls: 'car_license_plate',
    }));
    const assigned = assignPlatesToSlotViews(views, plateBoxes);
    const now = new Date().toISOString();
    const rows = [...assigned].map(([slotId, quad]) => ({ slotId, lpdObb: stringify5(quad), updatedAt: now }));
    deps.store.upsertSlotLpd(rows);
    // 반환 quad 는 입력 plate.quad 참조 보존(plateMatch 계약) → 참조 역조회로 원 confidence 부착.
    const assignedOut = [...assigned].map(([slotId, quad]) => {
      const src = plateBoxes.find((p) => p.quad === quad);
      return src ? { slotId, confidence: src.confidence } : { slotId };
    });
    return { ok: true, updated: rows.length, assigned: assignedOut, unassigned: plates.length - assigned.size };
}

/** POST /capture/slots/occupy 핸들러 본문. */
async function handleSlotsOccupy(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const parsed = SlotOccupyBuildSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'invalid body' };
    }
    const { cam, preset } = parsed.data;
    const views = deps.store
      .getSlotSetup()
      .filter((v) => (cam == null || v.camId === cam) && (preset == null || v.presetId === preset));
    const now = new Date().toISOString();
    // 겹침 회피 배율 탐색이 프레임 단위 집합 연산 → **프리셋별로 묶어** 한 번에 생성(뷰어 라이브와 동일 규약).
    const byPreset = new Map<string, typeof views>();
    for (const v of views) {
      if (!v.lpd) continue; // lpd 부재 → 생성 근거 없음(스킵).
      const key = `${v.camId}:${v.presetId}`;
      const g = byPreset.get(key) ?? [];
      g.push(v);
      byPreset.set(key, g);
    }
    const rows: SlotLpdRow[] = [];
    let withLpd = 0;
    for (const group of byPreset.values()) {
      withLpd += group.length;
      const regions = buildOccupyRegionsBySlot(group.map((v) => ({ slotId: v.slotId, quad: v.lpd! })));
      for (const v of group) {
        const poly = regions.get(v.slotId);
        if (!poly) continue; // 퇴화 quad·화면 밖 → 생성 실패(기존 값 보존, 위장 금지).
        rows.push({
          slotId: v.slotId,
          lpdObb: stringify5(v.lpd!), // upsertSlotLpd 는 lpd 도 함께 쓰므로 현재 값을 그대로 되쓴다(무변경).
          occupyRange: stringify5(poly),
          updatedAt: now,
        });
      }
    }
    if (rows.length > 0) deps.store.upsertSlotLpd(rows);
    return { ok: true, updated: rows.length, skipped: views.length - withLpd, failed: withLpd - rows.length };
}

/** POST /capture/slots/cuboid 핸들러 본문. */
async function handleSlotsCuboid(deps: CaptureRouteDeps, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const parsed = SlotCuboidBuildSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'invalid body (heightM 0.5~3.0)' };
    }
    if (!deps.placeRoiFile || !deps.ground?.enabled) {
      reply.code(404);
      return { ok: false, error: 'ground/place-roi 미설정' };
    }
    if (deps.store.getSlotSetup().length === 0) {
      reply.code(409);
      return { ok: false, error: 'slot_setup 비어있음 — ROI 파일 로딩 먼저' };
    }
    // 산출·저장은 buildSlotFrontCenters(W6) 단일 구현 — ROI 로딩 자동 경로와 **같은 함수**를 쓴다.
    try {
      const r = await buildSlotFrontCenters(deps.store, {
        placeRoiFile: deps.placeRoiFile,
        cameraposFile: deps.mapFiles?.cameraposFile,
        ground: deps.ground,
        ...(parsed.data.heightM !== undefined ? { heightM: parsed.data.heightM } : {}),
      });
      return { ok: true, ...r };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      reply.code(e.code === 'ENOENT' ? 404 : 500);
      return { ok: false, error: e.code === 'ENOENT' ? 'PtzCamRoi.json 없음' : 'ground-model 산출 실패', detail: e.message };
    }
}

/** 정밀수집 결과 저장/열기(save/setup-result/saves). saveStore 주입 시에만 등록(가산). */
function registerSaveRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  // 정밀수집 결과 저장/열기(save/*). saveStore 주입 시에만 등록(가산). 라우트는 위임만.
  if (deps.saveStore) {
    const saveStore = deps.saveStore;

    // 결과 저장: 현재 화면 상태(state.mapping)를 이름 지정 스냅샷으로 기록(동명 덮어쓰기).
    app.post('/capture/save', async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; artifact?: unknown };
      const safe = saveStore.sanitizeName(body.name);
      if (!safe) {
        reply.code(400);
        return { error: 'invalid name' };
      }
      const v = validateArtifactBody(body.artifact);
      if (!v.ok) {
        reply.code(v.code);
        return v.body;
      }
      saveStore.save(safe, v.artifact);
      return { ok: true, name: safe, slots: v.artifact.slots.length, globalCount: v.artifact.globalIndex.length };
    });

    // 최종 결과물 수동 생성(캘리브레이션 패널 'result 파일 생성'). 소스=DB slot_setup 정본(현재 값 그대로).
    // 센터라이징 잡 done 경로와 **같은 진입점**(writeSetupResultFiles) → 이력본+고정본 2벌 동일 산출.
    app.post('/capture/setup-result', async (_req, reply) => {
      const write = writeSetupResultFiles(deps.store.getSlotSetup(), saveStore);
      if (!write.archive && !write.fixed) {
        reply.code(500);
        return { ok: false, error: 'save failed' };
      }
      return { ok: true, slots: write.result.slots.length, archive: write.archive, fixed: write.fixed };
    });

    // 저장 목록(mtime 내림차순).
    app.get('/capture/saves', async () => ({ saves: saveStore.list() }));

    // 특정 결과 열기 → SetupArtifact(GET /mapping 과 동일 shape, 클라이언트 재사용).
    app.get('/capture/saves/:name', async (req, reply) => {
      const safe = saveStore.sanitizeName((req.params as { name: string }).name);
      if (!safe) {
        reply.code(400);
        return { error: 'invalid name' };
      }
      const artifact = saveStore.load(safe);
      if (!artifact) {
        reply.code(404);
        return { error: 'not found' };
      }
      return artifact;
    });
  }
}

/** 미리 정의된 주차면 폴리곤(PtzCamRoi.json) GET/PUT. */
function registerPlaceRoiRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  // 미리 정의된 주차면 폴리곤(PtzCamRoi.json) raw JSON 서빙. 정규화는 클라이언트(core.js normalizePtzCamRoi).
  // 파일 미설정=404, 파일 없음(ENOENT)=404, 읽기/파싱 실패=500(대칭).
  app.get('/capture/place-roi', async (_req, reply) => {
    if (!deps.placeRoiFile) {
      reply.code(404);
      return { error: 'place-roi 미설정' };
    }
    try {
      const raw = await readFile(deps.placeRoiFile, 'utf8');
      return JSON.parse(raw); // raw JSON 그대로 반환(정규화는 클라이언트 core.js).
    } catch (err) {
      fileErrorReply(reply, err, 'PtzCamRoi.json 없음', '읽기/파싱 실패');
      return;
    }
  });

  // 자동보정 결과(정규화 spaces)를 PtzCamRoi.json 에 저장(§04). GET place-roi 와 대칭·무토큰(/capture/* 관례).
  // 파일 미설정=404, 읽기/쓰기/파싱 실패=500. applyPlaceRoiUpdate 로 픽셀 역변환·구조 보존.
  app.put('/capture/place-roi', async (req, reply) => {
    if (!deps.placeRoiFile) {
      reply.code(404);
      return { error: 'place-roi 미설정' };
    }
    const parsed = parseOr400(reply, PlaceRoiPutSchema, req.body ?? {});
    if (!parsed) return;
    try {
      const raw = await readFile(deps.placeRoiFile, 'utf8');
      const next = applyPlaceRoiUpdate(JSON.parse(raw), parsed);
      await writeFile(deps.placeRoiFile, stringify5(next, 2), 'utf8');
      return { ok: true, spaceCount: parsed.spaces.length };
    } catch (err) {
      fileErrorReply(reply, err, 'PtzCamRoi.json 없음', 'place-roi 쓰기 실패');
      return;
    }
  });
}

/** 지면모델·차량 육면체·잡 육면체(ground-model/vehicle-cuboids/job-cuboids). */
function registerGroundRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  // 프리셋별 지면모델(GroundModel) 산출 — 3D 육면체 렌더의 유일한 근거(설계 1단계).
  // 입력은 이미지 위의 점(PtzCamRoi.json)과 zoom(camerapos) 뿐 — Unity camera 블록(position/eulerAngles/fov)
  // 은 쓰지 않는다(실카메라 호환). 추정은 전부 서버 소유, 뷰어는 투영만 한다(이중구현 회피).
  // 파일 미설정/ground.enabled=false → 404. 추정 실패 프리셋은 models 에서 빠진다(육면체 미표시 + issues).
  app.get('/capture/ground-model', (req, reply) => handleGroundModel(deps, req, reply));

  // 육면체 문맥 해결자 — **단일 구현**(`ground/cuboidContext.ts`). `CaptureJob`(index.ts 조립)도 **같은 팩토리**를 쓴다.
  //   → ground-model · vehicle-cuboids · detect · CaptureJob 4중복 제거(이중구현 금지 규약).
  const resolveCuboidContext = makeCuboidContextResolver({
    placeRoiFile: deps.placeRoiFile,
    cameraposFile: deps.mapFiles?.cameraposFile,
    ground: deps.ground,
  });

  // ★ 차량 3D 육면체 — **라이브 촬영 1회**(임의 프리셋 진단용). 잡·검출 없이도 육면체를 볼 수 있는 유일한 수단.
  //   ⚠️ 내부는 `buildFrameCuboids`(det 권위 + det↔seg 정합)로 **교체**되었다(리더 Q1=나 승인).
  //     이전 구현은 **seg 를 권위**로 차량 목록을 만들었다 → 잡·검출 경로(det 권위)와 **다른 차량 집합**을 낼 수 있었다.
  //     "두 개의 다른 진실"을 없앤다 — 세 표면이 같은 함수를 부른다. VPD 호출은 1→2회(det + seg)가 된다.
  //   404: vpd.segPath 미배선 / ground·place-roi 미설정. 그 외 실패는 전부 200 + issues·summary 로 드러난다.
  if (deps.camera && deps.vpd) {
    app.get('/capture/vehicle-cuboids', (req, reply) => handleVehicleCuboids(deps, resolveCuboidContext, req, reply));
  }

  // ★ 정밀수집 잡이 **방금 찍은 프레임**의 육면체(인메모리 읽기 — **카메라 호출 0 · VPD 호출 0**).
  //   라이브 촬영 라우트(/capture/vehicle-cuboids)를 잡 경로에 쓰면 (a) 화면에 뜬 프레임과 **다른 프레임**의
  //   육면체를 그리게 되고, (b) 잡이 PTZ 를 돌리는 중에 **카메라를 뺏는다**. → 잡 경로는 반드시 이 라우트를 쓴다.
  app.get('/capture/job-cuboids', async (req, reply) => {
    const cp = parseCamPreset(reply, req.query);
    if (!cp) return;
    const { cam, preset } = cp;
    const c = deps.job.getCuboids(cam, preset);
    if (!c) {
      reply.code(404);
      return { error: `cam${cam} preset${preset} 육면체 없음(잡 미실행 / 해당 프리셋 미촬영 / 육면체 기능 off)` };
    }
    return c;
  });
}

/** GET /capture/ground-model 핸들러 본문. */
async function handleGroundModel(deps: CaptureRouteDeps, _req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (!deps.placeRoiFile || !deps.ground?.enabled) {
      reply.code(404);
      return { error: 'ground-model 미설정' };
    }
    const ground = deps.ground;
    try {
      const raw = await readFile(deps.placeRoiFile, 'utf8');
      // zoom 소스(camerapos). 없으면 zoom=null → 프리셋 단독 f 로 강등(issues 에 기록).
      let views: ReturnType<typeof parseCameraViews> = [];
      if (deps.mapFiles?.cameraposFile) {
        try {
          views = parseCameraViews(JSON.parse(await readFile(deps.mapFiles.cameraposFile, 'utf8')));
        } catch {
          /* camerapos 없음/파싱실패 → zoom 미상 강등 */
        }
      }
      const models: GroundModel[] = [];
      const issues: string[] = [];
      let fovBaseV: number | null = null;
      for (const cam of buildGroundInputs(JSON.parse(raw), views)) {
        const r = estimateGroundModels(cam, ground);
        models.push(...r.models);
        issues.push(...r.issues);
        if (r.fovBaseV != null) fovBaseV = r.fovBaseV; // 단일 카메라 전제(현 데이터). 다중이면 마지막 값.
      }
      return { models, fovBaseV, issues };
    } catch (err) {
      fileErrorReply(reply, err, 'PtzCamRoi.json 없음', 'ground-model 산출 실패');
      return;
    }
}

/** GET /capture/vehicle-cuboids 핸들러 본문. deps.camera/deps.vpd 는 등록 가드가 존재 보장. */
async function handleVehicleCuboids(
  deps: CaptureRouteDeps,
  resolveCuboidContext: CuboidContextResolver,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
    const camera = deps.camera!;
    const vpd = deps.vpd!;
      if (!vpd.canSegment()) {
        reply.code(404);
        return { error: 'vpd.segPath 미설정 — 세그멘테이션 미배선' };
      }
      if (!deps.placeRoiFile || !deps.ground?.enabled) {
        reply.code(404);
        return { error: 'ground/place-roi 미설정' };
      }
      const q = req.query as { cam?: string; preset?: string; onPlace?: string };
      const cp = parseCamPreset(reply, q);
      if (!cp) return;
      const { cam, preset } = cp;
      const onPlace = q.onPlace === undefined ? true : q.onPlace !== '0'; // 모드 A 기본 on(§D).
      try {
        const ctx = await resolveCuboidContext(cam, preset);
        // 지면모델 없음 → **촬영하지 않고** 즉시 강등 응답(OBS-2). 어차피 육면체를 만들 수 없는데
        // 카메라를 1회 헛촬영하면 잡과 PTZ 를 다툰다(이전 구현의 조기 return 거동을 유지한다).
        if (!ctx) {
          return {
            cam,
            preset,
            imgW: 0,
            imgH: 0,
            cuboids: [],
            rejected: [],
            unmatched: [],
            assoc: [],
            anchor: { depthDevM: null, phaseDevM: null, unmatchedRate: null, n: 0, issues: [] },
            summary: {
              detCount: 0, segCount: 0, kept: 0, filteredOut: 0, matched: 0, unmatchedDet: 0, segOnly: 0,
              cuboidCount: 0, rejectedCount: 0, segDegraded: false, maskMismatch: 0, segMs: 0, buildMs: 0,
              detected: 0, onPlace, onPlaceDegraded: false,
            },
            issues: [`cam${cam} preset${preset} 지면모델 없음 — 육면체 미산출`],
            estimateUnverified: true,
          };
        }
        const img = await camera.requestImage(cam, preset);
        // ★ det 가 권위 — 점유 판정이 쓰는 그 호출을 여기서도 그대로 쓴다(seg 권위 아님).
        const det = await vpd.detect(img.jpg);
        // [0.5] 주차면 필터(모드 A) — det rect 기준. 기존 filterVehiclesOnPlace 재사용(신규 기하 0줄).
        //   폴리곤 부재 → 전량 통과 + degraded(드롭 금지 — 기존 정책 동일).
        const polysNorm = ctx.slotPolysPx.length
          ? ctx.slotPolysPx.map((poly) => poly.map((p) => ({ x: p.x / ctx.model.imgW, y: p.y / ctx.model.imgH })))
          : null;
        const filt = onPlace
          ? filterVehiclesOnPlace(det.map((b, i) => ({ rect: b.rect, i })), polysNorm)
          : { kept: det.map((b, i) => ({ rect: b.rect, i })), filteredOut: 0, degraded: false };

        const fc = await buildFrameCuboids({
          jpeg: img.jpg,
          detBoxes: det, // ★ 권위 — 필터 전 전량(가림 배제의 근거).
          keptDetIdx: filt.kept.map((k) => k.i),
          vpd,
          ctx,
        });
        // ★ seg **호출 실패**(타임아웃·네트워크·5xx)는 이 라우트에서 **502** 다 — 사용자가 육면체를 달라고 물었는데
        //   VPD 에 닿지도 못한 것을 `200 + 빈 배열` 로 숨기지 않는다. (잡은 같은 상황에서 강등하고 계속 돈다.)
        //   ⚠️ 검출 0대로 인한 500(S-1)은 실패가 아니다 → `summary.segDegraded` 로 구분되며 200 을 유지한다.
        if (fc.segError) {
          reply.code(502);
          return { error: 'vehicle-cuboids failed', detail: fc.segError };
        }
        return {
          cam,
          preset,
          ...fc,
          summary: {
            ...fc.summary,
            /** @deprecated `summary.detCount` 를 써라(det 권위). 하위호환 별칭 — 뷰어·기존 테스트가 읽는다. */
            detected: fc.summary.detCount,
            onPlace,
            onPlaceDegraded: filt.degraded,
          },
          issues: fc.issues,
        };
      } catch (err) {
        reply.code(502);
        return { error: 'vehicle-cuboids failed', detail: err instanceof Error ? err.message : String(err) };
      }
}

/** 주차면 자동보정 기준 프레임 저장·상호상관(refframe/autocorrect). camera+refFrameDir 주입 시에만 등록(가산). */
function registerRefframeRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  // 주차면 자동보정 기준 프레임 저장·상호상관(§04). camera+refFrameDir 주입 시에만 등록(가산).
  if (deps.camera && deps.refFrameDir) {
    const camera = deps.camera;
    const refFrameDir = deps.refFrameDir;

    // 기준 프레임 저장: 현재 프리셋 캡처 → data/refframes/cam{c}_p{p}.jpg.
    app.post('/capture/refframe', async (req, reply) => {
      const parsed = parseOr400(reply, RefFrameBodySchema, req.body ?? {});
      if (!parsed) return;
      const { cam, preset } = parsed;
      try {
        const img = await camera.requestImage(cam, preset);
        await mkdir(refFrameDir, { recursive: true });
        const path = join(refFrameDir, `cam${cam}_p${preset}.jpg`);
        await writeFile(path, img.jpg);
        return { ok: true, path };
      } catch (err) {
        reply.code(502);
        return { error: 'refframe capture failed', detail: err instanceof Error ? err.message : String(err) };
      }
    });

    // 자동보정: 기준 프레임 vs 현재 프레임 → 그레이 다운스케일 → estimateAlign → 정규화 오프셋.
    // 기준 없음=404, sharp/캡처 실패=502. 이동+스케일만(회전·원근 미보정).
    app.post('/capture/autocorrect', async (req, reply) => {
      const parsed = parseOr400(reply, RefFrameBodySchema, req.body ?? {});
      if (!parsed) return;
      const { cam, preset } = parsed;
      let refBuf: Buffer;
      try {
        refBuf = await readFile(join(refFrameDir, `cam${cam}_p${preset}.jpg`));
      } catch {
        reply.code(404);
        return { error: '기준 프레임 없음 — 먼저 기준 저장' };
      }
      try {
        const cur = await camera.requestImage(cam, preset);
        const [refGray, curGray] = await Promise.all([
          jpegToGray(refBuf, ALIGN_W, ALIGN_H),
          jpegToGray(cur.jpg, ALIGN_W, ALIGN_H),
        ]);
        const { dx, dy, scale, peak } = estimateAlign(refGray, curGray, ALIGN_W, ALIGN_H, {
          scales: ALIGN_SCALES,
          maxShift: ALIGN_MAX_SHIFT,
        });
        return { ok: true, dx: dx / ALIGN_W, dy: dy / ALIGN_H, scale, peak, confidence: peak };
      } catch (err) {
        reply.code(502);
        return { error: 'autocorrect failed', detail: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}

/** 라이브 VPD/LPD 검출(detect). camera/vpd/lpd 주입 시에만 등록(가산). */
function registerDetectRoute(app: FastifyInstance, deps: CaptureRouteDeps): void {
  // 육면체 문맥 해결자 — registerGroundRoutes 와 **같은 팩토리**(`ground/cuboidContext.ts`) 단일 구현.
  const resolveCuboidContext = makeCuboidContextResolver({
    placeRoiFile: deps.placeRoiFile,
    cameraposFile: deps.mapFiles?.cameraposFile,
    ground: deps.ground,
  });

  // 라이브 VPD/LPD 검출(§04). 1프리셋 1회 멱등 — R2 반복(프리셋 순회·10회)은 리더/프론트 재호출 소유.
  // camera/vpd/lpd 주입 시에만 등록(가산). fovBaseV 는 지면모델 공동추정(placeRoi 점 + camerapos zoom)에서 도출.
  if (deps.camera && deps.vpd && deps.lpd) {
    const { camera, vpd, lpd } = deps;
    app.post('/capture/detect', async (req, reply) => {
      const parsed = parseOr400(reply, DetectBodySchema, req.body ?? {});
      if (!parsed) return;
      const { cam, preset } = parsed;
      try {
        // fovBaseV 는 지면모델 공동추정(이미지 점 + zoom) — Unity camera.fov 미사용(C3).
        // ground.enabled 는 /capture/ground-model 라우트 킬스위치일 뿐, 추정 수학 자체는 순수하므로 여기선 무관하게 쓴다.
        const cfg = await loadDetectCfg(deps.placeRoiFile, cam, {
          cameraposFile: deps.mapFiles?.cameraposFile,
          ground: deps.ground,
        });
        // 모드A(기본): 해당 프리셋 주차면 폴리곤 위 차량만. 폴리곤 부재 시 runDetect 가 강등(전량 통과 + 사유).
        const place = await loadNormalizedPlaceRoi(deps.placeRoiFile);
        const polys = place?.byPreset.get(`${cam}:${preset}`)?.map((s) => s.points) ?? null;
        // 육면체 문맥(가산). null → 응답에 `cuboids` 키 없음(기존 계약 불변).
        const cuboidCtx = await resolveCuboidContext(cam, preset);
        return await runDetect(
          { camera, vpd, lpd },
          { cam, preset, vpdEnabled: parsed.vpdEnabled ?? false, ptz: parsed.ptz }, // 제품 정책: 자동 경로(검출 실행) VPD 정지. ptz 지정 시 base 프레임 오버라이드(lpd-live).
          cfg,
          {
            onlyOnPlace: parsed.vpdOnParkingOnly ?? true,
            polys,
            degradeReason: place ? `프리셋 ${cam}:${preset} 주차면 0개` : '주차면 파일 없음/로드 실패',
          },
          cuboidCtx,
        );
      } catch (err) {
        reply.code(502);
        return { error: 'detect failed', detail: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}
