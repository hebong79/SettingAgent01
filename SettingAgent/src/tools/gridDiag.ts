// ★ 25회차 신규 — **행 후보 전수 + 칸 단위 거리량 덤프**(계측 전용).
//
// 신규 파일 사유(설계서 §2-2 「재발명 금지 확인 의무」에 대한 답):
//   `roiAutoRowsDiag.ts` 는 **시뮬 골든 전용**(PtzCamRoi.json 제원 + 씬 정답 라벨)이고 칸 단위 양을 내지 않는다.
//   `realFrameOverlay.ts` 는 **라이브 캡처 1장**(디스크 프레임 입력 없음). `emptyBayProbe.ts` 는 단계별 생존 추적이지
//   행 후보 전수 비교가 아니다. 이번 회차의 관측량(`tolM = paintTolPx × mPerPx` · `cellAreaRatio`)은 **칸 단위**이고
//   **시뮬·야간실카 두 소스를 같은 표에 올려야** 거리 편향을 가를 수 있다. 셋 중 어느 것도 그 축을 갖고 있지 않다.
//
// 무엇을 재는가
//   ① 행별  `medianDepthM` · `mPerPx@행중심` · **`tolM = paintTolPx × mPerPx`** · `paint.near/score` · `quads.length` · 칸 픽셀길이 median
//   ② 칸별  픽셀 면적 · **지상 면적(m²)** · **`cellAreaRatio`** · 깊이 · `tolM`
//   ③ `refScore` 값과 그것을 잡은 후보 rank · `rows` 문턱 실값과 통과/탈락
//
// ★ 카메라 물리 이동 0 — **디스크의 기존 프레임 파일만** 읽는다. 캡처 클라이언트를 import 하지 않고
//   이미지 요청 호출도 하지 않는다(테스트가 소스 문자열로 봉인한다).
// ★ 정본·DB 쓰기 0 — `data/` 는 읽기만, 쓰기는 `reports/` 하위만.
// ★ 오라클 금지 — 씬 정답(슬롯 식별자·가시성·자세) 필드를 하나도 읽지 않는다.
//   금지 토큰 목록은 `test/gridDiagWiring.test.ts` 가 정본으로 갖고 있고 이 파일에 부재함을 봉인한다.
//
// 사용: npx tsx src/tools/gridDiag.ts <sim|night> [ratioMin] [ratioMax] [outDir]
//   ratioMin/ratioMax 를 주면 그 값으로 `cellAreaRatioMin/Max` 를 **CLI 인자로만** 켠다(정본 미기록).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { DEFAULT_BAY_OPTS, type BayDetectOpts, type BayQuad } from '../ground/bayGeometry.js';
import { cellAreaRatioOf, fitRowGrid, quadGroundAreaM2, type GridResult, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, interpolateHfov } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { readGroundSpec } from '../rpc/services/roiAuto.js';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { buildSourceRegistry } from '../viewer/sourceRegistry.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { backprojectToGround } from '../ground/project.js';
import type { GroundModel } from '../ground/types.js';

const mode = (process.argv[2] ?? 'sim') as 'sim' | 'night';
if (mode !== 'sim' && mode !== 'night') throw new Error(`mode: sim | night (받은 값 ${mode})`);
const ratioMin = process.argv[3] != null && process.argv[3] !== '' && process.argv[3] !== '-' ? Number(process.argv[3]) : 0;
const ratioMax = process.argv[4] != null && process.argv[4] !== '' && process.argv[4] !== '-' ? Number(process.argv[4]) : Infinity;
const outDir = process.argv[5] ?? 'reports/overlay_r25a';
const flagOn = ratioMin > 0 || Number.isFinite(ratioMax);
mkdirSync(outDir, { recursive: true });

/** 픽셀 4점 다각형의 픽셀 면적(신발끈). */
function quadPixelArea(q: BayQuad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q.quad[i];
    const n = q.quad[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}
/** 픽셀 p 에서 1px 이 지상 몇 m 인가 — p 와 p+(1,0) 의 역투영 거리. 역투영 실패 → null. */
function mPerPxAt(p: { x: number; y: number }, model: GroundModel): number | null {
  const A = backprojectToGround(p, model);
  const B = backprojectToGround({ x: p.x + 1, y: p.y }, model);
  if (!A || !B) return null;
  const d = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
  return Number.isFinite(d) ? d : null;
}
function quadCenter(q: BayQuad): { x: number; y: number } {
  return {
    x: (q.quad[0].x + q.quad[1].x + q.quad[2].x + q.quad[3].x) / 4,
    y: (q.quad[0].y + q.quad[1].y + q.quad[2].y + q.quad[3].y) / 4,
  };
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

interface CellRec {
  latticeIndex: number;
  pxArea: number;
  screenFrac: number;
  groundAreaM2: number | null;
  cellAreaRatio: number | null;
  depthM: number | null;
  mPerPx: number | null;
  tolM: number | null;
}
interface RowRec {
  rank: number;
  quads: number;
  paintScore: number;
  paintNear: number;
  paintSide: number;
  paintFar: number;
  baseScore: number | null;
  effectiveScore: number | null;
  coverage: number | null;
  effCells: number | null;
  denomCells: number | null;
  medianDepthM: number | null;
  mPerPxRow: number | null;
  tolM: number | null;
  medianCellPx: number | null;
  extentEndedBy: unknown;
  calibration: unknown;
  isRef: boolean;
  passScore: boolean;
  passNear: boolean;
  cells: CellRec[];
}
interface FrameRec {
  tag: string;
  frameHash: string;
  imgW: number;
  imgH: number;
  expectedBays: number;
  coverageDenom: string;
  slotWidthM: number;
  slotDepthM: number;
  cameraHeightM: number | null;
  focalPx: number;
  paintTolPx: number;
  lines: number;
  refScore: number;
  refRank: number;
  rowThreshold: number;
  rows: RowRec[];
}

/** 한 프레임을 서비스 경로와 **같은 순서**로 돌려 후보 전수를 만든다(알고리즘 무변경). */
async function runFrame(tag: string, jpg: Buffer, model: GroundModel, opts: BayDetectOpts): Promise<{ rec: FrameRec; jpg: Buffer; local: Array<{ ci: number; r: GridResult }>; W: number; H: number; lineSegs: Array<[number, number, number]> }> {
  const meta = await sharp(jpg).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gb = await sharp(jpg).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
  const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);

  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, W, H);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sp of seps) {
      const q = meetLines(sp.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  const local: Array<{ ci: number; r: GridResult }> = [];
  for (let ci = 0; ci < cands.length; ci++) {
    const r = fitRowGrid(model, cands[ci].front, cands[ci].cornersPx, ev, DEFAULT_PAINT_OPTIONS, opts);
    if (r) local.push({ ci, r });
  }
  // refScore = baseScore argmax 후보의 paint.score (bayGrid.ts:687-695 와 같은 식·같은 순서).
  let ri = -1;
  let refBase = -Infinity;
  for (let i = 0; i < local.length; i++) {
    const b = local[i].r.baseScore ?? local[i].r.paint.score;
    if (b > refBase + 1e-12) {
      refBase = b;
      ri = i;
    }
  }
  const refScore = ri >= 0 ? local[ri].r.paint.score : 0;
  const threshold = refScore * opts.rowMinScoreRatio;

  const rows: RowRec[] = local.map((e, i) => {
    const cells: CellRec[] = e.r.quads.map((q) => {
      const c = quadCenter(q);
      const X = backprojectToGround(c, e.r.modelUsed);
      const mp = mPerPxAt(c, e.r.modelUsed);
      const ga = quadGroundAreaM2(q, e.r.modelUsed);
      return {
        latticeIndex: q.latticeIndex,
        pxArea: quadPixelArea(q),
        screenFrac: quadPixelArea(q) / (W * H),
        groundAreaM2: ga,
        cellAreaRatio: cellAreaRatioOf(q, e.r.modelUsed, opts),
        depthM: X ? Math.hypot(X[0], X[1], X[2]) : null,
        mPerPx: mp,
        tolM: mp == null ? null : DEFAULT_PAINT_OPTIONS.paintTolPx * mp,
      };
    });
    const mpRow = median(cells.map((c) => c.mPerPx).filter((v): v is number => v != null));
    const cellPx = median(e.r.quads.map((q) => Math.hypot(q.quad[3].x - q.quad[0].x, q.quad[3].y - q.quad[0].y)));
    return {
      rank: e.ci,
      quads: e.r.quads.length,
      paintScore: e.r.paint.score,
      paintNear: e.r.paint.near,
      paintSide: e.r.paint.side,
      paintFar: e.r.paint.far,
      baseScore: e.r.baseScore ?? null,
      effectiveScore: e.r.effectiveScore ?? null,
      coverage: e.r.coverage ?? null,
      effCells: e.r.effCells ?? null,
      denomCells: e.r.denomCells ?? null,
      medianDepthM: e.r.medianDepthM,
      mPerPxRow: mpRow,
      tolM: mpRow == null ? null : DEFAULT_PAINT_OPTIONS.paintTolPx * mpRow,
      medianCellPx: cellPx,
      extentEndedBy: e.r.extentEndedBy,
      calibration: e.r.calibration,
      isRef: i === ri,
      passScore: e.r.paint.score >= threshold,
      passNear: e.r.paint.near >= opts.rowMinNearSupport,
      cells,
    };
  });

  const rec: FrameRec = {
    tag,
    frameHash,
    imgW: W,
    imgH: H,
    expectedBays: opts.expectedBays,
    coverageDenom: opts.coverageDenom,
    slotWidthM: opts.slotWidthM,
    slotDepthM: opts.slotDepthM,
    cameraHeightM: opts.cameraHeightM,
    focalPx: model.f,
    paintTolPx: DEFAULT_PAINT_OPTIONS.paintTolPx,
    lines: lines.length,
    refScore,
    refRank: ri >= 0 ? local[ri].ci : -1,
    rowThreshold: threshold,
    rows,
  };
  return { rec, jpg, local, W, H, lineSegs: lines.map((l) => l.line) };
}

/** 오버레이 — 통과 행은 초록, 탈락 행은 회색, `cellAreaRatio` 이상치는 색을 바꿔 **눈에 보이게** 한다. */
async function renderOverlay(
  outPng: string,
  jpg: Buffer,
  rec: FrameRec,
  local: Array<{ ci: number; r: GridResult }>,
  W: number,
  H: number,
  label: string,
): Promise<void> {
  const parts: string[] = [];
  for (const row of rec.rows) {
    const e = local.find((l) => l.ci === row.rank);
    if (!e) continue;
    const passes = row.passScore && row.passNear;
    for (let qi = 0; qi < e.r.quads.length; qi++) {
      const q = e.r.quads[qi];
      const cr = row.cells[qi]?.cellAreaRatio ?? null;
      // 색 규약: 통과행 정상비율=초록 / 비율 과소(<0.5)=파랑 / 비율 과대(>2)=자홍 / 탈락행=회색
      const col = !passes ? '#9e9e9e' : cr == null ? '#00e5ff' : cr < 0.5 ? '#2979ff' : cr > 2 ? '#ff00e5' : '#00e676';
      const wdt = passes ? 3 : 1;
      parts.push(
        `<polygon points="${q.quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${col}1f" stroke="${col}" stroke-width="${wdt}"/>`,
      );
      if (passes && cr != null) {
        const c = quadCenter(q);
        parts.push(`<text x="${c.x.toFixed(0)}" y="${c.y.toFixed(0)}" fill="${col}" font-size="20" text-anchor="middle">${cr.toFixed(2)}</text>`);
      }
    }
    if (row.isRef) {
      // refScore 를 잡은 후보의 근변선을 **굵게**(H1 직접 판정용).
      const q0 = e.r.quads[0];
      const qN = e.r.quads[e.r.quads.length - 1];
      if (q0 && qN) parts.push(`<line x1="${q0.quad[0].x.toFixed(1)}" y1="${q0.quad[0].y.toFixed(1)}" x2="${qN.quad[3].x.toFixed(1)}" y2="${qN.quad[3].y.toFixed(1)}" stroke="#ffea00" stroke-width="6"/>`);
    }
  }
  const passRows = rec.rows.filter((r) => r.passScore && r.passNear);
  parts.push('<rect x="10" y="10" width="1500" height="200" fill="#000000cc" rx="8"/>');
  const T = (y: number, s: number, fill: string, t: string) => `<text x="26" y="${y}" fill="${fill}" font-size="${s}">${t}</text>`;
  parts.push(T(46, 24, '#fff', `${label}  frameHash=${rec.frameHash}  ${rec.imgW}×${rec.imgH}`));
  parts.push(T(78, 20, '#ddd', `후보 ${rec.rows.length} · 통과행 ${passRows.length} · refScore=${rec.refScore.toFixed(5)}(rank ${rec.refRank}) · 문턱=${rec.rowThreshold.toFixed(5)} · f=${rec.focalPx.toFixed(1)}px`));
  parts.push(T(108, 20, '#ddd', `slot ${rec.slotWidthM}×${rec.slotDepthM}m · h=${rec.cameraHeightM}m · expectedBays=${rec.expectedBays} · denom=${rec.coverageDenom} · paintTolPx=${rec.paintTolPx}`));
  parts.push(
    T(138, 20, '#ffab40', `통과행 depth/tolM: ` + (passRows.map((r) => `#${r.rank} ${r.medianDepthM?.toFixed(1) ?? '--'}m/tol ${r.tolM?.toFixed(3) ?? '--'}m/near ${r.paintNear.toFixed(3)}/q${r.quads}`).join('  ') || '없음')),
  );
  parts.push(T(168, 19, '#00e676', '■ 통과·비율 정상  <tspan fill="#2979ff">■ 비율 &lt;0.5(과소)</tspan>  <tspan fill="#ff00e5">■ 비율 &gt;2(과대)</tspan>  <tspan fill="#9e9e9e">■ 문턱 탈락</tspan>  <tspan fill="#ffea00">━ refScore 후보 근변</tspan>'));
  parts.push(T(196, 19, '#aaa', `플래그 ${flagOn ? `ON  cellAreaRatio ∈ [${ratioMin}, ${ratioMax}]` : 'OFF (무력 기본값 0 / Infinity)'}`));

  await sharp(jpg)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(outPng);
}

const all: FrameRec[] = [];
const tagPrefix = flagOn ? 'r25_on' : 'r25_base';

if (mode === 'sim') {
  const cacheDir = 'test/fixtures/roiAutoGolden';
  const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
  const { byPreset } = normalizePtzCamRoi(placeJson);
  const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));
  for (const c of placeJson.cameras) {
    for (const p of c.presets) {
      const key = `${c.camera.cam_id}:${p.preset_idx}`;
      const manual = (byPreset.get(key) ?? []).filter((s: { points?: unknown[] }) => Array.isArray(s.points) && s.points.length === 4);
      const baseIntr = intrinsics.get(c.camera.cam_id, p.preset_idx);
      if (!baseIntr) continue;
      const jpgPath = join(cacheDir, `frame_${c.camera.cam_id}_${p.preset_idx}_d0.jpg`);
      if (!existsSync(jpgPath)) continue;
      const jpg = readFileSync(jpgPath);
      const model = groundModelFromIntrinsics(baseIntr, p.zoom);
      if (!model) continue;
      const opts: BayDetectOpts = {
        ...DEFAULT_BAY_OPTS,
        expectedBays: Math.max(1, manual.length),
        cellAreaRatioMin: ratioMin,
        cellAreaRatioMax: ratioMax,
      };
      const out = await runFrame(key, jpg, model, opts);
      all.push(out.rec);
      await renderOverlay(join(outDir, `${tagPrefix}_sim${key.replace(':', '-')}_${out.rec.frameHash}.png`), jpg, out.rec, out.local, out.W, out.H, `시뮬 골든 ${key}`);
    }
  }
} else {
  const dir = 'test/fixtures/realCamDaylight';
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    frames: Array<{ file: string; capturedAtLocal: string; viewerPtz: { pan: number; tilt: number; zoom: number }; sha256_12: string }>;
  };
  const night = manifest.frames.filter((f) => f.file.startsWith('frame_20260729_20'));
  const cfg = loadToolsConfig();
  const src = buildSourceRegistry(cfg).get('real-camera-2');
  if (!src) throw new Error('소스 real-camera-2 부재');
  const ground = readGroundSpec(process.env.LENS_CALIB_FILE ?? 'data/lens_calibration.json', 'real-camera-2');
  for (const f of night) {
    const jpg = readFileSync(join(dir, f.file));
    const hash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
    if (hash !== f.sha256_12) throw new Error(`해시 불일치 ${f.file}: 기대 ${f.sha256_12} 실제 ${hash} — 파일이 바뀌었다`);
    const meta = await sharp(jpg).metadata();
    const native = src.toNativePtz(f.viewerPtz) as { tilt: number; zoom: number };
    const hfov = ground.zoomHfov ? interpolateHfov(ground.zoomHfov, native.zoom) : null;
    const heightM = ground.heightM;
    if (hfov == null || heightM == null) throw new Error(`제원 부족 hfov=${hfov} heightM=${heightM}`);
    const model = groundModelFromIntrinsics(
      { camIdx: 1, presetIdx: 1, fovDeg: hfov, fovAxis: 'horizontal', tiltDeg: native.tilt / 100, heightM, imgW: meta.width ?? 0, imgH: meta.height ?? 0, source: 'real:real-camera-2' },
      f.viewerPtz.zoom,
    );
    if (!model) throw new Error(`지면모델 실패 ${f.file}`);
    // 야간 실카는 **면수를 모른다** — 서비스가 그 경우 쓰는 위상불변 분모(roiAuto.ts:936)를 그대로 쓴다.
    const opts: BayDetectOpts = {
      ...DEFAULT_BAY_OPTS,
      cameraHeightM: heightM,
      expectedBays: 1,
      coverageDenom: 'phaseInvariant',
      cellAreaRatioMin: ratioMin,
      cellAreaRatioMax: ratioMax,
    };
    const out = await runFrame(f.file, jpg, model, opts);
    all.push(out.rec);
    await renderOverlay(
      join(outDir, `${tagPrefix}_night${f.file.slice(6, 21)}_${out.rec.frameHash}.png`),
      jpg,
      out.rec,
      out.local,
      out.W,
      out.H,
      `야간 실카(real-camera-2) ${f.capturedAtLocal} hfov=${hfov.toFixed(2)}° tilt=${(native.tilt / 100).toFixed(2)}° h=${heightM}m`,
    );
  }
}

const jsonPath = join(outDir, `gridDiag_${mode}_${flagOn ? 'on' : 'base'}.json`);
writeFileSync(jsonPath, `${JSON.stringify(all, null, 1)}\n`, 'utf8');

// ── 콘솔 표 ①: 행별 거리 편향
console.log(`\n=== 25회차 gridDiag mode=${mode} 플래그 ${flagOn ? `ON [${ratioMin}, ${ratioMax}]` : 'OFF(무력)'} · paintTolPx=${DEFAULT_PAINT_OPTIONS.paintTolPx} ===`);
console.log('frame(tag)                hash          rk  q   depthM     mPerPx      tolM     near     score  cellPx   ref  게이트');
const flat: Array<{ f: FrameRec; r: RowRec }> = [];
for (const f of all) for (const r of f.rows) flat.push({ f, r });
for (const { f, r } of flat) {
  console.log(
    `${f.tag.padEnd(24).slice(0, 24)}  ${f.frameHash}  ${String(r.rank).padStart(2)}  ${String(r.quads).padStart(2)}  ` +
      `${(r.medianDepthM?.toFixed(2) ?? '--').padStart(8)}  ${(r.mPerPxRow?.toFixed(5) ?? '--').padStart(9)}  ` +
      `${(r.tolM?.toFixed(4) ?? '--').padStart(8)}  ${r.paintNear.toFixed(4).padStart(7)}  ${r.paintScore.toFixed(4).padStart(7)}  ` +
      `${(r.medianCellPx?.toFixed(1) ?? '--').padStart(6)}  ${(r.isRef ? '§' : ' ').padStart(3)}  ${r.passScore && r.passNear ? '통과' : r.passScore ? 'near탈락' : r.passNear ? '비율탈락' : '둘다탈락'}`,
  );
}

// ── ②: paint.near vs medianDepthM 최소자승 회귀(원시 배정도. toFixed 는 출력에만).
function regress(pts: Array<{ x: number; y: number }>): { slope: number; intercept: number; n: number; r2: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
}
const depthNear = flat.filter((e) => e.r.medianDepthM != null).map((e) => ({ x: e.r.medianDepthM as number, y: e.r.paintNear }));
const tolNear = flat.filter((e) => e.r.tolM != null).map((e) => ({ x: e.r.tolM as number, y: e.r.paintNear }));
const qNear = flat.map((e) => ({ x: e.r.quads, y: e.r.paintNear }));
console.log('\n=== 회귀(원시 배정도) ===');
for (const [name, rg] of [['paint.near ~ medianDepthM', regress(depthNear)], ['paint.near ~ tolM', regress(tolNear)], ['paint.near ~ quads.length', regress(qNear)]] as const) {
  console.log(`  ${name}: ${rg ? `slope=${rg.slope} r2=${rg.r2} n=${rg.n}` : '표본 부족'}`);
}
// quads.length 통제 후 잔차 회귀 — near 에서 quads 성분을 뺀 잔차를 depth 에 회귀한다.
const rgQ = regress(qNear);
if (rgQ) {
  const resid = flat.filter((e) => e.r.medianDepthM != null).map((e) => ({ x: e.r.medianDepthM as number, y: e.r.paintNear - (rgQ.intercept + rgQ.slope * e.r.quads) }));
  const rr = regress(resid);
  console.log(`  [quads 통제] resid(near|quads) ~ medianDepthM: ${rr ? `slope=${rr.slope} r2=${rr.r2} n=${rr.n}` : '표본 부족'}`);
}

// ── ③: cellAreaRatio 분포(칸 전수 · 통과행/탈락행 구분)
const cellsPass: CellRec[] = [];
const cellsFail: CellRec[] = [];
for (const { r } of flat) (r.passScore && r.passNear ? cellsPass : cellsFail).push(...r.cells);
const stat = (xs: number[]) => {
  if (!xs.length) return 'n=0';
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} min=${s[0]} p10=${q(0.1)} med=${q(0.5)} p90=${q(0.9)} max=${s[s.length - 1]}`;
};
console.log('\n=== cellAreaRatio 분포(원시 배정도) ===');
console.log(`  통과행 칸: ${stat(cellsPass.map((c) => c.cellAreaRatio).filter((v): v is number => v != null))}`);
console.log(`  탈락행 칸: ${stat(cellsFail.map((c) => c.cellAreaRatio).filter((v): v is number => v != null))}`);
console.log(`  통과행 픽셀면적: ${stat(cellsPass.map((c) => c.pxArea))}`);
console.log(`  통과행 화면점유율: ${stat(cellsPass.map((c) => c.screenFrac))}`);
console.log(`\n덤프: ${jsonPath}  · 오버레이: ${outDir}`);
