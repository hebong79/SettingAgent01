// 예제용 가짜 PTZ 카메라 — 하드웨어 없이 라이브러리 전체를 돌려볼 수 있게 한다.
//
// 실기의 병을 **일부러 주입**한다: 렌더는 진짜 초점거리 f_true 로 하고, setcenter 는 펌웨어가
// 믿는 f_fw = f_true × k 로 각도를 푼다. 그래서 클릭은 항상 k 배만큼 덜 온다 — 캘리브레이션이
// 되찾아야 하는 바로 그 오차다.
//
// 장면은 절차적 노이즈 텍스처다. NCC 매칭에는 "미세하고 반복되지 않는 무늬"만 있으면 되고,
// 그건 노이즈가 실사보다 오히려 잘 만족한다. (줌마다 텍스처 주파수를 화각에 맞춰 다시 잡는데,
// 실제 장면은 그러지 않는다 — 하지만 before/after 는 언제나 같은 줌에서 찍히고 솔버도 줌을
// 넘나들며 비교하지 않으므로 측정에는 영향이 없다.)

import { CameraCalibration, PtzGeometry, basis } from "../index.mjs";

const DEG = Math.PI / 180;

export class MockPtzCamera {
  /**
   * @param {object} [options]
   * @param {Array<{z,h}>} [options.trueHfov]  이 렌즈가 진짜 보는 화각 (되찾아야 할 정답)
   * @param {Array<{z,k}>} [options.trueGain]  펌웨어의 초점 오차 (되찾아야 할 정답)
   * @param {number} [options.width=320]       렌더 해상도(작을수록 예제가 빠르다)
   * @param {number} [options.height=180]
   * @param {{panpos,tiltpos,zoompos}} [options.ptz] 시작 자세
   */
  constructor({
    trueHfov = TRUE_HFOV,
    trueGain = TRUE_GAIN,
    width = 320,
    height = 180,
    frameWidth = 1920,
    frameHeight = 1080,
    ptz = { panpos: 4500, tiltpos: 1200, zoompos: 0 },
  } = {}) {
    this.truth = new CameraCalibration({ zoomHfov: trueHfov, centeringGain: trueGain, frameWidth, frameHeight });
    this.geometry = new PtzGeometry({ calibration: this.truth, frameWidth, frameHeight });
    this.width = width;
    this.height = height;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.ptz = { ...ptz };
    this.moves = 0;
  }

  async getPtz() { return { ...this.ptz }; }

  async goPtz({ panpos, tiltpos, zoompos }) {
    this.moves++;
    if (panpos !== undefined) this.ptz.panpos = ((Math.round(panpos) % 36000) + 36000) % 36000;
    if (tiltpos !== undefined) this.ptz.tiltpos = Math.round(tiltpos);
    if (zoompos !== undefined) this.ptz.zoompos = Math.round(zoompos);
  }

  /**
   * 펌웨어의 setcenter. 기하는 정확하지만 초점거리를 k 배 잘못 알고 있다 —
   * 실기에서 실제로 일어나는 일이 정확히 이것이다.
   */
  async setCenter({ x, y }) {
    this.moves++;
    const k = this.truth.gainAt(this.ptz.zoompos);
    const d = this.geometry.pixelToDelta({
      x, y, zoom: this.ptz.zoompos, tiltCd: this.ptz.tiltpos, focalGain: k,
    });
    this.ptz.panpos = ((this.ptz.panpos + d.panDelta) % 36000 + 36000) % 36000;
    this.ptz.tiltpos += d.tiltDelta;
  }

  /** 지금 자세에서 본 장면. FrameMatcher 가 먹는 그레이스케일 그대로. */
  async snapshotGray() {
    const { width: w, height: h } = this;
    const data = new Uint8Array(w * h);
    const hfov = this.truth.hfovAt(this.ptz.zoompos);
    const f = (w / 2) / Math.tan((hfov / 2) * DEG);   // 렌더 픽셀 기준 초점거리
    const { F, R, U } = basis(this.ptz.panpos, this.ptz.tiltpos);
    // 화각에 맞춰 텍스처 대역을 잡는다: 화면을 2주기로 가로지르는 저주파부터 6옥타브.
    const base = 2 / hfov;

    for (let py = 0; py < h; py++) {
      const v = -(py + 0.5 - h / 2) / f;
      for (let px = 0; px < w; px++) {
        const u = (px + 0.5 - w / 2) / f;
        const rx = F[0] + R[0] * u + U[0] * v;
        const ry = F[1] + R[1] * u + U[1] * v;
        const rz = F[2] + R[2] * u + U[2] * v;
        const len = Math.hypot(rx, ry, rz) || 1;
        const az = Math.atan2(ry, rx) / DEG;
        const el = Math.asin(rz / len) / DEG;
        data[py * w + px] = texture(az, el, base) * 255;
      }
    }
    return { data, width: w, height: h };
  }

  /**
   * 예제 표시용: 클릭했던 방향이 지금 화면 어디에 있나 (= 얼마나 덜 왔나).
   * 진짜 기하로 계산하므로 매칭 없이도 잔차를 볼 수 있다.
   */
  residualOf({ clickX, clickY, before }) {
    const target = this.geometry.pixelToTarget({ x: clickX, y: clickY, ptz: before });
    const landed = this.geometry.directionToPixel({ view: this.ptz, target });
    return {
      x: landed.xExact - this.frameWidth / 2,
      y: landed.yExact - this.frameHeight / 2,
      distance: Math.hypot(landed.xExact - this.frameWidth / 2, landed.yExact - this.frameHeight / 2),
    };
  }
}

// 이 가짜 렌즈의 "정답". 실기 cam-001 을 흉내내되 값은 일부러 다르게 두었다 — 예제가 내장
// 프리셋을 그대로 되뱉는 게 아니라 **진짜로 측정하고 있다**는 걸 보이기 위해서.
export const TRUE_HFOV = [
  { z: 0, h: 55.0 },
  { z: 5129, h: 32.0 },
  { z: 8000, h: 21.0 },
];
export const TRUE_GAIN = [
  { z: 0, k: 1.00 },
  { z: 5129, k: 1.08 },
  { z: 8000, k: 1.12 },
];

// ---------------------------------------------------------------------------
// 절차적 값 노이즈 (결정적 — 같은 방향은 언제나 같은 밝기)

function hash(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

function texture(azDeg, elDeg, base) {
  let value = 0;
  let amp = 1;
  let norm = 0;
  let freq = base;
  for (let o = 0; o < 6; o++) {
    value += amp * vnoise(azDeg * freq, elDeg * freq);
    norm += amp;
    amp *= 0.62;
    freq *= 2.4;
  }
  return value / norm;
}
