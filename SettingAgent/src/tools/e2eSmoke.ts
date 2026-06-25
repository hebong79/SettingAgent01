/**
 * E2E 통합 스모크 (실서버 대상). 실행: `npm run e2e`
 *
 * 실제 서버가 떠 있어야 동작한다:
 *   - Unity 카메라 (tools.config.camera.baseUrl)
 *   - da_vpd_api   (tools.config.vpd.endpoint)
 *   - (선택) 로컬 LLM (llm.config.llm.baseUrl, enabled=true 일 때만 점검)
 *
 * 절차: 헬스 점검 → camerapos 자동 로딩 → 셋업 실행 → 산출물 요약 출력.
 * 서버가 없으면 헬스에서 실패를 표시하고 비정상 종료(코드 1)한다.
 */
import { loadToolsConfig } from '../config/toolsConfig.js';
import { loadLlmConfig } from '../config/llmConfig.js';
import { CameraClient } from '../clients/CameraClient.js';
import { VpdClient } from '../clients/VpdClient.js';
import { Repository } from '../store/Repository.js';
import { SetupOrchestrator } from '../setup/SetupOrchestrator.js';
import { AgentRuntime } from '../brain/AgentRuntime.js';
import { loadSetupTargets, loadExpectedFaces, viewsToTargets } from '../setup/mapTargets.js';
import { discoverViews } from '../setup/discover.js';
import { createPresetProvider } from '../setup/presetProvider.js';
import { writeCamerapos } from '../setup/cameraposWriter.js';

async function main(): Promise<void> {
  const tools = loadToolsConfig();
  const llm = loadLlmConfig();
  const camera = new CameraClient(tools.camera);
  const vpd = new VpdClient(tools.vpd);
  const repo = new Repository(tools.store.dataDir);
  const brain = new AgentRuntime(llm);

  console.log('[e2e] 헬스 점검...');
  const [camOk, vpdOk] = await Promise.all([camera.health(), vpd.health()]);
  const brainOk = brain.enabled ? await brain.ping().catch(() => false) : null;
  console.log(`  camera(${tools.camera.baseUrl}): ${camOk ? 'OK' : 'FAIL'}`);
  console.log(`  vpd(${tools.vpd.endpoint}): ${vpdOk ? 'OK' : 'FAIL'}`);
  console.log(`  brain: ${brainOk === null ? '비활성' : brainOk ? 'OK' : 'FAIL'}`);

  if (!camOk || !vpdOk) {
    console.error('[e2e] 카메라/VPD 서버가 필요합니다. 서버 기동 후 다시 실행하세요.');
    process.exit(1);
  }

  let targets;
  if (tools.discovery.enabled) {
    console.log('[e2e] 프리셋 자동 탐색(discovery)...');
    targets = viewsToTargets(await discoverViews(camera, tools.discovery, (m) => console.log('  ' + m)));
  } else {
    // 2번 옵션: 셋업 직전 공급자(A/B)로 camerapos 자동 갱신.
    if (tools.presetProvider.refreshOnRun) {
      const provider = createPresetProvider(tools.presetProvider, { camera, discovery: tools.discovery, cameraBaseUrl: tools.camera.baseUrl, timeoutMs: tools.camera.imageTimeoutMs });
      if (provider) {
        console.log(`[e2e] camerapos 자동 갱신(${provider.name})...`);
        writeCamerapos(await provider.listViews(), tools.map.cameraposFile);
      }
    }
    console.log('[e2e] camerapos 로딩...');
    targets = loadSetupTargets(tools.map);
  }
  const expectedFaces = loadExpectedFaces(tools.map.presetFile);
  console.log(`  대상 프리셋 ${targets.length}개 (${tools.discovery.enabled ? 'discovery' : 'camerapos'})`);

  console.log('[e2e] 셋업 실행...');
  const orch = new SetupOrchestrator({ camera, vpd, repo, cfg: tools.setup });
  const artifact = await orch.run(targets, expectedFaces);

  console.log('[e2e] 결과 요약');
  console.log(`  프리셋: ${artifact.presets.length}, 슬롯: ${artifact.slots.length}, 전역인덱스: ${artifact.globalIndex.length}`);
  if (artifact.warnings?.length) console.log(`  경고:\n   - ${artifact.warnings.join('\n   - ')}`);
  console.log(`  산출물 저장: ${repo.path}`);

  if (brain.enabled && brainOk) {
    console.log('[e2e] 두뇌 검토...');
    console.log('  ' + (await brain.reviewSetup(artifact).catch((e) => `검토 실패: ${e}`)));
  }
  console.log('[e2e] 완료');
}

main().catch((err) => {
  console.error('[e2e] 실패:', err);
  process.exit(1);
});
