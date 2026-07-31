// ★ 24회차 계측 전용 — **접지선 오차 실측**(설계 §2-2 예측 P-a/P-b 대조용).
//
// 이미지 유래 seg 근변(빨간선)과 강등본 접지사각형의 근변을 **같은 프레임에서** 비교해
//   (1) 접지선 y 편의(px · 부호: + = 화면 아래 = 카메라 쪽 = 그림자 누출 방향)
//   (2) 길이축(head) 방위 오차(도)
// 를 낸다. 채점·계측 전용이며 검출 경로가 아니다(강등본은 오라클이므로 여기서만 접촉).
//
// 사용: npx tsx src/tools/groundErrProbe.ts v1 --cache reports/detcache_r24

import { pathToFileURL } from 'node:url';
import { bottomContour } from '../ground/contact.js';
import type { PixelQuad } from '../ground/types.js';
import { carList, footprintToGround, groundAxisOf, viewsOf } from './carAnchorUpper.js';
import { simDegradedSource } from './individualEngine.js';
import { footprintFromContact, nearEdgeOf, readSegCache, CONTOUR_STEP_PX } from './imageObservation.js';
import { goldenTargets, GOLDEN_DIRS, quantiles } from './sepAudit.js';

const midOfEdge = (q: PixelQuad, i: number) => ({ x: (q[i].x + q[(i + 1) % 4].x) / 2, y: (q[i].y + q[(i + 1) % 4].y) / 2 });

/** 화면상 가장 아래(카메라 쪽) 변의 두 끝점 — `individualEngine.edgeHitOf` 와 같은 near 정의. */
function nearEdgeOfQuad(q: PixelQuad): [{ x: number; y: number }, { x: number; y: number }] {
  let n = 0;
  for (let i = 1; i < 4; i++) if (midOfEdge(q, i).y > midOfEdge(q, n).y) n = i;
  return [q[n], q[(n + 1) % 4]];
}

/** 선분 (a,b) 위 x 에서의 y (수직이면 중점 y). */
function yAt(a: { x: number; y: number }, b: { x: number; y: number }, x: number): number {
  return Math.abs(b.x - a.x) < 1e-6 ? (a.y + b.y) / 2 : a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
}

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const cacheDir = argOf('--cache', 'reports/detcache_r24');
  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  const views = viewsOf(targets);
  const cars = await carList();
  const deg = simDegradedSource(cars, { seed: 1 });

  const dys: number[] = [];
  const angs: number[] = [];
  console.log(`24회차 접지선 오차 실측 — 대상 ${targetArg} · 캐시 ${cacheDir}\n` + `dy 부호: + = 화면 아래(카메라 쪽 · 그림자 누출 방향) / − = 위\n`);
  for (const t of targets) {
    const view = views.get(t.key);
    const c = readSegCache(cacheDir, t.frameHash);
    if (!view || !c) continue;
    const truth = deg.observe(t, view).filter((o) => o.footprintPx);
    for (const b of c.boxes) {
      const maskPx = b.mask.map((p) => ({ x: p.x * t.W, y: p.y * t.H }));
      const e = nearEdgeOf(bottomContour(maskPx, CONTOUR_STEP_PX));
      if (!e) continue;
      const mid = { x: (e[0].x + e[1].x) / 2, y: (e[0].y + e[1].y) / 2 };
      // 가장 가까운 강등본(=그 마스크가 가리키는 차) — 접지사각형 중심 거리 최소.
      let best: { dy: number; ang: number; id: string } | null = null;
      let bestD = Infinity;
      for (const o of truth) {
        const q = o.footprintPx as PixelQuad;
        const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
        const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
        const d = Math.hypot(cx - mid.x, cy - mid.y);
        if (d >= bestD) continue;
        const [na, nb] = nearEdgeOfQuad(q);
        const dy = mid.y - yAt(na, nb, mid.x);
        // 방위 오차 — 이미지 유래 quad 와 강등본 quad 의 지면 head 사이 각(0..90도).
        const fp = footprintFromContact(e[0], e[1], t.model);
        const Gi = fp ? footprintToGround(fp, t.model) : null;
        const Gt = footprintToGround(q, t.model);
        const ai = Gi ? groundAxisOf(Gi) : null;
        const at = Gt ? groundAxisOf(Gt) : null;
        let ang = NaN;
        if (ai && at) {
          const dp = Math.abs(ai.head[0] * at.head[0] + ai.head[1] * at.head[1] + ai.head[2] * at.head[2]);
          ang = (Math.acos(Math.min(1, dp)) * 180) / Math.PI;
        }
        bestD = d;
        best = { dy, ang, id: o.obsId };
      }
      if (!best) continue;
      dys.push(best.dy);
      if (Number.isFinite(best.ang)) angs.push(best.ang);
      console.log(`  ${t.key} seg#${b.vpdIdx} ↔ ${best.id}  접지선dy=${best.dy} px  방위오차=${best.ang} 도`);
    }
  }
  const st = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = quantiles(s);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return `n=${s.length} min=${s[0]} median=${q?.median} p90=${q?.p90} max=${q?.max} mean=${mean}`;
  };
  console.log(`\n★ 접지선 y 편의(px): ${st(dys)}`);
  console.log(`★ 접지선 |y 편의|(px): ${st(dys.map(Math.abs))}`);
  console.log(`★ 길이축 방위 오차(도): ${st(angs)}`);
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) await main();
