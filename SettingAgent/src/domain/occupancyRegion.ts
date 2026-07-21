// 점유영역(번호판 기준 사다리꼴) 생성 — **독립 사용 가능한 순수 모듈**.
// 외부(라우트·잡·MCP 도구·타 에이전트)에서 quad 배열만 넘기면 점유영역 폴리곤을 얻는다.
// DB/HTTP/파일/DOM 의존 0, 난수·시각 0(결정형).
//
// ★ 정본은 뷰어(web/occupancyRegion.js)가 라이브 오버레이에 쓰는 **기존 방법** 그대로다.
//   서버가 브라우저 ESM 을 import 할 수 없어(정적 배포 경계) 같은 알고리즘을 TS 로 옮겼고,
//   test/occupancyRegionParity.test.ts 가 두 구현의 출력 동일성을 강제한다(정의 갈림 방지).
//   기하 프리미티브는 신규 발명하지 않고 src/domain/polygon.ts 를 재사용한다.

import type { NormalizedPoint, NormalizedQuad } from './types.js';
import { clipByHalfPlane, convexIntersectionArea, polygonArea } from './polygon.js';

const DEGEN_EPS = 1e-9; // 축 벡터 퇴화 판정(0-길이 엣지).

/** 사다리꼴 형상·겹침해소 파라미터(web/occupancyRegion.js DEFAULTS 와 동일 값). */
export interface RegionConfig {
  /** 배율 하한(번호판 폭 대비 아래변 폭). */
  widthScaleMin: number;
  /** 배율 상한. */
  widthScaleMax: number;
  /** 위변/아래변 폭 비(1.0 = 평행사변형). */
  topWidthRatio: number;
  /** 중심에서 위(−v̂)로 뻗는 길이 = upRatio × 아래변 폭. */
  upRatio: number;
  /** 중심에서 아래(+v̂)로 뻗는 길이 = downRatio × 아래변 폭. */
  downRatio: number;
  scaleQuantum: number;
  areaEps: number;
  shrinkFactor: number;
  maxShrinkIters: number;
  minScale: number;
}

export const REGION_DEFAULTS: RegionConfig = {
  widthScaleMin: 3.5,
  widthScaleMax: 4.0,
  topWidthRatio: 1.0,
  upRatio: 0.9,
  downRatio: 0.6,
  scaleQuantum: 0.05,
  areaEps: 1e-6,
  shrinkFactor: 0.9,
  maxShrinkIters: 20,
  minScale: 1.0,
};

const BINARY_ITERS = 12; // 전역 배율 이진탐색 고정 반복수.

export interface PlateAxes {
  c: NormalizedPoint;
  u: NormalizedPoint;
  v: NormalizedPoint;
  width: number;
}

export interface RegionItem {
  /** 슬롯 식별자(전역 slot_id 등). 출력에 그대로 실린다. */
  idx: number;
  /** 번호판 OBB quad(4점). */
  quad: NormalizedQuad;
}

export interface RegionResult {
  regions: Array<{ idx: number; scale: number; polygon: NormalizedPoint[] }>;
  globalScale: number | null;
  overlapPairs: Array<[number, number]>;
}

function withDefaults(cfg?: Partial<RegionConfig>): RegionConfig {
  return { ...REGION_DEFAULTS, ...(cfg ?? {}) };
}

/** 4점 quad 의 산술 평균 중심. 비4점·비수치 → null(throw 금지). */
function quadCentroid4(quad: unknown): NormalizedPoint | null {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  let sx = 0;
  let sy = 0;
  for (const p of quad) {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return null;
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / 4, y: sy / 4 };
}

/**
 * 번호판 quad → 중심·단위 가로(û)/세로(v̂)축·폭.
 * 축은 대변 평균 엣지 방향이며 **장축을 û(가로)** 로 잡는다(LPD OBB 라벨 순환 회전에 불변 —
 * 번호판은 실물 가로가 항상 길다). 축 교체 시 û 를 반전해 입력 quad 의 핸디드니스를 보존하고,
 * v̂ 는 항상 화면 아래(+y)를 향하도록 부호 정규화한다. 퇴화 입력 → null.
 */
export function plateAxes(quad: NormalizedQuad | null | undefined): PlateAxes | null {
  const c = quadCentroid4(quad);
  if (!c || !quad) return null;
  const [tl, tr, br, bl] = quad;
  const a = {
    x: (tr.x - tl.x + (br.x - bl.x)) / 2,
    y: (tr.y - tl.y + (br.y - bl.y)) / 2,
    width: (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2,
  };
  const b = {
    x: (bl.x - tl.x + (br.x - tr.x)) / 2,
    y: (bl.y - tl.y + (br.y - tr.y)) / 2,
    width: (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2,
  };
  const al = Math.hypot(a.x, a.y);
  const bl2 = Math.hypot(b.x, b.y);
  if (al < DEGEN_EPS || bl2 < DEGEN_EPS) return null;
  const swapped = bl2 > al; // 장축이 b 쪽 → 라벨이 순환 회전된 입력.
  const uc = swapped ? b : a;
  const vc = swapped ? a : b;
  const ul = swapped ? bl2 : al;
  const vl = swapped ? al : bl2;
  const flip = vc.y < 0 ? -1 : 1;
  const usign = swapped ? -flip : flip;
  return {
    c,
    u: { x: (uc.x / ul) * usign, y: (uc.y / ul) * usign },
    v: { x: (vc.x / vl) * flip, y: (vc.y / vl) * flip },
    width: uc.width,
  };
}

/**
 * 축·배율 → 사다리꼴 4점 [TL,TR,BR,BL](미클램프).
 * 위/아래 변 ∥ û(번호판 가로와 평행), 좌우 ∥ v̂, upRatio > downRatio → 위가 길다.
 */
export function buildTrapezoid(axes: PlateAxes, scale: number, cfg?: Partial<RegionConfig>): NormalizedPoint[] {
  const { topWidthRatio, upRatio, downRatio } = withDefaults(cfg);
  const { c, u, v, width } = axes;
  const bw = scale * width; // 아래 변 전체 폭(배율 기준변).
  const tw = topWidthRatio * bw;
  const ct = { x: c.x - upRatio * bw * v.x, y: c.y - upRatio * bw * v.y }; // −v̂ = 화면 위.
  const cb = { x: c.x + downRatio * bw * v.x, y: c.y + downRatio * bw * v.y };
  return [
    { x: ct.x - (tw / 2) * u.x, y: ct.y - (tw / 2) * u.y },
    { x: ct.x + (tw / 2) * u.x, y: ct.y + (tw / 2) * u.y },
    { x: cb.x + (bw / 2) * u.x, y: cb.y + (bw / 2) * u.y },
    { x: cb.x - (bw / 2) * u.x, y: cb.y - (bw / 2) * u.y },
  ];
}

// 단위 정사각형 4개 내향 반평면(x≥0, x≤1, y≥0, y≤1).
const UNIT_HALF_PLANES = [
  { p0: { x: 0, y: 0 }, n: { x: 1, y: 0 } },
  { p0: { x: 1, y: 0 }, n: { x: -1, y: 0 } },
  { p0: { x: 0, y: 0 }, n: { x: 0, y: 1 } },
  { p0: { x: 0, y: 1 }, n: { x: 0, y: -1 } },
];

/** 다각형을 이미지 경계(단위 정사각형)로 클립. 전부 잘리면 []. */
export function clampToUnit(poly: readonly NormalizedPoint[]): NormalizedPoint[] {
  let out: NormalizedPoint[] = [...poly];
  for (const line of UNIT_HALF_PLANES) {
    out = clipByHalfPlane(out, line);
    if (out.length === 0) return [];
  }
  return out;
}

/**
 * 번호판 quad 목록 → 서로 겹치지 않는 점유영역 폴리곤(순수·결정형).
 * 1단계: 전역 단일 배율 이진탐색 [min,max] → 2단계(하한에서도 겹침): 겹치는 쌍만 개별 축소.
 * 잔존 겹침은 숨기지 않고 overlapPairs 로 보고한다.
 */
export function computeOccupancyRegions(items: RegionItem[], cfg?: Partial<RegionConfig>): RegionResult {
  const c = withDefaults(cfg);
  const entries = (Array.isArray(items) ? items : [])
    .map((it) => ({ idx: it?.idx, axes: plateAxes(it?.quad) }))
    .filter((e): e is { idx: number; axes: PlateAxes } => e.axes !== null && typeof e.idx === 'number')
    .sort((a, b) => a.idx - b.idx);

  const regionAt = (e: { axes: PlateAxes }, s: number) => clampToUnit(buildTrapezoid(e.axes, s, c));

  const anyOverlap = (s: number): boolean => {
    const polys = entries.map((e) => regionAt(e, s));
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        if (convexIntersectionArea(polys[i], polys[j]) > c.areaEps) return true;
      }
    }
    return false;
  };

  const pack = (scales: number[], globalScale: number | null, overlapPairs: Array<[number, number]>): RegionResult => ({
    regions: entries
      .map((e, i) => ({ idx: e.idx, scale: scales[i], polygon: regionAt(e, scales[i]) }))
      .filter((g) => g.polygon.length >= 3 && polygonArea(g.polygon) > 0),
    globalScale,
    overlapPairs,
  });

  // ── 1단계: 전역 이진탐색 ──
  if (!anyOverlap(c.widthScaleMax)) {
    return pack(entries.map(() => c.widthScaleMax), c.widthScaleMax, []);
  }
  if (!anyOverlap(c.widthScaleMin)) {
    let lo = c.widthScaleMin; // 불변식: lo 비겹침, hi 겹침.
    let hi = c.widthScaleMax;
    for (let k = 0; k < BINARY_ITERS; k++) {
      const mid = (lo + hi) / 2;
      if (anyOverlap(mid)) hi = mid;
      else lo = mid;
    }
    const snapped = Math.max(Math.floor(lo / c.scaleQuantum) * c.scaleQuantum, c.widthScaleMin);
    return pack(entries.map(() => snapped), snapped, []);
  }

  // ── 2단계: 인스턴스별 shrink-to-fit(전역 하한에서도 겹칠 때만) ──
  const overlappingPairs = (scales: number[]): Array<[number, number]> => {
    const polys = entries.map((e, i) => regionAt(e, scales[i]));
    const out: Array<[number, number]> = [];
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        if (convexIntersectionArea(polys[i], polys[j]) > c.areaEps) out.push([i, j]);
      }
    }
    return out;
  };

  const scales = entries.map(() => c.widthScaleMin);
  let pairs = overlappingPairs(scales);
  for (let k = 0; k < c.maxShrinkIters && pairs.length > 0; k++) {
    for (const [i, j] of pairs) {
      scales[i] = Math.max(c.minScale, scales[i] * c.shrinkFactor);
      scales[j] = Math.max(c.minScale, scales[j] * c.shrinkFactor);
    }
    pairs = overlappingPairs(scales);
  }
  return pack(scales, null, pairs.map(([i, j]) => [entries[i].idx, entries[j].idx] as [number, number]));
}

/**
 * **외부 사용 진입점** — 슬롯별 번호판 quad → 슬롯별 점유영역 폴리곤 Map.
 * 겹침 회피 배율 탐색이 프레임(프리셋) 단위 집합 연산이므로 **같은 프리셋의 판을 한 번에** 넘겨야 한다.
 * quad 가 퇴화했거나 영역이 전부 화면 밖인 슬롯은 Map 에서 빠진다(위장 생성 금지).
 */
export function buildOccupyRegionsBySlot(
  plates: Array<{ slotId: number; quad: NormalizedQuad }>,
  cfg?: Partial<RegionConfig>,
): Map<number, NormalizedPoint[]> {
  const { regions } = computeOccupancyRegions(
    plates.map((p) => ({ idx: p.slotId, quad: p.quad })),
    cfg,
  );
  return new Map(regions.map((r) => [r.idx, r.polygon]));
}
