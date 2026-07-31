// ★ 26회차 병행항목 26-2 — **OSD 자막 마스킹 전/후 대조**(가설 검증 계측 전용).
//
// 검증할 가설(리더 25회차 육안): 「OSD 자막의 수평 획이 도색선으로 검출되어 가짜 면을 만든다」
// 측정: 같은 프레임·같은 설정에서 **자막 영역만** 다르게 하고 `detectPaintLines` 직선 수 · 통과행 수를 대조한다.
//
// 신규 파일 사유(재발명 금지 확인):
//   `gridDiag.ts` 는 한 프레임을 **한 번만** 돌린다(암 개념 없음). `emptyBayProbe.ts`/`evPresetDetect.ts` 는
//   단계별 생존 추적이고 픽셀 개입이 없다. 이번 관측량은 **같은 프레임의 두 픽셀 버전 차분**이라
//   기존 도구 중 어느 것도 그 축을 갖고 있지 않다. 행 파이프라인 부분은 `gridDiag.ts:runFrame` 과 같은 순서.
//
// ★ 자막 영역은 **오라클이 아니다** — 정답지·수동 ROI·씬 정답을 한 글자도 읽지 않고
//   **이미지에서** 찾는다(§findOsdBox). 근거는 「고휘도 · 획 밝기 균일 · 글리프 크기 · 공통 베이스라인 4자 이상」.
// ★ 마스킹은 **경계를 만들지 않는다** — Coons(전유한) 보간으로 박스 내부를 테두리 값과 C0 연속하게 채운다.
//   그래도 새 직선이 테두리를 타는지 `edgeDistPx` 로 직접 확인한다.
// ★ **위치 특이성 통제군(sham)** — 같은 크기 박스를 자막이 **없는** 위치(수평 미러)에 같은 방식으로 채워
//   「박스를 지우면 무엇이든 변한다」가 아님을 가른다.
// ★ 카메라 물리 이동 0 — 디스크 JPEG 만 읽는다(캡처 클라이언트 미import, 테스트가 소스로 봉인).
// ★ 정본·DB 쓰기 0 — 쓰기는 `reports/` 하위만.
//
// 사용: npx tsx src/tools/osdMaskDiag.ts <night|sim|ev> [outDir] [simShamRel]
//   night = 야간 실카 6장(자막 있음) · sim = 시뮬 골든 5장(자막 없음, 대조군)
//   ev    = 실카 낮 프리셋 4장 — 리더 육안근거 ②(EV4 `64/15/x55`)·③(EV5 `38/11/x55`) 직접 검증(설계 범위 밖 추가 측정)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  meetLines,
  paintEvidenceOf,
  paintMask,
  refineSeparators,
  scanSeparators,
  type FrameGray,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, type BayDetectOpts, type BayQuad } from '../ground/bayGeometry.js';
import { fitRowGrid, type GridResult, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, interpolateHfov } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { readGroundSpec } from '../rpc/services/roiAuto.js';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { buildSourceRegistry } from '../viewer/sourceRegistry.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { GroundModel } from '../ground/types.js';
import {
  coonsFill,
  edgeDistPx,
  findOsdBox,
  lineCrossesBox,
  mirrorBox,
  quadOverlapsBox,
  type Box,
  type LineRec,
} from './osdMaskLib.js';

const mode = (process.argv[2] ?? 'night') as 'night' | 'sim' | 'ev';
if (mode !== 'night' && mode !== 'sim' && mode !== 'ev') throw new Error(`mode: night | sim | ev (받은 값 ${mode})`);
const outDir = process.argv[3] ?? 'reports/overlay_r26b';
mkdirSync(outDir, { recursive: true });

interface ArmRec {
  arm: string;
  lines: number;
  rows: number;
  passRows: number;
  refScore: number;
  rowThreshold: number;
  lineList: LineRec[];
  passRowIds: number[];
  /** ★ 통과행 중 **quad 가 OSD 박스와 겹치는** 행 수 — 가설이 직접 예측하는 양. 박스 미검출이면 null. */
  passRowsOnBox: number | null;
  /** 통과행이 만든 quad 총수. */
  passQuads: number;
}

function thetaRhoOf(l: [number, number, number]): { thetaDeg: number; rho: number } {
  return { thetaDeg: (Math.atan2(l[1], l[0]) * 180) / Math.PI, rho: -l[2] };
}

/** `gridDiag.ts:runFrame` 과 같은 순서 — 알고리즘 무변경. */
function runArm(arm: string, gray: Uint8Array, W: number, H: number, model: GroundModel, opts: BayDetectOpts, refBox: Box | null): { rec: ArmRec; local: Array<{ ci: number; r: GridResult }>; pass: boolean[] } {
  const frame: FrameGray = { data: gray, width: W, height: H };
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
  const pass = local.map((e) => e.r.paint.score >= threshold && e.r.paint.near >= opts.rowMinNearSupport);
  return {
    rec: {
      arm,
      lines: lines.length,
      rows: local.length,
      passRows: pass.filter(Boolean).length,
      refScore,
      rowThreshold: threshold,
      lineList: lines.map((l) => ({ ...thetaRhoOf(l.line), votes: l.votes, line: l.line })),
      passRowIds: local.filter((_, i) => pass[i]).map((e) => e.ci),
      passRowsOnBox: refBox ? local.filter((e, i) => pass[i] && (e.r.quads as BayQuad[]).some((q) => quadOverlapsBox(q, refBox))).length : null,
      passQuads: local.reduce((s, e, i) => s + (pass[i] ? e.r.quads.length : 0), 0),
    },
    local,
    pass,
  };
}

/** 직선 대응 — |Δθ| ≤ 1.0° 이고 |Δρ| ≤ 8px 이면 같은 직선으로 본다. */
function matchLines(a: LineRec[], b: LineRec[]): { newOnes: LineRec[]; lost: LineRec[]; kept: number } {
  const takenB = new Uint8Array(b.length);
  const lost: LineRec[] = [];
  let kept = 0;
  for (const la of a) {
    let hit = -1;
    for (let j = 0; j < b.length; j++) {
      if (takenB[j]) continue;
      if (Math.abs(la.thetaDeg - b[j].thetaDeg) <= 1.0 && Math.abs(la.rho - b[j].rho) <= 8) {
        hit = j;
        break;
      }
    }
    if (hit >= 0) {
      takenB[hit] = 1;
      kept++;
    } else lost.push(la);
  }
  return { newOnes: b.filter((_, j) => !takenB[j]), lost, kept };
}

interface FrameOut {
  tag: string;
  frameHash: string;
  imgW: number;
  imgH: number;
  osd: { found: boolean; box: Box | null; glyphs: number; groups: number; boxRel: [number, number, number, number] | null };
  shamBox: Box | null;
  arms: ArmRec[];
  diff: Array<{
    arm: string;
    dLines: number;
    dPassRows: number;
    newLines: number;
    lostLines: number;
    newLineEdgeDistMin: number | null;
    /** 소실 직선 중 **마스킹 박스를 관통**하던 직선 수 — 「지운 것이 그 직선이었나」 직접 확인. */
    lostCrossingBox: number;
    /** 직선 수가 `maxLines` 상한에 붙었는가(붙으면 직선 수 대조는 검열됨). */
    baseCapped: boolean;
    armCapped: boolean;
  }>;
}

/** 오버레이 한 장(행 quad + 박스). */
function panelSvg(W: number, H: number, local: Array<{ ci: number; r: GridResult }>, pass: boolean[], boxes: Array<{ b: Box; color: string; label: string }>, glyphBoxes: Box[], header: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < local.length; i++) {
    const col = pass[i] ? '#00e676' : '#9e9e9e';
    const wdt = pass[i] ? 3 : 1;
    for (const q of local[i].r.quads as BayQuad[]) {
      parts.push(`<polygon points="${q.quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${col}1f" stroke="${col}" stroke-width="${wdt}"/>`);
    }
  }
  for (const gb of glyphBoxes) {
    parts.push(`<rect x="${gb.x0}" y="${gb.y0}" width="${gb.x1 - gb.x0 + 1}" height="${gb.y1 - gb.y0 + 1}" fill="none" stroke="#ffea00" stroke-width="1"/>`);
  }
  for (const { b, color, label } of boxes) {
    parts.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0 + 1}" height="${b.y1 - b.y0 + 1}" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="10 6"/>`);
    parts.push(`<text x="${b.x0}" y="${Math.max(18, b.y0 - 8)}" fill="${color}" font-size="22">${label}</text>`);
  }
  parts.push(`<rect x="10" y="10" width="${W - 20}" height="${28 * header.length + 22}" fill="#000000cc" rx="8"/>`);
  header.forEach((t, i) => parts.push(`<text x="26" y="${44 + i * 28}" fill="${i === 0 ? '#fff' : '#ddd'}" font-size="${i === 0 ? 24 : 20}">${t}</text>`));
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

async function grayToPng(gray: Uint8Array, W: number, H: number): Promise<Buffer> {
  return sharp(Buffer.from(gray), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

const all: FrameOut[] = [];

/** 한 프레임 전체 — base / osd / sham 3개 암. */
async function processFrame(tag: string, label: string, jpg: Buffer, model: GroundModel, opts: BayDetectOpts, shamRel: [number, number, number, number] | null): Promise<void> {
  const meta = await sharp(jpg).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gb = await sharp(jpg).greyscale().raw().toBuffer();
  const gray = new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength);
  const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);

  const { mask } = paintMask({ data: gray, width: W, height: H }, DEFAULT_PAINT_OPTIONS);
  const find = findOsdBox({ data: gray, width: W, height: H }, mask);

  const shamBox: Box | null = find.box
    ? mirrorBox(find.box, W)
    : shamRel
      ? { x0: Math.round(shamRel[0] * W), y0: Math.round(shamRel[1] * H), x1: Math.round(shamRel[2] * W), y1: Math.round(shamRel[3] * H) }
      : null;
  // `passRowsOnBox` 의 기준 박스는 **세 암 모두 동일**(OSD 박스, 없으면 sham 박스) — 그래야 차분이 성립한다.
  const refBox = find.box ?? shamBox;

  const base = runArm('base', gray, W, H, model, opts, refBox);
  const arms: ArmRec[] = [base.rec];
  const diff: FrameOut['diff'] = [];
  const panels: Array<{ png: Buffer; local: Array<{ ci: number; r: GridResult }>; pass: boolean[]; boxes: Array<{ b: Box; color: string; label: string }>; glyphBoxes: Box[]; header: string[] }> = [];

  panels.push({
    png: await grayToPng(gray, W, H),
    local: base.local,
    pass: base.pass,
    boxes: find.box ? [{ b: find.box, color: '#ff5252', label: `OSD 검출 박스 ${find.box.x0},${find.box.y0}-${find.box.x1},${find.box.y1}` }] : [],
    glyphBoxes: find.glyphBoxes,
    header: [
      `[A] 마스킹 전(base)  frameHash=${frameHash}  ${W}×${H}`,
      label,
      `직선 ${base.rec.lines} · 후보행 ${base.rec.rows} · 통과행 ${base.rec.passRows} · refScore=${base.rec.refScore} · 문턱=${base.rec.rowThreshold}`,
      `OSD 검출: ${find.box ? `있음(글리프 ${find.glyphs}개 중 채택 ${find.glyphBoxes.length}자)` : `없음(글리프후보 ${find.glyphs} · 성분 ${find.candidates})`}`,
    ],
  });

  let osdGray: Uint8Array | null = null;
  if (find.box) {
    osdGray = coonsFill(gray, W, H, find.box);
    const a = runArm('osd', osdGray, W, H, model, opts, refBox);
    arms.push(a.rec);
    const m = matchLines(base.rec.lineList, a.rec.lineList);
    diff.push({
      arm: 'osd',
      dLines: a.rec.lines - base.rec.lines,
      dPassRows: a.rec.passRows - base.rec.passRows,
      newLines: m.newOnes.length,
      lostLines: m.lost.length,
      newLineEdgeDistMin: m.newOnes.length ? Math.min(...m.newOnes.map((l) => edgeDistPx(l.line, find.box as Box))) : null,
      lostCrossingBox: m.lost.filter((l) => lineCrossesBox(l.line, find.box as Box)).length,
      baseCapped: base.rec.lines >= DEFAULT_PAINT_OPTIONS.maxLines,
      armCapped: a.rec.lines >= DEFAULT_PAINT_OPTIONS.maxLines,
    });
    panels.push({
      png: await grayToPng(osdGray, W, H),
      local: a.local,
      pass: a.pass,
      boxes: [{ b: find.box, color: '#ff5252', label: 'OSD 마스킹(Coons 채움)' }],
      glyphBoxes: [],
      header: [
        `[B] OSD 마스킹 후(osd)  frameHash=${frameHash}  ${W}×${H}`,
        label,
        `직선 ${a.rec.lines}(Δ${a.rec.lines - base.rec.lines}) · 후보행 ${a.rec.rows} · 통과행 ${a.rec.passRows}(Δ${a.rec.passRows - base.rec.passRows}) · refScore=${a.rec.refScore}`,
        `신규직선 ${m.newOnes.length} · 소실직선 ${m.lost.length} · 신규직선의 박스변 최소거리 ${m.newOnes.length ? Math.min(...m.newOnes.map((l) => edgeDistPx(l.line, find.box as Box))).toFixed(2) : '--'}px`,
      ],
    });
  }

  if (shamBox) {
    const sg = coonsFill(gray, W, H, shamBox);
    const a = runArm('sham', sg, W, H, model, opts, refBox);
    arms.push(a.rec);
    const m = matchLines(base.rec.lineList, a.rec.lineList);
    diff.push({
      arm: 'sham',
      dLines: a.rec.lines - base.rec.lines,
      dPassRows: a.rec.passRows - base.rec.passRows,
      newLines: m.newOnes.length,
      lostLines: m.lost.length,
      newLineEdgeDistMin: m.newOnes.length ? Math.min(...m.newOnes.map((l) => edgeDistPx(l.line, shamBox))) : null,
      lostCrossingBox: m.lost.filter((l) => lineCrossesBox(l.line, shamBox)).length,
      baseCapped: base.rec.lines >= DEFAULT_PAINT_OPTIONS.maxLines,
      armCapped: a.rec.lines >= DEFAULT_PAINT_OPTIONS.maxLines,
    });
    panels.push({
      png: await grayToPng(sg, W, H),
      local: a.local,
      pass: a.pass,
      boxes: [{ b: shamBox, color: '#40c4ff', label: 'sham(자막 없는 위치) 같은 채움' }],
      glyphBoxes: [],
      header: [
        `[C] sham 마스킹 후(sham)  frameHash=${frameHash}  ${W}×${H}`,
        label,
        `직선 ${a.rec.lines}(Δ${a.rec.lines - base.rec.lines}) · 후보행 ${a.rec.rows} · 통과행 ${a.rec.passRows}(Δ${a.rec.passRows - base.rec.passRows}) · refScore=${a.rec.refScore}`,
        `신규직선 ${m.newOnes.length} · 소실직선 ${m.lost.length} · 신규직선의 박스변 최소거리 ${m.newOnes.length ? Math.min(...m.newOnes.map((l) => edgeDistPx(l.line, shamBox))).toFixed(2) : '--'}px`,
      ],
    });
  }

  // 나란히 합성(가로 배치).
  const comps: Array<{ input: Buffer; top: number; left: number }> = [];
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const withSvg = await sharp(p.png)
      .composite([{ input: Buffer.from(panelSvg(W, H, p.local, p.pass, p.boxes, p.glyphBoxes, p.header)), top: 0, left: 0 }])
      .png()
      .toBuffer();
    comps.push({ input: withSvg, top: 0, left: i * W });
  }
  const outPng = join(outDir, `r26b_${mode}_${tag}_${frameHash}.png`);
  await sharp({ create: { width: W * panels.length, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(comps)
    .png()
    .toFile(outPng);

  all.push({
    tag,
    frameHash,
    imgW: W,
    imgH: H,
    osd: {
      found: find.box != null,
      box: find.box,
      glyphs: find.glyphs,
      groups: find.groups,
      boxRel: find.box ? [find.box.x0 / W, find.box.y0 / H, find.box.x1 / W, find.box.y1 / H] : null,
    },
    shamBox,
    arms,
    diff,
  });
}

// ── 야간 실카 6장 ─────────────────────────────────────────────────────
if (mode === 'night') {
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
    if (hash !== f.sha256_12) throw new Error(`해시 불일치 ${f.file}: 기대 ${f.sha256_12} 실제 ${hash}`);
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
    // 25회차 `gridDiag.ts` 야간 설정과 **동일**(면수를 모르므로 위상불변 분모).
    const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, cameraHeightM: heightM, expectedBays: 1, coverageDenom: 'phaseInvariant' };
    await processFrame(f.file.slice(6, 21), `야간 실카(real-camera-2) ${f.capturedAtLocal} hfov=${hfov.toFixed(2)}° h=${heightM}m`, jpg, model, opts, null);
  }
} else if (mode === 'ev') {
  // ── 실카 낮 프리셋 4장(리더 육안근거 ②③ 직접 검증) ─────────────────
  // PTZ 값의 출처는 `evPresetDetect.ts:PRESETS`(장비 원시 PTZ 판독본) — **정답지 `truth.json` 은 읽지 않는다**.
  // ⚠ `real-camera-1` 은 `PtzCamRoi.json` 정본에 없어 설치고가 시뮬 값이다. 이 결함은 두 암에 **동일**하다.
  const PRESETS = [
    { id: 'EV1', presetIdx: 1, tiltPos: 2760, zoomPos: 8155, viewerZoom: 18.4209595, osd: '70/27/x35' },
    { id: 'EV3', presetIdx: 3, tiltPos: 1611, zoomPos: 8998, viewerZoom: 20.2218018, osd: '48/16/x35' },
    { id: 'EV4', presetIdx: 4, tiltPos: 1554, zoomPos: 10439, viewerZoom: 23.3001099, osd: '64/15/x55' },
    { id: 'EV5', presetIdx: 5, tiltPos: 1188, zoomPos: 10711, viewerZoom: 23.8811646, osd: '38/11/x55' },
  ] as const;
  const ground = readGroundSpec(process.env.LENS_CALIB_FILE ?? 'data/lens_calibration.json', 'real-camera-1');
  for (const P of PRESETS) {
    const png = readFileSync(join('test/fixtures/evPreset', `${P.id}.png`));
    const meta = await sharp(png).metadata();
    const hfov = ground.zoomHfov ? interpolateHfov(ground.zoomHfov, P.zoomPos) : null;
    const heightM = ground.heightM;
    if (hfov == null || heightM == null) throw new Error(`제원 부족 hfov=${hfov} heightM=${heightM}`);
    const model = groundModelFromIntrinsics(
      { camIdx: 1, presetIdx: P.presetIdx, fovDeg: hfov, fovAxis: 'horizontal', tiltDeg: P.tiltPos / 100, heightM, imgW: meta.width ?? 0, imgH: meta.height ?? 0, source: `evPreset:${P.id}` },
      P.viewerZoom,
    );
    if (!model) throw new Error(`지면모델 실패 ${P.id}`);
    const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, cameraHeightM: heightM, expectedBays: 1, coverageDenom: 'phaseInvariant' };
    await processFrame(P.id, `실카 낮 프리셋 ${P.id} OSD=${P.osd} hfov=${hfov.toFixed(2)}° h=${heightM}m`, png, model, opts, null);
  }
} else {
  // ── 시뮬 골든 5프레임(자막 없음 — 대조군) ────────────────────────────
  // sham 박스 상대좌표: **야간 6프레임에서 이미지-유도로 검출된 박스의 중앙값**을 CLI 인자로 받는다.
  const rel = process.argv[4];
  const shamRel = rel ? (rel.split(',').map(Number) as [number, number, number, number]) : null;
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
      const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, manual.length) };
      await processFrame(key.replace(':', '-'), `시뮬 골든 ${key}`, jpg, model, opts, shamRel);
    }
  }
}

const jsonPath = join(outDir, `osdMaskDiag_${mode}.json`);
writeFileSync(jsonPath, `${JSON.stringify(all, null, 1)}\n`, 'utf8');

// ── 콘솔 표 ────────────────────────────────────────────────────────────
console.log(`\n=== 26회차 26-2 OSD 자막 마스킹 대조 · mode=${mode} ===`);
console.log('★ 「박스위」 = 통과행 중 quad 가 기준 박스(OSD, 없으면 sham)와 겹치는 행 수 — 가설이 직접 예측하는 양');
console.log('frame                 hash          OSD박스(x0,y0-x1,y1)      base직선 base통과 박스위  osd직선 osd통과 박스위  sham직선 sham통과 박스위');
for (const f of all) {
  const g = (arm: string, k: 'lines' | 'passRows' | 'passRowsOnBox') => {
    const a = f.arms.find((x) => x.arm === arm);
    return a ? String(a[k] ?? '-').padStart(3) : ' --';
  };
  const b = f.osd.box ? `${f.osd.box.x0},${f.osd.box.y0}-${f.osd.box.x1},${f.osd.box.y1}` : '(없음)';
  console.log(
    `${f.tag.padEnd(20).slice(0, 20)}  ${f.frameHash}  ${b.padEnd(24)}  ${g('base', 'lines')}      ${g('base', 'passRows')}    ${g('base', 'passRowsOnBox')}    ${g('osd', 'lines')}     ${g('osd', 'passRows')}    ${g('osd', 'passRowsOnBox')}     ${g('sham', 'lines')}      ${g('sham', 'passRows')}    ${g('sham', 'passRowsOnBox')}`,
  );
}
const sum = (arm: string, k: 'lines' | 'passRows' | 'passRowsOnBox') => all.reduce((s, f) => s + (f.arms.find((x) => x.arm === arm)?.[k] ?? 0), 0);
const has = (arm: string) => all.filter((f) => f.arms.some((x) => x.arm === arm)).length;
console.log(`\n합계(원시 배정도) — base: 직선 ${sum('base', 'lines')} · 통과행 ${sum('base', 'passRows')} · 박스위 통과행 ${sum('base', 'passRowsOnBox')}`);
console.log(`               osd(${has('osd')}프레임): 직선 ${sum('osd', 'lines')} · 통과행 ${sum('osd', 'passRows')} · 박스위 통과행 ${sum('osd', 'passRowsOnBox')}`);
console.log(`              sham(${has('sham')}프레임): 직선 ${sum('sham', 'lines')} · 통과행 ${sum('sham', 'passRows')} · 박스위 통과행 ${sum('sham', 'passRowsOnBox')}`);
console.log('\n=== 차분 상세 ===');
for (const f of all) {
  for (const d of f.diff) {
    console.log(
      `${f.tag.padEnd(20).slice(0, 20)}  ${f.frameHash}  ${d.arm.padEnd(5)}  Δ직선 ${String(d.dLines).padStart(3)}${d.baseCapped || d.armCapped ? '(상한검열)' : '        '}  Δ통과행 ${String(d.dPassRows).padStart(3)}  신규 ${d.newLines}  소실 ${d.lostLines}(박스관통 ${d.lostCrossingBox})  신규직선-박스변 최소거리 ${d.newLineEdgeDistMin == null ? '--' : d.newLineEdgeDistMin}`,
    );
  }
}
if (mode === 'night') {
  const rels = all.filter((f) => f.osd.boxRel).map((f) => f.osd.boxRel as [number, number, number, number]);
  if (rels.length) {
    const med = (i: number) => {
      const s = rels.map((r) => r[i]).sort((a, b) => a - b);
      return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    };
    console.log(`\nOSD 박스 상대좌표 중앙값(시뮬 sham 인자로 전달): ${med(0)},${med(1)},${med(2)},${med(3)}`);
  }
}
console.log(`\n덤프: ${jsonPath}  · 스샷: ${outDir}`);
