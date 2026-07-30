// 실카 라이브 프레임 1장 육안 검증 오버레이(17b회차) — 리더가 결과를 **눈으로** 판정하기 위한 산출물.
//
// 기존 `roiAutoOverlay.ts` 를 확장하지 않고 새로 만든 이유:
//   그쪽은 **디렉터리에 쌓인 골든/캐시 프레임 배치**를 도는 도구이고 제원을 정본(PtzCamRoi.json)
//   메타에서만 얻는다. 실카는 프레임이 파일에 없고(라이브 캡처) 제원 출처도 다르다
//   (lens_calibration.cameraSpec + PTZ 피드백). 두 축을 한 파일에 섞으면 배치 도구가 실카 배선을
//   끌고 다니게 된다 — 분리가 각각 더 단순하다.
//
// ★ 실카에 PTZ 이동 명령을 보내지 않는다: snapshot(mode:'preset') = 현재 위치 그대로 캡처.
// ★ 수동 정본이 없으므로 **초록(정답)은 없다** — 빨강(자동 quad)·노랑(전방선)·회색(검출 직선)만 그려진다.
// ★ 정본·DB 무접촉(읽기만).
//
// 사용: npx tsx src/tools/realFrameOverlay.ts <sourceId> <outPng> [expectedBays|'-'] [heightM] [hfovDeg]
//   ★ 21회차 — `-` = 예상 주차면 수 **미사용**(coverageDenom='phaseInvariant' = 뷰어 칸을 비운 경로).
//     heightM·hfovDeg 는 뷰어 「카메라 제원」 칸과 같은 뜻의 **수동 지정**이다(비우면 실측표·파일값).
//     real-camera-1 처럼 파일에 cameraSpec.heightM 이 없는 카메라는 heightM 을 줘야 그린다.

import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
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
import { readGroundSpec } from '../rpc/services/roiAuto.js';
import { loadToolsConfig } from '../config/toolsConfig.js';
import { buildSourceRegistry } from '../viewer/sourceRegistry.js';
import { CameraSourceClient } from '../clients/CameraSourceClient.js';

const sourceId = process.argv[2];
const outPng = process.argv[3];
const baysArg = process.argv[4] ?? '-';
const noCount = baysArg === '-' || baysArg === '';
const expectedBays = noCount ? 0 : Number(baysArg);
const heightOverrideM = process.argv[5] != null && process.argv[5] !== '' ? Number(process.argv[5]) : null;
const hfovOverrideDeg = process.argv[6] != null && process.argv[6] !== '' ? Number(process.argv[6]) : null;
if (!sourceId || !outPng) {
  console.error("사용: npx tsx src/tools/realFrameOverlay.ts <sourceId> <outPng> [expectedBays|'-'] [heightM] [hfovDeg]");
  process.exit(2);
}

const cfg = loadToolsConfig();
const src = buildSourceRegistry(cfg).get(sourceId);
if (!src) {
  console.error(`알 수 없는 소스: ${sourceId}`);
  process.exit(2);
}

// 1) 현재 위치 그대로 프레임 1장(ptz 미지정 = mode:'preset' = 이동 없음).
const cap = await new CameraSourceClient(src, cfg.camera).requestImage(1, 1);
const frameHash = createHash('sha256').update(cap.jpg).digest('hex').slice(0, 12);
const meta = await sharp(cap.jpg).metadata();
const W = meta.width ?? 0;
const H = meta.height ?? 0;
const grayBuf = await sharp(cap.jpg).greyscale().raw().toBuffer();
const frame: FrameGray = { data: new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength), width: W, height: H };

// 2) 제원 — 서비스(roi.auto.detect)와 **같은 출처·같은 규칙**.
//    화각: readGroundSpec 의 zoomHfov(자체 실측표 또는 model 상속 프리셋)를 네이티브 zoompos 로 보간
//    틸트: 네이티브 tiltpos / 100 (centidegree · 양수=아래 — lens-calib geometry.ts:3-6 실측 확정)
//    설치고: lens_calibration.cameraSpec.heightM
const native = src.toNativePtz({ pan: cap.pan, tilt: cap.tilt, zoom: cap.zoom }) as { tilt: number; zoom: number };
const ground = readGroundSpec(process.env.LENS_CALIB_FILE ?? 'data/lens_calibration.json', sourceId);
const hfovAuto = ground.zoomHfov ? interpolateHfov(ground.zoomHfov, native.zoom) : null;
const hfov = hfovOverrideDeg ?? hfovAuto;
const heightM = heightOverrideM ?? ground.heightM;
const tiltDeg = native.tilt / 100;
if (hfov == null || heightM == null) {
  console.error(`제원 부족 — hfov=${hfov} heightM=${heightM} (data/lens_calibration.json 의 "${sourceId}".cameraSpec 또는 인자 heightM/hfovDeg 확인)`);
  process.exit(3);
}
const model = groundModelFromIntrinsics(
  {
    camIdx: 1,
    presetIdx: 1,
    fovDeg: hfov,
    fovAxis: 'horizontal',
    tiltDeg,
    heightM,
    imgW: W,
    imgH: H,
    source: `real:${sourceId}(${hfovOverrideDeg != null ? `hfov ${hfovOverrideDeg}° 수동지정(자동 ${hfovAuto?.toFixed(3) ?? '--'}°)` : `zoomHfov@z=${native.zoom}→${hfov.toFixed(3)}°←${ground.zoomHfovFrom}`}, tilt ${tiltDeg}°←tiltpos ${native.tilt}/100, 설치고 ${heightM}m${heightOverrideM != null ? ' 수동지정' : ''})`,
  },
  cap.zoom,
);
if (!model) {
  console.error(`지면모델 생성 실패(hfov ${hfov}° tilt ${tiltDeg}° h ${heightM}m) — 상향 시선이면 지면을 만나지 않는다`);
  process.exit(3);
}

// 3) 검출 — 서비스와 동일한 모듈·동일한 순서(알고리즘 무변경).
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
  {
    ...DEFAULT_BAY_OPTS,
    cameraHeightM: heightM,
    expectedBays: Math.max(1, expectedBays),
    coverageDenom: noCount ? 'phaseInvariant' : 'expectedBays',
  },
  frame,
);
const best = grid.best;

// 4) 렌더 — 색 규약은 roiAutoOverlay 와 같다(초록=수동 정본은 실카에 없다).
/** 동차직선 [a,b,c] 를 프레임 경계까지 늘려 선분 2점으로. */
function seg(l: readonly [number, number, number]): [number, number, number, number] | null {
  const [a, b, c] = l;
  const pts: Array<[number, number]> = [];
  const ok = (x: number, y: number) => x >= -2 && x <= W + 2 && y >= -2 && y <= H + 2;
  if (Math.abs(b) > 1e-9) {
    const y0 = -c / b;
    const y1 = -(a * W + c) / b;
    if (ok(0, y0)) pts.push([0, y0]);
    if (ok(W, y1)) pts.push([W, y1]);
  }
  if (Math.abs(a) > 1e-9) {
    const x0 = -c / a;
    const x1 = -(b * H + c) / a;
    if (ok(x0, 0)) pts.push([x0, 0]);
    if (ok(x1, H)) pts.push([x1, H]);
  }
  if (pts.length < 2) return null;
  return [pts[0][0], pts[0][1], pts[1][0], pts[1][1]];
}
const L = (s: [number, number, number, number], stroke: string, w: number, op = 1) =>
  `<line x1="${s[0].toFixed(1)}" y1="${s[1].toFixed(1)}" x2="${s[2].toFixed(1)}" y2="${s[3].toFixed(1)}" stroke="${stroke}" stroke-width="${w}" opacity="${op}"/>`;

const parts: string[] = [];
for (const ln of lines) {
  const s = seg(ln.line);
  if (s) parts.push(L(s, '#888888', 1, 0.35));
}
if (best) {
  const s = seg(best.frontLine);
  if (s) parts.push(L(s, '#ffea00', 3.5));
  for (const c of best.cornersPx) {
    parts.push(`<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="7" fill="none" stroke="#ff9100" stroke-width="3"/>`);
  }
  for (const q of best.quads) {
    parts.push(
      `<polygon points="${q.quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="#ff174422" stroke="#ff1744" stroke-width="3" stroke-dasharray="12,6"/>`,
    );
  }
}
const T = (y: number, fill: string, size: number, text: string) =>
  `<text x="32" y="${y}" fill="${fill}" font-size="${size}">${text}</text>`;
parts.push('<rect x="14" y="14" width="1180" height="196" fill="#000000cc" rx="8"/>');
parts.push(
  `<text x="32" y="52" fill="#fff" font-size="26" font-weight="bold">${sourceId}  직선 ${lines.length} · 가설 ${grid.tried.length} · 코너 ${best?.cornersPx.length ?? 0} · 자동quad ${best?.quads.length ?? 0} · expectedBays ${Math.max(1, expectedBays)}</text>`,
);
parts.push(
  T(88, '#ddd', 21, `f=${model.f.toFixed(2)}px  hfov=${hfov.toFixed(2)}°(수평${hfovOverrideDeg != null ? ' 수동' : ' 실측표'})  tilt=${tiltDeg.toFixed(2)}°(tiltpos ${native.tilt}/100)  설치고=${heightM}m  bays=${noCount ? '미사용' : expectedBays}  ${W}×${H}`),
);
parts.push(T(120, '#ddd', 21, `frameHash=${frameHash}  네이티브 zoompos=${native.zoom} tiltpos=${native.tilt}  뷰어 zoom=${cap.zoom.toFixed(3)}`));
// 표 밖 줌이면 화각이 끝점으로 클램프된 값이다 — 그 사실만 경고한다(표 안이면 조용하다).
const zs = (ground.zoomHfov ?? []).map((p) => p.z).filter((z) => Number.isFinite(z));
const clampNote =
  zs.length && (native.zoom < Math.min(...zs) || native.zoom > Math.max(...zs))
    ? `  ⚠ 줌 ${native.zoom} 이 표 범위 [${Math.min(...zs)}, ${Math.max(...zs)}] 밖 — 화각 클램프`
    : '';
parts.push(
  T(152, '#ffab40', 19, `zoomHfov ${ground.zoomHfov?.length ?? 0}점(${ground.zoomHfovFrom ?? '없음'}) · tilt 양수=아래(실측 확정)${clampNote}`),
);
parts.push(T(182, '#ff1744', 19, '┄ 자동quad   <tspan fill="#ffea00">━ 전방선</tspan>   <tspan fill="#ff9100">○ 근변코너</tspan>   <tspan fill="#888">━ 검출 전체직선</tspan>   <tspan fill="#999">(수동 정본 없음 = 초록 없음)</tspan>'));

mkdirSync(dirname(outPng), { recursive: true });
await sharp(cap.jpg)
  .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }])
  .png()
  .toFile(outPng);

console.log(
  JSON.stringify(
    {
      source: sourceId,
      frameHash,
      imgW: W,
      imgH: H,
      nativeZoom: native.zoom,
      nativeTilt: native.tilt,
      hfovDeg: hfov,
      tiltDeg,
      heightM,
      focalPx: model.f,
      lines: lines.length,
      hypotheses: grid.tried.length,
      quads: best?.quads.length ?? 0,
      issues: grid.issues,
      out: outPng,
    },
    null,
    2,
  ),
);
