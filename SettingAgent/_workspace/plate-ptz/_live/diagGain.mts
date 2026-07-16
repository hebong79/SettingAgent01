/**
 * 1회용 라이브 진단 — 실제 pan/tilt 게인과 "번호판 신원 전환" 여부를 사실로 확인한다.
 * 프로덕션 무수정. 관측만 한다.
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

const BASE = { pan: 22, tilt: 6.8, zoom: 1.69341 };

async function centers(ptz: { pan: number; tilt: number; zoom: number }) {
  const cap = await camera.requestImage(1, 1, ptz);
  await new Promise((r) => setTimeout(r, 300));
  const plates = await lpd.detect(cap.jpg);
  return plates
    .map((p) => {
      const r = quadBoundingRect(p.quad);
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w };
    })
    .sort((a, b) => a.cx - b.cx);
}

/** 이전 프레임 위치에 가장 가까운 번호판 = 동일 신원(추적). */
function track(prev: { cx: number; cy: number }, list: { cx: number; cy: number; w: number }[]) {
  let best = list[0];
  let bd = Infinity;
  for (const p of list) {
    const d = Math.hypot(p.cx - prev.cx, p.cy - prev.cy);
    if (d < bd) { bd = d; best = p; }
  }
  return { ...best, jump: bd };
}

/** 화면 중심 최근접(= 구현의 pickNearestPlate 기본 prior 와 동일 기준). */
function nearestCenter(list: { cx: number; cy: number; w: number }[]) {
  return list.reduce((a, b) => (Math.hypot(a.cx - 0.5, a.cy - 0.5) <= Math.hypot(b.cx - 0.5, b.cy - 0.5) ? a : b));
}

const base = await centers(BASE);
console.log(`=== BASE(pan=${BASE.pan}, tilt=${BASE.tilt}) plates=${base.length} ===`);
console.log('  전체 cx:', base.map((p) => p.cx.toFixed(3)).join(' '));
const t0 = nearestCenter(base);
console.log(`  중심최근접 대상: cx=${t0.cx.toFixed(3)} cy=${t0.cy.toFixed(3)} w=${t0.w.toFixed(4)}`);

const steps = [
  { name: 'pan +1', ptz: { ...BASE, pan: BASE.pan + 1 } },
  { name: 'pan +3', ptz: { ...BASE, pan: BASE.pan + 3 } },
  { name: 'pan -3', ptz: { ...BASE, pan: BASE.pan - 3 } },
  { name: 'tilt +1', ptz: { ...BASE, tilt: BASE.tilt + 1 } },
  { name: 'tilt +3', ptz: { ...BASE, tilt: BASE.tilt + 3 } },
  { name: 'probe(+1,+1)', ptz: { pan: BASE.pan + 1, tilt: BASE.tilt + 1, zoom: BASE.zoom } },
];

console.log('\n=== 스텝별: 추적(동일 신원) vs 중심최근접(구현 기준) ===');
for (const s of steps) {
  const list = await centers(s.ptz);
  const tr = track(t0, list);
  const nc = nearestCenter(list);
  const dPan = s.ptz.pan - BASE.pan;
  const dTilt = s.ptz.tilt - BASE.tilt;
  const dX = tr.cx - t0.cx;
  const dY = tr.cy - t0.cy;
  const gp = dPan !== 0 ? (dPan / dX).toFixed(2) : '-';
  const gt = dTilt !== 0 ? (dTilt / dY).toFixed(2) : '-';
  const switched = Math.abs(nc.cx - tr.cx) > 1e-6;
  console.log(
    `${s.name.padEnd(13)} plates=${list.length} | 추적: cx=${tr.cx.toFixed(3)} cy=${tr.cy.toFixed(3)} dX=${dX.toFixed(4)} dY=${dY.toFixed(4)} → gainPan=${gp} gainTilt=${gt}` +
      ` | 중심최근접: cx=${nc.cx.toFixed(3)} cy=${nc.cy.toFixed(3)} ${switched ? '★신원전환' : '(동일)'}`,
  );
}
