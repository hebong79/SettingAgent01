// 검증자 — downRatio 2배 전환(0.30→0.60) 시각/실측 검증.
//
// _qa_regions_par3.mjs 의 파이프라인·렌더 규약을 그대로 재사용한다.
// 입력은 _qa_data_final2/ (수정 서버 라이브 검출) — 공정 비교를 위해 동일 입력.
// computeOccupancyRegions(items) 는 cfg 인자 없이 호출 = 코드 기본값 그대로.
//
// 사용: SettingAgent> node _workspace/_qa_regions_down4.mjs
// 출력: _qa_shots/final4_down_cam1_p{1,2,3}.png + stdout 실측표

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
const TAG = 'final4_down';
const OLD_DOWN = 0.30; // 구 기본값(대조군).

const readData = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));

// 코드 기본값을 **소스에서 직접 읽어** 헤더에 표기(하드코딩 금지 — 표기와 실제의 괴리 방지).
const SRC = readFileSync(join(ROOT, 'web/occupancyRegion.js'), 'utf8');
const DEFAULT_UP = Number(/upRatio:\s*([0-9.]+)/.exec(SRC)[1]);
const DEFAULT_DOWN = Number(/downRatio:\s*([0-9.]+)/.exec(SRC)[1]);

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

// ── 위/아래 길이 실측 ─────────────────────────────────────────────────────
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * 미클램프 사다리꼴(buildTrapezoid 원형)에서 중심축 상/하 길이 실측.
 * ★ 클램프된 region.polygon 이 아니라 원형을 재는 이유: 이미지 경계 클립은 변을 잘라
 *   길이를 인위로 바꾼다. 비는 기하 정의값이므로 원형에서 재고, 클램프 여부는 별도 보고.
 * Ct = 위변 중점(TL,TR), Cb = 아래변 중점(BR,BL), C = 번호판 quad 중심(judge center 정의).
 * 정규화 좌표(0..1) 로 잰다 — 구/신 |Cb−C| 대조는 동일 좌표계에서만 유효.
 */
function measureAxis(item, scale, cfg) {
  const axes = plateAxes(item.quad);
  if (!axes) return null;
  const trap = buildTrapezoid(axes, scale, cfg);
  const [TL, TR, BR, BL] = trap;
  const C = axes.c;
  const Ct = mid(TL, TR);
  const Cb = mid(BR, BL);
  const up = len(sub(Ct, C));
  const down = len(sub(Cb, C));
  const maxY = Math.max(...trap.map((p) => p.y));
  return {
    idx: item.idx,
    up,
    down,
    ratio: down > 1e-12 ? up / down : NaN,
    maxY,
    slack: 1 - maxY, // 아래 변이 이미지 하단(y=1)까지 남은 여유.
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

  console.log(`══ downRatio 2배 검증 — 입력 ${DATA} (수정 서버 라이브) ══`);
  console.log(`   소스 실측 DEFAULTS.upRatio = ${DEFAULT_UP} / DEFAULTS.downRatio = ${DEFAULT_DOWN}`);
  console.log(`   기대 위/아래비 = ${DEFAULT_UP}/${DEFAULT_DOWN} = ${(DEFAULT_UP / DEFAULT_DOWN).toFixed(3)}\n`);

  const compare = [];
  const allMeas = [];
  const slackAll = [];

  for (const preset of PRESETS) {
    const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
    const { width: W, height: H } = await sharp(jpg).metadata();
    const detect = readData(`detect_cam${CAM}_p${preset}.json`);
    const { key, floorPolys, items } = itemsFor(judge, placeRoi, detect, preset);

    // ── ① 현재 코드 기본값(cfg 미주입) ──
    const result = computeOccupancyRegions(items);
    const byIdx = new Map(items.map((it) => [it.idx, it]));
    const meas = result.regions.map((g) => measureAxis(byIdx.get(g.idx), g.scale)).filter(Boolean);
    // 클램프 여부: region.polygon 이 4점이 아니면 이미지 경계에서 잘렸다.
    const clipped = result.regions.filter((g) => g.polygon.length !== 4).map((g) => `${g.idx}(${g.polygon.length}점)`);
    const { max, at } = maxPairArea(result.regions);
    allMeas.push(...meas.map((m) => ({ ...m, preset })));
    slackAll.push(...meas.map((m) => ({ preset, idx: m.idx, slack: m.slack, maxY: m.maxY })));

    // ── ③ 0.30(구) 대조 — 동일 입력·동일 경로, cfg 만 주입 ──
    const old030 = computeOccupancyRegions(items, { downRatio: OLD_DOWN });
    const old030Max = maxPairArea(old030.regions);
    compare.push({
      preset,
      neo: { gs: result.globalScale, n: result.regions.length, op: result.overlapPairs, max },
      old: { gs: old030.globalScale, n: old030.regions.length, op: old030.overlapPairs, max: old030Max.max },
    });

    // ── ④ 측정기 반증 — cfg.downRatio=0.30 주입 시 비가 실제로 3.000 으로 움직이나 ──
    const falsify = old030.regions.map((g) => measureAxis(byIdx.get(g.idx), g.scale, { downRatio: OLD_DOWN })).filter(Boolean);

    const rects = items.map((it) => vehicleIndex(detect).get(quadKey(it.quad))).filter(Boolean);
    const rs = meas.map((m) => m.ratio);
    const minSlack = meas.reduce((a, m) => (m.slack < a.slack ? m : a), meas[0]);

    const header = `cam${CAM}_p${preset} [${TAG}·cfg없음]  up=${DEFAULT_UP} down=${DEFAULT_DOWN}  위/아래비=${(DEFAULT_UP / DEFAULT_DOWN).toFixed(3)}  globalScale=${result.globalScale ?? 'null(2단계 폴백)'}  overlapPairs=${JSON.stringify(result.overlapPairs)}`;
    const note = `차량 ${detect.vehicles.length} / 점유 ${items.length} · regions=${result.regions.length} · 실측 위/아래비 ${f3(Math.min(...rs))}~${f3(Math.max(...rs))} · 하단여유 최소 ${minSlack.slack.toFixed(4)}(idx ${minSlack.idx}) · maxPairArea=${max.toExponential(2)}`;
    const svg = buildSvg(W, H, { floorPolys, plates: items.map((i) => i.quad), regions: result.regions, header, note, vehicleRects: rects });
    const out = join(SHOTS, `${TAG}_cam${CAM}_p${preset}.png`);
    await compose(jpg, svg, out);

    console.log(`── [${key}] ${W}×${H}px  주차면=${floorPolys.length}  차량=${detect.vehicles.length}  plate점유=${items.length}  regions=${result.regions.length}`);
    console.log(`   globalScale=${result.globalScale} overlapPairs=${JSON.stringify(result.overlapPairs)} maxPairArea=${max.toExponential(3)} ${at ? `(idx ${at[0]}↔${at[1]})` : '(전 쌍 0)'}`);
    console.log(`   경계 클램프된 region: ${clipped.length ? clipped.join(', ') : '없음(전부 4점 원형 유지)'}`);
    console.log(`   idx |  |Ct-C|    |Cb-C|   위/아래비 | maxY    하단여유 | 구0.30 |Cb-C|  신/구배  구0.30 비`);
    for (const m of meas) {
      const fz = falsify.find((f) => f.idx === m.idx);
      const ratio2x = fz ? m.down / fz.down : NaN;
      console.log(
        `   ${String(m.idx).padStart(3)} | ${m.up.toFixed(6)} ${m.down.toFixed(6)} ${m.ratio.toFixed(6).padStart(9)} | ${m.maxY.toFixed(4)} ${m.slack.toFixed(4).padStart(8)} | ` +
        `${fz ? fz.down.toFixed(6) : 'n/a'}    ${Number.isFinite(ratio2x) ? ratio2x.toFixed(6) : 'n/a'}  ${fz ? fz.ratio.toFixed(6) : 'n/a'}`,
      );
    }
    console.log(`   → ${out}\n`);
  }

  console.log('══ 위/아래비 전 인스턴스 종합 ══');
  const rs = allMeas.map((m) => m.ratio);
  console.log(`  인스턴스 수            : ${allMeas.length}`);
  console.log(`  위/아래비 |Ct-C|/|Cb-C|: min ${Math.min(...rs).toFixed(9)} / max ${Math.max(...rs).toFixed(9)}  (기대 ${(DEFAULT_UP / DEFAULT_DOWN).toFixed(3)})`);
  console.log(`  1.500 이탈 최대        : ${Math.max(...rs.map((r) => Math.abs(r - 1.5))).toExponential(3)}`);

  console.log('\n══ 하단 여유(1 − maxY) 오름차순 상위 6 ══');
  slackAll.sort((a, b) => a.slack - b.slack);
  console.log('  프리셋 | idx | maxY   | 여유');
  for (const s of slackAll.slice(0, 6)) {
    console.log(`  p${s.preset}     | ${String(s.idx).padStart(3)} | ${s.maxY.toFixed(4)} | ${s.slack.toFixed(4)}`);
  }
  const worst = slackAll[0];
  console.log(`  → 전체 최소 여유: p${worst.preset} idx=${worst.idx} 여유 ${worst.slack.toFixed(4)} (구현자 주장: p3 idx=14, 0.0761)`);
  // 선형 외삽: down 이 slack 만큼 더 내려가면 y=1 에 닿는다 → 임계 downRatio.
  const wm = allMeas.find((m) => m.preset === worst.preset && m.idx === worst.idx);
  if (wm) {
    // maxY 는 아래 두 정점 중 큰 값. downRatio 증가분 δ 당 y 증가율 = (down 방향 v.y 성분)/downRatio.
    const crit = DEFAULT_DOWN * (1 + worst.slack / (wm.down * Math.abs(1))); // 근사(아래 참고).
    console.log(`  → 참고: 최소 여유 인스턴스의 |Cb-C|=${wm.down.toFixed(6)} — 임계 downRatio 는 아래 스윕으로 실측한다.`);
  }

  console.log('\n══ 0.30(구) vs 0.60(신) 겹침 비교 — 동일 입력·동일 경로 ══');
  console.log('  프리셋 | downRatio | globalScale | regions | overlapPairs | 최대쌍교차면적');
  for (const c of compare) {
    console.log(`  p${c.preset}     | 0.60 (신) | ${String(c.neo.gs).padEnd(11)} | ${String(c.neo.n).padEnd(7)} | ${JSON.stringify(c.neo.op).padEnd(12)} | ${c.neo.max.toExponential(3)}`);
    console.log(`  p${c.preset}     | 0.30 (구) | ${String(c.old.gs).padEnd(11)} | ${String(c.old.n).padEnd(7)} | ${JSON.stringify(c.old.op).padEnd(12)} | ${c.old.max.toExponential(3)}`);
  }
  const identical = compare.every((c) => c.neo.gs === c.old.gs && c.neo.n === c.old.n && JSON.stringify(c.neo.op) === JSON.stringify(c.old.op));
  console.log(`  → 구현자 보고("3프리셋 전부 무변화") 독립 재현: ${identical ? '일치' : '*** 불일치 ***'}`);

  // ── ⑤ 임계 downRatio 스윕 — 첫 클램프가 실제로 어디서·누구에게 발생하나 ──
  console.log('\n══ 임계 downRatio 스윕(첫 클램프 지점 실측) ══');
  const judge2 = new OccupancyJudge();
  let firstHit = null;
  for (let d = 0.60; d <= 1.001; d += 0.01) {
    const dr = Math.round(d * 1000) / 1000;
    for (const preset of PRESETS) {
      const detect = readData(`detect_cam${CAM}_p${preset}.json`);
      const { items } = itemsFor(judge2, placeRoi, detect, preset);
      const res = computeOccupancyRegions(items, { downRatio: dr });
      const byIdx = new Map(items.map((it) => [it.idx, it]));
      for (const g of res.regions) {
        const m = measureAxis(byIdx.get(g.idx), g.scale, { downRatio: dr });
        if (m && m.maxY > 1 && !firstHit) firstHit = { dr, preset, idx: g.idx, maxY: m.maxY };
      }
    }
    if (firstHit) break;
  }
  console.log(firstHit
    ? `  첫 하단 초과(maxY>1): downRatio=${firstHit.dr} 에서 p${firstHit.preset} idx=${firstHit.idx} (maxY=${firstHit.maxY.toFixed(4)})  ← 구현자 주장 "≈0.66, p3 idx=14"`
    : '  0.60~1.00 구간에서 하단 초과 없음');
}

main().catch((e) => { console.error(e); process.exit(1); });
