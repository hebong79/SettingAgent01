// 가짜 Hucoms PTZ 카메라 — 하드웨어 없이 라이브러리 전체를 돌려볼 수 있게 한다.
//
// 실기의 병을 **일부러 주입**한다. 이 세 줄이 이 파일의 전부다:
//
//   렌더    → 진짜 렌즈로: f_true + **곡면율(k1,k2)**
//   setcenter → 펌웨어로:  f_fw = f_true × k, **곡면율을 모른다**
//   텔레메트리 → 정확히
//
// 그래서 클릭은 두 가지 이유로 빗나간다(편심 비례 오차 + 가장자리 3승 오차). 캘리브레이션이
// 되찾아야 하는 것이 정확히 그 둘이고, 되찾았는지는 여기 숨겨둔 정답과 대조하면 알 수 있다.
//
// 장면은 절차적 노이즈 텍스처다. ZNCC 매칭에는 "미세하고 반복되지 않는 무늬"만 있으면 되고,
// 그건 노이즈가 실사보다 오히려 잘 만족한다.

import { CameraCalibration } from '../src/calibration.js';
import { basis } from '../src/geometry.js';
import { PtzGeometry } from '../src/geometry.js';
import { undistortRadius } from '../src/distortion.js';
import type { DistortionPoint, GainPoint, GrayFrame, HfovPoint, HucomsCameraPort, Ptz } from '../src/types.js';

const DEG = Math.PI / 180;

/** 이 가짜 렌즈의 "정답". 실기 cam-001 을 흉내내되 값은 일부러 다르게 두었다 —
 *  예제·테스트가 내장 프리셋을 되뱉는 게 아니라 **진짜로 측정하고 있다**는 걸 보이기 위해서. */
export const TRUE_HFOV: HfovPoint[] = [
  { z: 0, h: 55.0 },
  { z: 5129, h: 32.0 },
  { z: 8000, h: 21.0 },
];

export const TRUE_GAIN: GainPoint[] = [
  { z: 0, k: 1.0 },
  { z: 5129, k: 1.08 },
  { z: 8000, k: 1.12 },
];

/** 정답 곡면율. 배럴(k1<0)이고 와이드에서 크다 — 광각 렌즈의 정상적인 모습. */
export const TRUE_DISTORTION: DistortionPoint[] = [
  { z: 0, k1: -0.085, k2: 0.012 },
  { z: 5129, k1: -0.02, k2: 0 },
  { z: 8000, k1: -0.008, k2: 0 },
];

export interface MockCameraOptions {
  trueHfov?: HfovPoint[];
  trueGain?: GainPoint[] | null;
  trueDistortion?: DistortionPoint[] | null;
  /** 렌더 해상도(작을수록 빠르다). 논리 프레임과 달라도 된다. */
  width?: number;
  height?: number;
  frameWidth?: number;
  frameHeight?: number;
  ptz?: Ptz;
}

export class MockHucomsCamera implements HucomsCameraPort {
  /** 되찾아야 할 정답. 테스트가 이것과 대조한다. */
  readonly truth: CameraCalibration;
  private readonly geometry: PtzGeometry;
  readonly width: number;
  readonly height: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  ptz: Ptz;
  moves = 0;
  snapshots = 0;

  constructor({
    trueHfov = TRUE_HFOV,
    trueGain = TRUE_GAIN,
    trueDistortion = TRUE_DISTORTION,
    width = 384,
    height = 216,
    frameWidth = 1920,
    frameHeight = 1080,
    ptz = { panpos: 4500, tiltpos: 1200, zoompos: 0 },
  }: MockCameraOptions = {}) {
    this.truth = new CameraCalibration({
      zoomHfov: trueHfov,
      centeringGain: trueGain,
      lensDistortion: trueDistortion,
      frameWidth,
      frameHeight,
    });
    this.geometry = new PtzGeometry({ calibration: this.truth, frameWidth, frameHeight });
    this.width = width;
    this.height = height;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.ptz = { ...ptz };
  }

  async getPtz(): Promise<Ptz> {
    return { ...this.ptz };
  }

  async waitSettle(): Promise<Ptz> {
    return { ...this.ptz };
  }

  async goPtz({ panpos, tiltpos, zoompos }: Partial<Ptz>): Promise<void> {
    this.moves++;
    if (panpos !== undefined) this.ptz.panpos = ((Math.round(panpos) % 36000) + 36000) % 36000;
    if (tiltpos !== undefined) this.ptz.tiltpos = Math.round(tiltpos);
    if (zoompos !== undefined) this.ptz.zoompos = Math.round(zoompos);
  }

  /**
   * 펌웨어의 setcenter. 기하는 정확하지만 **초점거리를 k 배 잘못 알고 있고, 곡면율을 모른다** —
   * 실기에서 실제로 일어나는 일이 정확히 이것이다.
   */
  async setCenter({ x, y }: { x: number; y: number }): Promise<void> {
    this.moves++;
    const k = this.truth.gainAt(this.ptz.zoompos);
    const d = this.geometry.pixelToDelta({
      x,
      y,
      zoom: this.ptz.zoompos,
      tiltCd: this.ptz.tiltpos,
      focalGain: k,
      undistort: false, // ★ 펌웨어는 왜곡을 모른다. 이 한 줄이 곡면율 오차의 원천이다.
    });
    this.ptz.panpos = (((this.ptz.panpos + d.panDelta) % 36000) + 36000) % 36000;
    this.ptz.tiltpos += d.tiltDelta;
  }

  /** 지금 자세에서 본 장면. FrameMatcher 가 먹는 그레이스케일 그대로. */
  async snapshotGray(): Promise<GrayFrame> {
    this.snapshots++;
    const { width: w, height: h } = this;
    const data = new Uint8Array(w * h);
    const zoom = this.ptz.zoompos;
    const hfov = this.truth.hfovAt(zoom);
    const fLogical = this.truth.focalAt(zoom);
    const coeffs = this.truth.distortion ? this.truth.distortion.coeffsAt(zoom) : { k1: 0, k2: 0 };
    const cxL = this.frameWidth / 2;
    const cyL = this.frameHeight / 2;
    const sx = this.frameWidth / w;
    const sy = this.frameHeight / h;
    const { F, R, U } = basis(this.ptz.panpos, this.ptz.tiltpos);
    // 화각에 맞춰 텍스처 대역을 잡는다: 화면을 2주기로 가로지르는 저주파부터 6옥타브.
    const base = 2 / hfov;

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        // ① 이 이미지 픽셀의 논리 좌표
        const X = (px + 0.5) * sx;
        const Y = (py + 0.5) * sy;
        // ② 곡면율을 펴서 이상 좌표로 — "이 픽셀은 어느 방향을 보고 있나"
        const dxp = X - cxL;
        const dyp = Y - cyL;
        const rpx = Math.hypot(dxp, dyp);
        let scale = 1;
        if (rpx > 1e-9 && (coeffs.k1 || coeffs.k2)) {
          const rIn = rpx / fLogical;
          scale = undistortRadius(rIn, coeffs) / rIn;
        }
        const u = (dxp * scale) / fLogical;
        const v = -(dyp * scale) / fLogical;
        // ③ 광선 → 방위/고도 → 텍스처
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
   * 표시·디버깅용: 클릭했던 방향이 지금 화면 어디에 있나(= 얼마나 덜 왔나).
   * 진짜 기하로 계산하므로 매칭 없이도 잔차를 볼 수 있다.
   */
  residualOf({ clickX, clickY, before }: { clickX: number; clickY: number; before: Ptz }): { x: number; y: number; distance: number } {
    const target = this.geometry.pixelToTarget({ x: clickX, y: clickY, ptz: before });
    const landed = this.geometry.directionToPixel({ view: this.ptz, target });
    const x = landed.xExact - this.frameWidth / 2;
    const y = landed.yExact - this.frameHeight / 2;
    return { x, y, distance: Math.hypot(x, y) };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 절차적 값 노이즈 (결정적 — 같은 방향은 언제나 같은 밝기)

function hash(i: number, j: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number): number {
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

function texture(azDeg: number, elDeg: number, base: number): number {
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
