import { describe, it, expect } from 'vitest';
import { analyzeArtifact } from '../web/core.js';

const sample = {
  createdAt: '2026-06-25T07:43:15.378Z',
  presets: [
    { camIdx: 1, presetIdx: 1, label: 'Preset 1', coveredSlotIds: ['c1p1s1', 'c1p1s2'] },
    { camIdx: 2, presetIdx: 1, label: 'Preset 1', coveredSlotIds: ['c2p1s1'] },
  ],
  slots: [
    {
      slotId: 'c1p1s1',
      zone: 'A-01',
      roiByPreset: { '1:1': { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
      plateRoiByPreset: { '1:1': { x: 0.15, y: 0.25, w: 0.05, h: 0.03 } },
    },
    { slotId: 'c1p1s2', zone: 'A-02', roiByPreset: { '1:1': { x: 0.5, y: 0.2, w: 0.2, h: 0.3 } } },
    { slotId: 'c2p1s1', zone: 'B-01', roiByPreset: { '2:1': { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } } },
  ],
  globalIndex: [
    { globalIdx: 2, slotId: 'c1p1s2', camIdx: 1, presetIdx: 1 },
    { globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 },
    { globalIdx: 3, slotId: 'c2p1s1', camIdx: 2, presetIdx: 1 },
  ],
  warnings: ['기대 2 ≠ 검출 3'],
  report: '설치 완료',
};

describe('analyzeArtifact (최종 셋업 산출물 분석)', () => {
  it('null/비객체 → ok:false, 빈 요약', () => {
    const a = analyzeArtifact(null);
    expect(a.ok).toBe(false);
    expect(a.totals.slots).toBe(0);
    expect(a.slots).toEqual([]);
  });

  it('집계 카운트', () => {
    const a = analyzeArtifact(sample);
    expect(a.ok).toBe(true);
    expect(a.totals).toMatchObject({
      cameras: 2,
      presets: 2,
      slots: 3,
      globalSlots: 3,
      withPlate: 1,
      warnings: 1,
      zones: 3,
    });
    expect(a.report).toBe('설치 완료');
    expect(a.createdAt).toBe('2026-06-25T07:43:15.378Z');
  });

  it('slots 는 globalIdx 오름차순 + presetKey/roi/번호판 평탄화', () => {
    const a = analyzeArtifact(sample);
    expect(a.slots.map((s) => s.globalIdx)).toEqual([1, 2, 3]);
    expect(a.slots[0]).toMatchObject({
      slotId: 'c1p1s1',
      zone: 'A-01',
      presetKey: '1:1',
      hasPlate: true,
      roi: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });
    expect(a.slots[1].hasPlate).toBe(false);
  });

  it('globalIndex 에 없는 슬롯은 globalIdx=null (맨 뒤로)', () => {
    const a = analyzeArtifact({
      ...sample,
      globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    });
    const last = a.slots[a.slots.length - 1];
    expect(last.globalIdx).toBeNull();
  });

  it('perPreset 슬롯 수 = coveredSlotIds 길이', () => {
    const a = analyzeArtifact(sample);
    expect(a.perPreset).toEqual([
      { key: '1:1', camIdx: 1, presetIdx: 1, label: 'Preset 1', slotCount: 2 },
      { key: '2:1', camIdx: 2, presetIdx: 1, label: 'Preset 1', slotCount: 1 },
    ]);
  });
});
