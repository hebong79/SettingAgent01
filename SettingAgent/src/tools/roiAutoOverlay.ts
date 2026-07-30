// V13 육안 검증 오버레이 — 실제 구현 모듈(floorPaint/bayGeometry)을 그대로 통과시켜 렌더한다.
// 초록=수동 정본 / 빨강=자동 quad / 노랑=선택된 전방선 / 파랑=선택된 분리선 / 회색=검출된 전체 직선.
// 정본·DB 무접촉(읽기만). 사용:
//   npx tsx src/tools/roiAutoOverlay.ts <frameDir> <outDir> [placeRoiFile]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  type RefinedLine,
} from '../ground/floorPaint.js';
import { DEFAULT_BAY_OPTS } from '../ground/bayGeometry.js';
import { detectBaysWithModel, type RowCandidate } from '../ground/bayGrid.js';
import { groundModelFromIntrinsics } from '../ground/cameraIntrinsics.js';
import { placeMetaProvider, readPlaceMeta } from '../ground/placeMetaIntrinsics.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';

const dir = process.argv[2];
const outDir = process.argv[3];
const placeFile = process.argv[4] ?? 'data/Place01/PtzCamRoi.json';
if (!dir || !outDir) {
  console.error('사용: npx tsx src/tools/roiAutoOverlay.ts <frameDir> <outDir> [placeRoiFile]');
  process.exit(2);
}

const placeJson = JSON.parse(readFileSync(placeFile, 'utf8'));
const { byPreset } = normalizePtzCamRoi(placeJson);
/** 제원 전용 뷰(주차면 무참조). */
const intrinsics = placeMetaProvider(readPlaceMeta(placeJson));
// ★ 15회차 — **골든 세트(JPG)** 도 읽는다. 기존 라이브 캐시(`frame_{cam}_{preset}.json`)는 그대로 지원.
//   골든은 `frame_{cam}_{preset}_d{i}.jpg` + `manifest.json`(zoom 출처) 형식이고, 디더 시점은 4번째 인자로 고른다(기본 0).
const ditherIdx = Number(process.argv[5] ?? 0);
const goldenManifest = existsSync(join(dir, 'manifest.json'))
  ? (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { frames: Array<{ file: string; ptz?: { zoom?: number } }> })
  : null;
const files = readdirSync(dir)
  .filter((f) => /^frame_\d+_\d+\.json$/.test(f) || new RegExp(`^frame_\\d+_\\d+_d${ditherIdx}\\.jpg$`).test(f))
  .sort();

/** 동차직선 [a,b,c] (ax+by+c=0) 을 프레임 경계까지 늘려 선분 2점으로. */
function seg(l: readonly [number, number, number], W: number, H: number): [number, number, number, number] | null {
  const [a, b, c] = l;
  const pts: Array<[number, number]> = [];
  const ok = (x: number, y: number) => x >= -2 && x <= W + 2 && y >= -2 && y <= H + 2;
  if (Math.abs(b) > 1e-9) {
    const y0 = -(a * 0 + c) / b, y1 = -(a * W + c) / b;
    if (ok(0, y0)) pts.push([0, y0]);
    if (ok(W, y1)) pts.push([W, y1]);
  }
  if (Math.abs(a) > 1e-9) {
    const x0 = -(b * 0 + c) / a, x1 = -(b * H + c) / a;
    if (ok(x0, 0)) pts.push([x0, 0]);
    if (ok(x1, H)) pts.push([x1, H]);
  }
  if (pts.length < 2) return null;
  return [pts[0][0], pts[0][1], pts[1][0], pts[1][1]];
}
const L = (s: [number, number, number, number], stroke: string, w: number, op = 1, dash = '') =>
  `<line x1="${s[0].toFixed(1)}" y1="${s[1].toFixed(1)}" x2="${s[2].toFixed(1)}" y2="${s[3].toFixed(1)}" stroke="${stroke}" stroke-width="${w}" opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

for (const f of files) {
  const m = /^frame_(\d+)_(\d+)(?:_d\d+)?\.(json|jpg)$/.exec(f);
  if (!m) continue;
  const camId = Number(m[1]), presetIdx = Number(m[2]);
  const key = `${camId}:${presetIdx}`;
  let jpg: Buffer;
  let zoom: number | undefined;
  if (m[3] === 'jpg') {
    // 골든 세트 — 이미지가 파일 그대로다. zoom 은 manifest 에서 가져온다(없으면 아래 기본 1).
    jpg = readFileSync(join(dir, f));
    zoom = goldenManifest?.frames.find((fr) => fr.file === f)?.ptz?.zoom;
  } else {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      result: { img_bytes: string; width: number; height: number };
      preset?: { zoom?: number };
    };
    jpg = Buffer.from(j.result.img_bytes, 'base64');
    zoom = j.preset?.zoom;
  }
  const meta = await sharp(jpg).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;

  const grayBuf = await sharp(jpg).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength), width: W, height: H };

  const manual = byPreset.get(key) ?? [];
  const bays = manual.filter((s) => Array.isArray(s.points) && s.points.length === 4).length;

  // ★ 7회차 P0 — **현재 자동 경로(bayGrid: 제원 주입 + 위상 탐색)** 와 동일한 호출로 재배선했다.
  //   이전에는 폐기된 `detectBays`(소실점 추정) 를 불러서 V13 이 실제 동작과 다른 그림을 보여 주고 있었다.
  const { lines, mask } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const ev = paintEvidenceOf(mask, W, H);
  const intr = intrinsics.get(camId, presetIdx);
  const model = intr ? groundModelFromIntrinsics(intr, zoom ?? 1) : null;
  const cands: RowCandidate[] = [];
  if (model) {
    for (const front of lines.slice(0, DEFAULT_PAINT_OPTIONS.frontCandidates)) {
      const peaks = scanSeparators(frame, mask, front, DEFAULT_PAINT_OPTIONS);
      const refined = peaks.length ? refineSeparators(frame, peaks, DEFAULT_PAINT_OPTIONS) : [];
      const pts: Array<{ x: number; y: number }> = [];
      for (const sep of refined) {
        const q = meetLines(sep.line, front.line);
        if (q) pts.push(q);
      }
      cands.push({ front, cornersPx: pts });
    }
  }
  const grid = model ? detectBaysWithModel(cands, model, ev, DEFAULT_PAINT_OPTIONS, { ...DEFAULT_BAY_OPTS, expectedBays: Math.max(1, bays) }, frame) : null;
  const best = grid?.best ?? null;
  const det = {
    frontLine: best ? best.frontLine : null,
    separators: [] as Array<readonly [number, number, number]>,
    cornersPx: best ? best.cornersPx : [],
    quads: best ? best.quads : [],
    focalPx: model ? model.f : null,
    cameraHeightM: best?.calibration ? best.calibration.correctedM : (model ? model.d : null),
    diag: { hypotheses: grid?.tried.length ?? 0, rowResidPx: null as number | null },
  };

  const parts: string[] = [];
  // 검출된 전체 직선(회색, 배경)
  for (const ln of lines) { const s = seg(ln.line, W, H); if (s) parts.push(L(s, '#888888', 1, 0.35)); }
  // 선택된 분리선(파랑)
  for (const sp of det.separators) { const s = seg(sp, W, H); if (s) parts.push(L(s, '#2979ff', 2.2, 0.9)); }
  // 선택된 전방선(노랑)
  if (det.frontLine) { const s = seg(det.frontLine, W, H); if (s) parts.push(L(s, '#ffea00', 3.5, 1)); }
  // 근변 코너(주황 점)
  for (const c of det.cornersPx) parts.push(`<circle cx="${(c.x).toFixed(1)}" cy="${(c.y).toFixed(1)}" r="7" fill="none" stroke="#ff9100" stroke-width="3"/>`);
  // 수동 정본(초록)
  for (const sp of manual) {
    if (!Array.isArray(sp.points) || sp.points.length < 3) continue;
    parts.push(`<polygon points="${sp.points.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(' ')}" fill="none" stroke="#00e676" stroke-width="4"/>`);
  }
  // 자동 quad(빨강)
  // ★ 수정(구현자, 2회차): `BayQuad` 의 필드는 `points` 가 아니라 **`quad`** 이고 좌표는 **이미 픽셀**이다.
  //   기존 코드는 `q.points ?? q` 로 quad 객체 자체를 점 배열로 오인했고(타입 에러), 게다가 `p.x * W` 로
  //   정규화 좌표인 양 1920 배 확대해 그렸다. 그래서 자동 quad 가 **항상** 화면 밖으로 나갔다.
  //   → 루프1 육안 진단의 "자동 quad 가 화면 밖" 은 알고리즘이 아니라 **이 렌더 버그**가 만든 상일 수 있다.
  for (const q of det.quads) {
    const pts = q.quad;
    if (!Array.isArray(pts) || pts.length < 3) continue;
    parts.push(`<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="#ff174422" stroke="#ff1744" stroke-width="3" stroke-dasharray="12,6"/>`);
  }

  parts.push(`<rect x="14" y="14" width="900" height="150" fill="#000000cc" rx="8"/>`);
  parts.push(`<text x="32" y="52" fill="#fff" font-size="26" font-weight="bold">${key}  직선 ${lines.length} · 가설 ${det.diag.hypotheses ?? '-'} · 코너 ${det.cornersPx.length} · 자동quad ${det.quads.length} · 수동 ${bays}면</text>`);
  parts.push(`<text x="32" y="88" fill="#ddd" font-size="21">f=${det.focalPx?.toFixed(1) ?? '--'}px  camH=${det.cameraHeightM?.toFixed(3) ?? '--'}m  rowResid=${det.diag.rowResidPx?.toFixed(2) ?? '--'}px</text>`);
  parts.push(`<text x="32" y="122" fill="#00e676" font-size="20">━ 수동  <tspan fill="#ff1744">┄ 자동quad</tspan>  <tspan fill="#ffea00">━ 선택 전방선</tspan>  <tspan fill="#2979ff">━ 선택 분리선</tspan>  <tspan fill="#ff9100">○ 근변코너</tspan>  <tspan fill="#888">━ 검출 전체직선</tspan></text>`);
  parts.push(`<text x="32" y="150" fill="#999" font-size="17">실제 구현 모듈 통과 · 정본 무접촉</text>`);

  const out = join(outDir, `overlay_${key.replace(':', '_')}.png`);
  await sharp(jpg).composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }]).png().toFile(out);
  console.log(`${key}: 직선 ${lines.length} 코너 ${det.cornersPx.length} quad ${det.quads.length} f=${det.focalPx?.toFixed(0) ?? '--'} camH=${det.cameraHeightM?.toFixed(2) ?? '--'} → ${out}`);
}
