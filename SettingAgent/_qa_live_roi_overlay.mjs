// 검증자 독립 확인 — 라이브 프레임 위에 실제 ROI(PtzCamRoi.json preset1, 런타임 데이터)를 그려
// 흰 주차선과 실제로 정합하는지 육안 확인용 PNG 를 만든다. (읽기 전용 — 런타임 파일 미수정)
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const RPC = 'http://localhost:13110/rpc';
let id = 1;
async function call(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const placeRoi = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const camerapos = JSON.parse(readFileSync('config/camerapos.json', 'utf8'));
const p1ptz = camerapos.datas[0].datas.find((d) => d.preset_id === 1);
const cam = placeRoi.cameras[0];
const p1 = cam.presets.find((p) => p.preset_idx === 1);

async function main() {
  console.error(`preset1 촬영: pan=${p1ptz.pan} tilt=${p1ptz.tilt} zoom=${p1ptz.zoom}`);
  await call('cam.setPTZ', { camId: 1, pan: p1ptz.pan, tilt: p1ptz.tilt, zoom: p1ptz.zoom });
  await new Promise((r) => setTimeout(r, 400));
  const { img_bytes } = await call('cam.captureJPG', { camId: 1 });
  const jpg = Buffer.from(img_bytes, 'base64');
  const meta = await sharp(jpg).metadata();
  console.error(`촬영 이미지: ${meta.width}x${meta.height}`);

  const polys = p1.parking_spaces
    .map((sp) => sp.points.map((p) => p.join(',')).join(' '))
    .map((pts, i) => `<polygon points="${pts}" fill="none" stroke="lime" stroke-width="3"/>`)
    .join('\n');
  const svg = `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${polys}</svg>`;

  const out = await sharp(jpg)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  writeFileSync(process.argv[2], out);
  console.error('저장 완료:', process.argv[2]);
}
main().catch((e) => { console.error('ERROR', e); process.exit(1); });
