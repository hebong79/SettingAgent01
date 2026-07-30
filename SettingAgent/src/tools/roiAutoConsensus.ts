// ★ 12회차 P0 — **다시점 합의**(캡처 단계 견고화). 프리셋 정의·정본 무접촉.
//
// 근거(9회차 실측): `2:2` 는 기저 PTZ 에서 0.0000 인데 pan −1.5° 에서 0.9440, tilt −0.8° 에서 0.9521 이다.
// 검출·기하가 실패한 게 아니라 **행 선별이 임계에 걸린 불운한 배치**다. 같은 행을 몇 도 다르게 보고
// **다수결**하면 임계를 벗어난다.
//
// 결정론: 디더 집합·순회 순서 고정, 동점 시 **기저 시점 우선 → 낮은 인덱스**.
// 사용: npx tsx src/tools/roiAutoConsensus.ts <jitDir>

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
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { backprojectToGround, projectToPixel } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { quadIoU } from '../ground/autoRoiPlan.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import type { Px, Vec3 } from '../ground/contactTypes.js';

const dir = process.argv[2];
if (!dir) {
  console.error('사용: npx tsx src/tools/roiAutoConsensus.ts <jitDir>');
  process.exit(2);
}
/** 고정 순회 순서 — 기저(0,0)가 항상 첫째다(동점 시 우선권). */
const ORDER = ['p0_p0', 'm15_p0', 'p15_p0', 'p0_m8', 'p0_p8', 'p10_p6'];
const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

/** 변주 시점 카메라좌표 → 기저 시점 카메라좌표(9회차 정변환의 역). */
function toBaseFrame(X: Vec3, n0: Vec3, dPanDeg: number, dTiltDeg: number): Vec3 {
  // 정변환: X1 = R_n0(-dpan)·X ; X2 = R_x(dtilt)·X1.  역: X1 = R_x(-dtilt)·X2 ; X = R_n0(+dpan)·X1
  const dt = -(dTiltDeg * Math.PI) / 180;
  const ct = Math.cos(dt);
  const st = Math.sin(dt);
  const X1: Vec3 = [X[0], X[1] * ct - X[2] * st, X[1] * st + X[2] * ct];
  const dp = (dPanDeg * Math.PI) / 180;
  const cp = Math.cos(dp);
  const sp = Math.sin(dp);
  const dot = n0[0] * X1[0] + n0[1] * X1[1] + n0[2] * X1[2];
  const cr: Vec3 = [n0[1] * X1[2] - n0[2] * X1[1], n0[2] * X1[0] - n0[0] * X1[2], n0[0] * X1[1] - n0[1] * X1[0]];
  return [
    X1[0] * cp + cr[0] * sp + n0[0] * dot * (1 - cp),
    X1[1] * cp + cr[1] * sp + n0[1] * dot * (1 - cp),
    X1[2] * cp + cr[2] * sp + n0[2] * dot * (1 - cp),
  ];
}

interface ViewResult { tag: string; quadsBase: PixelQuad[]; rowKey: Vec3 | null }

const files = readdirSync(dir).filter((x) => x.startsWith('jit_') && x.endsWith('.json'));
const presets = [...new Set(files.map((f) => /^jit_(\d+)_(\d+)_/.exec(f)!).map((m) => `${m[1]}:${m[2]}`))].sort();

console.log('다시점 합의 — 디더 6시점, 행 선택 다수결(기저 우선). 정본·프리셋 무접촉\n');
let sumSingle = 0;
let sumCons = 0;
let nP = 0;
for (const key of presets) {
  const [camS, preS] = key.split(':');
  const manual = (byPreset.get(key) ?? []).filter((s) => s.points.length === 4);
  if (manual.length < 1) continue;
  const baseIntr = intrinsics.get(Number(camS), Number(preS));
  if (!baseIntr) continue;

  const views: ViewResult[] = [];
  let mBase: GroundModel | null = null;
  let W = 0;
  let H = 0;
  for (const tag of ORDER) {
    const f = `jit_${camS}_${preS}_${tag}.json`;
    if (!files.includes(f)) continue;
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as any;
    W = j.result.width;
    H = j.result.height;
    const m0 = groundModelFromIntrinsics(baseIntr, j.base.zoom);
    const intr: PresetIntrinsics = { ...baseIntr, tiltDeg: j.actual.tilt };
    const mv = groundModelFromIntrinsics(intr, j.actual.zoom);
    if (!m0 || !mv) continue;
    mBase = m0;
    const gb = await sharp(Buffer.from(j.result.img_bytes, 'base64')).greyscale().raw().toBuffer();
    const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
    const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
    const ev = paintEvidenceOf(mask, W, H);
    const cands: RowCandidate[] = [];
    for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
      const pk = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
      const seps = pk.length ? refineSeparators(frame, pk, DEFAULT_PAINT_OPTIONS) : [];
      const pts: Array<{ x: number; y: number }> = [];
      for (const sp of seps) {
        const q = meetLines(sp.line, front.line);
        if (q) pts.push(q);
      }
      cands.push({ front, cornersPx: pts });
    }
    const g = detectBaysWithModel(cands, mv, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: manual.length }, frame);
    const best = g.best;
    if (!best || best.quads.length === 0) {
      views.push({ tag, quadsBase: [], rowKey: null });
      continue;
    }
    const n0 = m0.n as unknown as Vec3;
    // 이 시점의 quad 를 **기저 시점 픽셀**로 되돌린다(비교·채점을 한 좌표계에서).
    const qb: PixelQuad[] = [];
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let cn = 0;
    for (const q of best.quads) {
      const px: Array<{ x: number; y: number }> = [];
      let ok = true;
      for (const p of q.quad) {
        const X = backprojectToGround(p as Px, best.modelUsed);
        if (!X) { ok = false; break; }
        const Xb = toBaseFrame(X as unknown as Vec3, n0, j.jitter.dpan, j.jitter.dtilt);
        cx += Xb[0]; cy += Xb[1]; cz += Xb[2]; cn++;
        const u = projectToPixel(Xb, m0);
        if (!u) { ok = false; break; }
        px.push(u);
      }
      if (!ok || px.length !== 4) continue;
      const cq = canonicalizeQuad(px as PixelQuad);
      if (cq) qb.push(cq);
    }
    views.push({ tag, quadsBase: qb, rowKey: cn > 0 ? [cx / cn, cy / cn, cz / cn] : null });
  }
  if (!mBase || views.length === 0) continue;

  // 다수결: 행 중심(기저 지면좌표)이 2.0m 이내면 같은 행으로 본다.
  const clusters: Array<{ members: number[]; c: Vec3 }> = [];
  views.forEach((v, i) => {
    if (!v.rowKey) return;
    const hit = clusters.find((cl) => Math.hypot(cl.c[0] - v.rowKey![0], cl.c[1] - v.rowKey![1], cl.c[2] - v.rowKey![2]) < 2.0);
    if (hit) hit.members.push(i);
    else clusters.push({ members: [i], c: v.rowKey });
  });
  // 최다 득표 → 동점 시 가장 이른 시점(기저 우선)을 포함한 군집
  clusters.sort((a, b) => b.members.length - a.members.length || Math.min(...a.members) - Math.min(...b.members));
  const win = clusters[0];
  // 대표 = 승리 군집 중 가장 이른 시점
  const rep = win ? views[Math.min(...win.members)] : null;

  const truth = manual.map((s) => canonicalizeQuad(s.points.map((p) => ({ x: p.x * W, y: p.y * H })) as PixelQuad)).filter(Boolean) as PixelQuad[];
  const scoreOf = (qs: PixelQuad[]): number =>
    truth.reduce((s, t) => s + Math.max(0, ...qs.map((q) => quadIoU(q, t))), 0) / truth.length;
  const single = scoreOf(views[0]?.quadsBase ?? []);
  const cons = scoreOf(rep?.quadsBase ?? []);
  sumSingle += single;
  sumCons += cons;
  nP++;
  const votes = clusters.map((c) => `${c.members.length}`).join('/');
  console.log(
    `${key}  단일(기저) ${single.toFixed(5)}  →  합의 ${cons.toFixed(5)}   대표=${rep?.tag ?? '-'}  득표분포 ${votes}  ` +
      `${cons > single + 1e-6 ? '★개선' : cons < single - 1e-6 ? '!!후퇴' : '동일'}`,
  );
}
console.log(`\n평균  단일 ${(sumSingle / nP).toFixed(5)}  →  합의 ${(sumCons / nP).toFixed(5)}  (${nP}프리셋)`);
