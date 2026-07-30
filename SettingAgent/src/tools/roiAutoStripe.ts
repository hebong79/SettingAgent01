// ★ 11회차 — **도색 스트라이프 규약 실측**(진단 전용). 10면 정체의 마지막 물리적 후보.
//
// 질문: 수동 주석의 근변이 검출된 도색 스트라이프의 **어디**에 놓여 있는가?
//       중심선 / 안쪽(주차면 쪽) 모서리 / 바깥(차도 쪽) 모서리?
//
// 방법: 채택된 자동 근변선의 **법선 방향 밝기 횡단면**을 뜬다. 스트라이프의 양 모서리·중심·폭을 px 로 재고,
//       같은 법선축 위에서 수동 근변이 어디에 떨어지는지 면별로 낸다.
//       비율 r = (수동 − 중심) / (폭/2) 이면  r=0 중심 · r=+1 안쪽모서리 · r=−1 바깥모서리.
//
// 수동은 **자(尺)로만** 쓴다(파이프라인 입력 아님 — R1).
// 사용: npx tsx src/tools/roiAutoStripe.ts <frameDir> [placeRoiFile]

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
  stripeCenter,
  type FrameGray,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { backprojectToGround } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { PixelQuad } from '../ground/types.js';
import type { Px } from '../ground/contactTypes.js';

const dir = process.argv[2];
const placeFile = process.argv[3] ?? 'data/Place01/PtzCamRoi.json';
if (!dir) {
  console.error('사용: npx tsx src/tools/roiAutoStripe.ts <frameDir> [placeRoiFile]');
  process.exit(2);
}
const placeJson = JSON.parse(readFileSync(placeFile, 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));
const ONLY = (process.env.KEYS ?? '1:1,2:1').split(',');

for (const f of readdirSync(dir).filter((x) => /^frame_\d+_\d+\.json$/.test(x)).sort()) {
  const m = /^frame_(\d+)_(\d+)\.json$/.exec(f)!;
  const camId = Number(m[1]);
  const presetIdx = Number(m[2]);
  const key = `${camId}:${presetIdx}`;
  if (!ONLY.includes(key)) continue;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
    result: { img_bytes: string; width: number; height: number };
    preset?: { zoom?: number };
  };
  const W = j.result.width;
  const H = j.result.height;
  const gray = await sharp(Buffer.from(j.result.img_bytes, 'base64')).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gray.buffer, gray.byteOffset, gray.byteLength), width: W, height: H };
  const manual = byPreset.get(key) ?? [];
  const bays = manual.filter((s) => s.points.length === 4).length;
  const intr = intrinsics.get(camId, presetIdx);
  const model0 = intr ? groundModelFromIntrinsics(intr, j.preset?.zoom ?? 1) : null;
  if (!model0) continue;

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
  if (!best) continue;
  const L = best.frontLine;
  const model = best.modelUsed;

  const at = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const g = frame.data;
    const a = g[y0 * W + x0];
    const b = g[y0 * W + x1];
    const c = g[y1 * W + x0];
    const d = g[y1 * W + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  console.log(`\n=== ${key} (자동 quad ${best.quads.length}, 지상고 ${model.d.toFixed(3)}m) ===`);
  console.log('  비율 r = (수동근변 − 스트라이프중심)/(폭/2)   r=0 중심 · r=+1 안쪽모서리 · r=−1 바깥모서리');
  console.log('  면    폭(px)  중심t   수동t    Δ중심(px)  **r**     Δ중심(m)');
  const rs: number[] = [];
  const dm: number[] = [];
  const pipeT: number[] = [];
  const propT: number[] = [];
  const selfT: number[] = [];
  const manT: number[] = [];
  for (const sp of manual) {
    if (sp.points.length !== 4) continue;
    const q = canonicalizeQuad(sp.points.map((p) => ({ x: p.x * W, y: p.y * H })) as PixelQuad);
    if (!q) continue;
    // 근변 중점과 원변 중점 — 법선의 '안쪽'(주차면 쪽) 부호를 정한다.
    const nearMid = { x: (q[0].x + q[3].x) / 2, y: (q[0].y + q[3].y) / 2 };
    const farMid = { x: (q[1].x + q[2].x) / 2, y: (q[1].y + q[2].y) / 2 };
    const sNear = L[0] * nearMid.x + L[1] * nearMid.y + L[2];
    const sFar = L[0] * farMid.x + L[1] * farMid.y + L[2];
    const inward = Math.sign(sFar - sNear) || 1; // 법선 t 증가 방향이 주차면 안쪽인가
    // 근변 중점을 자동 근변선 위로 내린 발 — 거기서 법선 프로파일을 뜬다.
    const footX = nearMid.x - L[0] * sNear;
    const footY = nearMid.y - L[1] * sNear;
    const prof: Array<{ t: number; v: number }> = [];
    for (let u = -22; u <= 22; u += 0.25) {
      const v = at(footX + L[0] * u, footY + L[1] * u);
      if (v !== null) prof.push({ t: u, v });
    }
    if (prof.length < 20) continue;
    // 스트라이프 = 국소 밝기 최대 주변. 배경은 하위 25% 중앙값, 임계는 배경+진폭의 절반.
    const vs = prof.map((p) => p.v).sort((a, b) => a - b);
    const bg = vs[Math.floor(vs.length * 0.25)];
    const peak = vs[vs.length - 1];
    const thr = bg + (peak - bg) * 0.5;
    const above = prof.filter((p) => p.v >= thr);
    if (above.length < 2) continue;
    const tIn = Math.min(...above.map((p) => p.t));
    const tOut = Math.max(...above.map((p) => p.t));
    const width = tOut - tIn;
    // 밝기 가중 중심(반폭 임계 구간 내)
    let sw = 0;
    let st = 0;
    for (const p of above) {
      const w = p.v - bg;
      sw += w;
      st += w * p.t;
    }
    const tC = sw > 0 ? st / sw : (tIn + tOut) / 2;
    const tM = sNear; // 수동 근변의 법선 좌표(자동선 기준)
    const dCentre = tM - tC;
    const r = width > 0 ? (dCentre * inward) / (width / 2) : 0;
    // px → m (근변 지점 국소 스케일)
    const X1 = backprojectToGround({ x: footX, y: footY } as Px, model);
    const X2 = backprojectToGround({ x: footX + L[0], y: footY + L[1] } as Px, model);
    const mPerPx = X1 && X2 ? Math.hypot(X2[0] - X1[0], X2[1] - X1[1], X2[2] - X1[2]) : NaN;
    // ★ 12회차 P1 — **파이프라인 추정기 통일 재확인**.
    //   위 tC 는 이 도구의 자체 추정기(고정 ±22px 창 + 밝기가중)다. 재적합이 실제로 쓰는
    //   `stripeCenter`(반폭 profileHalfPx, 잘린 프로파일 폐기)로 **같은 지점**을 다시 재서
    //   드리프트가 재현되는지 본다. 재현 안 되면 11회차 §2 는 내 도구의 인공물이다.
    const profPipe: Array<{ t: number; v: number | null }> = [];
    for (let u = -DEFAULT_PAINT_OPTIONS.profileHalfPx; u <= DEFAULT_PAINT_OPTIONS.profileHalfPx; u += DEFAULT_PAINT_OPTIONS.profileStepPx) {
      profPipe.push({ t: u, v: at(footX + L[0] * u, footY + L[1] * u) });
    }
    const scPipe = stripeCenter(profPipe, DEFAULT_PAINT_OPTIONS);
    // 창을 스트라이프 폭에 비례시킨 재측정(리더 지시: 폭×2) — 고정창 인공물 판별용
    const halfProp = Math.max(6, width);
    const profProp: Array<{ t: number; v: number }> = [];
    for (let u = -halfProp; u <= halfProp; u += 0.25) {
      const v = at(footX + L[0] * u, footY + L[1] * u);
      if (v !== null) profProp.push({ t: u, v });
    }
    let tCprop = tC;
    if (profProp.length > 8) {
      const vv = profProp.map((q) => q.v).sort((a, b) => a - b);
      const bg2 = vv[Math.floor(vv.length * 0.25)];
      const th2 = bg2 + (vv[vv.length - 1] - bg2) * 0.5;
      const ab2 = profProp.filter((q) => q.v >= th2);
      let sw2 = 0;
      let st2 = 0;
      for (const q of ab2) { const w2 = q.v - bg2; sw2 += w2; st2 += w2 * q.t; }
      if (sw2 > 0) tCprop = st2 / sw2;
    }
    pipeT.push(scPipe ? scPipe.t : NaN);
    propT.push(tCprop);
    rs.push(r);
    dm.push(dCentre * inward * mPerPx);
    selfT.push(tC);
    manT.push(tM);
    console.log(
      `  s${String(sp.idx).padStart(2)}  ${width.toFixed(2).padStart(6)}  ${tC.toFixed(2).padStart(6)}  ${tM.toFixed(2).padStart(6)}  ` +
        `${(dCentre * inward).toFixed(3).padStart(8)}   ${r.toFixed(3).padStart(7)}   ${(dCentre * inward * mPerPx).toFixed(4).padStart(8)}`,
    );
  }
  if (rs.length) {
    const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    const sd = (a: number[]): number => Math.sqrt(avg(a.map((x) => (x - avg(a)) ** 2)));
    console.log(`  평균 r = ${avg(rs).toFixed(3)} (표준편차 ${sd(rs).toFixed(3)})   평균 Δ중심 = ${avg(dm).toFixed(4)}m`);
    console.log(`  → r 이 0 부근이면 규약 동일(원인 아님) · +1 이면 수동=안쪽모서리 · −1 이면 수동=바깥모서리`);
    const drift = (a: number[]): string => {
      const f = a.filter((x) => Number.isFinite(x));
      return f.length >= 2 ? `${f[0].toFixed(2)} → ${f[f.length - 1].toFixed(2)} (드리프트 ${(f[f.length - 1] - f[0]).toFixed(2)}px, n=${f.length})` : '측정불가';
    };
    console.log('  ── 추정기 통일 재확인 ──');
    console.log(`   자체(고정±22px)    tC: ${drift(selfT)}`);
    console.log(`   파이프라인 stripeCenter: ${drift(pipeT)}`);
    console.log(`   비례창(폭×2)        : ${drift(propT)}`);
    console.log(`   수동 tM             : ${drift(manT)}`);
  }
}
