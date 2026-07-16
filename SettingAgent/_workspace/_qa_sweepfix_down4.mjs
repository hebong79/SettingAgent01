import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePtzCamRoi, selectFloorRoi, presetKey } from '../web/core.js';
import { OccupancyJudge } from '../web/occupancy.js';
import { computeOccupancyRegions, plateAxes, buildTrapezoid } from '../web/occupancyRegion.js';
const FIX = 'd:/Work/Parking3D/AgentVLA/ParkAgent/SettingAgent/test/fixtures/occupancyAnchor';
const rd = (n) => JSON.parse(readFileSync(join(FIX, n), 'utf8'));
const judge = new OccupancyJudge();
const placeRoi = normalizePtzCamRoi(rd('place_roi.json')).byPreset;
const files = { 1: 'detect_cam1_p1_fixed.json', 2: 'detect_cam1_p2.json', 3: 'detect_cam1_p3.json' };
const itemsFor = (preset) => {
  const detect = rd(files[preset]);
  const key = presetKey(1, preset);
  const fp = selectFloorRoi({ useLlm: false, placeRoi, key }).polygons.map((p) => ({ idx: Number(p.label), quad: p.quad }));
  return judge.judge(fp, detect).filter((o) => o.source === 'plate' && o.plateQuad).map((o) => ({ idx: o.idx, quad: o.plateQuad }));
};
const maxYof = (item, scale, dr) => {
  const ax = plateAxes(item.quad); if (!ax) return null;
  return Math.max(...buildTrapezoid(ax, scale, { downRatio: dr }).map((p) => p.y));
};
console.log('== 구현자 픽스처(test/fixtures/occupancyAnchor) 기준 ==');
for (const p of [1,2,3]) {
  const items = itemsFor(p);
  const res = computeOccupancyRegions(items, { downRatio: 0.60 });
  const byIdx = new Map(items.map((i) => [i.idx, i]));
  let worst = null;
  for (const g of res.regions) {
    const my = maxYof(byIdx.get(g.idx), g.scale, 0.60);
    if (!worst || my > worst.my) worst = { idx: g.idx, my };
  }
  console.log(`  p${p}: 최소여유 idx=${worst.idx} maxY=${worst.my.toFixed(4)} 여유=${(1-worst.my).toFixed(4)}`);
}
let hit = null;
for (let d = 0.60; d <= 1.5001 && !hit; d = Math.round((d + 0.01) * 1000) / 1000) {
  for (const p of [1,2,3]) {
    const items = itemsFor(p);
    const res = computeOccupancyRegions(items, { downRatio: d });
    const byIdx = new Map(items.map((i) => [i.idx, i]));
    for (const g of res.regions) {
      const my = maxYof(byIdx.get(g.idx), g.scale, d);
      if (my > 1 && !hit) hit = { d, p, idx: g.idx, my };
    }
  }
}
console.log(hit ? `  첫 하단 초과: downRatio=${hit.d} p${hit.p} idx=${hit.idx} maxY=${hit.my.toFixed(4)}` : '  1.5 까지 초과 없음');
