/**
 * 1회용 라이브 진단 — B 가 죽은 지점(zoom 2.54 에서 가드가 pan 을 +1.44° 움직인 직후)을 재현한다.
 * 묻는 것: (a) 그 pan 이동의 실제 게인 부호/크기 (b) 대상 번호판이 정말 사라졌나, 아니면 LPD 단발 미검출인가.
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

const TILT = 9.95311778194531;
const ZOOM = 2.540115;

async function list(pan: number) {
  const cap = await camera.requestImage(1, 1, { pan, tilt: TILT, zoom: ZOOM });
  await new Promise((r) => setTimeout(r, 300));
  return (await lpd.detect(cap.jpg))
    .map((p) => {
      const r = quadBoundingRect(p.quad);
      return { cx: +(r.x + r.w / 2).toFixed(4), cy: +(r.y + r.h / 2).toFixed(4), w: +r.w.toFixed(4) };
    })
    .sort((a, b) => a.cx - b.cx);
}

console.log(`=== zoom=${ZOOM} tilt=${TILT.toFixed(2)} — pan 스윕(가드가 25.63 → 27.08 로 +1.44° 명령했다) ===`);
for (const pan of [25.63, 26.35, 27.08]) {
  const l = await list(pan);
  console.log(`pan=${pan.toFixed(2)} plates=${l.length}  cx: ${l.map((p) => p.cx.toFixed(3)).join(' ')}`);
  const near = l.reduce((a, b) => (Math.abs(a.cx - 0.5) <= Math.abs(b.cx - 0.5) ? a : b));
  console.log(`         중심최근접 cx=${near.cx} cy=${near.cy} w=${near.w}`);
}

console.log('\n=== 동일 PTZ(pan=27.08) 반복 검출 5회 — LPD 단발 미검출(지터) 여부 ===');
for (let i = 0; i < 5; i++) {
  const l = await list(27.08);
  console.log(`  #${i + 1} plates=${l.length}  cx: ${l.map((p) => p.cx.toFixed(3)).join(' ')}`);
}
