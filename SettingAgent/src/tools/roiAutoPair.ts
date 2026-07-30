// P2 쌍 경로 진단 — 어느 게이트가 쌍 가설을 죽이는가(진단 전용, 수동 무참조).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS, detectPaintLines, paintEvidenceOf, refineSeparators, scanSeparators,
  type FrameGray, type RefinedLine,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, detectBaysPaired, type PairHypothesis } from '../ground/bayGeometry.js';

const dir = process.argv[2];
const key = (process.argv[3] ?? '2_2').replace('_', ':');
const [camId, presetIdx] = key.split(':').map(Number);
const j = JSON.parse(readFileSync(join(dir, `frame_${camId}_${presetIdx}.json`), 'utf8'));
const jpg = Buffer.from(j.result.img_bytes, 'base64');
const W = j.result.width, H = j.result.height;
const gb = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
const bays = Number(process.argv[4] ?? 4);

const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
const ev = paintEvidenceOf(mask, W, H);
const top = lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates);
const seps: RefinedLine[][] = top.map((ln) => {
  const pk = scanSeparators(frame, mask, ln, DEFAULT_PAINT_OPTIONS);
  return pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
});
console.log(`${key} 상위 ${top.length}선의 분리선 후보 수: ${seps.map((s) => s.length).join(' ')}`);
for (let a = 0; a < top.length; a++) {
  for (let b = 0; b < top.length; b++) {
    if (a === b) continue;
    if (seps[a].length < DEFAULT_BAY_OPTS.minPicks || seps[b].length < 2) continue;
    const pair: PairHypothesis = { near: top[a], far: top[b], nearSeps: seps[a], farSeps: seps[b] };
    const det = detectBaysPaired([pair], ev, DEFAULT_PAINT_OPTIONS, camId, presetIdx, W, H, 1, {
      ...DEFAULT_BAY_OPTS, expectedBays: bays,
      chordResidPx: Number(process.argv[5] ?? DEFAULT_BAY_OPTS.chordResidPx),
      depthRatioTol: Number(process.argv[6] ?? DEFAULT_BAY_OPTS.depthRatioTol),
    });
    const g = det.diag.gate;
    const bi = Object.entries(det.diag.buildIssues).map(([k, v]) => `${k}=${v}`).join(' ');
    if (det.diag.hypotheses === 0 && g.noLattice === 0) continue;
    console.log(
      `near=${a} far=${b} 가설=${det.diag.hypotheses} quad=${det.quads.length} ` +
      `격자없음=${g.noLattice} 기하=${g.buildFail}[${bi}] 폭=${g.widthSpread} 고=${g.heightDev} 도색=${g.paint} ` +
      `${det.quads.length ? `near지지=${det.diag.paint!.near.toFixed(2)} camH=${det.cameraHeightM!.toFixed(2)}` : ''}`);
  }
}
