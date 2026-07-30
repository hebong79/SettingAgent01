// PTZ 소폭 변주로 관측을 늘린다(LOPO 검증용). **프레임 취득 전 roi.show2d{visible:false} 필수**(D-5).
// 정본·DB 무접촉(읽기만). 사용: npx tsx src/tools/roiAutoJitter.ts <outDir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('사용: npx tsx src/tools/roiAutoJitter.ts <outDir>'); process.exit(2); }
const RPC = 'http://localhost:13110/rpc';
let id = 0;
async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json() as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const roi = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
/** 기준 프리셋 PTZ (camerapos 가 아니라 정본 메타의 preset pan/tilt/zoom). */
const base: Array<{ cam: number; preset: number; pan: number; tilt: number; zoom: number }> = [];
for (const c of roi.cameras) for (const p of c.presets) {
  base.push({ cam: c.camera.cam_id, preset: p.preset_idx, pan: p.pan, tilt: p.tilt, zoom: p.zoom });
}
/** 고정 변주 격자(난수 0). zoom 은 **고정** — fov 가 바뀌면 제원 주입이 흔들린다. */
const JIT: Array<[number, number]> = [[0,0],[1.5,0],[-1.5,0],[0,0.8],[0,-0.8],[1.0,0.6]];

await rpc('roi.show2d', { visible: false });   // ★ D-5
console.log('roi.show2d visible=false 적용');
let n = 0;
for (const b of base) {
  for (const [dp, dt] of JIT) {
    const pan = b.pan + dp, tilt = b.tilt + dt;
    await rpc('cam.setPTZ', { camId: b.cam, pan, tilt, zoom: b.zoom });
    const cap = await rpc('cam.captureJPG', { camId: b.cam });
    const tag = `${b.cam}_${b.preset}_${dp >= 0 ? 'p' : 'm'}${Math.abs(dp * 10)}_${dt >= 0 ? 'p' : 'm'}${Math.abs(dt * 10)}`;
    writeFileSync(join(out, `jit_${tag}.json`), JSON.stringify({
      result: cap, base: { cam: b.cam, preset: b.preset, pan: b.pan, tilt: b.tilt, zoom: b.zoom },
      actual: { pan, tilt, zoom: b.zoom }, jitter: { dpan: dp, dtilt: dt },
    }));
    n++;
    process.stdout.write(`\r취득 ${n}/${base.length * JIT.length}  ${tag}      `);
  }
}
console.log(`\n완료: ${n}관측 → ${out}`);
