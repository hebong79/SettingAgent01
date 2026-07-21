import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSetupResult, SETUP_RESULT_NAME } from '../src/store/setupResult.js';
import { SaveStore } from '../src/store/SaveStore.js';
import type { SlotSetupView } from '../src/capture/types.js';

/**
 * 검증자(qa-tester): slot_setup 뷰 → 최종결과물 setup_result.json 변환(buildSetupResult).
 * 정본 스키마는 data/setup_result_sample.json — 키 집합·타입을 샘플과 교차 비교한다.
 */

/** slot_setup 뷰 1건(기본=완전 슬롯: roi/occupyRange/PTZ 보유). */
function view(over: Partial<SlotSetupView> = {}): SlotSetupView {
  return {
    slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, presetKey: '1:1',
    roi: [{ x: 0.02985, y: 0.76733 }, { x: 0.00452, y: 0.66839 }, { x: 0.14525, y: 0.6523 }, { x: 0.19678, y: 0.74427 }],
    vpd: null, lpd: null,
    occupyRange: [{ x: 0.0957, y: 0.71254 }, { x: 0.1386, y: 0.70949 }, { x: 0.13715, y: 0.68915 }, { x: 0.09425, y: 0.6922 }],
    pan: 7.68045, tilt: 10.74063, zoom: 8.99252,
    centered: true, img1: null, slot3dFrontCenter: null, updatedAt: null,
    ...over,
  };
}

describe('buildSetupResult(slot_setup → setup_result.json)', () => {
  it('완전 슬롯: 샘플 스키마와 동일한 키·값 매핑', () => {
    const out = buildSetupResult([view()]);
    expect(out.slots).toHaveLength(1);
    expect(out.slots[0]).toEqual({
      slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1,
      floor_roi: [{ x: 0.02985, y: 0.76733 }, { x: 0.00452, y: 0.66839 }, { x: 0.14525, y: 0.6523 }, { x: 0.19678, y: 0.74427 }],
      occupy_roi: [{ x: 0.0957, y: 0.71254 }, { x: 0.1386, y: 0.70949 }, { x: 0.13715, y: 0.68915 }, { x: 0.09425, y: 0.6922 }],
      centering: { pan: 7.68045, tilt: 10.74063, zoom: 8.99252 },
    });
  });

  it('샘플 파일(data/setup_result_sample.json)과 최상위·슬롯 키 집합 일치', () => {
    const sample = JSON.parse(readFileSync('data/setup_result_sample.json', 'utf-8')) as {
      slots: Array<Record<string, unknown>>;
    };
    const out = buildSetupResult([view()]);
    expect(Object.keys(out)).toEqual(Object.keys(sample));
    expect(Object.keys(out.slots[0]).sort()).toEqual(Object.keys(sample.slots[0]).sort());
    expect(Object.keys(out.slots[0].centering!).sort()).toEqual(
      Object.keys(sample.slots[0].centering as object).sort(),
    );
  });

  it('미센터라이징 슬롯: centering=null(0 위장 금지), 점유 미도출: occupy_roi=null', () => {
    const out = buildSetupResult([view({ pan: null, tilt: null, zoom: null, occupyRange: null, centered: false })]);
    expect(out.slots[0].centering).toBeNull();
    expect(out.slots[0].occupy_roi).toBeNull();
    expect(out.slots[0].floor_roi).toHaveLength(4); // 기하는 그대로 유지
  });

  it('PTZ 일부만 있으면 centering=null(부분값 방출 금지)', () => {
    const out = buildSetupResult([view({ zoom: null })]);
    expect(out.slots[0].centering).toBeNull();
  });

  it('행 순서는 소스(getSlotSetup 정렬) 보존', () => {
    const out = buildSetupResult([view({ slotId: 3 }), view({ slotId: 1 }), view({ slotId: 2 })]);
    expect(out.slots.map((s) => s.slotId)).toEqual([3, 1, 2]);
  });

  it('빈 slot_setup → slots: []', () => {
    expect(buildSetupResult([])).toEqual({ slots: [] });
  });

  it('SETUP_RESULT_NAME 은 SaveStore 안전화를 통과(고정 파일명 save/setup_result.json)', () => {
    expect(new SaveStore('save').sanitizeName(SETUP_RESULT_NAME)).toBe('setup_result');
  });
});
