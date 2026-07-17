// 5차 보조 — **측정기 자체의 판별력 검증**(위장 방지).
// 본 스크립트는 산출물이 아니라, _qa_regions_final.mjs 의 ②③④ 측정이 항상 0.00/3.00/4.00 을
// 뱉는 항진명제(tautology)인지, 아니면 결함을 실제로 잡아내는지를 확인한다.
//
// 방법: 알려진 결함/변형을 주입해 측정값이 기대대로 **움직이는지** 본다.
//   F1: 단축을 û 로 잡는 구(舊) plateAxes(2차 수정 전 = TL→TR 무조건 가로) → ② 각도차가 90° 로 뛰어야 한다.
//   F2: upRatio=0.55(4차 이전 값) 주입 → ③ 비가 1.833 으로 움직여야 한다.
//   F3: widthScaleMin/Max=3.5 주입 → ④ 배율이 3.50 으로 움직여야 한다.
// 셋 다 움직이면 측정기는 살아 있다. 안 움직이면 측정 자체가 무의미.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePtzCamRoi, selectFloorRoi, presetKey, quadCentroid } from '../web/core.js';
import { OccupancyJudge } from '../web/occupancy.js';
import { computeOccupancyRegions, plateAxes, buildTrapezoid } from '../web/occupancyRegion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE1 = join(HERE, '_qa_data');
const W = 1920, H = 1080;
const readCache1 = (n) => JSON.parse(readFileSync(join(CACHE1, n), 'utf8'));

const toPx = (p) => ({ x: p.x * W, y: p.y * H });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function angleBetween(a, b) {
  const cos = Math.abs((a.x * b.x + a.y * b.y) / (len(a) * len(b)));
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}
function plateLongAxisPx(quad) {
  const [tl, tr, br, bl] = quad.map(toPx);
  const a = { vec: mid(sub(tr, tl), sub(br, bl)), width: (len(sub(tr, tl)) + len(sub(br, bl))) / 2 };
  const b = { vec: mid(sub(bl, tl), sub(br, tr)), width: (len(sub(bl, tl)) + len(sub(br, tr))) / 2 };
  return a.width >= b.width ? a : b;
}

/** 2차 수정 **전** 구현 재현 — TL→TR 을 무조건 û 로 신뢰(장축 채택 없음). */
function plateAxesOld(quad) {
  const c = quadCentroid(quad);
  if (!c) return null;
  const [tl, tr, br, bl] = quad;
  const a = {
    x: ((tr.x - tl.x) + (br.x - bl.x)) / 2, y: ((tr.y - tl.y) + (br.y - bl.y)) / 2,
    width: (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2,
  };
  const b = { x: ((bl.x - tl.x) + (br.x - tr.x)) / 2, y: ((bl.y - tl.y) + (br.y - tr.y)) / 2 };
  const al = Math.hypot(a.x, a.y), bl2 = Math.hypot(b.x, b.y);
  const flip = b.y < 0 ? -1 : 1;
  return { c, u: { x: (a.x / al) * flip, y: (a.y / al) * flip }, v: { x: (b.x / bl2) * flip, y: (b.y / bl2) * flip }, width: a.width };
}

const judge = new OccupancyJudge();
const placeRoi = normalizePtzCamRoi(readCache1('place_roi.json')).byPreset;
function itemsOf(preset) {
  const detect = readCache1(`detect_cam1_p${preset}.json`);
  const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key: presetKey(1, preset) }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
  return judge.judge(floorPolys, detect).filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));
}

const angOf = (item, axesFn, scale = 4.0) => {
  const axes = axesFn(item.quad);
  const t = buildTrapezoid(axes, scale).map(toPx);
  return angleBetween(sub(t[2], t[3]), plateLongAxisPx(item.quad).vec); // 아래변 vs 판 장축(px)
};

console.log('══ 측정기 판별력 검증 (항진명제 여부) ══\n');

console.log('F1. ② 각도차 — 구 plateAxes(단축 오채택 결함) 주입 시 값이 움직이는가');
console.log('    preset | idx | 현행(장축채택) | 구구현(TL→TR맹신) | 판별?');
for (const preset of [1, 2, 3]) {
  for (const it of itemsOf(preset)) {
    const now = angOf(it, plateAxes);
    const old = angOf(it, plateAxesOld);
    const detected = Math.abs(old - now) > 1;
    console.log(`    p${preset}     | ${String(it.idx).padStart(3)} | ${now.toFixed(2).padStart(13)}° | ${old.toFixed(2).padStart(16)}° | ${detected ? '★ 결함 검출됨' : '동일(무결함 프레임)'}`);
  }
}

console.log('\nF2. ③ 위/아래 비 — upRatio=0.55(4차 이전) 주입 시');
for (const preset of [1]) {
  for (const it of itemsOf(preset).slice(0, 2)) {
    const axes = plateAxes(it.quad);
    const r = (cfg) => {
      const t = buildTrapezoid(axes, 4.0, cfg).map(toPx);
      const C = toPx(axes.c);
      return len(sub(mid(t[0], t[1]), C)) / len(sub(mid(t[2], t[3]), C));
    };
    console.log(`    idx ${it.idx}: 기본(cfg없음)=${r(undefined).toFixed(3)}  up=0.55주입=${r({ upRatio: 0.55 }).toFixed(3)}  → ${Math.abs(r(undefined) - r({ upRatio: 0.55 })) > 0.1 ? '★ 움직임(측정 유효)' : '고착(항진)'}`);
  }
}

console.log('\nF3. ④ 폭 배율 — widthScale 상하한 3.5 주입 시');
for (const preset of [1]) {
  const its = itemsOf(preset);
  const wr = (cfg) => {
    const res = computeOccupancyRegions(its, cfg);
    const g = res.regions[0];
    const it = its.find((x) => x.idx === g.idx);
    const t = buildTrapezoid(plateAxes(it.quad), g.scale, cfg).map(toPx);
    return len(sub(t[2], t[3])) / plateLongAxisPx(it.quad).width;
  };
  console.log(`    idx ${its[0].idx}: 기본(cfg없음)=${wr(undefined).toFixed(3)}  smin=smax=3.5주입=${wr({ widthScaleMin: 3.5, widthScaleMax: 3.5 }).toFixed(3)}  → ${Math.abs(wr(undefined) - wr({ widthScaleMin: 3.5, widthScaleMax: 3.5 })) > 0.1 ? '★ 움직임(측정 유효)' : '고착(항진)'}`);
}
