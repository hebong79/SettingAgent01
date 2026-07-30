// 왜 그 가설이 이겼나 — 전방선 후보별 추적(진단 전용). 수동 quad 는 **자(尺)로만** 쓴다(파이프라인 입력 아님).
// 정본·DB 무접촉(읽기만). 사용:
//   npx tsx src/tools/roiAutoWhy.ts <frameDir> <key 예 2_2> [placeRoiFile]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  lineThrough,
  type FrameGray,
  type RefinedLine,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, detectBays, type FrontHypothesis } from '../ground/bayGeometry.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { quadIoU } from '../ground/autoRoiPlan.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import type { PixelQuad } from '../ground/types.js';

const dir = process.argv[2];
const key = (process.argv[3] ?? '2_2').replace('_', ':');
const placeFile = process.argv[4] ?? 'data/Place01/PtzCamRoi.json';
const [camId, presetIdx] = key.split(':').map(Number);

const { byPreset } = normalizePtzCamRoi(JSON.parse(readFileSync(placeFile, 'utf8')));
const j = JSON.parse(readFileSync(join(dir, `frame_${camId}_${presetIdx}.json`), 'utf8')) as {
  result: { img_bytes: string; width: number; height: number };
  preset?: { zoom?: number };
};
const jpg = Buffer.from(j.result.img_bytes, 'base64');
const W = j.result.width;
const H = j.result.height;
const grayBuf = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength), width: W, height: H };
const manual = byPreset.get(key) ?? [];
const bays = manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;

// ── 진단 자: 수동 quad 의 최하단 변(카메라 최근접)을 참 근변으로 본다.
const truthQuads: PixelQuad[] = [];
const truthNearEdges: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
for (const sp of manual) {
  if (sp.points.length !== 4) continue;
  const q = sp.points.map((p) => ({ x: p.x * W, y: p.y * H }));
  truthQuads.push(canonicalizeQuad(q as PixelQuad) as PixelQuad);
  let best = 0;
  let bestY = -Infinity;
  for (let e = 0; e < 4; e++) {
    const yy = (q[e].y + q[(e + 1) % 4].y) / 2;
    if (yy > bestY) {
      bestY = yy;
      best = e;
    }
  }
  truthNearEdges.push([q[best], q[(best + 1) % 4]]);
}
/** 직선이 참 근변들과 얼마나 맞는가(최대 법선거리 px). */
function nearLineErr(l: readonly [number, number, number]): number {
  let worst = 0;
  for (const [A, B] of truthNearEdges) {
    worst = Math.max(worst, Math.abs(l[0] * A.x + l[1] * A.y + l[2]), Math.abs(l[0] * B.x + l[1] * B.y + l[2]));
  }
  return worst;
}

const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
const ev = paintEvidenceOf(mask, W, H);
console.log(`=== ${key} 직선 ${lines.length} · 수동 ${bays}면 · 전방선 후보 상위 ${DEFAULT_PAINT_OPTIONS.frontCandidates}`);

lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates).forEach((front, i) => {
  const err = nearLineErr(front.line);
  const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
  const seps: RefinedLine[] = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
  const hyp: FrontHypothesis[] = seps.length >= DEFAULT_BAY_OPTS.minPicks ? [{ front, separators: seps }] : [];
  const det = detectBays(hyp, ev, DEFAULT_PAINT_OPTIONS, camId, presetIdx, W, H, j.preset?.zoom ?? 1, {
    ...DEFAULT_BAY_OPTS,
    expectedBays: Math.max(1, bays),
  });
  const ious = truthQuads.map((t) => Math.max(0, ...det.quads.map((q) => quadIoU(q.quad, t))));
  const p = det.diag.paint;
  console.log(
    `rank${String(i).padStart(2)} votes=${String(front.votes).padStart(4)} 참근변오차=${err.toFixed(1).padStart(7)}px ` +
      `피크=${String(peaks.length).padStart(2)} 가설=${String(det.diag.hypotheses).padStart(4)} quad=${det.quads.length} ` +
      `탈락(도색)=${String(det.diag.rejectedByPaint).padStart(4)} ` +
      `near=${p ? p.near.toFixed(2) : ' -- '} far=${p ? p.far.toFixed(2) : ' -- '} side=${p ? p.side.toFixed(2) : ' -- '} ` +
      `score=${p ? p.score.toFixed(3) : ' -- '} camH=${det.cameraHeightM?.toFixed(2) ?? '--'} ` +
      `maxIoU=${ious.length ? Math.max(...ious).toFixed(4) : '--'} 평균IoU=${ious.length ? (ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(4) : '--'}`,
  );
  const g = det.diag.gate;
  const bi = Object.entries(det.diag.buildIssues).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`         게이트 탈락: 격자없음=${g.noLattice} 기하실패=${g.buildFail}[${bi}] 폭편차=${g.widthSpread} 지상고=${g.heightDev} 도색=${g.paint}`);
  if (det.quads.length === 0 && det.issues.length) console.log(`         ! ${det.issues[0]}`);
});
