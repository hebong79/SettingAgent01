// 구간선형 + 양끝 클램프 곡선 — 세 표(화각·게인·곡면율)의 공통 자료구조.
//
// **외삽하지 않는 것이 이 클래스의 핵심 계약이다.** 마지막 앵커 너머에서 실제 렌즈는 광학적으로
// 포화하므로 값을 유지하는 것이 맞고(실측: z≈16384 에서 광학 포화), 첫 앵커 아래에는 아무것도 없다.
// 외삽하면 조용히 0 으로 수렴하는 거짓말을 하게 된다.

export interface CurveOptions {
  /** 오류 메시지에 쓸 이름. */
  name?: string;
  /** 값이 양수여야 하는가. 화각·게인은 true, 곡면율 계수(k1<0 가능)는 false. */
  positive?: boolean;
}

export class ZoomCurve {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  /** 직전 조회 구간. 연속 호출은 대개 비슷한 줌을 묻는다(프리뷰 루프·스윕). */
  private hint = 0;

  readonly key: string;
  readonly name: string;

  /**
   * @param points [{ z, <key> }, ...] — 순서 무관(정렬한다)
   * @param key    값이 담긴 필드명 ("h" | "k" | "k1" | "k2")
   */
  constructor(points: readonly Record<string, number>[], key: string, { name = 'curve', positive = true }: CurveOptions = {}) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new TypeError(`${name}: [{ z, ${key} }] 형태의 비어있지 않은 배열이어야 합니다.`);
    }
    const rows = points
      .map((p) => ({ z: Number(p?.z), v: Number((p as Record<string, unknown> | undefined)?.[key]) }))
      .sort((a, b) => a.z - b.z);

    for (const r of rows) {
      if (!Number.isFinite(r.z) || !Number.isFinite(r.v) || (positive && !(r.v > 0))) {
        throw new TypeError(`${name}: 각 항목은 { z: 숫자, ${key}: ${positive ? '양수' : '숫자'} } 여야 합니다.`);
      }
    }
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      if (cur.z <= prev.z) throw new TypeError(`${name}: z 가 중복됩니다 (${cur.z}).`);
    }

    this.xs = Float64Array.from(rows, (r) => r.z);
    this.ys = Float64Array.from(rows, (r) => r.v);
    this.key = key;
    this.name = name;
  }

  get length(): number {
    return this.xs.length;
  }

  get first(): number {
    return this.ys[0]!;
  }

  get last(): number {
    return this.ys[this.ys.length - 1]!;
  }

  /** [최소 z, 최대 z]. */
  get domain(): [number, number] {
    return [this.xs[0]!, this.xs[this.xs.length - 1]!];
  }

  /** 곡선을 읽는다. 정의역 밖은 **클램프**(★외삽 금지). */
  at(x: number): number {
    const { xs, ys } = this;
    const n = xs.length;
    const v = Number(x);
    if (!Number.isFinite(v) || v <= xs[0]!) return ys[0]!;
    if (v >= xs[n - 1]!) return ys[n - 1]!;

    let i = this.hint;
    if (i >= n - 1 || v < xs[i]! || v > xs[i + 1]!) {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (v < xs[mid]!) hi = mid;
        else lo = mid;
      }
      i = lo;
      this.hint = i;
    }
    const t = (v - xs[i]!) / (xs[i + 1]! - xs[i]!);
    return ys[i]! + t * (ys[i + 1]! - ys[i]!);
  }

  /** 저장 가능한 원래 모양으로. */
  toJSON(digits?: number): Array<Record<string, number>> {
    const round = (v: number): number => (digits === undefined ? v : Number(v.toFixed(digits)));
    return Array.from(this.xs, (z, i) => ({ z, [this.key]: round(this.ys[i]!) }));
  }

  /** 이미 ZoomCurve 면 그대로, 배열이면 새로 만든다. */
  static from(points: readonly Record<string, number>[] | ZoomCurve, key: string, options?: CurveOptions): ZoomCurve {
    return points instanceof ZoomCurve ? points : new ZoomCurve(points, key, options);
  }
}
