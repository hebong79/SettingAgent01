/**
 * 자동 탐색(B) 결과를 camerapos.json 으로 내보내는 CLI. 실행: `npm run export:camerapos`
 *
 * 카메라 서버가 떠 있어야 한다. 탐색된 (cam,preset)+PTZ 를 tools.config 의 map.cameraposFile 에 저장한다.
 * 이후엔 discovery 를 꺼도 파일(A)로 정확·빠르게 셋업할 수 있다(필요 시 수동 보정).
 *
 * 벤더 API 공급자(A)가 있으면 DiscoveryPresetProvider 대신 그 공급자로 교체하면 동일하게 저장된다.
 */
import { loadToolsConfig } from '../config/toolsConfig.js';
import { CameraClient } from '../clients/CameraClient.js';
import { createPresetProvider } from '../setup/presetProvider.js';
import { writeCamerapos } from '../setup/cameraposWriter.js';

async function main(): Promise<void> {
  const t = loadToolsConfig();
  const camera = new CameraClient(t.camera);
  const provider = createPresetProvider(t.presetProvider, {
    camera,
    discovery: t.discovery,
    cameraBaseUrl: t.camera.baseUrl,
    timeoutMs: t.camera.imageTimeoutMs,
    log: (m) => console.log('  ' + m),
  });
  if (!provider) {
    console.error(`[export] presetProvider.type=${t.presetProvider.type} 는 수동 파일이라 export 대상이 아닙니다(discovery 또는 unity-api 로 설정).`);
    process.exit(1);
  }

  console.log(`[export] 공급자=${provider.name} 로 프리셋 목록 수집...`);
  const views = await provider.listViews();
  if (views.length === 0) {
    console.error('[export] 수집된 카메라/프리셋이 없습니다(카메라 서버 확인).');
    process.exit(1);
  }
  writeCamerapos(views, t.map.cameraposFile);
  console.log(`[export] ${views.length}건 저장 → ${t.map.cameraposFile}`);
  console.log('  ' + views.map((v) => `${v.camIdx}:${v.presetIdx}`).join(', '));
  console.log('[export] 완료. 필요 시 파일을 수동 보정 후, discovery 를 꺼고 셋업하면 파일(A)로 동작합니다.');
}

main().catch((err) => {
  console.error('[export] 실패:', err);
  process.exit(1);
});
