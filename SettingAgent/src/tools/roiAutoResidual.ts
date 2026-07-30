// ★ 7회차 P1 — IoU 결손의 **성분 분해**(진단 전용). 수동 quad 는 **자(尺)로만** 쓴다(파이프라인 입력 아님).
//
// 왜 필요한가: `1:1`·`2:1` 13면이 0.93~0.97 에 정체돼 있고, 특히 `2:1` 은 0.9301~0.9321 로 **균일**하다.
// 균일한 결손은 잡음이 아니라 **계통 편차**다. 자동·수동 quad 를 **같은 지면모델**로 역투영해 미터 좌표에서
// 비교하면 어느 성분이 틀렸는지 특정할 수 있다.
//
// 성분 4개:
//   ① 근변 법선 오프셋(m) — 행 전체가 깊이축으로 밀렸는가
//   ② 폭 피치(m)          — 2.5m 대비. 높이 자가보정이 맞추는 성분
//   ③ **깊이 연장(m)**     — 5.0m 대비. ★ 유력 용의자: 원변 도색이 없어 **독립 관측이 없다**(F2).
//                            깊이만 계통적으로 틀려도 어떤 구속도 잡아내지 못한다
//   ④ 전단/회전(도)        — 폭축 대비 깊이축 방향 오차
//
// 사용: npx tsx src/tools/roiAutoResidual.ts <frameDir> [placeRoiFile]

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  meetLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  type FrameGray,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { detectBaysWithModel, widthCoordOf, type RowCandidate, type RowFrame } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { backprojectToGround, dot3 } from '../ground/project.js';
import { quadIoU } from '../ground/autoRoiPlan.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import type { Px, Vec3 } from '../ground/contactTypes.js';

const dir = process.argv[2];
const placeFile = process.argv[3] ?? 'data/Place01/PtzCamRoi.json';
if (!dir) {
  console.error('사용: npx tsx src/tools/roiAutoResidual.ts <frameDir> [placeRoiFile]');
  process.exit(2);
}
const placeJson = JSON.parse(readFileSync(placeFile, 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

/** 픽셀 quad → 행 좌표계 (a=폭, b=깊이) 4점. 역투영 실패 → null. */
function toRowCoords(q: PixelQuad, fr: RowFrame, model: GroundModel): Array<{ a: number; b: number }> | null {
  const out: Array<{ a: number; b: number }> = [];
  for (const p of q) {
    const X = backprojectToGround(p as Px, model);
    if (!X) return null;
    const v: Vec3 = [X[0] - fr.origin[0], X[1] - fr.origin[1], X[2] - fr.origin[2]];
    out.push({ a: dot3(v, fr.u), b: dot3(v, fr.v) });
  }
  return out;
}

/** 행 좌표 4점(캐노니컬: p0=근좌, p1=원좌, p2=원우, p3=근우) → 성분. */
function componentsOf(c: ReadonlyArray<{ a: number; b: number }>): {
  nearB: number;
  widthM: number;
  depthM: number;
  shearDeg: number;
} {
  const nearB = (c[0].b + c[3].b) / 2;
  const widthM = Math.hypot(c[3].a - c[0].a, c[3].b - c[0].b);
  const depthM = (Math.hypot(c[1].a - c[0].a, c[1].b - c[0].b) + Math.hypot(c[2].a - c[3].a, c[2].b - c[3].b)) / 2;
  // 깊이축이 폭축에 대해 이루는 각(90°가 정상).
  const ua = c[3].a - c[0].a;
  const ub = c[3].b - c[0].b;
  const va = c[1].a - c[0].a;
  const vb = c[1].b - c[0].b;
  const ang = (Math.atan2(vb, va) - Math.atan2(ub, ua)) * (180 / Math.PI);
  const norm = ((ang % 360) + 540) % 360 - 180;
  return { nearB, widthM, depthM, shearDeg: norm };
}

const files = readdirSync(dir).filter((f) => /^frame_\d+_\d+\.json$/.test(f)).sort();
console.log('성분 분해 — 자동 vs 수동을 **같은 지면모델**로 역투영해 미터로 비교(수동은 자로만 사용)');
console.log('  Δ근변b = 자동 − 수동 근변 깊이좌표(m, +면 자동이 더 멀다)');
console.log('  폭/깊이 = 자동 값(m) 및 수동 값(m)   전단 = 깊이축이 폭축과 이루는 각 − 90°\n');

for (const f of files) {
  const m = /^frame_(\d+)_(\d+)\.json$/.exec(f);
  if (!m) continue;
  const camId = Number(m[1]);
  const presetIdx = Number(m[2]);
  const key = `${camId}:${presetIdx}`;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
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
  const intr = intrinsics.get(camId, presetIdx);
  const model0 = intr ? groundModelFromIntrinsics(intr, j.preset?.zoom ?? 1) : null;
  if (!model0) {
    console.log(`=== ${key}: 제원 공급 실패`);
    continue;
  }
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, W, H);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const refined = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sep of refined) {
      const q = meetLines(sep.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  const grid = detectBaysWithModel(cands, model0, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, bays) }, frame);
  const best = grid.best;
  if (!best) {
    console.log(`=== ${key}: 격자 없음`);
    continue;
  }
  const model = best.modelUsed;
  const fr = best.frame;

  console.log(`=== ${key}  (f=${model.f.toFixed(1)}px, 지상고 ${model.d.toFixed(3)}m, quad ${best.quads.length})`);
  console.log('  슬롯   IoU     Δ근변b(m)   폭 자동/수동      깊이 자동/수동     전단(°)');
  const rows: Array<{ dNear: number; wA: number; wM: number; dA: number; dM: number; sh: number; iou: number }> = [];
  for (const sp of manual) {
    if (sp.points.length !== 4) continue;
    const mq = canonicalizeQuad(sp.points.map((p) => ({ x: p.x * W, y: p.y * H })) as PixelQuad);
    if (!mq) continue;
    let bestIou = 0;
    let bestAuto: PixelQuad | null = null;
    for (const q of best.quads) {
      const v = quadIoU(q.quad, mq);
      if (v > bestIou) {
        bestIou = v;
        bestAuto = q.quad;
      }
    }
    if (!bestAuto || bestIou < 0.3) {
      console.log(`  s${String(sp.idx).padStart(2)}   ${bestIou.toFixed(4)}   (매칭 없음)`);
      continue;
    }
    const ca = toRowCoords(bestAuto, fr, model);
    const cm = toRowCoords(mq, fr, model);
    if (!ca || !cm) continue;
    const A = componentsOf(ca);
    const M = componentsOf(cm);
    const sh = A.shearDeg - M.shearDeg;
    rows.push({ dNear: A.nearB - M.nearB, wA: A.widthM, wM: M.widthM, dA: A.depthM, dM: M.depthM, sh, iou: bestIou });
    console.log(
      `  s${String(sp.idx).padStart(2)}   ${bestIou.toFixed(4)}   ${(A.nearB - M.nearB).toFixed(4).padStart(8)}   ` +
        `${A.widthM.toFixed(3)}/${M.widthM.toFixed(3)}   ${A.depthM.toFixed(3)}/${M.depthM.toFixed(3)}   ${sh.toFixed(2).padStart(6)}`,
    );
  }
  if (rows.length) {
    const avg = (f: (r: (typeof rows)[0]) => number): number => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    console.log(
      `  평균: Δ근변b=${avg((r) => r.dNear).toFixed(4)}m  폭 자동 ${avg((r) => r.wA).toFixed(3)} / 수동 ${avg((r) => r.wM).toFixed(3)}  ` +
        `깊이 자동 ${avg((r) => r.dA).toFixed(3)} / 수동 ${avg((r) => r.dM).toFixed(3)}  전단 ${avg((r) => r.sh).toFixed(2)}°`,
    );
    const dRel = (avg((r) => r.dA) - avg((r) => r.dM)) / avg((r) => r.dM);
    const wRel = (avg((r) => r.wA) - avg((r) => r.wM)) / avg((r) => r.wM);
    console.log(`  → 상대오차: 폭 ${(wRel * 100).toFixed(2)}%   **깊이 ${(dRel * 100).toFixed(2)}%**   근변이동 ${avg((r) => r.dNear).toFixed(3)}m\n`);
  }
}
