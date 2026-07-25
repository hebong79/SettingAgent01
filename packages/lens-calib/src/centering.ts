// 클릭 센터링 — "화면을 클릭하면 그 지점이 정확히 가운데로".
//
// 카메라 어댑터(HucomsCameraPort) 하나만 구현하면 어느 프로젝트에서든 그대로 돌아간다.
//
//   const cc = new ClickCentering({ camera, calibration: 'cam-001' });
//   await cc.click({ x: 1760, y: 150 });     // 프레임 픽셀(1920x1080)
//
// 두 가지 조준 모드:
//   'setcenter' (기본) — 카메라의 setcenter 에 **보정된 좌표**를 준다. 왕복 1회, 가장 빠르다.
//   'absolute'        — 목표 PTZ 를 직접 계산해 절대이동한다. setcenter 가 없거나, 프레임
//                       가장자리 클램프(보정 좌표가 0..W 를 벗어남)를 피하고 싶을 때.

import { CameraCalibration } from './calibration.js';
import { PtzGeometry } from './geometry.js';
import type { CalibrationSpec, GainPoint, HucomsCameraPort, Point, Ptz } from './types.js';

export type AimMode = 'setcenter' | 'absolute';

export interface ClickCenteringInit {
  camera: HucomsCameraPort;
  calibration?: CameraCalibration | CalibrationSpec | GainPoint[] | string | null;
  mode?: AimMode;
  frameWidth?: number;
  frameHeight?: number;
  speed?: number;
}

export interface ClickArgs {
  x: number;
  y: number;
  /** 임의 해상도 좌표를 넘길 때 그 좌표계의 크기. 주면 기준 프레임으로 자동 환산한다. */
  frameWidth?: number;
  frameHeight?: number;
  speed?: number;
  /**
   * 보정을 우회한다. **캘리브레이션 측정 전용** — 재려는 대상을 보정 너머로 재면 안 되니까.
   */
  rawAim?: boolean;
}

export interface ClickResult {
  from: Ptz;
  sent: Point | (Ptz & { panDelta: number; tiltDelta: number });
  clicked?: Point;
  ptz: Ptz;
  k: number;
  undistortScale: number;
  clamped: boolean;
  mode: AimMode;
}

export class ClickCentering {
  readonly camera: HucomsCameraPort;
  readonly calibration: CameraCalibration;
  readonly geometry: PtzGeometry;
  readonly mode: AimMode;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly speed?: number;

  constructor({ camera, calibration = null, mode = 'setcenter', frameWidth = 1920, frameHeight = 1080, speed }: ClickCenteringInit) {
    if (!camera || typeof camera.getPtz !== 'function') {
      throw new TypeError('ClickCentering: camera 어댑터에 getPtz() 가 필요합니다.');
    }
    if (mode !== 'setcenter' && mode !== 'absolute') throw new TypeError(`알 수 없는 mode: ${String(mode)}`);
    if (mode === 'setcenter' && typeof camera.setCenter !== 'function') {
      throw new TypeError("mode 'setcenter' 에는 camera.setCenter() 가 필요합니다.");
    }
    if (mode === 'absolute' && typeof camera.goPtz !== 'function') {
      throw new TypeError("mode 'absolute' 에는 camera.goPtz() 가 필요합니다.");
    }

    this.camera = camera;
    this.calibration = calibration instanceof CameraCalibration ? calibration : CameraCalibration.from(calibration, { frameWidth, frameHeight });
    this.mode = mode;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.speed = speed;
    this.geometry = new PtzGeometry({ calibration: this.calibration, frameWidth, frameHeight });
  }

  /** 임의 해상도 좌표 → 이 카메라의 기준 프레임 좌표. */
  normalize({ x, y, frameWidth, frameHeight }: { x: number; y: number; frameWidth?: number; frameHeight?: number }): Point {
    const sx = frameWidth ? this.frameWidth / frameWidth : 1;
    const sy = frameHeight ? this.frameHeight / frameHeight : 1;
    const nx = Number(x) * sx;
    const ny = Number(y) * sy;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new TypeError('x, y 는 유한한 숫자여야 합니다.');
    return { x: clamp(Math.round(nx), 0, this.frameWidth), y: clamp(Math.round(ny), 0, this.frameHeight) };
  }

  /** 정규화 좌표(0~1) → 프레임 픽셀. ParkAgent 어댑터가 쓰는 진입점. */
  fromNormalized({ x, y }: { x: number; y: number }): Point {
    return {
      x: Math.round(clamp01(x) * this.frameWidth),
      y: Math.round(clamp01(y) * this.frameHeight),
    };
  }

  /** 클릭 한 번 = 그 지점을 화면 중앙으로. */
  async click({ x, y, frameWidth, frameHeight, speed, rawAim = false }: ClickArgs): Promise<ClickResult> {
    const point = this.normalize({ x, y, frameWidth, frameHeight });
    const from = await this.camera.getPtz();
    const spd = speed ?? this.speed;

    if (this.mode === 'absolute') {
      // 절대이동은 f_true 로 직접 각도를 푼다 — 펌웨어의 틀린 초점을 아예 거치지 않으므로
      // 게인도, 가장자리 클램프도 필요 없다. 곡면율은 여전히 편다(rawAim 이면 그것도 끈다).
      const target = this.geometry.pixelToTarget({ ...point, ptz: from, undistort: !rawAim });
      await this.camera.goPtz!({ ...target, speed: spd });
      return { from, sent: target, clicked: point, ptz: await this.settle(from), k: 1, undistortScale: 1, clamped: false, mode: this.mode };
    }

    const aim = rawAim
      ? { x: point.x, y: point.y, k: 1, undistortScale: 1, clamped: false }
      : this.calibration.aim({ ...point, zoom: from.zoompos });
    await this.camera.setCenter!({ x: aim.x, y: aim.y, speed: spd });
    return {
      from,
      sent: { x: aim.x, y: aim.y },
      clicked: point,
      ptz: await this.settle(from),
      k: aim.k,
      undistortScale: aim.undistortScale,
      clamped: aim.clamped,
      mode: this.mode,
    };
  }

  /**
   * 드래그한 네모 = 그 영역으로 센터링 + 줌인.
   * **중심만** 보정한다(크기는 펌웨어가 목표 줌을 읽는 값이라 건드리면 안 된다).
   */
  async clickBox({
    startX,
    startY,
    endX,
    endY,
    frameWidth,
    frameHeight,
    speed,
    rawAim = false,
  }: { startX: number; startY: number; endX: number; endY: number; frameWidth?: number; frameHeight?: number; speed?: number; rawAim?: boolean }): Promise<{
    from: Ptz;
    sent: { startX: number; startY: number; endX: number; endY: number };
    ptz: Ptz;
    k: number;
    clamped: boolean;
  }> {
    if (typeof this.camera.setCenterBox !== 'function') {
      throw new TypeError('박스줌에는 camera.setCenterBox() 가 필요합니다.');
    }
    const a = this.normalize({ x: Math.min(startX, endX), y: Math.min(startY, endY), frameWidth, frameHeight });
    const b = this.normalize({ x: Math.max(startX, endX), y: Math.max(startY, endY), frameWidth, frameHeight });
    const from = await this.camera.getPtz();
    const box = rawAim
      ? { startX: a.x, startY: a.y, endX: b.x, endY: b.y, k: 1, clamped: false }
      : this.calibration.aimBox({ startX: a.x, startY: a.y, endX: b.x, endY: b.y, zoom: from.zoompos });

    await this.camera.setCenterBox({ startX: box.startX, startY: box.startY, endX: box.endX, endY: box.endY, speed: speed ?? this.speed });
    return { from, sent: { startX: box.startX, startY: box.startY, endX: box.endX, endY: box.endY }, ptz: await this.settle(from), k: box.k, clamped: box.clamped };
  }

  /** 이 클릭이 얼마나 보정되는지 미리 본다 — 카메라를 움직이지 않는다(UI 프리뷰·디버깅). */
  preview({ x, y, zoom, frameWidth, frameHeight }: { x: number; y: number; zoom: number; frameWidth?: number; frameHeight?: number }): {
    clicked: Point;
    sent: Point;
    k: number;
    undistortScale: number;
    clamped: boolean;
    shiftPx: number;
    hfovDeg: number;
    distortionShiftPx: number;
  } {
    const point = this.normalize({ x, y, frameWidth, frameHeight });
    const aim = this.calibration.aim({ ...point, zoom });
    return {
      clicked: point,
      sent: { x: aim.x, y: aim.y },
      k: aim.k,
      undistortScale: aim.undistortScale,
      clamped: aim.clamped,
      shiftPx: Math.hypot(aim.x - point.x, aim.y - point.y),
      hfovDeg: this.calibration.hfovAt(zoom),
      distortionShiftPx: this.calibration.distortionShiftPx(zoom),
    };
  }

  private async settle(before: Ptz): Promise<Ptz> {
    return typeof this.camera.waitSettle === 'function' ? this.camera.waitSettle({ before }) : this.camera.getPtz();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number(v) || 0));
}
