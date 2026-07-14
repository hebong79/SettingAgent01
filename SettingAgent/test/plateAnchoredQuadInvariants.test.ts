import { describe, it, expect } from 'vitest';
import {
  buildPlateAnchoredQuad,
  resolveFloorPolygon,
  expandPolygonToContainRect,
  predictPlateRect,
  normalizePolygon,
} from '../src/capture/floorRoi.js';
import { plateAngleRad, rectToQuad } from '../src/domain/geometry.js';
import { rectCorners } from '../src/domain/polygon.js';
import type { NormalizedRect, NormalizedPolygon, NormalizedQuad, NormalizedPoint } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 번호판(LPD) 기준 floor ROI 재정의 — 설계서 §6 불변식 13종.
 * 정확 좌표 대신 불변식(정점수·범위·볼록·포함·각도추종·좌우중앙·세로약간앞·멱등)을 검증한다.
 * plateQuad 순서 규약 = TL,TR,BR,BL(= plateAngleRad·rectToQuad·reviewer/finalizer 전 구간 동일).
 */

// ── 공용 헬퍼 ───────────────────────────────────────────────
const inRange = (v: number) => v >= -1e-9 && v <= 1 + 1e-9;
const allIn = (poly: NormalizedPolygon) => poly.every((p) => inRange(p.x) && inRange(p.y));

/** 점이 볼록 N각형 내부/경계에 있는지(cross product 부호 일관, 경계 포함). */
function pointInConvex(p: NormalizedPoint, poly: NormalizedPolygon): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
const containsRect = (poly: NormalizedPolygon, r: NormalizedRect) =>
  rectCorners(r).every((c) => pointInConvex(c, poly));
const containsQuad = (poly: NormalizedPolygon, q: NormalizedQuad) => q.every((c) => pointInConvex(c, poly));

/** 로컬 회전 축(구현과 동일 규약): nb=앞→뒤(이미지 위), u=좌우. nb.y>0 이면 부호 반전. */
function axes(theta: number): { nb: NormalizedPoint; u: NormalizedPoint } {
  let nb = { x: Math.sin(theta), y: -Math.cos(theta) };
  if (nb.y > 0) nb = { x: -nb.x, y: -nb.y };
  return { nb, u: { x: -nb.y, y: nb.x } };
}
const dot = (p: NormalizedPoint, a: NormalizedPoint) => p.x * a.x + p.y * a.y;
const centroid = (poly: NormalizedPolygon): NormalizedPoint => ({
  x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
  y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});
const plateCenter = (q: NormalizedQuad): NormalizedPoint => ({
  x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
  y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
});

/** 중심 (cx,cy), 반폭 hw, 반높이 hh 의 사각형을 phi(rad) 회전한 OBB quad(TL,TR,BR,BL, 이미지 y-down). */
function rotatedPlateQuad(cx: number, cy: number, hw: number, hh: number, phi: number): NormalizedQuad {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const rot = (x: number, y: number): NormalizedPoint => ({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  return [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
}

/** 최소 각도차(rad, -pi~pi 로 wrap). */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
const DEG3 = (3 * Math.PI) / 180;

/**
 * 앞변 방향각(rad). 앞변 = 두 앞(front=-nb) 정점을 잇는 모서리.
 * 앞/뒤는 nb 투영으로 식별(단순 y 최대는 대회전 시 뒤 정점이 앞 정점보다 y 큼 → 오식별).
 * 좌→우(dx>0)로 방향 정규화. 캐노니컬 시작정점(회전 시 FL/FR 이동)과 무관하게 앞변 안정 식별.
 */
function frontEdgeAngle(q: NormalizedPolygon, theta: number): number {
  const { nb } = axes(theta);
  const idx = [0, 1, 2, 3].sort((a, b) => dot(q[a], nb) - dot(q[b], nb));
  const [f0, f1] = [idx[0], idx[1]]; // nb 투영 최소 두 정점 = 앞 쌍.
  let dir = { x: q[f1].x - q[f0].x, y: q[f1].y - q[f0].y };
  if (dir.x < 0) dir = { x: -dir.x, y: -dir.y };
  return Math.atan2(dir.y, dir.x);
}

// ── 1. plateAngleRad (불변식 9) ──────────────────────────────
describe('plateAngleRad — 번호판 OBB 기울기(§6-9)', () => {
  it('축정렬 quad(rectToQuad) → 0', () => {
    const q = rectToQuad({ x: 0.2, y: 0.5, w: 0.2, h: 0.06 });
    expect(plateAngleRad(q)).toBeCloseTo(0, 6);
  });

  it('알려진 회전 15°·30° → 기대각 ±ε', () => {
    for (const deg of [15, 30, -20, 45]) {
      const phi = (deg * Math.PI) / 180;
      const q = rotatedPlateQuad(0.5, 0.5, 0.08, 0.03, phi);
      expect(plateAngleRad(q)).toBeCloseTo(phi, 6);
    }
  });

  it('퇴화(면적 0, 4점 동일) → 0', () => {
    const p = { x: 0.5, y: 0.5 };
    expect(plateAngleRad([p, p, p, p])).toBe(0);
  });

  it('점순서 뒤바뀜(배열 reverse=감김 반전) 강건 — 각도 불변', () => {
    const phi = (22 * Math.PI) / 180;
    const q = rotatedPlateQuad(0.5, 0.5, 0.08, 0.03, phi);
    const rev = [q[3], q[2], q[1], q[0]] as NormalizedQuad; // 배열 순서 반전
    expect(plateAngleRad(rev)).toBeCloseTo(plateAngleRad(q), 9);
  });
});

// ── 2. buildPlateAnchoredQuad (불변식 1·2·3·4·5·7·8) ──────────
describe('buildPlateAnchoredQuad — 배치 불변식(§6-1~8)', () => {
  // 번호판 span 이 작아 D 는 bbox 유도값이 지배(정상 경로): 포함·중앙·front-ratio 정확 성립.
  const vehicle: NormalizedRect = { x: 0.35, y: 0.4, w: 0.3, h: 0.3 };
  const buildRot = (deg: number): { q: NormalizedQuad; plate: NormalizedQuad; theta: number } => {
    const phi = (deg * Math.PI) / 180;
    const plate = rotatedPlateQuad(0.5, 0.55, 0.06, 0.02, phi);
    return { q: buildPlateAnchoredQuad(vehicle, plate), plate, theta: plateAngleRad(plate) };
  };

  it('정확히 4점 · 모두 0~1(§6-1·2)', () => {
    for (const deg of [0, 15, 30, -25]) {
      const { q } = buildRot(deg);
      expect(q).toHaveLength(4);
      expect(allIn(q)).toBe(true);
    }
  });

  it('캐노니컬 시계방향 [FL,FR,RR,RL]: q0.y>q3.y, q1.y>q2.y, q0.x<q1.x(§6-3)', () => {
    for (const deg of [0, 15, -15]) {
      const { q } = buildRot(deg);
      expect(q[0].y).toBeGreaterThan(q[3].y);
      expect(q[1].y).toBeGreaterThan(q[2].y);
      expect(q[0].x).toBeLessThan(q[1].x);
    }
  });

  it('번호판 quad 4모서리가 사변형 내부 포함(§6-4)', () => {
    for (const deg of [0, 15, 30, -25]) {
      const { q, plate } = buildRot(deg);
      expect(containsQuad(q, plate)).toBe(true);
    }
  });

  it('앞(하단)변 각도가 plateAngleRad 추종 ≤3°(§6-5·2)', () => {
    for (const deg of [0, 15, 30, -25]) {
      const { q, theta } = buildRot(deg);
      expect(Math.abs(angleDiff(frontEdgeAngle(q, theta), theta))).toBeLessThanOrEqual(DEG3);
    }
  });

  it('각도 부호 일치: +기울기→앞변 각>0, −기울기→<0(§6-6)', () => {
    const pos = buildRot(20);
    const neg = buildRot(-20);
    expect(frontEdgeAngle(pos.q, pos.theta)).toBeGreaterThan(0);
    expect(frontEdgeAngle(neg.q, neg.theta)).toBeLessThan(0);
  });

  it('번호판 중심 u축 투영이 사변형 좌우중앙 근접 |Δ|≤W의 10%(§6-7)', () => {
    for (const deg of [0, 15, 30, -25]) {
      const { q, plate, theta } = buildRot(deg);
      const { u } = axes(theta);
      const c = centroid(q);
      const pc = plateCenter(plate);
      const dU = Math.abs(dot(pc, u) - dot(c, u));
      // 사변형 u축 폭(대략) = 최대-최소 u 투영.
      const us = q.map((p) => dot(p, u));
      const W = Math.max(...us) - Math.min(...us);
      expect(dU).toBeLessThanOrEqual(W * 0.1);
    }
  });

  it('번호판 중심 nb축이 앞변 쪽(frontDist<backDist), ~0.42D(§6-8)', () => {
    for (const deg of [0, 15, 30, -25]) {
      const { q, plate, theta } = buildRot(deg);
      const { nb } = axes(theta);
      const ns = q.map((p) => dot(p, nb));
      const minN = Math.min(...ns); // 앞(-nb)
      const maxN = Math.max(...ns); // 뒤(+nb)
      const pcN = dot(plateCenter(plate), nb);
      const frontDist = pcN - minN;
      const backDist = maxN - pcN;
      expect(frontDist).toBeLessThan(backDist);
      // 앞변 비율 ≈ PLATE_FRONT_RATIO(0.42), 관대한 허용(clamp 없음 케이스).
      expect(frontDist / (maxN - minN)).toBeGreaterThan(0.3);
      expect(frontDist / (maxN - minN)).toBeLessThan(0.5);
    }
  });
});

// ── 3. 기운 plate 회전·near-vertical 퇴화 폴백(불변식 6·11) ────
describe('회전·near-vertical 퇴화 폴백(§6-6·11)', () => {
  const vehicle: NormalizedRect = { x: 0.35, y: 0.4, w: 0.3, h: 0.3 };

  it('near-vertical θ≈±90° → 유효 4점·0~1(퇴화 폴백 정상)', () => {
    for (const deg of [88, 90, 92, -90]) {
      const plate = rotatedPlateQuad(0.5, 0.5, 0.05, 0.02, (deg * Math.PI) / 180);
      const q = buildPlateAnchoredQuad(vehicle, plate);
      expect(q).toHaveLength(4);
      expect(allIn(q)).toBe(true);
    }
  });
});

// ── 4. rect plate / plate 부재 = predictPlateRect 경로(불변식 10) ─
describe('rect plate / plate 부재 → 각도 0·포함·중앙·front-ratio(§6-10)', () => {
  const vehicle: NormalizedRect = { x: 0.3, y: 0.35, w: 0.35, h: 0.35 };

  it('plate 부재: 예상 번호판 포함 + 중앙 + frontDist<backDist', () => {
    const q = buildPlateAnchoredQuad(vehicle);
    const pr = predictPlateRect(vehicle);
    expect(q).toHaveLength(4);
    expect(allIn(q)).toBe(true);
    expect(containsRect(q, pr)).toBe(true);
    const { nb, u } = axes(0);
    const c = centroid(q);
    const pc = { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 };
    expect(Math.abs(dot(pc, u) - dot(c, u))).toBeLessThan(0.05);
    const ns = q.map((p) => dot(p, nb));
    const pcN = dot(pc, nb);
    expect(pcN - Math.min(...ns)).toBeLessThan(Math.max(...ns) - pcN);
  });

  it('rect plate(rectToQuad, 축정렬) → 각도 0(하단변 수평 ≤3°)', () => {
    const plate = rectToQuad({ x: 0.45, y: 0.6, w: 0.1, h: 0.04 });
    const q = buildPlateAnchoredQuad(vehicle, plate);
    const edge = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
    expect(Math.abs(edge)).toBeLessThanOrEqual(DEG3);
    expect(containsQuad(q, plate)).toBe(true);
  });
});

// ── 5. resolveFloorPolygon(권한 역전: LLM 메인 + 폴백 빌더 + 안전망) ─────
describe('resolveFloorPolygon — LLM 메인 + 폴백 빌더 + 안전망(§6)', () => {
  const vehicle: NormalizedRect = { x: 0.35, y: 0.4, w: 0.3, h: 0.2 };

  it('LLM=null → 빌더 폴백(유효·번호판 포함)', () => {
    const plate = rotatedPlateQuad(0.5, 0.55, 0.06, 0.02, (18 * Math.PI) / 180);
    const poly = resolveFloorPolygon(null, vehicle, plate);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    expect(allIn(poly)).toBe(true);
    expect(containsQuad(poly, plate)).toBe(true);
  });

  it('LLM 4점 제공: LLM 이 메인(각도=LLM 축정렬, plate 각도로 재앵커 안함)', () => {
    const phi = (25 * Math.PI) / 180;
    const plate = rotatedPlateQuad(0.5, 0.55, 0.06, 0.02, phi);
    // 축정렬(각도 0) LLM 사변형 — 권한 역전 후 결과 각도가 여기(LLM)를 따른다.
    const llm = [
      { x: 0.4, y: 0.7 },
      { x: 0.6, y: 0.7 },
      { x: 0.6, y: 0.5 },
      { x: 0.4, y: 0.5 },
    ];
    const poly = resolveFloorPolygon(llm, vehicle, plate);
    // LLM 유효 → normalizePolygon(llm) 그대로 채택(번호판 각도 재앵커 없음).
    expect(poly).toEqual(normalizePolygon(llm));
    // 앞변 각도는 LLM(≈0)을 따르고 plate 의 25°가 아니다.
    expect(Math.abs(angleDiff(frontEdgeAngle(poly, 0), 0))).toBeLessThanOrEqual(DEG3);
    expect(Math.abs(angleDiff(frontEdgeAngle(poly, 0), phi))).toBeGreaterThan(DEG3);
  });

  it('LLM 유효 폴리곤을 그대로 채택(깊은 LLM → 빌더보다 깊음)', () => {
    const plate = rectToQuad({ x: 0.46, y: 0.55, w: 0.08, h: 0.03 });
    const { nb } = axes(0);
    const nbSpan = (poly: NormalizedPolygon) => {
      const ns = poly.map((p) => dot(p, nb));
      return Math.max(...ns) - Math.min(...ns);
    };
    const base = buildPlateAnchoredQuad(vehicle, plate); // LLM 없음(폴백 빌더)
    const deepLlm = [
      { x: 0.4, y: 0.9 },
      { x: 0.6, y: 0.9 },
      { x: 0.6, y: 0.3 },
      { x: 0.4, y: 0.3 },
    ];
    const resolved = resolveFloorPolygon(deepLlm, vehicle, plate);
    // 권한 역전: LLM 유효 → normalizePolygon(deepLlm) 그대로(빌더 미개입).
    expect(resolved).toEqual(normalizePolygon(deepLlm));
    expect(nbSpan(resolved)).toBeGreaterThan(nbSpan(base) + 0.1);
  });

  it('경계 clamp 후 포함강제 안전망: 밖 plateRect 포함 + 멱등(no-op)', () => {
    const plate = rectToQuad({ x: 0.46, y: 0.55, w: 0.06, h: 0.03 });
    // 빌더 사변형 밖에 있는 plateRect(안전망이 확장해야 함).
    const outsideRect: NormalizedRect = { x: 0.05, y: 0.9, w: 0.12, h: 0.06 };
    const poly = resolveFloorPolygon(null, vehicle, plate, outsideRect);
    expect(allIn(poly)).toBe(true);
    expect(containsRect(poly, outsideRect)).toBe(true);
    // 멱등: 같은 rect 로 다시 확장하면 no-op(동일).
    const again = expandPolygonToContainRect(poly, outsideRect);
    expect(again).toEqual(poly);
  });

  it('이미 포함(정상 경로) 안전망 멱등: 4점 유지 · 재확장 no-op', () => {
    const plate = rectToQuad({ x: 0.46, y: 0.55, w: 0.06, h: 0.03 });
    const poly = resolveFloorPolygon(null, vehicle, plate);
    expect(poly).toHaveLength(4);
    const target = { x: 0.46, y: 0.55, w: 0.06, h: 0.03 };
    expect(expandPolygonToContainRect(poly, target)).toBe(poly); // 동일 참조(no-op)
  });
});
