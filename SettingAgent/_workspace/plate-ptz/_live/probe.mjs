/**
 * 1회용 라이브 프로브(검증 보조, 프로덕션 아님).
 * cam1 의 프리셋 PTZ 마다 Unity 13110 /rpc 로 캡처 → LPD 9082 검출 → 번호판 개수/폭/중심을 출력한다.
 * 목적: 폐루프 검증 대상(번호판이 실제로 보이는 프리셋)을 고르는 것.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const RPC = 'http://localhost:13110/rpc';
const LPD = 'http://192.168.0.125:9082/lpd/api/v1/imgupload';
const OUT = new URL('./shots/', import.meta.url).pathname.replace(/^\//, '');

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** JPEG SOF 마커에서 이미지 크기 파싱(LPD 응답이 픽셀 좌표라 정규화에 필요). */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG 크기 파싱 실패');
}

async function lpd(jpg) {
  const fd = new FormData();
  fd.append('file', new Blob([jpg], { type: 'image/jpeg' }), 'f.jpg');
  const r = await fetch(LPD, { method: 'POST', body: fd });
  return await r.json();
}

async function shot(camId, ptz, tag) {
  await rpc('cam.setPTZ', { camId, ...ptz });
  await new Promise((r) => setTimeout(r, 500));
  const cap = await rpc('cam.captureJPG', { camId });
  const jpg = Buffer.from(cap.img_bytes ?? '', 'base64');
  const { w, h } = jpegSize(jpg);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}${tag}.jpg`, jpg);

  const res = await lpd(jpg);
  const polys = res.polygons ?? [];
  const plates = polys.map((poly, i) => {
    const xs = poly.map((p) => p[0] / w);
    const ys = poly.map((p) => p[1] / h);
    const rw = Math.max(...xs) - Math.min(...xs);
    const rh = Math.max(...ys) - Math.min(...ys);
    return {
      cx: +((Math.min(...xs) + rw / 2).toFixed(3)),
      cy: +((Math.min(...ys) + rh / 2).toFixed(3)),
      w: +rw.toFixed(4),
      h: +rh.toFixed(4),
      conf: +(res.confidences?.[i] ?? 0).toFixed(2),
    };
  });
  console.log(`[${tag}] ptz=${JSON.stringify(ptz)} img=${w}x${h} plates=${plates.length}`);
  for (const p of plates) console.log(`   cx=${p.cx} cy=${p.cy} w=${p.w} conf=${p.conf}`);
  return plates;
}

const presets = [
  { id: 1, pan: 22, tilt: 6.8, zoom: 1.69341 },
  { id: 2, pan: 56.6, tilt: 7.4, zoom: 2.03134 },
  { id: 3, pan: 43.5, tilt: 18.8, zoom: 1.46583 },
];

for (const p of presets) {
  try {
    await shot(1, { pan: p.pan, tilt: p.tilt, zoom: p.zoom }, `p${p.id}`);
  } catch (e) {
    console.log(`[p${p.id}] 실패: ${e.message}`);
  }
}
console.log(`\n스샷 저장: ${OUT}`);
