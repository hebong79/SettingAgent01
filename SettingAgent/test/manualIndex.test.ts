import { describe, it, expect } from 'vitest';
import { validateManualIndex, reorderGlobalIndex } from '../web/core.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';

function artifact() {
  return {
    createdAt: 'T',
    presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['a', 'b', 'c'] }],
    slots: [
      { slotId: 'a', zone: 'z', roiByPreset: {} },
      { slotId: 'b', zone: 'z', roiByPreset: {} },
      { slotId: 'c', zone: 'z', roiByPreset: {} },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'a', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'b', camIdx: 1, presetIdx: 1 },
      { globalIdx: 3, slotId: 'c', camIdx: 1, presetIdx: 1 },
    ],
  };
}

describe('validateManualIndex (#7)', () => {
  it('1..N 연속·중복 없음 → ok', () => {
    const v = validateManualIndex([{ globalIdx: 1, slotId: 'a' }, { globalIdx: 2, slotId: 'b' }, { globalIdx: 3, slotId: 'c' }]);
    expect(v.ok).toBe(true);
  });
  it('중복 globalIdx 감지', () => {
    const v = validateManualIndex([{ globalIdx: 1, slotId: 'a' }, { globalIdx: 1, slotId: 'b' }, { globalIdx: 3, slotId: 'c' }]);
    expect(v.ok).toBe(false);
    expect(v.duplicates).toEqual([1]);
    expect(v.gaps).toEqual([2]);
  });
  it('gap 감지', () => {
    const v = validateManualIndex([{ globalIdx: 1, slotId: 'a' }, { globalIdx: 2, slotId: 'b' }, { globalIdx: 4, slotId: 'c' }]);
    expect(v.ok).toBe(false);
    expect(v.gaps).toEqual([3]);
  });
});

describe('reorderGlobalIndex (#7)', () => {
  it('정상 재정렬 → coverage ok·순서 반영', () => {
    const a = artifact();
    const next = reorderGlobalIndex(a, ['c', 'a', 'b']);
    expect(next).not.toBeNull();
    expect(next!.globalIndex!.map((g) => g.slotId)).toEqual(['c', 'a', 'b']);
    expect(next!.globalIndex!.map((g) => g.globalIdx)).toEqual([1, 2, 3]);
    const cov = validateCoverage(next!.globalIndex as never, next!.slots as never);
    expect(cov.ok).toBe(true);
  });
  it('slots 집합과 불일치(누락) → null', () => {
    expect(reorderGlobalIndex(artifact(), ['a', 'b'])).toBeNull();
  });
  it('미존재 slotId → null', () => {
    expect(reorderGlobalIndex(artifact(), ['a', 'b', 'x'])).toBeNull();
  });
  it('중복 입력 → null', () => {
    expect(reorderGlobalIndex(artifact(), ['a', 'a', 'b'])).toBeNull();
  });
});
