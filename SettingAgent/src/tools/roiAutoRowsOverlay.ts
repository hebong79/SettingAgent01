// ★ 18회차 신규 — **다중 행 육안 검증 오버레이**. `rows` 전체를 그린다.
//
// 색 규약:
//   빨강 실선   = `best`(이 프리셋이 겨눈 대표 행. 소비자 10곳이 읽는 값)
//   시안 점선   = `rows` 의 나머지 행(도색 증거 기준 전체 행)
//   자홍 채움   = 증거 없이 **보간한** 칸(`filledIndices`) — 숨기지 않는다
//   초록 실선   = 씬 진값 중 이 뷰에서 **보이는** 면(채점 분모)
//   회색 실선   = 수동 정본(회귀 감시용 참고)
//
// 정본·DB 무접촉(읽기만). Unity 는 부르지 않는다(씬 제원은 `_workspace/18_scene_spec.json` 캐시).
//
// 사용: npx tsx src/tools/roiAutoRowsOverlay.ts [frames] [outDir] [rowExtentMode]

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, visibleTruth, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';
import type { PixelQuad } from '../ground/types.js';

const GOLDEN_DIRS: Record<string, string> = {
  v1: 'test/fixtures/roiAutoGolden',
  v2: 'test/fixtures/roiAutoGolden_v2',
};
const framesArg = process.argv[2] ?? 'v1';
const cacheDir = GOLDEN_DIRS[framesArg] ?? framesArg;
const outDir = process.argv[3] ?? 'reports/overlay_r18';
const rowExtentMode = (process.argv[4] ?? 'evidence') as 'evidence' | 'expected';
mkdirSync(outDir, { recursive: true });

const PLANE_Y_M = 0.05;
const MIN_AREA_PX = 200;

const specs = JSON.parse(readFileSync('_workspace/18_scene_spec.json', 'utf8')) as ScenePresetSpec[];
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);
const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));

const poly = (q: PixelQuad | Array<{ x: number; y: number }>, stroke: string, width: number, fill = 'none', dash = '') =>
  `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

/**
 * 행 번호별 색 — 시안→청→보라 구간(185~290°)에만 머문다.
 * 색상환을 한 바퀴 돌리면 뒤쪽 행이 **빨강**이 되어 `best`(빨강)와 육안으로 구분되지 않는다.
 */
const rowColor = (i: number, n: number) => `hsl(${185 + (105 * i) / Math.max(1, n - 1)} 90% 62%)`;

for (const c of placeJson.cameras) {
  for (const p of c.presets) {
    const key = `${c.camera.cam_id}:${p.preset_idx}`;
    const jpgPath = join(cacheDir, `frame_${c.camera.cam_id}_${p.preset_idx}_d0.jpg`);
    if (!existsSync(jpgPath)) continue;
    const baseIntr = intrinsics.get(c.camera.cam_id, p.preset_idx);
    if (!baseIntr) continue;
    const jpg = readFileSync(jpgPath);
    const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
    const meta = await sharp(jpg).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const gb = await sharp(jpg).greyscale().raw().toBuffer();
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
    const model = groundModelFromIntrinsics(baseIntr, p.zoom);
    if (!model) continue;
    const manual = byPreset.get(key) ?? [];
    const bays = manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;
    const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, bays), rowExtentMode };
    const g = detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, opts, frame);

    const vis = visibleTruth(
      projectTruth(faces, {
        camPos: c.camera.position,
        panDeg: p.pan,
        tiltDeg: p.tilt,
        fovDeg: p.fov,
        fovAxis: 'vertical',
        imgW: W,
        imgH: H,
        planeYM: PLANE_Y_M,
      }),
      W,
      H,
      MIN_AREA_PX,
    );

    const parts: string[] = [];
    // 수동 정본(회색, 배경)
    for (const sp of manual) {
      if (!Array.isArray(sp.points) || sp.points.length < 3) continue;
      parts.push(poly(sp.points.map((q) => ({ x: q.x * W, y: q.y * H })), '#bdbdbd', 2, 'none', '6,6'));
    }
    // 씬 진값 가시 면(초록)
    for (const t of vis) {
      parts.push(poly(t.quad, '#00e676', 3));
      const cx = (t.quad[0].x + t.quad[1].x + t.quad[2].x + t.quad[3].x) / 4;
      const cy = (t.quad[0].y + t.quad[1].y + t.quad[2].y + t.quad[3].y) / 4;
      parts.push(`<text x="${cx.toFixed(0)}" y="${cy.toFixed(0)}" fill="#00e676" font-size="20" text-anchor="middle">r${t.face.rowIdx}f${t.face.faceIdx}</text>`);
    }
    // rows(시안 계열 점선) — best 와 좌표가 같은 행도 그대로 둔다(무엇이 후보였는지 보여야 한다).
    g.rows.forEach((r, i) => {
      const col = rowColor(i, g.rows.length);
      for (const q of r.quads) {
        const isFilled = r.filledIndices.includes(q.latticeIndex);
        parts.push(poly(q.quad, col, isFilled ? 3 : 2, isFilled ? '#e040fb33' : 'none', '10,6'));
      }
      if (r.quads.length) {
        const q = r.quads[0].quad;
        parts.push(`<text x="${q[0].x.toFixed(0)}" y="${(q[0].y + 22).toFixed(0)}" fill="${col}" font-size="22" font-weight="bold">#${i} p${r.paint.score.toFixed(2)}${r.filledIndices.length ? ` 보간${r.filledIndices.length}` : ''}</text>`);
      }
    });
    // best(빨강 실선, 가장 위)
    for (const q of g.best?.quads ?? []) parts.push(poly(q.quad, '#ff1744', 4));

    const ended = g.best?.extentEndedBy ? `${g.best.extentEndedBy.lo}/${g.best.extentEndedBy.hi}` : '--';
    parts.push(`<rect x="14" y="14" width="1180" height="160" fill="#000000cc" rx="8"/>`);
    parts.push(`<text x="30" y="52" fill="#fff" font-size="26" font-weight="bold">${key}  frame ${frameHash}  mode=${rowExtentMode}  행후보 ${g.rows.length} · best ${g.best?.quads.length ?? 0}quad · 씬가시 ${vis.length}면 · 수동 ${bays}면</text>`);
    parts.push(`<text x="30" y="88" fill="#ddd" font-size="21">best 끝맺음 ${ended} · 보간 ${g.best?.filledIndices.length ?? 0}칸 · rows 총 ${g.rows.reduce((s, r) => s + r.quads.length, 0)}quad</text>`);
    parts.push(`<text x="30" y="124" fill="#00e676" font-size="20">━ 씬 진값(가시)  <tspan fill="#ff1744">━ best</tspan>  <tspan fill="#4dd0e1">┄ rows(전 행 후보)</tspan>  <tspan fill="#e040fb">▨ 보간 칸(증거 없음)</tspan>  <tspan fill="#bdbdbd">┄ 수동 정본</tspan></text>`);
    parts.push(`<text x="30" y="158" fill="#999" font-size="17">실제 구현 모듈 통과 · 정본·DB 무접촉 · 씬 진값은 채점 전용(검출 경로 미참조)</text>`);

    const out = join(outDir, `rows_${key.replace(':', '_')}_${rowExtentMode}.png`);
    await sharp(jpg)
      .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
      .png()
      .toFile(out);
    console.log(`${key}: rows ${g.rows.length} · best ${g.best?.quads.length ?? 0}quad · 씬가시 ${vis.length}면 → ${out}`);
  }
}
