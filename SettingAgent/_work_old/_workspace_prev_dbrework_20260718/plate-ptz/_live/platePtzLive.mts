/**
 * 1회용 라이브 검증 하네스(goal/loop 경험적 검증 — 프로덕션 아님).
 * 실제 PlatePtz 를 실 Unity(13110 /rpc) + 실 LPD(9082)에 물려 goal 수치를 관측한다.
 *
 * ★ 독립 관측 원칙(설계 §7, r2): "중심 최근접" 휴리스틱 금지 — 그 방식은 aliasing 에 당해
 *   r1 에서 허위 PASS 를 만들었다. 대상 신원은 미세 스텝 추적(track.mts)으로 확인한다(구현의 게인과 독립).
 *
 * 관측 목표:
 *   A. centerOnPlate → 대상 번호판의 |errX|,|errY| ≤ 0.03
 *   B. zoomToPlateWidth(센터링 이후) → 대상 폭 ∈ [0.18, 0.22]
 *   C. zoomToPlateWidth 단독(센터링 생략) → r2 에서 성공 요건으로 승격
 *   D. 실측 게인 정합: gainPan ∈ -36.6±20%, gainTilt ∈ -21.0±20% (@z1.69)
 *
 * 실행: npx tsx _workspace/plate-ptz/_live/platePtzLive.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadToolsConfig } from '../../../src/config/toolsConfig.js';
import { CRpcClient } from '../../../src/clients/CRpcClient.js';
import { RpcCameraClient } from '../../../src/clients/RpcCameraClient.js';
import { LpdClient } from '../../../src/clients/LpdClient.js';
import { PlatePtz } from '../../../src/calibrate/platePtz.js';
import type { Ptz } from '../../../src/calibrate/types.js';
import { observeAll, trackTarget, pickInitialTarget, type Obs } from './track.mjs';

const OUT = '_workspace/plate-ptz/_live/shots/';
mkdirSync(OUT, { recursive: true });

const cfg = loadToolsConfig();
const rpc = new CRpcClient({ baseUrl: 'http://localhost:13110', timeoutMs: 8000 });
const camera = new RpcCameraClient({ rpc, cameraCfg: cfg.camera, cameraposFile: 'config/camerapos.json' });
const lpd = new LpdClient(cfg.lpd);

const CAM = 1;
const PRESET = 1;
const BASE: Ptz = { pan: 22, tilt: 6.8, zoom: 1.69341 };

/** 결과 PTZ 에서 스샷 1장 저장(목시 확인용). */
async function shot(ptz: Ptz, tag: string) {
  const cap = await camera.requestImage(CAM, PRESET, ptz);
  writeFileSync(`${OUT}${tag}.jpg`, cap.jpg);
}

const baseList = await observeAll(camera, lpd, BASE);
const TARGET: Obs = pickInitialTarget(baseList);
console.log(`=== 사전 관측 base=${JSON.stringify(BASE)} plates=${baseList.length} ===`);
console.log(`  대상(중심최근접): cx=${TARGET.cx.toFixed(4)} cy=${TARGET.cy.toFixed(4)} w=${TARGET.w.toFixed(4)}`);
console.log(`  → errX=${(TARGET.cx - 0.5).toFixed(4)} errY=${(TARGET.cy - 0.5).toFixed(4)}`);
await shot(BASE, 'live_before');

/** 구현 결과 PTZ 로 대상을 추적해 독립 판정. */
async function judge(label: string, to: Ptz, tag: string) {
  const t = await trackTarget(camera, lpd, BASE, TARGET, to);
  await shot(to, tag);
  if (!t.found) {
    console.log(`  독립 추적: 대상 소실 — ${t.note}`);
    return null;
  }
  console.log(
    `  독립 추적(${t.steps}스텝): errX=${(t.cx - 0.5).toFixed(4)} errY=${(t.cy - 0.5).toFixed(4)} width=${t.w.toFixed(4)} (추적여유=${t.margin.toFixed(3)})`,
  );
  void label;
  return t;
}

console.log('\n=== A. centerOnPlate 단독 ===');
const rc = await new PlatePtz({ camera, lpd }).centerOnPlate(CAM, PRESET, BASE);
console.log(`  결과: ok=${rc.ok} reason=${rc.reason ?? '-'} iters=${rc.iterations} ptz=${JSON.stringify(rc.ptz)}`);
console.log(`  자기보고: err=${JSON.stringify(rc.err)} gain=${JSON.stringify(rc.gain)}`);
const tA = await judge('A', rc.ptz, 'live_after_center');
const passA = !!tA && Math.abs(tA.cx - 0.5) <= 0.03 && Math.abs(tA.cy - 0.5) <= 0.03;
console.log(`  판정 A(|err|≤0.03): ${passA ? 'PASS' : 'FAIL'}`);

// D. 게인 정합 — 실측 참값(-36.6/-21.0 @z1.69) 대비 ±20%
const gp = rc.gain.gainPan * (rc.gain.zoomRef / 1.69341);
const gt = rc.gain.gainTilt * (rc.gain.zoomRef / 1.69341);
const passD = Math.abs(gp - -36.6) <= 36.6 * 0.2 && Math.abs(gt - -21.0) <= 21.0 * 0.2;
console.log(`\n=== D. 게인 정합(@z1.69 환산) ===`);
console.log(`  측정 gainPan=${gp.toFixed(1)} (참값 -36.6±20%) / gainTilt=${gt.toFixed(1)} (참값 -21.0±20%)`);
console.log(`  판정 D: ${passD ? 'PASS' : 'FAIL'}`);

console.log('\n=== B. zoomToPlateWidth (센터링 결과 이어서, 게인 체이닝) ===');
const rz = await new PlatePtz({ camera, lpd }, { gain: rc.gain }).zoomToPlateWidth(CAM, PRESET, rc.ptz);
console.log(`  결과: ok=${rz.ok} reason=${rz.reason ?? '-'} iters=${rz.iterations} ptz=${JSON.stringify(rz.ptz)}`);
console.log(`  자기보고: width=${rz.plateWidth?.toFixed(4)}`);
const tB = await judge('B', rz.ptz, 'live_after_zoom');
const passB = !!tB && tB.w >= 0.18 && tB.w <= 0.22;
console.log(`  판정 B(폭 0.18~0.22): ${passB ? 'PASS' : 'FAIL'}`);

console.log('\n=== C. zoomToPlateWidth 단독(센터링 생략, base 에서 바로) ===');
const rzSolo = await new PlatePtz({ camera, lpd }).zoomToPlateWidth(CAM, PRESET, BASE);
console.log(`  결과: ok=${rzSolo.ok} reason=${rzSolo.reason ?? '-'} iters=${rzSolo.iterations} ptz=${JSON.stringify(rzSolo.ptz)}`);
console.log(`  자기보고: width=${rzSolo.plateWidth?.toFixed(4)}`);
const tC = await judge('C', rzSolo.ptz, 'live_zoom_solo');
const passC = !!tC && tC.w >= 0.18 && tC.w <= 0.22;
console.log(`  판정 C(단독 줌 폭 0.18~0.22): ${passC ? 'PASS' : 'FAIL'}`);

console.log(`\n=== 종합: A=${passA ? 'PASS' : 'FAIL'} B=${passB ? 'PASS' : 'FAIL'} C=${passC ? 'PASS' : 'FAIL'} D=${passD ? 'PASS' : 'FAIL'} ===`);
console.log(`스샷: ${OUT}`);
