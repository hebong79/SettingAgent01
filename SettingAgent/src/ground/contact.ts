// 마스크 → 접지선 → 지면 → **차량 3D 육면체**(설계 §4 의 [1]~[8]). 전부 순수 함수 · IO 0 · LLM 0.
//
// 재사용만 한다: GroundModel(f,n,d) 는 estimateGroundModels 가 이미 준다 → **추정 수학 신규 0줄**.
// 이 파일이 하는 일은 그 지면 위에 **차량 접지점을 얹는 것**뿐이다.
//
// ★ 관측/prior 경계(설계 §3, contactTypes.CuboidSource):
//     위치(X,Y) = 관측  ·  yaw = 슬롯 prior  ·  L = **항상 prior**(뒤 접지선은 원리적으로 안 보인다)
//     W/H = 관측 또는 prior 강등.
//
// 강등 철학(groundModel.ts 와 동일): throw 0건 · NaN 전파 0건 · **조용히 틀린 육면체보다 안 그리는 게 낫다**.
//   모든 강등은 issues: string[] 에 사유를 남긴다.

import { axialWrap, circularMedianAngle, iou, median } from '../domain/geometry.js';
import { polygonArea, pointInPolygon } from '../domain/polygon.js';
import type { NormalizedQuad } from '../domain/types.js';
import { backprojectToGround, projectCuboidPixels, projectToPixel, cross3, dot3, sub3, unit3 } from './project.js';
import type { GroundModel } from './types.js';
import type {
  ContactCol,
  ContactOptions,
  CuboidSource,
  Px,
  RejectedVehicle,
  SlotAxes,
  Vec3,
  VehicleCuboid,
} from './contactTypes.js';

const DEG = Math.PI / 180;
/** 폭 스팬 로버스트 분위(양끝 2% 절사 — bridge 잔재가 폭을 부풀리지 못하게). */
const SPAN_Q = 0.02;

/** 세그멘테이션 차량 1대(픽셀 좌표). */
export interface SegVehicle {
  /**
   * ★ **원본 VPD 검출 인덱스**(0-based). 마스크 drop·주차면 필터로 배열이 두 번 재색인되므로,
   * 이 키가 없으면 산출물을 원본 검출로 되짚을 수 없다. **옵셔널이 아니다** — 호출측이 잊으면 컴파일이 막는다.
   */
  vpdIdx: number;
  mask: Px[];
  cls: string;
  confidence: number;
  /** VPD bbox(픽셀) — 참고용 IoU 산출에만 쓴다(성공 기준 아님). */
  bboxPx?: { x1: number; y1: number; x2: number; y2: number };
}

/** buildVehicleCuboids 입력(프리셋 1개분). 전부 **원본 센서 픽셀** 좌표. */
export interface CuboidBuildInput {
  /** 육면체를 산출할 차량 — 주차면 필터([0.5]) **통과분**. */
  vehicles: SegVehicle[];
  /**
   * ⚠️ 가림 배제([2])가 쓸 **다른 차량** 마스크 — **필터 *전* 전량**이어야 한다.
   * 필터로 제외된 차량(통행차·원경차)도 **가리기는 한다**. 필터 후 집합으로 판정하면 **가림이 조용히 누락**된다
   * (파이썬 원형 contact_filtered.py 의 `others` 가 `cand` 전체를 쓰는 것과 동일).
   * 미지정이면 `vehicles` 자신을 쓴다(필터 off 경로).
   */
  occluderMasks?: Px[][];
  /** 이 프리셋의 주차면 폴리곤(픽셀). yaw prior 의 유일한 근거. */
  slotPolysPx: Px[][];
  ground: GroundModel;
  /** 주차면 규격(m). 어느 변군이 폭/깊이인지 **지면 실측 길이**로 판정한다(픽셀 길이로 판정하면 틀린다). */
  slotWidthM: number;
  slotDepthM: number;
  opts: ContactOptions;
}

export interface CuboidBuildResult {
  cuboids: VehicleCuboid[];
  rejected: RejectedVehicle[];
  /** 슬롯 축(yaw prior). 산출 실패 시 null → 육면체 전량 미산출. 앵커 지표도 이 축을 쓴다. */
  axes: SlotAxes | null;
  /** 프리셋 단위 advisory(축 기각 등). */
  issues: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// [1] 마스크 하단 윤곽 — 열별 최하단 y
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 마스크 폴리곤의 **하단 윤곽**(열별 최하단 점). cv2 래스터화 없이 폴리곤-수직선 교점으로 동등하게 구한다
 * (파이썬 원형 overlay_contact.py 와 같은 정의: 각 열에서 마스크가 차지하는 최대 y).
 * 오목(bridge 형) 폴리곤에서도 정확 — 모든 변과의 교점 중 max y 를 취하므로.
 */
export function bottomContour(mask: readonly Px[], stepPx: number): ContactCol[] {
  if (mask.length < 3 || !(stepPx > 0)) return [];
  const xs = mask.map((p) => p.x);
  const x0 = Math.ceil(Math.min(...xs));
  const x1 = Math.floor(Math.max(...xs));
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return [];
  const cols: ContactCol[] = [];
  for (let x = x0; x <= x1; x += stepPx) {
    let yMax = -Infinity;
    for (let i = 0; i < mask.length; i++) {
      const a = mask[i];
      const b = mask[(i + 1) % mask.length];
      // 반열린 [a.x, b.x) 교차 규칙 — 정점 중복 카운트를 막는다(수직변은 자동 제외).
      const hit = (a.x <= x && x < b.x) || (b.x <= x && x < a.x);
      if (!hit) continue;
      const t = (x - a.x) / (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      if (y > yMax) yMax = y;
    }
    if (Number.isFinite(yMax)) cols.push({ x, y: yMax });
  }
  return cols;
}

// ─────────────────────────────────────────────────────────────────────────────
// [2] 가림 배제 — 윤곽점 바로 아래가 '다른 차량' 마스크 안이면 접지선이 아니다
// ─────────────────────────────────────────────────────────────────────────────

interface OtherMask {
  poly: readonly Px[];
  /** 사전 필터용 bbox(폴리곤 검사 skip). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 폴리곤 → bbox 동봉 구조(가림 검사 사전 필터). */
export function toOtherMask(poly: readonly Px[]): OtherMask {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    poly,
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * 가림 배제: (x, y + belowPx) 가 **다른 차량** 마스크 안이면 그 열은 접지선이 아니다(앞차가 뒷차 발을 가림).
 * 마스크는 비볼록이므로 ray casting(pointInPolygon)을 쓴다 — convexIntersectionArea 사용 금지.
 * 실측 유효비율: 근경 95~100% / 안쪽 23~59%.
 *
 * ⚠️ **자기 차체 가림은 여기서 못 살린다**(자기 마스크 안이므로 규칙에 안 걸린다) — 그것이 L 이 prior 인 이유.
 */
export function rejectOccluded(
  cols: readonly ContactCol[],
  others: readonly OtherMask[],
  belowPx: number,
  imgH: number,
): { valid: ContactCol[]; cleanRatio: number } {
  if (cols.length === 0) return { valid: [], cleanRatio: 0 };
  const valid: ContactCol[] = [];
  for (const c of cols) {
    const yb = Math.min(c.y + belowPx, imgH - 1);
    let occluded = false;
    for (const o of others) {
      if (c.x < o.minX || c.x > o.maxX || yb < o.minY || yb > o.maxY) continue; // bbox 사전 필터.
      if (pointInPolygon(o.poly, { x: c.x, y: yb })) {
        occluded = true;
        break;
      }
    }
    if (!occluded) valid.push(c);
  }
  return { valid, cleanRatio: valid.length / cols.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// [4] 슬롯 축(yaw prior) — 프리셋 공통(스트립 가정)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 슬롯 폴리곤(픽셀) → 지면 기저 {u: 폭축, w: 깊이축, origin}.
 *
 * ★ **슬롯 배정 불필요** — 스트립은 전 슬롯이 같은 축을 공유한다(현 데이터). 축 스프레드가 크면(규격 혼재)
 *   가정이 깨진 것이므로 **기각**한다(육면체 미산출). 조용히 평균내지 않는다.
 * 폭/깊이 판정은 **지면 실측 길이**(m)로 한다 — 픽셀 길이로 판정하면 투영단축 때문에 뒤집힌다(groundModel §4-6).
 */
export function slotAxes(
  slotPolysPx: readonly Px[][],
  g: GroundModel,
  slotWidthM: number,
  slotDepthM: number,
  axisSpreadDeg: number,
): { axes: SlotAxes | null; issues: string[] } {
  const issues: string[] = [];
  const n = g.n as Vec3;
  const z: Vec3 = [0, 0, 1];
  const fwd = unit3([z[0] - dot3(z, n) * n[0], z[1] - dot3(z, n) * n[1], z[2] - dot3(z, n) * n[2]]);
  if (!fwd) {
    return { axes: null, issues: ['광축이 지면 법선과 평행 — 지면 기저 정의 불가'] };
  }
  const right = unit3(cross3(n, fwd));
  if (!right) return { axes: null, issues: ['지면 기저 퇴화'] };

  const uAngles: number[] = []; // 폭축 방향각(axial, rad) — fwd/right 기저 기준.
  const wSamples: Vec3[] = []; // 깊이축 표본(카메라에서 **멀어지는** 방향으로 정렬).
  const allCorners: Vec3[] = [];
  for (const poly of slotPolysPx) {
    if (poly.length !== 4) continue; // 4점 아닌 면은 축 표본 제외.
    const gp: Vec3[] = [];
    let bad = false;
    for (const p of poly) {
      const X = backprojectToGround(p, g);
      if (!X) {
        bad = true;
        break;
      }
      gp.push(X);
    }
    if (bad) continue; // 지평선 위 코너 → 그 슬롯 제외.
    allCorners.push(...gp);

    // 변군 A = (0-1),(3-2) / 변군 B = (0-3),(1-2) — PixelQuad 규약(ground/types.ts).
    const famA: Array<[Vec3, Vec3]> = [
      [gp[0], gp[1]],
      [gp[3], gp[2]],
    ];
    const famB: Array<[Vec3, Vec3]> = [
      [gp[0], gp[3]],
      [gp[1], gp[2]],
    ];
    const lenOf = (fam: Array<[Vec3, Vec3]>): number =>
      fam.reduce((s, [p, q]) => s + Math.hypot(...(sub3(q, p) as [number, number, number])), 0) / fam.length;
    const lenA = lenOf(famA);
    const lenB = lenOf(famB);
    // 지면 실측 길이로 폭/깊이 배정(픽셀 길이 아님).
    const costAisWidth = Math.abs(lenA - slotWidthM) + Math.abs(lenB - slotDepthM);
    const costBisWidth = Math.abs(lenB - slotWidthM) + Math.abs(lenA - slotDepthM);
    const widthFam = costAisWidth <= costBisWidth ? famA : famB;
    const depthFam = costAisWidth <= costBisWidth ? famB : famA;

    for (const [p, q] of widthFam) {
      const dir = unit3(sub3(q, p));
      if (!dir) continue;
      uAngles.push(Math.atan2(dot3(dir, right), dot3(dir, fwd))); // axial(±dir 동일) → circularMedianAngle 이 흡수.
    }
    for (const [p, q] of depthFam) {
      // 카메라에서 **먼** 끝점 쪽으로 부호 고정(깊이축 +w = 안쪽).
      const near = Math.hypot(p[0], p[1], p[2]) <= Math.hypot(q[0], q[1], q[2]) ? p : q;
      const far = near === p ? q : p;
      const dir = unit3(sub3(far, near));
      if (dir) wSamples.push(dir);
    }
  }

  if (uAngles.length === 0 || wSamples.length === 0 || allCorners.length === 0) {
    return { axes: null, issues: ['슬롯 폴리곤 0개(또는 전부 지평선 위) — yaw prior 불가'] };
  }

  const uMed = circularMedianAngle(uAngles); // 주기 π(축) 강건 대표각.
  let spreadDeg = 0;
  for (const a of uAngles) spreadDeg = Math.max(spreadDeg, Math.abs(axialWrap(a - uMed)) / DEG);
  if (spreadDeg > axisSpreadDeg) {
    return {
      axes: null,
      issues: [
        `슬롯 축 스프레드 ${spreadDeg.toFixed(1)}° > ${axisSpreadDeg}° — 스트립(공통 축) 가정 붕괴. ` +
          `규격 혼재(직각+평행주차) 의심 → 육면체 미산출(yaw prior 불가)`,
      ],
    };
  }

  const u = unit3([
    Math.cos(uMed) * fwd[0] + Math.sin(uMed) * right[0],
    Math.cos(uMed) * fwd[1] + Math.sin(uMed) * right[1],
    Math.cos(uMed) * fwd[2] + Math.sin(uMed) * right[2],
  ]);
  if (!u) return { axes: null, issues: ['폭축 퇴화'] };

  // 깊이축은 u 에 **직교**(슬롯은 직사각형) → cross(n,u) 로 정확히 만들고, 부호만 표본으로 고정.
  const wPerp = unit3(cross3(n, u));
  if (!wPerp) return { axes: null, issues: ['깊이축 퇴화'] };
  const meanW: Vec3 = [0, 0, 0];
  for (const s of wSamples) {
    meanW[0] += s[0];
    meanW[1] += s[1];
    meanW[2] += s[2];
  }
  const sign = dot3(wPerp, meanW) >= 0 ? 1 : -1;
  const w: Vec3 = [wPerp[0] * sign, wPerp[1] * sign, wPerp[2] * sign];

  const origin: Vec3 = [
    allCorners.reduce((s, p) => s + p[0], 0) / allCorners.length,
    allCorners.reduce((s, p) => s + p[1], 0) / allCorners.length,
    allCorners.reduce((s, p) => s + p[2], 0) / allCorners.length,
  ];
  return { axes: { u, w, origin, spreadDeg }, issues };
}

/** 지면점 → 슬롯 기저 좌표 (a = 폭축, b = 깊이축), 원점 기준 meter. */
export function toAxisCoords(X: Vec3, axes: SlotAxes): { a: number; b: number } {
  const r = sub3(X, axes.origin);
  return { a: dot3(r, axes.u), b: dot3(r, axes.w) };
}

/** 슬롯 기저 좌표 → 지면점. toAxisCoords 의 역(지면 위 점에 한해 정확 — u⊥w 이고 둘 다 평면 위). */
export function fromAxisCoords(a: number, b: number, axes: SlotAxes): Vec3 {
  return [
    axes.origin[0] + a * axes.u[0] + b * axes.w[0],
    axes.origin[1] + a * axes.u[1] + b * axes.w[1],
    axes.origin[2] + a * axes.u[2] + b * axes.w[2],
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// [5] 접지선 적합 — 결정형 exhaustive(랜덤 시드 없음 → 테스트 flaky 0)
// ─────────────────────────────────────────────────────────────────────────────

export interface LineFit {
  /** 앞선(앞범퍼 접지 모서리)의 깊이축 좌표(m). */
  tFront: number;
  /** 앞선 밴드의 폭축 중심(m) — buildFootprint 가 그대로 쓴다. */
  aCenter: number;
  /** 앞선 밴드의 폭축 스팬(m) = W 관측치. */
  frontSpanM: number;
  frontCount: number;
  /** 앞선 밴드 내 b 의 MAD(m) — **직선성 = bridge 게이트**(비율이 아니라 잔차로 잰다). */
  frontMadM: number;
  totalCount: number;
  /** 앞선 밴드에 속한 점들(G2b 픽셀 잔차 측정에 그대로 재사용). */
  frontBand: Array<{ a: number; b: number }>;
}

/** 앞선 적합 실패 사유(그대로 issues 문자열이 된다 — 조용한 실패 금지). */
export type LineFitReject =
  | { kind: 'empty' }
  | { kind: 'front-span'; frontSpanM: number; frontCount: number }
  | { kind: 'front-cols'; frontCount: number }
  | { kind: 'front-mad'; frontMadM: number };

/**
 * ★ **v2 — 근접 앞범퍼선(near-edge)**. v1 의 "최빈 밴드"는 **틀렸다**(Loop 1 실증: 육면체가 1~5m 뒤로 밀림).
 *
 * 왜 최빈이 틀렸나 — **오염이 전부 단방향(+b)** 이기 때문이다:
 *   ① **flank(측면) 접지선**: 하단 윤곽은 앞범퍼선뿐 아니라 **근접 측면 접지선**(b 가 차길이 L 에 걸쳐 퍼짐)을 포함한다.
 *      최빈·중앙값은 이 꼬리를 **평균해서 삼킨다** → tFront 가 뒤로 끌린다. (실측 주범)
 *   ② **z>0 현(chord)**: 로커패널·범퍼하단·언더바디 그림자(z≈0.15~0.25m)는 지면점이 아닌데 지면에 역투영되면
 *      카메라에서 **멀어지는 쪽**으로 밀린다(HANDOFF §2-6 의 그 함정이 접지선에서 재발). (실측 부범 — 상수 바닥)
 *   → b 를 **작게** 만드는 물리적 오염원은 **없다**(지면 아래엔 아무것도 없다).
 *   ∴ 참된 접지는 **b 최솟값 쪽 구조**에 있다. 단, bridge/누출만 양방향이므로 **최솟값이 아니라 로버스트 하위 분위수**를 쓴다.
 *
 * bridge 게이트를 `inlierRatio` 로 쓰면 **안 된다**(v1 의 숨은 오류): near-edge 밴드 비율은 **시야각의 함수**라
 * flank 가 많이 보이는 정상 차량을 파편화로 오진한다. → **`frontMadM`(밴드 내부 직선성)** 으로 잰다.
 */
export function fitContactLine(
  pts: ReadonlyArray<{ a: number; b: number }>,
  opts: ContactOptions,
): { fit: LineFit } | { reject: LineFitReject } {
  if (pts.length === 0) return { reject: { kind: 'empty' } };

  // 1. 하위 분위수(최솟값 금지 — bridge/누출 방어) → 2. 근접 모서리 밴드.
  const bs = pts.map((p) => p.b).sort((x, y) => x - y);
  const bNear = quantile(bs, opts.qNear);
  const frontBand = pts.filter((p) => p.b <= bNear + opts.frontBandM).map((p) => ({ a: p.a, b: p.b }));
  if (frontBand.length === 0) return { reject: { kind: 'empty' } };

  // 3. ★ 앞범퍼 검증 — 앞범퍼는 u(폭축)로 길고 flank 는 w(깊이축)로 길다.
  //    스팬이 짧으면 우리가 잡은 건 앞범퍼선이 아니다(flank 만 보임 / 원경 / 가림 과다) → **미산출**.
  const as = frontBand.map((p) => p.a).sort((x, y) => x - y);
  const frontSpanM = quantile(as, 1 - SPAN_Q) - quantile(as, SPAN_Q);
  if (frontSpanM < opts.minFrontSpanM) {
    return { reject: { kind: 'front-span', frontSpanM, frontCount: frontBand.length } };
  }
  if (frontBand.length < opts.minFrontCols) {
    return { reject: { kind: 'front-cols', frontCount: frontBand.length } };
  }

  // 4. 직선성(bridge 게이트) — 비율이 아니라 **잔차**.
  const tFront = median(frontBand.map((p) => p.b));
  const frontMadM = median(frontBand.map((p) => Math.abs(p.b - tFront)));
  if (frontMadM > opts.frontMadMaxM) {
    return { reject: { kind: 'front-mad', frontMadM } };
  }

  return {
    fit: {
      tFront,
      aCenter: median(frontBand.map((p) => p.a)),
      frontSpanM,
      frontCount: frontBand.length,
      frontMadM,
      totalCount: pts.length,
      frontBand,
    },
  };
}

/** 분위수(선형보간 없음 — 인덱스 클램프). 결정형. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

// ─────────────────────────────────────────────────────────────────────────────
// [6] footprint — 접지 모서리 + prior L → 지면 4점
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 접지선 적합 결과 → 지면 4점(FL, FR, RR, RL). "앞"=카메라 쪽 접지 모서리.
 * W 는 inlier 폭축 스팬(관측) — 부족/과대면 prior 강등. L 은 **항상 prior**(§3-1). nose-in/back-in 무관(직육면체 대칭).
 *
 * ★ F-1 클램프: 관측 스팬을 [priorW × loFactor, priorW × hiFactor] 로 자르고, **발동하면 W 출처를 'prior' 로 강등**한다.
 *   실루엣 하단 윤곽이 비정면 시야에서 지면이 아닌 **현(chord)** 위를 지나 폭을 부풀리기 때문이다(실측 +18%).
 *   현 기하 보정 모델은 **만들지 않는다** — 오염은 좌우 대칭이라 **중심(=앵커 지표)에는 영향이 없고**, 육면체 렌더/IoU 만 다친다.
 */
export interface Footprint {
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** 접지 앞선 중점 — 앵커 지표의 C_vehicle(prior 미주입, F-2). */
  front: Vec3;
  /** footprint 중심 — ⚠️ PRIOR_L 의존(렌더/포함판정 전용). */
  center: Vec3;
  widthM: number;
  wSource: 'observed' | 'prior';
  /** 클램프 전 원 관측 스팬(m). 강등 사유 문자열에 그대로 싣는다(은닉 금지). */
  rawSpanM: number;
}

export function buildFootprint(fit: LineFit, axes: SlotAxes, opts: ContactOptions): Footprint {
  const rawSpanM = fit.frontSpanM; // v2: 앞선 밴드의 폭축 스팬(fitContactLine 이 이미 로버스트 산출).
  const lo = opts.priorW * opts.widthClampLoFactor;
  const hi = opts.priorW * opts.widthClampHiFactor;

  let widthM: number;
  let wSource: 'observed' | 'prior';
  if (rawSpanM < opts.minWidthM) {
    widthM = opts.priorW; // 병적(설계 §8 #10) → prior 값 자체로.
    wSource = 'prior';
  } else if (rawSpanM < lo || rawSpanM > hi) {
    widthM = Math.min(hi, Math.max(lo, rawSpanM)); // F-1 클램프 → 경계값 채택 + 출처 강등.
    wSource = 'prior';
  } else {
    widthM = rawSpanM;
    wSource = 'observed';
  }

  const aC = fit.aCenter;
  const t = fit.tFront;
  const L = opts.priorL;
  const fl = fromAxisCoords(aC - widthM / 2, t, axes);
  const fr = fromAxisCoords(aC + widthM / 2, t, axes);
  const rr = fromAxisCoords(aC + widthM / 2, t + L, axes);
  const rl = fromAxisCoords(aC - widthM / 2, t + L, axes);
  return {
    corners: [fl, fr, rr, rl],
    front: fromAxisCoords(aC, t, axes), // ★ prior 가 한 번도 곱해지지 않은 점.
    center: fromAxisCoords(aC, t + L / 2, axes),
    widthM,
    wSource,
    rawSpanM,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// [7] 높이 — ❌ **제거됨(Loop 2). H 는 마스크 상단으로 관측할 수 없다.**
//
// v1/v2 는 "육면체 8점 투영의 min y 를 마스크 상단에 맞추는 역문제"로 h 를 풀었다(solveHeight, 이분탐색).
// 수학은 옳았으나 **전제가 틀렸다: 차는 직육면체가 아니다.**
//   · 맞춰지는 접점은 **언제나 모델의 뒤-상단 코너**(= tFront + PRIOR_L = 4.7m 뒤)다 — 실측: 전 차량·전 프리셋 예외 없이.
//   · 그러나 차의 최상단 실루엣 점(**지붕**)은 4.7m 뒤에 없다. 지붕은 **짧고 안쪽으로 물러난 슬래브**다.
//   · 모델의 뒤-상단 코너가 실제 지붕보다 멀리 있어 이미지에서 **더 위로** 투영된다
//     (실측: GT 높이 육면체의 재투영 상단이 마스크 상단보다 **29~66px 위**)
//     → 마스크 상단에 맞추려면 h 를 **낮춰야** 한다 → **계통적 H 과소(실측 −0.30 ~ −0.42m)**.
//   · L 민감도 실측 dh/dL = 0.13(p1) / 0.20(p3) m/m — 리더가 본 프리셋 의존성(p3/p1=1.36배)의 정체는
//     flank 오염이 아니라 이 계수 `(d−h)/D` 였다.
//
// ∴ **H = 차종 prior 고정**(`CuboidSource.H: 'prior'` 리터럴). 배치(footprint)는 앞선·슬롯축·prior L/W 가 결정하며
//   H 는 상자의 뚜껑 높이일 뿐이다 → 배치 성공기준은 G2b(앞선 픽셀거리 ≤ 8px)이지 H 가 아니다.
//   원리적으로 옳은 길은 **육면체 실루엣 ↔ 마스크 정합**이다(후속 과제 — 지금은 만들지 않는다, CLAUDE.md §2).
//   봉인: test/cuboidBoxPremise.test.ts
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// [8] 조립
// ─────────────────────────────────────────────────────────────────────────────

/** 프리셋 1개분 차량 육면체 산출. 실패는 전부 rejected/issues 로 드러난다(조용한 실패 금지). */
export function buildVehicleCuboids(input: CuboidBuildInput): CuboidBuildResult {
  const { vehicles, slotPolysPx, ground: g, opts } = input;
  const issues: string[] = [];
  const cuboids: VehicleCuboid[] = [];
  const rejected: RejectedVehicle[] = [];

  const axesRes = slotAxes(slotPolysPx, g, input.slotWidthM, input.slotDepthM, opts.axisSpreadDeg);
  issues.push(...axesRes.issues);
  const axes = axesRes.axes;
  if (!axes) {
    // yaw prior 불가 → 전 차량 미산출(사유는 차량마다 남긴다 — 조용히 사라지지 않게).
    for (let i = 0; i < vehicles.length; i++) {
      rejected.push({ boxIdx: i, vpdIdx: vehicles[i].vpdIdx, issues: ['슬롯 축 산출 실패 — yaw prior 불가'] });
    }
    return { cuboids, rejected, axes: null, issues };
  }

  // ⚠️ 가림 배제는 **필터 전 전량**(occluderMasks)으로 판단한다 — 필터로 제외된 차량도 가리기는 한다.
  //    미지정이면 vehicles 자신(필터 off 경로). 자기 자신은 아래에서 좌표 동일성으로 제외한다.
  const occluders = (input.occluderMasks ?? vehicles.map((v) => v.mask)).map(toOtherMask);

  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    const vIssues: string[] = [];

    // #4 마스크 퇴화.
    if (v.mask.length < 3 || polygonArea(v.mask) < opts.minMaskAreaPx) {
      rejected.push({ boxIdx: i, vpdIdx: v.vpdIdx, issues: [`마스크 퇴화(점 ${v.mask.length}개/면적 부족) — 육면체 미산출`] });
      continue;
    }

    // [1] 하단 윤곽 → [2] 가림 배제. 자기 자신은 **참조 동일성**으로 제외한다
    //     (occluderMasks 는 vehicles[i].mask 와 **같은 배열 참조**를 담아야 한다 — 라우트가 보장).
    const cols = bottomContour(v.mask, opts.colStepPx);
    const { valid, cleanRatio } = rejectOccluded(
      cols,
      occluders.filter((o) => o.poly !== v.mask),
      opts.belowPx,
      g.imgH,
    );
    // #5 유효 접지열 부족.
    if (valid.length < opts.minContactCols) {
      rejected.push({
        boxIdx: i,
        vpdIdx: v.vpdIdx,
        issues: [`유효 접지열 ${valid.length}개(< ${opts.minContactCols}) — 가림 과다, 육면체 미산출`],
      });
      continue;
    }
    // #6 cleanRatio 낮음 → 산출은 하되 advisory(실측 하한 23%).
    if (cleanRatio < opts.cleanRatioWarn) {
      vIssues.push(`접지선 유효비율 ${(cleanRatio * 100).toFixed(0)}% — 가림 많음(육면체 정확도 낮을 수 있음)`);
    }

    // [3] 지면 역투영.
    const groundPts: Array<{ a: number; b: number }> = [];
    for (const c of valid) {
      const X = backprojectToGround(c, g);
      if (X) groundPts.push(toAxisCoords(X, axes));
    }
    // #7 전부 지평선 위.
    if (groundPts.length === 0) {
      rejected.push({ boxIdx: i, vpdIdx: v.vpdIdx, issues: ['접지점 지면 역투영 전량 실패(지평선 위) — 육면체 미산출'] });
      continue;
    }

    // [5] ★ 앞선 적합 v2(near-edge). 실패 사유는 전부 issues 문자열로 드러난다.
    const fitRes = fitContactLine(groundPts, opts);
    if ('reject' in fitRes) {
      const r = fitRes.reject;
      const why =
        r.kind === 'front-span'
          ? `앞범퍼 접지선 미검출(앞선 폭 스팬 ${r.frontSpanM.toFixed(2)}m < ${opts.minFrontSpanM}m, 앞선열 ${r.frontCount}개) — ` +
            `flank 만 보임 / 원경 / 가림 과다 → 육면체 미산출`
          : r.kind === 'front-cols'
            ? `앞선 밴드 열 ${r.frontCount}개(< ${opts.minFrontCols}) — 육면체 미산출`
            : r.kind === 'front-mad'
              ? `앞선 잔차(MAD) ${r.frontMadM.toFixed(2)}m > ${opts.frontMadMaxM}m — 마스크 파편화(bridge) 의심 → 육면체 미산출`
              : '접지점 없음 — 육면체 미산출';
      rejected.push({ boxIdx: i, vpdIdx: v.vpdIdx, issues: [why] });
      continue;
    }
    const fit = fitRes.fit;

    // [6] footprint.
    const fp = buildFootprint(fit, axes, opts);
    // #10 폭 관측 실패(부족) 또는 F-1 클램프 발동 → W 출처 'prior' 강등. 원 스팬을 사유에 그대로 남긴다.
    if (fp.wSource === 'prior') {
      vIssues.push(
        `폭 관측 스팬 ${fp.rawSpanM.toFixed(2)}m 가 허용대역 ` +
          `[${(opts.priorW * opts.widthClampLoFactor).toFixed(2)}, ${(opts.priorW * opts.widthClampHiFactor).toFixed(2)}]m ` +
          `밖 — 차폭 ${fp.widthM.toFixed(2)}m 로 강등(W:'prior'). 실루엣 현(chord) 오염 의심`,
      );
    }

    // [7] 높이 = **차종 prior 고정**(관측 불가 — 위 [7] 블록의 논증). 강등이 아니라 **설계**다.
    const heightM = opts.priorH;

    // [8] 바닥 4점 재투영 → 정규화(뷰어 projectCuboid 입력). 하나라도 퇴화하면 미산출.
    const px = projectCuboidPixels(fp.corners, heightM, g);
    if (!px) {
      rejected.push({ boxIdx: i, vpdIdx: v.vpdIdx, issues: ['육면체 재투영 퇴화(지평선 위/카메라 뒤) — 육면체 미산출'] });
      continue;
    }
    const floorQuad = px.slice(0, 4).map((p) => ({ x: p.x / g.imgW, y: p.y / g.imgH })) as NormalizedQuad;

    // ★ G2b — 재투영 앞선(FL–FR) ↔ **앞선 밴드 접지열**의 수직 픽셀거리 중앙값. 관측과 모델을 같은 좌표계에서 비교.
    //   (앞선 밴드로 재는 이유: flank 열은 정의상 앞선에서 멀다 — 전량으로 재면 정상 차량이 시야각 때문에 실패한다.)
    const frontFitResid = frontFitResidPx(fit, axes, px[0], px[1], g);

    // ⚠️ 참고 전용 IoU(성공 기준 아님 — AABB 뭉개기로 배치 오류에 둔감). 응답에만 싣는다.
    const reprojIou = v.bboxPx ? cuboidBboxIou(px, v.bboxPx, g) : null;

    const source: CuboidSource = {
      position: 'observed',
      yaw: 'slot-prior',
      L: 'prior',
      W: fp.wSource,
      H: 'prior', // 관측 불가(차 ≠ 직육면체) — 타입이 리터럴로 못 박는다.
    };
    cuboids.push({
      boxIdx: i,
      vpdIdx: v.vpdIdx,
      cls: v.cls,
      confidence: v.confidence,
      floorQuad,
      floorGround: fp.corners,
      frontGround: fp.front,
      centerGround: fp.center,
      heightM,
      widthM: fp.widthM,
      lengthM: opts.priorL,
      source,
      cleanRatio,
      contactCols: valid.length,
      frontCount: fit.frontCount,
      frontMadM: fit.frontMadM,
      frontFitResidPx: frontFitResid,
      reprojIou,
      issues: vIssues,
    });
  }

  return { cuboids, rejected, axes, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// G2a/G2b 지표 — IoU 를 대체한다(§C). IoU 는 참고 출력으로만 남긴다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 재투영 앞선(FL→FR 픽셀 선분) 과 앞선 밴드 접지열의 수직 픽셀거리 중앙값.
 *
 * 🔴 **배치 지표가 아니다 — 자기참조 잔차다**(검증자 D-1). `tFront` 는 이 밴드의 median 이므로
 *   밴드가 균일하게 밀리면 모델도 함께 밀려 잔차는 불변이다(실증: z=0.30m 오염 → 배치 +1.34m, 이 값 0.00px).
 *   재는 것은 **앞선의 직선성**뿐이다. 게이트 금지 — `VehicleCuboid.frontFitResidPx` 주석 참조.
 */
export function frontFitResidPx(
  fit: LineFit,
  axes: SlotAxes,
  fl: Px,
  fr: Px,
  g: GroundModel,
): number | null {
  const dx = fr.x - fl.x;
  if (Math.abs(dx) < 1e-9) return null; // 앞선이 이미지에서 수직 → 수직거리 정의 불가.
  const devs: number[] = [];
  for (const p of fit.frontBand) {
    const obs = projectToPixel(fromAxisCoords(p.a, p.b, axes), g); // 관측 접지열의 픽셀 위치.
    if (!obs) continue;
    const t = (obs.x - fl.x) / dx;
    const yLine = fl.y + t * (fr.y - fl.y); // 앞선 선분의 같은 x 에서의 y(외삽 허용 — 선형).
    devs.push(Math.abs(obs.y - yLine));
  }
  return devs.length ? median(devs) : null;
}

/** 참고용 IoU: 재투영 육면체 8점의 AABB vs VPD bbox. **성공 기준 아님**(§C — 배치 오류에 둔감). */
function cuboidBboxIou(
  px: readonly Px[],
  bbox: { x1: number; y1: number; x2: number; y2: number },
  g: GroundModel,
): number {
  const xs = px.map((p) => p.x);
  const ys = px.map((p) => p.y);
  const toRect = (x1: number, y1: number, x2: number, y2: number) => ({
    x: x1 / g.imgW,
    y: y1 / g.imgH,
    w: (x2 - x1) / g.imgW,
    h: (y2 - y1) / g.imgH,
  });
  return iou(
    toRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)),
    toRect(bbox.x1, bbox.y1, bbox.x2, bbox.y2),
  );
}
