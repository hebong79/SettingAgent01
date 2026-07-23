import { describe, it, expect } from 'vitest';
import { compareOccupancyAgreement, type LogicOccupancyPreset } from '../src/capture/Finalizer.js';
import type { CaptureSnapshot } from '../src/capture/CaptureJob.js';
import type { OccupancyJudgment } from '../src/brain/SetupBrain.js';

/** occByPreset 엔트리(축소 occupancy) 최소 구성 — 함수가 읽는 필드는 spaces[].id/.occupied 뿐. */
function judgment(spaces: Array<{ id: number; occupied: boolean }>): OccupancyJudgment {
  const occupiedCount = spaces.filter((s) => s.occupied).length;
  return { spaces, occupiedCount, total: spaces.length, rate: spaces.length ? occupiedCount / spaces.length : 0, confidence: 1 };
}

/** compareOccupancyAgreement 는 snapshot.occByPreset 만 참조 — 나머지 필드는 빈 값으로 채운다. */
function snapshot(occ: Map<string, OccupancyJudgment>): CaptureSnapshot {
  return { dets: [], presetRounds: new Map(), aggregated: [], occByPreset: occ };
}

describe('compareOccupancyAgreement', () => {
  it('완전 합의: agreementRate=1', () => {
    const snap = snapshot(new Map([['1:1', judgment([{ id: 1, occupied: true }, { id: 2, occupied: false }])]]));
    const logic: LogicOccupancyPreset[] = [
      { key: '1:1', spaces: [{ idx: 1, occupied: true }, { idx: 2, occupied: false }] },
    ];
    expect(compareOccupancyAgreement(snap, logic)).toEqual({
      comparedPresets: 1,
      comparedSpaces: 2,
      agreedSpaces: 2,
      agreementRate: 1,
    });
  });

  it('부분 불일치: 한 면만 어긋나면 rate=0.5', () => {
    const snap = snapshot(new Map([['1:1', judgment([{ id: 1, occupied: true }, { id: 2, occupied: true }])]]));
    const logic: LogicOccupancyPreset[] = [
      { key: '1:1', spaces: [{ idx: 1, occupied: true }, { idx: 2, occupied: false }] },
    ];
    expect(compareOccupancyAgreement(snap, logic)).toEqual({
      comparedPresets: 1,
      comparedSpaces: 2,
      agreedSpaces: 1,
      agreementRate: 0.5,
    });
  });

  it('logicOccupancy 미제공(undefined/빈배열): undefined 반환', () => {
    const snap = snapshot(new Map([['1:1', judgment([{ id: 1, occupied: true }])]]));
    expect(compareOccupancyAgreement(snap, undefined)).toBeUndefined();
    expect(compareOccupancyAgreement(snap, [])).toBeUndefined();
  });

  it('비교 가능한 면 0개(키/면 미매칭): undefined 반환', () => {
    const snap = snapshot(new Map([['1:1', judgment([{ id: 9, occupied: true }])]]));
    // 프리셋 키는 없고(2:2), 면 id 도 안 맞음 → comparedSpaces=0.
    const logic: LogicOccupancyPreset[] = [{ key: '2:2', spaces: [{ idx: 1, occupied: true }] }];
    expect(compareOccupancyAgreement(snap, logic)).toBeUndefined();
  });
});
