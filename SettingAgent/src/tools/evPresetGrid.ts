// ★ 22회차 — 실카 프리셋 정답 라벨링 **보조 격자**(채점 전용 R1, 검출 경로 무접촉).
//
// 원본 EV1~EV5 위에 좌표 격자를 얹어 저장한다. 사람(=라벨러)이 그림을 보고
// 모서리 픽셀 좌표를 읽기 위한 눈금자일 뿐, 어떤 알고리즘도 이 출력을 읽지 않는다.
//
// 사용:
//   npx tsx src/tools/evPresetGrid.ts                    # 전체 5장 전역 격자
//   npx tsx src/tools/evPresetGrid.ts EV3 600 300 700 400 # 크롭 확대 격자(x y w h)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const SRC_DIR = 'd:/Work/Parking3D/AgentVLA/ParkAgent/etc/camera_preset';
const OUT_DIR = 'reports/truth_evpreset';
const NAMES = ['EV1', 'EV2', 'EV3', 'EV4', 'EV5'];

mkdirSync(OUT_DIR, { recursive: true });

/** 전역 격자: 100px 주선(라벨) + 50px 보조선. */
function gridSvg(w: number, h: number, major = 100, minor = 50): string {
  const p: string[] = [];
  for (let x = 0; x <= w; x += minor) {
    const isMaj = x % major === 0;
    p.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${isMaj ? '#00e5ff' : '#00e5ff55'}" stroke-width="${isMaj ? 1.6 : 0.8}"/>`);
  }
  for (let y = 0; y <= h; y += minor) {
    const isMaj = y % major === 0;
    p.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${isMaj ? '#00e5ff' : '#00e5ff55'}" stroke-width="${isMaj ? 1.6 : 0.8}"/>`);
  }
  for (let x = 0; x <= w; x += major) {
    for (let y = 0; y <= h; y += major * 2) {
      p.push(`<text x="${x + 4}" y="${y + 22}" fill="#ffea00" font-size="19" font-weight="bold" stroke="#000" stroke-width="0.6">${x}</text>`);
    }
  }
  for (let y = 0; y <= h; y += major) {
    for (let x = 0; x <= w; x += major * 3) {
      p.push(`<text x="${x + 4}" y="${y - 5}" fill="#ff4081" font-size="19" font-weight="bold" stroke="#000" stroke-width="0.6">${y}</text>`);
    }
  }
  return p.join('');
}

/** 크롭 확대 격자: 원본 좌표계 라벨을 유지한 채 scale 배 확대. */
function cropGridSvg(x0: number, y0: number, w: number, h: number, scale: number, step: number): string {
  const p: string[] = [];
  const firstX = Math.ceil(x0 / step) * step;
  const firstY = Math.ceil(y0 / step) * step;
  for (let X = firstX; X <= x0 + w; X += step) {
    const sx = (X - x0) * scale;
    p.push(`<line x1="${sx}" y1="0" x2="${sx}" y2="${h * scale}" stroke="#00e5ff88" stroke-width="1"/>`);
    p.push(`<text x="${sx + 3}" y="20" fill="#ffea00" font-size="17" font-weight="bold" stroke="#000" stroke-width="0.6">${X}</text>`);
  }
  for (let Y = firstY; Y <= y0 + h; Y += step) {
    const sy = (Y - y0) * scale;
    p.push(`<line x1="0" y1="${sy}" x2="${w * scale}" y2="${sy}" stroke="#00e5ff88" stroke-width="1"/>`);
    p.push(`<text x="3" y="${sy - 4}" fill="#ff4081" font-size="17" font-weight="bold" stroke="#000" stroke-width="0.6">${Y}</text>`);
  }
  return p.join('');
}

const args = process.argv.slice(2);

if (args.length >= 5) {
  const [name, xs, ys, ws, hs, ss, sts] = args;
  const x0 = Number(xs);
  const y0 = Number(ys);
  const w = Number(ws);
  const h = Number(hs);
  const scale = Number(ss ?? 2);
  const step = Number(sts ?? 25);
  const out = join(OUT_DIR, `grid_${name}_crop_${x0}_${y0}_${w}x${h}.png`);
  const base = await sharp(join(SRC_DIR, `${name}.png`))
    .extract({ left: x0, top: y0, width: w, height: h })
    .resize({ width: Math.round(w * scale), height: Math.round(h * scale), kernel: 'nearest' })
    .png()
    .toBuffer();
  const svg = `<svg width="${w * scale}" height="${h * scale}" xmlns="http://www.w3.org/2000/svg">${cropGridSvg(x0, y0, w, h, scale, step)}</svg>`;
  await sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
  console.log(`crop → ${out}`);
} else {
  for (const n of NAMES) {
    const src = join(SRC_DIR, `${n}.png`);
    const meta = await sharp(src).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const out = join(OUT_DIR, `grid_${n}.png`);
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${gridSvg(W, H)}</svg>`;
    await sharp(src).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
    console.log(`${n} ${W}x${H} → ${out}`);
  }
}
