// 검증자 — 평행사변형 전환(topWidthRatio 0.85→1.0) 시각/실측 검증.
//
// _qa_regions_final2.mjs 의 파이프라인·렌더 규약을 그대로 재사용한다.
// 입력은 _qa_data_final2/ (수정 서버 라이브 검출) — 공정 비교를 위해 동일 입력.
// computeOccupancyRegions(items) 는 cfg 인자 없이 호출 = 코드 기본값 그대로.
//
// 사용: SettingAgent> node _workspace/_qa_regions_par3.mjs
// 출력: _qa_shots/final3_par_cam1_p{1,2,3}.png + stdout 실측표

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { normalizePtzCamRoi, selectFloorRoi, presetKey, quadCentroid } from '../web/core.js';
import { OccupancyJudge, convexIntersectionArea } from '../web/occupancy.js';
import { computeOccupancyRegions, plateAxes, buildTrapezoid } from '../web/occupancyRegion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, '_qa_shots');
const DATA = join(HERE, '_qa_data_final2');
const CAM = 1;
const PRESETS = [1, 2, 3];
const TAG = 'final3_par';

const readData = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));

// 코드 기본값을 **소스에서 직접 읽어** 헤더에 표기(하드코딩 금지 — 표기와 실제의 괴리 방지).
const SRC = readFileSync(join(ROOT, 'web/occupancyRegion.js'), 'utf8');
const DEFAULT_TWR = Number(/topWidthRatio:\s*([0-9.]+)/.exec(SRC)[1]);

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

// ── 폭비·평행성 실측 ──────────────────────────────────────────────────────
const toPx = (p, W, H) => ({ x: p.x * W, y: p.y * H });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const cross = (a, b) => a.x * b.y - a.y * b.x;

/**
 * 미클램프 사다리꼴(buildTrapezoid 원형)에서 폭비·평행성 실측.
 * ★ 클램프된 region.polygon 이 아니라 원형을 재는 이유: 이미지 경계 클립은 변을 잘라
 *   폭비를 인위로 바꾼다. 폭비는 기하 정의값이므로 원형에서 재고, 클램프 여부는 별도 보고.
 */
function measureShape(item, scale, W, H, cfg) {
  const axes = plateAxes(item.quad);
  if (!axes) return null;
  const trap = buildTrapezoid(axes, scale, cfg).map((p) => toPx(p, W, H));
  const [TL, TR, BR, BL] = trap;
  const topVec = sub(TR, TL);
  const botVec = sub(BR, BL);
  const topW = len(topVec);
  const botW = len(botVec);
  // 정규화 외적 = sin(두 변 사잇각). 0 이면 평행.
  const sinTheta = (topW > 1e-12 && botW > 1e-12) ? cross(topVec, botVec) / (topW * botW) : NaN;
  return {
    idx: item.idx,
    topW,
    botW,
    widthRatio: botW > 1e-12 ? topW / botW : NaN,
    sinTheta,
    angleDeg: (Math.asin(Math.min(1, Math.abs(sinTheta))) * 180) / Math.PI,
    scale,
  };
}

// ── 파이프라인 ────────────────────────────────────────────────────────────
const quadKey = (q) => q.map((p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`).join(';');

function vehicleIndex(detect) {
  const m = new Map();
  for (const v of detect?.vehicles ?? []) if (v?.plate?.quad) m.set(quadKey(v.plate.quad), v.rect);
  return m;
}

/** judge → plate 필터 → items. cfg 와 무관한 상류 단계. */
function itemsFor(judge, placeRoi, detect, preset) {
  const key = presetKey(CAM, preset);
  const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
  const judged = judge.judge(floorPolys, detect);
  const items = judged.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));
  return { key, floorPolys, items };
}

const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a');

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const judge = new OccupancyJudge();
  const placeRoi = normalizePtzCamRoi(readData('place_roi.json')).byPreset;

  console.log(`══ 평행사변형 검증 — 입력 ${DATA} (수정 서버 라이브) ══`);
  console.log(`   소스 실측 DEFAULTS.topWidthRatio = ${DEFAULT_TWR}\n`);

  const compare = [];
  const allMeas = [];

  for (const preset of PRESETS) {
    const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
    const { width: W, height: H } = await sharp(jpg).metadata();
    const detect = readData(`detect_cam${CAM}_p${preset}.json`);
    const { key, floorPolys, items } = itemsFor(judge, placeRoi, detect, preset);

    // ── ① 현재 코드 기본값(cfg 미주입) ──
    const result = computeOccupancyRegions(items);
    const byIdx = new Map(items.map((it) => [it.idx, it]));
    const meas = result.regions.map((g) => measureShape(byIdx.get(g.idx), g.scale, W, H)).filter(Boolean);
    // 클램프 여부: region.polygon 이 4점이 아니면 이미지 경계에서 잘렸다.
    const clipped = result.regions.filter((g) => g.polygon.length !== 4).map((g) => `${g.idx}(${g.polygon.length}점)`);
    const { max, at } = maxPairArea(result.regions);
    allMeas.push(...meas);

    // ── ③ 0.85(구) 대조 — 동일 입력·동일 경로, cfg 만 주입 ──
    const old085 = computeOccupancyRegions(items, { topWidthRatio: 0.85 });
    const old085Max = maxPairArea(old085.regions);
    compare.push({
      preset,
      neo: { gs: result.globalScale, n: result.regions.length, op: result.overlapPairs, max },
      old: { gs: old085.globalScale, n: old085.regions.length, op: old085.overlapPairs, max: old085Max.max },
    });

    // ── ④ 측정기 반증 — cfg.topWidthRatio=0.85 주입 시 폭비가 실제로 움직이나 ──
    const falsify = old085.regions.map((g) => measureShape(byIdx.get(g.idx), g.scale, W, H, { topWidthRatio: 0.85 })).filter(Boolean);

    const rects = items.map((it) => vehicleIndex(detect).get(quadKey(it.quad))).filter(Boolean);
    const wrs = meas.map((m) => m.widthRatio);
    const sins = meas.map((m) => Math.abs(m.sinTheta));

    const header = `cam${CAM}_p${preset} [${TAG}·cfg없음]  topWidthRatio=${DEFAULT_TWR}  globalScale=${result.globalScale ?? 'null(2단계 폴백)'}  regions=${result.regions.length}  overlapPairs=${JSON.stringify(result.overlapPairs)}  maxPairArea=${max.toExponential(2)}`;
    const note = `차량 ${detect.vehicles.length} / 점유 ${items.length} · 폭비 |위|/|아래| ${f3(Math.min(...wrs))}~${f3(Math.max(...wrs))} · 평행성 |sin| 최대 ${Math.max(...sins).toExponential(2)}`;
    const svg = buildSvg(W, H, { floorPolys, plates: items.map((i) => i.quad), regions: result.regions, header, note, vehicleRects: rects });
    const out = join(SHOTS, `${TAG}_cam${CAM}_p${preset}.png`);
    await compose(jpg, svg, out);

    console.log(`── [${key}] ${W}×${H}px  주차면=${floorPolys.length}  차량=${detect.vehicles.length}  plate점유=${items.length}  regions=${result.regions.length}`);
    console.log(`   globalScale=${result.globalScale} overlapPairs=${JSON.stringify(result.overlapPairs)} maxPairArea=${max.toExponential(3)} ${at ? `(idx ${at[0]}↔${at[1]})` : '(전 쌍 0)'}`);
    console.log(`   경계 클램프된 region: ${clipped.length ? clipped.join(', ') : '없음(전부 4점 원형 유지)'}`);
    console.log(`   idx | 위변(px)  아래변(px) 폭비      | 정규외적 sinθ    사잇각(°)  | 반증 0.85 주입 폭비`);
    for (const m of meas) {
      const fz = falsify.find((f) => f.idx === m.idx);
      console.log(
        `   ${String(m.idx).padStart(3)} | ${m.topW.toFixed(1).padStart(8)} ${m.botW.toFixed(1).padStart(9)} ${m.widthRatio.toFixed(6).padStart(9)} | ` +
        `${m.sinTheta.toExponential(2).padStart(10)} ${m.angleDeg.toExponential(2).padStart(11)} | ${fz ? fz.widthRatio.toFixed(6) : 'n/a'}`,
      );
    }
    console.log(`   → ${out}\n`);
  }

  console.log('══ 폭비/평행성 전 인스턴스 종합 ══');
  const wrs = allMeas.map((m) => m.widthRatio);
  const sins = allMeas.map((m) => Math.abs(m.sinTheta));
  console.log(`  인스턴스 수            : ${allMeas.length}`);
  console.log(`  폭비 |위변|/|아래변|   : min ${Math.min(...wrs).toFixed(9)} / max ${Math.max(...wrs).toFixed(9)}  (기대 1.000)`);
  console.log(`  1.000 이탈 최대        : ${Math.max(...wrs.map((r) => Math.abs(r - 1))).toExponential(3)}`);
  console.log(`  평행성 |sinθ| 최대     : ${Math.max(...sins).toExponential(3)}  (기대 0 = 위/아래 변 평행)`);
  console.log(`  사잇각(°) 최대         : ${Math.max(...allMeas.map((m) => m.angleDeg)).toExponential(3)}`);

  console.log('\n══ 0.85(구) vs 1.0(신) 비교 — 동일 입력·동일 경로 ══');
  console.log('  프리셋 | topWidthRatio | globalScale | regions | overlapPairs | 최대쌍교차면적');
  for (const c of compare) {
    console.log(`  p${c.preset}     | 1.0 (신)      | ${String(c.neo.gs).padEnd(11)} | ${String(c.neo.n).padEnd(7)} | ${JSON.stringify(c.neo.op).padEnd(12)} | ${c.neo.max.toExponential(3)}`);
    console.log(`  p${c.preset}     | 0.85 (구)     | ${String(c.old.gs).padEnd(11)} | ${String(c.old.n).padEnd(7)} | ${JSON.stringify(c.old.op).padEnd(12)} | ${c.old.max.toExponential(3)}`);
  }
  const identical = compare.every((c) => c.neo.gs === c.old.gs && c.neo.n === c.old.n && JSON.stringify(c.neo.op) === JSON.stringify(c.old.op));
  console.log(`  → 구현자 보고("3프리셋 전부 무변화") 독립 재현: ${identical ? '일치' : '*** 불일치 ***'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
