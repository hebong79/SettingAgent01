// 점유영역 사다리꼴 생성(순수, 환경 비의존 — DOM/fetch/state 미참조).
// 번호판 quad 의 중심·축을 기준으로 상하좌우 사다리꼴 4점을 만들고, 영역끼리 겹치지 않는
// 최대 가로배율을 런타임 탐색 루프로 찾는다(설계 §2~§3).
//
// 기하 프리미티브는 신규 발명하지 않고 재사용한다:
//   ./occupancy.js — clipByHalfPlane / convexIntersectionArea / polygonArea
//   ./core.js      — quadCentroid (judge center 와 동일 정의)

import { clipByHalfPlane, convexIntersectionArea, polygonArea } from './occupancy.js';
import { quadCentroid } from './core.js';

const DEGEN_EPS = 1e-9; // 축 벡터 퇴화 판정(0-길이 엣지).

/** RegionConfig 기본값(설계 §2-3). UI 노출 없음 — 코드 기본값만. */
const DEFAULTS = {
  widthScaleMin: 3.5,
  widthScaleMax: 4.0,
  topWidthRatio: 1.0, // 1.0 = 평행사변형(마스터 지시). 번호판은 수직면이라 위(−v̂)는 먼 쪽이 아니라 높은 쪽 → 원근 수축 근거 없음.
  upRatio: 0.90,
  downRatio: 0.60,
  scaleQuantum: 0.05,
  areaEps: 1e-6,
  shrinkFactor: 0.9,
  maxShrinkIters: 20,
  minScale: 1.0,
};

const BINARY_ITERS = 12; // 전역 배율 이진탐색 고정 반복수(§3-3).

/** cfg 부분 지정 → 기본값 병합. */
function withDefaults(cfg) {
  return { ...DEFAULTS, ...(cfg ?? {}) };
}

/**
 * 번호판 quad([TL,TR,BR,BL]) → 중심·단위 가로/세로축·폭(설계 §2-1).
 * 축은 대변 평균 엣지 방향(bilinear 중심 접선) — 단일 엣지 대비 OBB 정점 잡음이 절반으로 평균화된다.
 *
 * **장축 채택**: 두 대변 평균 벡터 중 **긴 쪽을 û(가로)** 로 잡는다. LPD(ultralytics OBB)는 4점을
 * 박스 자체 회전 순서로 내므로 라벨이 순환 회전([TL,TR,BR,BL]→[TR,BR,BL,TL] 등)돼 들어올 수 있고,
 * TL→TR 을 무조건 가로로 믿으면 축이 90° 돌아간다(실측: cam1_p2 전수). 번호판은 실물 가로가 항상
 * 길어(한국 규격 약 520×110mm ≈ 4.7:1) 장축 = 가로가 성립한다 → 순환 회전에 불변.
 * 볼록성·인접성이 깨진 입력(대각선 순서)까지는 다루지 않는다 — 계약 밖.
 *
 * 축 교체 시 두 기저를 맞바꾸면 핸디드니스가 뒤집히므로 û 를 반전해 **입력 quad 자신의 핸디드니스를
 * 복원**한다(절대 부호를 강제하지 않음 — 실 LPD quad 는 cross(û,v̂)<0 규약이라 상수 가드는 오작동).
 * v̂ 는 항상 화면 아래(+y)를 향하도록 부호 정규화(180° 반전 검출 대비, û 동시 반전으로 핸디드니스 보존).
 * 퇴화(비4점/0-길이 엣지) 시 null — throw 금지(강등 철학).
 * @param {Array<{x:number,y:number}>|null|undefined} quad
 * @returns {{ c:{x:number,y:number}, u:{x:number,y:number}, v:{x:number,y:number}, width:number }|null}
 */
export function plateAxes(quad) {
  const c = quadCentroid(quad); // 비4점·좌표 비수치 검증 포함.
  if (!c) return null;
  const [tl, tr, br, bl] = quad;
  // 두 대변 평균 벡터 후보 — a: TL→TR·BL→BR 축, b: TL→BL·TR→BR 축. width 는 각 축의 평균 엣지 길이.
  const a = {
    x: ((tr.x - tl.x) + (br.x - bl.x)) / 2,
    y: ((tr.y - tl.y) + (br.y - bl.y)) / 2,
    width: (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2,
  };
  const b = {
    x: ((bl.x - tl.x) + (br.x - tr.x)) / 2,
    y: ((bl.y - tl.y) + (br.y - tr.y)) / 2,
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
  const flip = vc.y < 0 ? -1 : 1; // v̂ 가 화면 위를 향하면 두 축 동시 반전.
  const usign = swapped ? -flip : flip; // 교체 시 û 반전 → 입력 핸디드니스 복원.
  return {
    c,
    u: { x: (uc.x / ul) * usign, y: (uc.y / ul) * usign },
    v: { x: (vc.x / vl) * flip, y: (vc.y / vl) * flip },
    width: uc.width,
  };
}

/**
 * 축·배율 → 사다리꼴 4점 [TL,TR,BR,BL](미클램프, 설계 §2-2). topWidthRatio 기본 1.0 → 실제 형상은
 * 평행사변형(사다리꼴의 특수형); 비-1.0 을 cfg 로 주면 일반 사다리꼴이 된다.
 * 위/아래 변 ∥ û(가로 수평), 중심축(Ct↔Cb) ∥ v̂(세로 수평), upRatio > downRatio → 위가 김.
 * @param {{ c:{x:number,y:number}, u:{x:number,y:number}, v:{x:number,y:number}, width:number }} axes
 * @param {number} scale
 * @param {object} [cfg]
 * @returns {Array<{x:number,y:number}>}
 */
export function buildTrapezoid(axes, scale, cfg) {
  const { topWidthRatio, upRatio, downRatio } = withDefaults(cfg);
  const { c, u, v, width } = axes;
  const bw = scale * width; // 아래 변 전체 폭(배율 기준변).
  const tw = topWidthRatio * bw; // 위 변 전체 폭.
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

/**
 * 다각형을 이미지 경계(단위 정사각형)로 클립(설계 §2-4). 전부 잘리면 [].
 * @param {Array<{x:number,y:number}>} poly
 * @returns {Array<{x:number,y:number}>}
 */
export function clampToUnit(poly) {
  let out = poly;
  for (const line of UNIT_HALF_PLANES) {
    out = clipByHalfPlane(out, line);
    if (out.length === 0) return [];
  }
  return out;
}

/**
 * plate 점유분의 겹침 없는 사다리꼴 영역 계산(설계 §3). 순수·결정적 — 난수/시각/상태 없음.
 * 1단계: 전역 단일 배율 이진탐색 [min,max] → 2단계(하한에서도 겹침): 겹치는 쌍만 개별 축소.
 * @param {Array<{ idx:number, quad:Array<{x:number,y:number}> }>} items
 * @param {object} [cfg]
 * @returns {{ regions:Array<{idx:number,scale:number,polygon:Array<{x:number,y:number}>}>, globalScale:number|null, overlapPairs:Array<[number,number]> }}
 */
export function computeOccupancyRegions(items, cfg) {
  const c = withDefaults(cfg);
  // 퇴화 인스턴스는 모집단에서 제외. idx 오름차순 고정 → 쌍 순회 결정성(§3-3).
  const entries = (Array.isArray(items) ? items : [])
    .map((it) => ({ idx: it?.idx, axes: plateAxes(it?.quad) }))
    .filter((e) => e.axes !== null && typeof e.idx === 'number')
    .sort((a, b) => a.idx - b.idx);

  const regionAt = (e, s) => clampToUnit(buildTrapezoid(e.axes, s, c));

  /** 배율 s(전역)에서 겹치는 쌍이 하나라도 있는가. */
  const anyOverlap = (s) => {
    const polys = entries.map((e) => regionAt(e, s));
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        if (convexIntersectionArea(polys[i], polys[j]) > c.areaEps) return true;
      }
    }
    return false;
  };

  const pack = (scales, globalScale, overlapPairs) => ({
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
    // 그리드 내림(축소 방향 → 비겹침 유지) 후 하한 클램프.
    const snapped = Math.max(Math.floor(lo / c.scaleQuantum) * c.scaleQuantum, c.widthScaleMin);
    return pack(entries.map(() => snapped), snapped, []);
  }

  // ── 2단계: 인스턴스별 shrink-to-fit(전역 하한에서도 겹칠 때만) ──
  /** 현재 배율에서 겹치는 (i,j) 전부 — i<j, idx 순 결정적 순회. */
  const overlappingPairs = (scales) => {
    const polys = entries.map((e, i) => regionAt(e, scales[i]));
    const out = [];
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
    pairs = overlappingPairs(scales); // 축소 후 재판정 → 잔존 겹침만 보고.
  }
  // 잔존 겹침은 숨기지 않고 idx 쌍으로 보고(표시는 유지) — R1 위반을 드러낸다.
  return pack(scales, null, pairs.map(([i, j]) => [entries[i].idx, entries[j].idx]));
}
