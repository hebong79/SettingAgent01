import { describe, it, expect } from 'vitest';
import { validateRenumberMapping } from '../src/setup/renumberMapping.js';

/**
 * 검증자(qa): validateRenumberMapping 순열 게이트(설계서 §1).
 * 정상 순열→ok+idMap / old 누락·추가·중복 / new 중복 / new 1..N 아님 / length 불일치 / 빈 currentIds.
 */
describe('validateRenumberMapping', () => {
  it('정상 순열 → ok + idMap(old→new) 정확', () => {
    const v = validateRenumberMapping(
      [10, 20, 30],
      [
        { oldSlotId: 10, newSlotId: 2 },
        { oldSlotId: 20, newSlotId: 3 },
        { oldSlotId: 30, newSlotId: 1 },
      ],
    );
    expect(v.ok).toBe(true);
    expect(v.idMap).toBeDefined();
    expect(v.idMap!.get(10)).toBe(2);
    expect(v.idMap!.get(20)).toBe(3);
    expect(v.idMap!.get(30)).toBe(1);
  });

  it('항등 순열(변경 없음)도 유효', () => {
    const v = validateRenumberMapping([1, 2], [
      { oldSlotId: 1, newSlotId: 1 },
      { oldSlotId: 2, newSlotId: 2 },
    ]);
    expect(v.ok).toBe(true);
  });

  it('currentIds 빈배열 → error', () => {
    const v = validateRenumberMapping([], []);
    expect(v.ok).toBe(false);
    expect(v.error).toBeTruthy();
  });

  it('length 불일치 → error', () => {
    const v = validateRenumberMapping([1, 2, 3], [{ oldSlotId: 1, newSlotId: 1 }]);
    expect(v.ok).toBe(false);
  });

  it('oldSlotId 가 현재 슬롯에 없음 → error', () => {
    const v = validateRenumberMapping([1, 2], [
      { oldSlotId: 1, newSlotId: 1 },
      { oldSlotId: 99, newSlotId: 2 },
    ]);
    expect(v.ok).toBe(false);
  });

  it('oldSlotId 중복 → error', () => {
    const v = validateRenumberMapping([1, 2], [
      { oldSlotId: 1, newSlotId: 1 },
      { oldSlotId: 1, newSlotId: 2 },
    ]);
    expect(v.ok).toBe(false);
  });

  it('newSlotId 중복 → error', () => {
    const v = validateRenumberMapping([1, 2], [
      { oldSlotId: 1, newSlotId: 1 },
      { oldSlotId: 2, newSlotId: 1 },
    ]);
    expect(v.ok).toBe(false);
  });

  it('newSlotId 가 1..N 커버 아님(예: {1,2,4}) → error', () => {
    const v = validateRenumberMapping([1, 2, 3], [
      { oldSlotId: 1, newSlotId: 1 },
      { oldSlotId: 2, newSlotId: 2 },
      { oldSlotId: 3, newSlotId: 4 },
    ]);
    expect(v.ok).toBe(false);
  });
});
