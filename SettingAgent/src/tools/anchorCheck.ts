// 앵커 교정 근거 실측 — 앵커의 공유변과 이웃의 공유변 중 어느 쪽이 **검출된 도색선** 위에 있는가.
// 정본 무접촉(읽기만). 판정만 출력한다.
//   npx tsx src/tools/anchorCheck.ts <frameDir> <cam:preset> <anchorIdx>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, type FrameGray } from '../ground/floorPaint.js';

const [, , frameDir, key, anchorArg] = process.argv;
if (!frameDir || !key || !anchorArg) {
  console.error('사용: npx tsx src/tools/anchorCheck.ts <frameDir> <cam:preset> <anchorIdx>');
  process.exit(2);
}
const [camId, presetIdx] = key.split(':').map(Number);
const anchorIdx = Number(anchorArg);

const j = JSON.parse(readFileSync(join(frameDir, `frame_${camId}_${presetIdx}.json`), 'utf8')) as {
  result: { img_bytes: string; width: number; height: number };
};
const gray = await sharp(Buffer.from(j.result.img_bytes, 'base64')).greyscale().raw().toBuffer();
const frame: FrameGray = {
  data: new Uint8Array(gray.buffer, gray.byteOffset, gray.byteLength),
  width: j.result.width,
  height: j.result.height,
};
const { lines } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);

const root = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const cam = root.cameras.find((c: any) => c.camera.cam_id === camId);
const pre = cam.presets.find((p: any) => p.preset_idx === presetIdx);
const sp = pre.parking_spaces as Array<{ idx: number; points: number[][] }>;

const dist = (l: readonly number[], x: number, y: number) =>
  Math.abs(l[0] * x + l[1] * y + l[2]) / Math.hypot(l[0], l[1]);

/** 변의 양끝·중점 중 **최악** 표본 거리로 평가(부분적으로만 걸치는 선을 배제). */
function nearest(a: number[], b: number[]) {
  const samples = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b];
  let best = Infinity, bl: (typeof lines)[number] | null = null;
  for (const l of lines) {
    const d = samples.reduce((m, s) => Math.max(m, dist(l.line, s[0], s[1])), 0);
    if (d < best) { best = d; bl = l; }
  }
  return { d: best, l: bl! };
}

const A = sp.find((s) => s.idx === anchorIdx)!;
const N = sp[sp.indexOf(A) + 1];
if (!N) { console.error(`idx${anchorIdx} 의 이웃이 없다`); process.exit(3); }

// 체인 규약: 앵커의 (p2,p3) 가 이웃의 (p1,p0) 와 같은 변이어야 한다.
const ra = nearest(A.points[2], A.points[3]);
const rn = nearest(N.points[1], N.points[0]);
const gap2 = Math.hypot(A.points[2][0] - N.points[1][0], A.points[2][1] - N.points[1][1]);
const gap3 = Math.hypot(A.points[3][0] - N.points[0][0], A.points[3][1] - N.points[0][1]);

console.log(`\n=== ${key}  앵커 idx${A.idx} vs 이웃 idx${N.idx}  (검출 직선 ${lines.length}개)`);
console.log(`  앵커 공유변 → 최근접 도색선 ${ra.d.toFixed(2)}px  (폭 ${ra.l.widthPx.toFixed(1)} 대비 ${ra.l.contrast.toFixed(0)} span ${ra.l.spanPx.toFixed(0)})`);
console.log(`  이웃 공유변 → 최근접 도색선 ${rn.d.toFixed(2)}px  (폭 ${rn.l.widthPx.toFixed(1)} 대비 ${rn.l.contrast.toFixed(0)} span ${rn.l.spanPx.toFixed(0)})`);
console.log(`  두 변의 어긋남: p2 ${gap2.toFixed(2)}px · p3 ${gap3.toFixed(2)}px`);
console.log(`  ▶ ${rn.d < ra.d ? '이웃이 도색선에 더 가깝다 → 앵커를 이웃에 스냅하는 것이 옳다' : '앵커가 더 가깝다 → 교정하지 마라'}`);
console.log(`  교정안: idx${A.idx}.points[2] := [${N.points[1]}]  /  points[3] := [${N.points[0]}]`);
