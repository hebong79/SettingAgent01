/**
 * 1회용 라이브 진단 — 추적/최근접 휴리스틱을 일절 쓰지 않고 **전체 검출 목록**을 그대로 찍는다.
 * 번호판 6개가 강체처럼 함께 이동하므로, 목록 전체의 이동 방향·크기가 게인의 부호·크기를 모호함 없이 준다.
 * 프로덕션 무수정. 관측만.
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

const Z = 1.69341;

async function list(pan: number, tilt: number) {
  const cap = await camera.requestImage(1, 1, { pan, tilt, zoom: Z });
  await new Promise((r) => setTimeout(r, 300));
  return (await lpd.detect(cap.jpg))
    .map((p) => {
      const r = quadBoundingRect(p.quad);
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
    })
    .sort((a, b) => a.cx - b.cx);
}

/** 두 목록의 공통 이동량 추정: 각 점에 대해 최근접 대응의 중앙값 변위(강체 이동 가정). */
function shift(a: { cx: number; cy: number }[], b: { cx: number; cy: number }[]) {
  const dxs: number[] = [];
  const dys: number[] = [];
  for (const p of a) {
    let best: { cx: number; cy: number } | null = null;
    let bd = Infinity;
    for (const q of b) {
      const d = Math.hypot(q.cx - p.cx, q.cy - p.cy);
      if (d < bd) { bd = d; best = q; }
    }
    if (best && bd < 0.12) { dxs.push(best.cx - p.cx); dys.push(best.cy - p.cy); }
  }
  const med = (v: number[]) => (v.length ? v.sort((x, y) => x - y)[Math.floor(v.length / 2)] : NaN);
  return { dx: med(dxs), dy: med(dys), n: dxs.length };
}

console.log(`=== zoom=${Z} 고정. PAN 스윕 (tilt=6.8) — 전체 검출 cx 목록 ===`);
const panRef = await list(22, 6.8);
console.log(`pan=22.0 (기준) cx: ${panRef.map((p) => p.cx.toFixed(3)).join(' ')}`);
for (const pan of [23, 24, 25]) {
  const l = await list(pan, 6.8);
  const s = shift(panRef, l);
  const gain = (pan - 22) / s.dx;
  console.log(
    `pan=${pan.toFixed(1)}       cx: ${l.map((p) => p.cx.toFixed(3)).join(' ')}\n` +
      `          → 공통변위 dx=${s.dx.toFixed(4)} (대응 ${s.n}개) → gainPan = ${(pan - 22).toFixed(1)}/${s.dx.toFixed(4)} = ${gain.toFixed(1)}`,
  );
}

console.log(`\n=== zoom=${Z} 고정. TILT 스윕 (pan=22) — 전체 검출 cy 목록 ===`);
const tiltRef = await list(22, 6.8);
console.log(`tilt=6.8 (기준) cy: ${tiltRef.map((p) => p.cy.toFixed(3)).join(' ')}`);
for (const tilt of [7.8, 8.8]) {
  const l = await list(22, tilt);
  const s = shift(tiltRef, l);
  const gain = (tilt - 6.8) / s.dy;
  console.log(
    `tilt=${tilt.toFixed(1)}      cy: ${l.map((p) => p.cy.toFixed(3)).join(' ')}\n` +
      `          → 공통변위 dy=${s.dy.toFixed(4)} (대응 ${s.n}개) → gainTilt = ${(tilt - 6.8).toFixed(1)}/${s.dy.toFixed(4)} = ${gain.toFixed(1)}`,
  );
}
