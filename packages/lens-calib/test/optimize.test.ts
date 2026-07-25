import { describe, expect, it } from 'vitest';
import { goldenSection, nelderMead } from '../src/optimize.js';

describe('goldenSection', () => {
  it('단봉 함수의 최소를 찾는다', () => {
    const r = goldenSection((x) => (x - 1234.5) ** 2, 100, 10000, 200);
    expect(r.x).toBeCloseTo(1234.5, 3);
  });
});

describe('nelderMead', () => {
  it('2차원 이차형식의 최소를 찾는다', () => {
    const r = nelderMead((x) => (x[0]! - 3) ** 2 + (x[1]! + 7) ** 2, [0, 0], { steps: [1, 1] });
    expect(r.x[0]!).toBeCloseTo(3, 5);
    expect(r.x[1]!).toBeCloseTo(-7, 5);
    expect(r.converged).toBe(true);
  });

  it('★스케일이 크게 다른 파라미터도 steps 로 맞추면 수렴한다', () => {
    // f 는 O(10³), k 는 O(10⁻²) — 같은 스텝을 쓰면 심플렉스가 한 축으로 납작해져 수렴하지 않는다.
    const cost = (x: number[]): number => ((x[0]! - 1800) / 1800) ** 2 + ((x[1]! + 0.085) / 0.085) ** 2;
    const bad = nelderMead(cost, [1000, 0], { steps: [1, 1] });
    const good = nelderMead(cost, [1000, 0], { steps: [1800 * 0.05, 0.02] });
    expect(good.x[0]!).toBeCloseTo(1800, 2);
    expect(good.x[1]!).toBeCloseTo(-0.085, 6);
    expect(good.cost).toBeLessThan(bad.cost);
  });

  it('비유한 비용(Infinity/NaN)에서도 죽지 않는다', () => {
    const r = nelderMead((x) => (x[0]! <= 0 ? Infinity : (x[0]! - 5) ** 2), [1], { steps: [2] });
    expect(r.x[0]!).toBeCloseTo(5, 4);
  });

  it('steps 길이가 안 맞으면 거부한다', () => {
    expect(() => nelderMead((x) => x[0]!, [1, 2], { steps: [1] })).toThrow();
  });
});
