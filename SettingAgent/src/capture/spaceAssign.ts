// 클러스터↔주차면 폴리곤 전역-그리디 상호배타 1:1 배정(순수 함수, 설계서 §2).
// plateMatch.ts 의 "전역 min-cost maximal matching" 패턴만 차용 — 기하 도메인은 별개(rect+겹침 vs 폴리곤+거리).
// DB·IO 비의존. 한 프리셋 범위의 배정만 담당. LLM 미개입(결정형 기하).

import type { NormalizedPoint } from '../domain/types.js';
import { pointInPolygon, polygonCentroid } from '../domain/polygon.js';
import type { PlaceRoiSpace } from './placeRoi.js';
import type { AggregatedSlot } from './types.js';

/** quad 4점 산술평균 중심(번호판 근사 중심, D2). */
function quadCentroid(quad: readonly NormalizedPoint[]): NormalizedPoint {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

/** 클러스터 대표점: 번호판 quad 중심 우선(바닥 근접), 부재 시 차량 bbox 중심 폴백(§2.1). */
function reprPoint(c: AggregatedSlot): NormalizedPoint {
  if (c.plateQuad) return quadCentroid(c.plateQuad);
  return { x: c.x + c.w / 2, y: c.y + c.h / 2 };
}

/**
 * 한 프리셋의 클러스터들을 주차면 폴리곤들에 **최대 카디널리티 이분매칭**으로 상호배타 1:1 배정한다.
 *
 * - 대표점 = 번호판 quad 중심(우선) 또는 차량 bbox 중심(폴백).
 * - 후보(유효)쌍 조건(§2.2) = `pointInPolygon(space.points, repr)` **OR** 대표점↔폴리곤 centroid 거리 < centroidGate.
 *   (거리 게이트가 인접 슬롯 회수의 핵심 회복 메커니즘 — 폴리곤 포함 단독으로는 충돌 버그 미해결.)
 * - 비용 = 대표점↔폴리곤 centroid 제곱거리(§2.3) — 인접 슬롯 리스트의 **선호 순서**로만 사용(정렬 후 선착 그리디가 아님).
 *
 * ★ 알고리즘: **Kuhn 증가경로**(max-cardinality bipartite matching). 라이브 검증에서 "비용↑ 정렬 후 선착 그리디"가
 *   값싼 엣지를 먼저 소비해 회수 가능한 클러스터를 막는 cascade(greedy 15 vs 최대매칭 17)를 일으켰다 → 최대매칭으로 교체.
 *   - **결정성 + 비용선호**: 클러스터는 clusterId 오름차순으로 증가경로 탐색, 각 클러스터의 인접 슬롯은
 *     비용 오름(동률 spaceIdx 오름)으로 정렬 → 매 실행 동일 결과 + 저비용 엣지 우선 매칭.
 *   - N≤7 소규모라 O(V·E) 충분(Hungarian 불요).
 *
 * @param spaces  한 프리셋의 주차면 폴리곤들(배열 순서 = presetSlotIdx-1)
 * @param clusters 같은 프리셋의 accepted 클러스터들
 * @param opts.centroidGate 거리 게이트(정규화). 인접 슬롯 회수·먼 슬롯 차단 경계.
 * @returns key = spaces 배열 인덱스(0-based) → 배정된 클러스터. 미배정 공간은 키 없음.
 */
export function assignClustersToSpaces(
  spaces: readonly PlaceRoiSpace[],
  clusters: readonly AggregatedSlot[],
  opts: { centroidGate: number },
): Map<number, AggregatedSlot> {
  const gate2 = opts.centroidGate * opts.centroidGate; // 거리²와 비교(sqrt 불요).

  // 각 클러스터의 인접 슬롯(유효 후보) 리스트를 비용 오름(동률 spaceIdx 오름)으로 구성.
  const adj: number[][] = clusters.map((cluster) => {
    const repr = reprPoint(cluster);
    const edges: Array<{ spaceIdx: number; cost: number }> = [];
    for (let si = 0; si < spaces.length; si++) {
      const centroid = polygonCentroid(spaces[si].points);
      const dx = repr.x - centroid.x;
      const dy = repr.y - centroid.y;
      const cost = dx * dx + dy * dy;
      if (pointInPolygon(spaces[si].points, repr) || cost < gate2) {
        edges.push({ spaceIdx: si, cost });
      }
    }
    edges.sort((a, b) => a.cost - b.cost || a.spaceIdx - b.spaceIdx);
    return edges.map((e) => e.spaceIdx);
  });

  // 클러스터를 clusterId 오름차순으로 방문(결정성) — clusters 배열 순서와 무관.
  const order = clusters.map((_, ci) => ci).sort((a, b) => clusters[a].clusterId - clusters[b].clusterId);

  const matchOfSpace = new Array<number>(spaces.length).fill(-1); // 슬롯 → 배정 클러스터 인덱스(-1=미배정).
  const tryKuhn = (u: number, seen: boolean[]): boolean => {
    for (const v of adj[u]) {
      if (seen[v]) continue;
      seen[v] = true;
      if (matchOfSpace[v] === -1 || tryKuhn(matchOfSpace[v], seen)) {
        matchOfSpace[v] = u;
        return true;
      }
    }
    return false;
  };
  for (const u of order) tryKuhn(u, new Array<boolean>(spaces.length).fill(false));

  const assigned = new Map<number, AggregatedSlot>();
  for (let si = 0; si < spaces.length; si++) {
    if (matchOfSpace[si] !== -1) assigned.set(si, clusters[matchOfSpace[si]]);
  }
  return assigned;
}
