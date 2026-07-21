// 검증자 goal/loop 1차 이터레이션 — 점유영역 사다리꼴 경험적 스샷 증거 생성.
//
// 실제 구현(web/occupancyRegion.js · web/occupancy.js · web/core.js)을 **그대로 import** 한다.
// 기하 재구현 없음 — 스샷이 검증하는 대상은 라이브 뷰어가 쓰는 바로 그 코드다.
//
// 파이프라인(app.js updateLogicOccupancy 와 동일 순서):
//   place-roi(raw) → normalizePtzCamRoi → selectFloorRoi(useLlm:false)
//   → OccupancyJudge.judge(floorPolys, detect) → plate 행 filter
//   → computeOccupancyRegions(items, CFG)
//
// 데이터: 라이브 POST /capture/detect (실검출). _qa_data/ 에 캐시 — 이후 재실행은 캐시로 오프라인 동작.
//   강제 재검출: node _qa_regions.mjs --refetch
//
// 사용:
//   SettingAgent> node _workspace/_qa_regions.mjs [--refetch] [--top=0.85] [--up=0.55] [--down=0.30]
// 출력: _workspace/_qa_shots/iter1_cam1_p{1,2,3}.png, iter1_stress.png + stdout 수치 로그.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { normalizePtzCamRoi, selectFloorRoi, presetKey, quadCentroid } from '../web/core.js';
import { OccupancyJudge, convexIntersectionArea } from '../web/occupancy.js';
import { computeOccupancyRegions, plateAxes } from '../web/occupancyRegion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // SettingAgent/
const SHOTS = join(HERE, '_qa_shots');
const CACHE = join(HERE, '_qa_data');
const BASE = 'http://localhost:13020';
const CAM = 1;
const PRESETS = [1, 2, 3];

// ── 튜닝 파라미터(재실행 시 인자로 덮어쓰기 가능) ──────────────────────────
const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const CFG = {
  topWidthRatio: argOf('top', undefined),
  upRatio: argOf('up', undefined),
  downRatio: argOf('down', undefined),
  widthScaleMin: argOf('smin', undefined),
  widthScaleMax: argOf('smax', undefined),
};
for (const k of Object.keys(CFG)) if (CFG[k] === undefined) delete CFG[k]; // 미지정 → 구현 DEFAULTS.
const REFETCH = process.argv.includes('--refetch');

// ── 데이터 확보(라이브 실검출 → 캐시) ──────────────────────────────────────
async function fetchJson(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function cached(name, loader) {
  const file = join(CACHE, name);
  if (!REFETCH && existsSync(file)) return { data: JSON.parse(readFileSync(file, 'utf8')), source: 'cache' };
  const data = await loader();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
  return { data, source: 'live' };
}

// ── 렌더 헬퍼 ──────────────────────────────────────────────────────────────
const PALETTE = ['#4da6ff', '#ff7ad9', '#7dff9e', '#ffd24d', '#b48cff', '#4dfff0', '#ff8c5a', '#9cff4d'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const px = (poly, W, H) => poly.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(' ');

function buildSvg(W, H, { floorPolys, plates, regions, header, note }) {
  const parts = [];
  // 주차면 폴리곤 — 얇은 흰색.
  for (const f of floorPolys) {
    parts.push(`<polygon points="${px(f.quad, W, H)}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>`);
  }
  // 사다리꼴 region — 인스턴스별 색상 반투명 채움 + 진한 윤곽.
  regions.forEach((g, i) => {
    const c = PALETTE[i % PALETTE.length];
    parts.push(`<polygon points="${px(g.polygon, W, H)}" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="3"/>`);
    const cen = g.polygon.reduce((a, p) => ({ x: a.x + p.x / g.polygon.length, y: a.y + p.y / g.polygon.length }), { x: 0, y: 0 });
    parts.push(
      `<text x="${(cen.x * W).toFixed(1)}" y="${(cen.y * H).toFixed(1)}" font-family="monospace" font-size="26" font-weight="bold" fill="${c}" stroke="#000" stroke-width="4" paint-order="stroke" text-anchor="middle">idx ${g.idx} s=${g.scale.toFixed(3)}</text>`,
    );
  });
  // 번호판 quad — 노란색 굵은 선 + 중심점.
  for (const q of plates) {
    parts.push(`<polygon points="${px(q, W, H)}" fill="none" stroke="#ffff00" stroke-width="4"/>`);
    const c = quadCentroid(q);
    if (c) parts.push(`<circle cx="${(c.x * W).toFixed(1)}" cy="${(c.y * H).toFixed(1)}" r="5" fill="#ffff00" stroke="#000" stroke-width="1.5"/>`);
  }
  // 상단 수치 오버레이.
  parts.push(`<rect x="0" y="0" width="${W}" height="${note ? 104 : 72}" fill="#000" fill-opacity="0.62"/>`);
  parts.push(`<text x="16" y="44" font-family="monospace" font-size="30" fill="#fff">${esc(header)}</text>`);
  if (note) parts.push(`<text x="16" y="84" font-family="monospace" font-size="24" fill="#ffd24d">${esc(note)}</text>`);
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;
}

async function compose(jpgPath, svg, outPath) {
  const buf = await sharp(jpgPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  writeFileSync(outPath, buf);
}

/** 전 쌍 교차면적 최대값(구현과 동일한 convexIntersectionArea 사용). */
function maxPairArea(regions) {
  let max = 0;
  let at = null;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = convexIntersectionArea(regions[i].polygon, regions[j].polygon);
      if (a > max) { max = a; at = [regions[i].idx, regions[j].idx]; }
    }
  }
  return { max, at };
}

// ── 메인 ───────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const judge = new OccupancyJudge();

  const roi = await cached('place_roi.json', () => fetchJson('/capture/place-roi'));
  const placeRoi = normalizePtzCamRoi(roi.data).byPreset;
  console.log(`[data] place-roi: ${roi.source}`);

  const rows = [];
  for (const preset of PRESETS) {
    const key = presetKey(CAM, preset);
    const det = await cached(`detect_cam${CAM}_p${preset}.json`, () => fetchJson('/capture/detect', { cam: CAM, preset }));
    const detect = det.data;
    const { width: W, height: H } = await sharp(join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`)).metadata();

    const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
    const judged = judge.judge(floorPolys, detect);
    const items = judged.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));
    const result = computeOccupancyRegions(items, CFG);
    const { max, at } = maxPairArea(result.regions);

    // 폭 배율 실측: region 폭 / 번호판 폭(구현 plateAxes 의 W 정의 그대로).
    const widths = items.map((it) => plateAxes(it.quad)?.width ?? NaN);

    const header = `cam${CAM}_p${preset}  globalScale=${result.globalScale ?? 'null(2단계 폴백)'}  regions=${result.regions.length}  overlapPairs=${JSON.stringify(result.overlapPairs)}  maxPairArea=${max.toExponential(2)}`;
    const note = `실검출(LPD/VPD 라이브, ${det.source})  plate점유=${items.length}/${floorPolys.length}면  판번폭평균=${(widths.reduce((a, b) => a + b, 0) / (widths.length || 1)).toFixed(4)}`;
    const svg = buildSvg(W, H, { floorPolys, plates: items.map((i) => i.quad), regions: result.regions, header, note });
    const out = join(SHOTS, `iter1_cam${CAM}_p${preset}.png`);
    await compose(join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`), svg, out);

    rows.push({ key, detSource: det.source, size: `${W}x${H}`, floors: floorPolys.length, plateOcc: items.length, ...result, max, at, out });
    console.log(`\n[${key}] detect=${det.source} ${W}x${H} 주차면=${floorPolys.length} plate점유=${items.length}`);
    console.log(`  globalScale = ${result.globalScale}`);
    console.log(`  regions     = ${result.regions.length}  scales=[${result.regions.map((g) => g.scale.toFixed(3)).join(', ')}]`);
    console.log(`  idx         = [${result.regions.map((g) => g.idx).join(', ')}]`);
    console.log(`  overlapPairs= ${JSON.stringify(result.overlapPairs)}`);
    console.log(`  maxPairArea = ${max.toExponential(3)} ${at ? `(idx ${at[0]}↔${at[1]})` : ''}   areaEps=1e-6`);
    console.log(`  → ${out}`);
  }

  // ── 스트레스: 번호판을 의도적으로 밀착 배치(3.5배에서 반드시 겹침) → 2단계 shrink 폴백 확인 ──
  // **합성 입력**(실검출 아님). p2 실프레임 위에 그린다. floorPolys/judge 를 우회하고
  // computeOccupancyRegions 에 직접 주입 — 검증 대상이 폴백 루프이기 때문.
  const preset = 2;
  const { width: W, height: H } = await sharp(join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`)).metadata();
  const PW = 0.030; // 번호판 폭(정규화) ≈ 실검출 평균 수준.
  const PH = 0.015;
  const GAP = 0.045; // 중심 간격 — 3.5×0.030=0.105 폭이므로 확실히 겹친다.
  const stressItems = [0, 1, 2].map((i) => {
    const cx = 0.30 + i * GAP;
    const cy = 0.55;
    return {
      idx: 100 + i,
      quad: [
        { x: cx - PW / 2, y: cy - PH / 2 }, { x: cx + PW / 2, y: cy - PH / 2 },
        { x: cx + PW / 2, y: cy + PH / 2 }, { x: cx - PW / 2, y: cy + PH / 2 },
      ],
    };
  });
  const before = computeOccupancyRegions(stressItems, { ...CFG, maxShrinkIters: 0 }); // 축소 전(3.5 고정) 기준선.
  const beforeMax = maxPairArea(before.regions);
  const stress = computeOccupancyRegions(stressItems, CFG);
  const sMax = maxPairArea(stress.regions);
  const sHeader = `STRESS(합성 밀착 번호판)  globalScale=${stress.globalScale ?? 'null(2단계 폴백)'}  regions=${stress.regions.length}  overlapPairs=${JSON.stringify(stress.overlapPairs)}  maxPairArea=${sMax.max.toExponential(2)}`;
  const sNote = `합성 입력 — 실검출 아님. 중심간격 ${GAP} · 판폭 ${PW}. shrink 전(3.5고정) maxPairArea=${beforeMax.max.toExponential(2)} → 후 ${sMax.max.toExponential(2)}`;
  const sSvg = buildSvg(W, H, { floorPolys: [], plates: stressItems.map((i) => i.quad), regions: stress.regions, header: sHeader, note: sNote });
  const sOut = join(SHOTS, 'iter1_stress.png');
  await compose(join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`), sSvg, sOut);

  console.log(`\n[STRESS] 합성 밀착 3개 (중심간격=${GAP}, 판폭=${PW})`);
  console.log(`  shrink 전(3.5 고정): maxPairArea=${beforeMax.max.toExponential(3)}  overlapPairs=${JSON.stringify(before.overlapPairs)}`);
  console.log(`  shrink 후          : globalScale=${stress.globalScale}  scales=[${stress.regions.map((g) => g.scale.toFixed(3)).join(', ')}]`);
  console.log(`                       maxPairArea=${sMax.max.toExponential(3)}  overlapPairs=${JSON.stringify(stress.overlapPairs)}`);
  console.log(`  → ${sOut}`);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
