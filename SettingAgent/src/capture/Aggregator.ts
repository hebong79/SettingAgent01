import type { DetectionRow, AggregatedSlot } from './types.js';
import { center, containsPoint, intersectionArea, median } from '../domain/geometry.js';
import type { NormalizedRect } from '../domain/types.js';

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

interface Cluster {
  members: NormalizedRect[];
  rounds: Set<number>; // 멤버가 등장한 distinct round_idx (occupancy 분자)
}

function rectOf(d: DetectionRow): NormalizedRect {
  return { x: d.x, y: d.y, w: d.w, h: d.h };
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

/** 한 프리셋의 검출을 그리디 클러스터링(중심 거리 임계 이내면 같은 클러스터). */
function clusterDetections(dets: DetectionRow[], clusterDist: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const d of dets) {
    const r = rectOf(d);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const cd = dist(medianRect(clusters[i].members), r);
      if (cd < bestD) {
        bestD = cd;
        best = i;
      }
    }
    if (best >= 0 && bestD <= clusterDist) {
      clusters[best].members.push(r);
      clusters[best].rounds.add(d.roundIdx);
    } else {
      clusters.push({ members: [r], rounds: new Set([d.roundIdx]) });
    }
  }
  return clusters;
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
    // 번호판 클러스터 대표 bbox(매칭용).
    const plateReps = pClusters.map((c) => medianRect(c.members));

    let clusterId = 0;
    for (const c of vClusters) {
      clusterId += 1;
      const rep = medianRect(c.members);
      const support = c.members.length;
      const occupancyRate = totalRounds > 0 ? c.rounds.size / totalRounds : 0;
      const status: AggregatedSlot['status'] = support < opts.clusterMinSupport ? 'rejected' : 'candidate';

      // 번호판 귀속: 번호판 대표 중심이 vehicle 대표 ROI 내부 + 겹침 최대(기존 matchPlatesToSlots 규칙).
      let plate: NormalizedRect | null = null;
      let bestOverlap = 0;
      for (const pr of plateReps) {
        const cc = center(pr);
        if (!containsPoint(rep, cc.cx, cc.cy)) continue;
        const overlap = intersectionArea(rep, pr);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          plate = pr;
        }
      }

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
        status,
      });
    }
  }
  return out;
}
