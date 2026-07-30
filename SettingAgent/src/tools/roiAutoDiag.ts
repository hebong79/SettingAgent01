// 진단 — "참 전방선이 검출 직선 집합 안에 있는가?"
// 이 답이 다음 라운드의 방향을 가른다:
//   있다 → 검출은 되고 **선별**이 틀렸다(가설 점수 문제)
//   없다 → **검출** 자체가 참 선을 못 만든다(마스크·Hough 문제)
// 수동 ROI 는 여기서 **진단 자로만** 쓴다(파이프라인 입력 아님 — hold-out 유지).
// 정본·DB 무접촉(읽기만).
//   npx tsx src/tools/roiAutoDiag.ts <frameDir> [placeRoiFile]

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PAINT_OPTIONS, detectPaintLines, type FrameGray } from '../ground/floorPaint.js';
import { normalizePtzCamRoi } from '../capture/placeRoi.js';

const dir = process.argv[2];
const placeFile = process.argv[3] ?? 'data/Place01/PtzCamRoi.json';
if (!dir) { console.error('사용: npx tsx src/tools/roiAutoDiag.ts <frameDir> [placeRoiFile]'); process.exit(2); }

const { byPreset } = normalizePtzCamRoi(JSON.parse(readFileSync(placeFile, 'utf8')));
const files = readdirSync(dir).filter((f) => /^frame_\d+_\d+\.json$/.test(f)).sort();

/** 점 → 동차직선 거리(px). */
const dist = (l: readonly [number, number, number], x: number, y: number) =>
  Math.abs(l[0] * x + l[1] * y + l[2]) / Math.hypot(l[0], l[1]);

/** 두 점을 지나는 동차직선. */
function through(ax: number, ay: number, bx: number, by: number): [number, number, number] {
  return [ay - by, bx - ax, ax * by - bx * ay];
}

for (const f of files) {
  const m = /^frame_(\d+)_(\d+)\.json$/.exec(f);
  if (!m) continue;
  const camId = Number(m[1]), presetIdx = Number(m[2]);
  const key = `${camId}:${presetIdx}`;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { result: { img_bytes: string; width: number; height: number } };
  const jpg = Buffer.from(j.result.img_bytes, 'base64');
  const W = j.result.width, H = j.result.height;
  const gray = await sharp(jpg).greyscale().raw().toBuffer();
  const frame: FrameGray = { data: new Uint8Array(gray.buffer, gray.byteOffset, gray.byteLength), width: W, height: H };

  const { lines } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
  const manual = (byPreset.get(key) ?? []).filter((s) => Array.isArray(s.points) && s.points.length === 4);
  if (!manual.length) { console.log(`${key}: 수동 4점 슬롯 없음 — 건너뜀`); continue; }

  // 수동 quad 의 네 변 중 "가장 아래(y 최대)" 변을 참 전방선으로 본다(카메라에 가까운 변).
  // 전 슬롯의 참 전방변을 모아 하나의 직선으로 최소제곱하지 않고, 슬롯별로 각각 대조한다.
  const truths: Array<{ idx: number; line: [number, number, number]; mid: { x: number; y: number } }> = [];
  for (const sp of manual) {
    const P = sp.points.map((p) => ({ x: p.x * W, y: p.y * H }));
    let best = -1, bestY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      const my = (a.y + b.y) / 2;
      if (my > bestY) { bestY = my; best = i; }
    }
    const a = P[best], b = P[(best + 1) % 4];
    truths.push({ idx: sp.idx, line: through(a.x, a.y, b.x, b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }

  // 참 전방선(슬롯별)에 대해, 검출 직선 중 가장 가까운 것을 찾는다.
  console.log(`\n=== ${key}  검출직선 ${lines.length}개 / 수동 ${manual.length}면`);
  let inTop8 = 0, within3 = 0;
  for (const t of truths) {
    let bestRank = -1, bestD = Infinity, bestAng = 0;
    lines.forEach((ln, rank) => {
      // 중점에서의 법선거리 + 각도차로 판정
      const d = dist(ln.line, t.mid.x, t.mid.y);
      const a1 = Math.atan2(ln.line[0], -ln.line[1]);
      const a2 = Math.atan2(t.line[0], -t.line[1]);
      let da = Math.abs(a1 - a2) * 180 / Math.PI; da = Math.min(da, 180 - da);
      const cost = d + da * 6; // 1° ≈ 6px 로 환산해 결합
      if (cost < bestD) { bestD = cost; bestRank = rank; bestAng = da; }
    });
    const ln = lines[bestRank];
    const dMid = dist(ln.line, t.mid.x, t.mid.y);
    if (bestRank < 8) inTop8++;
    if (dMid <= 3) within3++;
    console.log(
      `  idx${String(t.idx).padStart(2)}: 최근접 검출선 rank=${String(bestRank).padStart(2)}/${lines.length}  ` +
      `법선거리=${dMid.toFixed(2)}px  각도차=${bestAng.toFixed(2)}°  ` +
      `폭=${ln.widthPx.toFixed(1)}px 대비=${ln.contrast.toFixed(0)} span=${ln.spanPx.toFixed(0)}px resid=${ln.residPx.toFixed(2)}`
    );
  }
  console.log(`  ▶ 참 전방변에 3px 이내로 대응하는 검출선 있음: ${within3}/${truths.length}   그중 상위8(가설 후보) 안: ${inTop8}/${truths.length}`);
}
