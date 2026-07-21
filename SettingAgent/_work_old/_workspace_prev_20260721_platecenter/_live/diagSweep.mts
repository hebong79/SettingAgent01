/**
 * 게인 재실측(diagSweep) — 프리셋별. 추적/최근접 휴리스틱 없이 전체 검출 목록의 공통 변위로
 * 게인의 부호·크기를 모호함 없이 측정. 프로덕션 무수정, 관측만. (원본 _work_old diagSweep 확장 — 3프리셋)
 */
import { loadToolsConfig } from '../../src/config/toolsConfig.js';
import { CRpcClient } from '../../src/clients/CRpcClient.js';
import { RpcCameraClient } from '../../src/clients/RpcCameraClient.js';
import { LpdClient } from '../../src/clients/LpdClient.js';
import { quadBoundingRect } from '../../src/domain/geometry.js';

const cfg = loadToolsConfig();
const rpc = new CRpcClient({ baseUrl: 'http://localhost:13110', timeoutMs: 8000 });
const camera = new RpcCameraClient({ rpc, cameraCfg: cfg.camera, cameraposFile: 'config/camerapos.json' });
const lpd = new LpdClient(cfg.lpd);

const PRESETS = [
  { id: 1, pan: 22, tilt: 6.8, zoom: 1.69341 },
  { id: 2, pan: 56.6, tilt: 7.4, zoom: 2.03134 },
  { id: 3, pan: 43.5, tilt: 18.8, zoom: 1.46583 },
];

async function list(presetId: number, pan: number, tilt: number, zoom: number) {
  const cap = await camera.requestImage(1, presetId, { pan, tilt, zoom });
  await new Promise((r) => setTimeout(r, 300));
  return (await lpd.detect(cap.jpg))
    .map((p) => { const r = quadBoundingRect(p.quad); return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 }; })
    .sort((a, b) => a.cx - b.cx);
}

/** 두 목록의 공통 이동(강체) — 각 점 최근접 대응의 중앙값 변위. */
function shift(a: { cx: number; cy: number }[], b: { cx: number; cy: number }[]) {
  const dxs: number[] = []; const dys: number[] = [];
  for (const p of a) {
    let best: { cx: number; cy: number } | null = null; let bd = Infinity;
    for (const q of b) { const d = Math.hypot(q.cx - p.cx, q.cy - p.cy); if (d < bd) { bd = d; best = q; } }
    if (best && bd < 0.12) { dxs.push(best.cx - p.cx); dys.push(best.cy - p.cy); }
  }
  const med = (v: number[]) => (v.length ? v.sort((x, y) => x - y)[Math.floor(v.length / 2)] : NaN);
  return { dx: med(dxs), dy: med(dys), n: dxs.length };
}

for (const P of PRESETS) {
  console.log(`\n========== PRESET ${P.id} (pan=${P.pan} tilt=${P.tilt} zoom=${P.zoom}) ==========`);
  const ref = await list(P.id, P.pan, P.tilt, P.zoom);
  console.log(`기준 판 개수=${ref.length}  cx: ${ref.map((p) => p.cx.toFixed(3)).join(' ')}`);
  if (ref.length === 0) { console.log('  판 미검 → 이 프리셋 게인 측정 불가(스킵)'); continue; }

  // 작은 스텝만(aliasing 회피): 0.5°, 1° — 변위 |dx|<간격절반 이어야 대응이 안 튐.
  const gpans: number[] = [];
  for (const dp of [0.5, 1]) {
    const l = await list(P.id, P.pan + dp, P.tilt, P.zoom);
    const s = shift(ref, l);
    const gAtZ = dp / s.dx; const gAt1 = gAtZ * P.zoom;
    gpans.push(gAt1);
    console.log(`  pan+${dp}: dx=${s.dx.toFixed(4)}(n${s.n}) → gainPan@z1=${gAt1.toFixed(1)}`);
  }
  const gtilts: number[] = [];
  for (const dt of [0.5, 1]) {
    const l = await list(P.id, P.pan, P.tilt + dt, P.zoom);
    const s = shift(ref, l);
    const gAtZ = dt / s.dy; const gAt1 = gAtZ * P.zoom;
    gtilts.push(gAt1);
    console.log(`  tilt+${dt}: dy=${s.dy.toFixed(4)}(n${s.n}) → gainTilt@z1=${gAt1.toFixed(1)}`);
  }
  const med = (v: number[]) => { const f = v.filter((x) => isFinite(x)).sort((a, b) => a - b); return f.length ? f[Math.floor(f.length / 2)] : NaN; };
  console.log(`  ▶ PRESET ${P.id} @z1: gainPan=${med(gpans).toFixed(1)}  gainTilt=${med(gtilts).toFixed(1)}  (현재 config: -62 / -35.5)`);
}
console.log('\n=== 완료 ===');
