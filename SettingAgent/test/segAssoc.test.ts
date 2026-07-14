// associateDetSeg — 1:1 불변식 · 결정성 · 극단 케이스. **프로덕션 함수를 import 해 호출한다**(재구현 0).
//
// ⚠️ 이 파일은 **합성 rect** 를 쓴다 — 그것으로 "정합이 실제로 맞는가"를 판정하지 **않는다**(픽스처가 검증 대상의
//    가정을 복사하는 함정). 여기서 보는 것은 **알고리즘의 불변식**(1:1·결정성·경계)뿐이다.
//    "실데이터에서 정말 맞는가"는 `assocRealFrames.test.ts`(실서버 응답 원문 녹화)가 본다.

import { describe, expect, it } from 'vitest';
import { associateDetSeg, DEFAULT_ASSOC_OPTIONS } from '../src/ground/segAssoc.js';
import type { NormalizedRect } from '../src/domain/types.js';

const R = (x: number, y: number, w = 0.1, h = 0.1): NormalizedRect => ({ x, y, w, h });

describe('associateDetSeg — 1:1 불변식(임계와 무관하게 구조적으로 보장)', () => {
  it('한 det 이 두 seg 를 먹지 못하고, 한 seg 가 두 det 에 붙지 못한다', () => {
    // det 1개가 seg 2개와 모두 크게 겹치는 병적 배치.
    const det = [R(0, 0, 0.4, 0.4)];
    const seg = [R(0, 0, 0.35, 0.35), R(0.02, 0.02, 0.35, 0.35)];
    const r = associateDetSeg(det, seg, { minIou: 0.1 });
    expect(r.pairs).toHaveLength(1); // det 1개 → 쌍은 최대 1개.
    expect(r.unmatchedSeg).toHaveLength(1); // 남은 seg 는 **사라지지 않고 드러난다**.

    // 반대: seg 1개에 det 2개가 달려든다.
    const r2 = associateDetSeg([R(0, 0, 0.4, 0.4), R(0.02, 0.02, 0.4, 0.4)], [R(0, 0, 0.4, 0.4)], { minIou: 0.1 });
    expect(r2.pairs).toHaveLength(1);
    expect(r2.unmatchedDet).toHaveLength(1);
    // 이긴 쪽은 IoU 가 더 높은 det(그리디) — 완전 일치한 #0.
    expect(r2.pairs[0].detIdx).toBe(0);
  });

  it('완전중첩 3×3 → 3쌍 정확히 대응(대각선)', () => {
    const boxes = [R(0.1, 0.1), R(0.5, 0.1), R(0.1, 0.5)];
    const r = associateDetSeg(boxes, boxes, DEFAULT_ASSOC_OPTIONS);
    expect(r.pairs.map((p) => [p.detIdx, p.segIdx])).toEqual([[0, 0], [1, 1], [2, 2]]);
    for (const p of r.pairs) expect(p.iou).toBeCloseTo(1, 12); // 완전중첩(부동소수 오차만 허용).
    expect(r.unmatchedDet).toEqual([]);
    expect(r.unmatchedSeg).toEqual([]);
  });

  it('0중첩 → 쌍 0개. det·seg 전부 미정합으로 **드러난다**(조용히 사라지지 않는다)', () => {
    const r = associateDetSeg([R(0, 0)], [R(0.8, 0.8)], DEFAULT_ASSOC_OPTIONS);
    expect(r.pairs).toEqual([]);
    expect(r.unmatchedDet).toEqual([0]);
    expect(r.unmatchedSeg).toEqual([0]);
    expect(r.bestIouByDet).toEqual([0]); // 사유의 근거(후보 0).
  });

  it('det 0개 / seg 0개 — throw 하지 않는다', () => {
    expect(associateDetSeg([], [R(0, 0)], DEFAULT_ASSOC_OPTIONS).unmatchedSeg).toEqual([0]);
    expect(associateDetSeg([R(0, 0)], [], DEFAULT_ASSOC_OPTIONS).unmatchedDet).toEqual([0]);
    expect(associateDetSeg([], [], DEFAULT_ASSOC_OPTIONS).pairs).toEqual([]);
  });

  it('★ 동점 결정성 — 같은 입력을 두 번 부르면 결과가 **비트 동일**(랜덤 시드 0 → flaky 0)', () => {
    // 완전 동일한 seg 두 개(동점) — 정렬 tie-break 이 없으면 결과가 흔들린다.
    const det = [R(0, 0, 0.3, 0.3), R(0.1, 0, 0.3, 0.3)];
    const seg = [R(0, 0, 0.3, 0.3), R(0, 0, 0.3, 0.3)];
    const a = associateDetSeg(det, seg, { minIou: 0.1 });
    const b = associateDetSeg(det, seg, { minIou: 0.1 });
    expect(a).toEqual(b);
    expect(a.pairs).toHaveLength(2); // 1:1 이므로 seg 2개가 각각 다른 det 에 간다.
    expect(new Set(a.pairs.map((p) => p.segIdx)).size).toBe(2);
  });

  it('임계 미만은 채택하지 않는다 — 단 bestIou 는 **임계와 무관하게** 원자료로 남는다(미정합 사유의 근거)', () => {
    const det = [R(0, 0, 0.2, 0.2)];
    const seg = [R(0.15, 0.15, 0.2, 0.2)]; // 작게 겹침.
    const low = associateDetSeg(det, seg, { minIou: 0.01 });
    const high = associateDetSeg(det, seg, { minIou: 0.9 });
    expect(low.pairs).toHaveLength(1);
    expect(high.pairs).toHaveLength(0);
    expect(high.unmatchedDet).toEqual([0]);
    // ★ 임계로 떨어뜨렸어도 "얼마나 가까웠는지"가 보존된다 → 강등이 관측 가능하다.
    expect(high.bestIouByDet[0]).toBeCloseTo(low.pairs[0].iou, 12);
    expect(high.bestIouByDet[0]).toBeGreaterThan(0);
  });

  it('secondIouByDet — 2위가 정확히 기록된다(모호성 진단의 근거. §5-④)', () => {
    const det = [R(0, 0, 0.4, 0.4)];
    const seg = [R(0, 0, 0.4, 0.4), R(0.05, 0.05, 0.4, 0.4)];
    const r = associateDetSeg(det, seg, { minIou: 0.1 });
    expect(r.bestIouByDet[0]).toBe(1); // 완전 일치.
    expect(r.secondIouByDet[0]).toBeGreaterThan(0);
    expect(r.secondIouByDet[0]).toBeLessThan(r.bestIouByDet[0]);
  });
});
