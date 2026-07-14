import { describe, it, expect } from 'vitest';
// 요구 A(차량 rect Ctrl+드래그) / 요구 B(전역 인덱스 중간삽입) 순수 로직 — DOM/fetch 미참조.
import {
  moveRect,
  hitTestRectHandle,
  nextSlotId,
  insertSlotAt,
  validateManualIndex,
  buildMappingRows,
} from '../web/core.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';
import type { ArtifactLike } from '../web/core.js';

/** 2프리셋 산출물(coveredSlotIds 순서 = position 진실). */
function sampleArtifact(): ArtifactLike {
  return {
    createdAt: 'T',
    presets: [
      { camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] },
      { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c1p2s1'] },
    ],
    slots: [
      { slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      { slotId: 'c1p1s2', zone: 'cam1', roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } },
      { slotId: 'c1p2s1', zone: 'cam1', roiByPreset: { '1:2': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
      { globalIdx: 3, slotId: 'c1p2s1', camIdx: 1, presetIdx: 2 },
    ],
  };
}

/** 표준 신규 슬롯(현재 (1,1) 프리셋). */
function newSlot(id = 'c1p1s3') {
  return { slotId: id, zone: 'cam1', roiByPreset: { '1:1': { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } } };
}

// ===== moveRect (요구 A — QA #12) =====
describe('moveRect (평행이동·경계 클램프)', () => {
  const r = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } as const;

  it('경계 내 이동: w,h 유지·x/y 이동', () => {
    const n = moveRect(r, 0.1, -0.1);
    expect(n.x).toBeCloseTo(0.5, 6);
    expect(n.y).toBeCloseTo(0.3, 6);
    expect(n.w).toBeCloseTo(0.2, 6);
    expect(n.h).toBeCloseTo(0.2, 6);
  });

  it('좌/상단 클램프: x,y≥0 하되 w,h 불변(clamp01Rect 와 달리 축소 없음)', () => {
    const n = moveRect(r, -0.9, -0.9);
    expect(n.x).toBe(0);
    expect(n.y).toBe(0);
    expect(n.w).toBeCloseTo(0.2, 6);
    expect(n.h).toBeCloseTo(0.2, 6);
  });

  it('우/하단 클램프: x≤1−w, y≤1−h', () => {
    const n = moveRect(r, 0.9, 0.9);
    expect(n.x).toBeCloseTo(0.8, 6); // 1 - 0.2
    expect(n.y).toBeCloseTo(0.8, 6);
    expect(n.w).toBeCloseTo(0.2, 6);
    expect(n.h).toBeCloseTo(0.2, 6);
    expect(n.x + n.w).toBeLessThanOrEqual(1);
    expect(n.y + n.h).toBeLessThanOrEqual(1);
  });
});

// ===== hitTestRectHandle (요구 A — QA #13) =====
describe('hitTestRectHandle (8핸들/내부/외부, 우선순위 코너>변>내부)', () => {
  const rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 } as const; // left .2 right .6 top .2 bottom .6
  const tol = 0.02;

  it('코너 정확히 위 → 해당 코너', () => {
    expect(hitTestRectHandle(rect, 0.2, 0.2, tol, tol)).toBe('nw');
    expect(hitTestRectHandle(rect, 0.6, 0.2, tol, tol)).toBe('ne');
    expect(hitTestRectHandle(rect, 0.2, 0.6, tol, tol)).toBe('sw');
    expect(hitTestRectHandle(rect, 0.6, 0.6, tol, tol)).toBe('se');
  });

  it('변 근접(코너 제외) → 변', () => {
    expect(hitTestRectHandle(rect, 0.4, 0.2, tol, tol)).toBe('n');
    expect(hitTestRectHandle(rect, 0.4, 0.6, tol, tol)).toBe('s');
    expect(hitTestRectHandle(rect, 0.2, 0.4, tol, tol)).toBe('w');
    expect(hitTestRectHandle(rect, 0.6, 0.4, tol, tol)).toBe('e');
  });

  it('내부 → in', () => {
    expect(hitTestRectHandle(rect, 0.4, 0.4, tol, tol)).toBe('in');
  });

  it('외부 → null', () => {
    expect(hitTestRectHandle(rect, 0.05, 0.05, tol, tol)).toBeNull();
    expect(hitTestRectHandle(rect, 0.9, 0.9, tol, tol)).toBeNull();
  });

  it('tol 경계값(정확히 |dx|=tol) → 히트(<=)', () => {
    // 우변 e: nx=0.62 → |dx|=0.02=tol 경계, ny=0.4(변 범위 안).
    expect(hitTestRectHandle(rect, 0.62, 0.4, tol, tol)).toBe('e');
  });

  it('tolX/tolY 비대칭', () => {
    // 상변 n: ny=0.203(|dy|=0.003<=0.005 통과), nx=0.4(변 범위 안, tolX=0.05).
    expect(hitTestRectHandle(rect, 0.4, 0.203, 0.05, 0.005)).toBe('n');
    // ny=0.21(|dy|=0.01>0.005 실패) → 내부.
    expect(hitTestRectHandle(rect, 0.4, 0.21, 0.05, 0.005)).toBe('in');
  });

  it('null rect 방어', () => {
    expect(hitTestRectHandle(null, 0.4, 0.4, tol, tol)).toBeNull();
  });
});

// ===== nextSlotId (요구 B — QA #10, #11) =====
describe('nextSlotId (결번 충돌회피)', () => {
  it('해당 프리셋 슬롯 0개 → s1', () => {
    expect(nextSlotId(sampleArtifact(), 2, 5)).toBe('c2p5s1');
  });

  it('연속 슬롯 → 최대+1', () => {
    expect(nextSlotId(sampleArtifact(), 1, 1)).toBe('c1p1s3');
  });

  it('결번(s2 삭제) 있어도 기존 slotId 와 충돌 없음', () => {
    const a = sampleArtifact();
    // (1,1) 에 s1, s3 만 있고 s2 결번 → max=3 → s4(길이+1=s3 충돌 회피).
    a.slots = [
      { slotId: 'c1p1s1', roiByPreset: { '1:1': { x: 0, y: 0, w: 0.1, h: 0.1 } } },
      { slotId: 'c1p1s3', roiByPreset: { '1:1': { x: 0, y: 0, w: 0.1, h: 0.1 } } },
    ];
    const id = nextSlotId(a, 1, 1);
    expect(id).toBe('c1p1s4');
    expect(a.slots.some((s) => s.slotId === id)).toBe(false);
  });
});

// ===== insertSlotAt (요구 B — QA #1~#9) =====
describe('insertSlotAt (전역 인덱스 중간삽입)', () => {
  it('#1 삽입 위치: 신규 globalIdx === clamp(at)', () => {
    const next = insertSlotAt(sampleArtifact(), 2, newSlot());
    const g = next.globalIndex!.find((e) => e.slotId === 'c1p1s3');
    expect(g!.globalIdx).toBe(2);
  });

  it('#2 이후 밀림: at 이상 +1, at 미만 불변', () => {
    const next = insertSlotAt(sampleArtifact(), 2, newSlot());
    const gid = (id: string) => next.globalIndex!.find((e) => e.slotId === id)!.globalIdx;
    expect(gid('c1p1s1')).toBe(1); // at(2) 미만 불변
    expect(gid('c1p1s3')).toBe(2); // 신규
    expect(gid('c1p1s2')).toBe(3); // 기존 2 → 3
    expect(gid('c1p2s1')).toBe(4); // 기존 3 → 4
  });

  it('#3 coverage: globalIndex↔slots 집합 동일', () => {
    const next = insertSlotAt(sampleArtifact(), 2, newSlot());
    const cov = validateCoverage(next.globalIndex as never, next.slots as never);
    expect(cov.ok).toBe(true);
  });

  it('#4 1..N 고유(validateManualIndex ok)', () => {
    const next = insertSlotAt(sampleArtifact(), 2, newSlot());
    expect(validateManualIndex(next.globalIndex).ok).toBe(true);
  });

  it('#5 중복 slotId 삽입 → no-op(원본 반환)', () => {
    const a = sampleArtifact();
    const next = insertSlotAt(a, 2, newSlot('c1p1s1'));
    expect(next).toBe(a); // 동일 참조
    expect(next.slots!.length).toBe(3);
    expect(next.globalIndex!.length).toBe(3);
  });

  it('#6 positionIdx 정합: coveredSlotIds 말미 + buildMappingRows 연속', () => {
    const next = insertSlotAt(sampleArtifact(), 1, newSlot());
    const p11 = next.presets!.find((p) => p.camIdx === 1 && p.presetIdx === 1)!;
    expect(p11.coveredSlotIds).toEqual(['c1p1s1', 'c1p1s2', 'c1p1s3']);
    const rows = buildMappingRows(next).filter((r) => r.presetIdx === 1 && r.camIdx === 1);
    expect(rows.map((r) => r.positionIdx)).toEqual([1, 2, 3]);
  });

  it('#7 preset 부재 → 신규 preset 생성 + coveredSlotIds=[slotId]', () => {
    const a = sampleArtifact();
    const s = { slotId: 'c3p9s1', zone: 'cam3', roiByPreset: { '3:9': { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } } };
    const next = insertSlotAt(a, 1, s);
    const p = next.presets!.find((pp) => pp.camIdx === 3 && pp.presetIdx === 9);
    expect(p).toBeDefined();
    expect(p!.coveredSlotIds).toEqual(['c3p9s1']);
    expect(validateCoverage(next.globalIndex as never, next.slots as never).ok).toBe(true);
  });

  it('#8 클램프: at<1→1(맨앞), at>N+1→N+1(맨끝)', () => {
    const front = insertSlotAt(sampleArtifact(), 0, newSlot());
    expect(front.globalIndex!.find((e) => e.slotId === 'c1p1s3')!.globalIdx).toBe(1);
    const back = insertSlotAt(sampleArtifact(), 99, newSlot());
    expect(back.globalIndex!.find((e) => e.slotId === 'c1p1s3')!.globalIdx).toBe(4); // N+1
  });

  it('#9 불변성: 원본 slots/globalIndex 미변형', () => {
    const a = sampleArtifact();
    const snapSlots = a.slots!.length;
    const snapGi = JSON.parse(JSON.stringify(a.globalIndex));
    const next = insertSlotAt(a, 2, newSlot());
    expect(a.slots!.length).toBe(snapSlots);
    expect(a.globalIndex).toEqual(snapGi);
    expect(next).not.toBe(a);
    expect(next.slots).not.toBe(a.slots);
    expect(next.globalIndex).not.toBe(a.globalIndex);
  });

  it('nextSlotId → insertSlotAt 왕복(app.js addSlot 경로): coverage·1..N 유지', () => {
    const a = sampleArtifact();
    const id = nextSlotId(a, 1, 2);
    const s = { slotId: id, zone: 'cam1', roiByPreset: { '1:2': { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } } };
    const next = insertSlotAt(a, 4, s);
    expect(id).toBe('c1p2s2');
    expect(validateCoverage(next.globalIndex as never, next.slots as never).ok).toBe(true);
    expect(validateManualIndex(next.globalIndex).ok).toBe(true);
    const p12 = next.presets!.find((p) => p.camIdx === 1 && p.presetIdx === 2)!;
    expect(p12.coveredSlotIds).toEqual(['c1p2s1', 'c1p2s2']);
  });
});
