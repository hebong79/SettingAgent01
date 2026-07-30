// LOPO(leave-one-preset-out) 검증 — `aimCenterWeight` 등급 확정용. 진단 전용, 정본·DB 무접촉.
//
// ★ 정답 유도: 변주 프레임에는 수동 주석이 없다. 그러나 카메라는 **움직이지 않고 각도만** 바뀌었고
//   지면모델은 제원에서 나오므로, 원 프리셋의 수동 quad 를 지면으로 역투영한 뒤 변주 시점으로 재투영하면
//   그 시점의 정답이 된다. zoom 고정이라 fov 는 불변이고 tilt 만 바뀐다.
//   (수동은 **채점 전용**으로만 쓴다 — R1 유지.)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, meetLines, paintEvidenceOf, refineSeparators, scanSeparators, type FrameGray } from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { backprojectToGround, projectToPixel } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { quadIoU } from '../ground/autoRoiPlan.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { PixelQuad } from '../ground/types.js';
import type { Px, Vec3 } from '../ground/contactTypes.js';

const dir = process.argv[2];
if (!dir) { console.error('사용: npx tsx src/tools/roiAutoLopo.ts <jitDir>'); process.exit(2); }
const WEIGHTS = (process.env.WEIGHTS ?? '0,1.0,1.6,2.2,3.0').split(',').map(Number);
const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

interface Obs { key: string; presetKey: string; W: number; H: number; frame: FrameGray; truth: PixelQuad[]; intr: PresetIntrinsics; zoom: number }
const obs: Obs[] = [];
for (const f of readdirSync(dir).filter((x) => x.startsWith('jit_') && x.endsWith('.json')).sort()) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as any;
  const W = j.result.width, H = j.result.height;
  const presetKey = `${j.base.cam}:${j.base.preset}`;
  const base = intrinsics.get(j.base.cam, j.base.preset);
  if (!base) continue;
  const m0 = groundModelFromIntrinsics(base, j.base.zoom);
  const intr: PresetIntrinsics = { ...base, tiltDeg: j.actual.tilt };
  const m1 = groundModelFromIntrinsics(intr, j.actual.zoom);
  if (!m0 || !m1) continue;
  // 원 시점 수동 quad → 지면 → 변주 시점 재투영 = 그 시점의 정답
  const truth: PixelQuad[] = [];
  for (const sp of byPreset.get(presetKey) ?? []) {
    if (sp.points.length !== 4) continue;
    const px: Array<{ x: number; y: number }> = [];
    let ok = true;
    for (const p of sp.points) {
      const X = backprojectToGround({ x: p.x * W, y: p.y * H } as Px, m0);
      if (!X) { ok = false; break; }
      // ★ 카메라는 **위치가 고정**이고 각도만 바뀐다. 기준 시점 카메라좌표 X 를 변주 시점 좌표로 옮긴다.
      //   ① pan 은 **월드 수직축**(= 기준 시점의 지면 법선 n0) 둘레 회전이다. 카메라 y축이 아니다 —
      //      틸트된 카메라에서 y축과 월드 수직은 다르다. 로드리게스로 n0 둘레 −dpan 회전.
      //   ② tilt 는 카메라 x축 둘레 회전. n(t)=[0,cos t,sin t] 이고 R_x(a)·n(t)=n(t+a) 이므로
      //      X' = R_x(dtilt)·X 여야 n1·X' = d 가 유지된다.
      //   (구현자 실측: ② 를 빠뜨렸을 때 tilt 변주 관측의 정답이 어긋나 IoU 가 0.25 로 떨어졌다.
      //    pan 변주만 0.92 로 정상이었던 것이 단서였다.)
      const dp = -((j.actual.pan - j.base.pan) * Math.PI) / 180;
      const n0 = m0.n as unknown as Vec3;
      const cp = Math.cos(dp), sp2 = Math.sin(dp);
      const dot = n0[0] * X[0] + n0[1] * X[1] + n0[2] * X[2];
      const cr: Vec3 = [n0[1] * X[2] - n0[2] * X[1], n0[2] * X[0] - n0[0] * X[2], n0[0] * X[1] - n0[1] * X[0]];
      const X1: Vec3 = [
        X[0] * cp + cr[0] * sp2 + n0[0] * dot * (1 - cp),
        X[1] * cp + cr[1] * sp2 + n0[1] * dot * (1 - cp),
        X[2] * cp + cr[2] * sp2 + n0[2] * dot * (1 - cp),
      ];
      const dt = ((j.actual.tilt - j.base.tilt) * Math.PI) / 180;
      const ct = Math.cos(dt), st = Math.sin(dt);
      const X2: Vec3 = [X1[0], X1[1] * ct - X1[2] * st, X1[1] * st + X1[2] * ct];
      const q = projectToPixel(X2, m1);
      if (!q) { ok = false; break; }
      px.push(q);
    }
    if (!ok || px.length !== 4) continue;
    const cq = canonicalizeQuad(px as PixelQuad);
    if (cq) truth.push(cq);
  }
  if (truth.length < 3) continue;
  const gb = await sharp(Buffer.from(j.result.img_bytes, 'base64')).greyscale().raw().toBuffer();
  obs.push({ key: f.replace(/^jit_|\.json$/g, ''), presetKey, W, H,
    frame: { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H }, truth, intr, zoom: j.actual.zoom });
}
console.log(`관측 ${obs.length}개 (정답 유도 성공분) · 가중치 후보 ${WEIGHTS.join(',')}\n`);

/** 관측 1건을 주어진 aimW 로 채점 → 평균 IoU. */
function score(o: Obs, aimW: number): number {
  const model = groundModelFromIntrinsics(o.intr, o.zoom);
  if (!model) return 0;
  const { lines, mask } = detectPaintLines(o.frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, o.W, o.H);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const pk = scanSeparators(o.frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = pk.length ? refineSeparators(o.frame, pk, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sp of seps) { const q = meetLines(sp.line, front.line); if (q) pts.push(q); }
    cands.push({ front, cornersPx: pts });
  }
  const g = detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS,
    { ...DEFAULT_BAY_OPTS, expectedBays: o.truth.length, aimCenterWeight: aimW }, o.frame);
  const quads = g.best?.quads ?? [];
  const ious = o.truth.map((t) => Math.max(0, ...quads.map((q) => quadIoU(q.quad, t))));
  return ious.reduce((a, b) => a + b, 0) / ious.length;
}

// 전 관측 × 전 가중치 채점
const table = new Map<string, number[]>();
for (const o of obs) {
  const row = WEIGHTS.map((w) => score(o, w));
  table.set(o.key, row);
  console.log(`  ${o.key.padEnd(16)} 정답 ${o.truth.length}면  ${row.map((v) => v.toFixed(4)).join('  ')}`);
}
const presets = [...new Set(obs.map((o) => o.presetKey))].sort();
console.log(`\n=== LOPO (${presets.length} 폴드) ===`);
console.log('제외 프리셋   선택 aimW   훈련평균    held-out평균   aimW=0 기준   판정');
let fail = 0;
for (const held of presets) {
  const tr = obs.filter((o) => o.presetKey !== held);
  const te = obs.filter((o) => o.presetKey === held);
  let best = { w: WEIGHTS[0], m: -1, i: 0 };
  WEIGHTS.forEach((w, i) => {
    const m = tr.reduce((s, o) => s + (table.get(o.key)![i]), 0) / tr.length;
    if (m > best.m + 1e-9) best = { w, m, i };
  });
  const got = te.reduce((s, o) => s + table.get(o.key)![best.i], 0) / te.length;
  const base = te.reduce((s, o) => s + table.get(o.key)![0], 0) / te.length;
  const ok = got >= base - 0.01;
  if (!ok) fail++;
  console.log(`  ${held.padEnd(10)}  ${String(best.w).padEnd(9)} ${best.m.toFixed(5)}   ${got.toFixed(5)}      ${base.toFixed(5)}      ${ok ? 'OK' : 'FAIL'}`);
}
console.log(`\n폴드 실패 ${fail}/${presets.length}`);
const overall = WEIGHTS.map((w, i) => [w, obs.reduce((s, o) => s + table.get(o.key)![i], 0) / obs.length] as [number, number]);
console.log('전 관측 평균: ' + overall.map(([w, m]) => `aimW=${w}:${m.toFixed(5)}`).join('  '));
