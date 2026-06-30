import { describe, it, expect } from 'vitest';
// 순수 ROI 편집 로직(#1~#3) — DOM/fetch 미참조.
import {
  diffArtifactVsCameras,
  pointInRect,
  pointInQuad,
  hitTestSlots,
  rebuildGlobalIndex,
  removeSlot,
  clamp01Rect,
  resizeRect,
  updateSlotRoi,
} from '../web/core.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';
import type { ArtifactLike } from '../web/core.js';

/** 3프리셋·소형 산출물(coveredSlotIds 순서 = position 진실). */
function sampleArtifact(): ArtifactLike {
  return {
    createdAt: 'T',
    presets: [
      { camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['a', 'b'] },
      { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['c'] },
    ],
    slots: [
      { slotId: 'a', zone: 'z', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
      { slotId: 'b', zone: 'z', roiByPreset: { '1:1': { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } },
      { slotId: 'c', zone: 'z', roiByPreset: { '1:2': { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
    ],
    globalIndex: [
      { globalIdx: 1, slotId: 'a', camIdx: 1, presetIdx: 1 },
      { globalIdx: 2, slotId: 'b', camIdx: 1, presetIdx: 1 },
      { globalIdx: 3, slotId: 'c', camIdx: 1, presetIdx: 2 },
    ],
  };
}

describe('diffArtifactVsCameras (#4 진단)', () => {
  it('산출물 1:3 보유 + cameras 1:1,1:2만 → artifactOnly:[1:3]', () => {
    const artifact = {
      presets: [
        { camIdx: 1, presetIdx: 1 },
        { camIdx: 1, presetIdx: 2 },
        { camIdx: 1, presetIdx: 3 },
      ],
    };
    const cameras = [{ camIdx: 1, presets: [{ presetIdx: 1 }, { presetIdx: 2 }] }];
    const d = diffArtifactVsCameras(artifact, cameras);
    expect(d.artifactOnly).toEqual(['1:3']);
    expect(d.camerasOnly).toEqual([]);
  });
  it('빈 입력 방어', () => {
    expect(diffArtifactVsCameras(null, undefined)).toEqual({ artifactOnly: [], camerasOnly: [] });
  });
  it('cameras 에만 있는 키 → camerasOnly', () => {
    const d = diffArtifactVsCameras(
      { presets: [{ camIdx: 1, presetIdx: 1 }] },
      [{ camIdx: 1, presets: [{ presetIdx: 1 }, { presetIdx: 9 }] }],
    );
    expect(d.camerasOnly).toEqual(['1:9']);
  });
});

describe('pointInRect / pointInQuad (#1 히트테스트)', () => {
  const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  it('내부', () => expect(pointInRect(0.3, 0.3, r)).toBe(true));
  it('경계(좌상)', () => expect(pointInRect(0.2, 0.2, r)).toBe(true));
  it('외부', () => expect(pointInRect(0.7, 0.7, r)).toBe(false));
  it('null rect 방어', () => expect(pointInRect(0.3, 0.3, null)).toBe(false));

  const quad = [
    { x: 0.2, y: 0.8 },
    { x: 0.8, y: 0.8 },
    { x: 0.7, y: 0.4 },
    { x: 0.3, y: 0.4 },
  ] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  it('quad 내부', () => expect(pointInQuad(0.5, 0.6, quad)).toBe(true));
  it('quad 외부', () => expect(pointInQuad(0.05, 0.05, quad)).toBe(false));
});

describe('hitTestSlots (#1)', () => {
  const slots = [
    { slotId: 'a', roiByPreset: { '1:1': { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } } },
    { slotId: 'b', roiByPreset: { '1:1': { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } } }, // a 와 겹침
  ];
  it('단일 매칭', () => {
    expect(hitTestSlots({ nx: 0.12, ny: 0.12, slots, key: '1:1' })).toBe('a');
  });
  it('겹친 슬롯 → 배열 끝(상단) 우선', () => {
    expect(hitTestSlots({ nx: 0.25, ny: 0.25, slots, key: '1:1' })).toBe('b');
  });
  it('빈 곳 → null', () => {
    expect(hitTestSlots({ nx: 0.9, ny: 0.9, slots, key: '1:1' })).toBeNull();
  });
  it('vehicle 레이어 off → rect 히트 제외', () => {
    expect(hitTestSlots({ nx: 0.12, ny: 0.12, slots, key: '1:1', layers: { vehicle: false } })).toBeNull();
  });
  it('floor quad 차선 매칭(rect 없을 때)', () => {
    const fslots = [
      {
        slotId: 'f',
        roiByPreset: {},
        floorRoiByPreset: {
          '1:1': [
            { x: 0.2, y: 0.8 },
            { x: 0.8, y: 0.8 },
            { x: 0.7, y: 0.4 },
            { x: 0.3, y: 0.4 },
          ],
        },
      },
    ];
    expect(hitTestSlots({ nx: 0.5, ny: 0.6, slots: fslots, key: '1:1' })).toBe('f');
  });
});

describe('rebuildGlobalIndex (#2 정합 — coveredSlotIds 순서 진실)', () => {
  it('cam→preset→position 순으로 1..N', () => {
    const a = sampleArtifact();
    const gi = rebuildGlobalIndex(a.slots, a.presets);
    expect(gi.map((g) => g.slotId)).toEqual(['a', 'b', 'c']);
    expect(gi.map((g) => g.globalIdx)).toEqual([1, 2, 3]);
  });
  it('coveredSlotIds 순서가 진실(slotId sN 파싱 아님)', () => {
    const presets = [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['b', 'a'] }];
    const slots = [
      { slotId: 'a', zone: 'z', roiByPreset: {} },
      { slotId: 'b', zone: 'z', roiByPreset: {} },
    ];
    const gi = rebuildGlobalIndex(slots, presets);
    expect(gi.map((g) => g.slotId)).toEqual(['b', 'a']);
  });
});

describe('removeSlot (#2 삭제)', () => {
  it('삭제 후 coverage ok, globalIdx 연속, coveredSlotIds 제거, 타 슬롯 ROI 불변', () => {
    const a = sampleArtifact();
    const next = removeSlot(a, 'b');
    expect(next.slots!.map((s) => s.slotId)).toEqual(['a', 'c']);
    const cov = validateCoverage(next.globalIndex as never, next.slots as never);
    expect(cov.ok).toBe(true);
    expect(next.globalIndex!.map((g) => g.globalIdx)).toEqual([1, 2]);
    expect(next.presets![0].coveredSlotIds).toEqual(['a']); // b 제거됨
    expect(next.slots![0].roiByPreset!['1:1']).toEqual(a.slots![0].roiByPreset!['1:1']); // a 불변
    // 원본 불변(불변 갱신).
    expect(a.slots!.length).toBe(3);
  });
});

describe('clamp01Rect / resizeRect (#3 크기 조정)', () => {
  it('se 핸들 +δ → w/h 증가', () => {
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, 'se', 0.1, 0.1);
    expect(r.w).toBeCloseTo(0.3, 6);
    expect(r.h).toBeCloseTo(0.3, 6);
    expect(r.x).toBeCloseTo(0.2, 6);
  });
  it('경계 클램프(1 초과 안 됨)', () => {
    const r = resizeRect({ x: 0.8, y: 0.8, w: 0.15, h: 0.15 }, 'se', 0.5, 0.5);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });
  it('음수 폭 방지(붕괴 → 최소폭, 좌우 뒤집힘 정규화)', () => {
    const r = resizeRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 'se', -0.5, -0.5);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
  it('clamp01Rect 음수 좌표 → 0', () => {
    const r = clamp01Rect({ x: -0.1, y: -0.2, w: 0.3, h: 0.3 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe('updateSlotRoi (#3)', () => {
  it('대상 slot roiByPreset[key] 만 교체, 타 슬롯 불변', () => {
    const a = sampleArtifact();
    const next = updateSlotRoi(a, 'a', '1:1', { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(next.slots![0].roiByPreset!['1:1']).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(next.slots![1].roiByPreset!['1:1']).toEqual(a.slots![1].roiByPreset!['1:1']);
    // globalIndex 불변(slot 집합 불변).
    expect(next.globalIndex).toBe(a.globalIndex);
  });
});
