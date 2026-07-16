// 검증자 goal/loop 3차 이터레이션 — (A) 축 수정 재촬영 + (B) upRatio 세로 길이 스윕.
//
// 1차 스크립트(_qa_regions.mjs)의 파이프라인·렌더 규약을 그대로 재사용한다.
// 실제 구현(web/occupancyRegion.js)을 import — 기하 재구현 없음. 구현 상수 수정 없음(cfg 주입만).
//
// 데이터 공정 비교:
//   _qa_data/       = 1차 이터레이션 검출 캐시(동일 입력 기준선)
//   _qa_data_iter3/ = 3차 라이브 재검출(--refetch 로 갱신) — 1차와의 동일성을 비교·보고
//   기본은 1차 캐시로 렌더한다(코드 변경만이 유일한 변수가 되도록). --live 로 3차 검출 사용.
//
// 사용:
//   SettingAgent> node _workspace/_qa_regions_iter3.mjs [--refetch] [--live]
// 출력:
//   _qa_shots/iter3_cam1_p{1,2,3}.png            (A)
//   _qa_shots/iter3_sweep_p{1,3}_up{055,090,130,170}.png  (B)
//   stdout 수치 로그(수준별 globalScale·overlapPairs·최대 교차면적·덮음률)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { normalizePtzCamRoi, selectFloorRoi, presetKey, quadCentroid } from '../web/core.js';
import { OccupancyJudge, convexIntersectionArea } from '../web/occupancy.js';
import { computeOccupancyRegions, plateAxes } from '../web/occupancyRegion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, '_qa_shots');
const CACHE1 = join(HERE, '_qa_data'); // 1차 검출 캐시.
const CACHE3 = join(HERE, '_qa_data_iter3'); // 3차 라이브 재검출.
const BASE = 'http://localhost:13020';
const CAM = 1;
const PRESETS = [1, 2, 3];

const REFETCH = process.argv.includes('--refetch');
const USE_LIVE = process.argv.includes('--live');

// B 스윕: downRatio·topWidthRatio 고정, upRatio 4수준.
const SWEEP_UPS = [0.55, 0.9, 1.3, 1.7];
const SWEEP_FIXED = { downRatio: 0.3, topWidthRatio: 0.85 };
const upTag = (u) => String(Math.round(u * 100)).padStart(3, '0');

// ── 데이터 ────────────────────────────────────────────────────────────────
async function fetchJson(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function cachedIn(dir, name, loader) {
  const file = join(dir, name);
  if (!REFETCH && existsSync(file)) return { data: JSON.parse(readFileSync(file, 'utf8')), source: 'cache' };
  const data = await loader();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
  return { data, source: 'live' };
}

const readCache1 = (name) => JSON.parse(readFileSync(join(CACHE1, name), 'utf8'));

// ── 렌더(1차와 동일 규약) ─────────────────────────────────────────────────
const PALETTE = ['#4da6ff', '#ff7ad9', '#7dff9e', '#ffd24d', '#b48cff', '#4dfff0', '#ff8c5a', '#9cff4d'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const px = (poly, W, H) => poly.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(' ');

function buildSvg(W, H, { floorPolys, plates, regions, header, note, vehicleRects = [] }) {
  const parts = [];
  for (const f of floorPolys) {
    parts.push(`<polygon points="${px(f.quad, W, H)}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>`);
  }
  // 차량 bbox(덮음률 분모) — 얇은 회색 점선. 지표의 실체를 스샷에서 눈으로 확인하기 위함.
  for (const r of vehicleRects) {
    parts.push(
      `<rect x="${(r.x * W).toFixed(1)}" y="${(r.y * H).toFixed(1)}" width="${(r.w * W).toFixed(1)}" height="${(r.h * H).toFixed(1)}" fill="none" stroke="#cccccc" stroke-opacity="0.75" stroke-width="2" stroke-dasharray="10 6"/>`,
    );
  }
  regions.forEach((g, i) => {
    const c = PALETTE[i % PALETTE.length];
    parts.push(`<polygon points="${px(g.polygon, W, H)}" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="3"/>`);
    const cen = g.polygon.reduce((a, p) => ({ x: a.x + p.x / g.polygon.length, y: a.y + p.y / g.polygon.length }), { x: 0, y: 0 });
    parts.push(
      `<text x="${(cen.x * W).toFixed(1)}" y="${(cen.y * H).toFixed(1)}" font-family="monospace" font-size="26" font-weight="bold" fill="${c}" stroke="#000" stroke-width="4" paint-order="stroke" text-anchor="middle">idx ${g.idx} s=${g.scale.toFixed(3)}</text>`,
    );
  });
  for (const q of plates) {
    parts.push(`<polygon points="${px(q, W, H)}" fill="none" stroke="#ffff00" stroke-width="4"/>`);
    const c = quadCentroid(q);
    if (c) parts.push(`<circle cx="${(c.x * W).toFixed(1)}" cy="${(c.y * H).toFixed(1)}" r="5" fill="#ffff00" stroke="#000" stroke-width="1.5"/>`);
  }
  parts.push(`<rect x="0" y="0" width="${W}" height="${note ? 104 : 72}" fill="#000" fill-opacity="0.62"/>`);
  parts.push(`<text x="16" y="44" font-family="monospace" font-size="30" fill="#fff">${esc(header)}</text>`);
  if (note) parts.push(`<text x="16" y="84" font-family="monospace" font-size="24" fill="#ffd24d">${esc(note)}</text>`);
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;
}

async function compose(jpgPath, svg, outPath) {
  const buf = await sharp(jpgPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  writeFileSync(outPath, buf);
}

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

// ── 덮음률 지표 ───────────────────────────────────────────────────────────
// 정의: coverage(idx) = area(region ∩ vehicleRect) / area(vehicleRect).
//   vehicleRect = VPD vehicles[].rect (축정렬 bbox, 정규화). 1차 보고서 §2 와 동일 정의.
//   매칭: plate quad ↔ vehicles[].plate.quad 좌표 동일성(judge 의 plates 는 detect.plates 와
//         vehicles[].plate 의 합집합이므로, vehicle 유래 plate 만 대응 차량을 가진다).
//   한계: bbox 는 차량 실루엣이 아니다(사선뷰에서 차 대각 길이를 담는 축정렬 사각 → 빈 공간 포함).
const rectPoly = (r) => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
];
const quadKey = (q) => q.map((p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`).join(';');

function vehicleIndex(detect) {
  const m = new Map();
  for (const v of detect?.vehicles ?? []) if (v?.plate?.quad) m.set(quadKey(v.plate.quad), v.rect);
  return m;
}

function coverageOf(region, rect) {
  if (!rect) return null;
  const a = convexIntersectionArea(region.polygon, rectPoly(rect));
  const av = rect.w * rect.h;
  return av > 0 ? a / av : null;
}

// 【보조 지표 — 주 지표(덮음률) 대체 아님】 이웃 차량 침범률.
//   intrude(idx) = max_{다른 차량 j} area(region ∩ rect_j) / area(rect_j)
//   R1/Goal④ 의 "옆차 미침범"은 region↔region 겹침(overlapPairs)과 다른 질문이라 별도 관측.
//   한계: (1) bbox 는 실루엣이 아니고 (2) 사선뷰에서 차량 bbox 끼리 이미 서로 크게 겹치므로
//         upRatio 와 무관한 바닥값이 깔린다. 절대값이 아니라 **수준 간 증가폭**만 읽어야 한다.
function intrusionOf(region, ownRect, allRects) {
  let max = 0;
  for (const r of allRects) {
    if (!r || r === ownRect) continue;
    const av = r.w * r.h;
    if (av <= 0) continue;
    max = Math.max(max, convexIntersectionArea(region.polygon, rectPoly(r)) / av);
  }
  return max;
}

// ── 파이프라인 1회분 ──────────────────────────────────────────────────────
function pipeline(judge, placeRoi, detect, preset, cfg) {
  const key = presetKey(CAM, preset);
  const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
  const judged = judge.judge(floorPolys, detect);
  const items = judged.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));
  const result = computeOccupancyRegions(items, cfg);
  const vidx = vehicleIndex(detect);
  const rects = new Map(items.map((it) => [it.idx, vidx.get(quadKey(it.quad)) ?? null]));
  const allRects = (detect?.vehicles ?? []).map((v) => v.rect).filter(Boolean);
  const cov = result.regions.map((g) => ({
    idx: g.idx,
    cov: coverageOf(g, rects.get(g.idx)),
    intr: intrusionOf(g, rects.get(g.idx), allRects),
  }));
  return { key, floorPolys, items, result, rects, cov, ...maxPairArea(result.regions) };
}

const fmtCov = (cov) => cov.map((c) => `${c.idx}:${c.cov === null ? 'n/a' : (c.cov * 100).toFixed(1) + '%'}`).join(' ');
const fmtIntr = (cov) => cov.map((c) => `${c.idx}:${(c.intr * 100).toFixed(1)}%`).join(' ');
const intrMean = (cov) => cov.reduce((a, c) => a + c.intr, 0) / (cov.length || 1);
const covStats = (cov) => {
  const v = cov.filter((c) => c.cov !== null).map((c) => c.cov);
  return v.length ? { min: Math.min(...v), max: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length, n: v.length } : null;
};

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const judge = new OccupancyJudge();

  // ---- 검출 동일성 비교 (1차 캐시 vs 3차 라이브) ----
  const roi3 = await cachedIn(CACHE3, 'place_roi.json', () => fetchJson('/capture/place-roi'));
  console.log(`[data] place-roi(iter3): ${roi3.source}`);
  const roi1 = readCache1('place_roi.json');
  console.log(`[동일성] place-roi 1차↔3차: ${JSON.stringify(roi1) === JSON.stringify(roi3.data) ? '동일' : '*** 상이 ***'}`);

  const det1 = {};
  const det3 = {};
  for (const preset of PRESETS) {
    det1[preset] = readCache1(`detect_cam${CAM}_p${preset}.json`);
    const c = await cachedIn(CACHE3, `detect_cam${CAM}_p${preset}.json`, () => fetchJson('/capture/detect', { cam: CAM, preset }));
    det3[preset] = c.data;
    const same = JSON.stringify(det1[preset]) === JSON.stringify(det3[preset]);
    const p1n = (det1[preset].plates ?? []).length;
    const p3n = (det3[preset].plates ?? []).length;
    const v1n = (det1[preset].vehicles ?? []).length;
    const v3n = (det3[preset].vehicles ?? []).length;
    console.log(`[동일성] detect p${preset} (${c.source}): ${same ? '완전 동일' : '*** 상이 ***'}  plates ${p1n}→${p3n}  vehicles ${v1n}→${v3n}`);
  }

  const placeRoi = normalizePtzCamRoi(USE_LIVE ? roi3.data : roi1).byPreset;
  const detOf = (p) => (USE_LIVE ? det3[p] : det1[p]);
  console.log(`\n[렌더 입력] ${USE_LIVE ? '3차 라이브 검출' : '1차 캐시 검출(공정 비교 — 코드 변경만이 변수)'}\n`);

  // ---- A: 축 수정 재촬영 ----
  console.log('══ A. 축 수정 재촬영 (기본 cfg: 구현 DEFAULTS) ══');
  for (const preset of PRESETS) {
    const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
    const { width: W, height: H } = await sharp(jpg).metadata();
    const r = pipeline(judge, placeRoi, detOf(preset), preset, {});
    const widths = r.items.map((it) => plateAxes(it.quad)?.width ?? NaN);
    const header = `cam${CAM}_p${preset}  globalScale=${r.result.globalScale ?? 'null(2단계 폴백)'}  regions=${r.result.regions.length}  overlapPairs=${JSON.stringify(r.result.overlapPairs)}  maxPairArea=${r.max.toExponential(2)}`;
    const note = `iter3 축수정본 · 실검출(${USE_LIVE ? '3차 라이브' : '1차 캐시'})  plate점유=${r.items.length}/${r.floorPolys.length}면  판폭평균=${(widths.reduce((a, b) => a + b, 0) / (widths.length || 1)).toFixed(4)}`;
    const svg = buildSvg(W, H, {
      floorPolys: r.floorPolys, plates: r.items.map((i) => i.quad), regions: r.result.regions, header, note,
      vehicleRects: [...r.rects.values()].filter(Boolean),
    });
    const out = join(SHOTS, `iter3_cam${CAM}_p${preset}.png`);
    await compose(jpg, svg, out);
    console.log(`\n[${r.key}] 주차면=${r.floorPolys.length} plate점유=${r.items.length}`);
    console.log(`  globalScale = ${r.result.globalScale}   scales=[${r.result.regions.map((g) => g.scale.toFixed(3)).join(', ')}]`);
    console.log(`  idx         = [${r.result.regions.map((g) => g.idx).join(', ')}]`);
    console.log(`  overlapPairs= ${JSON.stringify(r.result.overlapPairs)}   maxPairArea=${r.max.toExponential(3)} ${r.at ? `(idx ${r.at[0]}↔${r.at[1]})` : ''}`);
    console.log(`  판폭(정규화)= [${widths.map((w) => w.toFixed(4)).join(', ')}]`);
    console.log(`  덮음률      = ${fmtCov(r.cov)}`);
    console.log(`  → ${out}`);
  }

  // ---- B: upRatio 스윕 ----
  console.log('\n══ B. upRatio 스윕 (downRatio=0.30, topWidthRatio=0.85 고정) ══');
  const table = [];
  for (const preset of [1, 3]) {
    const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
    const { width: W, height: H } = await sharp(jpg).metadata();
    for (const up of SWEEP_UPS) {
      const cfg = { ...SWEEP_FIXED, upRatio: up };
      const r = pipeline(judge, placeRoi, detOf(preset), preset, cfg);
      const st = covStats(r.cov);
      const header = `cam${CAM}_p${preset} upRatio=${up.toFixed(2)}  globalScale=${r.result.globalScale ?? 'null(2단계 폴백)'}  regions=${r.result.regions.length}  overlapPairs=${JSON.stringify(r.result.overlapPairs)}  maxPairArea=${r.max.toExponential(2)}`;
      const note = `down=0.30 top=0.85 고정 · 덮음률(교차/vehRect) ${fmtCov(r.cov)}`;
      const svg = buildSvg(W, H, {
        floorPolys: r.floorPolys, plates: r.items.map((i) => i.quad), regions: r.result.regions, header, note,
        vehicleRects: [...r.rects.values()].filter(Boolean),
      });
      const out = join(SHOTS, `iter3_sweep_p${preset}_up${upTag(up)}.png`);
      await compose(jpg, svg, out);
      const row = {
        preset, up, globalScale: r.result.globalScale, regions: r.result.regions.length,
        scales: r.result.regions.map((g) => g.scale), overlapPairs: r.result.overlapPairs,
        maxPairArea: r.max, at: r.at, cov: r.cov, st, intrMean: intrMean(r.cov), out,
      };
      table.push(row);
      console.log(`\n[p${preset} up=${up.toFixed(2)}] globalScale=${r.result.globalScale}  regions=${r.result.regions.length}`);
      console.log(`  scales      = [${r.result.regions.map((g) => g.scale.toFixed(3)).join(', ')}]`);
      console.log(`  overlapPairs= ${JSON.stringify(r.result.overlapPairs)}   maxPairArea=${r.max.toExponential(3)} ${r.at ? `(idx ${r.at[0]}↔${r.at[1]})` : ''}`);
      console.log(`  덮음률      = ${fmtCov(r.cov)}${st ? `   [min ${(st.min * 100).toFixed(1)}% / 평균 ${(st.mean * 100).toFixed(1)}% / max ${(st.max * 100).toFixed(1)}%, n=${st.n}]` : ''}`);
      console.log(`  이웃침범률* = ${fmtIntr(r.cov)}   [평균 ${(intrMean(r.cov) * 100).toFixed(1)}%]  *보조지표(bbox 상호겹침 바닥값 포함)`);
      console.log(`  → ${out}`);
    }
  }

  console.log('\n══ 스윕 요약표 ══');
  console.log('preset | up   | globalScale | overlapPairs | maxPairArea | 덮음률 평균 | 덮음률 범위 | 이웃침범률* 평균');
  for (const r of table) {
    console.log(
      `p${r.preset}     | ${r.up.toFixed(2)} | ${String(r.globalScale ?? 'null(폴백)').padEnd(11)} | ${JSON.stringify(r.overlapPairs).padEnd(12)} | ${r.maxPairArea.toExponential(2)} | ` +
      `${r.st ? (r.st.mean * 100).toFixed(1) + '%' : 'n/a'} | ${r.st ? `${(r.st.min * 100).toFixed(1)}~${(r.st.max * 100).toFixed(1)}%` : 'n/a'} | ${(r.intrMean * 100).toFixed(1)}%`,
    );
  }
  console.log('* 이웃침범률 = max_j area(region ∩ 타차량rect_j)/area(rect_j). 보조 관측 — 덮음률 대체 아님.');
  console.log('  사선뷰는 차량 bbox 끼리 이미 겹쳐 upRatio 무관 바닥값이 있다. 수준 간 증가폭만 유효.');
  writeFileSync(join(HERE, '_qa_data_iter3', 'sweep_table.json'), JSON.stringify(table, null, 1));
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
