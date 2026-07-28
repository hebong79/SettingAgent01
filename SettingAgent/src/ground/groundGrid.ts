// 지면 격자(미터, 프리셋 무관) + 순수 변환 — L3 Loop 2.
// 좌표는 GroundFrame(a,b) 기준. 투영 수학은 project.ts::projectToPixel 만 쓴다(신규 투영 수학 0줄).
//
// ★ 함정1(리더 실측): colPitchM 은 **슬롯 폭(2.5m)** 이다. 슬롯은 폭 방향으로 반복된다.
//     깊이(5.0m)로 잡으면 인접 슬롯이 반칸 어긋나 IoU 가 1/0 으로 교대한다(실측 평균 0.5714).
// ★ 함정2(리더 실측): 행(row)은 **다른 주차열**이다. 단일 행 가정 금지 — (row,col) 2D 인덱스가 필수.
// ★ 함정3(리더 실측): 폭/깊이 축 판정은 **지면 실측 스팬(미터)** 으로 한다. 픽셀 길이 판정 금지
//     (투영단축 때문에 틀린다 — groundModel.ts §4-6 과 동일 원칙).
//
// ★★ 구현 중 실측으로 드러난 한계(설계 §7 Loop 3-1 이 지시한 '단일 격자 가정 붕괴' 판정 = **붕괴**):
//   data/Place01/PtzCamRoi.json 을 프리셋 불변 프레임에 올린 결과 주차열이 **3개**이고 서로
//     · preset1 열: 중심 a=26.276, 셀 5.0(a)×2.5(b)   · preset2 열: 중심 a=10.686, 같은 방위
//     · preset3 열: 중심 a=-0.014, 셀 2.5(a)×5.0(b)  ← **방위가 90° 뒤집힘**
//   preset1↔preset2 의 행 간격은 15.59m 로 rowPitch 5.0m 의 정수배가 **아니다**(3.118배).
//   → 하나의 균일 격자로 세 열을 덮을 수 없다. 따라서 격자는 **주차열(strip) 1개당 1개**이고,
//     카메라 1대가 여러 격자를 가질 수 있다(gridStore 는 `grids: GroundGrid[]`).
//   → 성립하는 명제: "주차면 1개 드로잉 → **그 주차열** 전 슬롯 · 그 열이 보이는 전 프리셋".
//     성립하지 않는 명제: "주차면 1개 → 카메라의 **모든** 주차열"(다른 열의 위상·방위는 원리적으로 미지).

import { backprojectToGround, projectToPixel } from './project.js';
import { groundCoordsOf, groundPointOf, groundFrameOf, type GroundFrame } from './groundFrame.js';
import type { Px, Vec3 } from './contactTypes.js';
import type { GroundModel, GroundOptions, PixelQuad } from './types.js';

const DEG = Math.PI / 180;
/** 지면 스팬이 설정 피치에서 이만큼(상대) 벗어나면 issues 로 노출. */
const SPAN_DEV_REL = 0.1;

/**
 * 주차장 지면 격자(미터, 프리셋 무관). 좌표는 GroundFrame(a,b) 기준.
 * 하나의 격자 = 하나의 주차열(strip). 카메라 1대가 여러 격자를 가질 수 있다(파일 상단 ★★).
 */
export interface GroundGrid {
  camIdx: number;
  /** 격자 원점(지면 2D, m) = 셀 (row 0, col 0) 의 기준 코너. */
  originM: { a: number; b: number };
  /**
   * 격자 방위(도). **열축(=폭축) 방향** = 지면 2D 에서 e1 을 이 각만큼 돌린 방향 (cosθ, sinθ).
   * 행축(=깊이축) = (−sinθ, cosθ).
   *
   * ★ 설계서는 `[0,90) mod 90` 이라고 적었으나 **[0,180) 으로 구현했다**(의도적 이탈, 사유):
   *   colPitch(2.5) ≠ rowPitch(5.0) 이므로 θ 와 θ+90 은 **서로 다른 격자**다(폭/깊이 축이 뒤바뀐다).
   *   mod 90 으로 접으면 리더 함정2·3(preset3 의 축 뒤집힘)을 표현할 수단 자체가 사라진다.
   *   θ 와 θ+180 은 인덱스 재매김으로 같은 격자이므로 180 에서 접는다.
   */
  thetaDeg: number;
  /** 열 피치(m) = 슬롯 폭. ground.slotWidthM(2.5). */
  colPitchM: number;
  /** 행 피치(m) = 슬롯 깊이. ground.slotDepthM(5.0). */
  rowPitchM: number;
  cols: number;
  rows: number;
  /**
   * 셀 → 슬롯번호. 키 `${row}:${col}`. 미배정 셀은 키 부재 = 그리지 않음.
   * 파일 quad 로 적합한 격자면 **전역 idx**, 부트스트랩 확장 격자면 **격자 로컬 순번**이다
   * (전역 idx 는 적용 단계에서 기존 슬롯 IoU 매칭으로 얻는다 — autoRoiPlan.ts).
   */
  slotIdByCell: Record<string, number>;
  issues: string[];
}

/** 자동 산출 quad 1건. */
export interface GridQuad {
  slotId: number;
  row: number;
  col: number;
  /** 원본 센서 픽셀 4점, PixelQuad 규약(p0=근좌, p1=원좌, p2=원우, p3=근우). */
  quad: PixelQuad;
}

/** 셀 키(결정론 — 문자열 조립 단일 지점). */
export const cellKey = (row: number, col: number): string => `${row}:${col}`;

/** 셀 키 파싱. 형식 불일치 → null. */
function parseCellKey(key: string): { row: number; col: number } | null {
  const m = /^(-?\d+):(-?\d+)$/.exec(key);
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

/**
 * 셀 순회 순서 — **항상** (row asc → col asc). `Object.keys`/`Map` 삽입 순서 의존 금지(결정론 규약).
 */
export function sortedCells(grid: GroundGrid): Array<{ row: number; col: number; slotId: number }> {
  const out: Array<{ row: number; col: number; slotId: number }> = [];
  for (const [key, slotId] of Object.entries(grid.slotIdByCell)) {
    const rc = parseCellKey(key);
    if (!rc || !Number.isFinite(slotId)) continue;
    out.push({ row: rc.row, col: rc.col, slotId });
  }
  out.sort((p, q) => p.row - q.row || p.col - q.col);
  return out;
}

/** 격자 축(지면 2D 단위벡터). u = 열축(폭), v = 행축(깊이). */
function axesOf(thetaDeg: number): { u: { a: number; b: number }; v: { a: number; b: number } } {
  const c = Math.cos(thetaDeg * DEG);
  const s = Math.sin(thetaDeg * DEG);
  return { u: { a: c, b: s }, v: { a: -s, b: c } };
}

/** 셀 (row,col) 의 지면 2D 코너 4점. 순서 [A, A+행, A+행+열, A+열] — 픽셀 순서는 canonicalizeQuad 가 정한다. */
function cellCornersM(grid: GroundGrid, row: number, col: number): Array<{ a: number; b: number }> {
  const { u, v } = axesOf(grid.thetaDeg);
  const w = grid.colPitchM;
  const h = grid.rowPitchM;
  const a0 = grid.originM.a + col * w * u.a + row * h * v.a;
  const b0 = grid.originM.b + col * w * u.b + row * h * v.b;
  return [
    { a: a0, b: b0 },
    { a: a0 + h * v.a, b: b0 + h * v.b },
    { a: a0 + h * v.a + w * u.a, b: b0 + h * v.b + w * u.b },
    { a: a0 + w * u.a, b: b0 + w * u.b },
  ];
}

/**
 * 픽셀 4점을 PixelQuad 규약 순서(p0=근좌, p1=원좌, p2=원우, p3=근우)로 캐노니컬화. 결정론.
 *
 * 왜 필요한가: 산출 quad 가 그대로 `estimateGroundVPs`(변군 규약 `edgesOf`, groundModel.ts:204)의
 * 입력이 된다. 순서가 틀리면 깊이/폭 배정이 **조용히** 뒤집힌다.
 *
 * 절차: ① 무게중심 기준 편각 정렬(볼록 순환열) ② 부호면적이 양(기준열 [근좌,원좌,원우,근우] 와 같은 감김)이
 *       되도록 방향 통일 ③ 중점 y 가 최대인 변(=근변)이 (p3→p0) 이 되도록 회전.
 * 비유한/영면적 → null(throw 금지).
 */
export function canonicalizeQuad(px: readonly Px[]): PixelQuad | null {
  if (!Array.isArray(px) || px.length !== 4) return null;
  if (px.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const cx = px.reduce((s, p) => s + p.x, 0) / 4;
  const cy = px.reduce((s, p) => s + p.y, 0) / 4;
  const ring = [...px].sort((p, q) => {
    const ap = Math.atan2(p.y - cy, p.x - cx);
    const aq = Math.atan2(q.y - cy, q.x - cx);
    return ap - aq || p.x - q.x || p.y - q.y; // 동일 편각은 (x,y) 로 결정론 고정.
  });
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    area2 += a.x * b.y - b.x * a.y;
  }
  if (!Number.isFinite(area2) || Math.abs(area2) < 1e-9) return null; // 퇴화(공선·중복점).
  if (area2 < 0) ring.reverse();
  // 근변(화면 아래 = 픽셀 y 큰 쪽) 을 (p3→p0) 자리에 놓는다.
  let bestI = 0;
  let bestY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const midY = (ring[i].y + ring[(i + 1) % 4].y) / 2;
    if (midY > bestY) {
      bestY = midY;
      bestI = i;
    }
  }
  const s = (bestI + 1) % 4;
  return [
    { x: ring[s].x, y: ring[s].y },
    { x: ring[(s + 1) % 4].x, y: ring[(s + 1) % 4].y },
    { x: ring[(s + 2) % 4].x, y: ring[(s + 2) % 4].y },
    { x: ring[(s + 3) % 4].x, y: ring[(s + 3) % 4].y },
  ];
}

/**
 * 격자 → 프리셋 픽셀 quad. `projectToPixel` 만 쓴다(신규 투영 수학 0줄).
 * 강등: 코너 4개 중 하나라도 null(지평선 위·카메라 뒤) 또는 캐노니컬화 실패 → 그 셀만 **통째로 제외** + issues 1건
 *       (부분 quad 금지 — projectCuboidPixels 의 "하나라도 퇴화하면 전체 null" 규약과 동일).
 * 순회 순서 고정: row asc → col asc.
 */
export function gridToPixelQuads(
  grid: GroundGrid,
  model: GroundModel,
  panDeg: number | null,
): { quads: GridQuad[]; issues: string[] } {
  const issues: string[] = [];
  const fr = groundFrameOf(model, panDeg);
  if (!fr) {
    issues.push(`preset${model.presetIdx}: 지면 프레임 산출 불가(PTZ pan 미상/수직 하방/모델 퇴화) — 자동 ROI 미생성`);
    return { quads: [], issues };
  }
  const quads: GridQuad[] = [];
  for (const { row, col, slotId } of sortedCells(grid)) {
    const corners = cellCornersM(grid, row, col);
    const pxs: Px[] = [];
    let ok = true;
    for (const c of corners) {
      const p = projectToPixel(groundPointOf(fr, c.a, c.b), model);
      if (!p) {
        ok = false;
        break;
      }
      pxs.push(p);
    }
    if (!ok) {
      issues.push(`preset${model.presetIdx} slot${slotId}(r${row}c${col}): 코너 투영 퇴화(지평선 위/카메라 뒤) — 셀 제외`);
      continue;
    }
    const quad = canonicalizeQuad(pxs);
    if (!quad) {
      issues.push(`preset${model.presetIdx} slot${slotId}(r${row}c${col}): quad 캐노니컬화 실패(퇴화) — 셀 제외`);
      continue;
    }
    quads.push({ slotId, row, col, quad });
  }
  return { quads, issues };
}

/** 정렬 median(빈 배열 → NaN). */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((p, q) => p - q);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * 주기 p 를 갖는 값들의 **원형 median**. RANSAC 금지 규약 하의 결정론적 위상 추정.
 * ① 벡터합으로 원형 평균(입력 순서 무관) → ② 그 평균을 중심으로 한 반주기 창으로 값을 감아 median → ③ [0,p) 로 환원.
 */
function circularMedian(xs: readonly number[], p: number): number {
  if (xs.length === 0 || !(p > 0)) return NaN;
  let sx = 0;
  let sy = 0;
  for (const x of xs) {
    const t = (2 * Math.PI * x) / p;
    sx += Math.cos(t);
    sy += Math.sin(t);
  }
  const mean = (Math.atan2(sy, sx) / (2 * Math.PI)) * p;
  const wrapped = xs.map((x) => {
    const d = (((x - mean) % p) + p) % p;
    return mean + (d > p / 2 ? d - p : d);
  });
  const m = median(wrapped);
  return ((m % p) + p) % p;
}

/** quad 4점 → 지면 2D 4점. 하나라도 역투영 실패 → null. */
export function quadToGroundM(
  quad: PixelQuad,
  model: GroundModel,
  fr: GroundFrame,
): Array<{ a: number; b: number }> | null {
  const out: Array<{ a: number; b: number }> = [];
  for (const p of quad) {
    const X = backprojectToGround(p, model);
    if (!X) return null;
    out.push(groundCoordsOf(fr, X as Vec3));
  }
  return out;
}

/**
 * 역방향(부트스트랩·검증용): 프리셋 quad 들 → 격자 파라미터 적합.
 *
 * 결정론: **RANSAC 금지**. 방위 = 변 방향의 mod 90 원형 median, 위상 = 잔차의 원형 median(닫힌 형태).
 * 피치는 **측정하지 않고** `opts.slotWidthM/slotDepthM`(저작 상수)을 쓴다 — 측정 스팬으로 피치를 잡으면
 * 프리셋마다 미세하게 다른 격자가 되어 프리셋 간 이식이 깨진다. 측정 스팬은 ① 폭/깊이 **축 배정**(함정3)과
 * ② 편차 issues 에만 쓴다.
 *
 * @param slotIds quads 와 같은 길이의 전역 슬롯번호. 생략 시 1-based 순번.
 * 실패(quad 0개·프레임 퇴화·전량 역투영 실패) → `{ grid: null, issues }`.
 *   ※ 설계서 시그니처는 `… | null` 이었으나 그 형태로는 **실패 사유(issues)가 소실**된다 → 객체 반환으로 변경.
 */
export function fitGridFromQuads(
  quads: readonly PixelQuad[],
  model: GroundModel,
  panDeg: number | null,
  opts: Pick<GroundOptions, 'slotWidthM' | 'slotDepthM'>,
  slotIds?: readonly number[],
): { grid: GroundGrid | null; issues: string[] } {
  const issues: string[] = [];
  if (!quads.length) {
    issues.push('격자 적합 실패: 입력 quad 0개');
    return { grid: null, issues };
  }
  const fr = groundFrameOf(model, panDeg);
  if (!fr) {
    issues.push(`preset${model.presetIdx}: 지면 프레임 산출 불가(PTZ pan 미상/수직 하방/모델 퇴화)`);
    return { grid: null, issues };
  }
  const gs: Array<{ id: number; pts: Array<{ a: number; b: number }> }> = [];
  quads.forEach((q, i) => {
    const pts = quadToGroundM(q, model, fr);
    if (!pts) {
      issues.push(`quad #${i + 1}: 지면 역투영 실패(지평선 위) — 적합 표본 제외`);
      return;
    }
    gs.push({ id: slotIds?.[i] ?? i + 1, pts });
  });
  if (!gs.length) {
    issues.push('격자 적합 실패: 지면으로 올릴 수 있는 quad 0개');
    return { grid: null, issues };
  }

  // ① 방위(mod 90) — 네 변의 방향각을 mod 90 원형 median.
  const angs: number[] = [];
  for (const g of gs) {
    for (let i = 0; i < 4; i++) {
      const p = g.pts[i];
      const q = g.pts[(i + 1) % 4];
      const len = Math.hypot(q.a - p.a, q.b - p.b);
      if (len < 1e-6) continue;
      angs.push(((((Math.atan2(q.b - p.b, q.a - p.a) / DEG) % 90) + 90) % 90));
    }
  }
  if (!angs.length) {
    issues.push('격자 적합 실패: 유효한 변 0개(퇴화 quad)');
    return { grid: null, issues };
  }
  const theta90 = circularMedian(angs, 90);

  // ② 폭/깊이 축 배정 — **지면 실측 스팬(미터)** 으로 판정(함정3: 픽셀 길이 판정 금지).
  const { u: u90, v: v90 } = axesOf(theta90);
  const spanAlong = (pts: Array<{ a: number; b: number }>, ax: { a: number; b: number }): number => {
    const ps = pts.map((p) => p.a * ax.a + p.b * ax.b);
    return Math.max(...ps) - Math.min(...ps);
  };
  const spanU = median(gs.map((g) => spanAlong(g.pts, u90)));
  const spanV = median(gs.map((g) => spanAlong(g.pts, v90)));
  const costKeep = Math.abs(spanU - opts.slotWidthM) + Math.abs(spanV - opts.slotDepthM);
  const costSwap = Math.abs(spanV - opts.slotWidthM) + Math.abs(spanU - opts.slotDepthM);
  const swap = costSwap < costKeep;
  let thetaDeg = ((theta90 + (swap ? 90 : 0)) % 180 + 180) % 180;
  // 접힘 경계(180 ≡ 0) 방어: 179.99999… 는 round5 로 180 이 되어 [0,180) 불변식을 깬다.
  // 0 으로 스냅해도 축이 180° 뒤집힐 뿐이고 원점·인덱스는 아래에서 그 θ 로 산출하므로 셀 집합은 동일하다.
  if (thetaDeg > 180 - 1e-4) thetaDeg = 0;
  const widthSpan = swap ? spanV : spanU;
  const depthSpan = swap ? spanU : spanV;
  if (Math.abs(widthSpan - opts.slotWidthM) / opts.slotWidthM > SPAN_DEV_REL) {
    issues.push(
      `실측 폭 ${widthSpan.toFixed(3)}m 가 설정 slotWidthM ${opts.slotWidthM}m 대비 ` +
        `${(((widthSpan - opts.slotWidthM) / opts.slotWidthM) * 100).toFixed(1)}% 벗어남 — 격자 피치는 설정값을 쓴다`,
    );
  }
  if (Math.abs(depthSpan - opts.slotDepthM) / opts.slotDepthM > SPAN_DEV_REL) {
    issues.push(
      `실측 깊이 ${depthSpan.toFixed(3)}m 가 설정 slotDepthM ${opts.slotDepthM}m 대비 ` +
        `${(((depthSpan - opts.slotDepthM) / opts.slotDepthM) * 100).toFixed(1)}% 벗어남 — 격자 피치는 설정값을 쓴다`,
    );
  }

  // ③ 위상 — 셀 중심이 (col+0.5)·w, (row+0.5)·h 에 오도록 하는 원점 오프셋의 원형 median.
  const { u, v } = axesOf(thetaDeg);
  const w = opts.slotWidthM;
  const h = opts.slotDepthM;
  const centers = gs.map((g) => {
    const a = g.pts.reduce((s, p) => s + p.a, 0) / 4;
    const b = g.pts.reduce((s, p) => s + p.b, 0) / 4;
    return { id: g.id, cu: a * u.a + b * u.b, cv: a * v.a + b * v.b };
  });
  const ou = circularMedian(centers.map((c) => c.cu - w / 2), w);
  const ov = circularMedian(centers.map((c) => c.cv - h / 2), h);
  if (!Number.isFinite(ou) || !Number.isFinite(ov)) {
    issues.push('격자 적합 실패: 위상 산출 불가');
    return { grid: null, issues };
  }

  // ④ 인덱스 부여 후 (0,0) 기준으로 정규화.
  const idx = centers.map((c) => ({
    id: c.id,
    col: Math.round((c.cu - ou - w / 2) / w),
    row: Math.round((c.cv - ov - h / 2) / h),
  }));
  const minCol = Math.min(...idx.map((e) => e.col));
  const minRow = Math.min(...idx.map((e) => e.row));
  const slotIdByCell: Record<string, number> = {};
  for (const e of idx) {
    const key = cellKey(e.row - minRow, e.col - minCol);
    if (slotIdByCell[key] != null) {
      issues.push(`셀 ${key} 충돌: slot${slotIdByCell[key]} 와 slot${e.id} 가 같은 격자 칸 — 배치가 격자와 불일치`);
      continue;
    }
    slotIdByCell[key] = e.id;
  }
  const cols = Math.max(...idx.map((e) => e.col)) - minCol + 1;
  const rows = Math.max(...idx.map((e) => e.row)) - minRow + 1;
  const oa = (ou + minCol * w) * u.a + (ov + minRow * h) * v.a;
  const ob = (ou + minCol * w) * u.b + (ov + minRow * h) * v.b;

  return {
    grid: {
      camIdx: model.camIdx,
      originM: { a: oa, b: ob },
      thetaDeg,
      colPitchM: w,
      rowPitchM: h,
      cols,
      rows,
      slotIdByCell,
      issues: [...issues],
    },
    issues,
  };
}
