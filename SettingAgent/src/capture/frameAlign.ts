// 주차면 자동보정용 프레임 정합(이동+스케일) 순수 수학. sharp/DOM 미참조 — 라우트가 그레이 배열만 주입.
// 회전·원근은 미보정(리더 확정). 다운스케일 그레이 배열 기준이라 O(w·h·shift²·scales) 허용.

/** 정수 인덱스 clamp(바이리니어 샘플 경계 보호). */
function clampIdx(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 제로평균 정규화 상호상관(NCC)으로 정수 픽셀 이동 추정.
 * peak 인 (dx,dy) 는 `ref[p] ≈ cur[p + (dx,dy)]` 를 만족 → ref 좌표계 ROI 를 (dx,dy) 만큼 이동하면 cur 와 정합.
 * ref/cur = 길이 w*h 그레이(0..255) 배열. maxShift = 탐색 반경(픽셀). → { dx, dy, peak(-1..1) }.
 */
export function normalizedCrossCorrelation(
  ref: Uint8Array,
  cur: Uint8Array,
  w: number,
  h: number,
  maxShift: number,
): { dx: number; dy: number; peak: number } {
  let best = { dx: 0, dy: 0, peak: -Infinity };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(w, w - dx);
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(h, h - dy);
      let sumR = 0;
      let sumC = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sumR += ref[y * w + x];
          sumC += cur[(y + dy) * w + (x + dx)];
          n++;
        }
      }
      if (n === 0) continue;
      const mR = sumR / n;
      const mC = sumC / n;
      let num = 0;
      let dR = 0;
      let dC = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const a = ref[y * w + x] - mR;
          const b = cur[(y + dy) * w + (x + dx)] - mC;
          num += a * b;
          dR += a * a;
          dC += b * b;
        }
      }
      const denom = Math.sqrt(dR * dC);
      const peak = denom > 0 ? num / denom : 0;
      if (peak > best.peak) best = { dx, dy, peak };
    }
  }
  return best;
}

/**
 * 중심 기준 스케일 리샘플(바이리니어, 동일 w×h 캔버스). s>1 이면 확대(내용 커짐), s<1 이면 축소.
 * 출력 픽셀 → 소스 좌표: src = center + (out-center)/s.
 */
export function scaleGray(src: Uint8Array, w: number, h: number, s: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const sx = cx + (ox - cx) / s;
      const sy = cy + (oy - cy) / s;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const x0c = clampIdx(x0, 0, w - 1);
      const x1c = clampIdx(x0 + 1, 0, w - 1);
      const y0c = clampIdx(y0, 0, h - 1);
      const y1c = clampIdx(y0 + 1, 0, h - 1);
      const v00 = src[y0c * w + x0c];
      const v10 = src[y0c * w + x1c];
      const v01 = src[y1c * w + x0c];
      const v11 = src[y1c * w + x1c];
      const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      out[oy * w + ox] = Math.round(v);
    }
  }
  return out;
}

/**
 * 이동+스케일 정합 추정. scale 후보마다 cur 을 1/scale 로 되돌린(zoom 상쇄) 뒤 ref 와 상호상관 → peak 최대 선택.
 * 반환 scale = cur 내용이 ref 대비 확대된 배율(ROI 를 그만큼 키워 내용 추종). dx,dy 는 그리드 픽셀 이동(라우트가 정규화).
 * opts.scales(예 0.9~1.1), opts.maxShift(탐색 반경 픽셀). → { dx, dy, scale, peak }.
 */
export function estimateAlign(
  ref: Uint8Array,
  cur: Uint8Array,
  w: number,
  h: number,
  opts: { scales?: number[]; maxShift?: number },
): { dx: number; dy: number; scale: number; peak: number } {
  const scales = opts.scales && opts.scales.length ? opts.scales : [1];
  const maxShift = opts.maxShift ?? 8;
  let best = { dx: 0, dy: 0, scale: 1, peak: -Infinity };
  for (const s of scales) {
    const scaled = s === 1 ? cur : scaleGray(cur, w, h, 1 / s);
    const { dx, dy, peak } = normalizedCrossCorrelation(ref, scaled, w, h, maxShift);
    if (peak > best.peak) best = { dx, dy, scale: s, peak };
  }
  return best;
}
