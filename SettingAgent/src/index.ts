import { loadToolsConfig } from './config/toolsConfig.js';
import { loadLlmConfig } from './config/llmConfig.js';
import { CameraClient } from './clients/CameraClient.js';
import { VpdClient } from './clients/VpdClient.js';
import { LpdClient } from './clients/LpdClient.js';
import { Repository } from './store/Repository.js';
import { SetupOrchestrator } from './setup/SetupOrchestrator.js';
import { createPresetProvider } from './setup/presetProvider.js';
import { AgentRuntime } from './brain/AgentRuntime.js';
import { buildServer } from './api/server.js';
import { buildSourceRegistry } from './viewer/sourceRegistry.js';
import { SqliteStore } from './capture/SqliteStore.js';
import { CheckpointReviewer } from './capture/CheckpointReviewer.js';
import { FloorRoiReviewer } from './capture/FloorRoiReviewer.js';
import { CaptureJob } from './capture/CaptureJob.js';
import { Finalizer } from './capture/Finalizer.js';
import { PtzCalibrator } from './calibrate/PtzCalibrator.js';
import { loadExpectedFaces } from './setup/mapTargets.js';
import { logger } from './util/logger.js';

/** SettingAgent 부트스트랩: 두 config(도구/LLM)를 분리 로드 → 의존성 조립 → REST 서버 기동. */
async function main(): Promise<void> {
  const tools = loadToolsConfig();
  const llm = loadLlmConfig();

  const camera = new CameraClient(tools.camera);
  const vpd = new VpdClient(tools.vpd);
  const lpd = new LpdClient(tools.lpd);
  const repo = new Repository(tools.store.dataDir);
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
  const captureJob = new CaptureJob({
    camera, vpd, lpd, store: sqlite, reviewer, floorReviewer, cfg: tools.capture,
    lpdEnabled: tools.setup.lpdEnabled, expectedByPreset,
  });
  const finalizer = new Finalizer({
    store: sqlite, repo, brain, cfg: tools.capture,
    roiPadding: tools.setup.roiPadding, yBandTolerance: tools.setup.yBandTolerance, expectedByPreset,
  });

  // 주차면별 번호판 중심정렬·줌 PTZ 캘리브레이션(/calibrate/*). 결정형 비례제어 + LLM 자문(toggle).
  const calibrator = new PtzCalibrator({ camera, lpd, brain, repo, cfg: tools.calibrate });

  // 웹 뷰어 통합(SettingViewer). enabled=false 면 sources 미빌드(헤드리스).
  const sources = tools.viewer.enabled ? buildSourceRegistry(tools) : undefined;

  const app = buildServer({
    orchestrator, repo, camera, vpd, brain, mapFiles: tools.map, discovery: tools.discovery,
    presetProvider, refreshOnRun: tools.presetProvider.refreshOnRun,
    captureJob, finalizer, sqlite, capture: tools.capture,
    calibrator, calibrate: tools.calibrate,
    viewer: tools.viewer, sources,
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
