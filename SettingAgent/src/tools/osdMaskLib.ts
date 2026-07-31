// ★ 26회차 26-2 — `osdMaskDiag.ts` 의 **순수 함수부**(자막 영역 검출 · 경계 없는 채움 · 기하 판정).
//
// 실행부(`osdMaskDiag.ts`)는 최상위에서 즉시 돌기 때문에 테스트가 import 할 수 없다.
// 그래서 **부작용 없는 함수만** 이 모듈로 분리해 `test/osdMaskDiagWiring.test.ts` 가 직접 검증한다.
// 여기에는 파일 I/O·카메라 호출·정답지 접근이 **하나도 없다**(테스트가 소스 문자열로 봉인한다).

import type { BayQuad } from '../ground/bayGeometry.js';
import type { FrameGray } from '../ground/floorPaint.js';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OsdFind {
  box: Box | null;
  glyphs: number;
  candidates: number;
  groups: number;
  /** 채택된 글줄의 글리프 bbox 목록(스샷 표시용) */
  glyphBoxes: Box[];
}
export interface LineRec {
  thetaDeg: number;
  rho: number;
  votes: number;
  line: [number, number, number];
}

// ── 자막 영역 검출 파라미터 ─────────────────────────────────────────────
// 값의 출처: 1920×1080 야간 프레임 6장을 육안으로 열어 OSD 글리프(`332/7/x5` 류)의 크기를 잰 값에
// 여유를 준 **범위**다. 고정 좌표가 아니라 **크기·밝기 범위**이므로 자막이 어디에 있든 찾는다.
// (글리프 높이 실측 약 30px, 획 폭 약 6px, 문자당 폭 약 20px @1080p)
export const OSD = {
  glyphHMin: 12,
  glyphHMax: 60,
  glyphWMin: 3,
  glyphWMax: 60,
  areaMin: 20,
  areaMax: 2000,
  /** 획 절대 밝기 하한 — OSD 는 번인 오버레이라 장면보다 훨씬 밝다. */
  meanGrayMin: 140,
  /** 획 밝기 **균일성** — 렌더된 글자는 상수 값이라 표준편차가 작다(장면 하이라이트는 크다). */
  stdGrayMax: 45,
  /** 조각 병합: 가로 간격 ≤ 이 값이고 세로도 가까우면 **한 글자의 조각**으로 본다(능선 마스크는 획을 쪼갠다). */
  mergeGapXPx: 5,
  mergeGapYPx: 8,
  /** 같은 글줄 판정: 가로 간격 ≤ max(글자높이)×이 값 */
  lineGapRatio: 1.5,
  /** 글줄로 인정할 최소 글리프 수 */
  minGlyphs: 4,
  /** 박스 여유(안티에일리어싱·그림자 획까지 덮기) */
  padPx: 8,
} as const;

/** 8-연결 성분. `mask` 는 `paintMask` 산출(도색 검출기가 실제로 보는 픽셀 집합). */
export function components(mask: Uint8Array, W: number, H: number): Array<{ box: Box; area: number; idx: number[] }> {
  const seen = new Uint8Array(W * H);
  const out: Array<{ box: Box; area: number; idx: number[] }> = [];
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    const idx: number[] = [];
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    while (sp > 0) {
      const i = stack[--sp];
      idx.push(i);
      const x = i % W;
      const y = (i - x) / W;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const j = ny * W + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack[sp++] = j;
          }
        }
      }
      // 성분이 비정상적으로 커지면(글레어 등) 더 안 키운다 — 어차피 글리프 조건에서 탈락.
      if (idx.length > 20000) break;
    }
    out.push({ box: { x0, y0, x1, y1 }, area: idx.length, idx });
  }
  return out;
}

/**
 * ★ 이미지에서 자막을 찾는다 — 정답지 무접촉.
 *
 * 근거 4가지(모두 이미지 성질):
 *   ① OSD 획은 `paintMask` 에 들어오는 **고휘도 능선**이다(검출기가 보는 바로 그 마스크를 재사용).
 *   ② 획 밝기가 **균일**하다(렌더된 글자 = 상수 값) — 장면의 밝은 물체는 그렇지 않다.
 *   ③ 성분 크기가 **글리프 크기**다(수십 px). 도색선은 수백 px 로 길어 폭 조건에서 탈락한다.
 *   ④ 4자 이상이 **한 글줄**(세로 범위가 겹치고 가로로 이어짐)로 늘어선다 — 장면 잡음은 이 배열을 만들지 않는다.
 * 능선 마스크는 한 글자를 위·아래 조각으로 쪼개므로 **조각 병합**을 먼저 한다(EV4 실측에서 확인된 결함).
 * 한계: 자막이 1~3자뿐이거나 장면과 대비가 낮으면 못 찾는다(못 찾으면 `box:null` 로 정직히 보고).
 */
export function findOsdBox(frame: FrameGray, mask: Uint8Array): OsdFind {
  const { data: g, width: W, height: H } = frame;
  const comps = components(mask, W, H);
  // ① 밝고 균일하며 글리프 크기 이하인 조각만 남긴다(긴 도색선은 폭/면적에서 탈락).
  const frags: Box[] = [];
  for (const c of comps) {
    const w = c.box.x1 - c.box.x0 + 1;
    const h = c.box.y1 - c.box.y0 + 1;
    if (h > OSD.glyphHMax || w > OSD.glyphWMax || c.area > OSD.areaMax) continue;
    if (c.area < 3) continue;
    let sum = 0;
    let sum2 = 0;
    for (const i of c.idx) {
      sum += g[i];
      sum2 += g[i] * g[i];
    }
    const mean = sum / c.area;
    if (mean < OSD.meanGrayMin) continue;
    if (Math.sqrt(Math.max(0, sum2 / c.area - mean * mean)) > OSD.stdGrayMax) continue;
    frags.push(c.box);
  }
  // ② 한 글자의 조각 병합 — 가로/세로로 가까운 상자를 반복 합친다.
  const near = (a: Box, b: Box): boolean =>
    Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) <= OSD.mergeGapXPx && Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) <= OSD.mergeGapYPx;
  const blobs = frags.map((b) => ({ ...b }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < blobs.length && !changed; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        if (!near(blobs[i], blobs[j])) continue;
        blobs[i] = {
          x0: Math.min(blobs[i].x0, blobs[j].x0),
          y0: Math.min(blobs[i].y0, blobs[j].y0),
          x1: Math.max(blobs[i].x1, blobs[j].x1),
          y1: Math.max(blobs[i].y1, blobs[j].y1),
        };
        blobs.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  // ③ 병합 후 글리프 크기인 것만 글자로 인정.
  const glyphs = blobs
    .filter((b) => {
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      return h >= OSD.glyphHMin && h <= OSD.glyphHMax && w >= OSD.glyphWMin && w <= OSD.glyphWMax;
    })
    .sort((a, b) => a.x0 - b.x0);
  if (!glyphs.length) return { box: null, glyphs: 0, candidates: comps.length, groups: 0, glyphBoxes: [] };

  // ④ 글줄 묶기 — **세로 범위가 겹치고** 가로 간격이 글자높이 이내면 같은 줄.
  const groups: Array<{ items: Box[]; y0: number; y1: number; x1: number }> = [];
  for (const q of glyphs) {
    const h = q.y1 - q.y0 + 1;
    let placed = false;
    for (const gr of groups) {
      const gh = gr.y1 - gr.y0 + 1;
      const overlap = Math.min(gr.y1, q.y1) - Math.max(gr.y0, q.y0);
      if (overlap <= 0) continue;
      if (q.x0 - gr.x1 > Math.max(h, gh) * OSD.lineGapRatio) continue;
      gr.items.push(q);
      gr.y0 = Math.min(gr.y0, q.y0);
      gr.y1 = Math.max(gr.y1, q.y1);
      gr.x1 = Math.max(gr.x1, q.x1);
      placed = true;
      break;
    }
    if (!placed) groups.push({ items: [q], y0: q.y0, y1: q.y1, x1: q.x1 });
  }
  let best: Box[] | null = null;
  for (const gr of groups) if (gr.items.length >= OSD.minGlyphs && (!best || gr.items.length > best.length)) best = gr.items;
  if (!best) return { box: null, glyphs: glyphs.length, candidates: comps.length, groups: groups.length, glyphBoxes: [] };
  const box: Box = {
    x0: Math.max(0, Math.min(...best.map((q) => q.x0)) - OSD.padPx),
    y0: Math.max(0, Math.min(...best.map((q) => q.y0)) - OSD.padPx),
    x1: Math.min(W - 1, Math.max(...best.map((q) => q.x1)) + OSD.padPx),
    y1: Math.min(H - 1, Math.max(...best.map((q) => q.y1)) + OSD.padPx),
  };
  return { box, glyphs: glyphs.length, candidates: comps.length, groups: groups.length, glyphBoxes: best };
}

/**
 * ★ Coons(전유한) 보간 채움 — 박스 내부를 **테두리 바로 바깥 값**으로 매끄럽게 잇는다.
 * 경계에서 값이 이웃 픽셀과 정확히 일치하므로 **계단 경계(사각 테두리)를 만들지 않는다**.
 * 원본 픽셀은 박스 밖에서 비트 불변.
 */
export function coonsFill(src: Uint8Array, W: number, H: number, box: Box): Uint8Array {
  const dst = new Uint8Array(src);
  const { x0, y0, x1, y1 } = box;
  const L = Math.max(0, x0 - 1);
  const R = Math.min(W - 1, x1 + 1);
  const T = Math.max(0, y0 - 1);
  const B = Math.min(H - 1, y1 + 1);
  const nx = R - L;
  const ny = B - T;
  if (!(nx > 0) || !(ny > 0)) return dst;
  const TL = src[T * W + L];
  const TR = src[T * W + R];
  const BL = src[B * W + L];
  const BR = src[B * W + R];
  for (let y = y0; y <= y1; y++) {
    const v = (y - T) / ny;
    const Lv = src[y * W + L];
    const Rv = src[y * W + R];
    for (let x = x0; x <= x1; x++) {
      const u = (x - L) / nx;
      const Tv = src[T * W + x];
      const Bv = src[B * W + x];
      const val =
        (1 - u) * Lv + u * Rv + (1 - v) * Tv + v * Bv -
        ((1 - u) * (1 - v) * TL + u * (1 - v) * TR + (1 - u) * v * BL + u * v * BR);
      dst[y * W + x] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }
  return dst;
}

/** 수평 미러 박스(같은 크기·같은 y, 자막이 없는 위치). */
export function mirrorBox(b: Box, W: number): Box {
  return { x0: W - 1 - b.x1, y0: b.y0, x1: W - 1 - b.x0, y1: b.y1 };
}

export function segCross(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }): boolean {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export function ptInPoly(p: { x: number; y: number }, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) inside = !inside;
  }
  return inside;
}
/** ★ 4각형이 박스와 **겹치는가** — 가설이 실제로 예측하는 양(「자막 위의 가짜 면」)을 세기 위한 판정. */
export function quadOverlapsBox(q: BayQuad, box: Box): boolean {
  const bp = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ];
  for (const p of q.quad) if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) return true;
  for (const p of bp) if (ptInPoly(p, q.quad)) return true;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (segCross(q.quad[i], q.quad[(i + 1) % 4], bp[j], bp[(j + 1) % 4])) return true;
  return false;
}

/** 직선이 박스 내부를 지나는가 — 4모서리의 부호가 갈리면 관통, 아니면 최소 |거리|가 0 초과. */
export function lineCrossesBox(l: [number, number, number], box: Box): boolean {
  const s = [
    l[0] * box.x0 + l[1] * box.y0 + l[2],
    l[0] * box.x1 + l[1] * box.y0 + l[2],
    l[0] * box.x1 + l[1] * box.y1 + l[2],
    l[0] * box.x0 + l[1] * box.y1 + l[2],
  ];
  return Math.min(...s) <= 0 && Math.max(...s) >= 0;
}

/** 직선이 박스 4변 중 어느 변을 타는가 — 변을 21점 샘플링해 평균 |거리|의 최솟값(px). */
export function edgeDistPx(l: [number, number, number], box: Box): number {
  const corners: Array<[number, number]> = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  let best = Infinity;
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = corners[e];
    const [bx, by] = corners[(e + 1) % 4];
    let s = 0;
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      s += Math.abs(l[0] * x + l[1] * y + l[2]);
    }
    best = Math.min(best, s / 21);
  }
  return best;
}

