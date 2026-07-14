import { join } from 'node:path';
import { loadToolsConfig } from './config/toolsConfig.js';
import { loadLlmConfig } from './config/llmConfig.js';
import { RpcCameraClient } from './clients/RpcCameraClient.js';
import { VpdClient } from './clients/VpdClient.js';
import { LpdClient } from './clients/LpdClient.js';
import { Repository } from './store/Repository.js';
import { SaveStore } from './store/SaveStore.js';
import { SetupOrchestrator } from './setup/SetupOrchestrator.js';
import { createPresetProvider } from './setup/presetProvider.js';
import { AgentRuntime } from './brain/AgentRuntime.js';
import { buildServer } from './api/server.js';
import { buildSourceRegistry } from './viewer/sourceRegistry.js';
import { SqliteStore } from './capture/SqliteStore.js';
import { CheckpointReviewer } from './capture/CheckpointReviewer.js';
import { FloorRoiReviewer } from './capture/FloorRoiReviewer.js';
import { OccupancyReviewer } from './capture/OccupancyReviewer.js';
import { CaptureJob } from './capture/CaptureJob.js';
import { makeCuboidContextResolver } from './ground/cuboidContext.js';
import { Finalizer } from './capture/Finalizer.js';
import { PtzCalibrator } from './calibrate/PtzCalibrator.js';
import { CRpcClient } from './clients/CRpcClient.js';
import { loadExpectedFaces } from './setup/mapTargets.js';
import { logger } from './util/logger.js';

/** SettingAgent 부트스트랩: 두 config(도구/LLM)를 분리 로드 → 의존성 조립 → REST 서버 기동. */
async function main(): Promise<void> {
  const tools = loadToolsConfig();
  const llm = loadLlmConfig();

  // Unity JSON-RPC(방식 B). 뷰어 RPC 콘솔 + 카메라 도구(13110 /rpc) 공용 — camera 이전에 생성해 주입 재사용.
  const rpc = new CRpcClient(tools.unityRpc);
  // 카메라: 죽은 13100 REST 대신 13110 RPC 로 동작(setPTZ/captureJPG/ping). 프리셋 PTZ 는 camerapos.json.
  const camera = new RpcCameraClient({ rpc, cameraCfg: tools.camera, cameraposFile: tools.map.cameraposFile });
  const vpd = new VpdClient(tools.vpd);
  const lpd = new LpdClient(tools.lpd);
  const repo = new Repository(tools.store.dataDir);
  const saveStore = new SaveStore(tools.store.saveDir, tools.store.reportsDir);
  const brain = new AgentRuntime(llm);
  const orchestrator = new SetupOrchestrator({ camera, vpd, lpd, repo, cfg: tools.setup, brain });

  const presetProvider = createPresetProvider(tools.presetProvider, {
    camera,
    discovery: tools.discovery,
    cameraBaseUrl: tools.camera.baseUrl,
    timeoutMs: tools.camera.imageTimeoutMs,
  });

  // 장기 관측·반복 수집(/capture/*) 조립. 좌표는 검출+집계만, LLM 은 판정·자문만(좌표 불변).
  const sqlite = new SqliteStore(tools.capture.dbFile);
  const expectedByPreset = loadExpectedFaces(tools.map.presetFile);
  const reviewer = new CheckpointReviewer({ store: sqlite, brain });
  const floorReviewer = new FloorRoiReviewer({
    store: sqlite, brain, maxPerCheckpoint: llm.floorRoi?.maxPerCheckpoint,
  });
  const occupancyReviewer = new OccupancyReviewer({ store: sqlite, brain });
  // 차량 육면체 문맥 해결자 — 라우트(captureRoutes)와 **같은 팩토리**(단일 구현).
  // `ground.enabled=false` → 항상 null → **육면체 전 기능 off**(기존 킬스위치 재사용 — 신규 설정 플래그 0).
  const cuboidCtx = makeCuboidContextResolver({
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    cameraposFile: tools.map.cameraposFile,
    ground: tools.ground,
  });
  const captureJob = new CaptureJob({
    camera, vpd, lpd, store: sqlite, reviewer, floorReviewer, occupancyReviewer, brain, cfg: tools.capture,
    lpdEnabled: tools.setup.lpdEnabled, expectedByPreset,
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    cuboidCtx,
  });
  const finalizer = new Finalizer({
    store: sqlite, repo, brain, cfg: tools.capture,
    roiPadding: tools.setup.roiPadding, yBandTolerance: tools.setup.yBandTolerance, expectedByPreset, saveStore,
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    camera,
  });

  // 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션(/calibrate/*). 결정형 비례제어 + LLM 자문(toggle).
  const calibrator = new PtzCalibrator({ camera, lpd, brain, repo, cfg: tools.calibrate });

  // 웹 뷰어 통합(SettingViewer). enabled=false 면 sources 미빌드(헤드리스).
  const sources = tools.viewer.enabled ? buildSourceRegistry(tools) : undefined;

  const app = buildServer({
    orchestrator, repo, camera, vpd, lpd, brain, mapFiles: tools.map, discovery: tools.discovery,
    presetProvider, refreshOnRun: tools.presetProvider.refreshOnRun,
    captureJob, finalizer, sqlite, capture: tools.capture, saveStore,
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    refFrameDir: join(tools.store.dataDir, 'refframes'),
    ground: tools.ground,
    calibrator, calibrate: tools.calibrate,
    viewer: tools.viewer, sources, rpc,
    dbFile: tools.capture.dbFile,
  });
  await app.listen({ port: tools.server.port, host: '0.0.0.0' });
  logger.info(
    { port: tools.server.port, llmEnabled: llm.llm.enabled, mcpEnabled: llm.mcp.enabled, viewerEnabled: tools.viewer.enabled },
    'SettingAgent 기동 완료',
  );
}

main().catch((err) => {
  logger.error({ err }, 'SettingAgent 기동 실패');
  process.exit(1);
});
