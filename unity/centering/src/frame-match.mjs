// "클릭한 내용이 이동 후 어디에 떨어졌나" — 캘리브레이션이 필요로 하는 단 하나의 측정.
//
// 카메라는 이걸 알려줄 수 없다(자기가 어디를 봤는지만 안다). 그래서 BEFORE 프레임에서 클릭
// 주변 패치를 떼어 AFTER 프레임의 **중앙 근처**에서 찾는다 — 제대로 됐다면 거기 있어야 하니까.
//
// Zero-mean 정규화 상호상관(ZNCC), coarse→fine:
//   * 두 스냅샷 사이에 노출이 흔들리므로 SSD 는 내용이 아니라 밝기를 쫓는다. 그래서 ZNCC.
//   * 1/4 스케일 coarse 가 후보를 추리고, 풀해상도 fine + 상관 피크 포물선 보간이 서브픽셀까지
//     내려간다. 재려는 신호 자체가 수십 픽셀뿐이라 서브픽셀이 사치가 아니다.
//
// 외부 의존성 없음(OpenCV 도 sharp 도 아님). 입력은 8bit 그레이스케일 버퍼 하나뿐이라, JPEG
// 디코딩은 쓰는 쪽 사정에 맡긴다:
//   node + sharp : await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true })
//   브라우저      : canvas.drawImage → getImageData → 채널 평균
//
// 성능: 상관 계산의 창 합/제곱합은 적분영상(summed-area table)으로 O(1) 이다. 원래 구현은
// 오프셋마다 창을 다시 훑었다 — 같은 결과, 인접합 계산이 사라진다.

/** @typedef {{data: Uint8Array|Uint8ClampedArray|Float32Array, width: number, height: number}} GrayFrame */

export class FrameMatcher {
  /**
   * @param {object} [options]
   * @param {number} [options.frameWidth=1920]  논리 좌표계(클릭 좌표가 쓰는 프레임). 실제 이미지가
   *                                            더 작아도 된다 — 스케일은 자동 환산한다.
   * @param {number} [options.frameHeight=1080]
   * @param {number} [options.half=48]      패치 반폭(실제 픽셀). 패치는 2*half 정사각.
   * @param {number} [options.search=320]   프레임 중심에서 얼마나 넓게 찾을지(실제 픽셀)
   * @param {number} [options.step=4]       coarse 축소 배율
   * @param {number} [options.pad=24]       fine 재탐색 여유. 텍스처 반복 로브(~8-20px)가 보일 만큼 넓어야 한다.
   * @param {number} [options.candidates=3] coarse 에서 넘길 후보 수
   * @param {number} [options.minPeak=0.6]    이 아래는 붙잡을 게 없었다는 뜻
   * @param {number} [options.minMargin=0.02] 이 아래는 위치가 동전던지기다 (점수와 무관!)
   * @param {number} [options.lowContrast=12] 이 아래는 화면에 아무것도 없다 (RMS 대비, 그레이 레벨)
   */
  constructor({
    frameWidth = 1920, frameHeight = 1080,
    half = 48, search = 320, step = 4, pad = 24, candidates = 3,
    minPeak = 0.6, minMargin = 0.02, lowContrast = 12,
  } = {}) {
    Object.assign(this, {
      frameWidth, frameHeight, half, search, step, pad, candidates,
      minPeak, minMargin, lowContrast,
    });
  }

  /**
   * @param {GrayFrame} before  클릭 직전 프레임
   * @param {GrayFrame} after   이동 완료 후 프레임 (같은 크기여야 한다)
   * @param {{clickX:number, clickY:number}} click  논리 프레임 좌표
   * @returns {{landedX, landedY, peak, margin, contrast, usable, reason}}
   *   landedX/Y  논리 프레임 좌표 — 클릭 좌표와 바로 비교할 수 있다
   *   peak       ZNCC 점수
   *   margin     1등 로브가 2등보다 얼마나 높은가. **점수보다 이게 중요하다.**
   *   contrast   패치 RMS 대비 — 실패 원인을 "반복 무늬"와 "화면에 아무것도 없음"으로 가른다
   *   reason     usable=false 일 때만: "dark" | "smooth" | "featureless"
   */
  locate(before, after, { clickX, clickY }) {
    if (before.width !== after.width || before.height !== after.height) {
      throw new Error("frame-match: 두 프레임의 크기가 다릅니다.");
    }
    const { data: b, width: w, height: h } = before;
    const { half, step, pad } = this;
    const sx = w / this.frameWidth;
    const sy = h / this.frameHeight;

    // 클릭 주변 패치. 가장자리 클릭이면 프레임 안으로 밀어 넣는다.
    const px = clampInt(Math.round(clickX * sx), half, w - half - 1);
    const py = clampInt(Math.round(clickY * sy), half, h - half - 1);
    const size = half * 2;

    // 탐색창은 프레임 중심 주변 — 제대로 된 센터링이라면 거기 있어야 한다.
    const ccx = Math.round((this.frameWidth / 2) * sx);
    const ccy = Math.round((this.frameHeight / 2) * sy);
    const x0 = Math.max(0, ccx - this.search - half);
    const y0 = Math.max(0, ccy - this.search - half);
    const winW = Math.min(w, ccx + this.search + half) - x0;
    const winH = Math.min(h, ccy + this.search + half) - y0;
    if (winW < size || winH < size) throw new Error("frame-match: 탐색창이 패치보다 작습니다.");

    // coarse: 1/4 스케일로 창 전체
    const cPatch = downsample(b, w, px - half, py - half, size, size, step);
    const cWin = downsample(after.data, w, x0, y0, winW, winH, step);
    const coarse = correlate(cWin, cPatch);
    if (coarse.width <= 0 || coarse.height <= 0) throw new Error("frame-match: coarse 창이 너무 작습니다.");

    const patch = crop(b, w, px - half, py - half, size, size);
    const contrast = zeroMean(patch).norm / Math.sqrt(patch.length); // RMS 대비
    const cands = topCandidates(coarse, this.candidates, Math.round(half / step));
    if (!cands.length) throw new Error("frame-match: 쓸 만한 상관 피크가 없습니다.");

    // fine: 후보마다 풀해상도로 다시. coarse 최고점이 풀해상도 최고점이라는 보장은 없다.
    let best = null;
    for (const c of cands) {
      const fx0 = clampInt(x0 + c.x * step - pad, 0, w - size - 1);
      const fy0 = clampInt(y0 + c.y * step - pad, 0, h - size - 1);
      const fw = Math.min(size + pad * 2, w - fx0);
      const fh = Math.min(size + pad * 2, h - fy0);
      const fine = correlate(
        { data: crop(after.data, w, fx0, fy0, fw, fh), width: fw, height: fh },
        { data: patch, width: size, height: size },
      );
      if (fine.width <= 0 || fine.height <= 0) continue;
      const p = peakOf(fine);
      if (!best || p.peak > best.peak) {
        best = {
          landedX: (fx0 + p.x + half) / sx,
          landedY: (fy0 + p.y + half) / sy,
          peak: p.peak,
          margin: sidelobeMargin(fine, p.x, p.y, 8),
        };
      }
    }
    if (!best) throw new Error("frame-match: 쓸 만한 상관 피크가 없습니다.");

    const usable = best.peak >= this.minPeak && best.margin >= this.minMargin;
    return {
      ...best,
      contrast,
      usable,
      // 실패 원인을 구분해야 하는 이유: 셋의 처방이 다르다.
      //   dark        → 낮에 다시 온다
      //   smooth      → 매칭은 잘 됐는데 위치를 특정 못 함(미세 디테일 없음, 야간 NR 의 전형)
      //   featureless → 무늬 있는 쪽(차량·주차선)으로 카메라를 돌린다
      reason: usable ? undefined
        : contrast < this.lowContrast ? "dark"
          : best.peak >= this.minPeak ? "smooth" : "featureless",
    };
  }
}

// ---------------------------------------------------------------------------
// 내부 — 순수 배열 연산

function crop(src, srcW, x0, y0, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y0 + y) * srcW + x0;
    for (let x = 0; x < w; x++) out[y * w + x] = src[row + x];
  }
  return out;
}

/** step×step 박스 평균. 축소 패치를 상관하기 전에 센서 노이즈를 눌러주는 역할도 한다. */
function downsample(src, srcW, x0, y0, w0, h0, step) {
  const w = Math.floor(w0 / step);
  const h = Math.floor(h0 / step);
  const out = new Float32Array(w * h);
  const inv = 1 / (step * step);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const sy = y0 + y * step;
      const sx = x0 + x * step;
      for (let j = 0; j < step; j++) {
        const row = (sy + j) * srcW + sx;
        for (let i = 0; i < step; i++) sum += src[row + i];
      }
      out[y * w + x] = sum * inv;
    }
  }
  return { data: out, width: w, height: h };
}

function zeroMean(a) {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length;
  let ss = 0;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i] - mean;
    out[i] = v;
    ss += v * v;
  }
  return { data: out, norm: Math.sqrt(ss) };
}

/**
 * 패치를 창 안 모든 위치에 대고 ZNCC 를 계산해 상관면을 만든다.
 * 창 쪽 합·제곱합은 적분영상으로 O(1), 교차항만 실제로 곱한다.
 */
function correlate(win, patch) {
  const { data: wd, width: ww, height: wh } = win;
  const { data: pd, width: pw, height: ph } = patch;
  const outW = ww - pw + 1;
  const outH = wh - ph + 1;
  const surface = new Float32Array(Math.max(0, outW * outH));
  const p = zeroMean(pd);
  if (outW <= 0 || outH <= 0 || p.norm < 1e-6) return { surface, width: outW, height: outH };

  // 적분영상 (테두리 0 행/열 포함 → 경계 분기 없음)
  const iw = ww + 1;
  const S = new Float64Array(iw * (wh + 1));
  const S2 = new Float64Array(iw * (wh + 1));
  for (let y = 0; y < wh; y++) {
    let rs = 0;
    let rs2 = 0;
    const src = y * ww;
    const cur = (y + 1) * iw;
    const prev = y * iw;
    for (let x = 0; x < ww; x++) {
      const v = wd[src + x];
      rs += v;
      rs2 += v * v;
      S[cur + x + 1] = S[prev + x + 1] + rs;
      S2[cur + x + 1] = S2[prev + x + 1] + rs2;
    }
  }
  const rect = (T, x, y) => T[(y + ph) * iw + x + pw] - T[y * iw + x + pw] - T[(y + ph) * iw + x] + T[y * iw + x];

  const n = pw * ph;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let cross = 0;
      for (let y = 0; y < ph; y++) {
        const wrow = (oy + y) * ww + ox;
        const prow = y * pw;
        for (let x = 0; x < pw; x++) cross += wd[wrow + x] * p.data[prow + x];
      }
      // p 가 zero-mean 이므로 cross 는 이미 Σ((w-μw)(p-μp)) 와 같다.
      const sum = rect(S, ox, oy);
      const varSum = rect(S2, ox, oy) - (sum * sum) / n;
      const denom = Math.sqrt(Math.max(varSum, 0)) * p.norm;
      surface[oy * outW + ox] = denom > 1e-6 ? cross / denom : 0;
    }
  }
  return { surface, width: outW, height: outH };
}

/** 최고점 + 이웃 3점 포물선 보간 → 서브픽셀. */
function peakOf({ surface, width: w, height: h }) {
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let i = 0; i < surface.length; i++) {
    if (surface[i] > best) { best = surface[i]; bx = i % w; by = (i / w) | 0; }
  }
  const at = (x, y) => surface[y * w + x];
  const sub = (a, b, c) => {
    const d = a - 2 * b + c;
    return Math.abs(d) < 1e-9 ? 0 : (0.5 * (a - c)) / d;
  };
  return {
    x: bx + (bx > 0 && bx < w - 1 ? sub(at(bx - 1, by), best, at(bx + 1, by)) : 0),
    y: by + (by > 0 && by < h - 1 ? sub(at(bx, by - 1), best, at(bx, by + 1)) : 0),
    peak: best,
  };
}

/**
 * 1등 로브가 2등보다 얼마나 높은가.
 *
 * 높은 상관 점수는 위치 확신이 아니다. 울타리·난간·주차선은 여러 오프셋에서 자기 자신과 ~0.9
 * 로 맞고, 그 중 누가 1등인지는 노이즈가 정한다. 실측 사례: 피크 0.898, 8px 옆 0.897 —
 * OpenCV 와 이 매처가 서로 다른 로브를 골랐고 **둘 다 10px 틀렸다.** 점수는 아무것도 말해주지
 * 않았고 이 마진(0.0008 vs 정상 0.04+)이 전부를 말했다.
 */
function sidelobeMargin({ surface, width: w, height: h }, peakX, peakY, radius) {
  let side = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.hypot(x - peakX, y - peakY) < radius) continue;
      const v = surface[y * w + x];
      if (v > side) side = v;
    }
  }
  return side === -Infinity ? 1 : surface[Math.round(peakY) * w + Math.round(peakX)] - side;
}

/**
 * coarse 피크는 제안이지 판결이 아니다. 축소면의 1등이 풀해상도의 1등이 아닐 수 있으므로
 * 서로 충분히 떨어진(=진짜 다른 로브인) 후보 몇 개를 넘긴다.
 */
function topCandidates({ surface, width: w, height: h }, count, minSeparation) {
  const scratch = Float32Array.from(surface);
  const taken = [];
  for (let k = 0; k < count; k++) {
    let best = -Infinity;
    let bi = -1;
    for (let i = 0; i < scratch.length; i++) if (scratch[i] > best) { best = scratch[i]; bi = i; }
    if (bi < 0 || best === -Infinity) break;
    const bx = bi % w;
    const by = (bi / w) | 0;
    taken.push({ x: bx, y: by, peak: best });
    for (let y = Math.max(0, by - minSeparation); y < Math.min(h, by + minSeparation + 1); y++) {
      for (let x = Math.max(0, bx - minSeparation); x < Math.min(w, bx + minSeparation + 1); x++) {
        scratch[y * w + x] = -Infinity;
      }
    }
  }
  return taken;
}

function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
