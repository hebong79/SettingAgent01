import { describe, it, expect } from 'vitest';
import { applyManualPlacement } from '../web/core.js';
import type { ArtifactLike } from '../web/core.js';

/**
 * 검증자(qa): 전역 인덱스 수동 매핑 표의 **배치 편집**(카메라/프리셋/프리셋내 위치) 클라 게이트.
 * slotId 는 DB slot_id(전역 정수) 문자열 — buildArtifactFromSlotSetup 산출 형식과 동일.
 */

const rect = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
const artifact: ArtifactLike = {
  presets: [
    { camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['1', '2'] },
    { camIdx: 1, presetIdx: 2, label: '1:2', coveredSlotIds: ['3'] },
  ],
  slots: [
    { slotId: '1', zone: 'cam1', roiByPreset: { '1:1': rect } },
    { slotId: '2', zone: 'cam1', roiByPreset: { '1:1': rect } },
    { slotId: '3', zone: 'cam1', roiByPreset: { '1:2': rect } },
  ],
  globalIndex: [
    { globalIdx: 1, slotId: '1', camIdx: 1, presetIdx: 1 },
    { globalIdx: 2, slotId: '2', camIdx: 1, presetIdx: 1 },
    { globalIdx: 3, slotId: '3', camIdx: 1, presetIdx: 2 },
  ],
};

/** 현재 배치 그대로의 입력(무변경 기준선). */
const asIs = {
  1: { camIdx: 1, presetIdx: 1, positionIdx: 1 },
  2: { camIdx: 1, presetIdx: 1, positionIdx: 2 },
  3: { camIdx: 1, presetIdx: 2, positionIdx: 1 },
};

describe('applyManualPlacement (배치 직접 입력)', () => {
  it('무변경 입력 → ok, changed=false, 제출 shape 전량', () => {
    const res = applyManualPlacement(artifact, asIs);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.changed).toBe(false);
      expect(res.placements).toEqual([
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1 },
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2 },
        { slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 1 },
      ]);
    }
  });

  it('같은 프리셋 안 위치 교환 → ok, changed=true', () => {
    const res = applyManualPlacement(artifact, {
      ...asIs,
      1: { camIdx: 1, presetIdx: 1, positionIdx: 2 },
      2: { camIdx: 1, presetIdx: 1, positionIdx: 1 },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.changed).toBe(true);
      expect(res.placements.find((p) => p.slotId === 1)!.presetSlotIdx).toBe(2);
    }
  });

  it('다른 프리셋으로 이동(위치 연속 유지) → ok', () => {
    // slot2 를 1:2 의 2번 위치로 이동 → 1:1={1}, 1:2={3,2}
    const res = applyManualPlacement(artifact, {
      ...asIs,
      2: { camIdx: 1, presetIdx: 2, positionIdx: 2 },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(true);
  });

  it('삼중키 충돌(같은 cam·preset·위치) → 실패', () => {
    const res = applyManualPlacement(artifact, {
      ...asIs,
      2: { camIdx: 1, presetIdx: 1, positionIdx: 1 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('배치 충돌');
  });

  it('위치 불연속(1,3) → 실패', () => {
    const res = applyManualPlacement(artifact, {
      ...asIs,
      2: { camIdx: 1, presetIdx: 1, positionIdx: 3 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('1..2 연속');
  });

  it('이동 후 원래 프리셋에 구멍(1:1 이 위치2만 남음) → 실패', () => {
    const res = applyManualPlacement(artifact, {
      ...asIs,
      1: { camIdx: 1, presetIdx: 2, positionIdx: 2 }, // slot1 이 빠져 1:1 은 위치2 만 남음
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('연속');
  });

  it('빈 값·0·비정수 → 실패', () => {
    expect(applyManualPlacement(artifact, { ...asIs, 2: { camIdx: 1, presetIdx: 1, positionIdx: '' } }).ok).toBe(false);
    expect(applyManualPlacement(artifact, { ...asIs, 2: { camIdx: 0, presetIdx: 1, positionIdx: 2 } }).ok).toBe(false);
    expect(applyManualPlacement(artifact, { ...asIs, 2: { camIdx: 1, presetIdx: 1.5, positionIdx: 2 } }).ok).toBe(false);
  });

  it('산출물 없음 → 실패', () => {
    expect(applyManualPlacement(null, {}).ok).toBe(false);
  });

  it('구 형식 slotId(c1p1s1) → 배치 변경 불가(정직한 실패)', () => {
    const legacy: ArtifactLike = {
      presets: [{ camIdx: 1, presetIdx: 1, label: '1:1', coveredSlotIds: ['c1p1s1'] }],
      slots: [{ slotId: 'c1p1s1', zone: 'cam1', roiByPreset: { '1:1': rect } }],
      globalIndex: [{ globalIdx: 1, slotId: 'c1p1s1', camIdx: 1, presetIdx: 1 }],
    };
    const res = applyManualPlacement(legacy, { c1p1s1: { camIdx: 1, presetIdx: 1, positionIdx: 1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('전역 정수');
  });
});
