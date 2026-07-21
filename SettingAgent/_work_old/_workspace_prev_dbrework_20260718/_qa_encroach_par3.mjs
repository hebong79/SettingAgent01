// 검증자 보조 — "위 변이 넓어져 이웃 차량 침범이 늘었는가"를 육안이 아닌 **면적 실측**으로 판정.
//
// overlapPairs/maxPairArea 는 region↔region 겹침만 본다. 침범은 다른 질문이다:
//   region 이 **이웃 차량의 rect** 를 얼마나 덮는가. 1.0 과 0.85 를 동일 입력으로 대조한다.
// 사용: SettingAgent> node _workspace/_qa_encroach_par3.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePtzCamRoi, selectFloorRoi, presetKey } from '../web/core.js';
import { OccupancyJudge, convexIntersectionArea, polygonArea } from '../web/occupancy.js';
import { computeOccupancyRegions } from '../web/occupancyRegion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '_qa_data_final2');
const CAM = 1;
const PRESETS = [1, 2, 3];
const readData = (n) => JSON.parse(readFileSync(join(DATA, n), 'utf8'));

const quadKey = (q) => q.map((p) => `${p.x.toFixed(9)},${p.y.toFixed(9)}`).join(';');
const rectPoly = (r) => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
];

const judge = new OccupancyJudge();
const placeRoi = normalizePtzCamRoi(readData('place_roi.json')).byPreset;

console.log('══ 이웃 차량 rect 침범 면적 — 1.0(신) vs 0.85(구), 동일 입력 ══\n');
const totals = {};

for (const preset of PRESETS) {
  const detect = readData(`detect_cam${CAM}_p${preset}.json`);
  const key = presetKey(CAM, preset);
  const floorPolys = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
  const judged = judge.judge(floorPolys, detect);
  const items = judged.filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));

  // region idx → 자기 차량 rect.
  const vmap = new Map();
  for (const v of detect.vehicles ?? []) if (v?.plate?.quad) vmap.set(quadKey(v.plate.quad), v.rect);
  const ownRect = new Map(items.map((it) => [it.idx, vmap.get(quadKey(it.quad))]));
  const allRects = (detect.vehicles ?? []).map((v) => v.rect);

  for (const ratio of [1.0, 0.85]) {
    const res = computeOccupancyRegions(items, { topWidthRatio: ratio });
    let sumEncroach = 0;
    let maxEncroach = 0;
    let maxAt = null;
    let sumOwn = 0;
    for (const g of res.regions) {
      const area = polygonArea(g.polygon);
      const own = ownRect.get(g.idx);
      // 자기 차량 rect 를 덮는 비율(높을수록 자기 차 위에 잘 서 있다).
      if (own) sumOwn += convexIntersectionArea(g.polygon, rectPoly(own)) / (area || 1);
      // 이웃(자기 것이 아닌) rect 를 덮는 면적.
      for (const r of allRects) {
        if (own && r.x === own.x && r.y === own.y && r.w === own.w && r.h === own.h) continue;
        const a = convexIntersectionArea(g.polygon, rectPoly(r));
        sumEncroach += a;
        if (a / (area || 1) > maxEncroach) { maxEncroach = a / (area || 1); maxAt = g.idx; }
      }
    }
    const k = `p${preset}_${ratio}`;
    totals[k] = { sumEncroach, maxEncroach, maxAt, ownCover: sumOwn / (res.regions.length || 1), n: res.regions.length };
  }

  const a = totals[`p${preset}_1`];
  const b = totals[`p${preset}_0.85`];
  console.log(`── [${key}] regions=${a.n}`);
  console.log(`   ratio | 자기차 rect 덮는 비율(평균) | 이웃 rect 침범면적 합 | 단일 region 최대 침범비(그 idx)`);
  console.log(`   1.0   | ${(a.ownCover * 100).toFixed(2).padStart(9)}%              | ${a.sumEncroach.toExponential(3).padStart(9)}          | ${(a.maxEncroach * 100).toFixed(2)}% (idx ${a.maxAt ?? '-'})`);
  console.log(`   0.85  | ${(b.ownCover * 100).toFixed(2).padStart(9)}%              | ${b.sumEncroach.toExponential(3).padStart(9)}          | ${(b.maxEncroach * 100).toFixed(2)}% (idx ${b.maxAt ?? '-'})`);
  const d = a.sumEncroach - b.sumEncroach;
  console.log(`   → 침범면적 증감(1.0 − 0.85): ${d >= 0 ? '+' : ''}${d.toExponential(3)}  ${d > 0 ? '(1.0 이 더 침범)' : d < 0 ? '(1.0 이 덜 침범)' : '(동일)'}\n`);
}
