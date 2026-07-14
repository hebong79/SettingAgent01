import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { estimateAlign } from '../capture/frameAlign.js';
import { applyPlaceRoiUpdate, loadNormalizedPlaceRoi } from '../capture/placeRoi.js';
import type { CaptureJob } from '../capture/CaptureJob.js';
import type { Finalizer } from '../capture/Finalizer.js';
import type { SqliteStore } from '../capture/SqliteStore.js';
import type { ICameraClient } from '../clients/CameraClient.js';
import type { VpdClient } from '../clients/VpdClient.js';
import type { LpdClient } from '../clients/LpdClient.js';
import { runDetect, loadDetectCfg } from '../capture/detectPipeline.js';
import type { SetupTarget } from '../setup/SetupOrchestrator.js';
import { loadSetupTargets, viewsToTargets, parseCameraViews, type MapFiles } from '../setup/mapTargets.js';
import { buildGroundInputs } from '../ground/groundInputs.js';
import { estimateGroundModels } from '../ground/groundModel.js';
import type { GroundModel } from '../ground/types.js';
import { writeCamerapos } from '../setup/cameraposWriter.js';
import type { PresetProvider } from '../setup/presetProvider.js';
import type { SetupBrain } from '../brain/SetupBrain.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { SaveStore } from '../store/SaveStore.js';
import { validateArtifactBody } from './artifactSchema.js';

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
});

const FinalizeBodySchema = z
  .object({
    runId: z.number().int().positive().optional(),
    /** 프론트 로직 점유 스냅샷(옵셔널, R4) — Finalizer 가 LLM 저장분과 1회 비교(best-effort). */
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
}

/**
 * /capture/* 라우트 등록(설계서 §6.1). 기존 /setup/* 불변·가산.
 * 좌표·집계·LLM 로직은 CaptureJob/Finalizer 소유. 라우트는 얇은 진입점.
 */
export function registerCaptureRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  app.post('/capture/start', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    let targets: SetupTarget[];
    if (parsed.data.targets && parsed.data.targets.length > 0) {
      targets = parsed.data.targets;
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
    try {
      const { runId } = deps.job.start({
        count: parsed.data.count,
        intervalMs: parsed.data.intervalMs ?? deps.cfg.intervalMs,
        checkpointEvery: parsed.data.checkpointEvery ?? deps.cfg.checkpointEvery,
        checkpointTriggerMode: parsed.data.checkpointTriggerMode ?? deps.cfg.checkpointTriggerMode,
        checkpointIntervalMs: parsed.data.checkpointIntervalMs ?? deps.cfg.checkpointIntervalMs,
        targets,
        floorRoiUseLlm: parsed.data.floorRoiUseLlm,
        vpdOnParkingOnly: parsed.data.vpdOnParkingOnly,
      });
      return { ok: true, runId };
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : 'capture already running' };
    }
  });

  app.get('/capture/status', async () => deps.job.getStatus());

  // LLM 강제 구동(warm-up). 사용자가 필요할 때 즉시 모델 로드. best-effort — { ok } 반환(미주입/비활성 시 false).
  app.post('/capture/warmup', async () => {
    const ok = await deps.brain?.warmup?.();
    return { ok: ok ?? false };
  });

  // 최근 캡처 프레임(수집 과정 관찰용). 카메라 재명령 없이 잡이 방금 찍은 JPEG 그대로.
  app.get('/capture/frame', async (req, reply) => {
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
    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store')
      .header('X-Cap-Cam', String(camIdx))
      .header('X-Cap-Preset', String(presetIdx))
      .header('X-Cap-Round', String(latest?.roundIdx ?? 0))
      // 이번 run 에서 캡처된 모든 프리셋(cam:preset) — 뷰어가 양쪽 카메라를 순환 표시.
      .header('X-Cap-Presets', presets.map((x) => `${x.camIdx}:${x.presetIdx}`).join(','));
    return reply.send(jpeg);
  });

  app.post('/capture/stop', async (_req, reply) => {
    const st = deps.job.getStatus();
    if (st.state !== 'running') {
      reply.code(400);
      return { error: 'not running', state: st.state };
    }
    deps.job.stop();
    return { ok: true, state: deps.job.getStatus().state };
  });

  app.post('/capture/finalize', async (req, reply) => {
    const parsed = FinalizeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    const st = deps.job.getStatus();
    if (st.state === 'running' || st.state === 'stopping' || st.state === 'finalizing') {
      reply.code(409);
      return { error: 'capture still running', state: st.state };
    }
    const runId = parsed.data.runId ?? deps.job.getRunId() ?? deps.store.listRuns(1)[0]?.id;
    if (runId === undefined) {
      reply.code(404);
      return { error: 'no run to finalize' };
    }
    try {
      const r = await deps.finalizer.finalize(runId, { logicOccupancy: parsed.data.occupancy });
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
  });

  app.get('/capture/runs', async () => deps.store.listRuns());

  app.get('/capture/runs/:id/aggregate', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid run id' };
    }
    const run = deps.store.getRun(id);
    if (!run) {
      reply.code(404);
      return { error: 'run not found' };
    }
    return deps.store.getAggregatedSlots(id);
  });

  // 차량 점유율(LLM 판정) 프리셋별 최신 조회. /aggregate 미러(시각화는 이번 범위 밖 — 조회만).
  app.get('/capture/runs/:id/occupancy', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid run id' };
    }
    if (!deps.store.getRun(id)) {
      reply.code(404);
      return { error: 'run not found' };
    }
    return deps.store.getLatestOccupancy(id);
  });

  // 파일 바닥ROI 기준 주차면(finalize 저장분, §06) 프리셋별 조회. /occupancy 패턴 미러(id 검증 400 / run 없음 404).
  app.get('/capture/runs/:id/slots', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid run id' };
    }
    if (!deps.store.getRun(id)) {
      reply.code(404);
      return { error: 'run not found' };
    }
    return deps.store.getParkingSlots(id);
  });

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
      const e = err as NodeJS.ErrnoException;
      reply.code(e.code === 'ENOENT' ? 404 : 500);
      return { error: e.code === 'ENOENT' ? 'PtzCamRoi.json 없음' : '읽기/파싱 실패', detail: e.message };
    }
  });

  // 자동보정 결과(정규화 spaces)를 PtzCamRoi.json 에 저장(§04). GET place-roi 와 대칭·무토큰(/capture/* 관례).
  // 파일 미설정=404, 읽기/쓰기/파싱 실패=500. applyPlaceRoiUpdate 로 픽셀 역변환·구조 보존.
  app.put('/capture/place-roi', async (req, reply) => {
    if (!deps.placeRoiFile) {
      reply.code(404);
      return { error: 'place-roi 미설정' };
    }
    const parsed = PlaceRoiPutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid body', detail: parsed.error.flatten() };
    }
    try {
      const raw = await readFile(deps.placeRoiFile, 'utf8');
      const next = applyPlaceRoiUpdate(JSON.parse(raw), parsed.data);
      await writeFile(deps.placeRoiFile, JSON.stringify(next, null, 2), 'utf8');
      return { ok: true, spaceCount: parsed.data.spaces.length };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      reply.code(e.code === 'ENOENT' ? 404 : 500);
      return { error: e.code === 'ENOENT' ? 'PtzCamRoi.json 없음' : 'place-roi 쓰기 실패', detail: e.message };
    }
  });

  // 프리셋별 지면모델(GroundModel) 산출 — 3D 육면체 렌더의 유일한 근거(설계 1단계).
  // 입력은 이미지 위의 점(PtzCamRoi.json)과 zoom(camerapos) 뿐 — Unity camera 블록(position/eulerAngles/fov)
  // 은 쓰지 않는다(실카메라 호환). 추정은 전부 서버 소유, 뷰어는 투영만 한다(이중구현 회피).
  // 파일 미설정/ground.enabled=false → 404. 추정 실패 프리셋은 models 에서 빠진다(육면체 미표시 + issues).
  app.get('/capture/ground-model', async (_req, reply) => {
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
      const e = err as NodeJS.ErrnoException;
      reply.code(e.code === 'ENOENT' ? 404 : 500);
      return { error: e.code === 'ENOENT' ? 'PtzCamRoi.json 없음' : 'ground-model 산출 실패', detail: e.message };
    }
  });

  // 주차면 자동보정 기준 프레임 저장·상호상관(§04). camera+refFrameDir 주입 시에만 등록(가산).
  if (deps.camera && deps.refFrameDir) {
    const camera = deps.camera;
    const refFrameDir = deps.refFrameDir;

    // 기준 프레임 저장: 현재 프리셋 캡처 → data/refframes/cam{c}_p{p}.jpg.
    app.post('/capture/refframe', async (req, reply) => {
      const parsed = RefFrameBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid body', detail: parsed.error.flatten() };
      }
      const { cam, preset } = parsed.data;
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
      const parsed = RefFrameBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid body', detail: parsed.error.flatten() };
      }
      const { cam, preset } = parsed.data;
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

  // 라이브 VPD/LPD 검출(§04). 1프리셋 1회 멱등 — R2 반복(프리셋 순회·10회)은 리더/프론트 재호출 소유.
  // camera/vpd/lpd 주입 시에만 등록(가산). fovBaseV 는 지면모델 공동추정(placeRoi 점 + camerapos zoom)에서 도출.
  if (deps.camera && deps.vpd && deps.lpd) {
    const { camera, vpd, lpd } = deps;
    app.post('/capture/detect', async (req, reply) => {
      const parsed = DetectBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid body', detail: parsed.error.flatten() };
      }
      const { cam, preset } = parsed.data;
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
        return await runDetect({ camera, vpd, lpd }, { cam, preset }, cfg, {
          onlyOnPlace: parsed.data.vpdOnParkingOnly ?? true,
          polys,
          degradeReason: place ? `프리셋 ${cam}:${preset} 주차면 0개` : '주차면 파일 없음/로드 실패',
        });
      } catch (err) {
        reply.code(502);
        return { error: 'detect failed', detail: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}
