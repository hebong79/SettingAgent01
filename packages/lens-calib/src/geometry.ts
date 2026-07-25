// PTZ ↔ 픽셀 기하.
//
// 부호 규약 (Hucoms, 실기 cam-001 실측 확정):
//   panpos +  = 시계방향  → 수학 방위각 a = −pan
//   tiltpos + = 아래를 봄 → 고도각      e = −tilt
//   각도 단위는 centidegree(1/100°) — 카메라가 그렇게 준다.
//
// 두 모델이 있고 섞으면 안 된다:
//   PtzGeometry  — **조준**. "이 픽셀을 가운데로 오게 하려면 얼마나 돌려야 하나"
//   역투영        — **표시**. "이 방향이 지금 프레임 어디에 보이나"
//
// 둘 다 tan 핀홀이지만 역할이 다르다. 조준 결과를 표시에 쓰거나 그 반대로 쓰면 가장자리부터 어긋난다.

import type { CameraCalibration } from './calibration.js';
import type { Ptz } from './types.js';

const DEG = Math.PI / 180;
const CD2RAD = DEG / 100; // centidegree → radian
const RAD2CD = 100 / DEG; // radian → centidegree

export type Vec3 = readonly [number, number, number];

export interface Basis {
  /** 광축(forward). */
  F: Vec3;
  /** 화면 오른쪽. F × 월드수직 이라 **항상 수평** — 롤이 없는 PTZ 짐벌의 성질 그 자체. */
  R: Vec3;
  /** 화면 위. */
  U: Vec3;
}

/** 팬/틸트(centidegree)에서 카메라 좌표계 기저를 만든다. */
export function basis(panCd: number, tiltCd: number): Basis {
  const a = -(Number(panCd) || 0) * CD2RAD;
  const e = -(Number(tiltCd) || 0) * CD2RAD;
  const ce = Math.cos(e);
  const se = Math.sin(e);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const F: Vec3 = [ce * ca, ce * sa, se];
  const rn = Math.hypot(F[0], F[1]) || 1;
  const R: Vec3 = [F[1] / rn, -F[0] / rn, 0];
  const U: Vec3 = [R[1] * F[2], -R[0] * F[2], R[0] * F[1] - R[1] * F[0]]; // R × F
  return { F, R, U };
}

export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 팬 각도를 −180°..+180°(centidegree)로 감는다. 0..36000 이음매를 넘길 때 필요. */
export const wrapCd = (to: number, from: number): number => ((((to - from + 18000) % 36000) + 36000) % 36000) - 18000;

export interface PixelToDeltaArgs {
  x: number;
  y: number;
  zoom?: number;
  /** 현재 tiltpos — 짐벌 커플링에 필요. */
  tiltCd?: number;
  /** 화각 직접 지정(표 무시). */
  hfovDeg?: number;
  /** 초점거리에 곱할 배율. 펌웨어의 (틀린) 초점을 흉내낼 때 쓴다. */
  focalGain?: number;
  /**
   * 곡면율을 펴고 시작할 것인가. 기본 true(조준은 실제 이미지 좌표를 받으므로).
   *
   * ★ false 로 두는 곳이 **한 군데** 있다 — 펌웨어의 setcenter 를 흉내낼 때다. 펌웨어는 왜곡을
   *   모르고 받은 좌표를 그대로 핀홀로 해석한다. 목 카메라가 그 사실을 정확히 재현해야
   *   솔버가 되찾을 신호가 생긴다.
   */
  undistort?: boolean;
}

export interface PtzDelta {
  panDelta: number;
  tiltDelta: number;
}

export interface DirectionToPixelResult {
  x: number;
  y: number;
  xExact: number;
  yExact: number;
  behind: boolean;
  inFrame: boolean;
}

/**
 * 조준 기하 — 픽셀 ↔ PTZ.
 *
 * 카메라 펌웨어 setcenter 가 하는 일의 재현식이자, setcenter 를 쓰지 않을 때의 대체 경로.
 * 픽셀을 카메라 좌표계의 광선으로 되돌린 뒤 그 광선이 새 광축이 되도록 팬/틸트를 푼다.
 *
 * 팬 축이 월드 수직축이라 광축이 기울어져 있으면 **가로로만 클릭해도 틸트가 딸려 움직인다**
 * (와이드·틸트 16.81°에서 dx=480 클릭에 dtilt=−62cd — 실기와 0 centidegree 로 일치).
 * 1/cos(tilt) 짐벌 커플링을 따로 곱하지 않는 이유가 이것이다 — 여기서는 기하의 결과로 저절로 나온다.
 */
export class PtzGeometry {
  readonly calibration: CameraCalibration;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly cx: number;
  readonly cy: number;

  constructor({ calibration, frameWidth = 1920, frameHeight = 1080 }: { calibration: CameraCalibration; frameWidth?: number; frameHeight?: number }) {
    if (!calibration) throw new TypeError('PtzGeometry: calibration 이 필요합니다.');
    this.calibration = calibration;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
  }

  /** 이 줌에서의 주변축 초점거리(px). hfovDeg 를 직접 주면 표를 무시한다. */
  focal(zoom: number, hfovDeg?: number): number {
    const h = hfovDeg === undefined ? this.calibration.hfovAt(zoom) : hfovDeg;
    return this.cx / Math.tan((h / 2) * DEG);
  }

  /** 픽셀 → 팬/틸트 델타(centidegree). */
  pixelToDelta({ x, y, zoom = 0, tiltCd = 0, hfovDeg, focalGain = 1, undistort = true }: PixelToDeltaArgs): PtzDelta {
    const baseFocal = this.focal(zoom, hfovDeg);

    // ① 곡면율을 편다 — 실제 이미지 좌표를 이상(핀홀) 좌표로. 표가 없으면 항등.
    let px = Number(x);
    let py = Number(y);
    if (undistort && this.calibration.distortion) {
      const u = this.calibration.distortion.undistort({ x: px, y: py, zoom, focal: baseFocal, cx: this.cx, cy: this.cy });
      px = u.x;
      py = u.y;
    }

    const focal = baseFocal * Math.max(focalGain, 0.01);
    const nx = (px - this.cx) / focal;
    const ny = (py - this.cy) / focal;

    const e0 = -(Number(tiltCd) || 0) * CD2RAD;
    const se = Math.sin(e0);
    const ce = Math.cos(e0);

    // 목표 광선 = F + R·nx + U·(−ny), 방위 0 기준
    const rx = ce + se * ny;
    const ry = -nx;
    const rz = se - ce * ny;
    const len = Math.hypot(rx, ry, rz) || 1;

    const a1 = Math.atan2(ry, rx);
    const e1 = Math.asin(Math.min(1, Math.max(-1, rz / len)));

    return {
      panDelta: Math.round(-a1 * RAD2CD),
      tiltDelta: Math.round((e0 - e1) * RAD2CD),
    };
  }

  /**
   * 픽셀 → 절대 목표 PTZ. setcenter 를 쓰지 않고 goptzfpos 로 직접 몰 때.
   * **프레임 가장자리 클램프 문제가 없다**는 것이 setcenter 대비 장점(설계서 §14-3).
   */
  pixelToTarget({ x, y, ptz, hfovDeg, focalGain = 1, undistort = true }: { x: number; y: number; ptz: Ptz; hfovDeg?: number; focalGain?: number; undistort?: boolean }): Ptz & PtzDelta {
    const d = this.pixelToDelta({ x, y, zoom: ptz?.zoompos, tiltCd: ptz?.tiltpos, hfovDeg, focalGain, undistort });
    const panpos = ((((Number(ptz?.panpos) || 0) + d.panDelta) % 36000) + 36000) % 36000;
    return {
      panpos: Math.round(panpos),
      tiltpos: Math.round((Number(ptz?.tiltpos) || 0) + d.tiltDelta),
      zoompos: Number(ptz?.zoompos) || 0,
      ...d,
    };
  }

  /**
   * 어떤 방향(다른 PTZ)이 지금 프레임의 어디에 보이는가 — **역투영**(표시).
   * 근접 호밍한 지점을 와이드 화면에 점으로 찍는 용도.
   *
   * 이상 좌표로 투영한 뒤 **distort** 해서 실제 이미지 좌표로 돌려준다 — 화면에 그리는 것은
   * 렌더가 아니라 실제 이미지이므로.
   */
  directionToPixel({ view, target, hfovDeg }: { view: Ptz; target: { panpos: number; tiltpos: number }; hfovDeg?: number }): DirectionToPixelResult {
    const h = hfovDeg === undefined ? this.calibration.hfovAt(view?.zoompos) : hfovDeg;
    const fx = this.cx / Math.tan((h / 2) * DEG);
    const fy = this.cy / Math.tan((this.calibration.vfovFrom(h) / 2) * DEG);

    const b = basis(view?.panpos, view?.tiltpos);
    const d = basis(target?.panpos, target?.tiltpos).F;

    const t = dot3(d, b.F);
    const behind = t <= 1e-9;
    let xExact = behind ? this.cx + Math.sign(dot3(d, b.R) || 1) * this.frameWidth : this.cx + fx * (dot3(d, b.R) / t);
    let yExact = behind ? this.cy - Math.sign(dot3(d, b.U) || 1) * this.frameHeight : this.cy - fy * (dot3(d, b.U) / t);

    if (!behind && this.calibration.distortion) {
      const m = this.calibration.distortion.distort({ x: xExact, y: yExact, zoom: view?.zoompos, focal: fx, cx: this.cx, cy: this.cy });
      xExact = m.x;
      yExact = m.y;
    }

    return {
      x: clamp(Math.round(xExact), 0, this.frameWidth),
      y: clamp(Math.round(yExact), 0, this.frameHeight),
      xExact,
      yExact,
      behind,
      inFrame: !behind && xExact >= 0 && xExact <= this.frameWidth && yExact >= 0 && yExact <= this.frameHeight,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
