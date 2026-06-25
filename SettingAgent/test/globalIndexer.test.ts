import { describe, it, expect } from 'vitest';
import { buildGlobalIndex, validateCoverage, indexMap, type IndexableSlot } from '../src/setup/GlobalIndexer.js';
import type { ParkingSlot } from '../src/domain/types.js';

describe('buildGlobalIndex', () => {
  const slots: IndexableSlot[] = [
    { slotId: 'c2p1s1', camIdx: 2, presetIdx: 1, positionIdx: 1 },
    { slotId: 'c1p2s1', camIdx: 1, presetIdx: 2, positionIdx: 1 },
    { slotId: 'c1p1s2', camIdx: 1, presetIdx: 1, positionIdx: 2 },
    { slotId: 'c1p1s1', camIdx: 1, presetIdx: 1, positionIdx: 1 },
  ];

  it('cam→preset→position 순으로 전역 인덱스 부여', () => {
    const g = buildGlobalIndex(slots);
    expect(g.map((x) => x.slotId)).toEqual(['c1p1s1', 'c1p1s2', 'c1p2s1', 'c2p1s1']);
    expect(g.map((x) => x.globalIdx)).toEqual([1, 2, 3, 4]);
  });

  it('결정적/멱등 - 입력 순서 무관 동일 결과', () => {
    const a = buildGlobalIndex(slots);
    const b = buildGlobalIndex([...slots].reverse());
    expect(a).toEqual(b);
  });

  it('indexMap', () => {
    const m = indexMap(buildGlobalIndex(slots));
    expect(m.get('c1p1s1')).toBe(1);
    expect(m.get('c2p1s1')).toBe(4);
  });
});

describe('validateCoverage', () => {
  const mkSlot = (id: string): ParkingSlot => ({ slotId: id, zone: 'z', roiByPreset: {} });

  it('일치하면 ok', () => {
    const g = buildGlobalIndex([{ slotId: 'a', camIdx: 1, presetIdx: 1, positionIdx: 1 }]);
    const res = validateCoverage(g, [mkSlot('a')]);
    expect(res.ok).toBe(true);
  });

  it('누락 탐지', () => {
    const g = buildGlobalIndex([{ slotId: 'a', camIdx: 1, presetIdx: 1, positionIdx: 1 }]);
    const res = validateCoverage(g, [mkSlot('a'), mkSlot('b')]);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['b']);
  });
});
