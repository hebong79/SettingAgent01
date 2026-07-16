// 검증자 goal/loop 최종2 — **수정된 서버의 라이브 재검출** 입력으로 Goal ①~⑥ 판정.
//
// _qa_regions_final.mjs 의 파이프라인·렌더·측정 규약을 그대로 재사용한다.
// 【핵심 차이】 입력이 _qa_data_final2/ (수정 서버 라이브) — 구 캐시(_qa_data_iter3)가 아니다.
// computeOccupancyRegions(items) 는 cfg 인자 없이 호출 = 뷰어 런타임 기본값 그대로.
//
// 사용: SettingAgent> node _workspace/_qa_regions_final2.mjs [--data <dir>] [--tag <tag>]
// 출력: _qa_shots/final2_cam1_p{1,2,3}.png + stdout 실측표

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { normalizePtzCamRoi, selectFloorRoi, presetKey, quadCentroid } from '../web/core.js';
import { OccupancyJudge, convexIntersectionArea, polygonCentroid } from '../web/occupancy.js';
import { computeOccupancyRegions, plateAxes, buildTrapezoid } from '../web/occupancyRegion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, '_qa_shots');
const CAM = 1;
const PRESETS = [1, 2, 3];
const EXPECTED_VEHICLES = { 1: 7, 2: 6, 3: 4 }; // 마스터 명시 실제 차량 수.

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DATA = join(HERE, argOf('--data', '_qa_data_final2'));
const TAG = argOf('--tag', 'final2');

const readData = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));

// ── 렌더(기존과 동일 규약) ────────────────────────────────────────────────
const PALETTE = ['#4da6ff', '#ff7ad9', '#7dff9e', '#ffd24d', '#b48cff', '#4dfff0', '#ff8c5a', '#9cff4d'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const px = (poly, W, H) => poly.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(' ');

function buildSvg(W, H, { floorPolys, plates, regions, header, note, vehicleRects = [] }) {
  const parts = [];
  for (const f of floorPolys) {
    parts.push(`<polygon points="${px(f.quad, W, H)}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>`);
  }
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

// ── 픽셀 기준 실측(기존 ②③④) ───────────────────────────────────────────
const toPx = (p, W, H) => ({ x: p.x * W, y: p.y * H });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function angleBetween(a, b) {
  const la = len(a), lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return NaN;
  const cos = Math.abs((a.x * b.x + a.y * b.y) / (la * lb));
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

function plateLongAxisPx(quad, W, H) {
  const [tl, tr, br, bl] = quad.map((p) => toPx(p, W, H));
  const a = { vec: mid(sub(tr, tl), sub(br, bl)), width: (len(sub(tr, tl)) + len(sub(br, bl))) / 2 };
  const b = { vec: mid(sub(bl, tl), sub(br, tr)), width: (len(sub(bl, tl)) + len(sub(br, tr))) / 2 };
  const long = a.width >= b.width ? a : b;
  const short = a.width >= b.width ? b : a;
  return { vec: long.vec, width: long.width, shortWidth: short.width };
}

function measure(item, scale, W, H) {
  const axes = plateAxes(item.quad);
  if (!axes) return null;
  const trap = buildTrapezoid(axes, scale).map((p) => toPx(p, W, H));
  const [TL, TR, BR, BL] = trap;
  const C = toPx(axes.c, W, H);
  const Ct = mid(TL, TR), Cb = mid(BR, BL);
  const topVec = sub(TR, TL), botVec = sub(BR, BL);
  const plate = plateLongAxisPx(item.quad, W, H);
  return {
    idx: item.idx,
    angTop: angleBetween(topVec, plate.vec),
    angBot: angleBetween(botVec, plate.vec),
    upLen: len(sub(Ct, C)),
    downLen: len(sub(Cb, C)),
    upDownRatio: len(sub(Cb, C)) > 1e-12 ? len(sub(Ct, C)) / len(sub(Cb, C)) : NaN,
    botW: len(botVec),
    plateW: plate.width,
    widthRatio: plate.width > 1e-12 ? len(botVec) / plate.width : NaN,
    aspectPx: plate.shortWidth > 1e-12 ? plate.width / plate.shortWidth : NaN,
    scale,
  };
}

// ── 파이프라인 ────────────────────────────────────────────────────────────
const quadKey = (q) => q.map((p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`).join(';');
const rectKey = (r) => `${r.x.toFixed(6)},${r.y.toFixed(6)},${r.w.toFixed(6)},${r.h.toFixed(6)}`;
const bboxCenter = (q) => {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
};
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function vehicleIndex(detect) {
  const m = new Map();
  for (const v of detect?.vehicles ?? []) if (v?.plate?.quad) m.set(quadKey(v.plate.quad), v.rect);
  return m;
}

function pipeline(judge, placeRoi, detect, preset, W, H) {
  const key = presetKey(CAM, preset);
  const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
  const judged = judge.judge(floorPolys, detect);
  const items = judged.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));
  const result = computeOccupancyRegions(items); // ★ cfg 없음 = 코드 기본값.
  const byIdx = new Map(items.map((it) => [it.idx, it]));
  const meas = result.regions.map((g) => measure(byIdx.get(g.idx), g.scale, W, H)).filter(Boolean);
  const vidx = vehicleIndex(detect);
  const rects = items.map((it) => vidx.get(quadKey(it.quad))).filter(Boolean);

  // ── Goal ② 오귀속 / ③ 1:1 / ⑥ recovered 중복 ──
  // region idx → 그 region 을 만든 plate → 그 plate 를 소유한 vehicle rect.
  const perRegion = result.regions.map((g) => {
    const it = byIdx.get(g.idx);
    const rect = vidx.get(quadKey(it.quad));
    const pc = bboxCenter(it.quad);
    const cen = polygonCentroid(g.polygon);
    return {
      idx: g.idx,
      rect,
      rk: rect ? rectKey(rect) : null,
      plateCenterInOwnRect: rect ? inRect(pc, rect) : false, // 판 중심 ∈ 자기 차량 rect
      regionCentroidInOwnRect: rect && cen ? inRect(cen, rect) : false, // 사다리꼴 중심 ∈ 자기 차량 위
    };
  });
  // ③ 차량당 region 수.
  const perVehicle = new Map();
  for (const v of detect.vehicles) perVehicle.set(rectKey(v.rect), 0);
  for (const pr of perRegion) if (pr.rk && perVehicle.has(pr.rk)) perVehicle.set(pr.rk, perVehicle.get(pr.rk) + 1);
  const vehWith2 = [...perVehicle.values()].filter((n) => n >= 2).length;
  const vehWith0 = [...perVehicle.values()].filter((n) => n === 0).length;

  // ⑥ 판 중심 근접쌍(중복 귀속) — 정규화 거리.
  const centers = detect.vehicles.map((v, i) => (v.plate ? { i, c: bboxCenter(v.plate.quad), rec: v.plate.recovered } : null)).filter(Boolean);
  const dupPairs = [];
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const d = Math.hypot(centers[i].c.x - centers[j].c.x, centers[i].c.y - centers[j].c.y);
      if (d <= 0.03) dupPairs.push([centers[i].i, centers[j].i, d]);
    }
  }
  const recovered = detect.vehicles.filter((v) => v.plate?.recovered).length;

  return {
    key, floorPolys, items, result, meas, rects, perRegion, perVehicle, vehWith2, vehWith0,
    dupPairs, recovered, vehicles: detect.vehicles.length,
    misattributed: perRegion.filter((p) => !p.plateCenterInOwnRect || !p.regionCentroidInOwnRect).map((p) => p.idx),
    ...maxPairArea(result.regions),
  };
}

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
const OK = (b) => (b ? '달성' : '*** 미달 ***');

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const judge = new OccupancyJudge();
  const placeRoi = normalizePtzCamRoi(readData('place_roi.json')).byPreset;

  console.log(`══ 최종2 — 수정 서버 라이브 재검출(${DATA}) · cfg 주입 없음 ══\n`);
  const all = [];
  for (const preset of PRESETS) {
    const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
    const { width: W, height: H } = await sharp(jpg).metadata();
    const detect = readData(`detect_cam${CAM}_p${preset}.json`);
    const r = pipeline(judge, placeRoi, detect, preset, W, H);
    all.push({ preset, r, W, H });

    const header = `cam${CAM}_p${preset} [${TAG}·LIVE·cfg없음]  globalScale=${r.result.globalScale ?? 'null(2단계 폴백)'}  regions=${r.result.regions.length}  overlapPairs=${JSON.stringify(r.result.overlapPairs)}  maxPairArea=${r.max.toExponential(2)}`;
    const angMax = Math.max(...r.meas.map((m) => Math.max(m.angTop, m.angBot)));
    const note = `차량 ${r.vehicles} / 점유 ${r.items.length} · 각도차 최대 ${f2(angMax)}° · 위/아래 ${f2(r.meas[0]?.upDownRatio)} · 폭비 ${f2(r.meas[0]?.widthRatio)}×(px) · recovered ${r.recovered}`;
    const svg = buildSvg(W, H, { floorPolys: r.floorPolys, plates: r.items.map((i) => i.quad), regions: r.result.regions, header, note, vehicleRects: r.rects });
    const out = join(SHOTS, `${TAG}_cam${CAM}_p${preset}.png`);
    await compose(jpg, svg, out);

    const exp = EXPECTED_VEHICLES[preset];
    console.log(`── [${r.key}] ${W}×${H}px  주차면=${r.floorPolys.length}  차량=${r.vehicles}(기대 ${exp})  plate점유=${r.items.length}  regions=${r.result.regions.length}`);
    console.log(`   ① 점유==실차량 : ${OK(r.items.length === exp)}  (점유 ${r.items.length} / 실제 ${exp})`);
    console.log(`   ② 오귀속 0     : ${OK(r.misattributed.length === 0)}  ${r.misattributed.length ? `위반 idx=${JSON.stringify(r.misattributed)}` : ''}`);
    console.log(`   ③ 사다리꼴 1:1 : ${OK(r.vehWith2 === 0 && r.vehWith0 === 0)}  (2개 차량 ${r.vehWith2} / 0개 차량 ${r.vehWith0})`);
    console.log(`   ④ overlapPairs : ${JSON.stringify(r.result.overlapPairs)}  ${OK(r.result.overlapPairs.length === 0)}  최대쌍교차면적=${r.max.toExponential(3)} ${r.at ? `(idx ${r.at[0]}↔${r.at[1]})` : '(전 쌍 0)'}`);
    console.log(`   ⑥ recovered=${r.recovered}  중복쌍 ${r.dupPairs.length}건 ${OK(r.dupPairs.length === 0)} ${r.dupPairs.length ? JSON.stringify(r.dupPairs) : ''}`);
    console.log(`   idx | ⑤위변각(°) 아래변각(°) | |Ct−C| |Cb−C| 비    | 아래폭(px) 판장축(px) 배     | 판종횡비`);
    for (const m of r.meas) {
      console.log(
        `   ${String(m.idx).padStart(3)} | ${f2(m.angTop).padStart(9)} ${f2(m.angBot).padStart(10)} | ` +
        `${m.upLen.toFixed(1).padStart(6)} ${m.downLen.toFixed(1).padStart(6)} ${f2(m.upDownRatio).padStart(5)} | ` +
        `${m.botW.toFixed(1).padStart(9)} ${m.plateW.toFixed(1).padStart(9)} ${f2(m.widthRatio).padStart(5)} | ${f2(m.aspectPx).padStart(6)}`,
      );
    }
    console.log(`   → ${out}\n`);
  }

  const flat = all.flatMap((a) => a.r.meas);
  const angs = flat.flatMap((m) => [m.angTop, m.angBot]);
  const rng = (v) => `min ${Math.min(...v).toFixed(3)} / max ${Math.max(...v).toFixed(3)}`;
  console.log('══ Goal 최종 판정 ══');
  console.log(`  ① 점유==실차량 전 프리셋 : ${OK(all.every((a) => a.r.items.length === EXPECTED_VEHICLES[a.preset]))}`);
  console.log(`  ② 오귀속 0               : ${OK(all.every((a) => a.r.misattributed.length === 0))}`);
  console.log(`  ③ 사다리꼴 1:1           : ${OK(all.every((a) => a.r.vehWith2 === 0 && a.r.vehWith0 === 0))}`);
  console.log(`  ④ overlapPairs 전부 빔   : ${OK(all.every((a) => a.r.result.overlapPairs.length === 0))}   최대쌍교차면적 최대: ${Math.max(...all.map((a) => a.r.max)).toExponential(3)}`);
  console.log(`  ⑤ 각도차(도)             : ${rng(angs)}`);
  console.log(`     위/아래 비            : ${rng(flat.map((m) => m.upDownRatio))}   (기대 3.00)`);
  console.log(`     폭 배율(px)           : ${rng(flat.map((m) => m.widthRatio))}   (기대 4.00)`);
  console.log(`  ⑥ recovered 중복 귀속 0  : ${OK(all.every((a) => a.r.dupPairs.length === 0))}   (recovered 총 ${all.reduce((s, a) => s + a.r.recovered, 0)}건)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
