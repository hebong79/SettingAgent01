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

  it('perPreset 슬롯 수 = coveredSlotIds 길이 (PTZ 미보유 산출물 → ptz=null)', () => {
    const a = analyzeArtifact(sample);
    expect(a.perPreset).toEqual([
      { key: '1:1', camIdx: 1, presetIdx: 1, label: 'Preset 1', slotCount: 2, ptz: null },
      { key: '2:1', camIdx: 2, presetIdx: 1, label: 'Preset 1', slotCount: 1, ptz: null },
    ]);
  });

  it('preset 의 pan/tilt/zoom 이 모두 있으면 perPreset.ptz 로 노출', () => {
    const a = analyzeArtifact({
      ...sample,
      presets: [
        { camIdx: 1, presetIdx: 1, label: 'Preset 1', coveredSlotIds: ['c1p1s1'], pan: 12.5, tilt: -7.25, zoom: 2 },
        { camIdx: 2, presetIdx: 1, label: 'Preset 1', coveredSlotIds: ['c2p1s1'], pan: 0, tilt: 0, zoom: 1 },
      ],
    });
    expect(a.perPreset[0].ptz).toEqual({ pan: 12.5, tilt: -7.25, zoom: 2 });
    expect(a.perPreset[1].ptz).toEqual({ pan: 0, tilt: 0, zoom: 1 }); // 0 은 유효값(falsy 로 버리지 않음).
  });

  it('pan/tilt/zoom 일부 누락·비수치 → ptz=null (부분 표기 금지)', () => {
    const a = analyzeArtifact({
      ...sample,
      presets: [
        { camIdx: 1, presetIdx: 1, coveredSlotIds: [], pan: 10, tilt: 5 }, // zoom 누락
        { camIdx: 2, presetIdx: 1, coveredSlotIds: [], pan: 10, tilt: 5, zoom: '2' }, // 문자열
        { camIdx: 3, presetIdx: 1, coveredSlotIds: [], pan: Number.NaN, tilt: 5, zoom: 2 }, // NaN
      ],
    });
    expect(a.perPreset.map((p) => p.ptz)).toEqual([null, null, null]);
  });

  it('floorRoiByPreset → slot.hasFloor + totals.withFloor 카운트', () => {
    const withFloor = {
      ...sample,
      slots: [
        {
          slotId: 'c1p1s1',
          zone: 'A-01',
          roiByPreset: { '1:1': { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          floorRoiByPreset: {
            '1:1': [
              { x: 0.1, y: 0.6 },
              { x: 0.4, y: 0.6 },
              { x: 0.36, y: 0.4 },
              { x: 0.14, y: 0.4 },
            ],
          },
        },
        { slotId: 'c1p1s2', zone: 'A-02', roiByPreset: { '1:1': { x: 0.5, y: 0.2, w: 0.2, h: 0.3 } } },
      ],
    };
    const a = analyzeArtifact(withFloor);
    expect(a.totals.withFloor).toBe(1);
    const s0 = a.slots.find((s) => s.slotId === 'c1p1s1')!;
    const s1 = a.slots.find((s) => s.slotId === 'c1p1s2')!;
    expect(s0.hasFloor).toBe(true);
    expect(s1.hasFloor).toBe(false);
  });

  it('floor 없는 산출물 → withFloor=0, 모든 slot.hasFloor=false', () => {
    const a = analyzeArtifact(sample);
    expect(a.totals.withFloor).toBe(0);
    expect(a.slots.every((s) => s.hasFloor === false)).toBe(true);
  });
});
