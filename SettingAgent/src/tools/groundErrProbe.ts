// ★ 24회차 계측 전용 — **접지선 오차 실측**(설계 §2-2 예측 P-a/P-b 대조용).
//
// 이미지 유래 seg 근변(빨간선)과 강등본 접지사각형의 근변을 **같은 프레임에서** 비교해
//   (1) 접지선 y 편의(px · 부호: + = 화면 아래 = 카메라 쪽 = 그림자 누출 방향)
//   (2) 길이축(head) 방위 오차(도)
// 를 낸다. 채점·계측 전용이며 검출 경로가 아니다(강등본은 오라클이므로 여기서만 접촉).
//
// 사용: npx tsx src/tools/groundErrProbe.ts v1 --cache reports/detcache_r24

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { MATCH_MIN_IOU, quadIoU } from '../ground/autoRoiPlan.js';
import { bottomContour, rejectOccluded, toOtherMask } from '../ground/contact.js';
import type { GroundModel, PixelQuad } from '../ground/types.js';
import type { Vec3 } from '../ground/contactTypes.js';
import { backprojectToGround } from '../ground/project.js';
import { CAR_BODY, carList, footprintToGround, groundAxisOf, viewsOf } from './carAnchorUpper.js';
import { simDegradedSource } from './individualEngine.js';
import { footprintFromContact, nearEdgeOf, readLpdCache, readSegCache, CONTOUR_STEP_PX } from './imageObservation.js';
import { buildTrapezoid, plateAxes, REGION_DEFAULTS } from '../domain/occupancyRegion.js';
import type { NormalizedQuad } from '../domain/types.js';
import { clampSpan, frontEdgeOf, groundBasis, groundLen, segEndpoints, splitContour, toGround2D, type EdgeFit, type KinkSplit, type Px } from './contactOrient.js';
import { goldenTargets, GOLDEN_DIRS, quantiles, type Target } from './sepAudit.js';

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

// ═════════════════════════════════════════════════════════════════════════════
// ★ 26회차 단계1 계측(`--probe`) — 설계 §3-1 M1~M6. **수리 전** 측정이며 검출 경로 변경 0.
// ═════════════════════════════════════════════════════════════════════════════

const sortNum = (xs: readonly number[]): number[] => [...xs].filter(Number.isFinite).sort((a, b) => a - b);
/** 분위수 — `sepAudit.quantiles` 의 p90 규약(s[ceil(q·n)−1])과 같은 정의. */
const pct = (s: readonly number[], q: number): number => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : NaN);
const med = (s: readonly number[]): number => (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
/** 설계자 실측이 쓴 중앙값 규약(짝수 n 에서 **아래쪽 중앙값** = `nearEdgeOf` 의 `z[floor(n/2)]` 계열). 대조 전용. */
const medLow = (s: readonly number[]): number => s[Math.floor((s.length - 1) / 2)];
const dist = (xs: readonly number[]): string => {
  const s = sortNum(xs);
  return `n=${s.length} min=${s[0]} p25=${pct(s, 0.25)} median=${med(s)} medianLow=${medLow(s)} p75=${pct(s, 0.75)} max=${s[s.length - 1]}`;
};

/** 앞변 2점 → 접지 quad → 지면 장축. 방위 비교의 유일한 경로(`groundAxisOf` 재사용). */
function headOf(e: readonly [Px, Px], g: GroundModel): Vec3 | null {
  const fp = footprintFromContact(e[0], e[1], g);
  const G = fp ? footprintToGround(fp, g) : null;
  const a = G ? groundAxisOf(G) : null;
  return a ? a.head : null;
}

/** 두 지면 장축 사이 각(0..90도). */
function angDeg(a: Vec3 | null, b: Vec3 | null): number {
  if (!a || !b) return NaN;
  return (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
}

/** ⓒ 음성 대조군 — 콘투어 중 최하단 y 에서 τpx 이내 열만 남겨 좌우 끝을 잇는다(설계 §2-3). */
export function nearBandEdge(cols: readonly Px[], bandPx: number): [Px, Px] | null {
  if (cols.length < 4) return null;
  const yMax = Math.max(...cols.map((c) => c.y));
  const keep = cols.filter((c) => c.y >= yMax - bandPx);
  return keep.length >= 2 ? nearEdgeOf(keep) : null;
}

/** 한 마스크의 계측 레코드 — 검출 경로가 아니라 **측정**이다. */
interface MaskRec {
  key: string;
  vpdIdx: number;
  cols: Px[];
  chord: [Px, Px];
  /** 픽셀공간 분해. */
  sp: KinkSplit | null;
  /** 지면공간 분해(콘투어를 지면 2D 로 올린 뒤 같은 정의로 분할). */
  spG: KinkSplit | null;
  /** 가림배제 후 지면공간 분해(M3). */
  spGocc: KinkSplit | null;
  chordLenM: number | null;
  /** 두 선분의 픽셀 끝점과 지면 길이. */
  eA: [Px, Px] | null;
  eB: [Px, Px] | null;
  lenA: number | null;
  lenB: number | null;
  /** 규칙별 선택(0=A · 1=B). */
  r1: number | null;
  r2: number | null;
  r3: number | null;
  /** 방위 오차(도) — 계측 전용 오라클(강등본) 대조. */
  angChord: number;
  angA: number;
  angB: number;
  angBand: number;
  /** best-of-two 의 승자(0=A · 1=B). */
  bestIdx: number | null;
  /** 스팬 클램프(§4-3) 적용 시 방위 오차와 승자. */
  angAc: number;
  angBc: number;
  bestIdxC: number | null;
  /** ★ 실제 산출 경로(`frontEdgeOf` · 규칙 R3 · 게이트 τ20/τ1.5)의 결과. */
  fit: EdgeFit | null;
  angKink: number;
  frontLenM: number | null;
  /** 접지선 y 편의(px) — 강등본 근변 대비. */
  dyChord: number;
  dyKink: number;
  /** 채점·스샷 전용 정답 quad(강등본). 검출 경로에 흐르지 않는다. */
  truthQ: PixelQuad | null;
}

/** 마스크 1개 → 계측 레코드. 정답(강등본 head)은 채점 인자로만 들어온다. */
function measureMask(
  t: Target,
  vpdIdx: number,
  maskPx: Px[],
  others: ReadonlyArray<readonly Px[]>,
  truthQ: PixelQuad | null,
): MaskRec | null {
  const cols = bottomContour(maskPx, CONTOUR_STEP_PX);
  const chord = nearEdgeOf(cols);
  if (!chord) return null;
  const Gt = truthQ ? footprintToGround(truthQ, t.model) : null;
  const at = Gt ? groundAxisOf(Gt) : null;
  const truthHead: Vec3 | null = at ? at.head : null;
  const basis = groundBasis(t.model);
  const colsG = basis ? cols.map((c) => toGround2D(c, t.model, basis)) : [];
  const colsGok = colsG.every((p) => p != null) ? (colsG as Px[]) : null;
  const occ = rejectOccluded(cols, others.map((o) => toOtherMask(o)), 6, t.H);
  const occG = basis ? occ.valid.map((c) => toGround2D(c, t.model, basis)) : [];
  const occGok = occG.length >= 8 && occG.every((p) => p != null) ? (occG as Px[]) : null;

  const sp = splitContour(cols, 4);
  const eA = sp ? segEndpoints(sp.segA, sp.a) : null;
  const eB = sp ? segEndpoints(sp.segB, sp.b) : null;
  const lenA = eA ? groundLen(eA[0], eA[1], t.model) : null;
  const lenB = eB ? groundLen(eB[0], eB[1], t.model) : null;

  // 규칙 3종(전부 비-오라클) — 설계 §3-2.
  let r1: number | null = null;
  let r2: number | null = null;
  let r3: number | null = null;
  if (sp && eA && eB) {
    if (lenA != null && lenB != null) r1 = lenA <= lenB ? 0 : 1; // R1 짧은 쪽
    const yA = sp.segA.reduce((s, p) => s + p.y, 0) / sp.segA.length;
    const yB = sp.segB.reduce((s, p) => s + p.y, 0) / sp.segB.length;
    r2 = yA >= yB ? 0 : 1; // R2 화면 아래
    // R3 시선직교 — 카메라 직하점에서 선분 중점으로 향하는 지면 방향과의 각이 큰 쪽.
    const nadir: Vec3 = [t.model.n[0] * t.model.d, t.model.n[1] * t.model.d, t.model.n[2] * t.model.d];
    const radialAng = (e: readonly [Px, Px]): number => {
      const A = backprojectToGround(e[0], t.model);
      const B = backprojectToGround(e[1], t.model);
      if (!A || !B) return NaN;
      const mid: Vec3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
      const rv: Vec3 = [mid[0] - nadir[0], mid[1] - nadir[1], mid[2] - nadir[2]];
      const sv: Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const rn = Math.hypot(rv[0], rv[1], rv[2]);
      const sn = Math.hypot(sv[0], sv[1], sv[2]);
      if (!(rn > 1e-9 && sn > 1e-9)) return NaN;
      return angDeg([rv[0] / rn, rv[1] / rn, rv[2] / rn], [sv[0] / sn, sv[1] / sn, sv[2] / sn]);
    };
    const ra = radialAng(eA);
    const rb = radialAng(eB);
    if (Number.isFinite(ra) && Number.isFinite(rb)) r3 = ra >= rb ? 0 : 1;
  }

  const band = nearBandEdge(cols, 12);
  const angChord = angDeg(headOf(chord, t.model), truthHead);
  const angA = eA ? angDeg(headOf(eA, t.model), truthHead) : NaN;
  const angB = eB ? angDeg(headOf(eB, t.model), truthHead) : NaN;
  const angBand = band ? angDeg(headOf(band, t.model), truthHead) : NaN;
  const bestIdx = Number.isFinite(angA) && Number.isFinite(angB) ? (angA <= angB ? 0 : 1) : null;
  // §4-3 조건부 예외의 사전 측정 — 스팬 클램프가 축 뒤집힘을 되돌리는가.
  const fit = frontEdgeOf(cols, t.model, chord);
  const fe: [Px, Px] | null = fit ? [fit.p0, fit.p1] : null;
  const angKink = fe ? angDeg(headOf(fe, t.model), truthHead) : NaN;
  const frontLenM = fe ? groundLen(fe[0], fe[1], t.model) : null;
  const dyOf = (e: readonly [Px, Px]): number => {
    if (!truthQ) return NaN;
    const m = { x: (e[0].x + e[1].x) / 2, y: (e[0].y + e[1].y) / 2 };
    const [na, nb] = nearEdgeOfQuad(truthQ);
    return m.y - yAt(na, nb, m.x);
  };
  const cA = eA ? clampSpan(eA, t.model, CAR_BODY.lengthM, CAR_BODY.widthM) : null;
  const cB = eB ? clampSpan(eB, t.model, CAR_BODY.lengthM, CAR_BODY.widthM) : null;
  const angAc = cA ? angDeg(headOf(cA, t.model), truthHead) : NaN;
  const angBc = cB ? angDeg(headOf(cB, t.model), truthHead) : NaN;
  const bestIdxC = Number.isFinite(angAc) && Number.isFinite(angBc) ? (angAc <= angBc ? 0 : 1) : null;

  return {
    key: t.key,
    vpdIdx,
    cols,
    chord,
    sp,
    spG: colsGok ? splitContour(colsGok, 4) : null,
    spGocc: occGok ? splitContour(occGok, 4) : null,
    chordLenM: groundLen(chord[0], chord[1], t.model),
    eA,
    eB,
    lenA,
    lenB,
    r1,
    r2,
    r3,
    angChord,
    angA,
    angB,
    angBand,
    bestIdx,
    angAc,
    angBc,
    bestIdxC,
    fit,
    angKink,
    frontLenM,
    dyChord: dyOf(chord),
    dyKink: fe ? dyOf(fe) : NaN,
    truthQ,
  };
}

/** 마스크 ↔ 강등본 짝짓기 — 기본 실행(`nearEdgeOf` 중점 최근접)과 **같은 규칙**이라 짝이 바뀌지 않는다. */
function collectRecords(
  targets: readonly Target[],
  cacheDir: string,
  views: Map<string, ReturnType<typeof viewsOf> extends Map<string, infer V> ? V : never>,
  deg: ReturnType<typeof simDegradedSource>,
): MaskRec[] {
  const recs: MaskRec[] = [];
  for (const t of targets) {
    const view = views.get(t.key);
    const c = readSegCache(cacheDir, t.frameHash);
    if (!view || !c) continue;
    const truth = deg.observe(t, view).filter((o) => o.footprintPx);
    const masks = c.boxes.map((b) => b.mask.map((p) => ({ x: p.x * t.W, y: p.y * t.H })));
    for (let i = 0; i < c.boxes.length; i++) {
      const b = c.boxes[i];
      const cols = bottomContour(masks[i], CONTOUR_STEP_PX);
      const e = nearEdgeOf(cols);
      if (!e) continue;
      const mid = { x: (e[0].x + e[1].x) / 2, y: (e[0].y + e[1].y) / 2 };
      let bestD = Infinity;
      let truthQ: PixelQuad | null = null;
      for (const o of truth) {
        const q = o.footprintPx as PixelQuad;
        const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
        const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
        const d = Math.hypot(cx - mid.x, cy - mid.y);
        if (d >= bestD) continue;
        bestD = d;
        truthQ = q;
      }
      const r = measureMask(t, b.vpdIdx, masks[i], masks.filter((_, j) => j !== i), truthQ);
      if (r) recs.push(r);
    }
  }
  return recs;
}

async function runProbe(targets: readonly Target[], cacheDir: string): Promise<void> {
  const views = viewsOf(targets);
  const cars = await carList();
  const deg = simDegradedSource(cars, { seed: 1 });
  const recs = collectRecords(targets, cacheDir, views, deg);

  console.log(`\n★ 26회차 단계1 — 꺾임 존재 측정(수리 전 · 검출 경로 변경 0) · 마스크 ${recs.length}개\n`);
  console.log(`  대상 seg#  콘투어열  픽셀꺾임각  픽셀개선배수  지면꺾임각  지면개선배수  chord지면m  선분A m  선분B m`);
  for (const r of recs) {
    console.log(
      `  ${r.key} #${r.vpdIdx}  ${r.cols.length}  ${r.sp?.kinkDeg}  ${r.sp?.gain}  ${r.spG?.kinkDeg}  ${r.spG?.gain}  ${r.chordLenM}  ${r.lenA}  ${r.lenB}`,
    );
  }

  const kp = recs.map((r) => r.sp?.kinkDeg).filter((v): v is number => v != null);
  const gp = recs.map((r) => r.sp?.gain).filter((v): v is number => v != null);
  const kg = recs.map((r) => r.spG?.kinkDeg).filter((v): v is number => v != null);
  const gg = recs.map((r) => r.spG?.gain).filter((v): v is number => v != null);
  const kgo = recs.map((r) => r.spGocc?.kinkDeg).filter((v): v is number => v != null);
  console.log(`\n★ M1 픽셀 꺾임각(도): ${dist(kp)}`);
  console.log(`★ M1 픽셀 개선배수  : ${dist(gp)}`);
  console.log(`★ M1 지면 꺾임각(도): ${dist(kg)}`);
  console.log(`★ M1 지면 개선배수  : ${dist(gg)}`);
  console.log(`   ≥20°(픽셀) ${kp.filter((v) => v >= 20).length}/${kp.length}  ≥30°(픽셀) ${kp.filter((v) => v >= 30).length}/${kp.length}  개선배수≥1.5 ${gp.filter((v) => v >= 1.5).length}/${gp.length}`);
  console.log(`   콘투어 열 수: ${dist(recs.map((r) => r.cols.length))}`);

  // M2 — τ 는 **분포에서** 뽑는다(사후 조정 금지). τ_deg=20(설계 §1-3 이 쓴 문턱) · τ_gain=1.5(같은 문헌 문턱).
  const TAU_DEG = 20;
  const TAU_GAIN = 1.5;
  const hit = recs.filter((r) => r.sp != null && r.sp.kinkDeg >= TAU_DEG && r.sp.gain >= TAU_GAIN).length;
  console.log(`\n★ M2 꺾임 검출률: τ_deg=${TAU_DEG} τ_gain=${TAU_GAIN} → ${hit}/${recs.length} = ${hit / recs.length}`);
  console.log(`   ${hit / recs.length < 0.5 ? '⚠ 0.5 미만 → §9 S1 발동(수리 착수 없이 K1 조기 발동)' : 'S1 미발동(0.5 이상)'}`);

  console.log(`\n★ M3 가림배제(rejectOccluded belowPx=6) 후 지면 꺾임각: ${dist(kgo)}`);
  console.log(`   (배제 전 지면 median=${med(sortNum(kg))} · 90° 로 접근하는가를 본다)`);

  const lens = recs.flatMap((r) => [r.lenA, r.lenB]).filter((v): v is number => v != null);
  const chords = recs.map((r) => r.chordLenM).filter((v): v is number => v != null);
  console.log(`\n★ M4 두 선분 지면 길이(m): ${dist(lens)}  · 4.7m 초과 ${lens.filter((v) => v > CAR_BODY.lengthM).length}/${lens.length}`);
  console.log(`   chord 지면 길이(m)   : ${dist(chords)}  · 4.7m 초과 ${chords.filter((v) => v > CAR_BODY.lengthM).length}/${chords.length} · 1.85m 초과 ${chords.filter((v) => v > CAR_BODY.widthM).length}/${chords.length}`);

  const both = recs.filter((r) => r.bestIdx != null);
  const agree = (pick: (r: MaskRec) => number | null): string => {
    const ok = both.filter((r) => pick(r) != null && pick(r) === r.bestIdx).length;
    return `${ok}/${both.length} = ${ok / both.length}`;
  };
  const errOf = (pick: (r: MaskRec) => number | null): number[] =>
    both.map((r) => (pick(r) === 0 ? r.angA : pick(r) === 1 ? r.angB : NaN)).filter(Number.isFinite);
  console.log(`\n★ M5 앞/옆 선택 규칙 일치율(vs best-of-two · 계측 전용)`);
  console.log(`   R1 길이(짧은 쪽)   : ${agree((r) => r.r1)}  방위오차 median=${med(sortNum(errOf((r) => r.r1)))}`);
  console.log(`   R2 하단(화면 아래) : ${agree((r) => r.r2)}  방위오차 median=${med(sortNum(errOf((r) => r.r2)))}`);
  console.log(`   R3 시선직교        : ${agree((r) => r.r3)}  방위오차 median=${med(sortNum(errOf((r) => r.r3)))}`);

  // §4-3 조건부 예외 — 스팬 클램프 효과(축 뒤집힘 되돌림).
  const flipA = recs.filter((r) => r.lenA != null && r.lenA > CAR_BODY.lengthM).length;
  const flipB = recs.filter((r) => r.lenB != null && r.lenB > CAR_BODY.lengthM).length;
  console.log(`
★ §4-3 스팬 클램프 사전 측정 — 선분 지면길이 > 4.7m: A ${flipA}/${recs.length} · B ${flipB}/${recs.length}`);
  const agreeC = (pick: (r: MaskRec) => number | null): string => {
    const bc = recs.filter((r) => r.bestIdxC != null);
    const ok = bc.filter((r) => pick(r) != null && pick(r) === r.bestIdxC).length;
    return `${ok}/${bc.length} = ${ok / bc.length}`;
  };
  const errC = (pick: (r: MaskRec) => number | null): number[] =>
    recs.map((r) => (pick(r) === 0 ? r.angAc : pick(r) === 1 ? r.angBc : NaN)).filter(Number.isFinite);
  console.log(`   클램프 후 R1: ${agreeC((r) => r.r1)} 오차median=${med(sortNum(errC((r) => r.r1)))}`);
  console.log(`   클램프 후 R2: ${agreeC((r) => r.r2)} 오차median=${med(sortNum(errC((r) => r.r2)))}`);
  console.log(`   클램프 후 R3: ${agreeC((r) => r.r3)} 오차median=${med(sortNum(errC((r) => r.r3)))}`);
  console.log(`   클램프 후 best-of-two: ${dist(recs.map((r) => Math.min(r.angAc, r.angBc)))}`);

  const bo = both.map((r) => Math.min(r.angA, r.angB));
  console.log(`\n★ M6 best-of-two 방위 오차(도): ${dist(bo)}`);
  console.log(`   현행 chord 방위 오차(도)    : ${dist(recs.map((r) => r.angChord))}`);
  console.log(`   ⓒ 근측밴드(12px) 방위 오차  : ${dist(recs.map((r) => r.angBand))}`);
}


// ── 스샷(설계 §7) — 같은 frameHash 에서 **수리 전/후 2장을 나란히** ────────────
const f1 = (v: number): string => v.toFixed(1);
const polyStr = (q: PixelQuad): string => q.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ');
const lineStr = (e: readonly [Px, Px], stroke: string, w: number, dash = ''): string =>
  `<line x1="${f1(e[0].x)}" y1="${f1(e[0].y)}" x2="${f1(e[1].x)}" y2="${f1(e[1].y)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

async function drawEdgeOverlays(targets: readonly Target[], cacheDir: string, recs: readonly MaskRec[], outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const mode of ['chord', 'kink'] as const) {
    for (const t of targets) {
      const rs = recs.filter((r) => r.key === t.key);
      if (!rs.length) continue;
      const parts: string[] = [];
      const angs: number[] = [];
      const lens: number[] = [];
      let kinks = 0;
      for (const r of rs) {
        const e: [Px, Px] = mode === 'kink' && r.fit ? [r.fit.p0, r.fit.p1] : [r.chord[0], r.chord[1]];
        if (mode === 'kink' && r.fit?.mode === 'kink') kinks += 1;
        if (r.truthQ) parts.push(`<polygon points="${polyStr(r.truthQ)}" fill="none" stroke="#00e676" stroke-width="3"/>`);
        parts.push(`<polyline points="${r.cols.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ')}" fill="none" stroke="#18ffff" stroke-width="2.4"/>`);
        // ★ 그리기 순서 주의 — 산출 quad 의 근변이 곧 앞변이다. quad 를 **먼저** 그려야 자홍 앞변이 덮이지 않는다.
        const fp = footprintFromContact(e[0], e[1], t.model);
        if (fp) {
          const iou = r.truthQ ? quadIoU(fp, r.truthQ) : 0;
          parts.push(`<polygon points="${polyStr(fp)}" fill="none" stroke="${iou >= MATCH_MIN_IOU ? '#00e5ff' : '#ff1744'}" stroke-width="2.8"/>`);
        }
        parts.push(lineStr(r.chord, '#9e9e9e', 2.4, '8 5')); // 폐기된 현 — 두 장 모두에.
        if (mode === 'kink' && r.fit?.other) parts.push(lineStr(r.fit.other, '#ffb300', 2, '6 4'));
        parts.push(lineStr(e, '#e040fb', 3.4));
        const a = mode === 'kink' ? r.angKink : r.angChord;
        if (Number.isFinite(a)) angs.push(a);
        const L = mode === 'kink' ? r.frontLenM : r.chordLenM;
        if (L != null) lens.push(L);
      }
      const kd = sortNum(rs.map((r) => r.fit?.kinkDeg).filter((v): v is number => v != null));
      parts.push(`<rect x="14" y="14" width="1600" height="104" fill="#000000cc" rx="8"/>`);
      const txt = (x: number, y: number, sTxt: string, fill: string, size: number) =>
        `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${sTxt}</text>`;
      parts.push(txt(30, 48, `26회차 접지 방위 · ${t.key} · 프레임해시 ${t.frameHash} · 모드 ${mode}`, '#fff', 22));
      parts.push(
        txt(30, 78, `마스크 ${rs.length} · 꺾임채택 ${mode === 'kink' ? kinks : 0} · 꺾임각med ${kd.length ? f1(med(kd)) : '-'}° · 앞변지면길이med ${lens.length ? f1(med(sortNum(lens))) : '-'}m · 방위오차med ${angs.length ? f1(med(sortNum(angs))) : '-'}°`, '#ddd', 18),
      );
      parts.push(
        `<text x="30" y="106" font-size="15" font-weight="bold"><tspan fill="#00e676">━ 정답quad(채점전용)</tspan>  <tspan fill="#18ffff">━ 접지선 bottomContour</tspan>  <tspan fill="#9e9e9e">╌ 폐기된 현(chord)</tspan>  <tspan fill="#e040fb">━ 추정 앞변</tspan>  <tspan fill="#ffb300">╌ 미채택 선분</tspan>  <tspan fill="#00e5ff">━ 산출quad(매칭)</tspan> <tspan fill="#ff1744">━ 산출quad(비매칭)</tspan></text>`,
      );
      const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
      const out = join(outDir, `r26_edge_${mode}_${t.key.replace(':', '_')}_${t.frameHash}.png`);
      writeFileSync(out, await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
      console.log(`   스샷 ${mode} ${t.key} → ${out}`);
    }
  }
}


/**
 * ★ Q11 — LPD 판 경로와의 **비-오라클 교차 대조**(설계 §6). **융합 아님 · 판정선 아님.**
 * 짝짓기는 「판 quad 중심이 seg rect 안」 — 정답을 쓰지 않는다.
 * 이 표가 답하는 것은 하나다: 두 독립 관측이 **어디서 갈라지는가**(= 시점각의 함수인가).
 */
function lpdCrossCheck(targets: readonly Target[], cacheDir: string, recs: readonly MaskRec[]): void {
  console.log(`
★ Q11 LPD 교차 대조(비-오라클 · 판정선 아님 · 융합 안 함)`);
  const angs: number[] = [];
  for (const t of targets) {
    const sc = readSegCache(cacheDir, t.frameHash);
    const lc = readLpdCache(cacheDir, t.frameHash);
    if (!sc || !lc) continue;
    for (const b of sc.boxes) {
      const r = recs.find((x) => x.key === t.key && x.vpdIdx === b.vpdIdx);
      if (!r || !Number.isFinite(r.angKink)) continue;
      const inRect = lc.plates.filter((pl) => {
        const cx = (pl.quad[0].x + pl.quad[1].x + pl.quad[2].x + pl.quad[3].x) / 4;
        const cy = (pl.quad[0].y + pl.quad[1].y + pl.quad[2].y + pl.quad[3].y) / 4;
        return cx >= b.rect.x && cx <= b.rect.x + b.rect.w && cy >= b.rect.y && cy <= b.rect.y + b.rect.h;
      });
      if (inRect.length !== 1) continue;
      const ax = plateAxes(inRect[0].quad as NormalizedQuad);
      if (!ax) continue;
      const trap = buildTrapezoid(ax, REGION_DEFAULTS.widthScaleMin, REGION_DEFAULTS);
      const fpL = trap.map((q) => ({ x: q.x * t.W, y: q.y * t.H })) as PixelQuad;
      const GL = footprintToGround(fpL, t.model);
      const aL = GL ? groundAxisOf(GL) : null;
      const fe: [Px, Px] | null = r.fit ? [r.fit.p0, r.fit.p1] : null;
      const hS = fe ? headOf(fe, t.model) : null;
      const a = aL && hS ? angDeg(aL.head, hS) : NaN;
      if (!Number.isFinite(a)) continue;
      angs.push(a);
      console.log(`   ${r.key} seg#${r.vpdIdx} ↔ 판  seg(kink)↔lpd 각=${a} 도 · 모드=${r.fit?.mode} · seg방위오차=${r.angKink} 도`);
    }
  }
  console.log(`   ★ seg(kink) ↔ lpd 각 분포: ${angs.length ? dist(angs) : 'n=0(짝지어진 쌍 없음)'}`);
}

/**
 * ★ 단계4 — 수리 전/후 + 음성 대조군을 **한 실행에서** 낸다(frameHash 물리적 동일).
 * chord = 24회차 현행 · kink = `frontEdgeOf`(R3) · band = ⓒ 근측밴드(「살아났다」 방어용 음성 대조군).
 */
async function runEdgeCompare(targets: readonly Target[], cacheDir: string, outDir: string): Promise<void> {
  const views = viewsOf(targets);
  const cars = await carList();
  const deg = simDegradedSource(cars, { seed: 1 });
  const recs = collectRecords(targets, cacheDir, views, deg);

  console.log(`
★ 26회차 단계4 — 앞변 방식별 방위 오차(마스크 ${recs.length}개 · 같은 실행 = frameHash 물리적 동일)
`);
  console.log(`  대상 seg#  모드   꺾임각  개선배수  앞변지면m  방위오차 chord→kink  dy chord→kink`);
  for (const r of recs) {
    console.log(
      `  ${r.key} #${r.vpdIdx}  ${r.fit?.mode}  ${r.fit?.kinkDeg}  ${r.fit?.rmsGain}  ${r.frontLenM}  ${r.angChord} → ${r.angKink}  ${r.dyChord} → ${r.dyKink}`,
    );
  }

  const kinkN = recs.filter((r) => r.fit?.mode === 'kink').length;
  const chordN = recs.filter((r) => r.fit?.mode === 'chord').length;
  console.log(`
★ 모드 분포: kink ${kinkN}/${recs.length} · chord 폴백 ${chordN}/${recs.length}`);
  console.log(`   폴백 마스크: ${recs.filter((r) => r.fit?.mode === 'chord').map((r) => `${r.key}#${r.vpdIdx}(꺾임각=${r.fit?.kinkDeg} 개선배수=${r.fit?.rmsGain})`).join(' · ')}`);

  console.log(`
★ Q1 길이축 방위 오차(도) — 판정선 중앙값 ≤ 10`);
  console.log(`   [수리 전] chord : ${dist(recs.map((r) => r.angChord))}`);
  console.log(`   [수리 후] kink  : ${dist(recs.map((r) => r.angKink))}`);
  console.log(`   [대조군ⓒ] band  : ${dist(recs.map((r) => r.angBand))}`);
  console.log(`   [계측전용] best-of-two : ${dist(recs.map((r) => Math.min(r.angA, r.angB)))}`);
  const kinkMed = med(sortNum(recs.map((r) => r.angKink)));
  const boMed = med(sortNum(recs.map((r) => Math.min(r.angA, r.angB))));
  console.log(`
   ★ Q1 판정: kink 중앙값 ${kinkMed} ${kinkMed <= 10 ? '≤ 10 → PASS' : '> 10 → FAIL'}`);
  if (kinkMed > 10) console.log(`   ★ §9 분기: best-of-two 중앙값 ${boMed} ${boMed <= 10 ? '≤ 10 → S2(정보는 있는데 선택을 틀렸다)' : '> 10 → S3(두 선분 중 어느 것도 앞변이 아니다)'}`);

  console.log(`
★ 접지선 |y 편의|(px) — 26-1b 발동 조건(|dy| 중앙값 > 60px)`);
  console.log(`   chord: ${dist(recs.map((r) => Math.abs(r.dyChord)))}`);
  console.log(`   kink : ${dist(recs.map((r) => Math.abs(r.dyKink)))}`);

  const fl = recs.map((r) => r.frontLenM).filter((v): v is number => v != null);
  const cl = recs.map((r) => r.chordLenM).filter((v): v is number => v != null);
  console.log(`
★ 앞변 지면 길이(m) — prior CAR_BODY.widthM=${CAR_BODY.widthM} 근방으로 이동했는가(§1-4 진단 지표 · 판정선 아님)`);
  console.log(`   chord: ${dist(cl)} · 4.7m 초과 ${cl.filter((v) => v > CAR_BODY.lengthM).length}/${cl.length} (= 90° 축 뒤집힘 후보)`);
  console.log(`   kink : ${dist(fl)} · 4.7m 초과 ${fl.filter((v) => v > CAR_BODY.lengthM).length}/${fl.length}`);
  console.log(`   ★ 90° 뒤집힘 후보 8/36 → ${fl.filter((v) => v > CAR_BODY.lengthM).length}/${fl.length}`);

  // 꺾임 없는 3건(설계 §1-3)에서 폴백이 어떻게 동작했는가.
  console.log(`
★ 설계 §1-3 「꺾임 없는 마스크 3건」의 폴백 거동`);
  for (const kk of ['1:1#7', '1:2#0', '2:1#6']) {
    const r = recs.find((x) => `${x.key}#${x.vpdIdx}` === kk);
    console.log(`   ${kk}: 모드=${r?.fit?.mode} 픽셀꺾임각=${r?.fit?.kinkDeg} 개선배수=${r?.fit?.rmsGain} 지면꺾임각=${r?.spG?.kinkDeg} 방위오차 chord=${r?.angChord} kink=${r?.angKink}`);
  }

  lpdCrossCheck(targets, cacheDir, recs);
  if (outDir) await drawEdgeOverlays(targets, cacheDir, recs, outDir);
}

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const cacheDir = argOf('--cache', 'reports/detcache_r24');
  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  if (process.argv.includes('--probe')) {
    await runProbe(targets, cacheDir);
    return;
  }
  const edgeArg = argOf('--edge', '');
  if (edgeArg) {
    await runEdgeCompare(targets, cacheDir, argOf('--out', ''));
    return;
  }
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
