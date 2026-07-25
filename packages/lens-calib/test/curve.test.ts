import { describe, expect, it } from 'vitest';
import { ZoomCurve } from '../src/curve.js';

describe('ZoomCurve', () => {
  const c = new ZoomCurve(
    [
      { z: 0, h: 57.14 },
      { z: 8000, h: 22.59 },
      { z: 16384, h: 2.39 },
    ],
    'h',
  );

  it('앵커에서는 앵커 값 그대로', () => {
    expect(c.at(0)).toBeCloseTo(57.14, 10);
    expect(c.at(8000)).toBeCloseTo(22.59, 10);
    expect(c.at(16384)).toBeCloseTo(2.39, 10);
  });

  it('구간 안은 선형 보간', () => {
    expect(c.at(4000)).toBeCloseTo((57.14 + 22.59) / 2, 10);
  });

  it('★정의역 밖은 클램프한다 — 외삽하지 않는다', () => {
    // 실제 렌즈는 마지막 앵커 너머에서 광학적으로 포화한다. 외삽하면 조용히 0 으로 수렴하는
    // 거짓말이 된다.
    expect(c.at(99999)).toBe(2.39);
    expect(c.at(-5000)).toBe(57.14);
    expect(c.at(Number.NaN)).toBe(57.14);
  });

  it('입력 순서와 무관하다(정렬한다)', () => {
    const shuffled = new ZoomCurve(
      [
        { z: 16384, h: 2.39 },
        { z: 0, h: 57.14 },
        { z: 8000, h: 22.59 },
      ],
      'h',
    );
    expect(shuffled.at(4000)).toBeCloseTo(c.at(4000), 12);
    expect(shuffled.domain).toEqual([0, 16384]);
  });

  it('연속 조회(hint 캐시)가 결과를 바꾸지 않는다', () => {
    const fresh = new ZoomCurve(
      [
        { z: 0, h: 57.14 },
        { z: 8000, h: 22.59 },
        { z: 16384, h: 2.39 },
      ],
      'h',
    );
    // 앞뒤로 뛰어다니며 조회해도 같은 답이어야 한다(hint 가 틀린 구간을 잡으면 여기서 깨진다).
    for (const z of [100, 15000, 500, 9000, 200, 16000, 4000]) {
      expect(fresh.at(z)).toBeCloseTo(c.at(z), 12);
    }
  });

  it('z 중복을 거부한다', () => {
    expect(
      () =>
        new ZoomCurve(
          [
            { z: 0, h: 1 },
            { z: 0, h: 2 },
          ],
          'h',
        ),
    ).toThrow(/중복/);
  });

  it('빈 배열을 거부한다', () => {
    expect(() => new ZoomCurve([], 'h')).toThrow();
  });

  it('positive:true 면 0 이하를 거부하고, false 면 음수를 받는다', () => {
    expect(() => new ZoomCurve([{ z: 0, k: -1 }], 'k')).toThrow();
    expect(new ZoomCurve([{ z: 0, k1: -0.03 }], 'k1', { positive: false }).at(0)).toBe(-0.03);
  });

  it('toJSON 은 원래 모양으로 되돌린다', () => {
    expect(c.toJSON(2)).toEqual([
      { z: 0, h: 57.14 },
      { z: 8000, h: 22.59 },
      { z: 16384, h: 2.39 },
    ]);
  });
});
