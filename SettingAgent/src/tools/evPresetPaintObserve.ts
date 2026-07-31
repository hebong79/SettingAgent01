// ★ 22회차 — 실카 프리셋 5장에 `detectPaintLines` 를 **읽기 전용으로** 돌려 무엇이 잡히는지 관찰.
//
// ⚠ 관찰일 뿐 채점이 아니다. 정답(truth.json)과 대조해 점수를 내지 않는다.
//   정본·DB 무접촉, 카메라 무접촉, 알고리즘 무수정.
//
// 사용: npx tsx src/tools/evPresetPaintObserve.ts

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, type FrameGray } from '../ground/floorPaint.js';

const SRC_DIR = 'd:/Work/Parking3D/AgentVLA/ParkAgent/etc/camera_preset';
const OUT_DIR = 'reports/truth_evpreset';
mkdirSync(OUT_DIR, { recursive: true });

for (const name of ['EV1', 'EV2', 'EV3', 'EV4', 'EV5']) {
  const src = join(SRC_DIR, `${name}.png`);
  const meta = await sharp(src).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gb = await sharp(src).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
  const { lines, threshold } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);

  const parts: string[] = [];
  const top = lines.slice(0, 12);
  top.forEach((r, i) => {
    const [a, b, c] = r.line;
    // a*x+b*y+c=0 을 화면 경계에서 잘라 그린다.
    const pts: Array<{ x: number; y: number }> = [];
    if (Math.abs(b) > 1e-9) {
      for (const x of [0, W]) {
        const y = -(a * x + c) / b;
        if (y >= 0 && y <= H) pts.push({ x, y });
      }
    }
    if (Math.abs(a) > 1e-9) {
      for (const y of [0, H]) {
        const x = -(b * y + c) / a;
        if (x >= 0 && x <= W) pts.push({ x, y });
      }
    }
    if (pts.length < 2) return;
    const col = `hsl(${(i * 31) % 360} 95% 60%)`;
    parts.push(`<line x1="${pts[0].x.toFixed(1)}" y1="${pts[0].y.toFixed(1)}" x2="${pts[1].x.toFixed(1)}" y2="${pts[1].y.toFixed(1)}" stroke="${col}" stroke-width="3"/>`);
    parts.push(`<text x="${pts[1].x.toFixed(0)}" y="${(pts[1].y - 6).toFixed(0)}" fill="${col}" font-size="22" font-weight="bold" text-anchor="end" stroke="#000" stroke-width="0.7">#${i} v${r.votes}</text>`);
  });
  parts.push(`<rect x="14" y="14" width="1000" height="96" fill="#000000cc" rx="8"/>`);
  parts.push(`<text x="30" y="52" fill="#fff" font-size="27" font-weight="bold">${name} · detectPaintLines 관찰(읽기 전용)</text>`);
  parts.push(`<text x="30" y="90" fill="#ddd" font-size="21">직선 ${lines.length}개 · 상위 ${top.length}개 표시 · mask thr ${threshold.toFixed(1)}</text>`);

  const out = join(OUT_DIR, `paintobs_${name}.png`);
  await sharp(src)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(out);
  console.log(`${name}: 직선 ${lines.length}개 (상위 votes ${top.map((r) => r.votes).join(',')}) → ${out}`);
}
