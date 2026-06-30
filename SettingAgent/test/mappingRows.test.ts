import { describe, it, expect } from 'vitest';
import { buildMappingRows, applyManualGlobalIds } from '../web/core.js';
import type { ArtifactLike } from '../web/core.js';

const artifact: ArtifactLike = {
  presets: [
    { camIdx: 1, presetIdx: 1, label: 'P1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] },
    { camIdx: 1, presetIdx: 3, label: 'P3', coveredSlotIds: ['c1p3s1'] },
  ],
  slots: [
    { slotId: 'c1p3s1', zone: 'B-01', roiByPreset: { '1:3': { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } } },
    { slotId: 'c1p1s1', zone: 'A-01', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } } },
    { slotId: 'c1p1s2', zone: 'A-02', roiByPreset: { '1:1': { x: 0.3, y: 0.1, w: 0.1, h: 0.1 } } },
  ],
  globalIndex: [
    { globalIdx: 3, slotId: 'c1p3s1', camIdx: 1, presetIdx: 3 },
    { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
    { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
  ],
};

describe('buildMappingRows (매핑 표 행)', () => {
  it('카메라→프리셋→위치 순 정렬 + 컬럼 도출', () => {
    const rows = buildMappingRows(artifact);
    expect(rows.map((r) => r.slotId)).toEqual(['c1p1s1', 'c1p1s2', 'c1p3s1']);
    expect(rows[0]).toMatchObject({ camIdx: 1, presetIdx: 1, positionIdx: 1, zone: 'A-01', globalIdx: 1 });
    expect(rows[2]).toMatchObject({ camIdx: 1, presetIdx: 3, positionIdx: 1, zone: 'B-01', globalIdx: 3 });
  });
  it('null 산출물 → 빈 배열', () => {
    expect(buildMappingRows(null)).toEqual([]);
  });
});

describe('applyManualGlobalIds (전역ID 직접 입력 적용)', () => {
  it('유효 매핑 → 새 globalIndex(정렬)', () => {
    const res = applyManualGlobalIds(artifact, { c1p1s1: 2, c1p1s2: 1, c1p3s1: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const gi = res.artifact.globalIndex ?? [];
      expect(gi.map((g) => `${g.globalIdx}:${g.slotId}`)).toEqual(['1:c1p1s2', '2:c1p1s1', '3:c1p3s1']);
      expect(gi[0]).toMatchObject({ camIdx: 1, presetIdx: 1 });
    }
  });
  it('중복 전역ID → 실패', () => {
    const res = applyManualGlobalIds(artifact, { c1p1s1: 1, c1p1s2: 1, c1p3s1: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('중복');
  });
  it('누락/비정수 → 실패', () => {
    expect(applyManualGlobalIds(artifact, { c1p1s1: 1, c1p1s2: 2 }).ok).toBe(false); // c1p3s1 누락
    expect(applyManualGlobalIds(artifact, { c1p1s1: 0, c1p1s2: 2, c1p3s1: 3 }).ok).toBe(false); // 0
  });
  it('1..N 아닌 값(범위 밖) → 누락으로 실패', () => {
    const res = applyManualGlobalIds(artifact, { c1p1s1: 1, c1p1s2: 2, c1p3s1: 9 });
    expect(res.ok).toBe(false); // 3개인데 9 → 3 누락
  });
});
