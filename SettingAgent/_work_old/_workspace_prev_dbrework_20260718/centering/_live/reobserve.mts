// 독립 재관측(리더 경험적 검증) — Goal 4.
// slot_ptz.json 의 최종 PTZ 로 프레임을 새로 찍어, 번호판 중심이 정말 (0.5,0.5) 인지
// PtzCalibrator/PlatePtz 폐루프 **밖에서** 확인한다. centered:true 자기보고를 신뢰하지 않는다.
// 실행: npx tsx _workspace/centering/_live/reobserve.mts   (cwd = SettingAgent)
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
// 프로덕션 배선(index.ts:32-34)과 동일: Unity JSON-RPC(13110 /rpc) 경유.
// CameraClient(/req_img REST 직결)는 이 환경에서 쓰이지 않는다.
import { RpcCameraClient } from '../../../src/clients/RpcCameraClient.js';
import { CRpcClient } from '../../../src/clients/CRpcClient.js';
import { LpdClient } from '../../../src/clients/LpdClient.js';
import { loadToolsConfig } from '../../../src/config/toolsConfig.js';
import { quadBoundingRect } from '../../../src/domain/geometry.js';
import { plateCenterError, pickNearestPlate } from '../../../src/calibrate/controlMath.js';

const OUT = '_workspace/centering/_live';
const cfg = loadToolsConfig();
const artifact = JSON.parse(readFileSync('data/slot_ptz.json', 'utf-8'));
const item = artifact.items[0];
console.log('■ 대상:', item.slotId, `cam${item.camIdx}:preset${item.presetIdx}`);
console.log('■ 캘리브레이터 자기보고: centered =', item.centered, '/ converged =', item.converged, '/ plateWidth =', item.plateWidth);
console.log('■ 최종 PTZ:', JSON.stringify(item.ptz));

const rpc = new CRpcClient(cfg.unityRpc);
const camera = new RpcCameraClient({ rpc, cameraCfg: cfg.camera, cameraposFile: cfg.map.cameraposFile });
const lpd = new LpdClient(cfg.lpd);

// 1) 최종 PTZ 로 새 프레임(독립 요청 — 캘리브레이터 미경유)
const cap = await camera.requestImage(item.camIdx, item.presetIdx, item.ptz);
writeFileSync(`${OUT}/reobs_final.jpg`, cap.jpg);
const meta = await sharp(cap.jpg).metadata();
console.log('■ 캡처:', cap.jpg.length, 'bytes,', meta.width + 'x' + meta.height);

// 2) 실 LPD 직접 호출
const plates = await lpd.detect(cap.jpg);
console.log('■ LPD 검출 수:', plates.length);
if (plates.length === 0) {
  console.log('✗ 재관측 실패: 최종 PTZ 에서 번호판이 검출되지 않음');
  process.exit(1);
}

// 3) 화면 중앙 기준 최근접 번호판 = 센터링된 대상이어야 한다
const target = pickNearestPlate(plates, { x: 0.5, y: 0.5, w: 0, h: 0 } as any);
if (!target) { console.log('✗ 대상 선정 실패'); process.exit(1); }
const pr = quadBoundingRect(target.quad);
const err = plateCenterError(pr);
const dist = Math.hypot(err.errX, err.errY);

console.log('\n=== 독립 재관측 결과 ===');
console.log('번호판 중심:', { cx: +(pr.x + pr.w / 2).toFixed(4), cy: +(pr.y + pr.h / 2).toFixed(4) }, '(목표 0.5, 0.5)');
console.log('중심 오차   :', { errX: +err.errX.toFixed(4), errY: +err.errY.toFixed(4) }, '| 거리', dist.toFixed(4), '| 허용', cfg.calibrate.centerTol);
console.log('번호판 폭   :', pr.w.toFixed(4), '| 목표', cfg.calibrate.targetPlateWidth, '±', cfg.calibrate.widthTol);

const centerOk = Math.abs(err.errX) <= cfg.calibrate.centerTol && Math.abs(err.errY) <= cfg.calibrate.centerTol;
const widthOk = Math.abs(pr.w - cfg.calibrate.targetPlateWidth) <= cfg.calibrate.widthTol;
console.log('\n판정: 중심', centerOk ? '✓ PASS' : '✗ FAIL', '/ 폭', widthOk ? '✓ PASS' : '✗ FAIL');

// 4) 육안 확인용 오버레이(중앙 십자 + 검출 quad)
const W = meta.width!, H = meta.height!;
const pts = target.quad.map((p: any) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(' ');
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" stroke="#00ff00" stroke-width="2" opacity="0.7"/>
  <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#00ff00" stroke-width="2" opacity="0.7"/>
  <circle cx="${W / 2}" cy="${H / 2}" r="${cfg.calibrate.centerTol * W}" fill="none" stroke="#00ff00" stroke-width="2" stroke-dasharray="6 4"/>
  <polygon points="${pts}" fill="none" stroke="#ff3b30" stroke-width="3"/>
  <circle cx="${(pr.x + pr.w / 2) * W}" cy="${(pr.y + pr.h / 2) * H}" r="6" fill="#ff3b30"/>
</svg>`;
await sharp(cap.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(`${OUT}/reobs_overlay.png`);
console.log('오버레이 저장:', `${OUT}/reobs_overlay.png`);
