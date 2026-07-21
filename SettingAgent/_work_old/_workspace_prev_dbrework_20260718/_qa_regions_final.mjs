// 검증자 goal/loop 5차 — 최종 확정본 검증(수렴 확인).
//
// 3차 스크립트(_qa_regions_iter3.mjs)의 파이프라인·렌더 규약을 그대로 재사용한다.
// 【핵심 차이】 computeOccupancyRegions(items) 를 **cfg 인자 없이** 호출 = 뷰어 런타임과 동일 조건.
// 데이터는 1차 캐시 검출(_qa_data/) 고정 — 3차와 동일한 공정 비교 원칙(코드 기본값만이 변수).
//
// Goal 4항목을 **픽셀 기준**으로 실측한다(2차 개발자 보고의 정규화 이방성 0.5625 지적 반영):
//   ① 겹침 0        : overlapPairs / 최대 쌍 교차면적
//   ② 가로 수평 정합 : region 위·아래 변 방향 ↔ 번호판 장축 방향 각도차(도)
//   ③ 위가 김        : |Ct−C| / |Cb−C|
//   ④ 폭 3.5~4배     : 아래변 폭 / 번호판 장축 폭
//
// ②④ 의 "번호판 장축"은 plateAxes 를 쓰지 않고 **quad 에서 픽셀 공간으로 독립 산출**한다.
// (plateAxes 로 재도출하면 순환 논증이 되고, 정규화 장축 ≠ 픽셀 장축일 위험을 못 잡는다.)
//
// 사용: SettingAgent> node _workspace/_qa_regions_final.mjs
// 출력: _qa_shots/final_cam1_p{1,2,3}.png, _qa_shots/final_stress.png + stdout 실측표

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
const CACHE1 = join(HERE, '_qa_data'); // 1차 검출 캐시 = 공정 비교 기준 입력.
const CAM = 1;
const PRESETS = [1, 2, 3];

const readCache1 = (name) => JSON.parse(readFileSync(join(CACHE1, name), 'utf8'));

// ── 렌더(1·3차와 동일 규약) ───────────────────────────────────────────────
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

// ── 픽셀 기준 실측(Goal ②③④) ────────────────────────────────────────────
// 정규화 좌표 → 픽셀: (x·W, y·H). 이방성 W/H(1920/1080) 때문에 각도·종횡비는
// 정규화 공간에서 왜곡된다 → 시각 판정 항목은 반드시 픽셀에서 잰다.
const toPx = (p, W, H) => ({ x: p.x * W, y: p.y * H });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 두 벡터의 무향 각도차(도) — 0~90. 180° 반전은 같은 직선이므로 접는다. */
function angleBetween(a, b) {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return NaN;
  const cos = Math.abs((a.x * b.x + a.y * b.y) / (la * lb));
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

/**
 * quad 에서 **픽셀 공간** 장축을 독립 산출(plateAxes 미사용 — 순환 논증 회피).
 * 대변 두 쌍의 평균 벡터·평균 길이를 각각 구해 픽셀 길이가 긴 쪽을 장축으로 채택.
 * @returns {{ vec:{x,y}, width:number, shortWidth:number }} vec=장축 평균 벡터(px), width=장축 평균 엣지 길이(px)
 */
function plateLongAxisPx(quad, W, H) {
  const [tl, tr, br, bl] = quad.map((p) => toPx(p, W, H));
  const a = { vec: mid(sub(tr, tl), sub(br, bl)), width: (len(sub(tr, tl)) + len(sub(br, bl))) / 2 };
  const b = { vec: mid(sub(bl, tl), sub(br, tr)), width: (len(sub(bl, tl)) + len(sub(br, tr))) / 2 };
  const long = a.width >= b.width ? a : b;
  const short = a.width >= b.width ? b : a;
  return { vec: long.vec, width: long.width, shortWidth: short.width };
}

/**
 * region 1개의 Goal ②③④ 실측. region.polygon 은 경계 클램프된 결과라
 * 변 길이·Ct/Cb 가 잘려 있을 수 있으므로 **미클램프 사다리꼴**을 재구성해 잰다
 * (buildTrapezoid 를 cfg 없이 호출 = 구현 기본값 그대로).
 */
function measure(item, scale, W, H) {
  const axes = plateAxes(item.quad);
  if (!axes) return null;
  const trap = buildTrapezoid(axes, scale).map((p) => toPx(p, W, H)); // [TL,TR,BR,BL]
  const [TL, TR, BR, BL] = trap;
  const C = toPx(axes.c, W, H);
  const Ct = mid(TL, TR); // 위 변 중점.
  const Cb = mid(BR, BL); // 아래 변 중점.
  const topVec = sub(TR, TL);
  const botVec = sub(BR, BL);
  const plate = plateLongAxisPx(item.quad, W, H);

  return {
    idx: item.idx,
    // ② 각도차(도) — 위/아래 변 vs 번호판 장축.
    angTop: angleBetween(topVec, plate.vec),
    angBot: angleBetween(botVec, plate.vec),
    // ③ 위/아래 길이비.
    upLen: len(sub(Ct, C)),
    downLen: len(sub(Cb, C)),
    upDownRatio: len(sub(Cb, C)) > 1e-12 ? len(sub(Ct, C)) / len(sub(Cb, C)) : NaN,
    // ④ 아래변 폭 / 번호판 장축 폭 (둘 다 픽셀).
    botW: len(botVec),
    plateW: plate.width,
    widthRatio: plate.width > 1e-12 ? len(botVec) / plate.width : NaN,
    // 참고: 픽셀 종횡비(장축/단축) — 장단축 오판 마진 관측.
    aspectPx: plate.shortWidth > 1e-12 ? plate.width / plate.shortWidth : NaN,
    scale,
  };
}

// ── 파이프라인 1회분 (cfg 주입 없음) ──────────────────────────────────────
const quadKey = (q) => q.map((p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`).join(';');
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

  const result = computeOccupancyRegions(items); // ★ cfg 인자 없음 — 코드 기본값 = 뷰어 런타임 조건.

  const byIdx = new Map(items.map((it) => [it.idx, it]));
  const meas = result.regions.map((g) => measure(byIdx.get(g.idx), g.scale, W, H)).filter(Boolean);
  const vidx = vehicleIndex(detect);
  const rects = items.map((it) => vidx.get(quadKey(it.quad))).filter(Boolean);
  return { key, floorPolys, items, result, meas, rects, ...maxPairArea(result.regions) };
}

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const judge = new OccupancyJudge();
  const placeRoi = normalizePtzCamRoi(readCache1('place_roi.json')).byPreset;

  console.log('══ 5차 최종 확정본 — cfg 주입 없음(코드 DEFAULTS 그대로) · 1차 캐시 검출 입력 ══\n');

  const all = [];
  for (const preset of PRESETS) {
    const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
    const { width: W, height: H } = await sharp(jpg).metadata();
    const detect = readCache1(`detect_cam${CAM}_p${preset}.json`);
    const r = pipeline(judge, placeRoi, detect, preset, W, H);
    all.push({ preset, r, W, H });

    const header = `cam${CAM}_p${preset} [FINAL·cfg없음]  globalScale=${r.result.globalScale ?? 'null(2단계 폴백)'}  regions=${r.result.regions.length}  overlapPairs=${JSON.stringify(r.result.overlapPairs)}  maxPairArea=${r.max.toExponential(2)}`;
    const angMax = Math.max(...r.meas.map((m) => Math.max(m.angTop, m.angBot)));
    const note = `최종 기본값(up=0.90/down=0.30) · 각도차 최대 ${f2(angMax)}° · 위/아래 ${f2(r.meas[0]?.upDownRatio)} · 폭비 ${f2(r.meas[0]?.widthRatio)}×(px)`;
    const svg = buildSvg(W, H, {
      floorPolys: r.floorPolys, plates: r.items.map((i) => i.quad), regions: r.result.regions, header, note, vehicleRects: r.rects,
    });
    const out = join(SHOTS, `final_cam${CAM}_p${preset}.png`);
    await compose(jpg, svg, out);

    console.log(`── [${r.key}] ${W}×${H}px  주차면=${r.floorPolys.length}  plate점유=${r.items.length}  regions=${r.result.regions.length}`);
    console.log(`   ① globalScale=${r.result.globalScale}  overlapPairs=${JSON.stringify(r.result.overlapPairs)}  최대쌍교차면적=${r.max.toExponential(3)} ${r.at ? `(idx ${r.at[0]}↔${r.at[1]})` : '(전 쌍 0)'}`);
    console.log(`   idx | ②위변각(°) ②아래변각(°) | ③|Ct−C| |Cb−C| 비    | ④아래폭(px) 판장축(px) 배     | 판종횡비(px)`);
    for (const m of r.meas) {
      console.log(
        `   ${String(m.idx).padStart(3)} | ${f2(m.angTop).padStart(9)} ${f2(m.angBot).padStart(11)} | ` +
        `${m.upLen.toFixed(1).padStart(6)} ${m.downLen.toFixed(1).padStart(6)} ${f2(m.upDownRatio).padStart(5)} | ` +
        `${m.botW.toFixed(1).padStart(9)} ${m.plateW.toFixed(1).padStart(9)} ${f2(m.widthRatio).padStart(5)} | ${f2(m.aspectPx).padStart(6)}`,
      );
    }
    console.log(`   → ${out}\n`);
  }

  // ── 전 프레임 집계 ──
  const flat = all.flatMap((a) => a.r.meas);
  const angs = flat.flatMap((m) => [m.angTop, m.angBot]);
  const uds = flat.map((m) => m.upDownRatio);
  const wrs = flat.map((m) => m.widthRatio);
  const asp = flat.map((m) => m.aspectPx);
  const rng = (v) => `min ${Math.min(...v).toFixed(3)} / max ${Math.max(...v).toFixed(3)}`;
  console.log('══ 전 프레임 집계 (인스턴스 ' + flat.length + '개, 각도 표본 ' + angs.length + '개) ══');
  console.log(`  ① overlapPairs 전부 비었나: ${all.every((a) => a.r.result.overlapPairs.length === 0) ? 'YES' : '*** NO ***'}   최대쌍교차면적 최대: ${Math.max(...all.map((a) => a.r.max)).toExponential(3)}`);
  console.log(`  ② 각도차(도)      : ${rng(angs)}`);
  console.log(`  ③ 위/아래 비      : ${rng(uds)}   (기대 3.00 = 0.90/0.30)`);
  console.log(`  ④ 폭 배율(px)     : ${rng(wrs)}   (기대 4.00, 허용 3.5~4.0)`);
  console.log(`  참고 판 픽셀 종횡비: ${rng(asp)}   (1.0 접근 시 장단축 오판 위험)`);

  // ── 스트레스: 최종 기본값으로 2단계 shrink 폴백 재확인 ──
  // 1차와 동일한 합성 입력(중심간격 0.045 · 판폭 0.030) — 실검출 아님.
  console.log('\n══ 스트레스(합성 밀착 3개) — 최종 기본값 cfg 없음 ══');
  const preset = 2;
  const jpg = join(ROOT, `data/refframes/cam${CAM}_p${preset}.jpg`);
  const { width: W, height: H } = await sharp(jpg).metadata();
  const PW = 0.030;
  const PH = 0.015;
  const GAP = 0.045;
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
  const before = computeOccupancyRegions(stressItems, { maxShrinkIters: 0 }); // 축소 전(3.5 고정) 기준선.
  const beforeMax = maxPairArea(before.regions);
  const stress = computeOccupancyRegions(stressItems); // ★ cfg 없음.
  const sMax = maxPairArea(stress.regions);
  const sHeader = `STRESS [FINAL·cfg없음]  globalScale=${stress.globalScale ?? 'null(2단계 폴백)'}  regions=${stress.regions.length}  overlapPairs=${JSON.stringify(stress.overlapPairs)}  maxPairArea=${sMax.max.toExponential(2)}`;
  const sNote = `합성 입력 — 실검출 아님. 중심간격 ${GAP} · 판폭 ${PW}. shrink 전(3.5고정) maxPairArea=${beforeMax.max.toExponential(2)} → 후 ${sMax.max.toExponential(2)}`;
  const sSvg = buildSvg(W, H, { floorPolys: [], plates: stressItems.map((i) => i.quad), regions: stress.regions, header: sHeader, note: sNote });
  const sOut = join(SHOTS, 'final_stress.png');
  await compose(jpg, sSvg, sOut);
  console.log(`  shrink 전(3.5 고정): maxPairArea=${beforeMax.max.toExponential(3)}  overlapPairs=${JSON.stringify(before.overlapPairs)}`);
  console.log(`  shrink 후          : globalScale=${stress.globalScale}  scales=[${stress.regions.map((g) => g.scale.toFixed(3)).join(', ')}]`);
  console.log(`                       maxPairArea=${sMax.max.toExponential(3)}  overlapPairs=${JSON.stringify(stress.overlapPairs)}`);
  console.log(`  → ${sOut}`);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
