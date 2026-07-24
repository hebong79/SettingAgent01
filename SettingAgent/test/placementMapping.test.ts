import { describe, it, expect } from 'vitest';
import { validateSlotPlacement, type CurrentPlacement } from '../src/setup/placementMapping.js';

/**
 * 검증자(qa): 서버측 배치 제출 게이트(순수). slot_setup UNIQUE(cam_id,preset_id,preset_slotidx)
 * 위반과 FK(preset_info) 위반을 트랜잭션 **전에** 400 으로 잡는지.
 */

const current: CurrentPlacement[] = [
  { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1 },
  { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2 },
  { slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 1 },
];
const presetKeys = new Set(['1:1', '1:2']);

describe('validateSlotPlacement', () => {
  it('전량 제출 + 위치 교환 → ok(중간상태 무시, 최종 상태만 판정)', () => {
    const res = validateSlotPlacement(
      current,
      [
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 2 },
        { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 1 },
        { slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 1 },
      ],
      presetKeys,
    );
    expect(res.ok).toBe(true);
  });

  it('부분 제출이 미제출 행의 현재 배치와 충돌 → 실패', () => {
    // slot1 만 (1,1,2) 로 — slot2 가 이미 (1,1,2) 를 쓰고 있고 제출에 없다.
    const res = validateSlotPlacement(current, [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 2 }], presetKeys);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('배치 충돌');
  });

  it('부분 제출이 빈 자리로 이동 → ok', () => {
    const res = validateSlotPlacement(current, [{ slotId: 1, camId: 1, presetId: 2, presetSlotIdx: 2 }], presetKeys);
    expect(res.ok).toBe(true);
  });

  it('미등록 프리셋(preset_info 부재) → 실패(FK 사전차단)', () => {
    const res = validateSlotPlacement(current, [{ slotId: 1, camId: 9, presetId: 9, presetSlotIdx: 1 }], presetKeys);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('등록되지 않은');
  });

  it('미존재 slotId → 실패', () => {
    const res = validateSlotPlacement(current, [{ slotId: 99, camId: 1, presetId: 1, presetSlotIdx: 3 }], presetKeys);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('현재 슬롯에 없습니다');
  });

  it('slotId 중복 제출 → 실패', () => {
    const res = validateSlotPlacement(
      current,
      [
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 3 },
        { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 4 },
      ],
      presetKeys,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('중복 제출');
  });

  it('빈 제출 → 실패', () => {
    expect(validateSlotPlacement(current, [], presetKeys).ok).toBe(false);
  });
});
