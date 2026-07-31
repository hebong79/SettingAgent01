// ★ 22회차 측정 ⓕ — **빈 주차구역이 파이프라인 어디서 죽는가**를 단계별로 좁히는 진단 도구.
//
// 배경(마스터 실측): 같은 카메라·같은 프리셋·같은 설정인데 검출 면수가 14/3/8 로 요동하고,
// 세 프레임 **모두** 화면 우하단의 「차가 없고 도색선이 선명한 빈 주차구역」을 하나도 잡지 못했다.
// 차가 없으므로 가림(occlusion) 성분이 아니다 — 도색만 보는 검출기가 가장 쉽게 잡아야 할 경우다.
//
// 무엇을 재는가(파이프라인 순서 그대로):
//   ①단 `detectPaintLines`        → 그 구역의 도색선이 **직선으로 검출되는가**, 검출되면 votes 순위 몇 번인가
//                                    (`frontCandidates` 상위 N 안에 드는가)
//   ②단 `scanSeparators`/`refineSeparators` → 그 선을 **front 로 강제 지정**했을 때 칸 경계를 몇 개 찾는가
//   ③단 `fitRowGrid`              → quad 몇 개 · `paint.score`/`paint.near`/`medianDepthM` 얼마 ·
//                                    `rows` 게이트(`score ≥ refScore·rowMinScoreRatio`, `near ≥ rowMinNearSupport`) 통과 여부
//   ④단 서비스 등가 실행           → 실제로 목록에 오르는 행이 무엇인가
//
// ★ 검출 알고리즘 0줄 변경. `src/ground/*` 를 **읽기만** 한다(import 만, 수정 없음).
// ★ 카메라를 이동시키지 않는다: `requestImage(cam,preset)` 을 **ptz 없이** 호출하면
//   `CameraSourceClient` 가 `mode:'preset'` 으로 내려보내고, `RealPtzSource.snapshot` 은 그 모드에서
//   `move()` 를 **호출하지 않는다**(RealPtzSource.ts:232-237 — getJpeg + 현재 PTZ 조회뿐).
//   `realFrameOverlay.ts`(17b)·`roi.auto.detect` 가 쓰는 것과 같은 경로다. 전후 PTZ 를 함께 기록한다.
// ★ 정본(PtzCamRoi.json)·DB 무접촉. `roi.auto.apply` 호출 없음.
// ★ **모든 단계가 같은 프레임 위에서 돈다** — 한 번 캡처해 버퍼를 재사용하므로 frameHash 가 단계마다 갈릴 수 없다(F13).
//
// 사용:
//   npx tsx src/tools/emptyBayProbe.ts <sourceId> <outDir> [frameJpg|'-'] [roiRect|'-'] [probeLines|'-'] [heightM] [hfovDeg]
//     frameJpg    저장된 jpg 경로를 주면 **캡처하지 않고** 그 프레임으로 돈다(같은 프레임 재분석용). '-' = 라이브 캡처
//     roiRect     "x0,y0,x1,y1" — 관심 영역(우하단 빈 구역). 이 사각형과 만나는 직선을 따로 표시·측정한다
//     probeLines  "3,17,25" — ②③단을 강제로 돌릴 직선 순위(0-based). '-' = ROI 와 만나는 직선 전부
//     heightM/hfovDeg  뷰어 「카메라 제원」 칸과 같은 뜻의 수동 지정(비우면 파일·실측표)

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PAINT_OPTIONS,
  detectPaintLines,
  imageSpanOf,
  meetLines,
  paintEvidenceOf,
  refineSeparators,
  scanSeparators,
  type FrameGray,
  type RefinedLine,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS, quadPaintSupport, type BayDetectOpts, type BayQuad, type PaintSupport } from '../ground/bayGeometry.js';
import { detectBaysWithModel, fitRowGrid, type GridResult, type RowCandidate, type RowFrame } from '../ground/bayGrid.js';
import { projectToPixel } from '../ground/project.js';
import { canonicalizeQuad } from '../ground/groundGrid.js';
import type { GroundModel } from '../ground/types.js';
import { groundModelFromIntrinsics, interpolateHfov } from '../ground/cameraIntrinsics.js';
import { readGroundSpec } from '../rpc/services/roiAuto.js';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { buildSourceRegistry } from '../viewer/sourceRegistry.js';
import { CameraSourceClient } from '../clients/CameraSourceClient.js';

const sourceId = process.argv[2];
const outDir = process.argv[3];
const frameArg = process.argv[4] ?? '-';
const roiArg = process.argv[5] ?? '-';
const probeArg = process.argv[6] ?? '-';
const heightOverrideM = process.argv[7] != null && process.argv[7] !== '' && process.argv[7] !== '-' ? Number(process.argv[7]) : null;
const hfovOverrideDeg = process.argv[8] != null && process.argv[8] !== '' && process.argv[8] !== '-' ? Number(process.argv[8]) : null;
if (!sourceId || !outDir) {
  console.error("사용: npx tsx src/tools/emptyBayProbe.ts <sourceId> <outDir> [frameJpg|'-'] [roiRect|'-'] [probeLines|'-'] [heightM] [hfovDeg]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const roi = roiArg === '-' ? null : (roiArg.split(',').map(Number) as [number, number, number, number]);
if (roi && (roi.length !== 4 || roi.some((v) => !Number.isFinite(v)))) throw new Error(`roiRect 형식: "x0,y0,x1,y1" (받은 값 ${roiArg})`);

const cfg = loadToolsConfig();
const src = buildSourceRegistry(cfg).get(sourceId);
if (!src) {
  console.error(`알 수 없는 소스: ${sourceId}`);
  process.exit(2);
}

/** ①③ 참고용 PTZ 조회(뷰어 프록시). 실패해도 진단을 죽이지 않는다. */
async function viewerPtz(): Promise<unknown> {
  try {
    const r = await fetch(`http://localhost:13020/viewer/api/ptz?source=${sourceId}&cam=1`, { signal: AbortSignal.timeout(20_000) });
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ── 0단: 프레임 확보(무이동). 한 번만 잡고 이후 전 단계가 이 버퍼를 쓴다.
const ptzBefore = await viewerPtz();
let jpg: Buffer;
let capPtz: { pan: number; tilt: number; zoom: number };
if (frameArg !== '-') {
  jpg = readFileSync(frameArg);
  const saved = JSON.parse(readFileSync(`${frameArg}.ptz.json`, 'utf8')) as { pan: number; tilt: number; zoom: number };
  capPtz = saved;
} else {
  const cap = await new CameraSourceClient(src, cfg.camera).requestImage(1, 1);
  jpg = cap.jpg;
  capPtz = { pan: cap.pan, tilt: cap.tilt, zoom: cap.zoom };
}
const ptzAfter = await viewerPtz();
const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
const framePath = join(outDir, `frame_${frameHash}.jpg`);
if (frameArg === '-') {
  writeFileSync(framePath, jpg);
  writeFileSync(`${framePath}.ptz.json`, `${JSON.stringify(capPtz)}\n`, 'utf8');
}

const meta = await sharp(jpg).metadata();
const W = meta.width ?? 0;
const H = meta.height ?? 0;
const grayBuf = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength), width: W, height: H };

// ── 제원 — 서비스(roi.auto.detect)·realFrameOverlay 와 **같은 출처·같은 규칙**.
const native = src.toNativePtz(capPtz) as { tilt: number; zoom: number };
const ground = readGroundSpec(process.env.LENS_CALIB_FILE ?? 'data/lens_calibration.json', sourceId);
const hfovAuto = ground.zoomHfov ? interpolateHfov(ground.zoomHfov, native.zoom) : null;
const hfov = hfovOverrideDeg ?? hfovAuto;
const heightM = heightOverrideM ?? ground.heightM;
const tiltDeg = native.tilt / 100;
if (hfov == null || heightM == null) {
  console.error(`제원 부족 — hfov=${hfov} heightM=${heightM}`);
  process.exit(3);
}
const model = groundModelFromIntrinsics(
  { camIdx: 1, presetIdx: 1, fovDeg: hfov, fovAxis: 'horizontal', tiltDeg, heightM, imgW: W, imgH: H, source: `real:${sourceId}` },
  capPtz.zoom,
);
if (!model) {
  console.error(`지면모델 생성 실패(hfov ${hfov}° tilt ${tiltDeg}° h ${heightM}m)`);
  process.exit(3);
}
/** 위 널 검사 이후의 비-널 모델. 아래 함수 선언 안에서 좁힘이 유지되지 않아 이름을 따로 둔다. */
const gm: GroundModel = model;

// ── ①단: 도색선 검출.
const { lines, mask, threshold } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
const evidence = paintEvidenceOf(mask, W, H);

/** 선분 AB 가 사각형과 만나는가(끝점 포함 · 표본 순회 — 새 기하 수식을 만들지 않는다). */
function segHitsRect(a: { x: number; y: number }, b: { x: number; y: number }, r: readonly [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = r;
  const N = 200;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && y >= Math.min(y0, y1) && y <= Math.max(y0, y1)) return true;
  }
  return false;
}

const lineRows = lines.map((ln, i) => ({
  rank: i,
  votes: ln.votes,
  spanPx: ln.spanPx,
  contrast: ln.contrast,
  widthPx: ln.widthPx,
  residPx: ln.residPx,
  hit: ln.hit,
  endA: ln.endA,
  endB: ln.endB,
  inRoi: roi ? segHitsRect(ln.endA, ln.endB, roi) : false,
  inTopN: i < DEFAULT_PAINT_OPTIONS.frontCandidates,
}));

// ── ②③단: 후보별 체인. 표준 상위 N + ROI 교차 직선 + 사용자가 지정한 순위 전부.
const probeSet = new Set<number>();
for (let i = 0; i < Math.min(DEFAULT_PAINT_OPTIONS.frontCandidates, lines.length); i++) probeSet.add(i);
if (probeArg !== '-') for (const s of probeArg.split(',')) probeSet.add(Number(s));
else for (const r of lineRows) if (r.inRoi) probeSet.add(r.rank);
const probeRanks = [...probeSet].filter((r) => r >= 0 && r < lines.length).sort((a, b) => a - b);

const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, cameraHeightM: heightM, expectedBays: 1, coverageDenom: 'phaseInvariant' };

interface Probe {
  rank: number;
  peaks: number;
  seps: number;
  corners: number;
  grid: GridResult | null;
  front: RefinedLine;
}
const probes: Probe[] = [];
for (const rank of probeRanks) {
  const front = lines[rank];
  const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
  const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
  const pts: Array<{ x: number; y: number }> = [];
  for (const sep of seps) {
    const q = meetLines(sep.line, front.line);
    if (q) pts.push(q);
  }
  const grid = fitRowGrid(model, front, pts, evidence, DEFAULT_PAINT_OPTIONS, opts);
  probes.push({ rank, peaks: peaks.length, seps: seps.length, corners: pts.length, grid, front });
}

// ── 깊이방향 감사 — **채택된 격자와 그 반대 깊이방향**을 같은 위상·같은 격자인덱스에서 나란히 잰다.
//
// 왜 필요한가: `fitRowGrid` 는 깊이축 v 의 **양방향**을 후보로 두고(bayGrid.ts:286-288) 이긴 쪽만 돌려준다.
// 진 쪽의 수치는 어디에도 남지 않아 "왜 반대편(=실제 주차칸이 있는 쪽)이 졌는가"를 알 수 없다.
//
// ★ 재구현 검증 규약: **같은 방향**을 이 함수로 다시 세워 `grid.paint` 와 값이 일치하는지 먼저 확인한다.
//   일치하면 반대방향 수치도 같은 식으로 얻은 것이므로 신뢰할 수 있고, 어긋나면 그 사실을 그대로 적는다.
//   (`buildAtPhase` 는 export 되지 않아 좌표 생성 3줄만 같은 규약으로 옮겼다 — 채점은 `quadPaintSupport` 원본 그대로.)
function auditDepthDirection(g: GridResult, flip: boolean, phaseShift = 0): { quads: BayQuad[]; sup: PaintSupport } {
  const fr: RowFrame = flip ? { origin: g.frame.origin, u: g.frame.u, v: [-g.frame.v[0], -g.frame.v[1], -g.frame.v[2]] } : g.frame;
  const phase = g.phaseM + phaseShift;
  const at = (a: number, b: number) =>
    projectToPixel([fr.origin[0] + fr.u[0] * a + fr.v[0] * b, fr.origin[1] + fr.u[1] * a + fr.v[1] * b, fr.origin[2] + fr.u[2] * a + fr.v[2] * b], gm);
  const quads: BayQuad[] = [];
  for (const q of g.quads) {
    const k = q.latticeIndex;
    const a0 = phase + k * opts.slotWidthM;
    const a1 = phase + (k + 1) * opts.slotWidthM;
    const n0 = at(a0, 0);
    const n1 = at(a1, 0);
    const f0 = at(a0, opts.slotDepthM);
    const f1 = at(a1, opts.slotDepthM);
    if (!n0 || !n1 || !f0 || !f1) continue;
    const cq = canonicalizeQuad([n0, f0, f1, n1]);
    if (cq) quads.push({ latticeIndex: k, quad: cq });
  }
  return { quads, sup: quadPaintSupport(quads, evidence, DEFAULT_PAINT_OPTIONS, opts) };
}

// `refScore` = baseScore argmax 후보의 paint.score — **표준 후보집합(상위 N)에서만** 뽑는다(bayGrid.ts:687-699 와 동일).
let refScore = 0;
let refBase = -Infinity;
let refRank = -1;
for (const p of probes) {
  if (!p.grid || p.rank >= DEFAULT_PAINT_OPTIONS.frontCandidates) continue;
  const b = p.grid.baseScore ?? p.grid.paint.score;
  if (b > refBase + 1e-12) {
    refBase = b;
    refScore = p.grid.paint.score;
    refRank = p.rank;
  }
}

// ── ④단: 서비스 등가 실행(상위 N 후보 → detectBaysWithModel).
const stdCands: RowCandidate[] = [];
for (const p of probes) {
  if (p.rank >= DEFAULT_PAINT_OPTIONS.frontCandidates) continue;
  const pts: Array<{ x: number; y: number }> = [];
  const peaks = scanSeparators(frame, mask, p.front, DEFAULT_PAINT_OPTIONS);
  const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
  for (const sep of seps) {
    const q = meetLines(sep.line, p.front.line);
    if (q) pts.push(q);
  }
  stdCands.push({ front: p.front, cornersPx: pts });
}
const detection = detectBaysWithModel(stdCands, model, evidence, DEFAULT_PAINT_OPTIONS, opts, frame);

// ── ④' 반사실: **진입 문턱만 없앤** 서비스 등가(= "행 단위 상대문턱을 개별 독립으로 바꾸면?"의 하한 모형).
//    검출 알고리즘은 그대로고 `rowMinScoreRatio`/`rowMinNearSupport` 만 0 으로 낮춘 옵션을 쓴다.
//    이것으로 "문턱만 풀면 그 구역이 **제 위치에** 잡히는가"를 그림으로 확인한다.
const noGate = detectBaysWithModel(
  stdCands,
  model,
  evidence,
  DEFAULT_PAINT_OPTIONS,
  { ...opts, rowMinScoreRatio: 0, rowMinNearSupport: 0 },
  frame,
);

// ── 렌더 ─────────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const L = (x1: number, y1: number, x2: number, y2: number, stroke: string, w: number, op = 1, dash = '') =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${w}" opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const T = (x: number, y: number, fill: string, size: number, text: string) =>
  `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${fill}" font-size="${size}" font-family="monospace">${esc(text)}</text>`;

/** 좌표 격자 — 스샷에서 픽셀 좌표를 눈으로 읽기 위한 눈금(진단 전용). */
function coordGrid(step = 200): string[] {
  const out: string[] = [];
  for (let x = step; x < W; x += step) {
    out.push(L(x, 0, x, H, '#00e5ff', 1, 0.18));
    out.push(T(x + 3, 18, '#00e5ff', 15, String(x)));
  }
  for (let y = step; y < H; y += step) {
    out.push(L(0, y, W, y, '#00e5ff', 1, 0.18));
    out.push(T(3, y - 3, '#00e5ff', 15, String(y)));
  }
  return out;
}
function roiBox(): string[] {
  if (!roi) return [];
  const [x0, y0, x1, y1] = roi;
  return [
    `<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="none" stroke="#76ff03" stroke-width="4" stroke-dasharray="16,10"/>`,
    T(Math.min(x0, x1) + 8, Math.min(y0, y1) + 28, '#76ff03', 24, 'ROI(빈 구역)'),
  ];
}
function banner(lines2: string[]): string[] {
  const out = [`<rect x="12" y="${H - 24 - 30 * lines2.length}" width="${W - 24}" height="${18 + 30 * lines2.length}" fill="#000000d8" rx="8"/>`];
  lines2.forEach((t, i) => out.push(T(28, H - 30 - 30 * (lines2.length - 1 - i), '#ffffff', 23, t)));
  return out;
}
async function render(name: string, parts: string[]): Promise<string> {
  const p = join(outDir, name);
  await sharp(jpg)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(p);
  return p;
}

/** 동차직선을 프레임 경계까지 늘린 선분(realFrameOverlay 와 같은 규약). */
function seg(l: readonly [number, number, number]): [number, number, number, number] | null {
  const sp = imageSpanOf(l as [number, number, number], W, H);
  if (!sp) return null;
  return [sp.px0 + sp.dx * sp.tmin, sp.py0 + sp.dy * sp.tmin, sp.px0 + sp.dx * sp.tmax, sp.py0 + sp.dy * sp.tmax];
}

// ①-a 마스크 오버레이 — "도색이 마스크에 잡히기는 하는가"(원인 A 판별의 1차 증거).
{
  const rgb = await sharp(jpg).ensureAlpha().raw().toBuffer();
  const px = new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);
  for (let i = 0, n = W * H; i < n; i++) {
    if (mask[i]) {
      px[i * 4] = 255;
      px[i * 4 + 1] = 0;
      px[i * 4 + 2] = 230;
    }
  }
  const base = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const parts = [...coordGrid(), ...roiBox(), ...banner([
    `①-a 도색 마스크(자홍) — frameHash ${frameHash} · 임계 ${threshold.toFixed(2)} · maskPercentile ${DEFAULT_PAINT_OPTIONS.maskPercentile} · minContrast ${DEFAULT_PAINT_OPTIONS.minContrast}`,
    `${W}×${H} · 마스크 화소 ${mask.reduce((s, v) => s + (v ? 1 : 0), 0)} · ROI 내 마스크 화소 ${roi ? countMaskInRoi() : '--'}`,
  ])];
  await sharp(base)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(join(outDir, `s1a_mask_${frameHash}.png`));
}
function countMaskInRoi(): number {
  if (!roi) return 0;
  const [x0, y0, x1, y1] = roi;
  let n = 0;
  for (let y = Math.max(0, Math.min(y0, y1)); y < Math.min(H, Math.max(y0, y1)); y++)
    for (let x = Math.max(0, Math.min(x0, x1)); x < Math.min(W, Math.max(x0, x1)); x++) if (mask[y * W + x]) n++;
  return n;
}

// ①-b 검출 직선 전체 + 순위 라벨.
{
  const parts: string[] = [...coordGrid()];
  for (const r of lineRows) {
    const s = seg(lines[r.rank].line);
    if (s) parts.push(L(s[0], s[1], s[2], s[3], r.inRoi ? '#76ff03' : r.inTopN ? '#ffea00' : '#9e9e9e', 1, r.inRoi ? 0.7 : 0.3));
    // 지지 구간(정련 표본이 실제로 덮은 구간)은 굵게 — 직선의 "실체"는 여기다.
    parts.push(L(r.endA.x, r.endA.y, r.endB.x, r.endB.y, r.inRoi ? '#76ff03' : r.inTopN ? '#ffea00' : '#bdbdbd', r.inRoi ? 6 : r.inTopN ? 5 : 2, r.inRoi ? 1 : r.inTopN ? 0.95 : 0.55));
    const mx = (r.endA.x + r.endB.x) / 2;
    const my = (r.endA.y + r.endB.y) / 2;
    parts.push(T(mx + 6, my - 6, r.inRoi ? '#76ff03' : r.inTopN ? '#ffea00' : '#e0e0e0', r.inRoi || r.inTopN ? 26 : 18, `#${r.rank}(v${r.votes})`));
  }
  parts.push(...roiBox());
  parts.push(...banner([
    `①-b 검출 직선 ${lines.length}개 — 노랑 = frontCandidates 상위 ${DEFAULT_PAINT_OPTIONS.frontCandidates} · 초록 = ROI 교차 · 회색 = 후보 밖`,
    `frameHash ${frameHash} · f=${model.f.toFixed(1)}px hfov=${hfov.toFixed(3)}° tilt=${tiltDeg.toFixed(2)}° h=${heightM}m · ROI 교차 직선 ${lineRows.filter((r) => r.inRoi).length}개`,
  ]));
  await render(`s1b_lines_${frameHash}.png`, parts);
}

// ②③ 후보별 오버레이 — 분리선·코너·격자를 한 장에.
for (const p of probes) {
  const parts: string[] = [...coordGrid()];
  const fs = seg(p.front.line);
  if (fs) parts.push(L(fs[0], fs[1], fs[2], fs[3], '#ffea00', 2, 0.5));
  parts.push(L(p.front.endA.x, p.front.endA.y, p.front.endB.x, p.front.endB.y, '#ffea00', 6));
  const peaks = scanSeparators(frame, mask, p.front, DEFAULT_PAINT_OPTIONS);
  const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
  for (const s of seps) parts.push(L(s.endA.x, s.endA.y, s.endB.x, s.endB.y, '#00b0ff', 4, 0.9));
  for (const s of seps) {
    const q = meetLines(s.line, p.front.line);
    if (q) parts.push(`<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="9" fill="none" stroke="#ff9100" stroke-width="4"/>`);
  }
  if (p.grid) {
    for (const q of p.grid.quads)
      parts.push(
        `<polygon points="${q.quad.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}" fill="#ff174433" stroke="#ff1744" stroke-width="4" stroke-dasharray="14,8"/>`,
      );
  }
  parts.push(...roiBox());
  const g = p.grid;
  const pass1 = g ? g.paint.score >= refScore * opts.rowMinScoreRatio : false;
  const pass2 = g ? g.paint.near >= opts.rowMinNearSupport : false;
  parts.push(...banner([
    `②③ 직선 #${p.rank}(votes ${p.front.votes}, 지지 ${p.front.spanPx.toFixed(0)}px, 대비 ${p.front.contrast.toFixed(1)}) — 피크 ${p.peaks} · 분리선 ${p.seps} · 코너 ${p.corners} · quad ${g?.quads.length ?? 0}`,
    g
      ? `score ${g.paint.score.toFixed(5)} (ref ${refScore.toFixed(5)}×${opts.rowMinScoreRatio} = ${(refScore * opts.rowMinScoreRatio).toFixed(5)} → ${pass1 ? '통과' : '탈락'}) · near ${g.paint.near.toFixed(5)} (≥${opts.rowMinNearSupport} → ${pass2 ? '통과' : '탈락'}) · depth ${g.medianDepthM?.toFixed(2) ?? '--'}m`
      : 'fitRowGrid = null (격자 산출 실패)',
    `frameHash ${frameHash}`,
  ]));
  await render(`s3_grid_ci${String(p.rank).padStart(2, '0')}_${frameHash}.png`, parts);
}

// ④ 서비스 등가 결과.
{
  const parts: string[] = [...coordGrid()];
  const palette = ['#ff1744', '#00e676', '#2979ff', '#ffea00', '#e040fb', '#ff9100', '#18ffff', '#f50057'];
  detection.rows.forEach((r, i) => {
    const col = palette[i % palette.length];
    for (const q of r.quads)
      parts.push(
        `<polygon points="${q.quad.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}" fill="${col}22" stroke="${col}" stroke-width="4"/>`,
      );
    const q0 = r.quads[0];
    if (q0) parts.push(T(q0.quad[0].x + 8, q0.quad[0].y - 10, col, 26, `row${i} n=${r.quads.length} s=${r.paint.score.toFixed(3)}`));
  });
  parts.push(...roiBox());
  parts.push(...banner([
    `④ 서비스 등가 — rows ${detection.rows.length}행 · quad 합계 ${detection.rows.reduce((s, r) => s + r.quads.length, 0)} · best quad ${detection.best?.quads.length ?? 0}`,
    `refScore ${refScore.toFixed(5)}(#${refRank}) · 문턱 score ≥ ${(refScore * opts.rowMinScoreRatio).toFixed(5)} · near ≥ ${opts.rowMinNearSupport} · frameHash ${frameHash}`,
  ]));
  await render(`s4_rows_${frameHash}.png`, parts);
}

// ④' 반사실 렌더.
{
  const parts: string[] = [...coordGrid()];
  const palette = ['#ff1744', '#00e676', '#2979ff', '#ffea00', '#e040fb', '#ff9100', '#18ffff', '#f50057'];
  noGate.rows.forEach((r, i) => {
    const col = palette[i % palette.length];
    for (const q of r.quads)
      parts.push(`<polygon points="${q.quad.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}" fill="${col}22" stroke="${col}" stroke-width="4"/>`);
    const q0 = r.quads[0];
    if (q0) parts.push(T(q0.quad[0].x + 8, q0.quad[0].y - 10, col, 26, `row${i} n=${r.quads.length} s=${r.paint.score.toFixed(3)}`));
  });
  parts.push(...roiBox());
  parts.push(...banner([
    `④' 반사실(진입 문턱 0) — rows ${noGate.rows.length}행 · quad 합계 ${noGate.rows.reduce((s, r) => s + r.quads.length, 0)} (문턱 적용시 ${detection.rows.length}행)`,
    `문턱만 없앴을 때 그 구역이 **제 위치에** 잡히는지 눈으로 판정한다 · frameHash ${frameHash}`,
  ]));
  await render(`s6_nogate_${frameHash}.png`, parts);
}

// ── 표 출력 ──────────────────────────────────────────────────────────────────
console.log(`\n=== 22회차 ⓕ 빈 주차구역 진단 · ${sourceId} · frameHash ${frameHash} · ${W}×${H}`);
console.log(`  PTZ 전 ${JSON.stringify(ptzBefore)}`);
console.log(`  캡처   ${JSON.stringify(capPtz)}  네이티브 tiltpos ${native.tilt} zoompos ${native.zoom}`);
console.log(`  PTZ 후 ${JSON.stringify(ptzAfter)}`);
console.log(`  제원 f=${model.f.toFixed(2)}px hfov=${hfov.toFixed(4)}° tilt=${tiltDeg.toFixed(3)}° 설치고=${heightM}m · 마스크 임계 ${threshold.toFixed(3)}`);
console.log(`  ROI=${roiArg} · ROI 내 마스크 화소 ${roi ? countMaskInRoi() : '--'}`);

console.log(`\n--- ①단 검출 직선 ${lines.length}개 (frontCandidates=${DEFAULT_PAINT_OPTIONS.frontCandidates})`);
console.log('  rank  votes   spanPx  contrast  widthPx  residPx  hit   endA(x,y)          endB(x,y)          ROI  topN');
for (const r of lineRows) {
  console.log(
    `  ${String(r.rank).padStart(4)}  ${String(r.votes).padStart(5)}  ${r.spanPx.toFixed(1).padStart(7)}  ${r.contrast.toFixed(1).padStart(8)}  ` +
      `${r.widthPx.toFixed(2).padStart(7)}  ${r.residPx.toFixed(2).padStart(7)}  ${String(r.hit).padStart(3)}  ` +
      `(${r.endA.x.toFixed(0)},${r.endA.y.toFixed(0)})`.padEnd(19) +
      `(${r.endB.x.toFixed(0)},${r.endB.y.toFixed(0)})`.padEnd(19) +
      `${r.inRoi ? ' ★ ' : '   '}  ${r.inTopN ? '★' : ''}`,
  );
}

console.log(`\n--- ②③단 후보별 (refScore ${refScore.toFixed(5)} ← 직선 #${refRank} · 문턱 score ≥ ${(refScore * opts.rowMinScoreRatio).toFixed(5)} · near ≥ ${opts.rowMinNearSupport})`);
console.log('  rank  peaks  seps  corners  quads  paint.score   near      far      side   nearChamfer  baseScore  effective  coverage  denomC  depth(m)  게이트');
for (const p of probes) {
  const g = p.grid;
  const g1 = g ? g.paint.score >= refScore * opts.rowMinScoreRatio : false;
  const g2 = g ? g.paint.near >= opts.rowMinNearSupport : false;
  console.log(
    `  ${String(p.rank).padStart(4)}  ${String(p.peaks).padStart(5)}  ${String(p.seps).padStart(4)}  ${String(p.corners).padStart(7)}  ` +
      `${String(g?.quads.length ?? 0).padStart(5)}  ${(g?.paint.score.toFixed(5) ?? '--').padStart(11)}  ` +
      `${(g?.paint.near.toFixed(5) ?? '--').padStart(7)}  ${(g?.paint.far.toFixed(5) ?? '--').padStart(7)}  ${(g?.paint.side.toFixed(5) ?? '--').padStart(7)}  ` +
      `${(g?.paint.nearChamferPx.toFixed(2) ?? '--').padStart(11)}  ` +
      `${(g?.baseScore?.toFixed(5) ?? '--').padStart(9)}  ${(g?.effectiveScore?.toFixed(5) ?? '--').padStart(9)}  ${(g?.coverage?.toFixed(5) ?? '--').padStart(8)}  ` +
      `${(g?.denomCells?.toFixed(2) ?? '--').padStart(6)}  ${(g?.medianDepthM?.toFixed(2) ?? '--').padStart(8)}  ` +
      `${g ? (g1 && g2 ? '통과' : g1 ? 'near탈락' : g2 ? '비율탈락' : '둘다탈락') : '격자없음'}${p.rank >= DEFAULT_PAINT_OPTIONS.frontCandidates ? ' (후보밖)' : ''}`,
  );
}

console.log(`\n--- 깊이방향 감사(채택 방향 vs 반대 방향, 같은 위상·같은 격자인덱스) · minNearSupport=${opts.minNearSupport}`);
console.log('  rank  방향      quads     near      far     side    score   재구현검증(채택방향이 grid.paint 와 일치하는가)');
const audits: Array<Record<string, unknown>> = [];
for (const p of probes) {
  const g = p.grid;
  if (!g) continue;
  const same = auditDepthDirection(g, false);
  const flip = auditDepthDirection(g, true);
  const ok =
    Math.abs(same.sup.near - g.paint.near) < 1e-9 && Math.abs(same.sup.far - g.paint.far) < 1e-9 && Math.abs(same.sup.side - g.paint.side) < 1e-9;
  console.log(
    `  ${String(p.rank).padStart(4)}  채택      ${String(same.quads.length).padStart(5)}  ${same.sup.near.toFixed(5).padStart(7)}  ${same.sup.far.toFixed(5).padStart(7)}  ${same.sup.side.toFixed(5).padStart(7)}  ${same.sup.score.toFixed(5).padStart(7)}   ${ok ? '일치' : `불일치(grid near ${g.paint.near.toFixed(5)} far ${g.paint.far.toFixed(5)} side ${g.paint.side.toFixed(5)})`}`,
  );
  console.log(
    `  ${String(p.rank).padStart(4)}  반대      ${String(flip.quads.length).padStart(5)}  ${flip.sup.near.toFixed(5).padStart(7)}  ${flip.sup.far.toFixed(5).padStart(7)}  ${flip.sup.side.toFixed(5).padStart(7)}  ${flip.sup.score.toFixed(5).padStart(7)}   ` +
      `near ${flip.sup.near >= opts.minNearSupport ? '≥' : '<'} minNearSupport → ${flip.sup.near >= opts.minNearSupport ? '살아남음' : '위상 자체가 기각(bayGrid.ts:402)'}`,
  );
  // 위상 스윕 — "반대 방향이 진 것은 위상을 재사용했기 때문 아닌가"를 배제한다.
  //   `near` 는 근변선에서 깊이 5m 떨어진 **평행선 위의 도색**이라 위상이 바뀌어도 구간 양 끝만 움직인다.
  //   그 사실을 주장으로 두지 않고 한 칸 주기를 8등분해 직접 잰다.
  const sweep = Array.from({ length: 8 }, (_, j) => auditDepthDirection(g, true, (opts.slotWidthM * j) / 8).sup);
  const nrs = sweep.map((s) => s.near);
  const scs = sweep.map((s) => s.score);
  const sds = sweep.map((s) => s.side);
  console.log(
    `  ${String(p.rank).padStart(4)}  반대(위상8스윕)   near ${Math.min(...nrs).toFixed(5)}~${Math.max(...nrs).toFixed(5)} · ` +
      `side ${Math.min(...sds).toFixed(5)}~${Math.max(...sds).toFixed(5)} · score ${Math.min(...scs).toFixed(5)}~${Math.max(...scs).toFixed(5)} · ` +
      `near ≥ ${opts.minNearSupport} 인 위상 ${nrs.filter((v) => v >= opts.minNearSupport).length}/8`,
  );
  audits.push({ rank: p.rank, same: same.sup, flip: flip.sup, sameMatchesGrid: ok, flipSweep: sweep });

  // 반대방향 quad 를 그림으로도 남긴다 — 수치와 그림이 어긋나면 그림을 믿는다는 규약(스샷 실측).
  if (flip.quads.length) {
    const parts: string[] = [...coordGrid()];
    parts.push(L(p.front.endA.x, p.front.endA.y, p.front.endB.x, p.front.endB.y, '#ffea00', 6));
    for (const q of same.quads)
      parts.push(`<polygon points="${q.quad.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}" fill="#ff174422" stroke="#ff1744" stroke-width="3" stroke-dasharray="14,8"/>`);
    for (const q of flip.quads)
      parts.push(`<polygon points="${q.quad.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}" fill="#00e67633" stroke="#00e676" stroke-width="4"/>`);
    parts.push(...roiBox());
    parts.push(...banner([
      `깊이방향 감사 · 직선 #${p.rank} — 빨강 = 채택 방향(near ${same.sup.near.toFixed(3)} far ${same.sup.far.toFixed(3)} side ${same.sup.side.toFixed(3)} score ${same.sup.score.toFixed(3)})`,
      `초록 = 반대 방향(near ${flip.sup.near.toFixed(3)} far ${flip.sup.far.toFixed(3)} side ${flip.sup.side.toFixed(3)} score ${flip.sup.score.toFixed(3)}) · minNearSupport ${opts.minNearSupport} · frameHash ${frameHash}`,
    ]));
    await render(`s5_flip_ci${String(p.rank).padStart(2, '0')}_${frameHash}.png`, parts);
  }
}

console.log(`\n--- ④단 서비스 등가: rows ${detection.rows.length}행 · quad 합계 ${detection.rows.reduce((s, r) => s + r.quads.length, 0)}`);
detection.rows.forEach((r, i) =>
  console.log(
    `  row${i}  quads ${String(r.quads.length).padStart(3)}  score ${r.paint.score.toFixed(5)}  near ${r.paint.near.toFixed(5)}  depth ${r.medianDepthM?.toFixed(2) ?? '--'}m  ` +
      `근변 (${r.quads[0]?.quad[0].x.toFixed(0)},${r.quads[0]?.quad[0].y.toFixed(0)})~(${r.quads[r.quads.length - 1]?.quad[3].x.toFixed(0)},${r.quads[r.quads.length - 1]?.quad[3].y.toFixed(0)})`,
  ),
);
for (const s of detection.issues) console.log(`  issue: ${s}`);

console.log(`\n--- ④'단 반사실(진입 문턱 0): rows ${noGate.rows.length}행 · quad 합계 ${noGate.rows.reduce((s, r) => s + r.quads.length, 0)}`);
noGate.rows.forEach((r, i) =>
  console.log(
    `  row${i}  quads ${String(r.quads.length).padStart(3)}  score ${r.paint.score.toFixed(5)}  near ${r.paint.near.toFixed(5)}  far ${r.paint.far.toFixed(5)}  side ${r.paint.side.toFixed(5)}  depth ${r.medianDepthM?.toFixed(2) ?? '--'}m  ` +
      `근변 (${r.quads[0]?.quad[0].x.toFixed(0)},${r.quads[0]?.quad[0].y.toFixed(0)})~(${r.quads[r.quads.length - 1]?.quad[3].x.toFixed(0)},${r.quads[r.quads.length - 1]?.quad[3].y.toFixed(0)})`,
  ),
);

writeFileSync(
  join(outDir, `probe_${frameHash}.json`),
  `${JSON.stringify(
    {
      sourceId,
      frameHash,
      imgW: W,
      imgH: H,
      ptzBefore,
      capPtz,
      ptzAfter,
      nativeTilt: native.tilt,
      nativeZoom: native.zoom,
      hfovDeg: hfov,
      tiltDeg,
      heightM,
      focalPx: model.f,
      maskThreshold: threshold,
      roi: roiArg,
      maskPxInRoi: roi ? countMaskInRoi() : null,
      frontCandidates: DEFAULT_PAINT_OPTIONS.frontCandidates,
      lines: lineRows,
      refScore,
      refRank,
      gates: { rowMinScoreRatio: opts.rowMinScoreRatio, rowMinNearSupport: opts.rowMinNearSupport, threshold: refScore * opts.rowMinScoreRatio },
      probes: probes.map((p) => ({
        rank: p.rank,
        peaks: p.peaks,
        seps: p.seps,
        corners: p.corners,
        quads: p.grid?.quads.length ?? 0,
        score: p.grid?.paint.score ?? null,
        near: p.grid?.paint.near ?? null,
        baseScore: p.grid?.baseScore ?? null,
        effectiveScore: p.grid?.effectiveScore ?? null,
        coverage: p.grid?.coverage ?? null,
        denomCells: p.grid?.denomCells ?? null,
        depthM: p.grid?.medianDepthM ?? null,
        far: p.grid?.paint.far ?? null,
        side: p.grid?.paint.side ?? null,
        nearChamferPx: p.grid?.paint.nearChamferPx ?? null,
      })),
      depthAudit: audits,
      rows: detection.rows.map((r) => ({ quads: r.quads.length, score: r.paint.score, near: r.paint.near, depthM: r.medianDepthM })),
      issues: detection.issues,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`\n산출: ${outDir}/  (frame_${frameHash}.jpg · s1a_mask · s1b_lines · s3_grid_ci* · s4_rows · probe_${frameHash}.json)`);
