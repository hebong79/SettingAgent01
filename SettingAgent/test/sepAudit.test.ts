// ★ 21회차 Phase 0-b — 분리선 감사 도구(`src/tools/sepAudit.ts`)의 **순수 로직** 유닛테스트.
//
// 이 도구는 리더가 A안/B안을 판정하는 근거를 내므로, 채점 산술이 틀리면 판정 자체가 틀린다.
// 그래서 ① 각 순수 함수의 경계 거동 ② **합성 장면에서 정답을 아는 채로** 감사 결과가 맞는지
// (오차 0 이 0 으로, 0.3m 어긋남이 누락으로 나오는지) 두 층으로 확인한다.

import { describe, expect, it } from 'vitest';
import {
  AUDIT_DEDUP_M,
  auditQuadAt,
  auditRowFrame,
  chanceHitRate,
  clusterCount,
  dedupeCoords,
  falseSepIndices,
  gate1Pairs,
  nearestSep,
  pickAuditFrame,
  quantiles,
} from '../src/tools/sepAudit.js';
import { groundModelFromIntrinsics, type PresetIntrinsics } from '../src/ground/cameraIntrinsics.js';
import { lineThrough } from '../src/ground/floorPaint.js';
import { projectToPixel } from '../src/ground/project.js';
import { rowFrameFromLine } from '../src/ground/bayGrid.js';
import { canonicalizeQuad } from '../src/ground/groundGrid.js';
import type { PixelQuad } from '../src/ground/types.js';

describe('sepAudit 순수 로직', () => {
  it('dedupeCoords — 허용치 안의 값을 접고 대표값은 구성원 평균이다', () => {
    const g = dedupeCoords([5.0, 0.02, 0.0, 2.5], 0.05);
    expect(g.map((x) => x.members)).toEqual([[2, 1], [3], [0]]);
    expect(g[0].aM).toBeCloseTo(0.01, 12);
    expect(g[1].aM).toBe(2.5);
    expect(g[2].aM).toBe(5.0);
  });

  it('dedupeCoords — 비유한 값은 버리고, 접을 것이 없으면 그대로 정렬만 한다', () => {
    expect(dedupeCoords([NaN, 3, 1, Infinity], 0.05).map((x) => x.aM)).toEqual([1, 3]);
  });

  it('nearestSep — 부호 있는 오차(분리선 − 참 경계)를 내고 후보 0개면 null', () => {
    const a = nearestSep(2.5, [2.4, 2.7])!;
    expect(a.sepIdx).toBe(0);
    expect(a.errM).toBeCloseTo(-0.1, 12);
    const b = nearestSep(2.5, [2.6, 2.45])!;
    expect(b.sepIdx).toBe(1);
    expect(b.errM).toBeCloseTo(-0.05, 12);
    expect(nearestSep(2.5, [])).toBeNull();
    expect(nearestSep(2.5, [NaN])).toBeNull();
  });

  it('falseSepIndices — 어떤 참 경계에도 붙지 않은 분리선만 센다', () => {
    expect(falseSepIndices([0, 0.3, 1.2, 5.0], [0.1, 5.1], 0.25)).toEqual([2]);
    // 참 경계가 없으면 전부 오검출이다(밀도 지표가 과소평가되지 않게).
    expect(falseSepIndices([0, 1], [], 0.25)).toEqual([0, 1]);
  });

  it('chanceHitRate — 겹치는 ±tol 구간을 합집합으로 세고 구간 밖은 자른다', () => {
    // [0,10] 에 분리선 1개(5) → 폭 0.5 구간 / 10 = 0.05.
    expect(chanceHitRate([5], 0, 10, 0.25)).toBeCloseTo(0.05, 12);
    // 0.1m 간격 두 개는 구간이 겹쳐 0.6/10 이다(0.5+0.5=1.0 이 아니다).
    expect(chanceHitRate([5, 5.1], 0, 10, 0.25)).toBeCloseTo(0.06, 12);
    // 촘촘하면 1 로 포화한다 — 이때 적중률은 정확도를 재지 못한다는 것이 이 지표의 요점이다.
    const dense = Array.from({ length: 41 }, (_, i) => i * 0.25);
    expect(chanceHitRate(dense, 0, 10, 0.25)).toBe(1);
    expect(Number.isNaN(chanceHitRate([5], 3, 3, 0.25))).toBe(true);
  });

  it('quantiles — p90 은 nearest-rank(보간하지 않는다)', () => {
    const q = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(q).toEqual({ median: 5.5, p90: 9, max: 10, n: 10 });
    expect(quantiles([2, 1, 3])).toEqual({ median: 2, p90: 3, max: 3, n: 3 });
    expect(quantiles([])).toBeNull();
  });

  it('pickAuditFrame — 적중 수 desc → 오차합 asc → 인덱스 asc(난수 0)', () => {
    expect(pickAuditFrame([{ hits: 2, sumAbsErrM: 0.1 }, { hits: 3, sumAbsErrM: 9 }])).toBe(1);
    expect(pickAuditFrame([{ hits: 3, sumAbsErrM: 0.5 }, { hits: 3, sumAbsErrM: 0.4 }])).toBe(1);
    expect(pickAuditFrame([{ hits: 3, sumAbsErrM: 0.4 }, { hits: 3, sumAbsErrM: 0.4 }])).toBe(0);
    expect(pickAuditFrame([])).toBe(-1);
  });

  it('gate1Pairs — 규격 폭에 맞는 쌍만 남기고 aLo 는 두 관측의 평균이다', () => {
    // 0, 2.5, 5.0 → (0,2.5)·(2.5,5.0) 두 쌍. (0,5.0) 은 게이트① 탈락.
    const p = gate1Pairs([0, 2.5, 5.0], 2.5, 0.05);
    expect(p.map((x) => [x.i, x.j])).toEqual([[0, 1], [1, 2]]);
    expect(p[0].aLoM).toBeCloseTo(0, 12);
    expect(p[1].aLoM).toBeCloseTo(2.5, 12);
    // 인접 쌍만 보지 않는다 — 사이에 오검출이 끼면 **건너뛴 쌍**이 통과한다(설계서 §3-1 3).
    const p2 = gate1Pairs([0, 1.2, 2.5], 2.5, 0.05);
    expect(p2.map((x) => [x.i, x.j])).toEqual([[0, 2]]);
    // 허용치 밖.
    expect(gate1Pairs([0, 2.7], 2.5, 0.05)).toEqual([]);
    expect(gate1Pairs([0, 2.7], 2.5, 0.1).length).toBe(1);
  });

  it('clusterCount — δ 보다 더 떨어진 것만 새 위치로 센다(배타성 생존 수의 하한)', () => {
    expect(clusterCount([0, 0.3, 0.6], 0.8333)).toBe(1);
    expect(clusterCount([0, 0.9, 1.0, 2.0], 0.8333)).toBe(3);
    expect(clusterCount([], 0.8333)).toBe(0);
  });
});

// ── 합성 장면: 정답을 아는 채로 감사 결과를 검산한다 ──────────────────────────
/**
 * 지면 위 폭 2.5m·깊이 5.0m 칸을 실제 투영으로 만들어 「참 면」으로 쓰고,
 * 분리선 교점은 **전방선 위의 정확한 참 경계 위치**(또는 일부러 어긋낸 위치)로 만든다.
 * 정답 오차를 알기 때문에 감사기의 산술을 그대로 검산할 수 있다.
 */
function synthetic(): {
  model: ReturnType<typeof groundModelFromIntrinsics>;
  frontLine: [number, number, number];
  faces: Array<{ faceIdx: number; quad: PixelQuad }>;
  aOf: (a: number) => { x: number; y: number };
} {
  const intr: PresetIntrinsics = {
    camIdx: 1,
    presetIdx: 1,
    fovDeg: 58,
    fovAxis: 'horizontal',
    tiltDeg: 20,
    heightM: 4.95,
    imgW: 1920,
    imgH: 1080,
    source: 'test',
  };
  const model = groundModelFromIntrinsics(intr, 1);
  if (!model) throw new Error('model');
  // 전방선 = 지면 v=0 인 직선을 투영한 것. 지면 좌표계를 직접 세운다.
  const fr0 = rowFrameFromLine(model, [0, 1, -900]); // 화면 가로선 y=900 을 전방선 씨앗으로.
  if (!fr0) throw new Error('rowFrame');
  const at = (a: number, b: number) => {
    const p = projectToPixel(
      [
        fr0.origin[0] + fr0.u[0] * a + fr0.v[0] * b,
        fr0.origin[1] + fr0.u[1] * a + fr0.v[1] * b,
        fr0.origin[2] + fr0.u[2] * a + fr0.v[2] * b,
      ],
      model,
    );
    if (!p) throw new Error(`project ${a},${b}`);
    return p;
  };
  const faces: Array<{ faceIdx: number; quad: PixelQuad }> = [];
  for (let k = 0; k < 3; k++) {
    const a0 = k * 2.5;
    const q = canonicalizeQuad([at(a0, 0), at(a0, 5), at(a0 + 2.5, 5), at(a0 + 2.5, 0)]);
    if (!q) throw new Error('quad');
    faces.push({ faceIdx: k + 1, quad: q });
  }
  return { model, frontLine: [0, 1, -900], faces, aOf: (a: number) => at(a, 0) };
}

describe('sepAudit 합성 장면 검산', () => {
  it('정확한 분리선을 주면 전 경계 적중 · 오차 ~0 · 면 전부 닫힘', () => {
    const { model, frontLine, faces, aOf } = synthetic();
    const sepPx = [0, 2.5, 5.0, 7.5].map(aOf);
    const r = auditRowFrame(model!, frontLine, faces, sepPx, 0.25, AUDIT_DEDUP_M);
    expect(r).not.toBeNull();
    expect(r!.boundaries.length).toBe(4); // 3면이 공유하는 경계 4개.
    expect(r!.hits).toBe(4);
    for (const b of r!.boundaries) expect(Math.abs(b.errM ?? 9)).toBeLessThan(1e-6);
    expect(r!.faces.map((f) => f.closable)).toEqual([true, true, true]);
    // 참 경계 간격은 규격 폭 그대로(합성이므로 F6 스케일 편차가 없다).
    for (const f of r!.faces) expect(f.truthSpanM).toBeCloseTo(2.5, 6);
    for (const f of r!.faces) expect(Math.abs(f.sepSpanM ?? 0)).toBeCloseTo(2.5, 6);
  });

  it('한 분리선을 0.3m 어긋내면 그 경계만 누락이고 그 두 면만 닫히지 않는다', () => {
    const { model, frontLine, faces, aOf } = synthetic();
    const sepPx = [0, 2.5 + 0.3, 5.0, 7.5].map(aOf);
    const r = auditRowFrame(model!, frontLine, faces, sepPx, 0.25, AUDIT_DEDUP_M)!;
    const miss = r.boundaries.filter((b) => !b.hit);
    expect(miss.length).toBe(1);
    expect(miss[0].aM).toBeCloseTo(2.5, 6);
    expect(Math.abs(miss[0].errM!)).toBeGreaterThan(0.25);
    expect(r.faces.map((f) => f.closable)).toEqual([false, false, true]);
    // px 오차도 함께 나온다(0 이 아니다).
    expect(miss[0].errPx).toBeGreaterThan(1);
  });

  it('오검출 분리선은 적중 판정을 바꾸지 않고 오검출로만 센다', () => {
    const { model, frontLine, faces, aOf } = synthetic();
    const sepPx = [0, 1.1, 2.5, 5.0, 7.5].map(aOf);
    const r = auditRowFrame(model!, frontLine, faces, sepPx, 0.25, AUDIT_DEDUP_M)!;
    expect(r.hits).toBe(4);
    expect(falseSepIndices(r.sepAM, r.boundaries.map((b) => b.aM), 0.25)).toEqual([1]);
  });

  it('전방선이 참 경계와 평행이면 그 면은 측정 불가로 남는다(추정으로 채우지 않는다)', () => {
    const { model, faces } = synthetic();
    // 참 면의 측변(대략 수직 방향)과 평행한 전방선을 넣으면 교점이 없거나 프레임에서 멀다.
    const side = lineThrough(faces[0].quad[0], faces[0].quad[1])!;
    const r = auditRowFrame(model!, side, faces, [], 0.25, AUDIT_DEDUP_M);
    // 프레임을 세울 수 없으면 null, 세울 수 있으면 최소한 면 1개가 측정 불가로 빠진다.
    if (r) expect(r.unmeasured.length + r.faces.filter((f) => f.loB < 0 || f.hiB < 0).length).toBeGreaterThan(0);
  });

  it('auditQuadAt — 참 면과 같은 폭좌표를 주면 참 quad 를 재현한다(계측용 조립 검산)', () => {
    const { model, frontLine, faces } = synthetic();
    const fr = rowFrameFromLine(model!, frontLine)!;
    const q = auditQuadAt(fr, model!, 2.5, 2.5, 5.0, false);
    expect(q).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      expect(q![i].x).toBeCloseTo(faces[1].quad[i].x, 6);
      expect(q![i].y).toBeCloseTo(faces[1].quad[i].y, 6);
    }
    // v 를 뒤집으면 다른 quad 다(설계서 §3-2 의 "v방향 2" 가 별개 후보라는 뜻).
    const flipped = auditQuadAt(fr, model!, 2.5, 2.5, 5.0, true)!;
    expect(Math.abs(flipped[1].y - q![1].y)).toBeGreaterThan(1);
  });
});
