// 노면 도색선 검출(Stage A) — **순수 · IO 0 · sharp 미참조 · 그레이스케일 전용**.
//
// 저장소 관례(`capture/frameAlign.ts` 규약, `api/captureRoutes.ts:220 jpegToGray` 사례):
//   sharp 는 라우트 계층이 쓰고, 알고리즘은 `Uint8Array` 그레이 배열만 받는다.
//
// ★ 색 채널을 쓰지 않는다(리더 D-5). 시뮬레이터의 초록 주차면 박스는 실카에 없는 합성 단서이므로
//   검출기가 색에 의존하면 실카 전이가 구조적으로 불가능해진다. 초록 오염 가드는 라우트가 소유한다.
//
// 난수 0 · RANSAC 0(R2). 모든 순회는 고정 순서이고 동점은 낮은 인덱스가 이긴다.
//
// ── 구현자 실측 요약(추측 아님. 5개 프리셋 실프레임에서 직접 측정) ──────────────────
//   · 전방 도색 실선은 안정적으로 검출된다(수동 근변 대비 최대거리 1.1~2.9px).
//   · 슬롯 분리선 스텁은 **전역 Hough 만으로는 부족하다** — 참 소실점에 2px 이내로 수렴하는
//     검출 직선이 프레임당 1~7개뿐이었다(총 250직선 중). 그래서 `scanSeparators`(전방선에서
//     뻗는 방향탐색)를 추가했다. 이 스캔은 참 코너 전부의 근방(2.6~31px)에 후보를 만든다.
//   · 그러나 후보 대비 오검출이 많아(참 코너 7개 : 피크 58개) 최종 선별은 아직 미해결이다.
//     상세 수치는 `_workspace/02_developer_changes.md` 참조.

/** 그레이 프레임(원본 센서 픽셀, 좌상단 원점). `data.length === width*height`. */
export interface FrameGray {
  data: Uint8Array;
  width: number;
  height: number;
}

/** 정규화 직선 `a*x + b*y + c = 0`, `a²+b²=1`. 부호 규약은 `normalizeLine` 참조. */
export type Line2 = readonly [number, number, number];

/** 서브픽셀 정련을 통과한 직선 1건. */
export interface RefinedLine {
  line: [number, number, number];
  /** 정련 표본의 최대 법선 잔차(px). */
  residPx: number;
  /** 스트라이프 중심을 얻은 표본 수. */
  hit: number;
  /** 평균 스트라이프 폭(px). */
  widthPx: number;
  /** 평균 대비(peak − bg). */
  contrast: number;
  /** 정련 표본이 덮은 구간 길이(px). */
  spanPx: number;
  /** 구간 양 끝(정련된 스트라이프 중심). */
  endA: { x: number; y: number };
  endB: { x: number; y: number };
  /** Hough 누적값(거친 검출 세기). 스캔 유래 직선은 0. */
  votes: number;
}

/** 전방선에서 뻗는 방향탐색이 찾은 분리선 후보 1건. */
export interface SeparatorPeak {
  /** 전방선 위 파라미터(px). */
  s: number;
  /** 전방선 위 교점. */
  p: { x: number; y: number };
  /** 스텁 진행 단위방향. */
  d: { x: number; y: number };
  /** 도색 마스크가 이어진 최장 길이(px) — 피크 세기. */
  runPx: number;
  /** 전방선 기준 각도(도). */
  angleDeg: number;
}

export interface PaintOptions {
  /** 배경 추정 블록 크기(px). */
  bgBlockPx: number;
  /** 마스크 임계 백분위(밝기−배경 차의 분포). */
  maskPercentile: number;
  /** 스트라이프로 인정하는 최소 대비(peak − bg). */
  minContrast: number;
  /** 능선 필터 사용 여부(얇은 띠만 남긴다). */
  ridge: boolean;
  /** 능선 판정: 양옆이 이만큼 어두워야 한다. */
  ridgeDrop: number;
  /** 능선 판정 반폭 후보(px). */
  ridgeHalfWidths: readonly number[];
  thetaStepDeg: number;
  minVotes: number;
  nmsThetaBins: number;
  nmsRhoBins: number;
  maxLines: number;
  /** 지지 구간 판정 반폭(px). */
  supportHalfPx: number;
  /** 지지 구간에서 허용하는 최대 결손(px) — 차량 가림 구간을 잇는다. */
  supportGapPx: number;
  minSupportPx: number;
  profileHalfPx: number;
  profileStepPx: number;
  samplesPerLine: number;
  minHits: number;
  /** 배경 추정 백분위(프로파일 내). */
  profileBgPercentile: number;
  // ── 분리선 방향탐색(scanSeparators)
  scanAngleRangeDeg: number;
  scanAngleStepDeg: number;
  scanStartPx: number;
  scanEndPx: number;
  scanGapPx: number;
  scanMinRunPx: number;
  scanNmsPx: number;
  /**
   * ★ 분리선 정련 전용 프로파일 반폭(px). 전방선 정련(profileHalfPx)과 **분리된 축**이다.
   *
   * 왜 분리했나: 분리선은 전방선과 교차하므로 창이 넓고 시작점이 가까우면 프로파일에 전방선 자신의
   * 도색이 섞여 스트라이프 중심이 끌려간다. 합성 장면에서 `scanStartPx=18, 반폭 8` 로 좁히면
   * 코너 오차 3.34px → 0.08~2.34px, quad IoU 0.8931~0.9396 → **0.9879~0.9959** 로 올라간다.
   *
   * ★ 그러나 실프레임에서는 반대다(구현자 실측 스윕): 실제 분리선 스텁은 30~120px 로 짧아
   * 시작점을 18px 로 밀면 표본 자체가 사라진다 — 1:1 평균 IoU 0.6004(start=6/nms=10/반폭14)
   * → 0.0449(start=10/nms=8/반폭10) → 0.0026(start=12/nms=8/반폭8).
   * **기본값은 실프레임 최선을 따른다.** 합성 상한은 `test/bayGeometry.test.ts` 가 튜닝값으로 따로 봉인한다.
   * 이 상충은 미해결이며 `_workspace/02_developer_changes.md` 에 그대로 적었다.
   */
  separatorProfileHalfPx: number;
  /** 전방선 후보 개수(votes 내림차순 상위 N). */
  frontCandidates: number;
  // ── 재투영 도색지지(P1)
  /** 변 하나당 표본 수. */
  supportSamples: number;
  /** 도색으로 인정하는 최대 거리(px). */
  paintTolPx: number;
  /** 거리 상한(px) — 이보다 멀면 전부 같은 값으로 포화시킨다. */
  supportSearchPx: number;
  /** 변 양 끝에서 건너뛸 비율(코너 = 두 도색선 교차점이라 귀속 모호). */
  endTrimRatio: number;
}

/** 구현자가 실프레임 5장에서 측정해 고정한 기본값. 실카에서는 재조정 대상이다(R10). */
export const DEFAULT_PAINT_OPTIONS: PaintOptions = {
  bgBlockPx: 16,
  maskPercentile: 0.97,
  minContrast: 45,
  ridge: true,
  ridgeDrop: 25,
  ridgeHalfWidths: [6, 10, 16],
  thetaStepDeg: 0.2,
  minVotes: 50,
  nmsThetaBins: 10,
  nmsRhoBins: 30,
  maxLines: 60,
  supportHalfPx: 3,
  supportGapPx: 40,
  minSupportPx: 40,
  profileHalfPx: 14,
  profileStepPx: 0.5,
  samplesPerLine: 15,
  minHits: 3,
  profileBgPercentile: 0.35,
  scanAngleRangeDeg: 70,
  scanAngleStepDeg: 0.5,
  scanStartPx: 6,
  scanEndPx: 150,
  scanGapPx: 6,
  scanMinRunPx: 18,
  scanNmsPx: 10,
  separatorProfileHalfPx: 14,
  frontCandidates: 8,
  supportSamples: 21,
  paintTolPx: 6,
  supportSearchPx: 40,
  endTrimRatio: 0.08,
};

const DEG = Math.PI / 180;

/** 부호 규약: a>0, a=0 이면 b>0. 길이 0 → null. 같은 직선이 두 표현을 갖지 않게 한다(결정론). */
export function normalizeLine(l: Line2): [number, number, number] | null {
  const n = Math.hypot(l[0], l[1]);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  let a = l[0] / n;
  let b = l[1] / n;
  let c = l[2] / n;
  if (a < 0 || (a === 0 && b < 0)) {
    a = -a;
    b = -b;
    c = -c;
  }
  return [a, b, c];
}

/** 두 점을 지나는 직선. 같은 점 → null. */
export function lineThrough(p: { x: number; y: number }, q: { x: number; y: number }): [number, number, number] | null {
  return normalizeLine([p.y - q.y, q.x - p.x, p.x * q.y - q.x * p.y]);
}

/** 두 직선 교점. 평행/퇴화 → null. */
export function meetLines(l: Line2, m: Line2): { x: number; y: number } | null {
  const d = l[0] * m[1] - l[1] * m[0];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const x = (l[1] * m[2] - l[2] * m[1]) / d;
  const y = (l[2] * m[0] - l[0] * m[2]) / d;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

interface BgField {
  f: Float32Array;
  bw: number;
  bh: number;
  blk: number;
}

/** 블록 median 배경장. */
function bgField(g: Uint8Array, W: number, H: number, blk: number): BgField {
  const bw = Math.ceil(W / blk);
  const bh = Math.ceil(H / blk);
  const f = new Float32Array(bw * bh);
  const buf: number[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      buf.length = 0;
      const yEnd = Math.min(H, (by + 1) * blk);
      const xEnd = Math.min(W, (bx + 1) * blk);
      for (let y = by * blk; y < yEnd; y++) for (let x = bx * blk; x < xEnd; x++) buf.push(g[y * W + x]);
      buf.sort((p, q) => p - q);
      f[by * bw + bx] = buf.length ? buf[buf.length >> 1] : 0;
    }
  }
  return { f, bw, bh, blk };
}

/** 배경장 쌍선형 보간. */
function bgAt(bf: BgField, x: number, y: number): number {
  const { f, bw, bh, blk } = bf;
  const fx = x / blk - 0.5;
  const fy = y / blk - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cx0 = Math.min(bw - 1, Math.max(0, x0));
  const cx1 = Math.min(bw - 1, Math.max(0, x0 + 1));
  const cy0 = Math.min(bh - 1, Math.max(0, y0));
  const cy1 = Math.min(bh - 1, Math.max(0, y0 + 1));
  const a = f[cy0 * bw + cx0];
  const b = f[cy0 * bw + cx1];
  const c = f[cy1 * bw + cx0];
  const d = f[cy1 * bw + cx1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * A2. 도색 마스크 = (밝기 − 국소배경) 상위 백분위 + **능선(얇은 밝은 띠) 필터**.
 *
 * ★ 능선 필터가 결정적이다(구현자 실측): 도색선은 폭이 유한한 **띠**이고 차체 하이라이트는 **덩어리**다.
 *   4방향 × 반폭 후보에 대해 "양옆이 모두 어둡다"를 요구해 덩어리를 떨어뜨린다. 순수 국소 판정.
 */
export function paintMask(frame: FrameGray, opts: PaintOptions): { mask: Uint8Array; threshold: number } {
  const { data: g, width: W, height: H } = frame;
  const bf = bgField(g, W, H, opts.bgBlockPx);
  const diff = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) diff[y * W + x] = g[y * W + x] - bgAt(bf, x, y);
  const samp: number[] = [];
  for (let i = 0; i < diff.length; i += 37) samp.push(diff[i]);
  samp.sort((a, b) => a - b);
  const q = samp.length ? samp[Math.min(samp.length - 1, Math.floor(samp.length * opts.maskPercentile))] : 0;
  const threshold = Math.max(opts.minContrast * 0.5, q);
  const raw = new Uint8Array(W * H);
  for (let i = 0; i < diff.length; i++) if (diff[i] > threshold) raw[i] = 1;
  if (!opts.ridge) return { mask: raw, threshold };

  const dirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!raw[i]) continue;
      const v = g[i];
      let ok = false;
      for (const d of opts.ridgeHalfWidths) {
        for (const [dx, dy] of dirs) {
          const ax = x + dx * d;
          const ay = y + dy * d;
          const bx = x - dx * d;
          const by = y - dy * d;
          if (ax < 0 || ay < 0 || ax >= W || ay >= H || bx < 0 || by < 0 || bx >= W || by >= H) continue;
          if (v - g[ay * W + ax] >= opts.ridgeDrop && v - g[by * W + bx] >= opts.ridgeDrop) {
            ok = true;
            break;
          }
        }
        if (ok) break;
      }
      if (ok) mask[i] = 1;
    }
  }
  return { mask, threshold };
}

/** 직선의 이미지 내 파라미터 구간. 기준점 `-c*(a,b)`, 방향 `(-b,a)`. 교차 없음 → null. */
export interface LineSpan {
  tmin: number;
  tmax: number;
  px0: number;
  py0: number;
  dx: number;
  dy: number;
}

export function imageSpanOf(line: Line2, W: number, H: number): LineSpan | null {
  const [a, b, c] = line;
  const px0 = -c * a;
  const py0 = -c * b;
  const dx = -b;
  const dy = a;
  let tmin = -Infinity;
  let tmax = Infinity;
  let dead = false;
  const clip = (num: number, den: number): void => {
    if (Math.abs(den) < 1e-12) {
      if (num < 0) dead = true;
      return;
    }
    const t = -num / den;
    if (den > 0) tmin = Math.max(tmin, t);
    else tmax = Math.min(tmax, t);
  };
  clip(px0, dx);
  clip(W - 1 - px0, -dx);
  clip(py0, dy);
  clip(H - 1 - py0, -dy);
  if (dead || !(tmax > tmin) || !Number.isFinite(tmin) || !Number.isFinite(tmax)) return null;
  return { tmin, tmax, px0, py0, dx, dy };
}

/**
 * ★ 마스크 지지 구간 — 직선 위에서 도색 화소가 실제로 이어지는 최장 구간(결손 허용).
 *
 * 이것이 없으면 짧은 분리선 스텁이 이미지 전폭 샘플링에 묻혀 정련에 **전부 실패**한다
 * (구현자 실측: 지지구간 도입 전 1:1 분리선 검출 0건 → 도입 후 6건).
 */
export function supportSpan(mask: Uint8Array, W: number, H: number, line: Line2, opts: PaintOptions): LineSpan | null {
  const sp = imageSpanOf(line, W, H);
  if (!sp) return null;
  const t0 = Math.ceil(sp.tmin);
  const t1 = Math.floor(sp.tmax);
  const hits: number[] = [];
  for (let t = t0; t <= t1; t++) {
    const x = sp.px0 + sp.dx * t;
    const y = sp.py0 + sp.dy * t;
    let on = 0;
    for (let u = -opts.supportHalfPx; u <= opts.supportHalfPx; u++) {
      const xi = Math.round(x + line[0] * u);
      const yi = Math.round(y + line[1] * u);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
      if (mask[yi * W + xi]) {
        on = 1;
        break;
      }
    }
    hits.push(on);
  }
  let best: { start: number; end: number } | null = null;
  let curStart = -1;
  let gap = 0;
  const keep = (start: number, end: number): void => {
    if (!best || end - start > best.end - best.start) best = { start, end };
  };
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]) {
      if (curStart < 0) curStart = i;
      gap = 0;
    } else if (curStart >= 0) {
      gap++;
      if (gap > opts.supportGapPx) {
        keep(curStart, i - gap);
        curStart = -1;
        gap = 0;
      }
    }
  }
  if (curStart >= 0) keep(curStart, hits.length - 1 - gap);
  if (!best) return null;
  const b: { start: number; end: number } = best;
  if (b.end - b.start < opts.minSupportPx) return null;
  return { tmin: t0 + b.start, tmax: t0 + b.end, px0: sp.px0, py0: sp.py0, dx: sp.dx, dy: sp.dy };
}

/** 밝기 프로파일에서 스트라이프 중심(무게중심). 대비 미달/표본 부족 → null. */
export function stripeCenter(
  prof: ReadonlyArray<{ t: number; v: number | null }>,
  opts: PaintOptions,
): { t: number; width: number; contrast: number } | null {
  // ★ 잘린 프로파일은 **버린다**. 한쪽이 프레임 밖으로 잘리면 무게중심이 그쪽으로 끌려가
  //   계통 오차가 생긴다(구현자 실측: 경계 표본 포함 시 합성 스트라이프 오프셋 0.02px → 0.91px).
  const vals: number[] = [];
  for (const p of prof) {
    if (p.v == null) return null;
    vals.push(p.v);
  }
  if (vals.length < 10) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const bg = sorted[Math.floor(sorted.length * opts.profileBgPercentile)];
  const peak = sorted[sorted.length - 1];
  if (peak - bg < opts.minContrast) return null;
  const thr = bg + (peak - bg) * 0.5;
  let sw = 0;
  let sws = 0;
  let n = 0;
  for (const p of prof) {
    if (p.v != null && p.v >= thr) {
      const w = p.v - bg;
      sw += w;
      sws += w * p.t;
      n++;
    }
  }
  if (!n || !(sw > 0)) return null;
  return { t: sws / sw, width: n * opts.profileStepPx, contrast: peak - bg };
}

/**
 * ★ **구간 균등 가중** 총최소제곱(10회차 P1).
 *
 * 왜 필요한가(구현자 실측): 행 전 구간에서 스트라이프 중심을 떠도 **가림 때문에 살아남는 표본이
 * 한쪽에 몰린다**. 비가중 TLS 는 표본이 촘촘한 쪽으로 각도를 끌어당기고, 그 편향이 격자를 통해
 * 다시 샘플링 구간을 정하므로 **반복해도 같은 편향점으로 수렴한다**(8회차: pass2 이동 0.009px 로
 * 이미 수렴했는데도 회전이 과보정된 채였다). 반복 횟수가 아니라 **가중**의 문제였다.
 *
 * 표본을 행 파라미터 t 로 K개 구간에 나누고 각 표본에 1/(그 구간의 표본 수) 가중을 준다 →
 * 구간별 기여가 같아져 밀집 편향이 사라진다. 튜닝 파라미터가 아니라 구조적 보정이다.
 */
export function fitLineTLSBinned(
  pts: ReadonlyArray<{ x: number; y: number }>,
  ts: readonly number[],
  bins: number,
): [number, number, number] | null {
  const n = pts.length;
  if (n < 2 || ts.length !== n || bins < 1) return null;
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  const span = hi - lo;
  const idx = ts.map((t) => (span > 1e-9 ? Math.min(bins - 1, Math.floor(((t - lo) / span) * bins)) : 0));
  const count = new Array<number>(bins).fill(0);
  for (const b of idx) count[b]++;
  const w = idx.map((b) => (count[b] > 0 ? 1 / count[b] : 0));
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    mx += w[i] * pts[i].x;
    my += w[i] * pts[i].y;
  }
  if (!(sw > 0)) return null;
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i].x - mx;
    const dy = pts[i].y - my;
    sxx += w[i] * dx * dx;
    sxy += w[i] * dx * dy;
    syy += w[i] * dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const a = -uy;
  const b = ux;
  return normalizeLine([a, b, -(a * mx + b * my)]);
}

/** 총최소제곱 직선 적합(2차 모멘트 고유방향 — 닫힌 해, 난수 0). */
export function fitLineTLS(pts: ReadonlyArray<{ x: number; y: number }>): [number, number, number] | null {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const a = -uy;
  const b = ux;
  return normalizeLine([a, b, -(a * mx + b * my)]);
}

/**
 * A4. 서브픽셀 정련 — 법선 방향 밝기 프로파일의 스트라이프 무게중심을 TLS 로 재적합.
 * `span` 미지정 시 이미지 전 구간을 쓴다(짧은 스텁에는 `supportSpan` 을 넘겨야 한다).
 */
/**
 * 직선을 따라 스트라이프 중심 표본을 수집한다(정련의 관측 단계).
 * `refineLine` 과 강건 재적합이 **같은 관측**을 공유하도록 분리했다 — 관측을 두 벌 만들지 않는다.
 */
export function sampleStripeCenters(
  frame: FrameGray,
  line: Line2,
  opts: PaintOptions,
  span?: LineSpan,
): Array<{ x: number; y: number; width: number; contrast: number }> {
  const { data: g, width: W, height: H } = frame;
  const at = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const a = g[y0 * W + x0];
    const b = g[y0 * W + x1];
    const c = g[y1 * W + x0];
    const d = g[y1 * W + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  const sp = span ?? imageSpanOf(line, W, H);
  if (!sp) return [];
  const nx = line[0];
  const ny = line[1];
  const pts: Array<{ x: number; y: number; width: number; contrast: number }> = [];
  const NS = Math.max(2, opts.samplesPerLine);
  for (let s = 0; s < NS; s++) {
    const t = sp.tmin + ((sp.tmax - sp.tmin) * s) / (NS - 1);
    const cxp = sp.px0 + sp.dx * t;
    const cyp = sp.py0 + sp.dy * t;
    const prof: Array<{ t: number; v: number | null }> = [];
    for (let u = -opts.profileHalfPx; u <= opts.profileHalfPx; u += opts.profileStepPx) {
      prof.push({ t: u, v: at(cxp + nx * u, cyp + ny * u) });
    }
    const sc = stripeCenter(prof, opts);
    if (!sc) continue;
    pts.push({ x: cxp + nx * sc.t, y: cyp + ny * sc.t, width: sc.width, contrast: sc.contrast });
  }
  return pts;
}

/** 표본 집합 → RefinedLine(공통 조립). */
function buildRefined(
  pts: ReadonlyArray<{ x: number; y: number; width: number; contrast: number }>,
  minHits: number,
): RefinedLine | null {
  if (pts.length < minHits) return null;
  const fit = fitLineTLS(pts);
  if (!fit) return null;
  let resid = 0;
  for (const p of pts) resid = Math.max(resid, Math.abs(fit[0] * p.x + fit[1] * p.y + fit[2]));
  const endA = { x: pts[0].x, y: pts[0].y };
  const endB = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  return {
    line: fit,
    residPx: resid,
    hit: pts.length,
    widthPx: pts.reduce((s, p) => s + p.width, 0) / pts.length,
    contrast: pts.reduce((s, p) => s + p.contrast, 0) / pts.length,
    spanPx: Math.hypot(endB.x - endA.x, endB.y - endA.y),
    endA,
    endB,
    votes: 0,
  };
}

/**
 * ★ 강건 정련 — 적합 후 잔차가 큰 표본을 **결정론적으로** 잘라내고 다시 적합한다(난수 0).
 *
 * 왜 필요한가(8회차 실측): 행 전 구간에서 표본을 뜨면 지레팔은 길어지지만 차체 모서리·그림자 같은
 * 이물 표본도 함께 들어온다(잔차 5~15px). 그것이 각도를 끌어 **회전을 과보정**했다
 * (1:1 오프셋 기울기 −0.094m → +0.049m 로 부호가 뒤집혔다).
 * MAD 기반 임계로 이물을 떨어뜨리면 긴 지레팔의 이점만 남는다.
 */
export function refineLineRobust(
  frame: FrameGray,
  line: Line2,
  opts: PaintOptions,
  span: LineSpan,
  trimK: number,
  passes: number,
  /** >0 이면 행 파라미터를 이 개수의 구간으로 나눠 **균등 가중** TLS 를 쓴다. */
  uniformBins = 0,
): RefinedLine | null {
  let pts = sampleStripeCenters(frame, line, opts, span);
  if (uniformBins > 0 && pts.length >= opts.minHits) {
    const ts = pts.map((q) => (q.x - span.px0) * span.dx + (q.y - span.py0) * span.dy);
    const fit = fitLineTLSBinned(pts, ts, uniformBins);
    if (fit) {
      let resid = 0;
      for (const q of pts) resid = Math.max(resid, Math.abs(fit[0] * q.x + fit[1] * q.y + fit[2]));
      return {
        line: fit,
        residPx: resid,
        hit: pts.length,
        widthPx: pts.reduce((a, q) => a + q.width, 0) / pts.length,
        contrast: pts.reduce((a, q) => a + q.contrast, 0) / pts.length,
        spanPx: Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y),
        endA: { x: pts[0].x, y: pts[0].y },
        endB: { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y },
        votes: 0,
      };
    }
  }
  let out = buildRefined(pts, opts.minHits);
  if (!out) return null;
  // trimK ≤ 0 이면 절단하지 않는다(= 순수 TLS). 8회차 실측에서 **절단이 오히려 해로웠다**:
  // 표본이 59 → 31~35 로 줄며 유효 지레팔이 짧아져 2:1 이 0.966 → 0.904 로 후퇴했다.
  if (!(trimK > 0)) return out;
  for (let i = 0; i < passes; i++) {
    const l = out.line;
    const res = pts.map((p) => Math.abs(l[0] * p.x + l[1] * p.y + l[2]));
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const dev = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
    const mad = dev[dev.length >> 1];
    // MAD 가 0 이면(대부분 완전 공선) 자를 것이 없다.
    const tol = mad > 1e-6 ? med + trimK * mad : Number.POSITIVE_INFINITY;
    const kept = pts.filter((_, k) => res[k] <= tol);
    if (kept.length < opts.minHits || kept.length === pts.length) break;
    const next = buildRefined(kept, opts.minHits);
    if (!next) break;
    pts = kept;
    out = next;
  }
  return out;
}

export function refineLine(frame: FrameGray, line: Line2, opts: PaintOptions, span?: LineSpan): RefinedLine | null {
  const { data: g, width: W, height: H } = frame;
  // ★ 쌍선형 표본 — 최근접 표본은 프로파일을 ±0.5px 로 양자화해 무게중심에 계통오차를 남긴다
  //   (구현자 실측: 최근접 0.56px → 쌍선형 0.02px, 합성 스트라이프 기준). 코너 정밀도의 병목이었다.
  const at = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const a = g[y0 * W + x0];
    const b = g[y0 * W + x1];
    const c = g[y1 * W + x0];
    const d = g[y1 * W + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  const sp = span ?? imageSpanOf(line, W, H);
  if (!sp) return null;
  const nx = line[0];
  const ny = line[1];
  const pts: Array<{ x: number; y: number; width: number; contrast: number }> = [];
  const NS = Math.max(2, opts.samplesPerLine);
  for (let s = 0; s < NS; s++) {
    const t = sp.tmin + ((sp.tmax - sp.tmin) * s) / (NS - 1);
    const cxp = sp.px0 + sp.dx * t;
    const cyp = sp.py0 + sp.dy * t;
    const prof: Array<{ t: number; v: number | null }> = [];
    for (let u = -opts.profileHalfPx; u <= opts.profileHalfPx; u += opts.profileStepPx) {
      prof.push({ t: u, v: at(cxp + nx * u, cyp + ny * u) });
    }
    const sc = stripeCenter(prof, opts);
    if (!sc) continue;
    pts.push({ x: cxp + nx * sc.t, y: cyp + ny * sc.t, width: sc.width, contrast: sc.contrast });
  }
  if (pts.length < opts.minHits) return null;
  const fit = fitLineTLS(pts);
  if (!fit) return null;
  let resid = 0;
  for (const p of pts) resid = Math.max(resid, Math.abs(fit[0] * p.x + fit[1] * p.y + fit[2]));
  const endA = { x: pts[0].x, y: pts[0].y };
  const endB = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  return {
    line: fit,
    residPx: resid,
    hit: pts.length,
    widthPx: pts.reduce((s, p) => s + p.width, 0) / pts.length,
    contrast: pts.reduce((s, p) => s + p.contrast, 0) / pts.length,
    spanPx: Math.hypot(endB.x - endA.x, endB.y - endA.y),
    endA,
    endB,
    votes: 0,
  };
}

/** A3. Hough 거친 직선. 반환 순서 고정: 누적 desc → theta asc → rho asc(R2). */
export function coarseLines(
  mask: Uint8Array,
  W: number,
  H: number,
  opts: PaintOptions,
): Array<{ line: [number, number, number]; votes: number; thetaDeg: number; rho: number }> {
  const step = opts.thetaStepDeg * DEG;
  const NTH = Math.round(Math.PI / step);
  const RMAX = Math.ceil(Math.hypot(W, H));
  const NR = 2 * RMAX + 1;
  const acc = new Int32Array(NTH * NR);
  const cosT = new Float64Array(NTH);
  const sinT = new Float64Array(NTH);
  for (let t = 0; t < NTH; t++) {
    cosT[t] = Math.cos(t * step);
    sinT[t] = Math.sin(t * step);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let t = 0; t < NTH; t++) acc[t * NR + Math.round(x * cosT[t] + y * sinT[t]) + RMAX]++;
    }
  }
  const peaks: Array<{ line: [number, number, number]; votes: number; thetaDeg: number; rho: number }> = [];
  for (let t = 0; t < NTH; t++) {
    for (let r = 0; r < NR; r++) {
      const v = acc[t * NR + r];
      if (v < opts.minVotes) continue;
      let best = true;
      for (let dt = -opts.nmsThetaBins; dt <= opts.nmsThetaBins && best; dt++) {
        const tt = (((t + dt) % NTH) + NTH) % NTH;
        for (let dr = -opts.nmsRhoBins; dr <= opts.nmsRhoBins; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= NR) continue;
          const u = acc[tt * NR + rr];
          if (u > v || (u === v && (tt < t || (tt === t && rr < r)))) {
            best = false;
            break;
          }
        }
      }
      if (best) peaks.push({ line: [cosT[t], sinT[t], -(r - RMAX)], votes: v, thetaDeg: t * opts.thetaStepDeg, rho: r - RMAX });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes || a.thetaDeg - b.thetaDeg || a.rho - b.rho);
  return peaks.slice(0, opts.maxLines);
}

/** A2~A4 일괄. 정련 성공 직선만, 누적 내림차순 고정 정렬. */
export function detectPaintLines(
  frame: FrameGray,
  opts: PaintOptions,
): { lines: RefinedLine[]; mask: Uint8Array; threshold: number } {
  const { mask, threshold } = paintMask(frame, opts);
  const coarse = coarseLines(mask, frame.width, frame.height, opts);
  const lines: RefinedLine[] = [];
  for (const c of coarse) {
    const span = supportSpan(mask, frame.width, frame.height, c.line, opts);
    if (!span) continue;
    const r = refineLine(frame, c.line, opts, span);
    if (r) lines.push({ ...r, votes: c.votes });
  }
  lines.sort((a, b) => b.votes - a.votes || a.line[2] - b.line[2]);
  return { lines, mask, threshold };
}

/**
 * ★ 분리선 방향탐색 — 전방선 위 각 지점에서 각도를 훑어 **가장 긴 도색 연속 구간**을 찾는다.
 *
 * 왜 필요한가(구현자 실측): 슬롯 분리선은 차량에 가려 30~120px 스텁으로만 보인다. 전역 Hough 는
 * 이 스텁을 차체 모서리 수백 개에 묻어버린다(참 소실점 2px 이내 수렴 직선이 250개 중 1~7개).
 * 전방선을 **이미지에서 먼저 얻은 뒤** 그 위에서 국소 탐색하면 짧은 스텁도 살아남는다
 * (참 코너 전부의 근방 2.6~31px 에 후보 생성 — 다만 오검출도 함께 늘어난다).
 *
 * 전방선은 이미지 증거이므로 이 시드는 hold-out 을 깨지 않는다(R1).
 */
export function scanSeparators(
  frame: FrameGray,
  mask: Uint8Array,
  front: RefinedLine,
  opts: PaintOptions,
): SeparatorPeak[] {
  const { width: W, height: H } = frame;
  const sp = imageSpanOf(front.line, W, H);
  if (!sp) return [];
  const nx = front.line[0];
  const ny = front.line[1];
  const ux = -front.line[1];
  const uy = front.line[0];
  const hit = (x: number, y: number): number => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi < 0 || yi < 0 || xi >= W || yi >= H ? 0 : mask[yi * W + xi];
  };
  const S0 = Math.ceil(sp.tmin);
  const S1 = Math.floor(sp.tmax);
  const n = S1 - S0 + 1;
  if (n < 10) return [];
  const score = new Float32Array(n);
  const ang = new Float32Array(n);
  for (let s = S0; s <= S1; s++) {
    const px = sp.px0 + sp.dx * s;
    const py = sp.py0 + sp.dy * s;
    let bs = 0;
    let ba = 0;
    for (let a = -opts.scanAngleRangeDeg; a <= opts.scanAngleRangeDeg; a += opts.scanAngleStepDeg) {
      const ca = Math.cos(a * DEG);
      const sa = Math.sin(a * DEG);
      for (const sgn of [1, -1] as const) {
        const dx = sgn * (nx * ca + ux * sa);
        const dy = sgn * (ny * ca + uy * sa);
        let run = 0;
        let cur = 0;
        let gap = 0;
        for (let r = opts.scanStartPx; r <= opts.scanEndPx; r++) {
          if (hit(px + dx * r, py + dy * r)) {
            cur = cur === 0 ? 1 : cur + 1 + gap;
            gap = 0;
            if (cur > run) run = cur;
          } else if (cur > 0) {
            gap++;
            if (gap > opts.scanGapPx) {
              cur = 0;
              gap = 0;
            }
          }
        }
        if (run > bs) {
          bs = run;
          ba = sgn > 0 ? a : a + 180;
        }
      }
    }
    score[s - S0] = bs;
    ang[s - S0] = ba;
  }
  const peaks: SeparatorPeak[] = [];
  for (let i = 0; i < n; i++) {
    if (score[i] < opts.scanMinRunPx) continue;
    let ok = true;
    for (let d = -opts.scanNmsPx; d <= opts.scanNmsPx; d++) {
      const j = i + d;
      if (j < 0 || j >= n) continue;
      if (score[j] > score[i] || (score[j] === score[i] && j < i)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const s = S0 + i;
    const a = ang[i] * DEG;
    peaks.push({
      s,
      p: { x: sp.px0 + sp.dx * s, y: sp.py0 + sp.dy * s },
      d: { x: nx * Math.cos(a) + ux * Math.sin(a), y: ny * Math.cos(a) + uy * Math.sin(a) },
      runPx: score[i],
      angleDeg: ang[i],
    });
  }
  return peaks;
}

// ── 재투영 도색지지(P1) ─────────────────────────────────────────────
/**
 * 도색 마스크의 **거리변환**(각 화소 → 가장 가까운 도색 화소까지의 거리, px).
 *
 * 왜 필요한가(리더 루프1 진단): 지금까지의 구속(소실점 수렴·등간격·f범위·폭편차·지상고)은 전부
 * 격자의 **내부 일관성**만 본다. 격자를 통째로 5m 뒤나 옆 행으로 옮겨도 똑같이 만족되므로,
 * 평행한 다른 도색선을 근변으로 오인해도 걸러지지 않았다(2:2 실측: 참 근변선이 rank1·0.07px 인데 IoU 0).
 * **산출한 quad 를 이미지로 되돌려 도색을 실제로 덮는지 묻는 것**이 빠진 유일한 구속이다.
 *
 * 2-pass 체임퍼(3-4 근사). 정확한 유클리드가 아니지만 단조·결정론이며 임계 판정에 충분하다. 난수 0.
 */
export function distanceTransform(mask: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const A = 1;
  const B = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      if (y > 0) v = Math.min(v, d[i - W] + A);
      if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + B);
      if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + B);
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1) v = Math.min(v, d[i + 1] + A);
      if (y < H - 1) v = Math.min(v, d[i + W] + A);
      if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + B);
      if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + B);
      d[i] = v;
    }
  }
  return d;
}

/** 프레임 1장분 도색 증거(거리변환 + 크기). 검출·기하 모듈이 재투영 검증에 쓴다. */
export interface PaintEvidence {
  dist: Float32Array;
  width: number;
  height: number;
}

export function paintEvidenceOf(mask: Uint8Array, width: number, height: number): PaintEvidence {
  return { dist: distanceTransform(mask, width, height), width, height };
}

/** 변 1개의 도색 지지도. */
export interface EdgeSupport {
  /** 도색까지의 거리가 허용치 이내인 표본 비율(0~1). 프레임 밖 표본은 **미검출로 센다**. */
  hitRatio: number;
  /** 표본별 도색까지 거리의 median(px). 프레임 밖은 상한값. */
  chamferPx: number;
  /** 프레임 안에 들어온 표본 수. */
  inFrame: number;
  samples: number;
}

/**
 * 선분이 도색 마스크를 얼마나 덮는가. **이미지 증거만** 쓴다(수동 ROI 무관 — R1).
 *
 * 양 끝 `endTrimRatio` 구간은 건너뛴다 — 코너는 두 도색선의 교차점이라 어느 변에 속하는지 모호하다.
 */
export function edgePaintSupport(
  ev: PaintEvidence,
  A: { x: number; y: number },
  B: { x: number; y: number },
  opts: PaintOptions,
): EdgeSupport {
  const n = opts.supportSamples;
  const cap = opts.supportSearchPx;
  const dists: number[] = [];
  let hit = 0;
  let inFrame = 0;
  for (let s = 0; s < n; s++) {
    const t = opts.endTrimRatio + ((1 - 2 * opts.endTrimRatio) * s) / (n - 1);
    const x = Math.round(A.x + (B.x - A.x) * t);
    const y = Math.round(A.y + (B.y - A.y) * t);
    if (x < 0 || y < 0 || x >= ev.width || y >= ev.height) {
      dists.push(cap);
      continue;
    }
    inFrame++;
    const d = Math.min(cap, ev.dist[y * ev.width + x]);
    dists.push(d);
    if (d <= opts.paintTolPx) hit++;
  }
  dists.sort((p, q) => p - q);
  return {
    hitRatio: hit / n,
    chamferPx: dists.length % 2 ? dists[(dists.length - 1) / 2] : (dists[dists.length / 2 - 1] + dists[dists.length / 2]) / 2,
    inFrame,
    samples: n,
  };
}

/**
 * 방향탐색 피크 → 서브픽셀 정련 직선. 정련 실패 시 시드 직선을 그대로 쓴다(강등, throw 금지).
 * 반환 순서는 입력 순서(= 전방선 위 위치 오름차순) 그대로다.
 */
export function refineSeparators(
  frame: FrameGray,
  peaks: readonly SeparatorPeak[],
  opts: PaintOptions,
): RefinedLine[] {
  const out: RefinedLine[] = [];
  for (const pk of peaks) {
    const seed = normalizeLine([pk.d.y, -pk.d.x, -(pk.d.y * pk.p.x - pk.d.x * pk.p.y)]);
    if (!seed) continue;
    const px0 = -seed[2] * seed[0];
    const py0 = -seed[2] * seed[1];
    const dx = -seed[1];
    const dy = seed[0];
    const proj = (q: { x: number; y: number }): number => (q.x - px0) * dx + (q.y - py0) * dy;
    const end = opts.scanStartPx + Math.min(opts.scanEndPx, pk.runPx);
    const ta = proj({ x: pk.p.x + pk.d.x * opts.scanStartPx, y: pk.p.y + pk.d.y * opts.scanStartPx });
    const tb = proj({ x: pk.p.x + pk.d.x * end, y: pk.p.y + pk.d.y * end });
    // 전방선 도색이 프로파일에 섞이지 않도록 좁은 창으로 정련한다(교차 지점 편향 제거).
    const r = refineLine(frame, seed, { ...opts, profileHalfPx: opts.separatorProfileHalfPx }, {
      tmin: Math.min(ta, tb),
      tmax: Math.max(ta, tb),
      px0,
      py0,
      dx,
      dy,
    });
    if (r) {
      out.push(r);
      continue;
    }
    out.push({
      line: seed,
      residPx: Number.POSITIVE_INFINITY,
      hit: 0,
      widthPx: 0,
      contrast: 0,
      spanPx: pk.runPx,
      endA: { x: pk.p.x, y: pk.p.y },
      endB: { x: pk.p.x + pk.d.x * end, y: pk.p.y + pk.d.y * end },
      votes: 0,
    });
  }
  return out;
}
