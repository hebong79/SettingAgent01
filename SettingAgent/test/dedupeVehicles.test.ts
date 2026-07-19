import { describe, it, expect } from 'vitest';
// 순수 ESM(브라우저 API 미참조) 직접 import — 다른 core.js 테스트(preciseCore.test.ts)와 동일 방식.
import { rectIoU, dedupeVehicles } from '../web/core.js';

/**
 * 검증자(qa-tester): VPD 오버레이 dedup 순수 로직(web/core.js).
 * 근거: 01_architect_plan.md §1 + 02_developer_changes.md §2(그리디→연결요소 교정).
 *
 * 핵심 회귀방지: 동심 다중스케일 체인에서 그리디(뒤→앞, kept와 IoU≥th면 스킵)는
 * 체인 양 끝이 서로 IoU<0.5면 2개가 잔존 → "차량당 1개" 위반. 연결요소(union-find)는
 * transitive 연결로 1개 병합. (case 3 이 이 회귀를 명시적으로 잡는다.)
 *
 * 한계: DOM/canvas 렌더·#roi-db 소스 전환 시각·app.js runLiveDetect 통합은
 * 리더 라이브/sharp 관찰로 확정(순수함수만 vitest 커버). detectByKey 소비처의
 * index 정합은 수집 시점 dedup(원순서 복원)으로 구조적 보장 — 아래 원순서 테스트로 근거.
 */

// ── 헬퍼: 정규화 rect ──
const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
// 중심 (0.5,0.5) 동심 정사각형(크기 s). 동심이면 IoU = (min/max)^2.
const concentric = (s: number) => R(0.5 - s / 2, 0.5 - s / 2, s, s);

describe('rectIoU — 정규화 rect 교집합/합집합 비율', () => {
  it('완전 일치 = 1', () => {
    // 이진 표현 정확한 좌표(inter=uni=1)로 부동소수 오차 없이 정확히 1.
    expect(rectIoU(R(0, 0, 1, 1), R(0, 0, 1, 1))).toBe(1);
  });

  it('완전 비겹침 = 0', () => {
    expect(rectIoU(R(0, 0, 0.1, 0.1), R(0.5, 0.5, 0.1, 0.1))).toBe(0);
  });

  it('경계 접함(모서리 공유) = 0', () => {
    // a 오른쪽변 x=1, b 왼쪽변 x=1 → 교집합 폭 0.
    expect(rectIoU(R(0, 0, 1, 1), R(1, 0, 1, 1))).toBe(0);
  });

  it('부분 겹침 수치: a={0,0,1,1}, b={0,0,0.5,1} → 0.5', () => {
    // inter=0.5, union=1+0.5-0.5=1.0 → 0.5.
    expect(rectIoU(R(0, 0, 1, 1), R(0, 0, 0.5, 1))).toBeCloseTo(0.5, 12);
  });

  it('부분 겹침 수치: 대각 half-overlap → 1/7', () => {
    // a area4, b area4, overlap 1x1=1, union=7.
    expect(rectIoU(R(0, 0, 2, 2), R(1, 1, 2, 2))).toBeCloseTo(1 / 7, 12);
  });

  it('퇴화(w=0) → 면적 0 → IoU 0', () => {
    expect(rectIoU(R(0, 0, 0, 1), R(0, 0, 1, 1))).toBe(0);
  });

  it('퇴화(h=0) → IoU 0', () => {
    expect(rectIoU(R(0, 0, 1, 0), R(0, 0, 1, 1))).toBe(0);
  });

  it('양쪽 모두 퇴화(union<=0) → 0(0나눗셈 가드)', () => {
    expect(rectIoU(R(0, 0, 0, 0), R(0, 0, 0, 0))).toBe(0);
  });
});

describe('dedupeVehicles — 기본 dedup(겹침 그룹→마지막, 별개→유지)', () => {
  it('겹침 그룹(IoU≥0.5)은 마지막 1개만 생존, 별개 차량은 유지', () => {
    const v0 = { rect: R(0, 0, 0.2, 0.2) };
    const v1 = { rect: R(0.02, 0.02, 0.2, 0.2) }; // v0 와 IoU≈0.68 ≥0.5 (같은 그룹)
    const v2 = { rect: R(0.7, 0.7, 0.1, 0.1) }; // 별개
    // 사전 조건: v0-v1 겹침, v0/v1-v2 비겹침.
    expect(rectIoU(v0.rect, v1.rect)).toBeGreaterThanOrEqual(0.5);
    expect(rectIoU(v1.rect, v2.rect)).toBeLessThan(0.5);

    const out = dedupeVehicles([v0, v1, v2]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(v1); // 그룹의 마지막(index1) 생존
    expect(out[1]).toBe(v2); // 별개 유지
  });
});

describe('★ 동심 다중스케일 체인 — 그리디 회귀 방지(필수)', () => {
  it('연속 IoU≥0.5·양끝 IoU<0.5 인 4박스 → 정확히 1개(마지막 index 생존)', () => {
    // 크기 0.10/0.13/0.17/0.22 동심. 인접 IoU≈0.59(≥0.5), 양끝 IoU≈0.207(<0.5).
    const A = { rect: concentric(0.1), id: 'A' };
    const B = { rect: concentric(0.13), id: 'B' };
    const C = { rect: concentric(0.17), id: 'C' };
    const D = { rect: concentric(0.22), id: 'D' };

    // 그리디 실패 조건 명시: 인접 ≥0.5, 양끝 <0.5.
    expect(rectIoU(A.rect, B.rect)).toBeGreaterThanOrEqual(0.5);
    expect(rectIoU(B.rect, C.rect)).toBeGreaterThanOrEqual(0.5);
    expect(rectIoU(C.rect, D.rect)).toBeGreaterThanOrEqual(0.5);
    expect(rectIoU(A.rect, D.rect)).toBeLessThan(0.5); // 양끝 안 겹침
    // 그리디였다면 kept=[D], B는 D와 IoU<0.5라 잔존 → [B,D] 2개(회귀).
    expect(rectIoU(B.rect, D.rect)).toBeLessThan(0.5);

    const out = dedupeVehicles([A, B, C, D]);
    expect(out).toHaveLength(1); // transitive 연결 → 1그룹
    expect(out[0]).toBe(D); // 생존 = 원배열 최대 index(마지막 검지)
    expect((out[0] as { id: string }).id).toBe('D');
  });
});

describe('마지막 검지 의미 — 생존 = 그룹 내 원배열 max index', () => {
  it('겹침 3개 그룹에서 생존 요소가 max index', () => {
    const g0 = { rect: concentric(0.1), tag: 0 };
    const g1 = { rect: concentric(0.11), tag: 1 };
    const g2 = { rect: concentric(0.12), tag: 2 };
    // 모두 서로 IoU≥0.5(작은 크기차) → 1그룹.
    const out = dedupeVehicles([g0, g1, g2]);
    expect(out).toHaveLength(1);
    expect((out[0] as { tag: number }).tag).toBe(2); // max index
  });
});

describe('원객체·필드 보존 및 원순서', () => {
  it('생존 객체는 원본 참조 그대로(plate/confidence/cls 보존)', () => {
    const keep = {
      rect: R(0.01, 0.01, 0.2, 0.2),
      plate: { quad: [{ x: 0.05, y: 0.05 }], recovered: true },
      confidence: 0.87,
      cls: 'car',
    };
    const dropped = { rect: R(0, 0, 0.2, 0.2), confidence: 0.4, cls: 'car' };
    // dropped(index0) ~ keep(index1) 겹침 → keep 생존.
    const out = dedupeVehicles([dropped, keep]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(keep); // 참조 동일
    expect(out[0]).toHaveProperty('plate');
    expect((out[0] as typeof keep).confidence).toBe(0.87);
    expect((out[0] as typeof keep).cls).toBe('car');
  });

  it('비겹침 3개 → 전부 유지·원순서·원참조', () => {
    const a = { rect: R(0.0, 0.0, 0.1, 0.1) };
    const b = { rect: R(0.4, 0.0, 0.1, 0.1) };
    const c = { rect: R(0.0, 0.4, 0.1, 0.1) };
    const out = dedupeVehicles([a, b, c]);
    expect(out).toEqual([a, b, c]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(out[2]).toBe(c);
  });
});

describe('인접 차량 비병합(과잉병합 없음)', () => {
  it('두 차량이 IoU<0.5로 살짝 겹쳐도 각각 유지(2개)', () => {
    const v1 = { rect: R(0, 0, 0.1, 0.1) };
    const v2 = { rect: R(0.08, 0, 0.1, 0.1) }; // IoU≈0.111 <0.5
    expect(rectIoU(v1.rect, v2.rect)).toBeLessThan(0.5);
    const out = dedupeVehicles([v1, v2]);
    expect(out).toHaveLength(2);
    expect(out).toEqual([v1, v2]);
  });
});

describe('엣지 케이스', () => {
  it('빈 배열 → []', () => {
    expect(dedupeVehicles([])).toEqual([]);
  });

  it('undefined 입력 → []', () => {
    expect(dedupeVehicles(undefined as unknown as [])).toEqual([]);
  });

  it('null 입력 → []', () => {
    expect(dedupeVehicles(null as unknown as [])).toEqual([]);
  });

  it('1개 → 그대로(원참조)', () => {
    const only = { rect: R(0.1, 0.1, 0.2, 0.2) };
    const out = dedupeVehicles([only]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(only);
  });

  it('전부 malformed(rect 없음) → []', () => {
    const bad = [{ confidence: 0.9 }, { rect: null }, { rect: undefined }] as unknown as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
    expect(dedupeVehicles(bad)).toEqual([]);
  });

  it('일부 malformed 는 스킵하고 정상 요소는 원순서로 유지', () => {
    const good1 = { rect: R(0.0, 0.0, 0.1, 0.1) };
    const bad = { confidence: 0.5 } as unknown as { rect: { x: number; y: number; w: number; h: number } };
    const good2 = { rect: R(0.5, 0.5, 0.1, 0.1) };
    const out = dedupeVehicles([good1, bad, good2]);
    expect(out).toEqual([good1, good2]); // malformed 스킵, 나머지 원순서
  });
});

describe('iouThresh 인자 반영', () => {
  it('같은 입력에 th=0.5 → 2개, th=0.1 → 1개(병합)', () => {
    const v1 = { rect: R(0, 0, 0.1, 0.1) };
    const v2 = { rect: R(0.08, 0, 0.1, 0.1) }; // IoU≈0.111
    const iou = rectIoU(v1.rect, v2.rect);
    expect(iou).toBeGreaterThan(0.1);
    expect(iou).toBeLessThan(0.5);

    expect(dedupeVehicles([v1, v2], 0.5)).toHaveLength(2); // 임계 미달 → 별개
    const merged = dedupeVehicles([v1, v2], 0.1); // 임계 하회 → 병합
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(v2); // 마지막 index 생존
  });
});
