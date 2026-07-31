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
import { clampSpan, frontEdgeOf, groundBasis, groundLen, segEndpoints, splitContour, toGround2D, type EdgeFit, type KinkSplit, type Px, type TlsLine } from './contactOrient.js';
import { dropRandomCols, seedOf, splitContour3 } from './contourRefine.js';
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
  /** ★ 27-A F4 — 꺾임점 고정 앞변(`pinKink`). */
  fit2: EdgeFit | null;
  angKink2: number;
  frontLenM2: number | null;
  dyKink2: number;
  /** ★ 27-A Q9 음성 대조군 N1 — 가림배제와 **같은 수**의 열을 시드 고정 무작위 제거한 뒤 같은 파이프라인. */
  angN1: number;
  n1Dropped: number;
  /** 접지선 y 편의(px) — 강등본 근변 대비. */
  dyChord: number;
  dyKink: number;
  /** 채점·스샷 전용 정답 quad(강등본). 검출 경로에 흐르지 않는다. */
  truthQ: PixelQuad | null;
  // ── ★ 27-A 단계 A 부검 원장 신규 4필드(설계 §1-1) ──
  /** `rejectOccluded` 가 이미 계산하고 버리던 값 — 가림 아닌 열 비율. */
  cleanRatio: number;
  /** 콘투어 중점의 지면 깊이(m) = |역투영점 − 카메라 직하점|. */
  depthM: number | null;
  /** 지면 해상도(m/px) = chord 지면길이 / chord 픽셀 x 스팬. */
  mpp: number | null;
  /** 마스크 폴리곤 면적(px², shoelace). */
  areaPx: number;
  // ── ★ 27-A 단계 B 판별 측정(C1~C6)에 필요한 보관 필드. 계측 전용. */
  model: GroundModel;
  /** 정답 장축(계측 전용 오라클). 검출 경로에 흐르지 않는다. */
  truthHead: Vec3 | null;
  /** 가림 배제 후 살아남은 콘투어 열(C1·F1 근거). */
  occCols: Px[];
  /** 마스크 픽셀 폴리곤(C4). */
  maskPx: Px[];
}

/** 폴리곤 면적(shoelace · 부호 무시). */
const shoelace = (poly: readonly Px[]): number => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
};

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
  // ★ 27-A F4(kink2) — 같은 콘투어·같은 게이트·같은 R3, 꺾임점 고정만 다르다.
  const fit2 = frontEdgeOf(cols, t.model, chord, { pinKink: true });
  const fe2: [Px, Px] | null = fit2 ? [fit2.p0, fit2.p1] : null;
  // ★ Q9 음성 대조군 N1 — 가림배제가 지웠을 열 수와 **같은 수**를 무작위로 지운다(시드 = key 해시).
  const n1Dropped = cols.length - occ.valid.length;
  const colsN1 = dropRandomCols(cols, n1Dropped, seedOf(`${t.key}#${vpdIdx}`));
  const fitN1 = frontEdgeOf(colsN1, t.model, nearEdgeOf(colsN1));
  const cA = eA ? clampSpan(eA, t.model, CAR_BODY.lengthM, CAR_BODY.widthM) : null;
  const cB = eB ? clampSpan(eB, t.model, CAR_BODY.lengthM, CAR_BODY.widthM) : null;
  const angAc = cA ? angDeg(headOf(cA, t.model), truthHead) : NaN;
  const angBc = cB ? angDeg(headOf(cB, t.model), truthHead) : NaN;
  const bestIdxC = Number.isFinite(angAc) && Number.isFinite(angBc) ? (angAc <= angBc ? 0 : 1) : null;

  // ★ 27-A 단계 A — 부검 원장 4필드(신규 계산은 여기 뿐, 검출 경로 무영향).
  const colMid = cols[Math.floor(cols.length / 2)];
  const Xm = colMid ? backprojectToGround(colMid, t.model) : null;
  const nadir3: Vec3 = [t.model.n[0] * t.model.d, t.model.n[1] * t.model.d, t.model.n[2] * t.model.d];
  const depthM = Xm ? Math.hypot(Xm[0] - nadir3[0], Xm[1] - nadir3[1], Xm[2] - nadir3[2]) : null;
  const chordSpanPx = chord[1].x - chord[0].x;
  const chordLenM0 = groundLen(chord[0], chord[1], t.model);
  const mpp = chordLenM0 != null && Math.abs(chordSpanPx) > 1e-9 ? chordLenM0 / chordSpanPx : null;

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
    fit2,
    angKink2: fe2 ? angDeg(headOf(fe2, t.model), truthHead) : NaN,
    frontLenM2: fe2 ? groundLen(fe2[0], fe2[1], t.model) : null,
    dyKink2: fe2 ? dyOf(fe2) : NaN,
    angN1: fitN1 ? angDeg(headOf([fitN1.p0, fitN1.p1], t.model), truthHead) : NaN,
    n1Dropped,
    dyChord: dyOf(chord),
    dyKink: fe ? dyOf(fe) : NaN,
    truthQ,
    cleanRatio: occ.cleanRatio,
    depthM,
    mpp,
    areaPx: shoelace(maskPx),
    model: t.model,
    truthHead,
    occCols: occ.valid,
    maskPx,
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


// ═════════════════════════════════════════════════════════════════════════════
// ★ 27-A 단계 A — **악화 14건 부검 원장**(설계 §1). 수리 코드 0줄 · 검출 경로 무변경.
//   TSV 는 stdout(리다이렉트 대상) · W1~W4 집계는 stderr(화면).
// ═════════════════════════════════════════════════════════════════════════════

/** 프리셋 tilt(도) — 설계 §41 §1-2 상수. 계측 라벨 전용. */
const TILT_OF: Record<string, number> = { '1:1': 8.7, '1:2': 20.1, '1:3': 35.8, '2:1': 10.0, '2:2': 17.0 };

/** 원장 1행 — 전부 원시 배정도(toFixed 금지). */
interface LedgerRow {
  key: string;
  vpdIdx: number;
  angChord: number;
  angKink: number;
  dAng: number;
  label: '개선' | '악화' | '폴백';
  cols: number;
  kinkDeg: number | null;
  gain: number | null;
  splitIdx: number | null;
  kFrac: number | null;
  lenA: number | null;
  lenB: number | null;
  chordLenM: number | null;
  frontLenM: number | null;
  r3: number | null;
  bestIdx: number | null;
  ruleOk: boolean | null;
  dyChord: number;
  dyKink: number;
  cleanRatio: number;
  depthM: number | null;
  mpp: number | null;
  areaPx: number;
  tilt: number;
}

function ledgerOf(recs: readonly MaskRec[]): LedgerRow[] {
  return recs.map((r) => {
    const dAng = r.angKink - r.angChord;
    const label: LedgerRow['label'] = r.fit?.mode === 'chord' ? '폴백' : dAng < 0 ? '개선' : '악화';
    return {
      key: r.key,
      vpdIdx: r.vpdIdx,
      angChord: r.angChord,
      angKink: r.angKink,
      dAng,
      label,
      cols: r.cols.length,
      kinkDeg: r.sp?.kinkDeg ?? null,
      gain: r.sp?.gain ?? null,
      splitIdx: r.sp?.k ?? null,
      kFrac: r.sp ? r.sp.k / r.cols.length : null,
      lenA: r.lenA,
      lenB: r.lenB,
      chordLenM: r.chordLenM,
      frontLenM: r.frontLenM,
      r3: r.r3,
      bestIdx: r.bestIdx,
      ruleOk: r.r3 != null && r.bestIdx != null ? r.r3 === r.bestIdx : null,
      dyChord: r.dyChord,
      dyKink: r.dyKink,
      cleanRatio: r.cleanRatio,
      depthM: r.depthM,
      mpp: r.mpp,
      areaPx: r.areaPx,
      tilt: TILT_OF[r.key] ?? NaN,
    };
  });
}

const LEDGER_COLS: Array<keyof LedgerRow> = [
  'key', 'vpdIdx', 'angChord', 'angKink', 'dAng', 'label', 'cols', 'kinkDeg', 'gain', 'splitIdx', 'kFrac',
  'lenA', 'lenB', 'chordLenM', 'frontLenM', 'r3', 'bestIdx', 'ruleOk', 'dyChord', 'dyKink',
  'cleanRatio', 'depthM', 'mpp', 'areaPx', 'tilt',
];

async function runAutopsy(targets: readonly Target[], cacheDir: string): Promise<void> {
  const views = viewsOf(targets);
  const cars = await carList();
  const deg = simDegradedSource(cars, { seed: 1 });
  const recs = collectRecords(targets, cacheDir, views, deg);
  const rows = ledgerOf(recs);

  console.log(LEDGER_COLS.join('\t'));
  for (const w of rows) console.log(LEDGER_COLS.map((c) => String(w[c])).join('\t'));

  const E = (s: string): void => console.error(s);
  const better = rows.filter((w) => w.label === '개선');
  const worse = rows.filter((w) => w.label === '악화');
  const fb = rows.filter((w) => w.label === '폴백');
  E(`\n★ 단계 A 원장 — 총 ${rows.length}행 · 개선 ${better.length} · 악화 ${worse.length} · 폴백 ${fb.length}`);
  E(`   (설계 §9 검증: 개선 16 · 악화 14 · 폴백 6 과 ${better.length === 16 && worse.length === 14 && fb.length === 6 ? '일치' : '불일치 — 분류 정의 대조 필요'})`);

  // ── W1 — 속성별 중앙값 대조표. 판독 규약: 중앙값 비 ≥2배 또는 상대군 [min,max] 밖일 때만 「분리」.
  E(`\n★ W1 악화(${worse.length}) vs 개선(${better.length}) 속성별 대조 — 판정: 중앙값비≥2 또는 상대군 [min,max] 밖`);
  E(`   속성  악화median  개선median  비(악화/개선)  악화med가 개선[min,max] 밖?  판정`);
  const attrs: Array<[string, (w: LedgerRow) => number | null]> = [
    ['angChord', (w) => w.angChord], ['cols', (w) => w.cols], ['kinkDeg', (w) => w.kinkDeg], ['gain', (w) => w.gain],
    ['kFrac', (w) => w.kFrac], ['cleanRatio', (w) => w.cleanRatio], ['depthM', (w) => w.depthM],
    ['mpp', (w) => w.mpp], ['areaPx', (w) => w.areaPx], ['tilt', (w) => w.tilt],
  ];
  for (const [nm, f] of attrs) {
    const sw = sortNum(worse.map(f).filter((v): v is number => v != null));
    const sb = sortNum(better.map(f).filter((v): v is number => v != null));
    if (!sw.length || !sb.length) { E(`   ${nm}: n 부족 — 미측정`); continue; }
    const mw = med(sw);
    const mb = med(sb);
    const ratio = mb !== 0 ? mw / mb : NaN;
    const outside = mw < sb[0] || mw > sb[sb.length - 1];
    const sep = (Number.isFinite(ratio) && (Math.abs(ratio) >= 2 || Math.abs(ratio) <= 0.5)) || outside;
    E(`   ${nm}\t${mw}\t${mb}\t${ratio}\t${outside}\t${sep ? '분리된다' : '분리 안 됨'}`);
  }

  // ── W2 — 악화군 angChord 분포. 중앙값 <10 이면 「우연히 맞던 chord 를 버린 것」.
  const wAngChord = sortNum(worse.map((w) => w.angChord));
  const w2med = med(wAngChord);
  E(`\n★ W2 악화 ${worse.length}건의 angChord 분포: ${dist(wAngChord)}`);
  E(`   ★ W2 판정: 중앙값 ${w2med} ${w2med < 10 ? '< 10 → 「우연히 맞던 chord 를 버린 것」 → F0 발동 조건 충족' : '≥ 10 → chord 도 이미 나빴다 → F0 발동 조건 미충족'}`);

  // ── W3 ★ 악화 2분: (i) 선택 오류(ruleOk=false) vs (ii) 두 선분 다 chord 보다 나쁨.
  const wi = worse.filter((w) => w.ruleOk === false);
  const wii = worse.filter((w) => w.ruleOk === true);
  const wiiBothWorse = wii.filter((w) => (w.lenA != null || true) && w.angKink > w.angChord);
  E(`\n★ W3 악화 ${worse.length}건 2분 — (i) 선택오류 ruleOk=false : ${wi.length} · (ii) ruleOk=true 인데 악화 : ${wii.length}`);
  E(`   (i):(ii) = ${wi.length}:${wii.length}`);
  E(`   (ii) 중 angKink > angChord 인 건수 = ${wiiBothWorse.length}`);
  // (ii) 세부 — 두 선분 다 chord 보다 나쁜가(bestIdx 쪽 오차 vs angChord).
  const recByKey = new Map(recs.map((r) => [`${r.key}#${r.vpdIdx}`, r]));
  let bothWorseThanChord = 0;
  for (const w of worse) {
    const r = recByKey.get(`${w.key}#${w.vpdIdx}`);
    if (!r) continue;
    if (Math.min(r.angA, r.angB) > r.angChord) bothWorseThanChord += 1;
  }
  E(`   ★ 악화군 중 **두 선분 다 chord 보다 나쁨**(min(angA,angB) > angChord) = ${bothWorseThanChord}/${worse.length}`);
  E(`   ★ W3 1차 결정자: ${wi.length > wii.length ? '(i) 선택 오류 우세 → F0 방향' : '(ii) 분해 자체 우세 → F1~F4 방향'}`);
  E(`   악화 상세(dAng 내림차순):`);
  for (const w of [...worse].sort((a, b) => b.dAng - a.dAng)) {
    E(`     ${w.key}#${w.vpdIdx}  angChord=${w.angChord} → angKink=${w.angKink}  dAng=${w.dAng}  ruleOk=${w.ruleOk}  r3=${w.r3} bestIdx=${w.bestIdx}  kFrac=${w.kFrac}  cleanRatio=${w.cleanRatio}  depthM=${w.depthM}`);
  }

  // ── W4 — 폴백 6건 제외 후 30건 재집계.
  const noFb = rows.filter((w) => w.label !== '폴백');
  E(`\n★ W4 폴백 제외 ${noFb.length}건 재집계 — 방위 중앙값 kink=${med(sortNum(noFb.map((w) => w.angKink)))} chord=${med(sortNum(noFb.map((w) => w.angChord)))} · 개선 ${noFb.filter((w) => w.label === '개선').length} : 악화 ${noFb.filter((w) => w.label === '악화').length}`);
  E(`   (판정선 아님 — 판정은 36건 전수)`);
}

// ═════════════════════════════════════════════════════════════════════════════
// ★ 27-A 단계 B — **원인 후보 ⓐ~ⓔ 판별 측정 C1~C6**(설계 §2). 수리 코드 0줄.
//   채택/기각 조건은 설계 §2 표에 **사전 고정**되어 있다. 사후에 바꾸지 않는다.
// ═════════════════════════════════════════════════════════════════════════════

/** 선분 잔차의 **부호 런 수**(C5) — 직선+노이즈면 많고, 곡선이면 1~2. */
function signRuns(seg: readonly Px[], fit: TlsLine): number {
  let runs = 0;
  let prev = 0;
  for (const p of seg) {
    // 직교 잔차 부호 = 법선 성분.
    const r = -(p.x - fit.cx) * fit.dir[1] + (p.y - fit.cy) * fit.dir[0];
    const s = r > 0 ? 1 : r < 0 ? -1 : 0;
    if (s !== 0 && s !== prev) {
      runs += 1;
      prev = s;
    }
  }
  return runs;
}

function runDiag(recs: readonly MaskRec[], cacheDir: string, targets: readonly Target[]): void {
  const rows = ledgerOf(recs);
  const labelOf = new Map(rows.map((w) => [`${w.key}#${w.vpdIdx}`, w.label]));
  const isWorse = (r: MaskRec): boolean => labelOf.get(`${r.key}#${r.vpdIdx}`) === '악화';
  const kinkAll = sortNum(recs.map((r) => r.angKink));
  console.log(`\n═══ 27-A 단계 B — 판별 측정 C1~C6 (마스크 ${recs.length}개) ═══`);
  console.log(`   기준선(26회차 종점) kink 방위 중앙값 = ${med(kinkAll)}`);

  // ── C3 ★ (ⓑ) 3선분 최적분할 + best-of-three. **순서와 무관하게 반드시 낸다**(T4 근거값).
  const gain3s: number[] = [];
  const bo3: number[] = [];
  const bo2: number[] = [];
  for (const r of recs) {
    const s3 = splitContour3(r.cols, 4);
    bo2.push(Math.min(r.angA, r.angB));
    if (!s3 || !r.sp) continue;
    gain3s.push(r.sp.rms2 > 1e-12 ? r.sp.rms2 / s3.rms3 : Infinity);
    const es: Array<[Px, Px]> = [segEndpoints(s3.segA, s3.a), segEndpoints(s3.segB, s3.b), segEndpoints(s3.segC, s3.c)];
    const angs = es.map((e) => angDeg(headOf(e, r.model), r.truthHead)).filter(Number.isFinite);
    if (angs.length === 3) bo3.push(Math.min(...angs));
  }
  console.log(`\n★ C3 (ⓑ 3선분) gain3 = rms2/rms3 : ${dist(gain3s)}`);
  console.log(`   best-of-two   방위 오차(계측 전용 오라클 상한): ${dist(bo2)}`);
  console.log(`   best-of-three 방위 오차(계측 전용 오라클 상한): ${dist(bo3)}`);
  const b3med = med(sortNum(bo3));
  console.log(`   ★ C3 판정(사전 고정: best-of-three 중앙값 < 10 이면 ⓑ 채택): ${b3med} ${b3med < 10 ? '< 10 → ⓑ 채택' : '≥ 10 → ⓑ 기각 · 그리고 이것이 §4 B 상신 근거'}`);

  // ── C1 (ⓐ) 가림배제 콘투어로 frontEdgeOf 재실행. 26회차는 꺾임각만 쟀다 — 앞변 산출은 미측정 구간.
  const c1angs: number[] = [];
  const c1gainLowClean: number[] = [];
  const c1gainHighClean: number[] = [];
  const cleanMed = med(sortNum(recs.map((r) => r.cleanRatio)));
  for (const r of recs) {
    const cc = r.occCols.length >= 8 ? r.occCols : r.cols;
    const ch = nearEdgeOf(cc);
    const f = frontEdgeOf(cc, r.model, ch);
    const a = f ? angDeg(headOf([f.p0, f.p1], r.model), r.truthHead) : NaN;
    c1angs.push(a);
    if (Number.isFinite(a)) (r.cleanRatio <= cleanMed ? c1gainLowClean : c1gainHighClean).push(r.angKink - a);
  }
  const c1med = med(sortNum(c1angs));
  console.log(`\n★ C1 (ⓐ 오염) 가림배제(belowPx=6) 콘투어 → frontEdgeOf 재실행 방위 오차: ${dist(c1angs)}`);
  console.log(`   기준 ${med(kinkAll)} 대비 중앙값 ${c1med} · 차 ${c1med - med(kinkAll)}`);
  console.log(`   이득(kink−C1) — cleanRatio 낮은군(≤${cleanMed}) median=${med(sortNum(c1gainLowClean))} n=${c1gainLowClean.length} · 높은군 median=${med(sortNum(c1gainHighClean))} n=${c1gainHighClean.length}`);
  console.log(`   ★ C1 판정(사전 고정: 중앙값 유의 하락 AND 이득이 낮은 cleanRatio 군에 집중): ${c1med < med(kinkAll) ? '중앙값 하락' : '중앙값 하락 없음 → ⓐ(타차 가림) 기각'}`);

  // ── C2 (ⓐ 그림자) dyKink **부호 있는** 중앙값. + = 화면 아래 = 그림자 누출 방향.
  const dySigned = sortNum(recs.map((r) => r.dyKink));
  console.log(`\n★ C2 (ⓐ 그림자) dyKink 부호 있는 분포(+ = 접지보다 아래 = 그림자 누출 방향): ${dist(dySigned)}`);
  console.log(`   양수 ${dySigned.filter((v) => v > 0).length}/${dySigned.length} · 음수 ${dySigned.filter((v) => v < 0).length}/${dySigned.length}`);

  // ── C6 (ⓔ 스팬 과연장) 채택 앞변 2점 ↔ 꺾임점 cols[splitIdx] 최소 픽셀 거리.
  const c6all: number[] = [];
  const c6worse: number[] = [];
  const c6better: number[] = [];
  for (const r of recs) {
    if (!r.fit || r.fit.mode !== 'kink' || r.fit.splitIdx == null) continue;
    const kp = r.cols[r.fit.splitIdx];
    if (!kp) continue;
    const d = Math.min(Math.hypot(r.fit.p0.x - kp.x, r.fit.p0.y - kp.y), Math.hypot(r.fit.p1.x - kp.x, r.fit.p1.y - kp.y));
    c6all.push(d);
    (isWorse(r) ? c6worse : c6better).push(d);
  }
  const c6med = med(sortNum(c6all));
  console.log(`\n★ C6 (ⓔ 스팬 과연장) 앞변 끝점 ↔ 꺾임점 최소거리(px): ${dist(c6all)}`);
  console.log(`   악화군 median=${med(sortNum(c6worse))} n=${c6worse.length} · 개선/폴백군 median=${med(sortNum(c6better))} n=${c6better.length}`);
  console.log(`   ★ C6 판정(사전 고정: 중앙값이 0 근방이면 ⓔ 기각 · 0 아님 AND 악화군에서 더 큼 이면 채택): ${c6med} ${c6med < 1 ? '→ 0 근방 → ⓔ 기각' : med(sortNum(c6worse)) > med(sortNum(c6better)) ? '→ 0 아님 + 악화군에서 더 큼 → ⓔ 채택' : '→ 0 아님이나 악화군에서 더 크지 않음 → ⓔ 기각'}`);

  // ── C4/C4b/C4c (ⓒ 마스크 병합) 지면 스팬 · 병합 vs 원경확대 분리 · seg rect 겹침.
  const spanM: number[] = [];
  const normW: number[] = [];
  const pxW: number[] = [];
  const over47: MaskRec[] = [];
  for (const r of recs) {
    const L = r.chordLenM;
    if (L == null) continue;
    spanM.push(L);
    pxW.push(Math.abs(r.chord[1].x - r.chord[0].x));
    if (r.mpp != null && Math.abs(r.mpp) > 1e-12) normW.push(L / CAR_BODY.lengthM / r.mpp);
    if (L > CAR_BODY.lengthM) over47.push(r);
  }
  console.log(`\n★ C4 (ⓒ 병합) chord 지면 스팬(m): ${dist(spanM)} · 4.7m 초과 ${over47.length}/${recs.length}`);
  console.log(`   C4b 정규화 폭 = (chordLenM/4.7)/mpp : ${dist(normW)}`);
  console.log(`   chord 픽셀 폭: ${dist(pxW)} · mpp(m/px): ${dist(recs.map((r) => r.mpp).filter((v): v is number => v != null))}`);
  console.log(`   4.7m 초과 ${over47.length}건 내역: ${over47.map((r) => `${r.key}#${r.vpdIdx}(L=${r.chordLenM} pxW=${Math.abs(r.chord[1].x - r.chord[0].x)} mpp=${r.mpp} tilt=${TILT_OF[r.key]} label=${labelOf.get(`${r.key}#${r.vpdIdx}`)})`).join(' · ')}`);
  let iouPairs = 0;
  for (const t of targets) {
    const c = readSegCache(cacheDir, t.frameHash);
    if (!c) continue;
    const qs = c.boxes.map((b) => [
      { x: b.rect.x, y: b.rect.y }, { x: b.rect.x + b.rect.w, y: b.rect.y },
      { x: b.rect.x + b.rect.w, y: b.rect.y + b.rect.h }, { x: b.rect.x, y: b.rect.y + b.rect.h },
    ] as PixelQuad);
    for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) if (quadIoU(qs[i], qs[j]) > 0) iouPairs += 1;
  }
  console.log(`   C4c seg rect 겹침 쌍(IoU>0 · 정답 미사용): ${iouPairs}`);
  const over47Worse = over47.filter((r) => isWorse(r)).length;
  console.log(`   ★ C4 판정(사전 고정: 정규화 폭이 1 을 크게 넘는 마스크가 악화군에 집중 AND C4c 겹침 존재): 4.7m 초과 중 악화 ${over47Worse}/${over47.length} · 겹침쌍 ${iouPairs}`);

  // ── C5/C5b (ⓓ 곡률) 잔차 부호 런 수 · 분할점 안정성(STEP 4 → 8).
  const runsA: number[] = [];
  const runsB: number[] = [];
  for (const r of recs) {
    if (!r.sp) continue;
    runsA.push(signRuns(r.sp.segA, r.sp.a));
    runsB.push(signRuns(r.sp.segB, r.sp.b));
  }
  console.log(`\n★ C5 (ⓓ 곡률) 선분 잔차 부호 런 수 — segA: ${dist(runsA)} · segB: ${dist(runsB)}`);
  const dK: number[] = [];
  const dKworse: number[] = [];
  for (const r of recs) {
    if (!r.sp) continue;
    const cols8 = bottomContour(r.maskPx, 8);
    const sp8 = splitContour(cols8, 4);
    if (!sp8) continue;
    const d = Math.abs(sp8.k / cols8.length - r.sp.k / r.cols.length);
    dK.push(d);
    if (isWorse(r)) dKworse.push(d);
  }
  console.log(`   C5b 분할점 안정성 |kFrac(step8) − kFrac(step4)|: ${dist(dK)} · 악화군만: ${dist(dKworse)}`);
  const runsMed = med(sortNum([...runsA, ...runsB]));
  console.log(`   ★ C5 판정(사전 고정: 런 수 중앙값 ≤3 이고 kFrac 이동 큰 군이 악화군과 겹치면 ⓓ 채택): 런 median=${runsMed} ${runsMed <= 3 ? '≤3' : '>3 → 런 많음(직선+노이즈) → ⓓ 기각 방향'}`);
}

// ── 스샷(설계 §7) — 같은 frameHash 에서 **수리 전/후 2장을 나란히** ────────────
const f1 = (v: number): string => v.toFixed(1);
const polyStr = (q: PixelQuad): string => q.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ');
const lineStr = (e: readonly [Px, Px], stroke: string, w: number, dash = ''): string =>
  `<line x1="${f1(e[0].x)}" y1="${f1(e[0].y)}" x2="${f1(e[1].x)}" y2="${f1(e[1].y)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;



// ═════════════════════════════════════════════════════════════════════════════
// ★ 27-A 단계 E — 스샷(설계 §7). pre = 26회차 kink 재현 · post = F4 정제 후.
//   ★ 확대본은 콘투어를 「선」이 아니라 **「점」**으로 그린다(26회차가 육안 판별 불가로 끝난 이유).
// ═════════════════════════════════════════════════════════════════════════════

const txtEl = (x: number, y: number, s: string, fill: string, size: number): string =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="bold" stroke="#000" stroke-width="0.6" paint-order="stroke">${s}</text>`;

async function drawR27Overlays(targets: readonly Target[], recs: readonly MaskRec[], outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const mode of ['pre', 'post'] as const) {
    for (const t of targets) {
      const rs = recs.filter((r) => r.key === t.key);
      if (!rs.length) continue;
      const parts: string[] = [];
      const angs: number[] = [];
      for (const r of rs) {
        const f = mode === 'pre' ? r.fit : r.fit2;
        const e: [Px, Px] = f ? [f.p0, f.p1] : [r.chord[0], r.chord[1]];
        if (r.truthQ) parts.push(`<polygon points="${polyStr(r.truthQ)}" fill="none" stroke="#00e676" stroke-width="3"/>`);
        parts.push(`<polyline points="${r.cols.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ')}" fill="none" stroke="#18ffff" stroke-width="2.4"/>`);
        const fp = footprintFromContact(e[0], e[1], t.model);
        if (fp) {
          const iou = r.truthQ ? quadIoU(fp, r.truthQ) : 0;
          parts.push(`<polygon points="${polyStr(fp)}" fill="none" stroke="${iou >= MATCH_MIN_IOU ? '#00e5ff' : '#ff1744'}" stroke-width="2.8"/>`);
        }
        parts.push(lineStr(r.chord, '#9e9e9e', 2.4, '8 5'));
        if (f?.other) parts.push(lineStr(f.other, '#ffb300', 2, '6 4'));
        parts.push(lineStr(e, '#e040fb', 3.4)); // 앞변 최상위(26회차 교정 순서 유지).
        const a = mode === 'pre' ? r.angKink : r.angKink2;
        if (Number.isFinite(a)) angs.push(a);
      }
      parts.push(`<rect x="14" y="14" width="1600" height="104" fill="#000000cc" rx="8"/>`);
      parts.push(txtEl(30, 48, `27-A 접지 방위 · ${t.key} · 프레임해시 ${t.frameHash} · ${mode === 'pre' ? 'pre(26회차 kink 재현)' : 'post(F4 꺾임점 고정)'}`, '#fff', 22));
      parts.push(txtEl(30, 78, `마스크 ${rs.length} · 방위오차med ${angs.length ? f1(med(sortNum(angs))) : '-'}° (판정선 ≤10°)`, '#ddd', 18));
      parts.push(
        `<text x="30" y="106" font-size="15" font-weight="bold"><tspan fill="#00e676">━ 정답quad(채점전용)</tspan>  <tspan fill="#18ffff">━ 접지선 bottomContour</tspan>  <tspan fill="#9e9e9e">╌ 폐기된 현(chord)</tspan>  <tspan fill="#e040fb">━ 추정 앞변</tspan>  <tspan fill="#ffb300">╌ 미채택 선분</tspan>  <tspan fill="#00e5ff">━ 산출quad(매칭)</tspan> <tspan fill="#ff1744">━ 산출quad(비매칭)</tspan></text>`,
      );
      const svg = `<svg width="${t.W}" height="${t.H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
      const out = join(outDir, `r27_${mode}_${t.key.replace(':', '_')}_${t.frameHash}.png`);
      writeFileSync(out, await sharp(t.jpg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
      console.log(`   스샷 ${mode} ${t.key} → ${out}`);
    }
  }

  // ── §7-2 악화 대표 3건 확대본 — 선정은 원장 `dAng` 내림차순 **자동**(사람이 고르지 않는다).
  const rows = ledgerOf(recs);
  const top3 = rows.filter((w) => w.label === '악화').sort((a, b) => b.dAng - a.dAng).slice(0, 3);
  for (let rank = 0; rank < top3.length; rank++) {
    const w = top3[rank];
    const r = recs.find((x) => x.key === w.key && x.vpdIdx === w.vpdIdx);
    const t = targets.find((x) => x.key === w.key);
    if (!r || !r.sp) continue;
    const xs = r.maskPx.map((p) => p.x);
    const ys = r.maskPx.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const hw = ((Math.max(...xs) - Math.min(...xs)) / 2) * 1.6;
    const hh = ((Math.max(...ys) - Math.min(...ys)) / 2) * 1.6;
    const L = Math.max(0, Math.round(cx - hw));
    const T = Math.max(0, Math.round(cy - hh));
    const W = Math.min(t!.W - L, Math.round(hw * 2));
    const H = Math.min(t!.H - T, Math.round(hh * 2));
    const scale = Math.max(1, 512 / Math.min(W, H));
    const SW = Math.round(W * scale);
    const SH = Math.round(H * scale);
    const X = (p: Px): string => f1((p.x - L) * scale);
    const Y = (p: Px): string => f1((p.y - T) * scale);
    const p: string[] = [];
    if (r.truthQ) p.push(`<polygon points="${r.truthQ.map((q) => `${X(q)},${Y(q)}`).join(' ')}" fill="none" stroke="#00e676" stroke-width="3"/>`);
    const fe: [Px, Px] = r.fit ? [r.fit.p0, r.fit.p1] : [r.chord[0], r.chord[1]];
    const fp = footprintFromContact(fe[0], fe[1], t!.model);
    if (fp) p.push(`<polygon points="${fp.map((q) => `${X(q)},${Y(q)}`).join(' ')}" fill="none" stroke="#ff1744" stroke-width="2.6"/>`);
    // ★ 콘투어를 점으로 — segA/segB 색 분리.
    const occSet = new Set(r.occCols.map((c) => `${c.x},${c.y}`));
    for (let i = 0; i < r.cols.length; i++) {
      const c = r.cols[i];
      const col = i < r.sp.k ? '#40c4ff' : '#ffab40';
      p.push(`<circle cx="${X(c)}" cy="${Y(c)}" r="2" fill="${col}"/>`);
      if (!occSet.has(`${c.x},${c.y}`)) p.push(txtEl(Number(X(c)) - 4, Number(Y(c)) + 4, '✕', '#616161', 11)); // 가림배제 탈락.
    }
    const kp = r.cols[r.sp.k];
    if (kp) {
      p.push(txtEl(Number(X(kp)) - 10, Number(Y(kp)) + 8, '★', '#ffffff', 26));
      p.push(txtEl(Number(X(kp)) + 12, Number(Y(kp)) - 8, `k=${r.sp.k}, kFrac=${f1(w.kFrac ?? 0)}`, '#ffffff', 14));
    }
    p.push(`<line x1="${X(fe[0])}" y1="${Y(fe[0])}" x2="${X(fe[1])}" y2="${Y(fe[1])}" stroke="#e040fb" stroke-width="3.4"/>`);
    p.push(`<rect x="8" y="8" width="${SW - 16}" height="92" fill="#000000d0" rx="6"/>`);
    p.push(txtEl(20, 34, `악화#${rank + 1} ${w.key} · ${t!.frameHash} · seg#${w.vpdIdx}`, '#fff', 18));
    p.push(txtEl(20, 58, `angChord ${f1(w.angChord)}° → angKink ${f1(w.angKink)}° (dAng +${f1(w.dAng)}°)`, '#ff8a80', 17));
    p.push(txtEl(20, 82, `kinkDeg ${f1(w.kinkDeg ?? 0)}° · gain ${f1(w.gain ?? 0)} · kFrac ${f1(w.kFrac ?? 0)} · cleanRatio ${f1(w.cleanRatio)} · depthM ${f1(w.depthM ?? 0)} · mpp ${w.mpp} · frontLenM ${f1(w.frontLenM ?? 0)}`, '#bbb', 14));
    const svg = `<svg width="${SW}" height="${SH}" xmlns="http://www.w3.org/2000/svg">${p.join('')}</svg>`;
    const buf = await sharp(t!.jpg).extract({ left: L, top: T, width: W, height: H }).resize(SW, SH).toBuffer();
    const out = join(outDir, `r27_worse${rank + 1}_${w.key.replace(':', '_')}_${t!.frameHash}_seg${w.vpdIdx}.png`);
    writeFileSync(out, await sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
    console.log(`   확대본 악화#${rank + 1} ${w.key}#${w.vpdIdx} dAng=${w.dAng} → ${out}`);
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

  // ★ 27-A 단계 D — F4(kink2) 관문 + 음성 대조군 + best-of-N 상한.
  const k2 = recs.map((r) => r.angKink2);
  const k2med = med(sortNum(k2));
  const better2 = recs.filter((r) => r.angKink2 < r.angChord).length;
  const worse2 = recs.filter((r) => r.angKink2 > r.angChord).length;
  console.log(`
═══ ★ 27-A 단계 D — F4 꺾임점 고정(kink2) 관문 ═══`);
  console.log(`   [27-A F4] kink2 : ${dist(k2)}`);
  console.log(`   [Q9 대조군 N1 무작위절사] : ${dist(recs.map((r) => r.angN1))} · 지운 열 수 median=${med(sortNum(recs.map((r) => r.n1Dropped)))}`);
  console.log(`   [Q9 대조군ⓒ 근측밴드]     : ${dist(recs.map((r) => r.angBand))}`);
  console.log(`   ★ Q1 판정(F4): 중앙값 ${k2med} ${k2med <= 10 ? '≤ 10' : '> 10 → FAIL'} · 개선 ${better2} : 악화 ${worse2} ${better2 >= worse2 ? '(악화 ≤ 개선)' : '(악화 > 개선)'}`);
  console.log(`   26회차 kink 대비 이득 = ${kinkMed - k2med} · N1 이득 = ${kinkMed - med(sortNum(recs.map((r) => r.angN1)))} · 근측밴드 이득 = ${kinkMed - med(sortNum(recs.map((r) => r.angBand)))}`);
  console.log(`   ★ Q10 best-of-N 상한(계측 전용 오라클 · 실검출 아님):`);
  console.log(`      best-of-two(원 콘투어)   : ${boMed}`);
  const bo2p = recs.map((r) => {
    const s = splitContour(r.cols, 4);
    if (!s) return NaN;
    const pin = (seg: Px[], L: TlsLine, e: [Px, Px]): [Px, Px] => {
      const kp = r.cols[s.k];
      if (!kp) return e;
      const t2 = (kp.x - L.cx) * L.dir[0] + (kp.y - L.cy) * L.dir[1];
      const pr = { x: L.cx + t2 * L.dir[0], y: L.cy + t2 * L.dir[1] };
      const i = Math.hypot(e[0].x - kp.x, e[0].y - kp.y) <= Math.hypot(e[1].x - kp.x, e[1].y - kp.y) ? 0 : 1;
      const out: [Px, Px] = [e[0], e[1]];
      out[i] = pr;
      return out;
    };
    const a = angDeg(headOf(pin(s.segA, s.a, segEndpoints(s.segA, s.a)), r.model), r.truthHead);
    const b = angDeg(headOf(pin(s.segB, s.b, segEndpoints(s.segB, s.b)), r.model), r.truthHead);
    return Math.min(a, b);
  }).filter(Number.isFinite);
  const bo2pMed = med(sortNum(bo2p));
  console.log(`      best-of-two(F4 정제 후)  : ${bo2pMed}  ← ★ T4 판정 근거값`);
  console.log(`      ★ §4 T-분기: ${k2med <= 10 && better2 >= worse2 ? 'T1 — Q1 1차 통과 → Q2 판정으로' : k2med <= 10 ? 'T2 — 중앙값 통과 · 악화 > 개선' : bo2pMed <= 10 ? 'T3 — 정보는 있는데 선택을 틀렸다 → F0 1회 교체 후 재실행' : 'T4 — 하단 콘투어의 선분 모델에 방위 정보가 없다 → K1 확정 · 선택지 B 상신'}`);

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
  if (outDir) await drawR27Overlays(targets, recs, outDir);
}

async function main(): Promise<void> {
  const targetArg = process.argv[2] ?? 'v1';
  const cacheDir = argOf('--cache', 'reports/detcache_r24');
  const targets = await goldenTargets(GOLDEN_DIRS[targetArg] ?? targetArg);
  if (process.argv.includes('--probe')) {
    await runProbe(targets, cacheDir);
    return;
  }
  if (process.argv.includes('--autopsy')) {
    await runAutopsy(targets, cacheDir);
    return;
  }
  if (process.argv.includes('--diag')) {
    const views0 = viewsOf(targets);
    const cars0 = await carList();
    const recs0 = collectRecords(targets, cacheDir, views0, simDegradedSource(cars0, { seed: 1 }));
    runDiag(recs0, cacheDir, targets);
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
