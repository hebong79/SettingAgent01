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
  const app = buildServer({ orchestrator, repo, camera, vpd, brain, mapFiles: tools.map, discovery: tools.discovery, presetProvider, refreshOnRun: tools.presetProvider.refreshOnRun });
  await app.listen({ port: tools.server.port, host: '0.0.0.0' });
  logger.info(
    { port: tools.server.port, llmEnabled: llm.llm.enabled, mcpEnabled: llm.mcp.enabled },
    'SettingAgent 기동 완료',
  );
}

main().catch((err) => {
  logger.error({ err }, 'SettingAgent 기동 실패');
  process.exit(1);
});
