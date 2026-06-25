import { loadViewerConfig } from './config/viewerConfig.js';
import { buildSourceRegistry } from './viewer/sourceRegistry.js';
import { buildViewerServer } from './server.js';

/** SettingViewer 부트스트랩: config 로드 → 소스 레지스트리 빌드 → 서버 기동. */
async function main(): Promise<void> {
  const cfg = loadViewerConfig();
  const sources = buildSourceRegistry(cfg);
  const app = buildViewerServer({ sources, viewer: cfg.viewer, settingAgentUrl: cfg.settingAgentUrl });
  await app.listen({ port: cfg.server.port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`SettingViewer 기동 완료 (port=${cfg.server.port}, settingAgentUrl=${cfg.settingAgentUrl})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('SettingViewer 기동 실패', err);
  process.exit(1);
});
