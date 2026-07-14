import type { DetectionRow, AggregatedSlot } from './types.js';
import {
  axialWrap,
  center,
  circularMad,
  circularMedianAngle,
  clamp01,
  containsPoint,
  intersectionArea,
  mad,
  median,
  medianPoint,
  plateAngleRad,
  projectedSpan,
  synthesizePlateQuad,
  weightedMedian,
} from '../domain/geometry.js';
import type { NormalizedRect, NormalizedQuad, NormalizedPoint } from '../domain/types.js';

// ── 강건 통계 상수(모듈 named const — floorRoi 선례, config 미승격 §3.6). ──
/** 이상치 MAD 컷을 적용할 최소 멤버 수(미만은 컷 생략 = 현행 보존). */
const ROBUST_MIN_MEMBERS = 4;
/** MAD→σ 정규분포 일치 상수. */
const MAD_SCALE = 1.4826;
/** ≈3σ 이상치 컷 계수. */
const MAD_K = 3.0;
/** 정규화좌표 MAD 하한(동일좌표 과민제거 방지). */
const MAD_FLOOR = 1e-4;
/** 지지수 신뢰 포화 관측 수. */
const SUPPORT_SAT = 10;
/** 위치 퍼짐 신뢰 0 도달 임계(= clusterDist 규모). */
const POS_SPREAD_MAX = 0.06;
/** 각도 분산 신뢰 0 도달 임계(rad, ~20°). */
const ANGLE_SPREAD_MAX = 0.35;
/** 신뢰도 가중(점유·지지·위치·각도, 합=1). */
const W_OCC = 0.35;
const W_SUP = 0.25;
const W_POS = 0.25;
const W_ANG = 0.15;

/**
 * 결정형 시공간 집계 (설계서 §4.2). DB·IO 비의존 순수함수.
 * 입력 = 평면 DetectionRow 배열 + 프리셋별 총 라운드 맵, 출력 = AggregatedSlot 배열.
 * 좌표는 검출 멤버 중앙값으로만 산출(LLM 미개입 — 좌표 불변식 §0-4).
 */
export interface AggregateOptions {
  /** 클러스터 병합 거리 임계(중심 간 유클리드 거리, 정규화). */
  clusterDist: number;
  /** 슬롯으로 인정할 최소 지지수(클러스터 멤버 검출 수). 미만은 rejected. */
  clusterMinSupport: number;
  /** 집계 대상 최소 신뢰도(미만 검출 제외). */
  minConfidence: number;
}

/** 클러스터 멤버(rect + 선택적 OBB quad + conf). plate 멤버만 quad 를 보유(vehicle 은 undefined). */
interface Member {
  rect: NormalizedRect;
  quad?: NormalizedQuad;
  conf: number;
}

interface Cluster {
  members: Member[];
  rounds: Set<number>; // 멤버가 등장한 distinct round_idx (occupancy 분자)
}

function memberOf(d: DetectionRow): Member {
  return { rect: { x: d.x, y: d.y, w: d.w, h: d.h }, quad: d.quad, conf: d.conf };
}

/** 두 사각형 중심 간 유클리드 거리. */
function dist(a: NormalizedRect, b: NormalizedRect): number {
  const ca = center(a);
  const cb = center(b);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
}

/** 멤버 중앙값 대표 bbox(지터에 평균보다 강건). */
function medianRect(rects: NormalizedRect[]): NormalizedRect {
  return {
    x: median(rects.map((r) => r.x)),
    y: median(rects.map((r) => r.y)),
    w: median(rects.map((r) => r.w)),
    h: median(rects.map((r) => r.h)),
  };
}

/** 클러스터 멤버들의 대표 rect(중앙값). */
function clusterRect(c: Cluster): NormalizedRect {
  return medianRect(c.members.map((m) => m.rect));
}

/** 한 프리셋의 검출을 그리디 클러스터링(중심 거리 임계 이내면 같은 클러스터). */
function clusterDetections(dets: DetectionRow[], clusterDist: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const d of dets) {
    const m = memberOf(d);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const cd = dist(clusterRect(clusters[i]), m.rect);
      if (cd < bestD) {
        bestD = cd;
        best = i;
      }
    }
    if (best >= 0 && bestD <= clusterDist) {
      clusters[best].members.push(m);
      clusters[best].rounds.add(d.roundIdx);
    } else {
      clusters.push({ members: [m], rounds: new Set([d.roundIdx]) });
    }
  }
  return clusters;
}

/** quad 4모서리 평균 중심. */
function quadCentroid(q: NormalizedQuad): NormalizedPoint {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

/**
 * 강건 대표 bbox(개선 ②): conf 가중 median + N≥ROBUST_MIN_MEMBERS 시 center MAD 이상치 컷.
 * posSpread = 생존 center 의 MAD 기반 공간 퍼짐 스칼라. 소표본(<MIN)·N=1 은 가중 median 만(등가중=median 폴백).
 */
function robustRect(members: Member[]): { rect: NormalizedRect; posSpread: number } {
  let survivors = members;
  if (members.length >= ROBUST_MIN_MEMBERS) {
    const cxs = members.map((m) => center(m.rect).cx);
    const cys = members.map((m) => center(m.rect).cy);
    const medx = median(cxs);
    const medy = median(cys);
    const sx = MAD_SCALE * mad(cxs, medx);
    const sy = MAD_SCALE * mad(cys, medy);
    const kept = members.filter((m) => {
      const c = center(m.rect);
      const outX = sx >= MAD_FLOOR && Math.abs(c.cx - medx) > MAD_K * sx;
      const outY = sy >= MAD_FLOOR && Math.abs(c.cy - medy) > MAD_K * sy;
      return !(outX || outY);
    });
    if (kept.length > 0) survivors = kept; // 생존 0 → 컷 취소(전체 사용).
  }
  const ws = survivors.map((m) => m.conf);
  const rect: NormalizedRect = {
    x: weightedMedian(survivors.map((m) => m.rect.x), ws),
    y: weightedMedian(survivors.map((m) => m.rect.y), ws),
    w: weightedMedian(survivors.map((m) => m.rect.w), ws),
    h: weightedMedian(survivors.map((m) => m.rect.h), ws),
  };
  const scx = survivors.map((m) => center(m.rect).cx);
  const scy = survivors.map((m) => center(m.rect).cy);
  const posSpread = Math.hypot(MAD_SCALE * mad(scx), MAD_SCALE * mad(scy));
  return { rect, posSpread };
}

/**
 * 강건 번호판 자세(개선 ①+②): 클러스터 quad 멤버 각도를 축 순환 median 으로 집계 → 대표 quad 합성.
 * 소표본 폴백: quad 0 → null, quad 1 → 원본(현행 최근접=유일과 동일, 왜곡 없음).
 * ≥2: θ_rep(순환 median) + 강건 중심(centroid medianPoint) + 강건 크기(가중 median span) → synthesizePlateQuad.
 * N≥ROBUST_MIN_MEMBERS 시 각도·좌표 MAD 이상치 컷 후 재계산.
 */
function robustPlatePose(members: Member[]): { quad: NormalizedQuad | null; angleSpread: number | null } {
  const withQuad = members.filter((m) => m.quad);
  if (withQuad.length === 0) return { quad: null, angleSpread: null };
  if (withQuad.length === 1) return { quad: withQuad[0].quad!, angleSpread: null };

  const angles = withQuad.map((m) => plateAngleRad(m.quad!));
  const theta0 = circularMedianAngle(angles, withQuad.map((m) => m.conf));

  let survivors = withQuad;
  if (withQuad.length >= ROBUST_MIN_MEMBERS) {
    const angScaled = MAD_K * MAD_SCALE * circularMad(angles, theta0);
    const cxs = withQuad.map((m) => center(m.rect).cx);
    const cys = withQuad.map((m) => center(m.rect).cy);
    const medx = median(cxs);
    const medy = median(cys);
    const sx = MAD_SCALE * mad(cxs, medx);
    const sy = MAD_SCALE * mad(cys, medy);
    const kept = withQuad.filter((m, i) => {
      const angOut = angScaled > 0 && Math.abs(axialWrap(angles[i] - theta0)) > angScaled;
      const c = center(m.rect);
      const posOut =
        (sx >= MAD_FLOOR && Math.abs(c.cx - medx) > MAD_K * sx) ||
        (sy >= MAD_FLOOR && Math.abs(c.cy - medy) > MAD_K * sy);
      return !(angOut || posOut);
    });
    if (kept.length > 0) survivors = kept;
  }

  const sAngles = survivors.map((m) => plateAngleRad(m.quad!));
  const sWs = survivors.map((m) => m.conf);
  const thetaRep = circularMedianAngle(sAngles, sWs);
  const c = medianPoint(survivors.map((m) => quadCentroid(m.quad!)));
  const ux = Math.cos(thetaRep);
  const uy = Math.sin(thetaRep);
  const vx = -Math.sin(thetaRep);
  const vy = Math.cos(thetaRep);
  const w = weightedMedian(survivors.map((m) => projectedSpan(m.quad!, ux, uy)), sWs);
  const h = weightedMedian(survivors.map((m) => projectedSpan(m.quad!, vx, vy)), sWs);
  const quad = synthesizePlateQuad(c, thetaRep, w, h);
  const angleSpread = circularMad(sAngles, thetaRep);
  return { quad, angleSpread };
}

/**
 * 슬롯 종합 신뢰도(개선 ③) 0~1. 점유·지지·위치·각도 서브스코어의 가용항 가중평균.
 * plate 부재(angleSpread=null) 시 각도항 제외 후 잔여 가중 재정규화(무번호판 슬롯 불이익 방지).
 */
function slotConfidence(p: {
  support: number;
  occupancyRate: number;
  posSpread: number;
  angleSpread: number | null;
}): number {
  const sSup = Math.min(1, p.support / SUPPORT_SAT);
  const sOcc = clamp01(p.occupancyRate);
  const sPos = 1 - clamp01(p.posSpread / POS_SPREAD_MAX);
  const terms: Array<{ w: number; s: number }> = [
    { w: W_OCC, s: sOcc },
    { w: W_SUP, s: sSup },
    { w: W_POS, s: sPos },
  ];
  if (p.angleSpread !== null) {
    terms.push({ w: W_ANG, s: 1 - clamp01(p.angleSpread / ANGLE_SPREAD_MAX) });
  }
  let num = 0;
  let den = 0;
  for (const t of terms) {
    num += t.w * t.s;
    den += t.w;
  }
  return den > 0 ? num / den : 0;
}

export function aggregate(
  dets: DetectionRow[],
  presetRounds: Map<string, number>,
  opts: AggregateOptions,
): AggregatedSlot[] {
  // 프리셋별로 분리(다른 프리셋 좌표계 혼합 금지).
  const byPreset = new Map<string, DetectionRow[]>();
  for (const d of dets) {
    if (d.conf < opts.minConfidence) continue;
    const key = `${d.camIdx}:${d.presetIdx}`;
    let arr = byPreset.get(key);
    if (!arr) byPreset.set(key, (arr = []));
    arr.push(d);
  }

  const out: AggregatedSlot[] = [];
  for (const [key, presetDets] of byPreset) {
    const vehicles = presetDets.filter((d) => d.kind === 'vehicle');
    const plates = presetDets.filter((d) => d.kind === 'plate');
    if (vehicles.length === 0) continue;

    const camIdx = vehicles[0].camIdx;
    const presetIdx = vehicles[0].presetIdx;
    const totalRounds = presetRounds.get(key) ?? 0;

    const vClusters = clusterDetections(vehicles, opts.clusterDist);
    const pClusters = clusterDetections(plates, opts.clusterDist);
    // 번호판 클러스터 강건 대표 bbox(매칭·저장용) + 클러스터 참조(대표 자세 산출용).
    const plateReps = pClusters.map((c) => ({ rect: robustRect(c.members).rect, cluster: c }));

    let clusterId = 0;
    for (const c of vClusters) {
      clusterId += 1;
      const { rect: rep, posSpread } = robustRect(c.members);
      const support = c.members.length;
      const occupancyRate = totalRounds > 0 ? c.rounds.size / totalRounds : 0;
      const status: AggregatedSlot['status'] = support < opts.clusterMinSupport ? 'rejected' : 'candidate';

      // 번호판 귀속: 번호판 대표 중심이 vehicle 대표 ROI 내부 + 겹침 최대(기존 matchPlatesToSlots 규칙).
      let plate: NormalizedRect | null = null;
      let plateCluster: Cluster | null = null;
      let bestOverlap = 0;
      for (const pr of plateReps) {
        const cc = center(pr.rect);
        if (!containsPoint(rep, cc.cx, cc.cy)) continue;
        const overlap = intersectionArea(rep, pr.rect);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          plate = pr.rect;
          plateCluster = pr.cluster;
        }
      }
      // 대표 자세: 매칭된 번호판 클러스터의 축 순환 median 각도 + 강건 중심/크기 → 합성 quad. 부재 시 null.
      const pose = plateCluster
        ? robustPlatePose(plateCluster.members)
        : { quad: null, angleSpread: null };
      const confidence = slotConfidence({ support, occupancyRate, posSpread, angleSpread: pose.angleSpread });

      out.push({
        presetKey: key,
        clusterId,
        camIdx,
        presetIdx,
        x: rep.x,
        y: rep.y,
        w: rep.w,
        h: rep.h,
        support,
        occupancyRate,
        plateX: plate ? plate.x : null,
        plateY: plate ? plate.y : null,
        plateW: plate ? plate.w : null,
        plateH: plate ? plate.h : null,
        plateQuad: pose.quad,
        confidence,
        posSpread,
        angleSpread: pose.angleSpread,
        status,
      });
    }
  }
  return out;
}
