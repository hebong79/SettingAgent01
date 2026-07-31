// ★ 19회차 신규 — **행 후보 분포 측정** 도구(문턱을 정하기 **전에** 분포부터 본다).
//
// 무엇을 재는가(설계자 §12-3 필수 측정 1·4 · 리더 지시 1·3):
//   ① 후보별 `paint.score`·`paint.near` 분포 + 씬 정답 라벨(진짜/가짜) → **골짜기가 있는가**
//   ② `best` 대비 상대비 분포(프리셋마다 스케일이 달라 절대값은 못 쓴다)
//   ③ dedup 이 무엇을 지웠는가 — 후보 쌍의 quad 겹침 분포(§6-4 미측정 이월)
//   ④ 구조 제약(행 간 평행·등간격·거리) 측정치
//
// ★ 라벨은 **채점 전용**이다. 여기서 얻은 라벨을 검출·필터 경로에 넣지 않는다(R1).
//   이 파일은 `src/tools/` 의 진단 도구이며 `src/ground/` 검출 모듈은 이 파일을 import 하지 않는다.
//
// 사용: npx tsx src/tools/roiAutoRowsDiag.ts [frames]
//   frames  v1(기본) | v2 | 캐시 디렉터리

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
import { DEFAULT_BAY_OPTS, type BayDetectOpts } from '../ground/bayGeometry.js';
import { fitRowGrid, type GridResult, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, visibleTruth, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { quadIoU, MATCH_MIN_IOU } from '../ground/autoRoiPlan.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';

const GOLDEN_DIRS: Record<string, string> = {
  v1: 'test/fixtures/roiAutoGolden',
  v2: 'test/fixtures/roiAutoGolden_v2',
};
const framesArg = process.argv[2] ?? 'v1';
const cacheDir = GOLDEN_DIRS[framesArg] ?? framesArg;
// ★ 22회차 — 커버리지 분모 스위치(진단 전용). 같은 프레임 위에서 두 분모의 후보 순위를 대조한다.
const coverageDenom = (process.argv[3] ?? 'expectedBays') as 'expectedBays' | 'phaseInvariant';
if (coverageDenom !== 'expectedBays' && coverageDenom !== 'phaseInvariant') throw new Error(`coverageDenom: ${coverageDenom}`);

const PLANE_Y_M = 0.05;
const MIN_AREA_PX = 200;

const specs = JSON.parse(readFileSync('_workspace/18_scene_spec.json', 'utf8')) as ScenePresetSpec[];
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);

const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

console.log(`19회차 행 후보 분포 측정 — frames=${cacheDir} · 라벨은 채점 전용(R1)\n`);

interface Rec {
  key: string;
  ci: number;
  r: GridResult;
  /** 이 행의 quad 중 정답 면과 IoU ≥ 0.5 로 매칭된 수. */
  hit: number;
  quads: number;
  /** hit / quads. */
  rowPrec: number;
  /** paint.score / (그 프리셋 best 후보의 paint.score). */
  ratioBest: number;
  isBest: boolean;
  angDeg: number;
  depth: number | null;
}
const recs: Rec[] = [];

for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    const key = `${c.camera.cam_id}:${p.preset_idx}`;
    const manual = (byPreset.get(key) ?? []).filter((s: { points?: unknown[] }) => Array.isArray(s.points) && s.points.length === 4);
    const baseIntr = intrinsics.get(c.camera.cam_id, p.preset_idx);
    if (!baseIntr) continue;
    const jpgPath = join(cacheDir, `frame_${c.camera.cam_id}_${p.preset_idx}_d0.jpg`);
    if (!existsSync(jpgPath)) continue;
    const jpg = readFileSync(jpgPath);
    const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
    const meta = await sharp(jpg).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const gb = await sharp(jpg).greyscale().raw().toBuffer();
    const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };

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
    const model = groundModelFromIntrinsics(baseIntr, p.zoom);
    if (!model) continue;
    const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, manual.length), rowExtentMode: 'evidence', coverageDenom };

    const local: Array<{ ci: number; r: GridResult }> = [];
    for (let ci = 0; ci < cands.length; ci++) {
      const r = fitRowGrid(model, cands[ci].front, cands[ci].cornersPx, ev, DEFAULT_PAINT_OPTIONS, opts);
      if (r) local.push({ ci, r });
    }
    if (!local.length) continue;
    // `best` = effectiveScore argmax(= detectBaysWithModel 의 선별 결과. maxRowDistanceRatio=0 이라 pool 전체).
    let bi = 0;
    for (let i = 1; i < local.length; i++) {
      if ((local[i].r.effectiveScore ?? 0) > (local[bi].r.effectiveScore ?? 0) + 1e-12) bi = i;
    }
    const bestPaint = local[bi].r.paint.score;

    const rows: Rec[] = local.map((e, i) => {
      let hit = 0;
      for (const q of e.r.quads) {
        let mx = 0;
        for (const t of vis) mx = Math.max(mx, quadIoU(t.quad, q.quad));
        if (mx >= MATCH_MIN_IOU) hit++;
      }
      const ang = (Math.atan2(e.r.frontLine[1], e.r.frontLine[0]) * 180) / Math.PI;
      return {
        key,
        ci: e.ci,
        r: e.r,
        hit,
        quads: e.r.quads.length,
        rowPrec: e.r.quads.length ? hit / e.r.quads.length : 0,
        ratioBest: bestPaint > 0 ? e.r.paint.score / bestPaint : 0,
        isBest: i === bi,
        angDeg: ang,
        depth: e.r.medianDepthM,
      };
    });
    recs.push(...rows);

    // ★ 22회차 — `refScore` 는 **baseScore argmax 후보의 paint.score**(bayGrid.ts:682-699). 그 기준선이
    //   커버리지에 따라 다른 후보로 옮겨가면 진입 문턱 자체가 통째로 움직인다. 그래서 여기서 함께 낸다.
    let ri = 0;
    for (let i = 1; i < local.length; i++) {
      const bi2 = local[i].r.baseScore ?? local[i].r.paint.score;
      const bb = local[ri].r.baseScore ?? local[ri].r.paint.score;
      if (bi2 > bb + 1e-12) ri = i;
    }
    const refScore = local[ri].r.paint.score;

    console.log(`=== ${key}  프레임 ${frameHash} · 씬가시 ${vis.length}면 · 후보 ${local.length}개 · denom=${coverageDenom} · refScore=${refScore.toFixed(5)}(ci=${local[ri].ci})`);
    console.log('  ci  quads  paint.score  paint.near   ratioBest  ratioRef  baseScore  effective  denomC   depth(m)   각(°)     hit/quads  rowPrec  판정  게이트  best');
    for (const x of [...rows].sort((a, b) => b.r.paint.score - a.r.paint.score)) {
      const g1 = x.r.paint.score >= refScore * opts.rowMinScoreRatio;
      const g2 = x.r.paint.near >= opts.rowMinNearSupport;
      console.log(
        `  ${String(x.ci).padStart(2)}  ${String(x.quads).padStart(5)}  ` +
          `${x.r.paint.score.toFixed(5).padStart(11)}  ${x.r.paint.near.toFixed(5).padStart(10)}  ` +
          `${x.ratioBest.toFixed(5).padStart(9)}  ${(refScore > 0 ? x.r.paint.score / refScore : 0).toFixed(5).padStart(8)}  ` +
          `${(x.r.baseScore ?? 0).toFixed(5).padStart(9)}  ${(x.r.effectiveScore ?? 0).toFixed(5).padStart(9)}  ` +
          `${(x.r.denomCells?.toFixed(2) ?? '--').padStart(6)}  ${(x.depth?.toFixed(2) ?? '--').padStart(9)}  ` +
          `${x.angDeg.toFixed(3).padStart(8)}  ${String(x.hit).padStart(6)}/${String(x.quads).padEnd(3)}  ` +
          `${x.rowPrec.toFixed(3).padStart(6)}  ${(x.rowPrec >= 0.5 ? '진짜' : x.hit > 0 ? '부분' : '가짜').padEnd(4)}  ` +
          `${(g1 && g2 ? '통과' : g1 ? 'near탈락' : g2 ? '비율탈락' : '둘다탈락').padEnd(8)}  ${x.isBest ? '★' : ''}${x.ci === local[ri].ci ? '§ref' : ''}`,
      );
    }

    // ── dedup 진단: 후보 쌍의 quad 겹침. dedupeRows 와 같은 식(각 quad 의 최대 quadIoU ≥ rowMergeIoU 비율).
    const pairLines: string[] = [];
    for (let a = 0; a < local.length; a++) {
      for (let b = 0; b < local.length; b++) {
        if (a === b) continue;
        const A = local[a].r;
        const B = local[b].r;
        if (!B.quads.length) continue;
        let hit = 0;
        let maxIoU = 0;
        for (const q of B.quads) {
          let m = 0;
          for (const pq of A.quads) m = Math.max(m, quadIoU(pq.quad, q.quad));
          maxIoU = Math.max(maxIoU, m);
          if (m >= opts.rowMergeIoU) hit++;
        }
        if (b > a || maxIoU > 0.05) {
          pairLines.push(`    ${local[a].ci}→${local[b].ci}: 겹침비 ${(hit / B.quads.length).toFixed(3)} · 최대quadIoU ${maxIoU.toFixed(4)}`);
        }
      }
    }
    console.log(`  [dedup 진단] 쌍별 겹침(비 ≥0.5 면 뒤쪽 제거)`);
    for (const l of pairLines) console.log(l);

    // ── 구조 제약 측정: 행 간 각도 차 · 지면 거리 · 깊이 간격.
    const sorted = [...local].filter((e) => e.r.medianDepthM != null).sort((a, b) => (a.r.medianDepthM ?? 0) - (b.r.medianDepthM ?? 0));
    console.log(
      `  [구조] 거리순 ci=${sorted.map((e) => e.ci).join(',')} · 거리=${sorted.map((e) => (e.r.medianDepthM ?? 0).toFixed(2)).join(',')}\n` +
        `         전방선 각(°)=${sorted.map((e) => ((Math.atan2(e.r.frontLine[1], e.r.frontLine[0]) * 180) / Math.PI).toFixed(2)).join(',')}`,
    );
    // ★ 구조 제약 후보: **지면 위에서** 행끼리 평행한가(이미지 각이 아니라 행 좌표계 u 벡터의 사잇각).
    //   진짜 행끼리는 0° 에 가까워야 하고, 엉뚱한 후보는 흩어져야 한다 — 그 전제를 라벨과 함께 잰다.
    const par: string[] = [];
    for (let a = 0; a < local.length; a++) {
      for (let b = a + 1; b < local.length; b++) {
        const ua = local[a].r.frame.u;
        const ub = local[b].r.frame.u;
        const d = Math.abs(ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2]);
        const deg = (Math.acos(Math.min(1, d)) * 180) / Math.PI;
        const la = rows.find((x) => x.ci === local[a].ci);
        const lb = rows.find((x) => x.ci === local[b].ci);
        const tag = (x?: Rec) => (x && x.rowPrec >= 0.5 ? 'R' : x && x.hit > 0 ? 'p' : 'F');
        par.push(`${local[a].ci}${tag(la)}-${local[b].ci}${tag(lb)}:${deg.toFixed(2)}°`);
      }
    }
    console.log(`         지면 u 사잇각: ${par.join(' ')}\n`);
  }
}

// ── 전체 분포 요약
const real = recs.filter((x) => x.rowPrec >= 0.5);
const part = recs.filter((x) => x.rowPrec < 0.5 && x.hit > 0);
const fake = recs.filter((x) => x.hit === 0);
const stat = (xs: number[]) =>
  xs.length ? `n=${xs.length} min=${Math.min(...xs).toFixed(4)} med=${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(4)} max=${Math.max(...xs).toFixed(4)}` : 'n=0';
console.log(
  `\n=== 전체 분포(후보 ${recs.length}개) ===\n` +
    `  진짜(rowPrec≥0.5) ${real.length} · 부분(0<rowPrec<0.5) ${part.length} · 가짜(hit=0) ${fake.length}\n` +
    `  paint.score  진짜 ${stat(real.map((x) => x.r.paint.score))}\n` +
    `               부분 ${stat(part.map((x) => x.r.paint.score))}\n` +
    `               가짜 ${stat(fake.map((x) => x.r.paint.score))}\n` +
    `  ratioBest    진짜 ${stat(real.map((x) => x.ratioBest))}\n` +
    `               부분 ${stat(part.map((x) => x.ratioBest))}\n` +
    `               가짜 ${stat(fake.map((x) => x.ratioBest))}\n` +
    `  paint.near   진짜 ${stat(real.map((x) => x.r.paint.near))}\n` +
    `               부분 ${stat(part.map((x) => x.r.paint.near))}\n` +
    `               가짜 ${stat(fake.map((x) => x.r.paint.near))}\n`,
);
// 정렬 나열 — 골짜기를 눈으로 찾기 위해 라벨을 붙여 한 줄로 낸다.
console.log('  ratioBest 오름차순(라벨): ' + [...recs].sort((a, b) => a.ratioBest - b.ratioBest).map((x) => `${x.ratioBest.toFixed(3)}${x.rowPrec >= 0.5 ? 'R' : x.hit > 0 ? 'p' : 'F'}`).join(' '));
console.log('  paint.score 오름차순(라벨): ' + [...recs].sort((a, b) => a.r.paint.score - b.r.paint.score).map((x) => `${x.r.paint.score.toFixed(3)}${x.rowPrec >= 0.5 ? 'R' : x.hit > 0 ? 'p' : 'F'}`).join(' '));
