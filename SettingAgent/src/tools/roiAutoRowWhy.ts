// 근변선 후보별 격자 결과 + IoU 대조(진단 전용, 수동은 자로만).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, meetLines, paintEvidenceOf, refineSeparators, scanSeparators, type FrameGray } from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { fitRowGrid } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { quadIoU } from '../ground/autoRoiPlan.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import type { PixelQuad } from '../ground/types.js';

const dir = process.argv[2];
const key = (process.argv[3] ?? '2_2').replace('_', ':');
const [camId, presetIdx] = key.split(':').map(Number);
const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intr = placeMetaProvider(readPlaceMeta(placeJson)).get(camId, presetIdx)!;
const j = JSON.parse(readFileSync(join(dir, `frame_${camId}_${presetIdx}.json`), 'utf8'));
const jpg = Buffer.from(j.result.img_bytes, 'base64');
const W = j.result.width, H = j.result.height;
const gb = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
const model = groundModelFromIntrinsics(intr, j.preset?.zoom ?? 1)!;
const manual = byPreset.get(key) ?? [];
const bays = manual.filter((s) => s.points.length === 4).length;
const truths: PixelQuad[] = manual.filter((s) => s.points.length === 4)
  .map((s) => canonicalizeQuad(s.points.map((p) => ({ x: p.x * W, y: p.y * H })) as PixelQuad) as PixelQuad);
const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
const ev = paintEvidenceOf(mask, W, H);
console.log(`${key} f=${model.f.toFixed(1)} tilt=${intr.tiltDeg} h=${intr.heightM} 베이=${bays}`);
lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates).forEach((front, i) => {
  const pk = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
  const refined = pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
  const pts: Array<{ x: number; y: number }> = [];
  for (const sep of refined) { const p = meetLines(sep.line, front.line); if (p) pts.push(p); }
  const g = fitRowGrid(model, front, pts, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: bays, farWeight: Number(process.env.FARW ?? DEFAULT_BAY_OPTS.farWeight), aimCenterWeight: Number(process.env.AIMW ?? DEFAULT_BAY_OPTS.aimCenterWeight), extendMinNearSupport: Number(process.env.EXTMIN ?? DEFAULT_BAY_OPTS.extendMinNearSupport), maxHeightCorrection: Number(process.env.MAXHC ?? DEFAULT_BAY_OPTS.maxHeightCorrection), coverageExponent: Number(process.env.COVEXP ?? DEFAULT_BAY_OPTS.coverageExponent), maxRowDistanceRatio: Number(process.env.DISTR ?? DEFAULT_BAY_OPTS.maxRowDistanceRatio) });
  if (!g) { console.log(`rank${i} votes=${front.votes} → 격자 없음`); return; }
  const ious = truths.map((t) => Math.max(0, ...g.quads.map((q) => quadIoU(q.quad, t))));
  console.log(`      칸별: ${g.cellDiag.map((c) => `k${c.index}:${c.near.toFixed(2)}${c.kept ? '*' : ''}${c.inFrame ? '' : '(밖)'}`).join(' ')}`);
  const ctr = g.quads.map((q) => ({ x: q.quad.reduce((a, b) => a + b.x, 0) / 4, y: q.quad.reduce((a, b) => a + b.y, 0) / 4 }));
  console.log(`      quad중심: ${ctr.map((c) => `(${c.x.toFixed(0)},${c.y.toFixed(0)})`).join(' ')}`);
  console.log(`rank${i} votes=${String(front.votes).padStart(4)} quad=${g.quads.length} near=${g.paint.near.toFixed(3)} far=${g.paint.far.toFixed(3)} side=${g.paint.side.toFixed(3)} score=${g.paint.score.toFixed(3)} eff=${(g.effectiveScore ?? 0).toFixed(3)} 위상적합=${g.phaseFitM?.toFixed(3) ?? '--'}m | IoU=[${ious.map((v) => v.toFixed(3)).join(' ')}] 평균=${(ious.reduce((a,b)=>a+b,0)/ious.length).toFixed(4)}`);
});
