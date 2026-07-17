/**
 * PlatePtz 수동 시험 실행기 (검증·시연용 — 프로덕션 아님).
 *
 * 사용법:
 *   npx tsx _workspace/plate-ptz/_live/try.mts [옵션]
 *
 * 옵션 (전부 생략 가능):
 *   --cam=1          카메라 번호(1-based, 기본 1)
 *   --preset=1       프리셋 번호(config/camerapos.json 에서 base PTZ 를 읽는다, 기본 1)
 *   --ptz=22,6.8,1.7 base PTZ 를 직접 지정(pan,tilt,zoom). 주면 --preset 무시
 *   --mode=both      both(기본, 센터링→줌) | center(센터링만) | zoom(줌만 단독)
 *   --target=0.2     목표 번호판 폭(화면 가로 대비, 기본 0.2 = 20%)
 *   --tol=0.02       폭 허용오차(기본 0.02)
 *
 * 예:
 *   npx tsx _workspace/plate-ptz/_live/try.mts --preset=2
 *   npx tsx _workspace/plate-ptz/_live/try.mts --preset=3 --mode=center
 *   npx tsx _workspace/plate-ptz/_live/try.mts --ptz=22,6.8,1.69341 --target=0.3
 *
 * 결과 스샷: _workspace/plate-ptz/_live/shots/try_*.jpg
 * 전제: Unity 시뮬(13110 /rpc)·LPD(9082) 기동.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadToolsConfig } from '../../../src/config/toolsConfig.js';
import { CRpcClient } from '../../../src/clients/CRpcClient.js';
import { RpcCameraClient } from '../../../src/clients/RpcCameraClient.js';
import { LpdClient } from '../../../src/clients/LpdClient.js';
import { PlatePtz } from '../../../src/calibrate/platePtz.js';
import { quadBoundingRect } from '../../../src/domain/geometry.js';
import type { Ptz } from '../../../src/calibrate/types.js';

const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;

const CAM = Number(arg('cam', '1'));
const PRESET = Number(arg('preset', '1'));
const MODE = arg('mode', 'both') as 'both' | 'center' | 'zoom';
const TARGET = Number(arg('target', '0.2'));
const TOL = Number(arg('tol', '0.02'));
const OUT = '_workspace/plate-ptz/_live/shots/';
mkdirSync(OUT, { recursive: true });

/** base PTZ: --ptz 우선, 없으면 camerapos.json 의 해당 프리셋. */
function basePtz(): Ptz {
  const raw = arg('ptz');
  if (raw) {
    const [pan, tilt, zoom] = raw.split(',').map(Number);
    return { pan, tilt, zoom };
  }
  const j = JSON.parse(readFileSync('config/camerapos.json', 'utf-8')) as {
    datas: { cam_id: number; datas: { preset_id: number; pan: number; tilt: number; zoom: number }[] }[];
  };
  const cam = j.datas.find((c) => c.cam_id === CAM);
  const p = cam?.datas.find((d) => d.preset_id === PRESET);
  if (!p) throw new Error(`camerapos.json 에 cam=${CAM} preset=${PRESET} 없음`);
  return { pan: p.pan, tilt: p.tilt, zoom: p.zoom };
}

const cfg = loadToolsConfig();
const rpc = new CRpcClient({ baseUrl: 'http://localhost:13110', timeoutMs: 8000 });
const camera = new RpcCameraClient({ rpc, cameraCfg: cfg.camera, cameraposFile: 'config/camerapos.json' });
const lpd = new LpdClient(cfg.lpd);

/** 지정 PTZ 로 캡처해 스샷 저장 + 검출 요약(참고용 — 판정 아님). */
async function snap(ptz: Ptz, tag: string) {
  const cap = await camera.requestImage(CAM, PRESET, ptz);
  writeFileSync(`${OUT}try_${tag}.jpg`, cap.jpg);
  const plates = await lpd.detect(cap.jpg);
  const near = plates
    .map((p) => {
      const r = quadBoundingRect(p.quad);
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w };
    })
    .sort((a, b) => Math.hypot(a.cx - 0.5, a.cy - 0.5) - Math.hypot(b.cx - 0.5, b.cy - 0.5))[0];
  console.log(
    `  스샷 ${OUT}try_${tag}.jpg — 검출 ${plates.length}개` +
      (near ? `, 화면중심 최근접: cx=${near.cx.toFixed(3)} cy=${near.cy.toFixed(3)} 폭=${near.w.toFixed(4)}` : ''),
  );
}

function report(name: string, r: Awaited<ReturnType<PlatePtz['centerOnPlate']>>) {
  console.log(`\n[${name}]`);
  console.log(`  성공 : ${r.ok}${r.reason ? `  (실패사유: ${r.reason})` : ''}`);
  console.log(`  반복 : ${r.iterations}회`);
  console.log(`  PTZ  : pan=${r.ptz.pan.toFixed(3)} tilt=${r.ptz.tilt.toFixed(3)} zoom=${r.ptz.zoom.toFixed(3)}`);
  if (r.err) console.log(`  중심오차: errX=${r.err.errX.toFixed(4)} errY=${r.err.errY.toFixed(4)}`);
  if (r.plateWidth !== null) console.log(`  번호판 폭: ${r.plateWidth.toFixed(4)} (화면 가로의 ${(r.plateWidth * 100).toFixed(1)}%)`);
  console.log(`  게인 : pan=${r.gain.gainPan.toFixed(2)} tilt=${r.gain.gainTilt.toFixed(2)} (zoomRef=${r.gain.zoomRef})`);
}

const BASE = basePtz();
console.log(`=== PlatePtz 시험 — cam=${CAM} preset=${PRESET} mode=${MODE} ===`);
console.log(`base PTZ: pan=${BASE.pan} tilt=${BASE.tilt} zoom=${BASE.zoom} / 목표 폭 ${TARGET}±${TOL}`);
console.log('\n[시작 화면]');
await snap(BASE, 'before');

const opts = { targetPlateWidth: TARGET, widthTol: TOL };

if (MODE === 'center') {
  const r = await new PlatePtz({ camera, lpd }, opts).centerOnPlate(CAM, PRESET, BASE);
  report('센터링 (pan/tilt — zoom 불변)', r);
  await snap(r.ptz, 'center');
} else if (MODE === 'zoom') {
  const r = await new PlatePtz({ camera, lpd }, opts).zoomToPlateWidth(CAM, PRESET, BASE);
  report('줌 단독 (센터링 생략)', r);
  await snap(r.ptz, 'zoom_solo');
} else {
  const c = await new PlatePtz({ camera, lpd }, opts).centerOnPlate(CAM, PRESET, BASE);
  report('1단계 · 센터링 (pan/tilt — zoom 불변)', c);
  await snap(c.ptz, 'center');
  if (!c.ok) console.log('\n  ※ 센터링 실패 — 그래도 줌을 이어서 시도합니다(단독 동작 확인).');
  // 센터링에서 실측한 게인을 줌 가드에 체이닝(권장 사용법).
  const z = await new PlatePtz({ camera, lpd }, { ...opts, gain: c.gain }).zoomToPlateWidth(CAM, PRESET, c.ptz);
  report('2단계 · 줌 (번호판 폭 → 목표)', z);
  await snap(z.ptz, 'zoom');
}

console.log(`\n스샷 폴더: ${OUT}`);
