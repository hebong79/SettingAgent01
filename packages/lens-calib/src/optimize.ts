// 최적화 두 가지 — 외부 의존 0.
//
// 참조본은 미지수가 **초점거리 하나**였으므로 황금분할로 충분했다(비용이 f 에 대해 단봉).
// 곡면율이 들어오면서 미지수가 (f, k1, k2) **셋**이 되어 다차원 탐색이 필요해졌다.
// 도함수를 쓰지 않는 Nelder-Mead 심플렉스를 쓴다 — 비용함수에 뉴턴 역산과 클램프가 섞여 있어
// 해석적 미분이 지저분하고, 미지수가 3개뿐이라 심플렉스로 충분하다.

export interface GoldenResult {
  x: number;
  cost: number;
}

/** 황금분할 탐색: 비용이 단봉이고 파라미터가 하나뿐일 때. */
export function goldenSection(cost: (x: number) => number, lo: number, hi: number, iterations = 220): GoldenResult {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = hi - gr * (hi - lo);
  let b = lo + gr * (hi - lo);
  let fa = cost(a);
  let fb = cost(b);
  for (let i = 0; i < iterations; i++) {
    if (fa < fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - gr * (hi - lo);
      fa = cost(a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + gr * (hi - lo);
      fb = cost(b);
    }
  }
  const x = (lo + hi) / 2;
  return { x, cost: cost(x) };
}

export interface NelderMeadOptions {
  /**
   * 차원별 초기 심플렉스 변위. **반드시 파라미터의 스케일에 맞춰야 한다** —
   * f 는 O(10³), k1 은 O(10⁻²) 라 같은 스텝을 쓰면 심플렉스가 한 축으로만 납작해져 수렴하지 않는다.
   */
  steps: number[];
  maxIterations?: number;
  /** 심플렉스 꼭짓점 간 비용 차가 이보다 작으면 수렴으로 본다. */
  tolerance?: number;
}

export interface NelderMeadResult {
  x: number[];
  cost: number;
  iterations: number;
  converged: boolean;
}

/**
 * Nelder-Mead 심플렉스. 표준 계수(반사 1 · 확장 2 · 축소 0.5 · 수축 0.5).
 * 비용이 비유한(Infinity/NaN)이면 그 꼭짓점은 자동으로 최악으로 밀려나므로 별도 처리가 필요 없다.
 */
export function nelderMead(cost: (x: number[]) => number, x0: number[], { steps, maxIterations = 600, tolerance = 1e-10 }: NelderMeadOptions): NelderMeadResult {
  const n = x0.length;
  if (n === 0) throw new TypeError('nelderMead: 파라미터가 비어 있습니다.');
  if (steps.length !== n) throw new TypeError('nelderMead: steps 길이가 파라미터 수와 달라야 합니다.');

  const safe = (x: number[]): number => {
    const v = cost(x);
    return Number.isFinite(v) ? v : Number.MAX_VALUE;
  };

  // 초기 심플렉스: x0 과 각 축으로 steps[i] 만큼 민 점 n 개.
  const simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] = p[i]! + steps[i]!;
    simplex.push(p);
  }
  let values = simplex.map(safe);

  const centroidExcept = (excludeIdx: number): number[] => {
    const c = new Array<number>(n).fill(0);
    let count = 0;
    for (let i = 0; i < simplex.length; i++) {
      if (i === excludeIdx) continue;
      for (let j = 0; j < n; j++) c[j] = c[j]! + simplex[i]![j]!;
      count++;
    }
    for (let j = 0; j < n; j++) c[j] = c[j]! / count;
    return c;
  };
  const combine = (a: number[], b: number[], t: number): number[] => a.map((v, j) => v + t * (b[j]! - v));

  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations++) {
    // 정렬: 0 이 최선, 마지막이 최악.
    const order = values.map((v, i) => i).sort((a, b) => values[a]! - values[b]!);
    const sortedSimplex = order.map((i) => simplex[i]!);
    const sortedValues = order.map((i) => values[i]!);
    for (let i = 0; i < simplex.length; i++) {
      simplex[i] = sortedSimplex[i]!;
      values[i] = sortedValues[i]!;
    }

    if (Math.abs(values[values.length - 1]! - values[0]!) <= tolerance * (Math.abs(values[0]!) + tolerance)) {
      converged = true;
      break;
    }

    const worst = simplex.length - 1;
    const centroid = centroidExcept(worst);

    const reflected = combine(centroid, simplex[worst]!, -1);
    const fr = safe(reflected);
    if (fr < values[0]!) {
      const expanded = combine(centroid, simplex[worst]!, -2);
      const fe = safe(expanded);
      if (fe < fr) {
        simplex[worst] = expanded;
        values[worst] = fe;
      } else {
        simplex[worst] = reflected;
        values[worst] = fr;
      }
      continue;
    }
    if (fr < values[worst - 1]!) {
      simplex[worst] = reflected;
      values[worst] = fr;
      continue;
    }
    // 수축
    const contracted = combine(centroid, simplex[worst]!, 0.5);
    const fc = safe(contracted);
    if (fc < values[worst]!) {
      simplex[worst] = contracted;
      values[worst] = fc;
      continue;
    }
    // 전체 축소 — 최선점 쪽으로 당긴다.
    const best = simplex[0]!;
    for (let i = 1; i < simplex.length; i++) simplex[i] = combine(best, simplex[i]!, 0.5);
    values = simplex.map(safe);
  }

  let bestIdx = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! < values[bestIdx]!) bestIdx = i;
  return { x: simplex[bestIdx]!.slice(), cost: values[bestIdx]!, iterations, converged };
}
