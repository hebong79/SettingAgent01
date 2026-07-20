/** slot5 판을 화면중앙으로 pre-aim 한 뒤 zoom 을 올리며 검출 여부·폭을 실측(고zoom 검출 한계 진단). */
import { loadToolsConfig } from '../../src/config/toolsConfig.js';
import { CRpcClient } from '../../src/clients/CRpcClient.js';
import { RpcCameraClient } from '../../src/clients/RpcCameraClient.js';
import { LpdClient } from '../../src/clients/LpdClient.js';
import { quadBoundingRect } from '../../src/domain/geometry.js';
import { scaleGainForZoom, panTiltCorrection } from '../../src/calibrate/controlMath.js';

const cfg = loadToolsConfig();
const rpc = new CRpcClient({ baseUrl: 'http://localhost:13110', timeoutMs: 8000 });
const camera = new RpcCameraClient({ rpc, cameraCfg: cfg.camera, cameraposFile: 'config/camerapos.json' });
const lpd = new LpdClient(cfg.lpd);

// 대상: slot5(p1 pan22/tilt6.8/z1.69) lpd center (0.702,0.622). 비교 slot4 (0.567,0.651).
const CASES = [
  { name: 'slot5', preset: 1, pan: 22, tilt: 6.8, zoom: 1.69341, cx: 0.702, cy: 0.622 },
  { name: 'slot4', preset: 1, pan: 22, tilt: 6.8, zoom: 1.69341, cx: 0.567, cy: 0.651 },
];

for (const C of CASES) {
  // pre-aim: lpd center → 화면중앙(0.5). preAimPtz 와 동일 수식.
  const g = scaleGainForZoom({ gainPan: cfg.calibrate.fallbackGainPanDeg, gainTilt: cfg.calibrate.fallbackGainTiltDeg, zoomRef: 1 }, C.zoom);
  const err = { errX: C.cx - 0.5, errY: C.cy - 0.5 };
  const pt = panTiltCorrection(err, g, C.pan, C.tilt, 90);
  console.log(`\n===== ${C.name}: pre-aim pan=${pt.pan.toFixed(2)} tilt=${pt.tilt.toFixed(2)} =====`);
  for (const zoom of [2, 4, 6, 8, 10, 12, 14, 16]) {
    const cap = await camera.requestImage(1, C.preset, { pan: pt.pan, tilt: pt.tilt, zoom });
    await new Promise((r) => setTimeout(r, 300));
    const plates = await lpd.detect(cap.jpg);
    // 화면중앙 최근접 판(있으면) 폭·중심.
    let best: { cx: number; cy: number; w: number } | null = null; let bd = Infinity;
    for (const p of plates) { const r = quadBoundingRect(p.quad); const c = { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w }; const d = Math.hypot(c.cx - 0.5, c.cy - 0.5); if (d < bd) { bd = d; best = c; } }
    console.log(`  zoom=${String(zoom).padStart(2)}: 검출 ${plates.length}개` + (best ? ` | 중앙최근접 center=(${best.cx.toFixed(3)},${best.cy.toFixed(3)}) w=${best.w.toFixed(3)} dist=${bd.toFixed(3)}` : ' | 판 없음'));
  }
}
console.log('\n=== 완료 ===');
