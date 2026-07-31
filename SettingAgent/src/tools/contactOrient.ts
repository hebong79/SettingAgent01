// ★ 26회차 신규 — **접지 콘투어의 꺾임(L) 분해 → 앞변 추정**(설계 `_workspace/41_architect_plan_round26_contact_orientation.md` §4-1).
//
// ══════════════════════════════════════════════════════════════════════════
// 왜 필요한가(24회차 실측 근거):
//   현행 `nearEdgeOf` 는 콘투어 좌·우 끝을 잇는 **현(chord)** 이다. 그런데 하단 콘투어는 L 자다
//   (앞범퍼 접지선 + 옆면 접지선). 현은 그 L 을 가로질러 **대각선**을 만들고, 지면 길이 중앙값이
//   3.852938205182645 m(차폭 1.85m 의 2배)로 나온다. 8/36 은 4.7m 도 넘어 `groundAxisOf` 가 장축을 90° 뒤집는다.
//
// 이 파일이 하는 일 — 콘투어를 **픽셀공간에서** 2선분으로 최적 분할(TLS)하고, 게이트를 통과하면
//   두 선분 중 하나를 **앞변**으로 골라 2점을 돌려준다. 게이트 미통과면 호출측이 넘긴 chord 로 폴백한다.
//
// ★★ 오라클 격리 ★★ — 입력은 **콘투어 점 + GroundModel + chord** 뿐이다.
//   차량 월드 좌표·면 라벨·가시성·강등본을 읽지 않는다. `SlotAxes`/`fitContactLine`/`buildFootprint`/
//   `buildFrameCuboids`/`slotPolysPx` 도 부르지 않는다(설계 §5 봉인 승계 · 새 파일로의 봉인 세탁 방지).
// ★ 폴백 chord 는 **인자로 받는다** — `imageObservation.nearEdgeOf` 를 import 하면 순환이 된다(설계 §4-1).

import { backprojectToGround, projectToPixel } from '../ground/project.js';
import type { GroundModel } from '../ground/types.js';
import type { Vec3 } from '../ground/contactTypes.js';

export interface Px {
  x: number;
  y: number;
}

/** 총최소제곱(TLS) 직선. `dir` 은 단위 방향, `rms` 는 직교거리 RMS. */
export interface TlsLine {
  dir: [number, number];
  cx: number;
  cy: number;
  rms: number;
}

/**
 * 총최소제곱 직선 적합 — 공분산 최대고유벡터가 방향, 직교거리 RMS 가 잔차.
 * 최소제곱(y=ax+b)이 아니라 TLS 를 쓰는 이유: 콘투어 선분이 **수직에 가까울 수 있다**(옆면 접지선).
 */
export function tlsFit(pts: readonly Px[]): TlsLine | null {
  const n = pts.length;
  if (n < 2) return null;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // 2×2 대칭행렬의 최대고유값 → 그 고유벡터가 장축 방향.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);
  const l2 = tr / 2 - Math.sqrt(disc);
  let vx = sxy;
  let vy = l1 - sxx;
  if (Math.hypot(vx, vy) < 1e-12) {
    vx = l1 - syy;
    vy = sxy;
  }
  const nv = Math.hypot(vx, vy);
  if (nv < 1e-12) return { dir: [1, 0], cx, cy, rms: 0 };
  return { dir: [vx / nv, vy / nv], cx, cy, rms: Math.sqrt(Math.max(0, l2) / n) };
}

/** 콘투어 2선분 분해 결과. `k` 는 분할 인덱스 — segA = cols[0..k), segB = cols[k..). */
export interface KinkSplit {
  k: number;
  a: TlsLine;
  b: TlsLine;
  /** 1선 적합 RMS. */
  rmsAll: number;
  /** 2선 가중 RMS = sqrt((nA·rmsA² + nB·rmsB²)/n). */
  rms2: number;
  /** 개선배수 = rmsAll / rms2. */
  gain: number;
  /** 두 방향 사이 각(0..90도). */
  kinkDeg: number;
  segA: Px[];
  segB: Px[];
}

const angBetween = (u: readonly [number, number], v: readonly [number, number]): number =>
  (Math.acos(Math.min(1, Math.abs(u[0] * v[0] + u[1] * v[1]))) * 180) / Math.PI;

/**
 * 콘투어를 2선분으로 **최적 분할** — 각 조각 ≥ `minSegCols` 점, 가중 RMS 최소인 분할점 채택.
 * 분할은 **픽셀공간**에서 한다(잘 조건화됨 · 역투영 노출 최소화 — 설계 §2-4).
 */
export function splitContour(cols: readonly Px[], minSegCols = 4): KinkSplit | null {
  const n = cols.length;
  if (n < 2 * minSegCols) return null;
  const all = tlsFit(cols);
  if (!all) return null;
  let best: KinkSplit | null = null;
  for (let k = minSegCols; k <= n - minSegCols; k++) {
    const A = cols.slice(0, k);
    const B = cols.slice(k);
    const fa = tlsFit(A);
    const fb = tlsFit(B);
    if (!fa || !fb) continue;
    const rms2 = Math.sqrt((A.length * fa.rms * fa.rms + B.length * fb.rms * fb.rms) / n);
    if (best && rms2 >= best.rms2) continue;
    best = {
      k,
      a: fa,
      b: fb,
      rmsAll: all.rms,
      rms2,
      gain: rms2 > 1e-12 ? all.rms / rms2 : Infinity,
      kinkDeg: angBetween(fa.dir, fb.dir),
      segA: A,
      segB: B,
    };
  }
  return best;
}

// ── 지면 2D 기저(길이·각도 보존 등거리 사상) ─────────────────────────────────

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Vec3): Vec3 | null => {
  const m = Math.hypot(a[0], a[1], a[2]);
  return m > 1e-9 ? [a[0] / m, a[1] / m, a[2] / m] : null;
};

/** 지면 평면의 정규직교 기저 {e1,e2} — 길이·각도가 보존되므로 지면 통계를 2D 로 낼 수 있다. */
export function groundBasis(g: GroundModel): { e1: Vec3; e2: Vec3 } | null {
  const n = g.n as Vec3;
  const seed: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = unit3(cross3(n, seed));
  if (!e1) return null;
  const e2 = unit3(cross3(n, e1));
  return e2 ? { e1, e2 } : null;
}

/** 픽셀점 → 지면 역투영 → 지면 2D 좌표(미터). 역투영 실패는 null(부분 사용 금지). */
export function toGround2D(p: Px, g: GroundModel, basis: { e1: Vec3; e2: Vec3 }): Px | null {
  const X = backprojectToGround(p, g);
  return X ? { x: dot3(X, basis.e1), y: dot3(X, basis.e2) } : null;
}

/** 두 픽셀점 사이의 **지면 길이**(m). 역투영 실패 시 null. */
export function groundLen(p0: Px, p1: Px, g: GroundModel): number | null {
  const A = backprojectToGround(p0, g);
  const B = backprojectToGround(p1, g);
  return A && B ? Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) : null;
}

// ── ★ 앞변 추정(설계 §4-1) ───────────────────────────────────────────────────

export interface KinkOpts {
  /** 콘투어 최소 열 수 — 미만이면 chord 폴백. */
  minCols: number;
  /** 각 선분 최소 열 수. */
  minSegCols: number;
  /** τ_deg — 단계1 분포에서 도출(설계 §1-3 이 쓴 문턱 20°). */
  minKinkDeg: number;
  /** τ_gain — 같은 근거의 1.5배. */
  minRmsGain: number;
  /**
   * ★ 27-A **F4 꺾임점 고정**(설계 §3 F4) — 채택 앞변 2점 중 꺾임점 쪽 끝을 `cols[splitIdx]` 의
   * TLS 투영으로 **고정**한다. 발동 근거: C6 실측(앞변 끝점↔꺾임점 최소거리 중앙값 14.944379128562943 px ·
   * 악화군 30.664152241448438 vs 개선/폴백군 13.63107017901973). `segEndpoints` 자체는 무변경이다.
   * **기본 false** — 26회차 `'kink'` 산출을 비트 그대로 보존한다(Q3b 앵커).
   */
  pinKink: boolean;
}

export const KINK_DEFAULTS: KinkOpts = { minCols: 8, minSegCols: 4, minKinkDeg: 20, minRmsGain: 1.5, pinKink: false };

export interface EdgeFit {
  p0: Px;
  p1: Px;
  /** 'kink' = 분해 성공 · 'chord' = 게이트 미통과 → 넘겨받은 chord 와 **동일 좌표** 폴백. */
  mode: 'kink' | 'chord';
  kinkDeg: number | null;
  rmsGain: number | null;
  splitIdx: number | null;
  /** 채택되지 않은 선분(계측·스샷 전용). */
  other: [Px, Px] | null;
}

/** TLS 선 위로 조각의 양 끝을 투영한 2점 — 「그 선분의 스팬」. */
export function segEndpoints(seg: readonly Px[], fit: TlsLine): [Px, Px] {
  let tmin = Infinity;
  let tmax = -Infinity;
  for (const p of seg) {
    const t = (p.x - fit.cx) * fit.dir[0] + (p.y - fit.cy) * fit.dir[1];
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  return [
    { x: fit.cx + tmin * fit.dir[0], y: fit.cy + tmin * fit.dir[1] },
    { x: fit.cx + tmax * fit.dir[0], y: fit.cy + tmax * fit.dir[1] },
  ];
}

/**
 * **R3 시선직교** — 카메라 직하점(`d·n`)에서 선분 중점으로 향하는 지면 방향과 이루는 각.
 * 앞범퍼는 시선에 가로눕고(각 큼) 옆면은 시선을 따라 눕는다(각 작음).
 * 규칙 3종 중 이것만 구현한다 — 단계1 M5 실측에서 best-of-two 일치율 28/36 = 0.7777777777777778 로
 * R1(23/36) · R2(26/36) 을 앞섰다. **여러 규칙의 가중합·CLI 스윕을 만들지 않는다**(설계 §3-2 결정 규약).
 */
function radialAngOf(e: readonly [Px, Px], g: GroundModel): number {
  const A = backprojectToGround(e[0], g);
  const B = backprojectToGround(e[1], g);
  if (!A || !B) return NaN;
  const nd: Vec3 = [g.n[0] * g.d, g.n[1] * g.d, g.n[2] * g.d];
  const rv = unit3([(A[0] + B[0]) / 2 - nd[0], (A[1] + B[1]) / 2 - nd[1], (A[2] + B[2]) / 2 - nd[2]]);
  const sv = unit3([B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
  if (!rv || !sv) return NaN;
  return (Math.acos(Math.min(1, Math.abs(dot3(rv, sv)))) * 180) / Math.PI;
}

/**
 * 접지 콘투어 → **앞변 2점**. 게이트(`kinkDeg ≥ τ_deg` AND `gain ≥ τ_gain`) 통과 시 꺾임 분해,
 * 미통과 시 호출측이 넘긴 `chord` 로 폴백한다(= 24회차 산출과 동일 = 무회귀).
 * 산출 2점은 `footprintFromContact` 에 **그대로** 넘긴다(그 함수는 무변경 — 설계 §4-3).
 */
export function frontEdgeOf(
  cols: readonly Px[],
  g: GroundModel,
  chord: readonly [Px, Px] | null,
  opts?: Partial<KinkOpts>,
): EdgeFit | null {
  const o = { ...KINK_DEFAULTS, ...opts };
  const fallback = (kinkDeg: number | null, rmsGain: number | null): EdgeFit | null =>
    chord ? { p0: chord[0], p1: chord[1], mode: 'chord', kinkDeg, rmsGain, splitIdx: null, other: null } : null;
  if (cols.length < o.minCols) return fallback(null, null);
  const sp = splitContour(cols, o.minSegCols);
  if (!sp) return fallback(null, null);
  if (!(sp.kinkDeg >= o.minKinkDeg && sp.gain >= o.minRmsGain)) return fallback(sp.kinkDeg, sp.gain);
  const eA = segEndpoints(sp.segA, sp.a);
  const eB = segEndpoints(sp.segB, sp.b);
  const ra = radialAngOf(eA, g);
  const rb = radialAngOf(eB, g);
  if (!Number.isFinite(ra) || !Number.isFinite(rb)) return fallback(sp.kinkDeg, sp.gain);
  const front = ra >= rb ? eA : eB;
  const other = ra >= rb ? eB : eA;
  // ★ F4 — 꺾임점 쪽 끝을 `cols[splitIdx]` 의 TLS 투영으로 고정(스팬 과연장 차단).
  const kp = o.pinKink ? cols[sp.k] : null;
  if (kp) {
    const L = ra >= rb ? sp.a : sp.b;
    const t = (kp.x - L.cx) * L.dir[0] + (kp.y - L.cy) * L.dir[1];
    const proj = { x: L.cx + t * L.dir[0], y: L.cy + t * L.dir[1] };
    const i = Math.hypot(front[0].x - kp.x, front[0].y - kp.y) <= Math.hypot(front[1].x - kp.x, front[1].y - kp.y) ? 0 : 1;
    front[i] = proj;
  }
  return { p0: front[0], p1: front[1], mode: 'kink', kinkDeg: sp.kinkDeg, rmsGain: sp.gain, splitIdx: sp.k, other };
}

/**
 * 앞변 스팬 클램프(설계 §4-3 **조건부 예외**) — 지면 길이가 `maxM` 를 넘으면 중점 기준으로 `toM` 까지 줄인다.
 * **방향은 바꾸지 않는다**(중점 대칭 축소). 바뀌는 것은 `footprintFromContact` 산출 quad 의 가로/세로 비뿐이며,
 * 그 결과 `groundAxisOf`(`carAnchorUpper.ts:256`)가 장축을 **깊이축으로 정상 선택**한다.
 * 이 함수는 차량 prior `CAR_BODY` 에 의존한다 — 그 사실을 보고서에 명시할 것.
 */
export function clampSpan(e: readonly [Px, Px], g: GroundModel, maxM: number, toM: number): [Px, Px] {
  const A = backprojectToGround(e[0], g);
  const B = backprojectToGround(e[1], g);
  if (!A || !B) return [e[0], e[1]];
  const L = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
  if (!(L > maxM) || !(L > 1e-9)) return [e[0], e[1]];
  const k = toM / L;
  const mid: Vec3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const shrink = (X: Vec3): Vec3 => [mid[0] + (X[0] - mid[0]) * k, mid[1] + (X[1] - mid[1]) * k, mid[2] + (X[2] - mid[2]) * k];
  const pa = projectToPixel(shrink(A), g);
  const pb = projectToPixel(shrink(B), g);
  return pa && pb ? [pa, pb] : [e[0], e[1]];
}
