/**
 * 1회용 라이브 진단 — zoom 이 번호판 중심을 어떻게 움직이는지 실측한다.
 * 가설(설계 §2.6): 중심(0.5,0.5) 기준 방사 확대 — err(z) = err(z0)·(z/z0), width(z) = width(z0)·(z/z0).
 * pan/tilt 는 고정하고 zoom 만 변화시켜 가설 대 실측을 비교한다. 프로덕션 무수정.
 */
import { loadToolsConfig } from '../../../src/config/toolsConfig.js';
import { CRpcClient } from '../../../src/clients/CRpcClient.js';
import { RpcCameraClient } from '../../../src/clients/RpcCameraClient.js';
import { LpdClient } from '../../../src/clients/LpdClient.js';
import { quadBoundingRect } from '../../../src/domain/geometry.js';

const cfg = loadToolsConfig();
const rpc = new CRpcClient({ baseUrl: 'http://localhost:13110', timeoutMs: 8000 });
const camera = new RpcCameraClient({ rpc, cameraCfg: cfg.camera, cameraposFile: 'config/camerapos.json' });
const lpd = new LpdClient(cfg.lpd);

/** A(centerOnPlate) 가 수렴시킨 PTZ — 여기서 zoom 만 올린다. */
const P = { pan: 25.631726428722494, tilt: 9.95311778194531 };
const Z0 = 1.69341;

async function plates(zoom: number) {
  const cap = await camera.requestImage(1, 1, { ...P, zoom });
  await new Promise((r) => setTimeout(r, 300));
  return (await lpd.detect(cap.jpg)).map((p) => {
    const r = quadBoundingRect(p.quad);
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w };
  });
}

const base = await plates(Z0);
const t0 = base.reduce((a, b) => (Math.hypot(a.cx - 0.5, a.cy - 0.5) <= Math.hypot(b.cx - 0.5, b.cy - 0.5) ? a : b));
console.log(`=== 기준 zoom=${Z0} plates=${base.length} ===`);
console.log(`  대상: cx=${t0.cx.toFixed(4)} cy=${t0.cy.toFixed(4)} w=${t0.w.toFixed(4)} (errX=${(t0.cx - 0.5).toFixed(4)} errY=${(t0.cy - 0.5).toFixed(4)})`);
console.log('\nzoom  | 실측 cx     errX     width  | 방사예측 errX  width | 실측/예측 err비  width비');

for (const z of [2.0, 2.54, 3.0, 3.81, 5.0, 7.0, 10.0]) {
  const list = await plates(z);
  const k = z / Z0;
  // 방사 확대 가설: err ∝ k, width ∝ k
  const predErrX = (t0.cx - 0.5) * k;
  const predErrY = (t0.cy - 0.5) * k;
  const predW = t0.w * k;
  // 예측 위치에 가장 가까운 검출 = 동일 신원(반경 무제한 — 진단이므로 기각하지 않는다)
  const pcx = 0.5 + predErrX;
  const pcy = 0.5 + predErrY;
  let best = list[0];
  let bd = Infinity;
  for (const p of list) {
    const d = Math.hypot(p.cx - pcx, p.cy - pcy);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) { console.log(`${z.toFixed(2).padStart(5)} | 검출 0`); continue; }
  const errX = best.cx - 0.5;
  console.log(
    `${z.toFixed(2).padStart(5)} | ${errX.toFixed(4).padStart(8)} ${errX.toFixed(4).padStart(8)} ${best.w.toFixed(4)} | ` +
      `${predErrX.toFixed(4).padStart(8)} ${predW.toFixed(4)} | ${(errX / predErrX).toFixed(2).padStart(6)} ${(best.w / predW).toFixed(2).padStart(6)}` +
      ` | 예측오차=${bd.toFixed(4)}${bd > 0.08 ? ' ★반경0.08 초과→기각됨' : ''}`,
  );
}
