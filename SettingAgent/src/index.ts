import { join } from 'node:path';
import { loadToolsConfig } from './config/toolsConfig.js';
import { loadLlmConfig } from './config/llmConfig.js';
import { RpcCameraClient } from './clients/RpcCameraClient.js';
import { CameraSourceClient } from './clients/CameraSourceClient.js';
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
import { OccupancyReviewer } from './capture/OccupancyReviewer.js';
import { CaptureJob } from './capture/CaptureJob.js';
import { makeCuboidContextResolver } from './ground/cuboidContext.js';
import { Finalizer } from './capture/Finalizer.js';
import { PtzCalibrator } from './calibrate/PtzCalibrator.js';
import { PlateDiscoveryJob } from './calibrate/PlateDiscoveryJob.js';
import { SetupPipeline } from './pipeline/SetupPipeline.js';
import { CRpcClient } from './clients/CRpcClient.js';
import { loadExpectedFaces } from './setup/mapTargets.js';
import { logger } from './util/logger.js';

/** SettingAgent 부트스트랩: 두 config(도구/LLM)를 분리 로드 → 의존성 조립 → REST 서버 기동. */
async function main(): Promise<void> {
  const tools = loadToolsConfig();
  const llm = loadLlmConfig();

  // Unity JSON-RPC(방식 B). 뷰어 RPC 콘솔 + 카메라 도구(13110 /rpc) 공용 — camera 이전에 생성해 주입 재사용.
  const rpc = new CRpcClient(tools.unityRpc);
  // 명시된 TypeScript 네이티브 런타임은 선택된 cameraSources 항목을 Viewer와 메인 파이프라인이 공유한다.
  // cameraRuntime 미설정인 기존 배포는 기존 RpcCameraClient 경로를 그대로 유지한다.
  const sources = tools.viewer.enabled || tools.cameraRuntime ? buildSourceRegistry(tools) : undefined;
  const selectedEntry = tools.cameraRuntime ? sources?.entries().next().value : undefined;
  if (tools.cameraRuntime && selectedEntry?.[0] !== tools.cameraRuntime.selectedCameraId) {
    throw new Error(`선택 카메라(${tools.cameraRuntime.selectedCameraId})를 찾을 수 없습니다`);
  }
  const selectedSource = selectedEntry?.[1];
  const camera = selectedSource
    ? new CameraSourceClient(selectedSource, tools.camera)
    : new RpcCameraClient({ rpc, cameraCfg: tools.camera, cameraposFile: tools.map.cameraposFile });
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
  // 캡처 루프 LLM off(설계서 §6.5): CheckpointReviewer/FloorRoiReviewer 배선 제거.
  // OccupancyReviewer 만 축소 보조로 잔존(인메모리 occByPreset).
  const occupancyReviewer = new OccupancyReviewer({ brain });
  // 차량 육면체 문맥 해결자 — 라우트(captureRoutes)와 **같은 팩토리**(단일 구현).
  // `ground.enabled=false` → 항상 null → **육면체 전 기능 off**(기존 킬스위치 재사용 — 신규 설정 플래그 0).
  const cuboidCtx = makeCuboidContextResolver({
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    cameraposFile: tools.map.cameraposFile,
    ground: tools.ground,
  });
  // 원버튼 셋업 파이프라인(수집→최종화→센터라이징 자동 연쇄). 클로저 전방참조로 생성순서 역전 해소:
  // captureJob/calibrator 는 pipeline 을 완료콜백으로 필요로 하고, pipeline 은 그 둘을 dep 로 필요로 한다.
  let pipeline: SetupPipeline | undefined;
  const captureJob = new CaptureJob({
    camera, vpd, lpd, occupancyReviewer, brain, cfg: tools.capture,
    lpdEnabled: tools.setup.lpdEnabled, expectedByPreset,
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    cuboidCtx,
    onFinished: (s) => pipeline?.onCaptureFinished(s),
  });
  const finalizer = new Finalizer({
    store: sqlite, repo, brain, cfg: tools.capture,
    roiPadding: tools.setup.roiPadding, yBandTolerance: tools.setup.yBandTolerance, expectedByPreset, saveStore,
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    cameraposFile: tools.map.cameraposFile, ground: tools.ground, // slot3d_front_center 산출 필수 배선(Q3).
  });

  // 주차면별 번호판 중심정렬·줌 센터라이징(/calibrate/*). PlatePtz 결정형 폐루프 위임 + DB(centering_slot) 미러.
  const calibrator = new PtzCalibrator({
    camera, lpd, cfg: tools.calibrate, store: sqlite, saveStore,
    onFinished: (s) => pipeline?.onCalibrateFinished(s),
  });

  // 번호판 탐색·확대반복·역계산(/discover/*). 앞면중심 기준 디지털 크롭-줌 → slot_setup.lpd 부분 UPDATE.
  // 원버튼 셋업 자동연쇄에 discovering 단계로 포함(finalize→discovery→centering). 수동 /discover/ptz 도 동일 인스턴스.
  // pipeline 보다 먼저 생성(pipeline 이 dep 로 필요). onFinished 는 위 클로저 전방참조로 이 파이프라인에 회귀한다.
  const discoverOutFile = 'data/plate_discovery.json';
  const plateDiscovery = new PlateDiscoveryJob({
    camera, lpd, store: sqlite, outFile: discoverOutFile,
    onFinished: (s) => pipeline?.onDiscoverFinished(s),
  });

  // 파이프라인 조립(dep 완비 후). captureJob/calibrator/plateDiscovery 의 완료콜백이 위 클로저로 이 인스턴스에 회귀한다.
  pipeline = new SetupPipeline({ job: captureJob, finalizer, discovery: plateDiscovery, calibrator, store: sqlite });

  const app = buildServer({
    orchestrator, repo, camera, vpd, lpd, brain, mapFiles: tools.map, discovery: tools.discovery,
    presetProvider, refreshOnRun: tools.presetProvider.refreshOnRun,
    captureJob, finalizer, sqlite, capture: tools.capture, saveStore,
    placeRoiFile: join(tools.store.dataDir, tools.store.placeRoiFile),
    refFrameDir: join(tools.store.dataDir, 'refframes'),
    ground: tools.ground,
    calibrator, calibrate: tools.calibrate,
    plateDiscovery, discoverOutFile,
    pipeline,
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
