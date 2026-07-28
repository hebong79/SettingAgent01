// 구간선형 + 양끝 클램프 곡선.
//
// 캘리브레이션 표(zoom→화각, zoom→게인)의 공통 자료구조. 두 표 모두 "줌 앵커 몇 개 + 사이는
// 직선"이라는 같은 모양이라 하나로 묶는다.
//
// 외삽하지 않는 것이 이 클래스의 핵심 계약이다: 마지막 앵커 너머에서 실제 렌즈는 광학적으로
// 포화하므로 값을 유지하는 것이 맞고, 첫 앵커 아래에는 아무것도 없다. 외삽하면 조용히 0으로
// 수렴하는 거짓말을 하게 된다.

export class Curve {
  #xs;
  #ys;
  #hint = 0;

  /**
   * @param {Array<object>} points  [{ z, <key> }, ...] — 순서는 상관없다(정렬한다)
   * @param {string} key            값이 담긴 필드명 ("h" | "k" | ...)
   * @param {object} [options]
   * @param {string} [options.name]      오류 메시지에 쓸 이름
   * @param {boolean} [options.positive] 값이 양수여야 하는가 (기본 true)
   */
  constructor(points, key, { name = "curve", positive = true } = {}) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new TypeError(`${name}: [{ z, ${key} }] 형태의 비어있지 않은 배열이어야 합니다.`);
    }
    const rows = points
      .map((p) => ({ z: Number(p?.z), v: Number(p?.[key]) }))
      .sort((a, b) => a.z - b.z);

    for (const r of rows) {
      if (!Number.isFinite(r.z) || !Number.isFinite(r.v) || (positive && !(r.v > 0))) {
        throw new TypeError(`${name}: 각 항목은 { z: 숫자, ${key}: ${positive ? "양수" : "숫자"} } 여야 합니다.`);
      }
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].z <= rows[i - 1].z) throw new TypeError(`${name}: z 가 중복됩니다 (${rows[i].z}).`);
    }

    this.#xs = Float64Array.from(rows, (r) => r.z);
    this.#ys = Float64Array.from(rows, (r) => r.v);
    this.key = key;
    this.name = name;
  }

  get length() { return this.#xs.length; }
  get first() { return this.#ys[0]; }
  get last() { return this.#ys[this.#ys.length - 1]; }
  get domain() { return [this.#xs[0], this.#xs[this.#xs.length - 1]]; }

  /**
   * 곡선을 읽는다. 정의역 밖은 클램프(외삽 금지).
   *
   * 연속 호출은 대개 비슷한 줌을 묻기 때문에(프리뷰 루프, 스윕) 직전 구간을 먼저 확인하고,
   * 빗나갈 때만 이진탐색한다 — 표가 촘촘해져도 조회 비용이 늘지 않는다.
   */
  at(x) {
    const xs = this.#xs;
    const ys = this.#ys;
    const n = xs.length;
    const v = Number(x);
    if (!Number.isFinite(v) || v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];

    let i = this.#hint;
    if (i >= n - 1 || v < xs[i] || v > xs[i + 1]) {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (v < xs[mid]) hi = mid; else lo = mid;
      }
      i = lo;
      this.#hint = i;
    }
    const t = (v - xs[i]) / (xs[i + 1] - xs[i]);
    return ys[i] + t * (ys[i + 1] - ys[i]);
  }

  /** 저장 가능한 원래 모양([{ z, <key> }])으로 되돌린다. */
  toJSON(digits) {
    const round = (v) => (digits === undefined ? v : Number(v.toFixed(digits)));
    return Array.from(this.#xs, (z, i) => ({ z, [this.key]: round(this.#ys[i]) }));
  }

  /** 이미 Curve 면 그대로, 배열이면 새로 만든다. */
  static from(points, key, options) {
    return points instanceof Curve ? points : new Curve(points, key, options);
  }
}
