// 09 설계 검증 스크립트 — 동결 실데이터(occupancyAnchor 픽스처)로 전역 그리디 + tie-break 후보 비교.
// 코드 수정 0. plateMatch.ts 의 기하(quadBoundingRect/center/containsPoint/intersectionArea)를 그대로 복제.
import { readFile } from 'node:fs/promises';

const FIX = 'd:/Work/Parking3D/AgentVLA/ParkAgent/SettingAgent/test/fixtures/occupancyAnchor';

// ── geometry (src/domain/geometry.ts 동일 규칙 복제) ──
const quadBR = (q) => {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
const center = (r) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });
const containsPoint = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const ixArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
const px = (v, s) => Math.round(v * s);

// ── 현행 알고리즘 (plateMatch.ts:14-41 그대로) ──
function matchOld(slots, plates) {
  const result = new Map(), bestArea = new Map();
  for (const plate of plates) {
    const pr = quadBR(plate.quad), c = center(pr);
    let bestSlot = -1, bestOverlap = 0;
    for (const s of slots) {
      if (!containsPoint(s.roi, c.cx, c.cy)) continue;
      const overlap = ixArea(s.roi, pr);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestSlot = s.positionIdx; }
    }
    if (bestSlot < 0) continue;
    if (bestOverlap > (bestArea.get(bestSlot) ?? 0)) { bestArea.set(bestSlot, bestOverlap); result.set(bestSlot, plate.quad); }
  }
  return result;
}

// ── tie-break 후보 메트릭 (작을수록 우선) ──
const FRONT_BIAS = 0.62; // detectPipeline.ts:113 기존 상수
const metrics = {
  index: () => 0, // 순수 (pi,si) 폴백만
  centerDist: (c, roi) => {
    const rc = center(roi);
    return (c.cx - rc.cx) ** 2 + (c.cy - rc.cy) ** 2;
  },
  frontAnchor: (c, roi) => {
    const ax = roi.x + roi.w / 2, ay = roi.y + roi.h * FRONT_BIAS;
    return (c.cx - ax) ** 2 + (c.cy - ay) ** 2;
  },
  rectAreaSmall: (_c, roi) => roi.w * roi.h,
  groundDist: (c, roi) => Math.abs(roi.y + roi.h - c.cy),
};

// ── 전역 그리디: 후보쌍 (overlap desc, metric asc, pi asc, si asc) 정렬 → 양측 미배정일 때만 확정 ──
function matchGreedy(slots, plates, metric) {
  const pairs = [];
  plates.forEach((plate, pi) => {
    const pr = quadBR(plate.quad), c = center(pr);
    slots.forEach((s, si) => {
      if (!containsPoint(s.roi, c.cx, c.cy)) return;
      pairs.push({ pi, si, slot: s.positionIdx, overlap: ixArea(s.roi, pr), m: metric(c, s.roi), quad: plate.quad });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.m - b.m || a.pi - b.pi || a.si - b.si);
  const result = new Map(), usedPlate = new Set();
  for (const p of pairs) {
    if (usedPlate.has(p.pi) || result.has(p.slot)) continue;
    result.set(p.slot, p.quad); usedPlate.add(p.pi);
  }
  return result;
}

// ── 실행 ──
const GT = {
  // 진단 08 §2-2/§5-2 확정 정답 (plate index -> vehicle index). p1 veh2 는 정당 미귀속.
  p1: { 0: 1, 1: 4, 2: 5, 3: 3, 4: 6, 5: 0 },
  p2: null, // old 결과 + plates[5]->veh5 로 도출(아래서 구성)
  p3: null, // old 와 동일해야 함(회귀 0)
};

for (const p of ['p1', 'p2', 'p3']) {
  const d = JSON.parse(await readFile(`${FIX}/detect_cam1_${p}.json`, 'utf8'));
  const det = d.detect ?? d;
  const vehicles = det.vehicles, plates = det.plates;
  const W = det.imageSize?.w ?? 1920, H = det.imageSize?.h ?? 1080;
  const slots = vehicles.map((v, i) => ({ positionIdx: i, roi: v.rect }));

  console.log(`\n===== ${p} vehicles=${vehicles.length} plates=${plates.length} =====`);
  plates.forEach((pl, i) => {
    const c = center(quadBR(pl.quad));
    const cands = slots.filter((s) => containsPoint(s.roi, c.cx, c.cy)).map((s) => s.positionIdx);
    console.log(`  plates[${i}] c=(${px(c.cx, W)},${px(c.cy, H)}) cands=[${cands}]`);
  });

  const quadToPi = new Map(plates.map((pl, i) => [pl.quad, i]));
  const fmt = (m) => [...m.entries()].map(([slot, q]) => `veh${slot}<-p${quadToPi.get(q)}`).sort().join(' ');
  const old = matchOld(slots, plates);
  console.log(`  old        : ${fmt(old)}  (matched ${old.size}/${vehicles.length})`);
  for (const [name, metric] of Object.entries(metrics)) {
    const g = matchGreedy(slots, plates, metric);
    console.log(`  greedy/${name.padEnd(13)}: ${fmt(g)}  (matched ${g.size}/${vehicles.length})`);
  }

  // tie 상세: 동률 쌍의 각 메트릭 값 출력(p1 plates[4]/plates[5], p2 plates[5])
  plates.forEach((pl, i) => {
    const pr = quadBR(pl.quad), c = center(pr);
    const cands = slots.filter((s) => containsPoint(s.roi, c.cx, c.cy));
    if (cands.length < 2) return;
    const ovs = cands.map((s) => ixArea(s.roi, pr));
    if (Math.abs(ovs[0] - ovs[1]) > 1e-12) return; // 포화 동률만
    console.log(`  ★tie plates[${i}]:`);
    for (const s of cands) {
      const roi = s.roi, rc = center(roi);
      console.log(
        `    veh${s.positionIdx} rect=(${px(roi.x, W)}..${px(roi.x + roi.w, W)}, ${px(roi.y, H)}..${px(roi.y + roi.h, H)})` +
        ` centerDist=${Math.sqrt(metrics.centerDist(c, roi)).toFixed(5)}` +
        ` frontAnchor=${Math.sqrt(metrics.frontAnchor(c, roi)).toFixed(5)}` +
        ` area=${(roi.w * roi.h).toFixed(5)} groundDist=${metrics.groundDist(c, roi).toFixed(5)}`,
      );
    }
  });
}

// ── lpdFilterRegression 합성 케이스(단일 차량·판 2장 동일 크기 완전 포함) 재현 ──
console.log('\n===== lpdFilterRegression :332 합성 케이스 (PARKED rect 안 true/noise 동일 크기) =====');
const rectToQuad = (r) => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
];
// test 파일의 PARKED rect 를 읽어 정확히 재현해야 하나, 여기선 주석 실측(y 0.18~0.44) 기반 근사 + 좌표 명시.
const PARKED = { x: 0.36, y: 0.18, w: 0.14, h: 0.26 }; // 실파일 값은 테스트에서 재확인 필요
const mkPlate = (cx, cy) => ({ quad: rectToQuad({ x: cx - 0.024, y: cy - 0.012, w: 0.048, h: 0.024 }) });
const truP = mkPlate(0.43, 0.335), noiP = mkPlate(0.43, 0.29);
const slots1 = [{ positionIdx: 0, roi: PARKED }];
for (const [name, metric] of Object.entries(metrics)) {
  const g = matchGreedy(slots1, [truP, noiP], metric);
  const winner = g.get(0) === truP.quad ? 'TRUE' : g.get(0) === noiP.quad ? 'NOISE★회귀' : 'none';
  console.log(`  greedy/${name.padEnd(13)}: slot0 <- ${winner}`);
}
console.log(`  old        : slot0 <- ${matchOld(slots1, [truP, noiP]).get(0) === truP.quad ? 'TRUE' : 'NOISE'}`);

// ── (C) 가드 ε 근거: p1 회수점 vs 배정판 최소거리 / 판간 최소거리 ──
console.log('\n===== (C) ε 근거 — p1 정규화 거리 =====');
const d1 = JSON.parse(await readFile(`${FIX}/detect_cam1_p1.json`, 'utf8'));
const det1 = d1.detect ?? d1;
const cts = det1.plates.map((pl) => center(quadBR(pl.quad)));
let minSpace = Infinity;
for (let i = 0; i < cts.length; i++) for (let j = i + 1; j < cts.length; j++) {
  minSpace = Math.min(minSpace, Math.hypot(cts[i].cx - cts[j].cx, cts[i].cy - cts[j].cy));
}
console.log(`  base 판간 최소 정규화 거리 = ${minSpace.toFixed(4)}`);
for (const v of det1.vehicles) {
  if (!v.plate?.recovered) continue;
  const rc = center(quadBR(v.plate.quad));
  const dmin = Math.min(...cts.map((c) => Math.hypot(c.cx - rc.cx, c.cy - rc.cy)));
  console.log(`  recovered 판 c=(${px(rc.cx, 1920)},${px(rc.cy, 1080)}) → base 판 최근접 정규화 거리 = ${dmin.toFixed(4)}`);
}
