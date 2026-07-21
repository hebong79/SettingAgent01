import { describe, it, expect } from 'vitest';
import { assignClustersToSpaces } from '../src/capture/spaceAssign.js';
import { pointInPolygon, polygonCentroid } from '../src/domain/polygon.js';
import type { PlaceRoiSpace } from '../src/capture/placeRoi.js';
import type { AggregatedSlot } from '../src/capture/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 신규 순수함수 `assignClustersToSpaces` (클러스터↔주차면 폴리곤
 * **최대 카디널리티 이분매칭(Kuhn)** + centroid 거리 게이트) 단위 검증.
 * 근거: 01_architect_plan.md §2/§5.1 + 02_developer_changes.md §5(그리디→Kuhn 재설계).
 * 경계면: 반환 Map<spaceIdx(0-based), AggregatedSlot>, 미배정 공간은 키 없음.
 */

// ── 테스트 픽스처 헬퍼 ─────────────────────────────────────────────

/** 중심 (cx,cy) 반변 half 축정렬 정사각 폴리곤(무게중심 = 중심). */
function sq(cx: number, cy: number, half = 0.05): NormalizedPoint[] {
  return [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ];
}

/** 중심 (qx,qy) 소형 quad(4점 산술평균 = 중심). 번호판 대표점 시뮬. */
function quadAt(qx: number, qy: number): NormalizedQuad {
  return [
    { x: qx - 0.01, y: qy - 0.01 },
    { x: qx + 0.01, y: qy - 0.01 },
    { x: qx + 0.01, y: qy + 0.01 },
    { x: qx - 0.01, y: qy + 0.01 },
  ];
}

/**
 * AggregatedSlot 팩토리. bbox 중심 = (cx,cy)(w=h=0.04 → x=cx-0.02,y=cy-0.02).
 * quadCenter 주면 plateQuad 부여(대표점=번호판 quad centroid), 없으면 null(대표점=bbox 중심).
 */
function cluster(id: number, cx: number, cy: number, quadCenter?: [number, number]): AggregatedSlot {
  return {
    presetKey: '1:1',
    clusterId: id,
    camIdx: 1,
    presetIdx: 1,
    x: cx - 0.02,
    y: cy - 0.02,
    w: 0.04,
    h: 0.04,
    support: 3,
    occupancyRate: 1,
    plateX: null,
    plateY: null,
    plateW: null,
    plateH: null,
    plateQuad: quadCenter ? quadAt(quadCenter[0], quadCenter[1]) : null,
    confidence: 0.9,
    posSpread: 0,
    angleSpread: null,
    status: 'candidate',
  };
}

const space = (idx: number, cx: number, cy: number, half = 0.05): PlaceRoiSpace => ({ idx, points: sq(cx, cy, half) });

/** 배정 결과를 spaceIdx→clusterId 로 축약(단언 편의). */
function idMap(m: Map<number, AggregatedSlot>): Map<number, number> {
  return new Map([...m.entries()].map(([si, c]) => [si, c.clusterId]));
}

/**
 * 참조용 **선착 그리디**(리팩토링 전 알고리즘): 모든 후보쌍을 비용↑→clusterId↑→spaceIdx↑ 정렬 후
 * 양쪽 미배정일 때만 확정. 최대매칭이 그리디보다 카디널리티가 큼을 대조하기 위한 로컬 재현.
 */
function naiveGreedy(
  spaces: readonly PlaceRoiSpace[],
  clusters: readonly AggregatedSlot[],
  gate: number,
): Map<number, AggregatedSlot> {
  const gate2 = gate * gate;
  const reprOf = (c: AggregatedSlot): NormalizedPoint =>
    c.plateQuad
      ? {
          x: (c.plateQuad[0].x + c.plateQuad[1].x + c.plateQuad[2].x + c.plateQuad[3].x) / 4,
          y: (c.plateQuad[0].y + c.plateQuad[1].y + c.plateQuad[2].y + c.plateQuad[3].y) / 4,
        }
      : { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  const edges: Array<{ ci: number; si: number; cost: number }> = [];
  clusters.forEach((c, ci) => {
    const repr = reprOf(c);
    spaces.forEach((sp, si) => {
      const ctr = polygonCentroid(sp.points);
      const cost = (repr.x - ctr.x) ** 2 + (repr.y - ctr.y) ** 2;
      if (pointInPolygon(sp.points, repr) || cost < gate2) edges.push({ ci, si, cost });
    });
  });
  edges.sort((a, b) => a.cost - b.cost || clusters[a.ci].clusterId - clusters[b.ci].clusterId || a.si - b.si);
  const usedC = new Set<number>();
  const usedS = new Set<number>();
  const out = new Map<number, AggregatedSlot>();
  for (const e of edges) {
    if (usedC.has(e.ci) || usedS.has(e.si)) continue;
    usedC.add(e.ci);
    usedS.add(e.si);
    out.set(e.si, clusters[e.ci]);
  }
  return out;
}

// ── (a) cascade 회수 — 최대매칭의 핵심 ─────────────────────────────

describe('assignClustersToSpaces — (a) cascade 회수(그리디 대비 카디널리티 +1)', () => {
  // spaces[0]=Sα(0.50,0.50) 경쟁 슬롯, spaces[1]=Sβ(0.75,0.50) A 전용.
  // A(id1): Sα(cost 0.0064 최저)·Sβ(0.0289) 둘 다 도달. B(id2): Sα(0.0144)만 도달.
  // 선착 그리디는 최저비용 A-Sα 를 먼저 소비 → B(유일엣지 Sα) 차단 → B 고아(카디널리티 1).
  // 최대매칭(Kuhn)은 증가경로로 A 를 Sβ 로 밀어 Sα 를 B 에 회수 → 둘 다 배정(카디널리티 2).
  const spaces = [space(0, 0.5, 0.5), space(1, 0.75, 0.5)];
  const A = cluster(1, 0.58, 0.5); // Sα 에 더 가깝(0.0064) + Sβ 도달
  const B = cluster(2, 0.38, 0.5); // Sα(0.0144)만 도달
  const gate = 0.23;

  it('최대매칭은 두 슬롯 모두 배정(카디널리티 2)', () => {
    const m = assignClustersToSpaces(spaces, [A, B], { centroidGate: gate });
    expect(m.size).toBe(2);
    // 증가경로 재배치 증거: A 는 최저비용 슬롯 Sα(0) 이 아니라 Sβ(1) 로 밀리고, Sα 는 B 가 회수.
    expect(idMap(m)).toEqual(new Map([[0, 2], [1, 1]]));
  });

  it('선착 그리디였다면 B 는 미배정(카디널리티 1) — 최대매칭이 +1', () => {
    const greedy = naiveGreedy(spaces, [A, B], gate);
    expect(greedy.size).toBe(1); // A-Sα 만, B 고아
    const maxm = assignClustersToSpaces(spaces, [A, B], { centroidGate: gate });
    expect(maxm.size).toBe(greedy.size + 1); // 최대매칭이 그리디보다 정확히 +1 회수
  });
});

// ── (b) 상호배타 1:1 ───────────────────────────────────────────────

describe('assignClustersToSpaces — (b) 상호배타 1:1', () => {
  it('한 클러스터가 두 슬롯에/한 슬롯에 두 클러스터 금지 — 값·키 모두 유일', () => {
    // 완전연결(두 클러스터 두 슬롯 모두 도달)에서도 1:1 매칭.
    const spaces = [space(0, 0.3, 0.5), space(1, 0.5, 0.5)];
    const c1 = cluster(1, 0.32, 0.5);
    const c2 = cluster(2, 0.48, 0.5);
    const m = assignClustersToSpaces(spaces, [c1, c2], { centroidGate: 0.25 });
    expect(m.size).toBe(2);
    const clusterIds = [...m.values()].map((c) => c.clusterId);
    expect(new Set(clusterIds).size).toBe(clusterIds.length); // 클러스터 중복 배정 없음
    expect(new Set(m.keys()).size).toBe(m.size); // 슬롯 중복 없음(Map 키 특성)
    expect(idMap(m)).toEqual(new Map([[0, 1], [1, 2]])); // 근접 슬롯에 각자 배정
  });
});

// ── (c) 빈칸 보존(#clusters < #spaces) ────────────────────────────

describe('assignClustersToSpaces — (c) 빈칸 보존', () => {
  it('#clusters(2) < #spaces(4) → 초과 슬롯은 map 키 부재', () => {
    const spaces = [space(0, 0.2, 0.5), space(1, 0.4, 0.5), space(2, 0.6, 0.5), space(3, 0.8, 0.5)];
    const c1 = cluster(1, 0.2, 0.5); // S0 내부
    const c2 = cluster(2, 0.4, 0.5); // S1 내부
    const m = assignClustersToSpaces(spaces, [c1, c2], { centroidGate: 0.06 }); // 자기 폴리곤만
    expect(m.size).toBe(2);
    expect(idMap(m)).toEqual(new Map([[0, 1], [1, 2]]));
    expect(m.has(2)).toBe(false); // 빈칸 유지
    expect(m.has(3)).toBe(false);
  });
});

// ── (d) 고아 미배정(#clusters > #spaces) ──────────────────────────

describe('assignClustersToSpaces — (d) 고아 미배정', () => {
  it('#clusters(4) > #spaces(2) → 초과 클러스터는 값에 부재', () => {
    const spaces = [space(0, 0.2, 0.5), space(1, 0.4, 0.5)];
    const clusters = [
      cluster(1, 0.2, 0.5),
      cluster(2, 0.4, 0.5),
      cluster(3, 0.6, 0.5), // 폴리곤·게이트 밖 → 후보 0
      cluster(4, 0.8, 0.5), // 폴리곤·게이트 밖 → 후보 0
    ];
    const m = assignClustersToSpaces(spaces, clusters, { centroidGate: 0.06 });
    expect(m.size).toBe(2);
    const assignedIds = new Set([...m.values()].map((c) => c.clusterId));
    expect(assignedIds).toEqual(new Set([1, 2]));
    expect(assignedIds.has(3)).toBe(false); // 고아
    expect(assignedIds.has(4)).toBe(false);
  });

  it('진짜 고아(주행로 차량): 모든 폴리곤 밖 + 전 centroid 거리 > gate → 미배정', () => {
    const spaces = [space(0, 0.2, 0.5), space(1, 0.4, 0.5)];
    const lane = cluster(9, 0.9, 0.1); // 모든 슬롯에서 원거리
    const m = assignClustersToSpaces(spaces, [lane], { centroidGate: 0.1 });
    expect(m.size).toBe(0);
  });
});

// ── (e) 게이트 경계(제곱거리 < gate² 엄격 부등호) ──────────────────

describe('assignClustersToSpaces — (e) 게이트 경계(제곱거리 < gate²)', () => {
  // 대표점(0.5,0.75) 은 폴리곤(중심0.5,0.5·반변0.05) 밖. centroid 까지 거리 0.25 → 제곱거리 ≈0.0625.
  // 후보 조건은 pointInPolygon(밖) OR 제곱거리 < gate². 폴리곤 밖이므로 게이트 단독이 판정.
  // (엄격 부등호의 knife-edge 동률은 IEEE754 노이즈로 관측 불가·의미 없음 → 양측 여유 마진으로 검증.)
  const spaces = [space(0, 0.5, 0.5)];
  const c = cluster(1, 0.5, 0.75); // plateQuad 없음 → bbox 중심(0.5,0.75) 사용

  it('제곱거리 > gate²(gate=0.24 → 0.0576) → 게이트 밖 → 미배정', () => {
    expect(assignClustersToSpaces(spaces, [c], { centroidGate: 0.24 }).size).toBe(0); // 0.0625 < 0.0576 거짓
  });
  it('제곱거리 < gate²(gate=0.26 → 0.0676) → 게이트 안 → 배정', () => {
    const m = assignClustersToSpaces(spaces, [c], { centroidGate: 0.26 }); // 0.0625 < 0.0676 참
    expect(m.size).toBe(1);
    expect(m.get(0)!.clusterId).toBe(1);
  });
});

// ── (f) 대표점 우선순위(plateQuad > bbox 중심) ────────────────────

describe('assignClustersToSpaces — (f) 대표점 우선순위', () => {
  const spaces = [space(0, 0.5, 0.5)]; // 중심 폴리곤

  it('plateQuad 있으면 quad centroid 사용(차량중심이 밖이어도 배정)', () => {
    // bbox 중심 (0.9,0.9) 은 폴리곤·게이트 밖이지만, plateQuad centroid (0.5,0.5) 는 폴리곤 내부.
    const c = cluster(1, 0.9, 0.9, [0.5, 0.5]);
    const m = assignClustersToSpaces(spaces, [c], { centroidGate: 0.1 });
    expect(m.size).toBe(1); // 번호판 중심으로 내부 판정 → 배정
  });

  it('plateQuad 부재 시 차량 bbox 중심 폴백(밖이면 미배정)', () => {
    const c = cluster(1, 0.9, 0.9); // plateQuad 없음 → bbox 중심 (0.9,0.9) 밖
    const m = assignClustersToSpaces(spaces, [c], { centroidGate: 0.1 });
    expect(m.size).toBe(0);
  });
});

// ── (g) 결정성(입력 순서 무관 동일 Map) ──────────────────────────

describe('assignClustersToSpaces — (g) 결정성', () => {
  const spaces = [space(0, 0.3, 0.5), space(1, 0.5, 0.5)];
  const c1 = cluster(1, 0.32, 0.5);
  const c2 = cluster(2, 0.48, 0.5);

  it('동일 입력 → 동일 Map(반복 안정)', () => {
    const a = idMap(assignClustersToSpaces(spaces, [c1, c2], { centroidGate: 0.25 }));
    const b = idMap(assignClustersToSpaces(spaces, [c1, c2], { centroidGate: 0.25 }));
    expect(a).toEqual(b);
  });

  it('clusters 배열 순서를 뒤섞어도 동일 배정(clusterId 방문순 보장)', () => {
    const forward = idMap(assignClustersToSpaces(spaces, [c1, c2], { centroidGate: 0.25 }));
    const reversed = idMap(assignClustersToSpaces(spaces, [c2, c1], { centroidGate: 0.25 }));
    expect(reversed).toEqual(forward);
    expect(forward).toEqual(new Map([[0, 1], [1, 2]]));
  });
});
