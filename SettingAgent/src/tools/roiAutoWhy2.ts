// 지정 전방선 rank 의 분리선 교점을 참 코너와 대조(진단 전용, 수동은 자로만).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS, detectPaintLines, refineSeparators, scanSeparators, meetLines,
  type FrameGray, type RefinedLine,
} from '../ground/floorPaint.js';
import { meetLinesLS, vpResidPx } from '../ground/bayGeometry.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';

const dir = process.argv[2];
const key = (process.argv[3] ?? '2_2').replace('_', ':');
const rank = Number(process.argv[4] ?? 1);
const [camId, presetIdx] = key.split(':').map(Number);
const { byPreset } = normalizePtzCamRoi(JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8')));
const j = JSON.parse(readFileSync(join(dir, `frame_${camId}_${presetIdx}.json`), 'utf8'));
const jpg = Buffer.from(j.result.img_bytes, 'base64');
const W = j.result.width, H = j.result.height;
const gb = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
const manual = byPreset.get(key) ?? [];
const pts: Array<{ x: number; y: number }> = [];
for (const sp of manual) for (const p of sp.points) pts.push({ x: p.x * W, y: p.y * H });

const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
const front = lines[rank];
console.log(`${key} rank${rank} front votes=${front.votes} line=[${front.line.map((v) => v.toFixed(4)).join(',')}]`);
const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
const seps: RefinedLine[] = refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS);
console.log('스캔 피크(위치/각도/run):');
console.log('  ' + peaks.map((pk) => `(${pk.p.x.toFixed(0)},${pk.p.y.toFixed(0)})a=${pk.angleDeg.toFixed(0)}r=${pk.runPx.toFixed(0)}`).join(' '));
console.log('정련 선분 길이: ' + seps.map((sp) => Math.hypot(sp.endB.x - sp.endA.x, sp.endB.y - sp.endA.y).toFixed(0)).join(' '));
const ux = -front.line[1], uy = front.line[0];
const ox = -front.line[2] * front.line[0], oy = -front.line[2] * front.line[1];
const rows = seps.map((sp) => {
  const p = meetLines(sp.line, front.line)!;
  return { sp, p, s: (p.x - ox) * ux + (p.y - oy) * uy };
}).filter((r) => r.p).sort((a, b) => a.s - b.s);
console.log(`분리선 ${rows.length}개 교점(전방선 위):`);
console.log('  ' + rows.map((r) => `(${r.p.x.toFixed(0)},${r.p.y.toFixed(0)})`).join(' '));
// 참 코너(수동 정점 중 이 전방선에 가까운 것)
const near = pts.filter((p) => Math.abs(front.line[0] * p.x + front.line[1] * p.y + front.line[2]) < 12);
const uniq: Array<{ x: number; y: number }> = [];
for (const p of near) if (!uniq.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 15)) uniq.push(p);
uniq.sort((a, b) => a.x - b.x);
console.log(`참 근변 코너(전방선 12px 이내) ${uniq.length}개: ` + uniq.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '));
for (const t of uniq) {
  let best = Infinity, bi = -1;
  rows.forEach((r, i) => { const d = Math.hypot(r.p.x - t.x, r.p.y - t.y); if (d < best) { best = d; bi = i; } });
  console.log(`  참(${t.x.toFixed(0)},${t.y.toFixed(0)}) → 최근접 교점 #${bi} 거리 ${best.toFixed(1)}px`);
}
// 참 코너에 대응하는 분리선들이 한 점에 모이는가
const idxs = uniq.map((t) => { let b = Infinity, bi = -1; rows.forEach((r, i) => { const d = Math.hypot(r.p.x - t.x, r.p.y - t.y); if (d < b) { b = d; bi = i; } }); return b < 25 ? bi : -1; }).filter((i) => i >= 0);
const uu = [...new Set(idxs)];
if (uu.length >= 2) {
  const V = meetLinesLS(uu.map((i) => rows[i].sp.line))!;
  console.log(`참코너 대응 분리선 ${uu.length}개의 VP_d = (${V.x.toFixed(0)},${V.y.toFixed(0)})`);
  for (const i of uu) console.log(`   sep#${i} vpResid=${vpResidPx(V, rows[i].sp.endA, rows[i].sp.endB).toFixed(2)}px  seg=(${rows[i].sp.endA.x.toFixed(0)},${rows[i].sp.endA.y.toFixed(0)})-(${rows[i].sp.endB.x.toFixed(0)},${rows[i].sp.endB.y.toFixed(0)})`);
  const cx = W / 2, cy = H / 2;
  const sVals = uu.map((i) => rows[i].s);
  console.log(`   교점 s=[${sVals.map((v) => v.toFixed(0)).join(' ')}]`);
}
