// ★ 22회차 — **실카 프리셋 정지영상 위에서 검출→채점→오버레이**를 끝까지 돌리는 진단 하네스.
//
// 왜 정지영상인가: 측정 시각이 야간이라 라이브 카메라를 쓸 수 없다. 그래서 낮에 저장된
// `etc/camera_preset/EV*.png`(사본 `test/fixtures/evPreset/`) 5장 중 **EV2 를 제외한 4장**을 쓴다
// (EV2 제외는 마스터 지시). **카메라에 접속하지 않는다 — 네트워크 호출 0건.**
//
// ★ f 문제 해결의 근거(21회차 규약 + 22회차 판독):
//   프리셋 뷰어 스샷 `etc/camera_preset/pos_EV*.jpg` 의 「장비 원시」 P/T/Z 를 그대로 읽었다.
//   - P·T 는 **centidegree**, `tiltpos + = 아래`(`@parkagent/lens-calib` geometry.ts:3-6 실측 확정).
//   - Z 는 **zoompos** 이며 `data/lens_calibration.json` 의 `real-camera-1.zoomHfov` **13점 실측표의 색인 그 자체**다.
//   - 3중 검산: EV1 `T 2760/100 = 27.60°` ↔ OSD `70/27/x35` · `P 7034/100 = 70.34°` ↔ OSD `70/...`,
//     EV3 `1611 → 16.11°` ↔ OSD `48/16/x35`, EV5 `1188 → 11.88°` ↔ OSD `38/11/x55`.
//   ⚠ **뷰어 tilt 는 각도가 아니라 range-fit 위치다**(21회차 §5-(g)) — 뷰어 값이 아니라 장비 원시 tiltpos 를 쓴다.
//   설치고 13m 은 `data/lens_calibration.json` 의 `real-camera-1.cameraSpec.heightM`(마스터 확정값).
//
// 무엇을 재는가(파이프라인 순서 그대로 — **어디서 죽는지**가 이 도구의 진짜 산출이다):
//   ①단 `detectPaintLines`                  → 직선 수 · 정답 근변선의 rank/votes/대비/거리
//   ②단 `frontCandidates` 상위 8 진입 여부   → 근변선이 후보 집합에 들어가는가
//   ③단 `scanSeparators`/`refineSeparators`  → 분리선·코너 수
//   ④단 `fitRowGrid`                         → 격자 산출 여부. **기본(minNearSupport 0.5)** 과
//        **near 게이트만 0 으로 낮춘 등가 실행**을 나란히 돌려 `bayGrid.ts:402` 위상 전멸을 직접 가른다.
//        추가로 깊이 양방향 × 위상 8스윕의 `paint.near` 범위를 잰다.
//   ⑤단 `rows` 진입 문턱(`rowMinScoreRatio` 0.94 · `rowMinNearSupport` 0.69) → 최종 quad
//
// 채점: `test/fixtures/evPreset/truth.json`(채점 전용 R1) 대비 IoU·재현율·정밀도를 **원시 배정도**로 낸다.
//   - 4점 중 하나라도 `pt:null`(가림) 인 면은 **IoU 계산 불가** → `unscorable` 로 따로 세고 계산한 척하지 않는다.
//   - 세 분모를 함께 낸다: ⓐ 전부포함 ⓑ 가림·화면밖 제외 ⓒ 확실 면만(4점 전부 `observed`).
//
// ★ 검출 알고리즘 0줄 변경. `src/ground/*`·`src/rpc/services/*`·`web/*` 는 **import 만** 한다.
// ★ 정본 `data/Place01/PtzCamRoi.json` · DB 무접촉. `roi.auto.apply` 미호출.
// ★ `data/lens_calibration.json` 은 **읽기만**(옆 세션이 실카 PTZ 작업 중).
//
// 사용: npx tsx src/tools/evPresetDetect.ts <EV1|EV3|EV4|EV5|all>

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
import { quadIoU } from '../ground/autoRoiPlan.js';
import { groundModelFromIntrinsics, interpolateHfov, type ZoomHfovPoint } from '../ground/cameraIntrinsics.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';

const FIX_DIR = 'test/fixtures/evPreset';
const OUT_DIR = 'reports/overlay_r22i';
const LENS_FILE = 'data/lens_calibration.json';
const CAMERA_ID = 'real-camera-1';

/**
 * 프리셋별 **장비 원시 PTZ** — `etc/camera_preset/pos_EV*.jpg` 를 직접 열어 판독한 값이다(리더 판독과 대조 일치).
 * `panPos`/`tiltPos` centidegree · `zoomPos` = zoomHfov 표 색인. 뷰어 값은 참고용으로만 싣는다.
 * **EV2 는 마스터 지시로 제외** — 이 목록에 넣지 않는다.
 */
interface PresetSpec {
  id: string;
  presetIdx: number;
  panPos: number;
  tiltPos: number;
  zoomPos: number;
  viewerPan: number;
  viewerTilt: number;
  viewerZoom: number;
  osdNote: string;
}
const PRESETS: readonly PresetSpec[] = [
  { id: 'EV1', presetIdx: 1, panPos: 7034, tiltPos: 2760, zoomPos: 8155, viewerPan: -109.6580461, viewerTilt: -12.1090909, viewerZoom: 18.4209595, osdNote: '70/27/x35' },
  { id: 'EV3', presetIdx: 3, panPos: 4877, tiltPos: 1611, zoomPos: 8998, viewerPan: -131.2286452, viewerTilt: -30.9109091, viewerZoom: 20.2218018, osdNote: '48/16/x35' },
  { id: 'EV4', presetIdx: 4, panPos: 6402, tiltPos: 1554, zoomPos: 10439, viewerPan: -115.9782216, viewerTilt: -31.8436364, viewerZoom: 23.3001099, osdNote: '64/15/x55' },
  { id: 'EV5', presetIdx: 5, panPos: 3844, tiltPos: 1188, zoomPos: 10711, viewerPan: -141.5589322, viewerTilt: -37.8327273, viewerZoom: 23.8811646, osdNote: '38/11/x55' },
];

const which = process.argv[2] ?? 'all';
const targets = which === 'all' ? PRESETS : PRESETS.filter((p) => p.id === which);
if (!targets.length) {
  console.error(`사용: npx tsx src/tools/evPresetDetect.ts <EV1|EV3|EV4|EV5|all>  (EV2 는 마스터 지시로 제외)`);
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

// ── 정답(채점 전용) ────────────────────────────────────────────────────────────
type Pt = { x: number; y: number };
interface TruthCorner {
  status: 'observed' | 'uncertain' | 'offscreen' | 'occluded';
  pt: Pt | null;
}
interface TruthBay {
  id: string;
  occupied: boolean;
  occluded: boolean;
  clipped: boolean;
  uncertain: boolean;
  corners: Record<string, TruthCorner>;
  cornerOrder: string[];
  note?: string;
}
interface TruthLine {
  id: string;
  kind: 'near' | 'far' | 'sep';
  a: Pt;
  b: Pt;
  uncertain?: boolean;
}
interface TruthPreset {
  preset: string;
  imageWidth: number;
  imageHeight: number;
  osdPtz: string;
  lines: TruthLine[];
  bays: TruthBay[];
}
const truthDoc = JSON.parse(readFileSync(join(FIX_DIR, 'truth.json'), 'utf8')) as { presets: TruthPreset[] };

/** 렌즈 실측표(읽기 전용). */
const lens = JSON.parse(readFileSync(LENS_FILE, 'utf8')) as {
  cameras: Array<{ id: string; zoomHfov?: ZoomHfovPoint[]; cameraSpec?: { heightM?: number } }>;
};
const cam = lens.cameras.find((c) => c.id === CAMERA_ID);
const ZOOM_HFOV: readonly ZoomHfovPoint[] = cam?.zoomHfov ?? [];
const HEIGHT_M = cam?.cameraSpec?.heightM ?? 0;
if (!ZOOM_HFOV.length || !(HEIGHT_M > 0)) {
  console.error(`${LENS_FILE} 의 ${CAMERA_ID} 에 zoomHfov 또는 cameraSpec.heightM 이 없다 — 추정하지 않고 종료한다`);
  process.exit(3);
}
const Z_MIN = Math.min(...ZOOM_HFOV.map((p) => p.z));
const Z_MAX = Math.max(...ZOOM_HFOV.map((p) => p.z));

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 정답 직선을 검출 직선 목록에 대응시킨다 — `evPresetNearEdge.ts` 와 **같은 잣대**(각도 3° · 최대 수직거리 10px). */
function matchDetected(a: Pt, b: Pt, lines: readonly RefinedLine[]) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.hypot(dx, dy);
  if (!(n > 0)) return null;
  const tl: [number, number, number] = [-dy / n, dx / n, (dy * a.x - dx * a.y) / n];
  const probes = [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b];
  let best: { rank: number; votes: number; contrast: number; spanPx: number; maxDistPx: number; angleDeg: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const dl = lines[i].line;
    const angleDeg = (Math.acos(Math.min(1, Math.abs(tl[0] * dl[0] + tl[1] * dl[1]))) * 180) / Math.PI;
    if (angleDeg > 3) continue;
    let maxDist = 0;
    for (const p of probes) maxDist = Math.max(maxDist, Math.abs(dl[0] * p.x + dl[1] * p.y + dl[2]));
    if (maxDist > 10) continue;
    if (!best || maxDist < best.maxDistPx) {
      best = { rank: i, votes: lines[i].votes, contrast: lines[i].contrast, spanPx: lines[i].spanPx, maxDistPx: maxDist, angleDeg };
    }
  }
  return best;
}

/** 정답 면 → 픽셀 4각형. 4점 중 하나라도 null 이면 **null**(IoU 계산 불가 = unscorable). */
function truthQuad(b: TruthBay): PixelQuad | null {
  const pts: Pt[] = [];
  for (const k of b.cornerOrder) {
    const c = b.corners[k];
    if (!c || !c.pt) return null;
    pts.push(c.pt);
  }
  if (pts.length !== 4) return null;
  return [pts[0], pts[1], pts[2], pts[3]];
}

type Cohort = 'all' | 'visible' | 'certain';
/** 면이 각 분모에 드는가. ⓐ 전부 · ⓑ 가림·화면밖 제외 · ⓒ 확실(4점 전부 observed, 플래그 전부 false). */
function inCohort(b: TruthBay, c: Cohort): boolean {
  if (c === 'all') return true;
  const st = b.cornerOrder.map((k) => b.corners[k]?.status);
  if (c === 'visible') return !st.some((s) => s === 'occluded' || s === 'offscreen') && !b.occluded && !b.clipped;
  return st.every((s) => s === 'observed') && !b.uncertain && !b.occluded && !b.clipped;
}

const IOU_HIT = 0.5; // 매칭 인정 문턱 — `autoRoiPlan.MATCH_MIN_IOU` 와 같은 값을 그대로 쓴다(새 상수 만들지 않는다).

interface ScoreOut {
  cohort: Cohort;
  truthTotal: number;
  unscorable: number;
  scorable: number;
  detected: number;
  hits: number;
  recall: number | null;
  precision: number | null;
  meanIoU: number | null;
  pairs: Array<{ bay: string; iou: number; quadIdx: number }>;
}
/** 탐욕 1:1 매칭(IoU 내림차순). 미채점 면은 분모에만 남기고 매칭에서 제외한다. */
function score(bays: readonly TruthBay[], quads: readonly PixelQuad[], cohort: Cohort): ScoreOut {
  const pool = bays.filter((b) => inCohort(b, cohort));
  const scorables = pool.map((b) => ({ b, q: truthQuad(b) })).filter((e): e is { b: TruthBay; q: PixelQuad } => e.q != null);
  const cells: Array<{ bi: number; qi: number; iou: number }> = [];
  for (let i = 0; i < scorables.length; i++) for (let j = 0; j < quads.length; j++) cells.push({ bi: i, qi: j, iou: quadIoU(scorables[i].q, quads[j]) });
  cells.sort((x, y) => y.iou - x.iou);
  const usedB = new Set<number>();
  const usedQ = new Set<number>();
  const pairs: ScoreOut['pairs'] = [];
  for (const c of cells) {
    if (c.iou <= 0 || usedB.has(c.bi) || usedQ.has(c.qi)) continue;
    usedB.add(c.bi);
    usedQ.add(c.qi);
    pairs.push({ bay: scorables[c.bi].b.id, iou: c.iou, quadIdx: c.qi });
  }
  const hitPairs = pairs.filter((p) => p.iou >= IOU_HIT);
  return {
    cohort,
    truthTotal: pool.length,
    unscorable: pool.length - scorables.length,
    scorable: scorables.length,
    detected: quads.length,
    hits: hitPairs.length,
    recall: pool.length ? hitPairs.length / pool.length : null,
    precision: quads.length ? hitPairs.length / quads.length : null,
    meanIoU: hitPairs.length ? hitPairs.reduce((s, p) => s + p.iou, 0) / hitPairs.length : null,
    pairs,
  };
}

// ── 본체 ──────────────────────────────────────────────────────────────────────
const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, cameraHeightM: HEIGHT_M, expectedBays: 1, coverageDenom: 'phaseInvariant' };
const report: Array<Record<string, unknown>> = [];

for (const P of targets) {
  const T = truthDoc.presets.find((t) => t.preset === P.id);
  if (!T) {
    console.error(`truth.json 에 ${P.id} 가 없다 — 건너뛴다`);
    continue;
  }
  const srcPng = join(FIX_DIR, `${P.id}.png`);
  const meta = await sharp(srcPng).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gb = await sharp(srcPng).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };

  // ── 지면모델: zoompos → zoomHfov 13점 **보간** → hfov → f. tilt = tiltpos/100(하향 양수). 설치고 13m.
  const hfov = interpolateHfov(ZOOM_HFOV, P.zoomPos);
  const tiltDeg = P.tiltPos / 100;
  const clamped = P.zoomPos < Z_MIN || P.zoomPos > Z_MAX;
  if (hfov == null) {
    console.error(`${P.id}: zoomHfov 보간 실패 — 추정하지 않고 건너뛴다`);
    continue;
  }
  const model = groundModelFromIntrinsics(
    {
      camIdx: 1,
      presetIdx: P.presetIdx,
      fovDeg: hfov,
      fovAxis: 'horizontal',
      tiltDeg,
      heightM: HEIGHT_M,
      imgW: W,
      imgH: H,
      source: `evPreset:${P.id}(zoomHfov@z=${P.zoomPos}→${hfov.toFixed(4)}°, tilt ${tiltDeg}°←tiltpos ${P.tiltPos}/100, 설치고 ${HEIGHT_M}m)`,
    },
    P.viewerZoom,
  );
  if (!model) {
    console.error(`${P.id}: 지면모델 생성 실패(hfov ${hfov} tilt ${tiltDeg} h ${HEIGHT_M})`);
    continue;
  }
  const gm: GroundModel = model;

  // ── ①단 도색선 검출.
  const { lines, mask, threshold } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const evidence = paintEvidenceOf(mask, W, H);
  const lineMatches = T.lines.map((L) => ({ id: L.id, kind: L.kind, uncertain: !!L.uncertain, det: matchDetected(L.a, L.b, lines) }));

  // ── ②③④단 후보별 체인. 표준 상위 N(=frontCandidates) 그대로.
  interface Probe {
    rank: number;
    front: RefinedLine;
    peaks: number;
    seps: number;
    corners: number;
    grid: GridResult | null;
    gridNoNear: GridResult | null;
    sweepSame: number[];
    sweepFlip: number[];
    /** ★ 이 후보의 격자가 **정답 위에 있었는가** — 「어느 후보가 옳았는데 어디서 죽었나」의 직접 증거. */
    truthBestIoU: number;
    truthBestBay: string | null;
    /** `frontCandidates` 상위 N 안인가. false 면 **서비스 경로에 애초에 들어가지 않는** 진단 전용 후보다. */
    inTopN: boolean;
  }
  const probes: Probe[] = [];
  const stdCands: RowCandidate[] = [];
  const topN = Math.min(DEFAULT_PAINT_OPTIONS.frontCandidates, lines.length);
  // ★ 표준 후보(상위 N) + **정답 근변선이 상위 N 밖에서 잡힌 경우 그 순위**를 진단용으로 덧붙인다.
  //   덧붙인 순위는 `stdCands`(서비스 등가 실행)에 **넣지 않는다** — "후보 밖이라 죽었다"를 확인만 한다.
  const extraRanks = new Set<number>();
  for (const m of lineMatches) if (m.kind === 'near' && m.det && m.det.rank >= topN) extraRanks.add(m.det.rank);
  const probeRanks = [...Array.from({ length: topN }, (_, i) => i), ...[...extraRanks].sort((a, b) => a - b)];
  for (const rank of probeRanks) {
    const inTopN = rank < topN;
    const front = lines[rank];
    const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Pt[] = [];
    for (const sep of seps) {
      const q = meetLines(sep.line, front.line);
      if (q) pts.push(q);
    }
    if (inTopN) stdCands.push({ front, cornersPx: pts });
    const grid = fitRowGrid(gm, front, pts, evidence, DEFAULT_PAINT_OPTIONS, opts);
    // ★ `bayGrid.ts:402` 위상 전멸 판별 — **near 게이트만 0** 으로 낮춘 등가 실행(검출 알고리즘 무변경).
    //   grid==null && gridNoNear!=null 이면 죽은 곳은 오직 `paint.near < minNearSupport` 다.
    const gridNoNear = fitRowGrid(gm, front, pts, evidence, DEFAULT_PAINT_OPTIONS, { ...opts, minNearSupport: 0 });
    // 위상 스윕 — "위상을 재사용해서 진 것 아니냐"를 배제한다(한 칸 주기 8등분 · 깊이 양방향).
    const base = grid ?? gridNoNear;
    const sweepSame = base ? Array.from({ length: 8 }, (_, j) => auditNear(base, false, (opts.slotWidthM * j) / 8, gm).near) : [];
    const sweepFlip = base ? Array.from({ length: 8 }, (_, j) => auditNear(base, true, (opts.slotWidthM * j) / 8, gm).near) : [];
    // 이 후보 격자와 정답 면의 최대 IoU — 문턱 탈락이 「옳은 격자를 버린 것」인지 「엉뚱한 격자를 막은 것」인지 가른다.
    const candQuads: PixelQuad[] = ((grid ?? gridNoNear)?.quads ?? []).map((q) => q.quad);
    let truthBestIoU = 0;
    let truthBestBay: string | null = null;
    for (const b of T.bays) {
      const tq = truthQuad(b);
      if (!tq) continue;
      for (const cq of candQuads) {
        const v = quadIoU(tq, cq);
        if (v > truthBestIoU) {
          truthBestIoU = v;
          truthBestBay = b.id;
        }
      }
    }
    probes.push({ rank, front, peaks: peaks.length, seps: seps.length, corners: pts.length, grid, gridNoNear, sweepSame, sweepFlip, truthBestIoU, truthBestBay, inTopN });

    // 후보별 오버레이 — 「어느 후보가 어디에 격자를 세웠나」를 눈으로 확인한다(스샷 실측 규약).
    const cp: string[] = [];
    for (const b of T.bays) {
      const tq = truthQuad(b);
      if (tq) cp.push(`<polygon points="${tq.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="#00e67618" stroke="#00e676" stroke-width="4"/>`);
    }
    for (const cq of candQuads) cp.push(`<polygon points="${cq.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="#ff174422" stroke="#ff1744" stroke-width="4" stroke-dasharray="14,8"/>`);
    cp.push(
      `<line x1="${front.endA.x.toFixed(1)}" y1="${front.endA.y.toFixed(1)}" x2="${front.endB.x.toFixed(1)}" y2="${front.endB.y.toFixed(1)}" stroke="#ffea00" stroke-width="6"/>`,
    );
    cp.push(`<rect x="12" y="12" width="${W - 24}" height="90" fill="#000000dd" rx="8"/>`);
    cp.push(
      `<text x="28" y="48" fill="#fff" font-size="24" font-family="monospace">${esc(`${P.id} 후보 #${rank}(v${front.votes}) — 격자 ${candQuads.length}칸 · score ${grid?.paint.score.toFixed(5) ?? '--'} · near ${(grid ?? gridNoNear)?.paint.near.toFixed(5) ?? '--'}${grid ? '' : ' (기본 게이트에서 null)'}`)}</text>`,
    );
    cp.push(
      `<text x="28" y="84" fill="#fff" font-size="24" font-family="monospace">${esc(`정답 최대 IoU ${truthBestIoU}${truthBestBay ? ` (${truthBestBay})` : ''} · 노랑=근변선 지지구간 · 빨강점선=이 후보 격자 · 초록=정답`)}</text>`,
    );
    await sharp(srcPng)
      .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${cp.join('')}</svg>`), top: 0, left: 0 }])
      .png()
      .toFile(join(OUT_DIR, `cand_${P.id}_ci${String(rank).padStart(2, '0')}.png`));
  }

  /** 채택 격자를 같은 격자인덱스·주어진 위상/깊이방향으로 다시 세워 도색지지를 잰다(emptyBayProbe 와 같은 규약). */
  function auditNear(g: GridResult, flip: boolean, phaseShift: number, m: GroundModel): PaintSupport {
    const fr: RowFrame = flip ? { origin: g.frame.origin, u: g.frame.u, v: [-g.frame.v[0], -g.frame.v[1], -g.frame.v[2]] } : g.frame;
    const phase = g.phaseM + phaseShift;
    const at = (a: number, b: number) =>
      projectToPixel([fr.origin[0] + fr.u[0] * a + fr.v[0] * b, fr.origin[1] + fr.u[1] * a + fr.v[1] * b, fr.origin[2] + fr.u[2] * a + fr.v[2] * b], m);
    const quads: BayQuad[] = [];
    for (const q of g.quads) {
      const k = q.latticeIndex;
      const n0 = at(phase + k * opts.slotWidthM, 0);
      const n1 = at(phase + (k + 1) * opts.slotWidthM, 0);
      const f0 = at(phase + k * opts.slotWidthM, opts.slotDepthM);
      const f1 = at(phase + (k + 1) * opts.slotWidthM, opts.slotDepthM);
      if (!n0 || !n1 || !f0 || !f1) continue;
      const cq = canonicalizeQuad([n0, f0, f1, n1]);
      if (cq) quads.push({ latticeIndex: k, quad: cq });
    }
    return quadPaintSupport(quads, evidence, DEFAULT_PAINT_OPTIONS, opts);
  }

  // ── ⑤단 `rows` 진입 문턱 + 서비스 등가 실행.
  const detection = detectBaysWithModel(stdCands, gm, evidence, DEFAULT_PAINT_OPTIONS, opts, frame);
  let refScore = 0;
  let refBase = -Infinity;
  let refRank = -1;
  for (const p of probes) {
    if (!p.grid || !p.inTopN) continue;
    const b = p.grid.baseScore ?? p.grid.paint.score;
    if (b > refBase + 1e-12) {
      refBase = b;
      refScore = p.grid.paint.score;
      refRank = p.rank;
    }
  }
  // ★ 반사실 — **진입 문턱만 0** 으로 낮춘 등가 실행(검출 알고리즘 무변경). 문턱이 무엇을 버렸는지의 상한.
  const noGate = detectBaysWithModel(stdCands, gm, evidence, DEFAULT_PAINT_OPTIONS, { ...opts, rowMinScoreRatio: 0, rowMinNearSupport: 0 }, frame);
  const noGateQuads: PixelQuad[] = [];
  for (const r of noGate.rows) for (const q of r.quads) noGateQuads.push(q.quad);

  const rowQuads: PixelQuad[] = [];
  for (const r of detection.rows) for (const q of r.quads) rowQuads.push(q.quad);
  const bestQuads: PixelQuad[] = (detection.best?.quads ?? []).map((q) => q.quad);

  // ── 채점(rows 합집합 = 서비스가 사람에게 보여 주는 목록).
  const scores = (['all', 'visible', 'certain'] as Cohort[]).map((c) => score(T.bays, rowQuads, c));
  const scoresBest = (['all', 'visible', 'certain'] as Cohort[]).map((c) => score(T.bays, bestQuads, c));
  const scoresNoGate = (['all', 'visible', 'certain'] as Cohort[]).map((c) => score(T.bays, noGateQuads, c));
  const unscorableIds = T.bays.filter((b) => truthQuad(b) == null).map((b) => b.id);

  // ── 오버레이 ────────────────────────────────────────────────────────────────
  const parts: string[] = [];
  const poly = (q: readonly Pt[], stroke: string, fill: string, w: number, dash = '') =>
    `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const txt = (x: number, y: number, fill: string, size: number, s: string) =>
    `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${fill}" font-size="${size}" font-family="monospace">${esc(s)}</text>`;
  for (const b of T.bays) {
    const q = truthQuad(b);
    if (q) {
      parts.push(poly(q, '#00e676', '#00e67618', 4));
      parts.push(txt(q[0].x + 6, q[0].y - 8, '#00e676', 22, b.id));
    } else {
      // 미채점 면(4점 중 null 존재) — 있는 점만 회색 점선으로 잇고 「미채점」임을 밝힌다.
      const known = b.cornerOrder.map((k) => b.corners[k]?.pt).filter((p): p is Pt => !!p);
      if (known.length >= 2) {
        parts.push(
          `<polyline points="${known.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#9e9e9e" stroke-width="4" stroke-dasharray="14,10"/>`,
        );
        parts.push(txt(known[0].x + 6, known[0].y - 8, '#9e9e9e', 22, `${b.id} 미채점`));
      }
    }
  }
  for (const q of rowQuads) parts.push(poly(q, '#00e5ff', '#00e5ff22', 4));
  // 근변선 후보(상위 N)를 옅게 — 「어디까지 살아 있었나」를 그림으로 남긴다.
  for (const p of probes) {
    const sp = imageSpanOf(p.front.line, W, H);
    if (sp)
      parts.push(
        `<line x1="${(sp.px0 + sp.dx * sp.tmin).toFixed(1)}" y1="${(sp.py0 + sp.dy * sp.tmin).toFixed(1)}" x2="${(sp.px0 + sp.dx * sp.tmax).toFixed(1)}" y2="${(sp.py0 + sp.dy * sp.tmax).toFixed(1)}" stroke="#ffea00" stroke-width="1.5" opacity="0.35"/>`,
      );
    parts.push(
      `<line x1="${p.front.endA.x.toFixed(1)}" y1="${p.front.endA.y.toFixed(1)}" x2="${p.front.endB.x.toFixed(1)}" y2="${p.front.endB.y.toFixed(1)}" stroke="#ffea00" stroke-width="4" opacity="0.85"/>`,
    );
  }
  const sAll = scores[0];
  const head = [
    `${P.id}  zoompos ${P.zoomPos}${clamped ? '(표 범위 밖 — 화각 클램프)' : '(표 안 보간)'}  hfov ${hfov.toFixed(4)}°  f ${gm.f.toFixed(2)}px  tilt ${tiltDeg.toFixed(2)}°(tiltpos ${P.tiltPos}/100)  설치고 ${HEIGHT_M}m  ${W}×${H}`,
    `검출 quad ${rowQuads.length}(rows ${detection.rows.length}행 · best ${bestQuads.length}) · 정답 면 ${T.bays.length}(미채점 ${unscorableIds.length})`,
    `재현율 ⓐ전부 ${sAll.recall == null ? '--' : sAll.recall.toFixed(5)} (${sAll.hits}/${sAll.truthTotal}) · ⓑ가림제외 ${scores[1].hits}/${scores[1].truthTotal} · ⓒ확실만 ${scores[2].hits}/${scores[2].truthTotal}`,
    `초록=정답 · 시안=검출 · 회색점선=미채점(가림 좌표 null) · 노랑=근변선 후보 상위 ${topN}`,
  ];
  parts.push(`<rect x="12" y="12" width="${W - 24}" height="${18 + 34 * head.length}" fill="#000000dd" rx="8"/>`);
  head.forEach((t, i) => parts.push(txt(28, 48 + 34 * i, '#ffffff', 24, t)));

  const outPng = join(OUT_DIR, `detect_${P.id}.png`);
  await sharp(srcPng)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(outPng);

  // ── 콘솔 표 ─────────────────────────────────────────────────────────────────
  console.log(`\n=== ${P.id} · ${W}×${H} · OSD ${P.osdNote} · 장비원시 P${P.panPos}/T${P.tiltPos}/Z${P.zoomPos}`);
  console.log(
    `  제원: zoompos ${P.zoomPos} → hfov ${hfov.toFixed(6)}° (${clamped ? '표밖 클램프' : '표안 보간'}) → **f ${gm.f}px** · tilt ${tiltDeg}° · 설치고 ${HEIGHT_M}m · 마스크임계 ${threshold.toFixed(3)}`,
  );
  console.log(`  ①단 검출 직선 ${lines.length}개 (frontCandidates=${DEFAULT_PAINT_OPTIONS.frontCandidates})`);
  console.log('   정답선 대응:  id(kind)          rank  votes  contrast  dist(px)  angle  상위N');
  for (const m of lineMatches) {
    const d = m.det;
    console.log(
      `     ${`${m.id}(${m.kind})`.padEnd(18)}${(d ? `#${d.rank}` : '대응없음').padStart(6)}  ${(d ? String(d.votes) : '--').padStart(5)}  ${(d ? d.contrast.toFixed(1) : '--').padStart(8)}  ${(d ? d.maxDistPx.toFixed(2) : '--').padStart(8)}  ${(d ? d.angleDeg.toFixed(2) : '--').padStart(5)}  ${d && d.rank < DEFAULT_PAINT_OPTIONS.frontCandidates ? '★' : ''}`,
    );
  }
  console.log(`  ②③④단 후보별 (refScore ${refScore.toFixed(5)}←#${refRank} · 문턱 score ≥ ${(refScore * opts.rowMinScoreRatio).toFixed(5)} · rows near ≥ ${opts.rowMinNearSupport})`);
  console.log('   rank  votes  peaks  seps  corners | 기본 quad  score     near    | near게이트0 quad  near     | 위상8스윕 near(채택/반대)   정답최대IoU   죽는 단계');
  for (const p of probes) {
    const g = p.grid;
    const gn = p.gridNoNear;
    const pass1 = g ? g.paint.score >= refScore * opts.rowMinScoreRatio : false;
    const pass2 = g ? g.paint.near >= opts.rowMinNearSupport : false;
    const stage = !p.inTopN
      ? `② 상위 ${topN} 밖 — 서비스 경로 미진입(진단 전용)`
      : !p.seps
      ? '③ 분리선 0'
      : !g && !gn
        ? '④ 격자 산출 실패'
        : !g
          ? '④ 위상 전멸(near<0.5 · bayGrid.ts:402)'
          : pass1 && pass2
            ? '통과'
            : pass1
              ? '⑤ rows near 탈락'
              : pass2
                ? '⑤ rows 비율 탈락'
                : '⑤ rows 둘다 탈락';
    const rng = (a: number[]) => (a.length ? `${Math.min(...a).toFixed(3)}~${Math.max(...a).toFixed(3)}` : '--');
    console.log(
      `   ${String(p.rank).padStart(4)}  ${String(p.front.votes).padStart(5)}  ${String(p.peaks).padStart(5)}  ${String(p.seps).padStart(4)}  ${String(p.corners).padStart(7)} | ` +
        `${String(g?.quads.length ?? 0).padStart(9)}  ${(g?.paint.score.toFixed(5) ?? '--').padStart(8)}  ${(g?.paint.near.toFixed(5) ?? '--').padStart(7)} | ` +
        `${String(gn?.quads.length ?? 0).padStart(15)}  ${(gn?.paint.near.toFixed(5) ?? '--').padStart(7)} | ` +
        `${rng(p.sweepSame).padStart(13)} / ${rng(p.sweepFlip).padStart(13)}  ${p.truthBestIoU.toFixed(5).padStart(9)}${p.truthBestBay ? `(${p.truthBestBay})` : ''}  ${stage}`,
    );
  }
  console.log(`  ⑤단 rows ${detection.rows.length}행 · quad 합계 ${rowQuads.length} · best quad ${bestQuads.length}`);
  for (const s of detection.issues) console.log(`     issue: ${s}`);
  const calib = detection.best?.calibration ?? null;
  console.log(
    `  지상고 자가보정: ${calib ? `${calib.nominalM}m → ${calib.correctedM}m (관측 칸간격 ${calib.measuredWidthM}m, 계수 ${calib.factor}, 표본 ${calib.samples})` : `미적용(승자 없음 또는 보정 실패) — 보정 전 ${HEIGHT_M}m 그대로`}`,
  );
  console.log(`  채점(rows 합집합) — 미채점 면 ${unscorableIds.length}개: ${unscorableIds.join(', ') || '없음'}`);
  for (const s of scores) {
    console.log(
      `     ${s.cohort.padEnd(8)} 정답 ${String(s.truthTotal).padStart(2)} (채점가능 ${s.scorable} / 미채점 ${s.unscorable}) · 검출 ${s.detected} · IoU≥${IOU_HIT} 적중 ${s.hits} · ` +
        `재현율 ${s.recall == null ? '--' : s.recall} · 정밀도 ${s.precision == null ? '--' : s.precision} · 평균IoU ${s.meanIoU == null ? '--' : s.meanIoU}`,
    );
    for (const pr of s.pairs) console.log(`        ${pr.bay} ↔ quad#${pr.quadIdx}  IoU ${pr.iou}`);
  }
  console.log(`  ★ 반사실(rows 진입 문턱 0) — rows ${noGate.rows.length}행 · quad ${noGateQuads.length}`);
  for (const s of scoresNoGate) {
    console.log(
      `     ${s.cohort.padEnd(8)} 정답 ${String(s.truthTotal).padStart(2)} · 검출 ${s.detected} · IoU≥${IOU_HIT} 적중 ${s.hits} · 재현율 ${s.recall == null ? '--' : s.recall} · 정밀도 ${s.precision == null ? '--' : s.precision} · 평균IoU ${s.meanIoU == null ? '--' : s.meanIoU}`,
    );
    for (const pr of s.pairs.filter((x) => x.iou >= IOU_HIT)) console.log(`        ${pr.bay} ↔ quad#${pr.quadIdx}  IoU ${pr.iou}`);
  }
  console.log(`  오버레이: ${outPng}`);

  report.push({
    preset: P.id,
    imgW: W,
    imgH: H,
    panPos: P.panPos,
    tiltPos: P.tiltPos,
    zoomPos: P.zoomPos,
    zoomTableClamped: clamped,
    hfovDeg: hfov,
    tiltDeg,
    heightM: HEIGHT_M,
    focalPx: gm.f,
    maskThreshold: threshold,
    lines: lines.length,
    lineMatches,
    refScore,
    refRank,
    gates: { rowMinScoreRatio: opts.rowMinScoreRatio, rowMinNearSupport: opts.rowMinNearSupport, minNearSupport: DEFAULT_BAY_OPTS.minNearSupport },
    probes: probes.map((p) => ({
      rank: p.rank,
      votes: p.front.votes,
      spanPx: p.front.spanPx,
      contrast: p.front.contrast,
      peaks: p.peaks,
      seps: p.seps,
      corners: p.corners,
      grid: p.grid ? { quads: p.grid.quads.length, score: p.grid.paint.score, near: p.grid.paint.near, far: p.grid.paint.far, side: p.grid.paint.side, depthM: p.grid.medianDepthM } : null,
      gridNoNear: p.gridNoNear ? { quads: p.gridNoNear.quads.length, score: p.gridNoNear.paint.score, near: p.gridNoNear.paint.near } : null,
      sweepSameNear: p.sweepSame,
      sweepFlipNear: p.sweepFlip,
      truthBestIoU: p.truthBestIoU,
      truthBestBay: p.truthBestBay,
    })),
    rows: detection.rows.map((r) => ({ quads: r.quads.length, score: r.paint.score, near: r.paint.near, depthM: r.medianDepthM })),
    bestQuads: bestQuads.length,
    heightCalibration: detection.best?.calibration ?? null,
    issues: detection.issues,
    unscorableIds,
    scoresRows: scores,
    scoresBest,
    noGate: { rows: noGate.rows.length, quads: noGateQuads.length, scores: scoresNoGate },
  });
}

writeFileSync(join(OUT_DIR, 'detect.json'), `${JSON.stringify({ note: 'EV2 는 마스터 지시로 제외', heightM: HEIGHT_M, zoomHfovFrom: `${LENS_FILE}#${CAMERA_ID}`, presets: report }, null, 2)}\n`, 'utf8');
console.log(`\n산출: ${OUT_DIR}/detect_*.png · ${OUT_DIR}/detect.json`);
