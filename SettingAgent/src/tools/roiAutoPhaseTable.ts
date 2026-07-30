// ★ 20c회차 신규 — **위상 후보 점수표**. "어느 후보가 몇 점으로 이겼는가"를 찍는다.
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 재구현하지 않는다(U11 방지)
//   위상 열거를 도구가 흉내내면 서비스와 갈라진다. 그래서 **실제 `detectBaysWithModel` 을 그대로 호출**하고
//   `expectedBays` 만 1..N 으로 쓸어 승자를 읽는다.
//   이것이 후보 지형을 온전히 드러내는 이유(코드 사실):
//     · 위상 후보 목록 `phases[]`(bayGrid.ts:292-294)는 검출 코너 `evid` 와 `spanLo + w·j/phaseSteps` 로만
//       만들어진다 → **`expectedBays` 와 무관**하다. 후보 집합은 모든 bays 에서 **동일**하다.
//     · `rowExtentMode:'evidence'`(기본)에서 `expectedBays` 의 **유일한 생존 경로**는
//       `denom`(bayGrid.ts:393) 하나다. 317~329(‘expected’ 창 선택)는 이 모드에서 죽은 가지다.
//       (`bayGeometry.ts:419 bestLattice` 의 `maxIndex = expectedBays+maxGap+2` 는 **구 경로**
//        `detectBays`/`detectBaysPaired` 전용이며 `detectBaysWithModel` 에서 도달하지 않는다.)
//   → 따라서 bays 를 쓸면 **같은 후보 집합에 다른 점수**가 매겨지고, 승자가 바뀌는 지점이 곧 역전점이다.
//
// ★ 프레임 고정: 잡은 프레임 1장을 디스크에 캐시하고 그 한 장으로 전 스윕을 돈다(U17 교락 제거).
//   캐시가 있으면 카메라를 아예 건드리지 않는다.
// ══════════════════════════════════════════════════════════════════════════
//
// 정본·DB 무접촉. Unity 는 `cam.getPTZ`·`roi.show2d{visible:false}`·`cam.captureJPG`(전부 읽기/표시)만.
// 사용: npx tsx src/tools/roiAutoPhaseTable.ts <camId> <tag> [maxBays]

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
import { DEFAULT_BAY_OPTS, type BayDetectOpts } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../ground/cameraIntrinsics.js';
import { baseFocalPxOf, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { facesOfRow, projectTruth, visibleTruth, type ScenePresetSpec } from '../ground/sceneTruth.js';
import { scoreDetection, type TruthEntry } from '../ground/roiAutoRecall.js';
import { MATCH_MIN_IOU } from '../ground/autoRoiPlan.js';
import type { PixelQuad } from '../ground/types.js';

const PLANE_Y_M = 0.05;
const MIN_AREA_PX = 200;
const DEG = Math.PI / 180;
const CACHE_DIR = 'reports/overlay_r20/frames';

const camId = Number(process.argv[2] ?? 1);
const tag = process.argv[3] ?? 'A';
const maxBays = Number(process.argv[4] ?? 16);
/** ★ 21회차 — 커버리지 척도 스위치. `phaseInvariant` 는 면수를 모르는 호출자(현재뷰 · 칸 비움)의 경로다. */
const coverageDenom = (process.argv[5] ?? 'expectedBays') as 'expectedBays' | 'phaseInvariant';
if (coverageDenom !== 'expectedBays' && coverageDenom !== 'phaseInvariant') throw new Error(`coverageDenom: ${coverageDenom}`);
mkdirSync(CACHE_DIR, { recursive: true });

let rpcId = 0;
async function unity(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch('http://localhost:13110/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ── 프레임 확보(캐시 우선 — 있으면 카메라를 건드리지 않는다) ─────────────────
const jpgPath = join(CACHE_DIR, `${tag}_cam${camId}.jpg`);
const ptzPath = join(CACHE_DIR, `${tag}_cam${camId}.ptz.json`);
let jpg: Buffer;
let ptzNow: { pan: number; tilt: number; zoom: number };
if (existsSync(jpgPath) && existsSync(ptzPath)) {
  jpg = readFileSync(jpgPath);
  ptzNow = JSON.parse(readFileSync(ptzPath, 'utf8'));
  console.log(`프레임 캐시 사용: ${jpgPath} (카메라 미접촉)`);
} else {
  ptzNow = (await unity('cam.getPTZ', { camId })) as typeof ptzNow;
  await unity('roi.show2d', { visible: false }); // F2 — 합성 초록 박스 제거.
  const cap = (await unity('cam.captureJPG', { camId })) as { img_bytes?: string };
  jpg = Buffer.from(cap.img_bytes ?? '', 'base64');
  writeFileSync(jpgPath, jpg);
  writeFileSync(ptzPath, JSON.stringify(ptzNow));
  console.log(`프레임 신규 캡처 → ${jpgPath} (카메라 무이동: getPTZ/captureJPG 읽기만)`);
}
const frameHash = createHash('sha256').update(jpg).digest('hex').slice(0, 12);

const meta0 = await sharp(jpg).metadata();
const W = meta0.width ?? 0;
const H = meta0.height ?? 0;
const gb = await sharp(jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(gb.buffer, gb.byteOffset, gb.byteLength), width: W, height: H };

// ── 제원(서비스 currentViewResolver 와 같은 규칙) ────────────────────────────
const placeJson = JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8'));
const meta = readPlaceMeta(placeJson);
const camMeta = meta.cameras.find((c) => c.camera.camIdx === camId)!.camera;
const base = baseFocalPxOf(meta, camId)!;
const intr: PresetIntrinsics = {
  camIdx: camId, presetIdx: 1,
  fovDeg: (2 * Math.atan(W / 2 / base.fBasePx)) / DEG,
  fovAxis: 'horizontal', fovAtZoom: 'zoom1',
  tiltDeg: ptzNow.tilt, heightM: camMeta.heightM, imgW: W, imgH: H,
  source: 'phase-table',
};
const model = groundModelFromIntrinsics(intr, ptzNow.zoom)!;

// ── 정답(같은 프레임·같은 유효 f) ────────────────────────────────────────────
const specs = JSON.parse(readFileSync('_workspace/18_scene_spec.json', 'utf8')) as ScenePresetSpec[];
const faces = specs.flatMap((s) => facesOfRow(s, PLANE_Y_M) ?? []);
const camPosRaw = (placeJson.cameras.find((c: any) => c.camera.cam_id === camId) as any).camera.position as number[];
const vis = visibleTruth(
  projectTruth(faces, {
    camPos: [camPosRaw[0], camPosRaw[1], camPosRaw[2]],
    panDeg: ptzNow.pan, tiltDeg: ptzNow.tilt,
    fovDeg: (2 * Math.atan(W / 2 / model.f)) / DEG, fovAxis: 'horizontal',
    imgW: W, imgH: H, planeYM: PLANE_Y_M,
  }),
  W, H, MIN_AREA_PX,
);

// ── 검출 입력(bays 와 무관 — 한 번만 만든다) ─────────────────────────────────
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

console.log(
  `\n20c회차 위상 후보 점수표 — [${tag}] cam${camId} pan ${ptzNow.pan} tilt ${ptzNow.tilt} zoom ${ptzNow.zoom}\n` +
    `프레임 ${frameHash} · f ${model.f.toFixed(3)}px · 씬가시 ${vis.length}면\n` +
    `점수식(코드): effective = (paint.score + ${DEFAULT_BAY_OPTS.aimCenterWeight}·aimTerm + ${DEFAULT_BAY_OPTS.phaseFitWeight}·phaseTerm) × coverage^${DEFAULT_BAY_OPTS.coverageExponent}\n` +
    `             coverageDenom=${coverageDenom} — ` +
    (coverageDenom === 'phaseInvariant'
      ? `coverage = min(1, Σ칸별근변지지 / 도색지지구간칸수)  ← **위상 불변 · expectedBays 미사용**(21회차 ②)\n`
      : `coverage = min(1, quads / denom) · denom = min(expectedBays, inFrameCells)  ← 종전 식(위상 의존 F18)\n`) +
    `★ phaseFitWeight=0 이므로 phaseTerm 은 점수에 기여하지 않는다. base ≡ paint.score + 1.6·aimTerm 은 **bays 와 무관**하다.\n`,
);

interface Row {
  bays: number; phaseM: number; quads: number; inFrame: number; denom: number; coverage: number;
  paintScore: number; effective: number; baseScore: number; recall: number; iou: number | null; matched: number;
  /** 증거 없이 **보간**된 칸(`filledIndices`) — 커버리지 분자가 보간칸으로 부푸는지 본다. */
  filled: number;
  /** 칸별 근변 지지(그 위상의 창 안 칸만). 길이 우위가 증거 우위인지 가른다. */
  cellNear: number[];
  near: number; far: number; side: number;
}
const rows: Row[] = [];
for (let bays = 1; bays <= maxBays; bays++) {
  const opts: BayDetectOpts = { ...DEFAULT_BAY_OPTS, expectedBays: bays, coverageDenom };
  const g = detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, opts, frame);
  const b = g.best;
  if (!b) continue;
  const inFrame = b.cellDiag.filter((c) => c.inFrame).length;
  // ★ 21회차 — 커버리지·분모·기저점수를 **재계산하지 않고 산출물에서 읽는다**(식이 갈라지면 표가 거짓말한다 = U11).
  const denom =
    coverageDenom === 'phaseInvariant' ? (b.denomCells ?? NaN) : Math.max(1, Math.min(bays, inFrame || bays));
  const coverage = b.coverage ?? 0;
  const eff = b.effectiveScore ?? 0;
  const baseScore = b.baseScore ?? 0;
  const det: PixelQuad[] = b.quads.map((q) => q.quad);
  const truth: TruthEntry[] = vis.map((t) => ({ face: t.face, quad: t.quad, detectable: false }));
  const sc = scoreDetection(det, truth, MATCH_MIN_IOU);
  rows.push({
    bays, phaseM: b.phaseM, quads: b.quads.length, inFrame, denom, coverage,
    paintScore: b.paint.score, effective: eff, baseScore,
    recall: sc.recall, iou: sc.meanIoU, matched: sc.matched,
    filled: b.filledIndices.length,
    cellNear: b.quads.map((q) => b.cellDiag.find((c) => c.index === q.latticeIndex)?.near ?? NaN),
    near: b.paint.near, far: b.paint.far, side: b.paint.side,
  });
}

console.log('bays | phaseM        | quads | inFrame | denom | coverage | paint.score | base(=eff/cov) | effective | 재현율  | 매칭IoU');
console.log('-----+---------------+-------+---------+-------+----------+-------------+----------------+-----------+---------+---------');
for (const r of rows) {
  console.log(
    `${String(r.bays).padStart(4)} | ${r.phaseM.toFixed(6).padStart(13)} | ${String(r.quads).padStart(5)} | ${String(r.inFrame).padStart(7)} | ` +
      `${r.denom.toFixed(2).padStart(5)} | ${r.coverage.toFixed(5).padStart(8)} | ${r.paintScore.toFixed(6).padStart(11)} | ${r.baseScore.toFixed(6).padStart(14)} | ` +
      `${r.effective.toFixed(6).padStart(9)} | ${r.recall.toFixed(4).padStart(7)} | ${r.iou == null ? '     --' : r.iou.toFixed(5).padStart(7)}`,
  );
}

// ── 서로 다른 승자(=위상)들을 뽑아, **모든 denom 에서** 각자의 점수를 다시 계산해 역전점을 특정한다 ──
// base·quads·inFrameCells 는 bays 와 무관하므로, denom 만 바꿔 넣으면 그 후보의 점수를 정확히 재현할 수 있다.
const uniq: Row[] = [];
for (const r of rows) if (!uniq.some((u) => Math.abs(u.phaseM - r.phaseM) < 1e-9)) uniq.push(r);
console.log(`\n★ 서로 다른 승자 위상 ${uniq.length}개 — 같은 후보 집합, denom 만 다르다`);
for (const u of uniq) {
  console.log(
    `   P@${u.phaseM.toFixed(6)}: quads ${u.quads}(보간 ${u.filled}) · inFrame ${u.inFrame} · ` +
      `paint near ${u.near.toFixed(4)} far ${u.far.toFixed(4)} side ${u.side.toFixed(4)} score ${u.paintScore.toFixed(6)} · ` +
      `base ${u.baseScore.toFixed(6)} · 재현율 ${u.recall.toFixed(4)} · 매칭IoU ${u.iou?.toFixed(5) ?? '--'}\n` +
      `        칸별 근변지지: [${u.cellNear.map((v) => v.toFixed(3)).join(' ')}]`,
  );
}
if (uniq.length >= 2) {
  console.log('\n★ denom 별 점수 재계산(역전점 특정) — effective = base × min(1, quads/denom)');
  const head = uniq.map((u) => `P@${u.phaseM.toFixed(3)}`.padStart(14)).join(' |');
  console.log(`denom |${head} | 승자`);
  for (let d = 1; d <= maxBays; d++) {
    const vals = uniq.map((u) => u.baseScore * Math.min(1, u.quads / Math.max(1, Math.min(d, u.inFrame || d))));
    let wi = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[wi] + 1e-12) wi = i;
    console.log(
      `${String(d).padStart(5)} |${vals.map((v) => v.toFixed(6).padStart(14)).join(' |')} | P@${uniq[wi].phaseM.toFixed(3)} ` +
        `(재현율 ${uniq[wi].recall.toFixed(4)})`,
    );
  }
}
