// ★ 26회차 26-3 신규 — **후보 진입 컷 계측**: `detectPaintLines` 가 낸 직선 전수의 **정렬 키 분포**와
//   **정답 행 근변선의 순위**를 시뮬 골든 5프레임에서 뽑는다.
//
// 25회차가 남긴 표적(§9-2): 「1:1 은 60개 직선 중 8개만 채점되는데 그 8개에 전경 열 근변선이 없다」.
// 그러나 25회차는 **전경 근변선이 60개 안에 있기는 한지**를 재지 않았다. 이 도구가 그것부터 잰다.
//   ─ 진짜 근변선이 60개 안에 **없다** → 병목은 진입 컷이 아니라 검출(①단)이다. `frontCandidates` 를 올려도 소용없다.
//   ─ 있는데 순위가 낮다 → **왜 낮은가**(votes 가 무엇에 비례하나)를 같은 표에서 가른다.
//
// 신규 파일 사유(「재발명 금지」에 대한 답):
//   `evPresetDetect.ts` 는 **실카 EV 프리셋 + 손라벨 truth.json** 전용이고 시뮬 씬 정답을 읽지 않는다.
//   `emptyBayProbe.ts` 는 **라이브/단일 프레임 + 손으로 준 ROI 사각형** 기준이라 정답 행이 인자다.
//   `roiAutoRecall.ts` 는 면 단위 채점기라 **직선 단위 양(votes·chord·span)을 하나도 내지 않는다.**
//   `gridDiag.ts` 는 **행 후보(이미 컷을 통과한 8개)** 단위다 — 컷 **밖**을 볼 수 없다.
//   이번 관측량은 「검출 직선 60개 × 정렬 키」이고 그 축을 가진 도구가 없다.
//
// ★ 카메라 물리 이동 0 — 디스크의 골든 JPEG 만 읽는다(캡처 클라이언트 import 없음).
// ★ 정본·DB 쓰기 0 — 쓰기는 `reports/` 하위만. 정본 적용 RPC 를 호출하지 않는다(테스트가 소스 문자열로 봉인).
// ★ 검출 알고리즘 무변경 — `src/ground/*` 는 읽기만 한다. 대체 정렬 키는 **이 도구 안에서만** 재정렬해
//   서비스 등가 실행을 돌린다(서비스 소스를 고치지 않고 효과를 잰다).
//
// 사용: npx tsx src/tools/frontCut.ts [key] [topN] [outDir] [tag] [sweep]
//   key   votes(기본·현행) | fill | span | fillspan | contrast   — 후보 진입 정렬 키
//   topN  기본 8 (= DEFAULT_PAINT_OPTIONS.frontCandidates)
//   tag   출력 파일명 접두(기본 r26c_<key><topN>)
//   sweep "votes:9,votes:10,fill:6" — 추가로 채점만 하는 조합 목록(오버레이·덤프 없음).
//         후보 체인(`scanSeparators`/`refineSeparators`)은 직선 순위별로 **한 번만** 계산해 재사용한다.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { DEFAULT_BAY_OPTS, quadPaintSupport, type BayDetectOpts } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, visibleTruth, quadAreaPx, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { scoreDetection, sumScores, type DetectionScore, type TruthEntry } from '../ground/roiAutoRecall.js';
import { MATCH_MIN_IOU } from '../ground/autoRoiPlan.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import { backprojectToGround } from '../ground/project.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';

/** `roiAutoRecall.ts` 와 **같은 상수**를 쓴다(정답 구성이 어긋나면 순위 비교가 무의미하다). */
const PLANE_Y_M = 0.05;
const MIN_AREA_PX = 200;
const SPEC_CACHE = '_workspace/18_scene_spec.json';
const CACHE_DIR = 'test/fixtures/roiAutoGolden';

type SortKey = 'votes' | 'fill' | 'span' | 'fillspan' | 'contrast';
const KEYS: SortKey[] = ['votes', 'fill', 'span', 'fillspan', 'contrast'];
const key = (process.argv[2] ?? 'votes') as SortKey;
if (!KEYS.includes(key)) throw new Error(`key: ${KEYS.join(' | ')} (받은 값 ${key})`);
const topN = process.argv[3] != null && process.argv[3] !== '' && process.argv[3] !== '-' ? Number(process.argv[3]) : DEFAULT_PAINT_OPTIONS.frontCandidates;
if (!Number.isInteger(topN) || topN < 1) throw new Error(`topN 은 1 이상 정수(받은 값 ${process.argv[3]})`);
const outDir = process.argv[4] ?? 'reports/overlay_r26c';
const tag = process.argv[5] ?? `r26c_${key}${topN}`;
const sweepArg = process.argv[6] ?? '';
const sweep: Array<{ key: SortKey; topN: number }> = sweepArg
  ? sweepArg.split(',').map((s) => {
      const [k, n] = s.split(':');
      if (!KEYS.includes(k as SortKey) || !Number.isInteger(Number(n)) || Number(n) < 1) throw new Error(`sweep 항목 형식 <key>:<topN> (받은 값 ${s})`);
      return { key: k as SortKey, topN: Number(n) };
    })
  : [];
mkdirSync(outDir, { recursive: true });

if (!existsSync(SPEC_CACHE)) throw new Error(`씬 제원 캐시 부재: ${SPEC_CACHE} — Unity 조회는 이 도구가 하지 않는다`);
const specs = JSON.parse(readFileSync(SPEC_CACHE, 'utf8')) as ScenePresetSpec[];
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);

/** 직선 1개의 계측량 — 정렬 키 후보를 **전부** 같이 낸다. */
interface LineRec {
  /** 현행(votes) 정렬에서의 순위. */
  rank0: number;
  votes: number;
  /** 직선이 이미지 안을 지나는 전체 현 길이(px). votes 는 이 구간에서 누적된다. */
  chordPx: number;
  /** 정련 표본이 실제로 덮은 구간 길이(px) = 도색 지지 구간. */
  spanPx: number;
  /** votes / chordPx — 「현 길이당 도색 누적」. 길이 편향을 뺀 값. */
  fill: number;
  /** votes / spanPx — 지지 구간당 누적. */
  fillSpan: number;
  contrast: number;
  widthPx: number;
  hit: number;
  residPx: number;
  thetaDeg: number;
  /** 지지 구간 중점의 지상 깊이(m). 역투영 실패 → null. */
  depthM: number | null;
  /** 이 직선이 정답 행의 근변선인가 — `r<rowIdx>` 목록. */
  truthNearOf: number[];
}

function keyOf(l: LineRec, k: SortKey): number {
  return k === 'votes' ? l.votes : k === 'fill' ? l.fill : k === 'span' ? l.spanPx : k === 'fillspan' ? l.fillSpan : l.contrast;
}

/** 정답 근변선 ↔ 검출 직선 대응 — `evPresetDetect.matchDetected` 와 **같은 잣대**(각도 3° · 최대 수직거리 10px). */
function matchDetected(a: { x: number; y: number }, b: { x: number; y: number }, lines: readonly RefinedLine[]): { idx: number; maxDistPx: number; angleDeg: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.hypot(dx, dy);
  if (!(n > 0)) return null;
  const probes = [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b];
  const tl: [number, number] = [-dy / n, dx / n];
  let best: { idx: number; maxDistPx: number; angleDeg: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const dl = lines[i].line;
    const angleDeg = (Math.acos(Math.min(1, Math.abs(tl[0] * dl[0] + tl[1] * dl[1]))) * 180) / Math.PI;
    if (angleDeg > 3) continue;
    let maxDist = 0;
    for (const p of probes) maxDist = Math.max(maxDist, Math.abs(dl[0] * p.x + dl[1] * p.y + dl[2]));
    if (maxDist > 10) continue;
    if (!best || maxDist < best.maxDistPx) best = { idx: i, maxDistPx: maxDist, angleDeg };
  }
  return best;
}

function depthAt(p: { x: number; y: number }, model: GroundModel): number | null {
  const X = backprojectToGround(p, model);
  return X ? Math.hypot(X[0], X[1], X[2]) : null;
}

/** 정답 행 1건 — 행의 근변선 양 끝(가시 면들의 근변 끝점 중 행 방향 극단 2점). */
interface TruthRowRec {
  rowIdx: number;
  visibleFaces: number;
  /** 가시 면 중심 깊이 median(m). */
  medianDepthM: number | null;
  meanAreaPx: number;
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** 근변 도색 지지(면 평균) — `detectable` 판정과 같은 식. */
  nearSupport: number;
  /** 대응된 검출 직선(현행 votes 순위 기준 인덱스). */
  matchRank0: number | null;
  matchDistPx: number | null;
  matchAngleDeg: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((p, q) => p - q);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

interface FrameRec {
  key: string;
  frameHash: string;
  imgW: number;
  imgH: number;
  lines: LineRec[];
  truthRows: TruthRowRec[];
  /** 이번 정렬 키·topN 으로 진입한 직선의 현행 순위 목록. */
  admittedRank0: number[];
  score: DetectionScore;
}

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

const frames: FrameRec[] = [];
const scores: DetectionScore[] = [];
const sweepScores = new Map<string, DetectionScore[]>();

for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    const fkey = `${c.camera.cam_id}:${p.preset_idx}`;
    const manual = (byPreset.get(fkey) ?? []).filter((s: { points?: unknown[] }) => Array.isArray(s.points) && s.points.length === 4);
    const baseIntr = intrinsics.get(c.camera.cam_id, p.preset_idx);
    if (!baseIntr) continue;
    const jpgPath = join(CACHE_DIR, `frame_${c.camera.cam_id}_${p.preset_idx}_d0.jpg`);
    if (!existsSync(jpgPath)) continue;
    const jpg = readFileSync(jpgPath);
    const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
    const meta = await sharp(jpg).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const gb = await sharp(jpg).greyscale().raw().toBuffer();
    const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
    const model = groundModelFromIntrinsics(baseIntr, p.zoom);
    if (!model) continue;
    const gm: GroundModel = model;

    // ── 정답(씬 진값) — `roiAutoRecall.ts` 와 같은 규칙.
    const proj = projectTruth(faces, {
      camPos: c.camera.position,
      panDeg: p.pan,
      tiltDeg: p.tilt,
      fovDeg: p.fov,
      fovAxis: 'vertical',
      imgW: W,
      imgH: H,
      planeYM: PLANE_Y_M,
    });
    const vis = visibleTruth(proj, W, H, MIN_AREA_PX);

    // ── ①단 검출(무변경).
    const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
    const ev = paintEvidenceOf(mask, W, H);
    const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, manual.length) };

    const recs: LineRec[] = lines.map((l, i) => {
      const sp = imageSpanOf(l.line, W, H);
      const chordPx = sp ? sp.tmax - sp.tmin : 0;
      const mid = { x: (l.endA.x + l.endB.x) / 2, y: (l.endA.y + l.endB.y) / 2 };
      return {
        rank0: i,
        votes: l.votes,
        chordPx,
        spanPx: l.spanPx,
        fill: chordPx > 0 ? l.votes / chordPx : 0,
        fillSpan: l.spanPx > 0 ? l.votes / l.spanPx : 0,
        contrast: l.contrast,
        widthPx: l.widthPx,
        hit: l.hit,
        residPx: l.residPx,
        thetaDeg: (Math.atan2(l.line[1], l.line[0]) * 180) / Math.PI,
        depthM: depthAt(mid, gm),
        truthNearOf: [],
      };
    });

    // ── 정답 행별 근변선. `canonicalizeQuad` 규약(p0=근좌, p3=근우)이라 근변 = quad[0]→quad[3].
    const byRow = new Map<number, Array<{ quad: PixelQuad }>>();
    for (const t of vis) {
      const arr = byRow.get(t.face.rowIdx) ?? [];
      arr.push({ quad: t.quad });
      byRow.set(t.face.rowIdx, arr);
    }
    const truthRows: TruthRowRec[] = [];
    for (const [rowIdx, arr] of [...byRow.entries()].sort((x, y) => x[0] - y[0])) {
      // 행 근변선 = 모든 면의 근변 끝점 전체에서 **행 방향 극단 2점**.
      const pts = arr.flatMap((e) => [e.quad[0], e.quad[3]]);
      let a = pts[0];
      let b = pts[0];
      let bestD = -1;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          if (d > bestD) {
            bestD = d;
            a = pts[i];
            b = pts[j];
          }
        }
      }
      const m = matchDetected(a, b, lines);
      if (m) recs[m.idx].truthNearOf.push(rowIdx);
      const depths = arr
        .map((e) => depthAt({ x: (e.quad[0].x + e.quad[1].x + e.quad[2].x + e.quad[3].x) / 4, y: (e.quad[0].y + e.quad[1].y + e.quad[2].y + e.quad[3].y) / 4 }, gm))
        .filter((v): v is number => v != null);
      truthRows.push({
        rowIdx,
        visibleFaces: arr.length,
        medianDepthM: median(depths),
        meanAreaPx: arr.reduce((s, e) => s + quadAreaPx(e.quad), 0) / arr.length,
        a,
        b,
        nearSupport: quadPaintSupport(arr.map((e, i) => ({ latticeIndex: i, quad: e.quad })), ev, DEFAULT_PAINT_OPTIONS, opts).near,
        matchRank0: m ? m.idx : null,
        matchDistPx: m ? m.maxDistPx : null,
        matchAngleDeg: m ? m.angleDeg : null,
      });
    }

    // ── ②③④단 서비스 등가 실행. **이 도구 안에서만** 정렬 키를 바꿔 상위 topN 을 고른다.
    //   후보 체인은 직선 순위별로 한 번만 만들어 스윕 전체가 재사용한다(같은 입력 → 같은 산출).
    const candCache = new Map<number, RowCandidate>();
    const candOf = (rank0: number): RowCandidate => {
      const hit = candCache.get(rank0);
      if (hit) return hit;
      const front = lines[rank0];
      const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
      const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
      const pts: Array<{ x: number; y: number }> = [];
      for (const sep of seps) {
        const q = meetLines(sep.line, front.line);
        if (q) pts.push(q);
      }
      const c: RowCandidate = { front, cornersPx: pts };
      candCache.set(rank0, c);
      return c;
    };
    const truth: TruthEntry[] = vis.map((t) => ({
      face: t.face,
      quad: t.quad,
      detectable: quadPaintSupport([{ latticeIndex: 0, quad: t.quad }], ev, DEFAULT_PAINT_OPTIONS, opts).near >= opts.extendMinNearSupport,
    }));
    const runSpec = (k: SortKey, n: number): { admittedRank0: number[]; detQuads: PixelQuad[]; sc: DetectionScore } => {
      const ord = [...recs].sort((x, y) => keyOf(y, k) - keyOf(x, k) || x.rank0 - y.rank0).slice(0, n);
      const g = detectBaysWithModel(ord.map((r) => candOf(r.rank0)), gm, ev, DEFAULT_PAINT_OPTIONS, opts, frame);
      const q: PixelQuad[] = g.rows.flatMap((r) => r.quads.map((c) => c.quad));
      return { admittedRank0: ord.map((r) => r.rank0), detQuads: q, sc: scoreDetection(q, truth, MATCH_MIN_IOU) };
    };
    const primary = runSpec(key, topN);
    const admitted = primary.admittedRank0;
    const detQuads = primary.detQuads;
    const sc = primary.sc;
    scores.push(sc);
    for (const s of sweep) {
      const id = `${s.key}:${s.topN}`;
      const arr = sweepScores.get(id) ?? [];
      arr.push(runSpec(s.key, s.topN).sc);
      sweepScores.set(id, arr);
    }

    frames.push({ key: fkey, frameHash, imgW: W, imgH: H, lines: recs, truthRows, admittedRank0: admitted, score: sc });

    // ── 오버레이: 정답 quad(노랑) + 산출 quad(초록) + 정답 행 근변선(자홍). 「전경 열에 면이 생겼나」를 눈으로.
    const parts: string[] = [];
    for (const t of vis) {
      parts.push(`<polygon points="${t.quad.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#ffea00" stroke-width="2" stroke-dasharray="8 6"/>`);
    }
    for (const q of detQuads) {
      parts.push(`<polygon points="${q.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' ')}" fill="#00e6761f" stroke="#00e676" stroke-width="3"/>`);
    }
    for (const r of truthRows) {
      const col = r.matchRank0 == null ? '#ff1744' : '#e040fb';
      parts.push(`<line x1="${r.a.x.toFixed(1)}" y1="${r.a.y.toFixed(1)}" x2="${r.b.x.toFixed(1)}" y2="${r.b.y.toFixed(1)}" stroke="${col}" stroke-width="5"/>`);
      parts.push(
        `<text x="${((r.a.x + r.b.x) / 2).toFixed(0)}" y="${((r.a.y + r.b.y) / 2 - 12).toFixed(0)}" fill="${col}" font-size="26" text-anchor="middle">r${r.rowIdx} ${r.medianDepthM?.toFixed(1) ?? '--'}m rank ${r.matchRank0 ?? '대응없음'}</text>`,
      );
    }
    parts.push('<rect x="10" y="10" width="1560" height="176" fill="#000000cc" rx="8"/>');
    const T = (y: number, s: number, fill: string, t: string) => `<text x="26" y="${y}" fill="${fill}" font-size="${s}">${t}</text>`;
    parts.push(T(46, 24, '#fff', `26회차 후보 진입 컷 · ${fkey}  frameHash=${frameHash}  ${W}×${H}`));
    parts.push(T(78, 20, '#ddd', `정렬 키=${key} · topN=${topN} · 검출 직선 ${lines.length}개 · 진입 직선(현행순위) [${admitted.join(',')}]`));
    parts.push(T(108, 20, '#ddd', `재현 ${sc.matched}/${sc.truthTotal} = ${sc.recall} · 정밀 ${sc.matched}/${sc.detected} = ${sc.precision} · meanIoU ${sc.meanIoU ?? '--'}`));
    parts.push(
      T(138, 20, '#ffab40', `정답 행: ` + truthRows.map((r) => `r${r.rowIdx}(면${r.visibleFaces} ${r.medianDepthM?.toFixed(1) ?? '--'}m near ${r.nearSupport.toFixed(3)} rank ${r.matchRank0 ?? 'X'})`).join('  ')),
    );
    parts.push(T(168, 19, '#00e676', '■ 산출 quad  <tspan fill="#ffea00">┈ 씬 정답 면</tspan>  <tspan fill="#e040fb">━ 정답 행 근변(직선 대응 있음)</tspan>  <tspan fill="#ff1744">━ 정답 행 근변(대응 없음)</tspan>'));
    await sharp(jpg)
      .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
      .png()
      .toFile(join(outDir, `${tag}_sim${fkey.replace(':', '-')}_${frameHash}.png`));
  }
}

writeFileSync(join(outDir, `frontCut_${tag}.json`), `${JSON.stringify(frames, null, 1)}\n`, 'utf8');

// ── 표 ①: 정답 행별 근변선 순위(현행 votes 정렬 기준) + 각 대체 키에서의 순위.
console.log(`\n=== 26회차 frontCut · 정렬 키=${key} · topN=${topN} ===`);
console.log('frame  hash          row  면수  depthM   면적px    near지지  대응rank0  거리px  각도°  ' + KEYS.map((k) => `rank[${k}]`.padStart(13)).join(''));
for (const f of frames) {
  for (const r of f.truthRows) {
    const ranks = KEYS.map((k) => {
      if (r.matchRank0 == null) return '--'.padStart(13);
      const ord = [...f.lines].sort((x, y) => keyOf(y, k) - keyOf(x, k) || x.rank0 - y.rank0);
      return String(ord.findIndex((l) => l.rank0 === r.matchRank0)).padStart(13);
    }).join('');
    console.log(
      `${f.key.padEnd(5)}  ${f.frameHash}  ${String(r.rowIdx).padStart(3)}  ${String(r.visibleFaces).padStart(4)}  ` +
        `${(r.medianDepthM?.toFixed(2) ?? '--').padStart(7)}  ${r.meanAreaPx.toFixed(0).padStart(8)}  ${r.nearSupport.toFixed(4).padStart(8)}  ` +
        `${String(r.matchRank0 ?? '대응없음').padStart(9)}  ${(r.matchDistPx?.toFixed(2) ?? '--').padStart(6)}  ${(r.matchAngleDeg?.toFixed(2) ?? '--').padStart(5)}  ${ranks}`,
    );
  }
}

// ── 표 ②: 1:1 프레임 직선 전수(현행 순위 순).
const f11 = frames.find((f) => f.key === '1:1');
if (f11) {
  console.log(`\n=== 1:1 ${f11.frameHash} 검출 직선 ${f11.lines.length}개 전수(현행 votes 정렬) ===`);
  console.log('rank0  votes   chordPx   spanPx     fill  fillSpan  contrast  widthPx  hit  residPx   theta°    depthM  정답행근변');
  for (const l of f11.lines) {
    console.log(
      `${String(l.rank0).padStart(5)}  ${String(l.votes).padStart(5)}  ${l.chordPx.toFixed(1).padStart(7)}  ${l.spanPx.toFixed(1).padStart(7)}  ` +
        `${l.fill.toFixed(4).padStart(7)}  ${l.fillSpan.toFixed(4).padStart(8)}  ${l.contrast.toFixed(1).padStart(8)}  ${l.widthPx.toFixed(2).padStart(7)}  ` +
        `${String(l.hit).padStart(3)}  ${l.residPx.toFixed(2).padStart(7)}  ${l.thetaDeg.toFixed(2).padStart(7)}  ${(l.depthM?.toFixed(2) ?? '--').padStart(8)}  ` +
        `${l.truthNearOf.length ? `★ r${l.truthNearOf.join(',r')}` : ''}`,
    );
  }
}

// ── 표 ③: 키별 「정답 행 근변선이 상위 topN 에 몇 개 들어오는가」.
console.log(`\n=== 키별 진입 성적(정답 행 근변선 / 전체 정답 행) · topN=${topN} ===`);
for (const k of KEYS) {
  let inTop = 0;
  let total = 0;
  const detail: string[] = [];
  for (const f of frames) {
    const ord = [...f.lines].sort((x, y) => keyOf(y, k) - keyOf(x, k) || x.rank0 - y.rank0);
    for (const r of f.truthRows) {
      total++;
      const rk = r.matchRank0 == null ? null : ord.findIndex((l) => l.rank0 === r.matchRank0);
      if (rk != null && rk < topN) inTop++;
      detail.push(`${f.key}r${r.rowIdx}=${rk == null ? 'X' : rk}`);
    }
  }
  console.log(`  ${k.padEnd(9)} ${String(inTop).padStart(2)}/${total}   ${detail.join(' ')}`);
}

// ── 표 ④: 채점 총계(원시 배정도 — `toFixed` 없음).
const tot = sumScores(scores);
console.log(`\n=== 채점 총계(원시 배정도) · 키=${key} topN=${topN} ===`);
console.log(`  recall            ${tot.recall}   (${tot.matched}/${tot.truthTotal})`);
console.log(`  recallDetectable  ${tot.recallDetectable}`);
console.log(`  precision         ${tot.precision}   (${tot.matched}/${tot.detected})`);
console.log(`  meanIoU           ${tot.meanIoU}`);
console.log(`  minIoU            ${tot.minIoU}`);
console.log(`  pass95 ${tot.pass95} · pass98 ${tot.pass98}`);
console.log(`  프레임해시: ${frames.map((f) => `${f.key}=${f.frameHash}`).join(' ')}`);
console.log(`  프레임별 재현: ${frames.map((f) => `${f.key} ${f.score.matched}/${f.score.truthTotal}`).join(' · ')}`);

// ── 표 ⑤: 스윕(키 × topN) — 재현·정밀 상충을 한 표로. 원시 배정도.
if (sweep.length) {
  console.log(`\n=== 스윕(원시 배정도) ===`);
  console.log('key:topN      recall               recallDetectable     precision            meanIoU              pass95 pass98  프레임별');
  for (const s of [{ key, topN }, ...sweep]) {
    const id = `${s.key}:${s.topN}`;
    const arr = id === `${key}:${topN}` ? scores : (sweepScores.get(id) ?? []);
    if (!arr.length) continue;
    const t = sumScores(arr);
    console.log(
      `${id.padEnd(12)}  ${String(t.recall).padEnd(19)}  ${String(t.recallDetectable).padEnd(19)}  ${String(t.precision).padEnd(19)}  ${String(t.meanIoU).padEnd(19)}  ` +
        `${String(t.pass95).padStart(6)} ${String(t.pass98).padStart(6)}  ${frames.map((f, i) => `${f.key} ${arr[i].matched}/${arr[i].truthTotal}`).join(' · ')}`,
    );
  }
}
console.log(`\n덤프: ${join(outDir, `frontCut_${tag}.json`)} · 오버레이: ${outDir}`);
