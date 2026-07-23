import { describe, it, expect } from 'vitest';
import { buildArtifactFromSlotSetup } from '../src/setup/artifactFromSlotSetup.js';
import { validateCoverage } from '../src/setup/GlobalIndexer.js';
import type { SlotSetupView } from '../src/capture/types.js';
import type { NormalizedPoint, NormalizedQuad } from '../src/domain/types.js';

/**
 * 검증자(qa-tester): 순수 빌더 buildArtifactFromSlotSetup 단위 테스트.
 * 설계서 §6.1 — 빈배열/그룹핑/bbox/lpd/globalIndex/coverage/멀티카메라.
 * SlotSetupView fixture 를 직접 구성하고 now:()=>'T' 를 주입해 결정성 확보.
 */

const quad = (pts: [number, number][]): NormalizedQuad =>
  pts.map(([x, y]) => ({ x, y })) as unknown as NormalizedQuad;

const poly = (pts: [number, number][]): NormalizedPoint[] => pts.map(([x, y]) => ({ x, y }));

/** SlotSetupView fixture(필수 필드만 지정, 나머지는 무의미 기본값). */
const view = (o: Partial<SlotSetupView> & Pick<SlotSetupView, 'slotId' | 'camId' | 'presetId'>): SlotSetupView => ({
  presetSlotIdx: null,
  presetKey: `${o.camId}:${o.presetId}`,
  roi: poly([[0.2, 0.3], [0.6, 0.3], [0.6, 0.7], [0.2, 0.7]]),
  vpd: null,
  lpd: null,
  occupyRange: null,
  pan: null,
  tilt: null,
  zoom: null,
  centered: false,
  img1: null,
  slot3dFrontCenter: null,
  updatedAt: null,
  ...o,
});

describe('buildArtifactFromSlotSetup — 순수 빌더', () => {
  it('빈 views → presets/slots/globalIndex 빈 배열 + createdAt', () => {
    const a = buildArtifactFromSlotSetup([], () => 'T');
    expect(a).toEqual({ presets: [], slots: [], globalIndex: [], createdAt: 'T' });
  });

  it('presetKey 기준 그룹핑 — cam1:preset1 3행 + cam1:preset2 2행 → preset 2개', () => {
    const views = [
      view({ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 0 }),
      view({ slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 1 }),
      view({ slotId: 3, camId: 1, presetId: 1, presetSlotIdx: 2 }),
      view({ slotId: 4, camId: 1, presetId: 2, presetSlotIdx: 0 }),
      view({ slotId: 5, camId: 1, presetId: 2, presetSlotIdx: 1 }),
    ];
    const a = buildArtifactFromSlotSetup(views, () => 'T');
    expect(a.presets).toHaveLength(2);
    const p1 = a.presets.find((p) => p.label === '1:1')!;
    const p2 = a.presets.find((p) => p.label === '1:2')!;
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    // coveredSlotIds = String(slotId), presetSlotIdx(=SQL) 순서 보존
    expect(p1.coveredSlotIds).toEqual(['1', '2', '3']);
    expect(p2.coveredSlotIds).toEqual(['4', '5']);
    expect(p1.camIdx).toBe(1);
    expect(p1.presetIdx).toBe(1);
    expect(p2.presetIdx).toBe(2);
  });

  it('roiByPreset = slotRoi 폴리곤의 축정렬 bbox rect(x=min,y=min,w,h)', () => {
    const a = buildArtifactFromSlotSetup(
      [view({ slotId: 1, camId: 1, presetId: 1, roi: poly([[0.2, 0.3], [0.6, 0.3], [0.6, 0.7], [0.2, 0.7]]) })],
      () => 'T',
    );
    const rect = a.slots[0].roiByPreset['1:1'];
    expect(rect.x).toBeCloseTo(0.2, 10);
    expect(rect.y).toBeCloseTo(0.3, 10);
    expect(rect.w).toBeCloseTo(0.4, 10);
    expect(rect.h).toBeCloseTo(0.4, 10);
  });

  it('bbox 는 비대칭 다각형(6점)에서도 min/max 로 감싼다', () => {
    const a = buildArtifactFromSlotSetup(
      [view({ slotId: 1, camId: 1, presetId: 1, roi: poly([[0.1, 0.5], [0.3, 0.2], [0.7, 0.25], [0.8, 0.6], [0.5, 0.9], [0.2, 0.8]]) })],
      () => 'T',
    );
    const rect = a.slots[0].roiByPreset['1:1'];
    expect(rect.x).toBeCloseTo(0.1, 10);
    expect(rect.y).toBeCloseTo(0.2, 10);
    expect(rect.w).toBeCloseTo(0.7, 10); // 0.8-0.1
    expect(rect.h).toBeCloseTo(0.7, 10); // 0.9-0.2
  });

  it('빈 roi → 0-rect 방어(throw 없음)', () => {
    const a = buildArtifactFromSlotSetup([view({ slotId: 1, camId: 1, presetId: 1, roi: [] })], () => 'T');
    expect(a.slots[0].roiByPreset['1:1']).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('plateRoiByPreset — lpd 있을 때만 키 존재(값=quad), lpd=null 이면 키 부재', () => {
    const lpdQuad = quad([[0.3, 0.4], [0.5, 0.4], [0.5, 0.5], [0.3, 0.5]]);
    const views = [
      view({ slotId: 1, camId: 1, presetId: 1, lpd: lpdQuad }),
      view({ slotId: 2, camId: 1, presetId: 1, lpd: null }),
    ];
    const a = buildArtifactFromSlotSetup(views, () => 'T');
    const s1 = a.slots.find((s) => s.slotId === '1')!;
    const s2 = a.slots.find((s) => s.slotId === '2')!;
    expect(s1.plateRoiByPreset).toBeDefined();
    expect(s1.plateRoiByPreset!['1:1']).toEqual(lpdQuad);
    expect(s2.plateRoiByPreset).toBeUndefined();
  });

  it('globalIndex — globalIdx===v.slotId(number), slotId===String(v.slotId), camIdx/presetIdx 전달', () => {
    const a = buildArtifactFromSlotSetup(
      [view({ slotId: 7, camId: 2, presetId: 3 })],
      () => 'T',
    );
    expect(a.globalIndex[0]).toEqual({ globalIdx: 7, slotId: '7', camIdx: 2, presetIdx: 3 });
  });

  it('slot.slotId 는 String, zone === `cam${camId}`, createdAt=주입 now', () => {
    const a = buildArtifactFromSlotSetup([view({ slotId: 5, camId: 4, presetId: 1 })], () => '2026-01-01T00:00:00.000Z');
    expect(a.slots[0].slotId).toBe('5');
    expect(a.slots[0].zone).toBe('cam4');
    expect(a.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('coverage 성립 — validateCoverage(globalIndex, slots).ok===true (missing/extra 빈배열)', () => {
    const views = [
      view({ slotId: 1, camId: 1, presetId: 1 }),
      view({ slotId: 2, camId: 1, presetId: 1 }),
      view({ slotId: 3, camId: 2, presetId: 1 }),
    ];
    const a = buildArtifactFromSlotSetup(views, () => 'T');
    const cov = validateCoverage(a.globalIndex, a.slots);
    expect(cov.ok).toBe(true);
    expect(cov.missing).toEqual([]);
    expect(cov.extra).toEqual([]);
  });

  it('멀티카메라 — cam1·cam2 혼합 → preset 이 서로 다른 camIdx 로 분리', () => {
    const views = [
      view({ slotId: 1, camId: 1, presetId: 1 }),
      view({ slotId: 2, camId: 2, presetId: 1 }),
    ];
    const a = buildArtifactFromSlotSetup(views, () => 'T');
    expect(a.presets).toHaveLength(2);
    const cams = a.presets.map((p) => p.camIdx).sort();
    expect(cams).toEqual([1, 2]);
    // presetKey 는 camId 로 구분(같은 presetId 여도 다른 키)
    expect(a.presets.map((p) => p.label).sort()).toEqual(['1:1', '2:1']);
  });

  it('default now 미주입 시 createdAt 은 ISO 문자열', () => {
    const a = buildArtifactFromSlotSetup([view({ slotId: 1, camId: 1, presetId: 1 })]);
    expect(() => new Date(a.createdAt).toISOString()).not.toThrow();
    expect(a.createdAt).toBe(new Date(a.createdAt).toISOString());
  });
});
