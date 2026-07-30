// ★ 20b회차 신규 — **임의 뷰(현재 화면 그대로) 육안 진단 오버레이**.
//
// 색 규약은 `roiAutoRowsOverlay.ts` 그대로다:
//   빨강 실선   = `best`(대표 행)
//   시안~보라 점선 = `rows` 의 각 행
//   자홍 채움   = 증거 없이 **보간한** 칸(`filledIndices`)
//   초록 실선   = 씬 진값 중 이 뷰에서 **보이는** 면(채점 분모)
//   주황 점선   = 매칭 실패한 정답 면과 **가장 가까운** 산출 quad(임계 미만 쌍 — 육안 판정의 핵심)
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 같은 프레임 보증(이 진단의 전제)
//   프레임 1장을 잡아 **그 한 장으로** 검출·정답투영·그리기를 전부 한다. 별도 캡처를 섞지 않는다.
//   카메라를 **움직이지 않는다** — `cam.getPTZ`(읽기) · `roi.show2d{visible:false}` · `cam.captureJPG`(읽기)뿐이다.
//   위치를 옮기려면 이 도구가 아니라 서비스 이동 경로(`POST /viewer/api/move`)를 먼저 쓰라.
//
// ★ 도구↔서비스 괴리(U11) 교차대조
//   같은 PTZ 에서 서비스 `roi.auto.detect{view:"current"}` 를 한 번 더 불러 f·quad 개수·좌표를 대조해
//   **수치로** 출력한다. 시뮬 씬은 정지하지 않으므로(U17) 프레임 해시는 다를 수 있다 — 그래서
//   "좌표가 같다"가 아니라 **얼마나 다른가**를 적는다.
// ══════════════════════════════════════════════════════════════════════════
//
// 정본·DB 무접촉(읽기만). `roi.create2d` 를 부르지 않는다(쓰기 메서드 — F17).
//
// 사용: npx tsx src/tools/roiAutoCurrentViewOverlay.ts <camId> <expectedBays|'-'> [tag] [outDir]
//   ★ 21회차 — 2번째 인자에 `-` 를 주면 **예상 주차면 수 없이**(면수 미사용 · coverageDenom='phaseInvariant')
//     검출한다. 마스터가 뷰어 칸을 비운 것과 같은 경로다. 숫자를 주면 종전(면수 기반) 경로.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
import { DEFAULT_BAY_OPTS, quadPaintSupport, type BayDetectOpts } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { baseFocalPxOf, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, quadAreaPx, visibleTruth, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { scoreDetection, type TruthEntry } from '../ground/roiAutoRecall.js';
import { MATCH_MIN_IOU, quadIoU } from '../ground/autoRoiPlan.js';
import { backprojectToGround } from '../ground/project.js';
import type { Px, Vec3 } from '../ground/contactTypes.js';
import type { PixelQuad } from '../ground/types.js';

const PLANE_Y_M = 0.05;
const MIN_AREA_PX = 200;
const DEG = Math.PI / 180;

const camId = Number(process.argv[2] ?? 1);
const baysArg = process.argv[3] ?? '-';
/** `-` = 면수 미사용(위상 불변 커버리지). 숫자 = 종전 경로. */
const noCount = baysArg === '-' || baysArg === '';
const expectedBays = noCount ? 0 : Number(baysArg);
const tag = process.argv[4] ?? 'cur';
const outDir = process.argv[5] ?? 'reports/overlay_r20';
if (!noCount && (!Number.isFinite(expectedBays) || expectedBays < 1)) throw new Error(`expectedBays: ${baysArg} (숫자 또는 '-')`);
mkdirSync(outDir, { recursive: true });

let rpcId = 0;
async function rpc(url: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const unity = (m: string, p?: Record<string, unknown>) => rpc('http://localhost:13110/rpc', m, p);
const setting = (m: string, p?: Record<string, unknown>) => rpc('http://localhost:13020/rpc', m, p);

const specs = JSON.parse(readFileSync('_workspace/18_scene_spec.json', 'utf8')) as ScenePresetSpec[];
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);
const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const meta = readPlaceMeta(placeJson);
const camMeta = meta.cameras.find((c) => c.camera.camIdx === camId)?.camera;
if (!camMeta) throw new Error(`cam${camId} 메타 없음`);
const base = baseFocalPxOf(meta, camId);
if (!base) throw new Error(`cam${camId} 기준 초점거리 파생 불가`);

// ── ① 현재 PTZ(읽기) · ② 합성 초록 제거 · ③ 무이동 캡처 ─────────────────────
// ★ 21회차 — **프레임 캐시 우선**. `reports/overlay_r20/frames/<tag>_cam<id>.jpg` 가 있으면 그것을 쓴다.
//   전/후 비교를 **한 장**으로 돌리기 위한 것이다(F13: 프레임해시가 다르면 IoU 비교가 무효 · U17 교락 제거).
//   캐시를 쓰면 카메라를 아예 건드리지 않는다.
const FRAME_CACHE = join('reports/overlay_r20/frames', `${tag}_cam${camId}.jpg`);
const PTZ_CACHE = join('reports/overlay_r20/frames', `${tag}_cam${camId}.ptz.json`);
const useCache = existsSync(FRAME_CACHE) && existsSync(PTZ_CACHE);
let ptzNow: { pan: number; tilt: number; zoom: number };
let jpg: Buffer;
if (useCache) {
  ptzNow = JSON.parse(readFileSync(PTZ_CACHE, 'utf8'));
  jpg = readFileSync(FRAME_CACHE);
  console.log(`프레임 캐시 사용: ${FRAME_CACHE} (카메라 미접촉)`);
} else {
  ptzNow = (await unity('cam.getPTZ', { camId })) as { pan: number; tilt: number; zoom: number };
  await unity('roi.show2d', { visible: false });
  const cap = (await unity('cam.captureJPG', { camId })) as { img_bytes?: string };
  jpg = Buffer.from(cap.img_bytes ?? '', 'base64');
}
const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);
const m0 = await sharp(jpg).metadata();
const W = m0.width ?? 0;
const H = m0.height ?? 0;
const gb = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };
// 초록 오염 가드(F2) — 이 진단은 도색선을 보는 것이라 박스가 덮으면 무효다.
const rgb = await sharp(jpg).removeAlpha().raw().toBuffer();
let green = 0;
for (let i = 0; i < rgb.length / 3; i++) {
  const r = rgb[i * 3];
  const g = rgb[i * 3 + 1];
  const b = rgb[i * 3 + 2];
  if (g > 110 && g - r > 55 && g - b > 55) green++;
}
const greenRatio = green / (rgb.length / 3);

// ── ④ 제원 — 서비스 currentViewResolver 와 **같은 규칙**(기준화각 × 현재 zoom · 현재 tilt) ──
const baseHfovDeg = (2 * Math.atan(W / 2 / base.fBasePx)) / DEG;
const intr: PresetIntrinsics = {
  camIdx: camId,
  presetIdx: 1,
  fovDeg: baseHfovDeg,
  fovAxis: 'horizontal',
  fovAtZoom: 'zoom1',
  tiltDeg: ptzNow.tilt,
  heightM: camMeta.heightM,
  imgW: W,
  imgH: H,
  source: `current-view-overlay(f@zoom1 ${base.fBasePx.toFixed(3)}px)`,
};
const model = groundModelFromIntrinsics(intr, ptzNow.zoom);
if (!model) throw new Error('지면모델 구성 실패');

// ── ⑤ 검출(실제 구현 모듈 그대로) ────────────────────────────────────────────
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
const opts: BayDetectOpts = {
  ...DEFAULT_BAY_OPTS,
  expectedBays: Math.max(1, expectedBays),
  coverageDenom: noCount ? 'phaseInvariant' : 'expectedBays',
};
const g = detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, opts, frame);

// ── ⑥ 정답 투영(같은 프레임 · **검출이 쓴 유효 f 그대로**) ───────────────────
// `baseHfovDeg` 는 줌1 기준이라 투영에 그대로 쓰면 안 된다 — `model.f` 를 유효 수평화각으로 되돌려 쓴다.
const camPosRaw = (placeJson.cameras.find((c: any) => c.camera.cam_id === camId) as any).camera.position as number[];
const camPos: [number, number, number] = [camPosRaw[0], camPosRaw[1], camPosRaw[2]];
const effHfovDeg = (2 * Math.atan(W / 2 / model.f)) / DEG;
const vis = visibleTruth(
  projectTruth(faces, {
    camPos,
    panDeg: ptzNow.pan,
    tiltDeg: ptzNow.tilt,
    fovDeg: effHfovDeg,
    fovAxis: 'horizontal',
    imgW: W,
    imgH: H,
    planeYM: PLANE_Y_M,
  }),
  W,
  H,
  MIN_AREA_PX,
);

// ── ⑦ 채점 + **미매칭 최대 IoU 분포**(임계 미만 쌍을 버리지 않고 본다) ───────
const detected: Array<{ quad: PixelQuad; label: string }> = [];
const seen = new Set<string>();
const sig = (q: PixelQuad) => q.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join('|');
for (const q of g.best?.quads ?? []) {
  if (seen.has(sig(q.quad))) continue;
  seen.add(sig(q.quad));
  detected.push({ quad: q.quad, label: `best#${q.latticeIndex}` });
}
g.rows.forEach((r, i) => {
  for (const q of r.quads) {
    if (seen.has(sig(q.quad))) continue;
    seen.add(sig(q.quad));
    detected.push({ quad: q.quad, label: `r${i}#${q.latticeIndex}` });
  }
});
const truth: TruthEntry[] = vis.map((t) => ({
  face: t.face,
  quad: t.quad,
  detectable: quadPaintSupport([{ latticeIndex: 0, quad: t.quad }], ev, DEFAULT_PAINT_OPTIONS, opts).near >= opts.extendMinNearSupport,
}));
const sc = scoreDetection(detected.map((d) => d.quad), truth, MATCH_MIN_IOU);

/**
 * ★ 어긋남의 **지면 미터 성분 분해**(육안 판정을 수치로 대체).
 *
 * 정답 quad 와 최근접 산출 quad 의 중심을 **같은 지면모델**로 역투영해, 그 정답 면 자신의 축으로
 * 분해한다: `along` = 행 방향(칸 피치 축) · `cross` = 깊이 방향.
 *   · along 만 크고 피치의 ~0.5 배 → **격자 위상(lattice phase)**
 *   · cross 만 크다              → **근변선 깊이 오프셋**
 *   · 둘 다 작은데 IoU 가 낮다   → 크기·회전 문제
 */
function decompose(truthQuad: PixelQuad, detQuad: PixelQuad): { along: number; cross: number; pitchM: number } | null {
  const gp = (q: PixelQuad) => q.map((p) => backprojectToGround(p as Px, model!)).filter((x): x is Vec3 => x != null);
  const tg = gp(truthQuad);
  const dg = gp(detQuad);
  if (tg.length !== 4 || dg.length !== 4) return null;
  const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const cen = (q: Vec3[]): Vec3 => [
    (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
    (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
    (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4,
  ];
  // 정답 quad 의 두 변 중 **짧은 쪽**이 행 방향(피치 2.5m), 긴 쪽이 깊이(5.0m).
  const e01: Vec3 = [tg[1][0] - tg[0][0], tg[1][1] - tg[0][1], tg[1][2] - tg[0][2]];
  const e12: Vec3 = [tg[2][0] - tg[1][0], tg[2][1] - tg[1][1], tg[2][2] - tg[1][2]];
  const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const rowVec = len(e01) < len(e12) ? e01 : e12;
  const depVec = len(e01) < len(e12) ? e12 : e01;
  const pitchM = len(rowVec);
  const u: Vec3 = [rowVec[0] / pitchM, rowVec[1] / pitchM, rowVec[2] / pitchM];
  const dl = len(depVec);
  const v: Vec3 = [depVec[0] / dl, depVec[1] / dl, depVec[2] / dl];
  const ct = cen(tg);
  const cd = cen(dg);
  const d: Vec3 = [cd[0] - ct[0], cd[1] - ct[1], cd[2] - ct[2]];
  void mid;
  return { along: d[0] * u[0] + d[1] * u[1] + d[2] * u[2], cross: d[0] * v[0] + d[1] * v[1] + d[2] * v[2], pitchM };
}

/** 정답 면별 **최근접 산출 quad**(임계 무시). 매칭 실패가 "못 찾음"인지 "조금 어긋남"인지를 가른다. */
const nearest = truth.map((t, ti) => {
  let bestIou = 0;
  let bestIdx = -1;
  for (let di = 0; di < detected.length; di++) {
    const iou = quadIoU(t.quad, detected[di].quad);
    if (iou > bestIou) {
      bestIou = iou;
      bestIdx = di;
    }
  }
  return { ti, face: t.face, iou: bestIou, det: bestIdx, matched: sc.pairs.some((p) => p.rowIdx === t.face.rowIdx && p.faceIdx === t.face.faceIdx) };
});

// ★ 도색 지지 대조 — **격자 위상 판정의 결정적 수치**.
//   `near` 는 행 전체가 공유하는 근변선이라 양쪽 다 높게 나온다. 갈리는 것은 **`side`**(칸 경계 = 분리선)다.
//   정답 side 가 높고 검출 side 가 낮으면 → **검출 위상**이 틀린 것. 반대면 → **정답 투영**이 틀린 것.
//   ★ 개수를 맞춘다: 정답 N 칸 vs **그 N 칸이 각각 최근접으로 고른 검출 칸**. 개수·범위가 다르면
//     평균이 흔들려 비교가 무의미해진다.
const rowOfDet = nearest.length ? [...nearest].sort((a, b) => b.iou - a.iou)[0].face.rowIdx : -1;
const t2 = nearest.filter((n) => n.face.rowIdx === rowOfDet && n.det >= 0);
const tSup = quadPaintSupport(vis.map((t, i) => ({ latticeIndex: i, quad: t.quad })), ev, DEFAULT_PAINT_OPTIONS, opts);
const t2Sup = quadPaintSupport(
  t2.map((n, i) => ({ latticeIndex: i, quad: vis.find((v) => v.face === n.face)!.quad })),
  ev,
  DEFAULT_PAINT_OPTIONS,
  opts,
);
/** 위 정답 칸들이 각각 고른 **최근접 검출 칸**(중복 제거) — 개수·범위를 맞춘 대조군. */
const d2Sup = quadPaintSupport(
  [...new Set(t2.map((n) => n.det))].map((di, i) => ({ latticeIndex: i, quad: detected[di].quad })),
  ev,
  DEFAULT_PAINT_OPTIONS,
  opts,
);
const dSup = quadPaintSupport(g.best?.quads ?? [], ev, DEFAULT_PAINT_OPTIONS, opts);

// ── ⑧ 서비스 교차대조(U11) — 같은 PTZ 에서 서비스가 낸 값과 비교 ─────────────
let cross = '서비스 교차대조: 실패';
try {
  const svc = (await setting('roi.auto.detect', {
    camId,
    view: 'current',
    source: 'simulator-1',
    ...(noCount ? {} : { expectedBays }),
  })) as any;
  const sp = svc.presets?.[0];
  const svcBest = (sp?.quads ?? []).length;
  const svcRows = (sp?.rows ?? []).length;
  const svcRowQuads = (sp?.rows ?? []).reduce((n: number, r: any) => n + r.quads.length, 0);
  const svcF = sp?.intrinsics?.focalPx ?? null;
  let maxD = null as number | null;
  if (svcBest === (g.best?.quads.length ?? 0) && svcBest > 0) {
    maxD = 0;
    for (let i = 0; i < svcBest; i++) {
      const a = sp.quads[i].quadNorm as Array<{ x: number; y: number }>;
      const b = g.best!.quads[i].quad;
      for (let k = 0; k < 4; k++) maxD = Math.max(maxD, Math.abs(a[k].x * W - b[k].x), Math.abs(a[k].y * H - b[k].y));
    }
  }
  cross =
    `서비스 교차대조: f 도구 ${model.f.toFixed(5)} vs 서비스 ${svcF} (Δ ${svcF != null ? (model.f - svcF).toExponential(3) : '—'}px) · ` +
    `best ${g.best?.quads.length ?? 0} vs ${svcBest} · rows ${g.rows.length}행/${g.rows.reduce((n, r) => n + r.quads.length, 0)}quad vs ${svcRows}행/${svcRowQuads}quad · ` +
    `프레임 ${frameHash} vs ${sp?.frameHash} ${frameHash === sp?.frameHash ? '(동일)' : '(다름 — 시뮬 씬은 정지하지 않는다 U17)'} · ` +
    `best 좌표 최대차 ${maxD == null ? '개수 불일치로 미산출' : `${maxD.toFixed(3)}px`}`;
} catch (e) {
  cross = `서비스 교차대조: 실패(${(e as Error).message})`;
}

// ── ⑨ 오버레이 ───────────────────────────────────────────────────────────────
const poly = (q: PixelQuad | Array<{ x: number; y: number }>, stroke: string, width: number, fill = 'none', dash = '') =>
  `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const rowColor = (i: number, n: number) => `hsl(${185 + (105 * i) / Math.max(1, n - 1)} 90% 62%)`;

const parts: string[] = [];
for (const t of vis) {
  parts.push(poly(t.quad, '#00e676', 3));
  const cx = (t.quad[0].x + t.quad[1].x + t.quad[2].x + t.quad[3].x) / 4;
  const cy = (t.quad[0].y + t.quad[1].y + t.quad[2].y + t.quad[3].y) / 4;
  const n = nearest.find((x) => x.face === t.face)!;
  parts.push(
    `<text x="${cx.toFixed(0)}" y="${cy.toFixed(0)}" fill="${n.matched ? '#00e676' : '#ffab00'}" font-size="19" text-anchor="middle">r${t.face.rowIdx}f${t.face.faceIdx} ${n.iou.toFixed(2)}</text>`,
  );
}
g.rows.forEach((r, i) => {
  const col = rowColor(i, g.rows.length);
  for (const q of r.quads) {
    const isFilled = r.filledIndices.includes(q.latticeIndex);
    parts.push(poly(q.quad, col, isFilled ? 3 : 2, isFilled ? '#e040fb33' : 'none', '10,6'));
  }
  if (r.quads.length) {
    const q = r.quads[0].quad;
    parts.push(`<text x="${q[0].x.toFixed(0)}" y="${(q[0].y + 22).toFixed(0)}" fill="${col}" font-size="22" font-weight="bold">#${i} p${r.paint.score.toFixed(2)}</text>`);
  }
});
for (const q of g.best?.quads ?? []) parts.push(poly(q.quad, '#ff1744', 4));
// 미매칭 정답의 최근접 산출 quad(주황) — "조금 어긋난 것"과 "못 찾은 것"을 화면에서 가른다.
for (const n of nearest) {
  if (n.matched || n.det < 0 || n.iou <= 0) continue;
  parts.push(poly(detected[n.det].quad, '#ffab00', 3, 'none', '4,4'));
}

parts.push(`<rect x="14" y="14" width="1600" height="196" fill="#000000dd" rx="8"/>`);
parts.push(
  `<text x="30" y="52" fill="#fff" font-size="25" font-weight="bold">[${tag}] cam${camId} pan ${ptzNow.pan} tilt ${ptzNow.tilt} zoom ${ptzNow.zoom} · frame ${frameHash} · bays=${noCount ? '미사용(위상불변)' : expectedBays}</text>`,
);
parts.push(
  `<text x="30" y="86" fill="#ddd" font-size="20">f ${model.f.toFixed(2)}px (f@zoom1 ${base.fBasePx.toFixed(2)} × ${ptzNow.zoom}) · 유효 HFOV ${effHfovDeg.toFixed(3)}° · 씬가시 ${vis.length}면(검출가능 ${sc.truthDetectable}) · 산출 ${detected.length}quad · 초록오염 ${(greenRatio * 100).toFixed(3)}%</text>`,
);
parts.push(
  `<text x="30" y="120" fill="#ffd54f" font-size="20">재현율 ${sc.recall.toFixed(4)} (${sc.matched}/${sc.truthTotal}) · 정밀도 ${sc.precision.toFixed(4)} · 매칭IoU ${sc.meanIoU?.toFixed(5) ?? '--'} · 미매칭 최근접 IoU [${nearest.filter((n) => !n.matched).map((n) => n.iou.toFixed(3)).join(' ') || '없음'}]</text>`,
);
parts.push(
  `<text x="30" y="154" fill="#00e676" font-size="19">━ 씬 진값(가시·라벨=최근접IoU)  <tspan fill="#ff1744">━ best</tspan>  <tspan fill="#4dd0e1">┄ rows</tspan>  <tspan fill="#e040fb">▨ 보간칸</tspan>  <tspan fill="#ffab00">┄ 미매칭 정답의 최근접 산출</tspan></text>`,
);
parts.push(`<text x="30" y="188" fill="#999" font-size="17">같은 프레임 1장으로 검출·정답투영·렌더 전부 수행 · 카메라 무이동(getPTZ/captureJPG 읽기만) · 정본·DB 무접촉</text>`);

const out = join(outDir, `cur_${tag}_cam${camId}_b${noCount ? 'none' : expectedBays}.png`);
await sharp(jpg)
  .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
  .png()
  .toFile(out);

console.log(
  `[${tag}] cam${camId} pan ${ptzNow.pan} tilt ${ptzNow.tilt} zoom ${ptzNow.zoom} · frame ${frameHash} · bays=${expectedBays}\n` +
    `  f ${model.f.toFixed(5)}px · 유효 HFOV ${effHfovDeg.toFixed(5)}° · 초록오염 ${(greenRatio * 100).toFixed(4)}%\n` +
    `  씬가시 ${vis.length}면(도색지지 있음 ${sc.truthDetectable}) · 산출 ${detected.length}quad(best ${g.best?.quads.length ?? 0} · rows ${g.rows.length}행)\n` +
    `  재현율 ${sc.recall.toFixed(4)} (${sc.matched}/${sc.truthTotal}) · 정밀도 ${sc.precision.toFixed(4)} · 매칭IoU ${sc.meanIoU?.toFixed(5) ?? '--'}\n` +
    `  격자 위상: phaseM ${g.best?.phaseM ?? '--'} · phaseFitM ${g.best?.phaseFitM ?? '--'} · 근변선 ${g.best ? g.best.frontLine.map((v) => v.toFixed(4)).join(',') : '--'}\n` +
    `  ★ 정답별 최근접 산출 IoU(임계 ${MATCH_MIN_IOU} 무시):\n` +
    nearest
      .map((n) => {
        const tq = vis.find((v) => v.face === n.face)!.quad;
        const dec = n.det >= 0 ? decompose(tq, detected[n.det].quad) : null;
        const dtxt = dec ? ` · Δalong ${dec.along.toFixed(3)}m(=${(dec.along / dec.pitchM).toFixed(3)}칸) Δcross ${dec.cross.toFixed(3)}m · 피치 ${dec.pitchM.toFixed(3)}m` : '';
        const det = truth[n.ti].detectable ? '도색O' : '도색X';
        return `      r${n.face.rowIdx}f${n.face.faceIdx} iou ${n.iou.toFixed(4)} ${n.matched ? '(매칭)' : n.iou > 0 ? `(미매칭 ← ${detected[n.det].label})` : '(겹침 0)'} ${det} 면적 ${quadAreaPx(tq).toFixed(0)}px²${dtxt}`;
      })
      .join('\n') +
    `\n  ★ 도색 지지 대조(같은 마스크·같은 함수 — 어느 쪽 칸경계가 도색 위인가):\n` +
    `      정답(가시면 전체)       near ${tSup.near.toFixed(4)} far ${tSup.far.toFixed(4)} side ${tSup.side.toFixed(4)} score ${tSup.score.toFixed(4)}\n` +
    `      ★ 정답 r${rowOfDet} ${t2.length}칸        near ${t2Sup.near.toFixed(4)} far ${t2Sup.far.toFixed(4)} side ${t2Sup.side.toFixed(4)} score ${t2Sup.score.toFixed(4)}\n` +
    `      ★ 그 칸들의 최근접 검출  near ${d2Sup.near.toFixed(4)} far ${d2Sup.far.toFixed(4)} side ${d2Sup.side.toFixed(4)} score ${d2Sup.score.toFixed(4)}   ← 개수 맞춘 대조군\n` +
    `      검출 best 행 전체        near ${dSup.near.toFixed(4)} far ${dSup.far.toFixed(4)} side ${dSup.side.toFixed(4)} score ${dSup.score.toFixed(4)}\n` +
    `  ${cross}\n` +
    `  검출 issues:\n${g.issues.map((s) => `      - ${s}`).join('\n')}\n` +
    `  지면모델 issues:\n${model.issues.map((s) => `      - ${s}`).join('\n')}\n` +
    `  → ${out}`,
);
