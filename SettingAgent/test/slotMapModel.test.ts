import { describe, it, expect } from 'vitest';
import { slotMapModel } from '../web/core.js';
import type { MappingRow } from '../web/core.js';

const rows: MappingRow[] = [
  { slotId: 'c1p1s1', camIdx: 1, presetIdx: 1, positionIdx: 1, zone: 'A-01', globalIdx: 1 },
  { slotId: 'c1p3s1', camIdx: 1, presetIdx: 3, positionIdx: 1, zone: 'B-01', globalIdx: 2 },
];

describe('slotMapModel (슬롯 박스 맵 모델)', () => {
  it('전역ID 라벨·그룹·선택 플래그', () => {
    const boxes = slotMapModel(rows, { c1p1s1: 7, c1p3s1: 8 }, 'c1p3s1');
    expect(boxes[0]).toEqual({ slotId: 'c1p1s1', label: '7', group: '1:1', bad: false, selected: false });
    expect(boxes[1]).toEqual({ slotId: 'c1p3s1', label: '8', group: '1:3', bad: false, selected: true });
  });

  it('전역ID 없음/빈값 → label "?" + bad', () => {
    const boxes = slotMapModel(rows, { c1p1s1: '', c1p3s1: undefined }, null);
    expect(boxes[0].label).toBe('?');
    expect(boxes[0].bad).toBe(true);
    expect(boxes[1].bad).toBe(true);
  });

  it('빈 rows → 빈 배열', () => {
    expect(slotMapModel([], {}, null)).toEqual([]);
    expect(slotMapModel(null, null, null)).toEqual([]);
  });
});
