import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTouringPlan } from '../web/core.js';

// 실데이터 fixture — save/setup_result.json(고정본, 23슬롯). cwd=SettingAgent 기준 상대경로.
// 그룹: cam1:preset1(7)·cam1:preset2(4)·cam1:preset3(2)·cam2:preset1(6)·cam2:preset2(4) = 23.
const realSetup = JSON.parse(readFileSync('save/setup_result.json', 'utf8')) as {
  slots: Array<{
    slotId: number;
    camId: number;
    presetId: number;
    presetSlotIdx: number | null;
    centering: { pan: number; tilt: number; zoom: number } | null;
  }>;
};

describe('buildTouringPlan — 실데이터 23슬롯 그룹핑·순서', () => {
  it('preset 스텝은 그룹당 1개(총 5개), 순서 1:1→1:2→1:3→2:1→2:2', () => {
    const { steps, skipped } = buildTouringPlan(realSetup);
    const presets = steps.filter((s) => s.kind === 'preset');
    expect(presets.map((p) => `${p.camId}:${p.presetId}`)).toEqual([
      '1:1',
      '1:2',
      '1:3',
      '2:1',
      '2:2',
    ]);
    // 실데이터 23슬롯 전부 centering non-null → skipped 0, slot 스텝 23개.
    const slots = steps.filter((s) => s.kind === 'slot');
    expect(slots).toHaveLength(23);
    expect(skipped).toBe(0);
    // 전체 스텝 = 5 preset + 23 slot = 28.
    expect(steps).toHaveLength(28);
  });

  it('각 preset 스텝 직후에 그 그룹의 slot 스텝들이 배치된다(카메라→프리셋→슬롯)', () => {
    const { steps } = buildTouringPlan(realSetup);
    // 그룹별 기대 slot 개수.
    const expectedCounts: Record<string, number> = {
      '1:1': 7,
      '1:2': 4,
      '1:3': 2,
      '2:1': 6,
      '2:2': 4,
    };
    let curKey: string | null = null;
    const counts: Record<string, number> = {};
    for (const step of steps) {
      const key = `${step.camId}:${step.presetId}`;
      if (step.kind === 'preset') {
        curKey = key;
        counts[key] = 0;
      } else {
        // slot 스텝은 반드시 직전 preset 스텝과 같은 그룹에 속한다(그룹 경계 넘지 않음).
        expect(key).toBe(curKey);
        counts[key] += 1;
      }
    }
    expect(counts).toEqual(expectedCounts);
  });

  it('preset 스텝은 ptz를 보유하지 않는다(런타임 findPresetPtz가 채움)', () => {
    const { steps } = buildTouringPlan(realSetup);
    for (const p of steps.filter((s) => s.kind === 'preset')) {
      expect('ptz' in p).toBe(false);
    }
  });

  it('slot 스텝 순서는 그룹 내 presetSlotIdx 오름차순', () => {
    const { steps } = buildTouringPlan(realSetup);
    let curKey: string | null = null;
    let prevIdx = -Infinity;
    for (const step of steps) {
      const key = `${step.camId}:${step.presetId}`;
      if (step.kind === 'preset') {
        curKey = key;
        prevIdx = -Infinity;
      } else if (step.kind === 'slot') {
        const idx = step.presetSlotIdx ?? 0;
        expect(idx).toBeGreaterThanOrEqual(prevIdx);
        prevIdx = idx;
        expect(key).toBe(curKey);
      }
    }
  });

  it('slot 스텝 ptz는 원본 centering(pan/tilt/zoom)과 동일값', () => {
    const { steps } = buildTouringPlan(realSetup);
    // slotId → centering 매핑 대조.
    const byId = new Map(realSetup.slots.map((s) => [s.slotId, s.centering]));
    for (const step of steps) {
      if (step.kind !== 'slot') continue;
      const c = byId.get(step.slotId)!;
      expect(step.ptz).toEqual({ pan: c!.pan, tilt: c!.tilt, zoom: c!.zoom });
    }
  });
});

describe('buildTouringPlan — centering=null 스킵', () => {
  it('동일 그룹 2슬롯(1 centering, 1 null): steps=[preset, slot], skipped=1', () => {
    const input = {
      slots: [
        {
          slotId: 1,
          camId: 1,
          presetId: 1,
          presetSlotIdx: 1,
          centering: { pan: 5, tilt: 10, zoom: 3 },
        },
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, centering: null },
      ],
    };
    const { steps, skipped } = buildTouringPlan(input);
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe('preset');
    expect(steps[1].kind).toBe('slot');
    expect(skipped).toBe(1);
    expect((steps[1] as { ptz: unknown }).ptz).toEqual({ pan: 5, tilt: 10, zoom: 3 });
  });

  it('부분 결손 centering(zoom 누락)도 스킵(위장 이동 금지)', () => {
    // fetch 응답은 untyped parsed JSON — 런타임 결손 데이터를 방어하는지 확인(타입은 as로 우회).
    const input = {
      slots: [
        // zoom 누락 — pan/tilt만 있음.
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 5, tilt: 10 } },
      ],
    } as unknown as Parameters<typeof buildTouringPlan>[0];
    const { steps, skipped } = buildTouringPlan(input);
    // preset 스텝은 발행되지만 slot 스텝은 없음.
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('preset');
    expect(skipped).toBe(1);
  });

  it('그룹의 모든 슬롯 centering=null이어도 그 그룹 preset 스텝은 발행된다', () => {
    const input = {
      slots: [
        { slotId: 1, camId: 2, presetId: 5, presetSlotIdx: 1, centering: null },
        { slotId: 2, camId: 2, presetId: 5, presetSlotIdx: 2, centering: null },
      ],
    };
    const { steps, skipped } = buildTouringPlan(input);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ kind: 'preset', camId: 2, presetId: 5 });
    expect(skipped).toBe(2);
  });
});

describe('buildTouringPlan — graceful 빈/무효 입력', () => {
  it('{slots:[]} → {steps:[], skipped:0}', () => {
    expect(buildTouringPlan({ slots: [] })).toEqual({ steps: [], skipped: 0 });
  });

  it('null → {steps:[], skipped:0} (throw 없음)', () => {
    expect(buildTouringPlan(null)).toEqual({ steps: [], skipped: 0 });
  });

  it('undefined → {steps:[], skipped:0} (throw 없음)', () => {
    expect(buildTouringPlan(undefined)).toEqual({ steps: [], skipped: 0 });
  });

  it('{} (slots 없음) → {steps:[], skipped:0}', () => {
    expect(buildTouringPlan({} as { slots?: never })).toEqual({ steps: [], skipped: 0 });
  });
});

describe('buildTouringPlan — 단일 그룹 다중 슬롯', () => {
  it('1:1에 슬롯 3개(모두 centering): preset 1 + slot 3, presetSlotIdx 오름차순', () => {
    const input = {
      slots: [
        {
          slotId: 1,
          camId: 1,
          presetId: 1,
          presetSlotIdx: 1,
          centering: { pan: 1, tilt: 1, zoom: 1 },
        },
        {
          slotId: 2,
          camId: 1,
          presetId: 1,
          presetSlotIdx: 2,
          centering: { pan: 2, tilt: 2, zoom: 2 },
        },
        {
          slotId: 3,
          camId: 1,
          presetId: 1,
          presetSlotIdx: 3,
          centering: { pan: 3, tilt: 3, zoom: 3 },
        },
      ],
    };
    const { steps, skipped } = buildTouringPlan(input);
    expect(steps.filter((s) => s.kind === 'preset')).toHaveLength(1);
    const slots = steps.filter((s) => s.kind === 'slot');
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => (s as { presetSlotIdx: number }).presetSlotIdx)).toEqual([1, 2, 3]);
    expect(skipped).toBe(0);
  });
});

describe('buildTouringPlan — 방어적 재정렬(결정성)', () => {
  it('그룹 뒤섞인 입력(1:1, 2:1, 1:1)도 정렬 후 그룹당 preset 스텝 1개', () => {
    const input = {
      slots: [
        {
          slotId: 10,
          camId: 1,
          presetId: 1,
          presetSlotIdx: 2,
          centering: { pan: 2, tilt: 2, zoom: 2 },
        },
        {
          slotId: 20,
          camId: 2,
          presetId: 1,
          presetSlotIdx: 1,
          centering: { pan: 9, tilt: 9, zoom: 9 },
        },
        {
          slotId: 11,
          camId: 1,
          presetId: 1,
          presetSlotIdx: 1,
          centering: { pan: 1, tilt: 1, zoom: 1 },
        },
      ],
    };
    const { steps } = buildTouringPlan(input);
    const presets = steps.filter((s) => s.kind === 'preset');
    // 1:1 그룹 preset 스텝은 재정렬로 병합돼 1개만(중복 없음), 그다음 2:1.
    expect(presets.map((p) => `${p.camId}:${p.presetId}`)).toEqual(['1:1', '2:1']);
    // 순서: preset1:1, slot(idx1,slotId11), slot(idx2,slotId10), preset2:1, slot(slotId20).
    expect(steps.map((s) => (s.kind === 'preset' ? `P${s.camId}:${s.presetId}` : `S${s.slotId}`))).toEqual([
      'P1:1',
      'S11',
      'S10',
      'P2:1',
      'S20',
    ]);
  });

  it('presetSlotIdx=null이 섞여도 throw 없이 결정적으로 정렬(null→0 취급, slotId tie-break)', () => {
    const input = {
      slots: [
        {
          slotId: 5,
          camId: 1,
          presetId: 1,
          presetSlotIdx: null,
          centering: { pan: 1, tilt: 1, zoom: 1 },
        },
        {
          slotId: 3,
          camId: 1,
          presetId: 1,
          presetSlotIdx: null,
          centering: { pan: 2, tilt: 2, zoom: 2 },
        },
      ],
    };
    const { steps } = buildTouringPlan(input);
    const slots = steps.filter((s) => s.kind === 'slot');
    // presetSlotIdx 동률(null→0) → slotId 오름차순 tie-break: 3, 5.
    expect(slots.map((s) => (s as { slotId: number }).slotId)).toEqual([3, 5]);
  });
});

describe('buildTouringPlan — 스텝 shape 계약', () => {
  it('preset 스텝 키는 {kind,camId,presetId}만, slot 스텝 키는 {kind,camId,presetId,presetSlotIdx,slotId,ptz}', () => {
    const input = {
      slots: [
        {
          slotId: 7,
          camId: 1,
          presetId: 2,
          presetSlotIdx: 3,
          centering: { pan: 5.1, tilt: 10.8, zoom: 11.2 },
        },
      ],
    };
    const { steps } = buildTouringPlan(input);
    const preset = steps.find((s) => s.kind === 'preset')!;
    const slot = steps.find((s) => s.kind === 'slot')!;
    expect(Object.keys(preset).sort()).toEqual(['camId', 'kind', 'presetId']);
    expect(Object.keys(slot).sort()).toEqual([
      'camId',
      'kind',
      'presetId',
      'presetSlotIdx',
      'ptz',
      'slotId',
    ]);
    // 값 계약.
    expect(preset).toEqual({ kind: 'preset', camId: 1, presetId: 2 });
    expect(slot).toEqual({
      kind: 'slot',
      camId: 1,
      presetId: 2,
      presetSlotIdx: 3,
      slotId: 7,
      ptz: { pan: 5.1, tilt: 10.8, zoom: 11.2 },
    });
  });
});

describe('Touring Test 버튼 위치 — 센터라이징 영역(.centering-inline)', () => {
  const html = readFileSync('web/index.html', 'utf8');
  const appJs = readFileSync('web/app.js', 'utf8');

  it('#cap-touring 은 .centering-inline 안(#cal-start 뒤)에 있고, 정밀수집 툴바에는 없다', () => {
    const inline = html.slice(html.indexOf('<div class="centering-inline">'));
    const block = inline.slice(0, inline.indexOf('id="cal-summary"')); // centering-inline 마지막 요소까지.
    expect(block.indexOf('id="cap-touring"')).toBeGreaterThan(block.indexOf('id="cal-start"'));
    const toolbar = html.slice(html.indexOf('class="cap-actions toolbar capture-actions"'));
    expect(toolbar.slice(0, toolbar.indexOf('</div>'))).not.toContain('cap-touring');
  });

  it('클릭 결선(runTouringTest)은 그대로 유지된다', () => {
    expect(appJs).toContain("$('cap-touring').addEventListener('click', runTouringTest)");
  });
});
