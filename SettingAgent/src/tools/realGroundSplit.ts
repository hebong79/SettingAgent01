// 27-C 진단 하네스 — 실카 검출 면수 요동의 **성분 분해**(프레임 vs 지면모델).
//
// 왜 필요한가: 마스터가 "같은 뷰를 연속 실행했는데 6/4/2/4 면"을 관측했다. 원인 후보가 둘이다.
//   (가) **프레임 종속** — 14회차에 시뮬에서 확인된 성분(같은 PTZ·같은 코드인데 잡힌 프레임에 따라 ±6면).
//   (나) **지면모델 오배정** — 배너가 실카를 보면서 시뮬 카메라(높이 5m)의 모델을 표시하고 있다.
// 두 성분은 **다른 실험으로만** 갈린다. 이 도구는 한 번의 실행에서 둘을 각각 고립시킨다.
//
//   [A] 프레임 성분  — 지면모델을 **고정**(실측 설치고)하고 무이동 연속 캡처 N장 → 면수 산포.
//   [B] 모델 성분    — **한 프레임**(바이트 동일)에 설치고만 갈아끼워 → 면수 변화.
//   [C] 재현성       — 같은 프레임 · 같은 모델 2회 → 결정론 확인(산포의 기저선이 0인가).
//
// ★ PTZ 이동 명령 0건: snapshot(mode:'preset', ptz 미지정) 은 RealPtzSource 에서 move 를 부르지 않는다
//   (`RealPtzSource.snapshot`: mode==='manual' && ptz 일 때만 이동). 캡처마다 장비 PTZ 를 함께 읽어
//   **드리프트(무명령 변화)** 를 표에 남긴다 — 22회차에 명령 0건인데 zoompos 가 변한 관측이 있다.
// ★ 검출 알고리즘 0줄 변경. `src/ground/*`·`src/rpc/services/*` 는 **import 만** 한다.
// ★ 정본 `data/Place01/PtzCamRoi.json` **읽기만** · DB 무접촉 · `roi.auto.apply` 미호출.
// ★ 판정 수치는 전부 **원시 배정도**로 찍는다(toFixed 판정 금지 — 표시용 반올림만 별도).
//
// 사용: npx tsx src/tools/realGroundSplit.ts <sourceId> <N> <outDir>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics, interpolateHfov } from '../ground/cameraIntrinsics.js';
import { buildGroundInputs } from '../ground/groundInputs.js';
import { estimateGroundModels } from '../ground/groundModel.js';
import type { GroundModel } from '../ground/types.js';
import { readGroundSpec } from '../rpc/services/roiAuto.js';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { buildSourceRegistry } from '../viewer/sourceRegistry.js';
import { CameraSourceClient } from '../clients/CameraSourceClient.js';

const sourceId = process.argv[2] ?? 'real-camera-1';
const shots = Number(process.argv[3] ?? 5);
const outDir = process.argv[4] ?? 'reports/overlay_r27c';
if (!Number.isInteger(shots) || shots < 1) {
  console.error('사용: npx tsx src/tools/realGroundSplit.ts <sourceId> <N> <outDir>');
  process.exit(2);
}

const cfg = loadToolsConfig();
const src = buildSourceRegistry(cfg).get(sourceId);
if (!src) {
  console.error(`알 수 없는 소스: ${sourceId}`);
  process.exit(2);
}
const client = new CameraSourceClient(src, cfg.camera);
mkdirSync(outDir, { recursive: true });

// ── 검출 1회(순수) — 서비스와 **동일한 모듈·동일한 순서**. 알고리즘 무변경. ─────────────────
interface DetectOut {
  lines: number;
  tried: number;
  corners: number;
  quads: number;
  /** quad 정점 전체를 이어붙인 원시 문자열의 해시 — 재현성 비트 비교용(반올림 없음). */
  quadDigest: string;
  /** 렌더용 픽셀 quad(판정에는 쓰지 않는다). */
  quadsPx: Array<Array<{ x: number; y: number }>>;
}
function detectOnce(frame: FrameGray, W: number, H: number, model: GroundModel, heightM: number): DetectOut {
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const evidence = paintEvidenceOf(mask, W, H);
  const cands: RowCandidate[] = [];
  for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
    const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
    const seps = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
    const pts: Array<{ x: number; y: number }> = [];
    for (const sep of seps) {
      const q = meetLines(sep.line, front.line);
      if (q) pts.push(q);
    }
    cands.push({ front, cornersPx: pts });
  }
  const grid = detectBaysWithModel(
    cands,
    model,
    evidence,
    DEFAULT_PAINT_OPTIONS,
    // 뷰어에서 「예상 주차면 수」를 비운 경로와 같다(21회차 권장 = 개수 미사용).
    { ...DEFAULT_BAY_OPTS, cameraHeightM: heightM, expectedBays: 1, coverageDenom: 'phaseInvariant' },
    frame,
  );
  const best = grid.best;
  const raw = (best?.quads ?? []).map((q) => q.quad.map((p) => `${p.x},${p.y}`).join(';')).join('|');
  return {
    lines: lines.length,
    tried: grid.tried.length,
    corners: best?.cornersPx.length ?? 0,
    quads: best?.quads.length ?? 0,
    quadDigest: createHash('sha256').update(raw).digest('hex').slice(0, 12),
    quadsPx: (best?.quads ?? []).map((q) => q.quad.map((p) => ({ x: p.x, y: p.y }))),
  };
}

/** 같은 프레임 위에 arm 별 자동 quad 를 얹는다(육안 대조 전용 — 판정 수치는 표가 정본). */
async function renderArm(jpg: Buffer, W: number, H: number, title: string, out: DetectOut, file: string): Promise<void> {
  const parts = out.quadsPx.map(
    (q) => `<polygon points="${q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="#ff174422" stroke="#ff1744" stroke-width="3" stroke-dasharray="12,6"/>`,
  );
  parts.push('<rect x="14" y="14" width="1500" height="76" fill="#000000cc" rx="8"/>');
  const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  parts.push(`<text x="32" y="64" fill="#fff" font-size="30" font-weight="bold">${esc}</text>`);
  await sharp(jpg)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(file);
}

// ── 실카 제원(검출 경로가 실제로 쓰는 것) — lens_calibration + PTZ 피드백. ────────────────
const spec = readGroundSpec(process.env.LENS_CALIB_FILE ?? 'data/lens_calibration.json', sourceId);
if (spec.heightM == null || !spec.zoomHfov) {
  console.error(`제원 부족 — heightM=${spec.heightM} zoomHfov=${spec.zoomHfov?.length ?? 0}점`);
  process.exit(3);
}
const REAL_H = spec.heightM;

// ── 배너가 보여주는 **시뮬 파일 모델**(대조군) — /capture/ground-model 과 같은 조합. ───────
//    카메라 식별자를 받지 않는 라우트라 실카를 봐도 cam_id 1/2 의 모델이 나온다. 그 사실을 여기서 재현한다.
const fileModels = new Map<string, GroundModel>();
for (const camIn of buildGroundInputs(JSON.parse(readFileSync('data/Place01/PtzCamRoi.json', 'utf8')), [])) {
  for (const m of estimateGroundModels(camIn, cfg.ground).models) fileModels.set(`${m.camIdx}:${m.presetIdx}`, m);
}

// ── [A] 프레임 성분 — 무이동 연속 캡처 N장, 지면모델은 각 프레임의 자기 PTZ + 실측 설치고. ──
interface Shot {
  i: number;
  frameHash: string;
  tiltPos: number;
  zoomPos: number;
  W: number;
  H: number;
  f: number;
  tiltDeg: number;
  out: DetectOut;
  jpg: Buffer;
  frame: FrameGray;
  model: GroundModel;
}
const takenAt: string[] = [];
const shotsOut: Shot[] = [];
for (let i = 1; i <= shots; i++) {
  const t0 = new Date().toISOString();
  const cap = await client.requestImage(1, 1); // ptz 미지정 = 이동 없음.
  takenAt.push(t0);
  const frameHash = createHash('sha256').update(cap.jpg).digest('hex').slice(0, 12);
  const meta = await sharp(cap.jpg).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const gray = await sharp(cap.jpg).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gray.buffer, gray.byteOffset, gray.byteLength), width: W, height: H };
  const native = src.toNativePtz({ pan: cap.pan, tilt: cap.tilt, zoom: cap.zoom }) as { tilt: number; zoom: number };
  const hfov = interpolateHfov(spec.zoomHfov, native.zoom);
  if (hfov == null) {
    console.error(`#${i} 화각 보간 실패(zoompos ${native.zoom})`);
    process.exit(3);
  }
  const tiltDeg = native.tilt / 100;
  const model = groundModelFromIntrinsics(
    {
      camIdx: 1,
      presetIdx: 1,
      fovDeg: hfov,
      fovAxis: 'horizontal',
      tiltDeg,
      heightM: REAL_H,
      imgW: W,
      imgH: H,
      source: `real:${sourceId}(zoomHfov@z=${native.zoom}→${hfov}°, tilt ${tiltDeg}°←tiltpos ${native.tilt}/100, 설치고 ${REAL_H}m)`,
    },
    cap.zoom,
  );
  if (!model) {
    console.error(`#${i} 지면모델 생성 실패(hfov ${hfov} tilt ${tiltDeg})`);
    process.exit(3);
  }
  const out = detectOnce(frame, W, H, model, REAL_H);
  writeFileSync(join(outDir, `frame${i}_${frameHash}.jpg`), cap.jpg);
  shotsOut.push({ i, frameHash, tiltPos: native.tilt, zoomPos: native.zoom, W, H, f: model.f, tiltDeg, out, jpg: cap.jpg, frame, model });
}

// ── [B] 모델 성분 — **frame#1 고정**(바이트 동일). 설치고/모델만 갈아끼운다. ────────────────
const base = shotsOut[0];
interface Arm {
  id: string;
  note: string;
  model: GroundModel;
  heightM: number;
}
const arms: Arm[] = [{ id: 'REAL', note: `실측 설치고 ${REAL_H}m (검출 경로가 실제로 쓰는 값)`, model: base.model, heightM: REAL_H }];
// B-1: 설치고만 배너값으로 — 나머지(f·tilt)는 실카 그대로.
const baseHfov = interpolateHfov(spec.zoomHfov, base.zoomPos)!;
for (const key of ['1:1', '1:3']) {
  const fm = fileModels.get(key);
  if (!fm) continue;
  const swapped = groundModelFromIntrinsics(
    {
      camIdx: 1,
      presetIdx: 1,
      fovDeg: baseHfov,
      fovAxis: 'horizontal',
      tiltDeg: base.tiltDeg,
      heightM: fm.d,
      imgW: base.W,
      imgH: base.H,
      source: `설치고만 배너값(${key}) ${fm.d}m 로 교체`,
    },
    1,
  );
  if (swapped) arms.push({ id: `H<-${key}`, note: `설치고만 ${fm.d}m (배너 ${key} 의 카메라고)`, model: swapped, heightM: fm.d });
}
// B-2: 배너 모델을 **통째로** 적용 — f·tilt·설치고 전부 시뮬 파일값(= 배너가 말하는 그 모델).
for (const key of ['1:1', '1:3']) {
  const fm = fileModels.get(key);
  if (!fm) continue;
  arms.push({ id: `FULL<-${key}`, note: `배너 모델 통째(f=${fm.f} tilt=${fm.tiltDeg} d=${fm.d})`, model: { ...fm, imgW: base.W, imgH: base.H }, heightM: fm.d });
}
const armOut = arms.map((a) => ({ a, out: detectOnce(base.frame, base.W, base.H, a.model, a.heightM) }));
// 육안 대조 — **같은 프레임**(base.frameHash) 위에 arm 별 quad 를 얹는다.
for (const { a, out } of armOut) {
  await renderArm(
    base.jpg,
    base.W,
    base.H,
    `${a.id}  h=${a.heightM}m f=${a.model.f.toFixed(1)}px tilt=${a.model.tiltDeg.toFixed(2)}°  →  자동quad ${out.quads}  (frame ${base.frameHash})`,
    out,
    join(outDir, `arm_${a.id.replace(/[<>:]/g, '_')}.png`),
  );
}
// 프레임 성분 육안 대조 — **같은 모델**로 서로 다른 프레임을 얹는다.
for (const s of shotsOut) {
  await renderArm(s.jpg, s.W, s.H, `frame#${s.i} ${s.frameHash}  h=${REAL_H}m f=${s.f.toFixed(1)}px (모델 동일)  →  자동quad ${s.out.quads}`, s.out, join(outDir, `frame${s.i}_${s.frameHash}.png`));
}

// ── [C] 재현성 — 같은 프레임·같은 모델 2회. 산포의 기저선이 0인지 확인한다. ─────────────────
const rep1 = detectOnce(base.frame, base.W, base.H, base.model, REAL_H);
const rep2 = detectOnce(base.frame, base.W, base.H, base.model, REAL_H);

// ── 보고 ──────────────────────────────────────────────────────────────────────────────
const uniqHash = new Set(shotsOut.map((s) => s.frameHash));
const counts = shotsOut.map((s) => s.out.quads);
const uniqPtz = new Set(shotsOut.map((s) => `${s.tiltPos}/${s.zoomPos}`));
const lines: string[] = [];
lines.push(`═══ 27-C 성분분해 · ${sourceId} · ${new Date().toISOString()} ═══`);
lines.push(`제원: 설치고 ${REAL_H}m←lens_calibration · zoomHfov ${spec.zoomHfov.length}점(${spec.zoomHfovFrom}) · PTZ 이동 명령 0건`);
lines.push('');
lines.push('[A] 프레임 성분 — 무이동 연속 캡처(지면모델은 각 프레임의 자기 PTZ + 실측 설치고)');
lines.push('  #  frameHash     tiltpos zoompos     f(px)                직선  가설  코너  quads  quadDigest');
for (const s of shotsOut) {
  lines.push(
    `  ${String(s.i).padStart(2)}  ${s.frameHash}  ${String(s.tiltPos).padStart(6)} ${String(s.zoomPos).padStart(6)}  ` +
      `${String(s.f).padEnd(20)} ${String(s.out.lines).padStart(4)}  ${String(s.out.tried).padStart(4)}  ` +
      `${String(s.out.corners).padStart(4)}  ${String(s.out.quads).padStart(5)}  ${s.out.quadDigest}`,
  );
}
lines.push(`  → 서로 다른 프레임 ${uniqHash.size}/${shotsOut.length} · 서로 다른 PTZ ${uniqPtz.size}/${shotsOut.length} · 면수 [${counts.join(', ')}] 폭 ${Math.max(...counts) - Math.min(...counts)}`);
lines.push('');
lines.push(`[B] 모델 성분 — frame#1(${base.frameHash}) **바이트 고정**, 지면모델만 교체`);
lines.push('  arm         설치고(m)            f(px)                tilt(°)              직선  가설  코너  quads  quadDigest');
for (const { a, out } of armOut) {
  lines.push(
    `  ${a.id.padEnd(11)} ${String(a.heightM).padEnd(20)} ${String(a.model.f).padEnd(20)} ${String(a.model.tiltDeg).padEnd(20)} ` +
      `${String(out.lines).padStart(4)}  ${String(out.tried).padStart(4)}  ${String(out.corners).padStart(4)}  ${String(out.quads).padStart(5)}  ${out.quadDigest}`,
  );
}
for (const { a } of armOut) lines.push(`      ${a.id} = ${a.note}`);
lines.push('');
lines.push('[C] 재현성 — 같은 프레임·같은 모델 2회');
lines.push(`  quads ${rep1.quads} vs ${rep2.quads} · quadDigest ${rep1.quadDigest} vs ${rep2.quadDigest} → ${rep1.quadDigest === rep2.quadDigest ? '비트 동일(결정론)' : '★ 불일치 — 비결정 성분 존재'}`);
const report = lines.join('\n');
console.log(report);
writeFileSync(join(outDir, 'split_report.txt'), `${report}\n`, 'utf8');
writeFileSync(
  join(outDir, 'split_raw.json'),
  `${JSON.stringify(
    {
      sourceId,
      takenAt,
      realHeightM: REAL_H,
      shots: shotsOut.map((s) => ({ i: s.i, frameHash: s.frameHash, tiltPos: s.tiltPos, zoomPos: s.zoomPos, W: s.W, H: s.H, f: s.f, tiltDeg: s.tiltDeg, ...s.out })),
      arms: armOut.map(({ a, out }) => ({ id: a.id, note: a.note, heightM: a.heightM, f: a.model.f, tiltDeg: a.model.tiltDeg, d: a.model.d, ...out })),
      repeat: [rep1, rep2],
      fileModels: [...fileModels].map(([k, m]) => ({ key: k, f: m.f, tiltDeg: m.tiltDeg, d: m.d, source: m.source, metricErr: m.metricErr, conf: m.conf })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`\n산출: ${join(outDir, 'split_report.txt')} · ${join(outDir, 'split_raw.json')} · frame*.jpg ${shotsOut.length}장`);
