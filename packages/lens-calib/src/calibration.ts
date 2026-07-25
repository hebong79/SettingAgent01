// 카메라 캘리브레이션 — 이 렌즈의 **세 곡선**.
//
// ── 왜 세 개인가 ────────────────────────────────────────────────────────────
// 실기 Hucoms 105샘플이 확인한 것:
//   * 펌웨어의 setcenter 는 이미 **정확한 tan 기하 + 1/cos(tilt) 짐벌 커플링**을 쓴다
//     (팬 스윕과 틸트 스윕으로 각각 역산한 초점거리가 0.1% 이내 일치 — 선형 모델이면 불가능하다)
//   * 틀린 것은 기하가 아니라 **상수 하나** — 펌웨어가 믿는 f_fw 가 실제 렌즈의 f_true 와 어긋난다
//
// 그래서 두 표로 시작했고, 그 둘이 원리적으로 못 잡는 성분 하나가 남아 세 번째가 생겼다:
//
//   zoomHfov       {z, h}      렌즈가 실제로 보는 화각        **표시**  (주변축 f 를 정한다)
//   lensDistortion {z, k1, k2} 그 시야가 얼마나 휘었나        **양쪽**  (편심의 3승 이상)  ★신규
//   centeringGain  {z, k}      펌웨어가 얼마나 잘못 도나      **조준**  (편심의 1승)
//
// **세 표는 서로 다른 축이다. 바꿔 쓰면 화면 가장자리로 갈수록 어긋난다.**
//
// ── 조준은 3단이고, 순서가 중요하다 ──────────────────────────────────────────
//
//   클릭(실제 이미지 픽셀) → undistort → ×k → clamp 0..W → setcenter
//
// 펌웨어는 왜곡을 **모르고** 받은 좌표를 핀홀로 해석한다. 그러므로 먼저 펴서 진짜 광선 각도를
// 얻고, 그 다음 펌웨어의 초점 배율오차를 상쇄해야 한다. 반대로 하면 두 보정이 서로를 오염시킨다.
//
// 정확성 증명:
//   목표 — 펌웨어가 atan(send/f_fw) 만큼 돌아 참 각도 atan(r_u/f_true) 와 같아야 한다
//   ⟹ send = r_u·(f_fw/f_true) = undistort(r_d) · k                                  ∎
//
// k1=k2=0 이면 undistort 가 항등이므로 **참조본과 완전히 동일한 한 줄**로 환원된다(설계서 G5).

import { ZoomCurve } from './curve.js';
import { LensDistortion } from './distortion.js';
import { getPreset, PRESETS } from './presets.js';
import type { CalibrationSpec, DistortionPoint, GainPoint, HfovPoint, Point, ResidualReport } from './types.js';

const DEG = Math.PI / 180;

export interface CalibrationInit {
  zoomHfov?: readonly HfovPoint[] | ZoomCurve;
  centeringGain?: readonly GainPoint[] | ZoomCurve | null;
  lensDistortion?: readonly DistortionPoint[] | LensDistortion | null;
  frameWidth?: number;
  frameHeight?: number;
  label?: string;
  measuredAt?: string;
  residual?: ResidualReport;
  source?: string;
}

/** aim() 결과. clamped=true 면 그 클릭은 **부분 보정만** 된 것이다. */
export interface AimResult {
  x: number;
  y: number;
  /** 적용된 게인. */
  k: number;
  /** undistort 로 편심이 몇 배가 됐나(1 = 곡면율 보정 없음). */
  undistortScale: number;
  /** 프레임 밖으로 나가 잘렸는가. */
  clamped: boolean;
}

export class CameraCalibration {
  readonly hfovCurve: ZoomCurve;
  readonly gainCurve: ZoomCurve | null;
  readonly distortion: LensDistortion | null;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly aspect: number;
  readonly cx: number;
  readonly cy: number;
  readonly label?: string;
  readonly measuredAt?: string;
  readonly residual?: ResidualReport;
  readonly source: string;

  constructor({
    zoomHfov,
    centeringGain = null,
    lensDistortion = null,
    frameWidth = 1920,
    frameHeight = 1080,
    label,
    measuredAt,
    residual,
    source = 'measured',
  }: CalibrationInit = {}) {
    if (!(frameWidth > 0) || !(frameHeight > 0)) throw new TypeError('frameWidth/frameHeight 는 양수여야 합니다.');
    if (!zoomHfov) throw new TypeError('zoomHfov 가 필요합니다.');
    this.hfovCurve = ZoomCurve.from(zoomHfov as unknown as readonly Record<string, number>[], 'h', { name: 'zoomHfov' });
    this.gainCurve = centeringGain ? ZoomCurve.from(centeringGain as unknown as readonly Record<string, number>[], 'k', { name: 'centeringGain' }) : null;
    this.distortion = LensDistortion.from(lensDistortion ?? null);
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.aspect = frameWidth / frameHeight;
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
    this.label = label;
    this.measuredAt = measuredAt;
    this.residual = residual;
    this.source = source;
  }

  /** 게인 곡선이 있는가 = 편심 배율 보정을 하는가. */
  get hasGain(): boolean {
    return this.gainCurve !== null;
  }

  /** 곡면율 곡선이 있고, 실제로 0 이 아닌 계수를 들고 있는가. */
  get hasDistortion(): boolean {
    return this.distortion !== null && this.distortion.hasAnyDistortion;
  }

  /**
   * 프리셋 이름 / 실측 객체 / 배열(구버전: 게인만) / null 을 하나로 해석한다.
   * null 이면 "이 카메라는 캘리브레이션 없음" — **보정 없이** 조준하고 기본 화각표로 그린다.
   */
  static from(
    spec: CameraCalibration | CalibrationSpec | GainPoint[] | string | null | undefined,
    { frameWidth = 1920, frameHeight = 1080, fallback = 'cam-001' }: { frameWidth?: number; frameHeight?: number; fallback?: string | null } = {},
  ): CameraCalibration {
    if (spec instanceof CameraCalibration) return spec;
    const defaults = fallback ? getPreset(fallback) : null;

    if (!spec) {
      return new CameraCalibration({
        zoomHfov: defaults?.zoomHfov,
        centeringGain: null,
        lensDistortion: null,
        frameWidth,
        frameHeight,
        source: 'none',
      });
    }
    if (typeof spec === 'string') {
      const p = getPreset(spec);
      return new CameraCalibration({ ...p, frameWidth, frameHeight, source: spec });
    }
    // 구버전 모양: intrinsics 가 게인 곡선 배열 하나였다.
    if (Array.isArray(spec)) {
      return new CameraCalibration({
        zoomHfov: defaults?.zoomHfov,
        centeringGain: spec,
        frameWidth,
        frameHeight,
        source: 'measured',
      });
    }
    if (typeof spec !== 'object') throw new TypeError('캘리브레이션은 프리셋 이름 · 실측 객체 · null 중 하나여야 합니다.');

    // 실측 객체는 프리셋을 상속해 **잰 것만** 덮어쓴다.
    const inherited = spec.model ? getPreset(spec.model) : defaults;
    const measured = Boolean(spec.zoomHfov || spec.centeringGain || spec.lensDistortion);
    return new CameraCalibration({
      zoomHfov: spec.zoomHfov ?? inherited?.zoomHfov,
      centeringGain: spec.centeringGain ?? (spec.zoomHfov ? null : inherited?.centeringGain) ?? null,
      lensDistortion: spec.lensDistortion ?? inherited?.lensDistortion ?? null,
      label: spec.label ?? inherited?.label,
      measuredAt: spec.measuredAt,
      residual: spec.residual,
      frameWidth,
      frameHeight,
      source: measured ? 'measured' : (spec.model ?? 'none'),
    });
  }

  // ── 표시(display) 축 ──────────────────────────────────────────────────────

  /**
   * 줌 → 수평 화각(도).
   * ★ 곡면율 표가 있을 때 이 값은 **주변축(paraxial) 화각**이다 — 화면 중심 근처의 기울기가 정의하는
   *   각이며, 프레임 가장자리까지의 실제 각이 아니다(그건 hfovEdgeAt). 두 값은 왜곡이 0 일 때만 같다.
   */
  hfovAt(zoom: number): number {
    return this.hfovCurve.at(zoom);
  }

  /** 수평 화각 → 수직 화각(도). tan 렌즈는 비율이 일정하지 않다(와이드 0.614 → 28° 0.570). */
  vfovFrom(hfovDeg: number): number {
    return (2 * Math.atan(Math.tan((hfovDeg / 2) * DEG) / this.aspect)) / DEG;
  }

  vfovAt(zoom: number): number {
    return this.vfovFrom(this.hfovAt(zoom));
  }

  /** 줌 → 주변축 초점거리(px). f_true. 그리기·역투영·왜곡 정규화의 기준. */
  focalAt(zoom: number): number {
    return this.cx / Math.tan((this.hfovAt(zoom) / 2) * DEG);
  }

  /**
   * 진단: 프레임 좌우 끝까지의 **실제** 수평 화각(도). 곡면율이 없으면 hfovAt 와 같다.
   * 배럴이면 이 값이 hfovAt 보다 **크다**(가장자리가 안으로 수축해 더 넓은 세상이 담긴다).
   */
  hfovEdgeAt(zoom: number): number {
    const f = this.focalAt(zoom);
    if (!this.distortion) return this.hfovAt(zoom);
    const ru = this.distortion.undistortRadius(this.cx / f, this.distortion.coeffsAt(zoom));
    return (2 * Math.atan(ru)) / DEG;
  }

  /** 진단: 이 줌에서 코너가 왜곡으로 몇 px 밀리나. 0 이면 보정할 것이 없다. */
  distortionShiftPx(zoom: number): number {
    if (!this.distortion) return 0;
    return this.distortion.maxShiftPx({ zoom, focal: this.focalAt(zoom), cx: this.cx, cy: this.cy });
  }

  // ── 조준(aiming) 축 ───────────────────────────────────────────────────────

  /** 줌 → 보정 게인 k. 곡선이 없으면 1(보정 안 함). */
  gainAt(zoom: number): number {
    return this.gainCurve ? this.gainCurve.at(zoom) : 1;
  }

  /** 실제 이미지 픽셀 → 이상(핀홀) 픽셀. 곡면율 표가 없으면 **입력을 그대로** 돌려준다. */
  undistortPoint({ x, y, zoom }: { x: number; y: number; zoom: number }): Point {
    if (!this.distortion) return { x, y };
    const m = this.distortion.undistort({ x, y, zoom, focal: this.focalAt(zoom), cx: this.cx, cy: this.cy });
    return { x: m.x, y: m.y };
  }

  /** 이상(핀홀) 픽셀 → 실제 이미지 픽셀. 그리기·prior ROI 용. */
  distortPoint({ x, y, zoom }: { x: number; y: number; zoom: number }): Point {
    if (!this.distortion) return { x, y };
    const m = this.distortion.distort({ x, y, zoom, focal: this.focalAt(zoom), cx: this.cx, cy: this.cy });
    return { x: m.x, y: m.y };
  }

  /**
   * 클릭 좌표를 setcenter 에 넘길 좌표로 바꾼다 — **이 라이브러리의 핵심 3단.**
   *
   *   1) undistort  곡면율을 편다 (표 없으면 항등)
   *   2) × k        프레임 중심 기준으로 편심을 게인만큼 민다
   *   3) clamp      setcenter 가 받는 0..W / 0..H 로 자른다
   *
   * 잘리면 clamped:true 로 알린다 — 그 클릭은 **부분 보정**만 된 것이다. 완전 해결은
   * ClickCentering 의 mode:'absolute'(목표 PTZ 직접 계산 후 goptzfpos 절대이동).
   */
  aim({ x, y, zoom }: { x: number; y: number; zoom: number }): AimResult {
    const u = this.undistortPoint({ x: Number(x), y: Number(y), zoom });
    const rIn = Math.hypot(Number(x) - this.cx, Number(y) - this.cy);
    const rOut = Math.hypot(u.x - this.cx, u.y - this.cy);

    const k = this.gainAt(zoom);
    const ax = this.cx + (u.x - this.cx) * k;
    const ay = this.cy + (u.y - this.cy) * k;
    const sx = clamp(Math.round(ax), 0, this.frameWidth);
    const sy = clamp(Math.round(ay), 0, this.frameHeight);
    return {
      x: sx,
      y: sy,
      k,
      undistortScale: rIn > 1e-9 ? rOut / rIn : 1,
      clamped: sx !== Math.round(ax) || sy !== Math.round(ay),
    };
  }

  /**
   * 박스줌용. 박스의 **중심만** 보정해 박스를 통째로 평행이동한다.
   * 크기는 건드리지 않는다 — 크기는 펌웨어가 목표 줌을 읽는 값이고, 그건 별개 문제다.
   */
  aimBox({ startX, startY, endX, endY, zoom }: { startX: number; startY: number; endX: number; endY: number; zoom: number }): {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    k: number;
    clamped: boolean;
  } {
    if (!this.hasGain && !this.hasDistortion) return { startX, startY, endX, endY, k: 1, clamped: false };
    const bx = (startX + endX) / 2;
    const by = (startY + endY) / 2;
    const a = this.aim({ x: bx, y: by, zoom });
    // 보정만큼 밀되, 크기를 바꾸지 않고 프레임 안으로 되민다.
    const dx = clamp(a.x - bx, -startX, this.frameWidth - endX);
    const dy = clamp(a.y - by, -startY, this.frameHeight - endY);
    return {
      startX: Math.round(startX + dx),
      startY: Math.round(startY + dy),
      endX: Math.round(endX + dx),
      endY: Math.round(endY + dy),
      k: a.k,
      clamped: dx !== a.x - bx || dy !== a.y - by,
    };
  }

  // ── 직렬화 ────────────────────────────────────────────────────────────────

  /** 저장 모양. 그대로 CameraCalibration.from() 에 다시 넣을 수 있다. */
  toJSON(): CalibrationSpec {
    return {
      ...(this.label ? { label: this.label } : {}),
      zoomHfov: this.hfovCurve.toJSON(2) as unknown as HfovPoint[],
      ...(this.gainCurve ? { centeringGain: this.gainCurve.toJSON(3) as unknown as GainPoint[] } : {}),
      ...(this.distortion ? { lensDistortion: this.distortion.toJSON(5) } : {}),
      ...(this.measuredAt ? { measuredAt: this.measuredAt } : {}),
      ...(this.residual ? { residual: this.residual } : {}),
    };
  }

  /** 사람이 읽을 요약 한 줄. */
  describe(): string {
    const [z0, z1] = this.hfovCurve.domain;
    return [
      this.label ?? this.source,
      `화각 ${this.hfovAt(z0).toFixed(1)}°(z${z0}) → ${this.hfovAt(z1).toFixed(2)}°(z${z1})`,
      this.hasGain ? `게인 ${this.gainCurve!.length}점` : '게인 없음(무보정 조준)',
      this.distortion ? this.distortion.describe() : '곡면율 없음',
      this.measuredAt ? `실측 ${this.measuredAt}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
}

export { PRESETS };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
