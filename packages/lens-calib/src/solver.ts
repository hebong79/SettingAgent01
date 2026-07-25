// 캘리브레이션 솔버 — 측정 샘플 → 이 카메라의 세 곡선.
//
// ── 참조본에서 그대로 계승하는 것 (손대지 않는다) ────────────────────────────
// 화각·게인은 **완전히 독립인 세 경로**로 같은 답에 도달한다. 이 삼중화가 참조본을 믿을 수 있게
// 만든 유일한 이유이므로 구조를 보존한다:
//
//   f_true  — **영상만**. 측정된 before/after PTZ 와 착지 픽셀만으로, 그 3D 회전이 그 픽셀 이동을
//             설명하게 만드는 단 하나의 f 를 푼다. 펌웨어 모델이 전혀 안 들어간다
//   f_fw    — **텔레메트리만**. 카메라가 고른 팬/틸트에서 바로 읽는다. 영상 불필요.
//             세로 클릭은 깨끗하게, 가로 클릭은 1/cos(tilt) 짐벌 커플링을 얹어서.
//             ★ 이 둘이 0.1% 이내로 일치한다는 사실이 "펌웨어 기하는 정확하다"의 증명이다
//   g       — **모델 없음**. 잔차/편심 기울기의 중앙값. 운영자가 보는 것 그 자체
//
// 최종 게인은 g 에서 뽑는다(f_fw/f_true 와 일치하지만 기울기가 열화에 강하다).
// 화각은 f_true 에서 뽑는다.
//
// ── 이번에 추가되는 것 ──────────────────────────────────────────────────────
// 곡면율 (k1, k2). 비용함수는 **같은 predictLanding 하나**를 왜곡 포함으로 확장한 것이다.
// 광류 격자 샘플이 클릭 샘플과 같은 스키마라 코드가 그대로 재사용된다(설계서 §7.2).

import { CameraCalibration } from './calibration.js';
import { distortRadius, mapRadialPx, type Coeffs } from './distortion.js';
import { basis, dot3, type Vec3 } from './geometry.js';
import { goldenSection, nelderMead } from './optimize.js';
import type { DistortionPoint, GainPoint, HfovPoint, ResidualReport, Sample } from './types.js';

const DEG = Math.PI / 180;

export interface SolverOptions {
  frameWidth?: number;
  frameHeight?: number;
  /** 장면이 우리를 배신한 경계(하늘·빈 아스팔트). */
  minPeak?: number;
  /** 같은 무늬의 다른 반복을 가리키는 경계. */
  minMargin?: number;
  /** 한 줌에서 기울기를 내는 데 필요한 최소 샘플. */
  minSamples?: number;
  /** 초점 탐색 구간(px). */
  focalRange?: [number, number];
  /** 황금분할 반복 횟수. */
  iterations?: number;
  /** 곡면율 채택 게이트 — 왜곡항이 잔차를 이만큼은 줄여야 한다. */
  minImprovement?: number;
  /** 곡면율 채택 게이트 — 코너 변위가 이만큼은 되어야 한다(px). */
  minCornerShiftPx?: number;
}

/** 한 줌의 화각·게인 해. */
export interface ZoomPoint {
  zoom: number;
  hfov: number | null;
  gain: number | null;
  focalTrue: number | null;
  focalFirmware: number | null;
  residualSlope: number;
  residualPx: number;
  fitRmsPx: number | null;
  samples: number;
  of: number;
}

/** 렌즈 피팅 결과 (f 와 선택적 왜곡 계수). */
export interface LensFit {
  f: number;
  k1: number;
  k2: number;
  /** 예측-관측 RMS(px). */
  rms: number;
  n: number;
  dof: 1 | 2 | 3;
}

export interface SkippedZoom {
  zoom: number;
  usable: number;
  of: number;
  why?: string;
}

export class CalibrationSolver {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly minPeak: number;
  readonly minMargin: number;
  readonly minSamples: number;
  readonly focalRange: [number, number];
  readonly iterations: number;
  readonly minImprovement: number;
  readonly minCornerShiftPx: number;
  readonly cx: number;
  readonly cy: number;

  constructor({
    frameWidth = 1920,
    frameHeight = 1080,
    minPeak = 0.6,
    minMargin = 0.02,
    minSamples = 2,
    focalRange = [400, 400000],
    iterations = 220,
    minImprovement = 0.25,
    minCornerShiftPx = 4,
  }: SolverOptions = {}) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.minPeak = minPeak;
    this.minMargin = minMargin;
    this.minSamples = minSamples;
    this.focalRange = focalRange;
    this.iterations = iterations;
    this.minImprovement = minImprovement;
    this.minCornerShiftPx = minCornerShiftPx;
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
  }

  /**
   * 샘플이 거짓말하는 방식들을 걸러낸다: 약한 템플릿 매칭, 모호한 매칭, 그리고 요청한 이동과
   * 어긋나는 PTZ 회신(정착 전에 읽음).
   *
   * ★ 교차축 검사는 **클릭 샘플에만** 적용한다. 광류 격자 샘플은 애초에 축 분리를 하지 않고
   *   프레임 전역을 재므로, 클릭용 게이트를 그대로 걸면 정상 샘플을 대량으로 버린다.
   */
  usable(samples: readonly Sample[]): Sample[] {
    return samples.filter((s) => {
      if (s.usable === false) return false;
      if (!Number.isFinite(s.landedX) || !Number.isFinite(s.landedY)) return false;
      if (s.peak !== undefined && !(s.peak >= this.minPeak)) return false;
      // margin 은 모호성 검사가 생기기 전 스윕에는 없다 — 그런 샘플도 쓰되, 보증이 약할 뿐이다.
      if (s.margin !== undefined && !(s.margin >= this.minMargin)) return false;
      if (s.kind === 'click') {
        if (s.dx && Math.sign(s.dpanCd || s.dx) !== Math.sign(s.dx)) return false;
        if (s.dy && Math.sign(s.dtiltCd || s.dy) !== Math.sign(s.dy)) return false;
        if (s.dy === 0 && Math.abs(s.residualY) > 40) return false;
        if (s.dx === 0 && Math.abs(s.residualX) > 40) return false;
      }
      return true;
    });
  }

  /**
   * 초점이 f(+ 왜곡 c)라면 관측 시작점의 내용이 **어디 떨어져야 하나**.
   * 측정된 PTZ 만 쓴다 — 펌웨어 모델이 끼어들지 않는 것이 이 추정을 독립으로 만드는 지점이다.
   *
   *   ① undistort  실제 이미지 좌표 → 이상 좌표
   *   ② 광선        before 자세 기저에서
   *   ③ 재투영      after 자세 기저로
   *   ④ distort     이상 좌표 → 실제 이미지 좌표 (관측과 같은 공간으로)
   */
  predictLanding(sample: Sample, f: number, c: Coeffs = { k1: 0, k2: 0 }): { x: number; y: number } | null {
    const u = mapRadialPx(sample.fromX, sample.fromY, this.cx, this.cy, f, c, false);
    const b0 = basis(sample.ptzBefore.panpos, sample.ptzBefore.tiltpos);
    const b1 = basis(sample.ptzAfter.panpos, sample.ptzAfter.tiltpos);
    const ux = (u.x - this.cx) / f;
    const uy = -(u.y - this.cy) / f;
    const ray: Vec3 = [b0.F[0] + b0.R[0] * ux + b0.U[0] * uy, b0.F[1] + b0.R[1] * ux + b0.U[1] * uy, b0.F[2] + b0.R[2] * ux + b0.U[2] * uy];
    const t = dot3(ray, b1.F);
    if (t <= 1e-9) return null; // 카메라 뒤로 돌아갔다
    const xi = this.cx + f * (dot3(ray, b1.R) / t);
    const yi = this.cy - f * (dot3(ray, b1.U) / t);
    const d = mapRadialPx(xi, yi, this.cx, this.cy, f, c, true);
    return { x: d.x, y: d.y };
  }

  /** 예측-관측 RMS(px). 예측 불가 샘플은 제외하되, 하나도 없으면 Infinity. */
  private rmsFor(samples: readonly Sample[], f: number, c: Coeffs): number {
    let total = 0;
    let n = 0;
    for (const s of samples) {
      const p = this.predictLanding(s, f, c);
      if (!p) continue;
      total += (p.x - s.landedX) ** 2 + (p.y - s.landedY) ** 2;
      n++;
    }
    return n ? Math.sqrt(total / n) : Infinity;
  }

  /** 영상의 진짜 초점거리: 모든 착지를 설명하는 단 하나의 f (왜곡 없음 가정). */
  fitTrueFocal(samples: readonly Sample[]): { f: number; rms: number; n: number } | null {
    const usable = this.usable(samples);
    if (usable.length < 3) return null;
    const zero: Coeffs = { k1: 0, k2: 0 };
    const r = goldenSection((f) => this.rmsFor(usable, f, zero), this.focalRange[0], this.focalRange[1], this.iterations);
    return { f: r.x, rms: r.cost, n: usable.length };
  }

  /**
   * (f, k1, k2) 동시 피팅. **데이터가 허락하는 만큼만** 자유도를 준다 — 과적합 방지.
   *
   *   ≥24 대응점 → f, k1, k2
   *   ≥12        → f, k1     (k2 = 0 고정)
   *    <12       → f 만       (왜곡 없음)
   *
   * dof 를 명시하면 그 값을 강제한다(게이트 비교용 baseline 을 뽑을 때).
   */
  fitLens(samples: readonly Sample[], dof?: 1 | 2 | 3): LensFit | null {
    const usable = this.usable(samples);
    if (usable.length < 3) return null;
    const n = usable.length;
    const useDof: 1 | 2 | 3 = dof ?? (n >= 24 ? 3 : n >= 12 ? 2 : 1);

    const base = goldenSection((f) => this.rmsFor(usable, f, { k1: 0, k2: 0 }), this.focalRange[0], this.focalRange[1], this.iterations);
    if (useDof === 1) return { f: base.x, k1: 0, k2: 0, rms: base.cost, n, dof: 1 };

    const f0 = base.x;
    const x0 = useDof === 2 ? [f0, 0] : [f0, 0, 0];
    // 스텝은 파라미터 스케일에 맞춘다 — f 는 5%, k 는 0.02(전형적 배럴의 크기 정도).
    const steps = useDof === 2 ? [f0 * 0.05, 0.02] : [f0 * 0.05, 0.02, 0.02];
    const res = nelderMead(
      (x) => {
        const f = x[0]!;
        if (!(f > 0)) return Infinity;
        return this.rmsFor(usable, f, { k1: x[1]!, k2: useDof === 3 ? x[2]! : 0 });
      },
      x0,
      { steps },
    );
    const f = res.x[0]!;
    const k1 = res.x[1]!;
    const k2 = useDof === 3 ? res.x[2]! : 0;
    // 심플렉스가 baseline 보다 나쁜 곳에서 멈췄으면 baseline 을 돌려준다(퇴보 금지).
    if (!(res.cost < base.cost)) return { f: base.x, k1: 0, k2: 0, rms: base.cost, n, dof: 1 };
    return { f, k1, k2, rms: res.cost, n, dof: useDof };
  }

  /**
   * 펌웨어가 쓴 초점거리 — 텔레메트리만으로. 가로 클릭은 1/cos(tilt) 짐벌 커플링을 얹고 세로는 안 얹는다.
   * **둘이 일치한다는 사실이 "펌웨어 기하는 정확하다(그리고 어느 초점에서)"의 증명이다.**
   */
  firmwareFocal(samples: readonly Sample[]): { pan: Stat | null; tilt: Stat | null } {
    const h: number[] = [];
    const v: number[] = [];
    for (const s of samples) {
      if (s.kind !== 'click') continue;
      const cosTilt = Math.cos((s.ptzBefore.tiltpos / 100) * DEG);
      if (s.dy === 0 && s.dx && s.dpanCd && Math.sign(s.dpanCd) === Math.sign(s.dx)) {
        h.push(Math.abs(s.dx) / (Math.tan(Math.abs(s.dpanCd / 100) * DEG) * cosTilt));
      }
      if (s.dx === 0 && s.dy && s.dtiltCd && Math.sign(s.dtiltCd) === Math.sign(s.dy)) {
        v.push(Math.abs(s.dy) / Math.tan(Math.abs(s.dtiltCd / 100) * DEG));
      }
    }
    return { pan: stat(h), tilt: stat(v) };
  }

  /**
   * 카메라가 남기고 가는 클릭 편심의 비율. 중간에 모델이 없다 — 운영자가 보는 것 그 자체.
   * 중앙값이라 나쁜 매칭 하나가 흔들지 못한다.
   */
  undershootSlope(samples: readonly Sample[]): { g: number; n: number } | null {
    const gs: number[] = [];
    for (const s of samples) {
      if (s.kind !== 'click') continue;
      if (s.dx) gs.push(s.residualX / s.dx);
      if (s.dy) gs.push(s.residualY / s.dy);
    }
    if (!gs.length) return null;
    gs.sort((a, b) => a - b);
    const mid = gs.length >> 1;
    return { g: gs.length % 2 ? gs[mid]! : (gs[mid - 1]! + gs[mid]!) / 2, n: gs.length };
  }

  /** 초점거리(px) → 수평 화각(도). */
  hfovFromFocal(f: number): number {
    return (2 * Math.atan(this.cx / f)) / DEG;
  }

  /**
   * 한 줌 분량의 클릭 샘플 → 그 줌의 화각·게인.
   *
   * 게인은 f_fw/f_true 가 아니라 **잔차 기울기**에서 뽑는다. 둘 다 측정값이고 서로 일치하지만,
   * 기울기가 운영자의 체감이자 열화에 강하다(초점 피팅 하나가 실패해도 안 흔들린다).
   * gainApplied 는 **검증 패스**용: 보정을 켜고 잰 값에서 참 게인을 복원한다 — g = 1 − k_적용/k_참.
   */
  solveZoom(samples: readonly Sample[], { gainApplied = 1 }: { gainApplied?: number } = {}): ZoomPoint | null {
    const usable = this.usable(samples);
    const slope = usable.length >= this.minSamples ? this.undershootSlope(usable) : null;
    // 화각은 초점 **피팅**(착지 3개 이상)이 필요하고, 게인은 잔차 기울기만 있으면 된다. 이걸
    // 분리해 두는 게 중요하다: 검증은 "얼마나 빗나가나"만 묻는데, 샘플 하나가 나빴다고 그 답을
    // 거부하는 건 무의미한 까다로움이다.
    const trueFit = this.fitTrueFocal(samples);
    const fw = this.firmwareFocal(samples);
    if (!slope) return null;

    return {
      zoom: samples[0]!.zoomAnchor,
      hfov: trueFit ? this.hfovFromFocal(trueFit.f) : null,
      gain: slope.g < 0.9 ? gainApplied / (1 - slope.g) : null,
      focalTrue: trueFit ? trueFit.f : null,
      focalFirmware: fw.tilt?.f ?? fw.pan?.f ?? null,
      residualSlope: slope.g,
      // 1/4 프레임 클릭이 **이 패스에서** 몇 px 빗나갔나. 생성 패스는 카메라가 가진 오차,
      // 검증 패스는 보정 후 **살아남은** 오차 — 같은 숫자, 반대 의미.
      residualPx: Math.abs(slope.g) * (this.frameWidth / 4),
      fitRmsPx: trueFit ? trueFit.rms : null,
      samples: usable.length,
      of: samples.length,
    };
  }

  /**
   * 한 줌 분량의 **광류 격자** 샘플 → 그 줌의 곡면율. ★신규
   *
   * 채택 게이트(설계서 §7.3): 왜곡항이
   *   (a) 잔차를 minImprovement 이상 줄이고
   *   (b) 코너를 minCornerShiftPx 이상 밀고
   *   (c) **k1 < 0 (배럴)** 이어야
   * 채택한다. 아니면 **k1=k2=0 으로 기록**한다 — 측정을 안 한 것과 재봤더니 없었던 것은
   * 다른 사실이므로 `adopted:false` 와 사유를 함께 남긴다.
   *
   * ★ (c) 배럴 부호 게이트(설계서 §3의 1차 예측 = "광각단은 반드시 k1<0"): 광각 렌즈의 방사왜곡은
   *   배럴이다. 양의 k1(핀쿠션)이 나온다면 그것은 잔차를 지배하는 **비방사 성분**(PTZ 팬축·광학
   *   중심 오프셋에 의한 시차 등)에 옵티마이저가 마진으로 끼워맞춘 아티팩트다 — 실측에서 실제로
   *   관측됐다(154 z5129 k1=+0.17, 잔차 7→5px 마진 개선). 이런 표를 채택하면 조준을 오히려
   *   틀리게 만든다. 그래서 부호로 걸러낸다. (망원단 핀쿠션은 이 컴포넌트의 범위 밖이다.)
   */
  solveDistortionZoom(samples: readonly Sample[]): DistortionPoint | null {
    const usable = this.usable(samples);
    const zoom = samples[0]?.zoomAnchor ?? 0;
    if (usable.length < 6) return null;

    const base = this.fitLens(usable, 1);
    if (!base) return null;
    if (usable.length < 12) {
      return { z: zoom, k1: 0, k2: 0, adopted: false, reason: 'too_few_samples', rms0Px: px(base.rms), rms1Px: px(base.rms), n: usable.length };
    }

    const full = this.fitLens(usable);
    if (!full || full.dof === 1) {
      return { z: zoom, k1: 0, k2: 0, adopted: false, reason: 'not_significant', rms0Px: px(base.rms), rms1Px: px(base.rms), n: usable.length };
    }

    const improvement = base.rms > 0 ? (base.rms - full.rms) / base.rms : 0;
    const rCorner = Math.hypot(this.cx, this.cy) / full.f;
    const cornerShiftPx = Math.abs(distortRadius(rCorner, full) - rCorner) * full.f;
    // 배럴(k1<0)만 채택한다 — (c) 부호 게이트. 양의 k1 은 비방사 잔차에 낀 아티팩트로 본다.
    const adopted = improvement >= this.minImprovement && cornerShiftPx >= this.minCornerShiftPx && full.k1 < 0;

    return {
      z: zoom,
      k1: adopted ? full.k1 : 0,
      k2: adopted ? full.k2 : 0,
      adopted,
      ...(adopted ? {} : { reason: 'not_significant' as const }),
      rms0Px: px(base.rms),
      rms1Px: px(full.rms),
      n: usable.length,
    };
  }

  /**
   * 클릭 스윕 전체 → 기기에 저장할 수 있는 CameraCalibration.
   * `lensDistortion` 을 함께 주면 세 표를 모두 실은 캘리브레이션이 나온다.
   */
  build(
    samples: readonly Sample[],
    {
      gainApplied = () => 1,
      measuredAt,
      label,
      lensDistortion,
    }: { gainApplied?: (zoom: number) => number; measuredAt?: string; label?: string; lensDistortion?: DistortionPoint[] | null } = {},
  ): { calibration: CameraCalibration; points: ZoomPoint[]; skipped: SkippedZoom[] } {
    const byZoom = groupBy(samples, (s) => s.zoomAnchor);

    const points: ZoomPoint[] = [];
    const skipped: SkippedZoom[] = [];
    for (const [zoom, rows] of [...byZoom.entries()].sort((a, b) => a[0] - b[0])) {
      const p = this.solveZoom(rows, { gainApplied: gainApplied(zoom) });
      // 저장되는 곡선은 모든 앵커에서 **두 숫자 다** 있어야 한다. 기울기는 나왔지만 초점 피팅이
      // 안 된 줌은 앵커가 될 수 없다 — 화각 곡선에 구멍이 생기고 보간이 그걸 추측으로 덮는다.
      if (p && p.gain !== null && p.gain > 0 && p.hfov !== null) points.push(p);
      else skipped.push({ zoom, usable: this.usable(rows).length, of: rows.length });
    }
    if (points.length < 2) {
      throw new Error(
        `캘리브레이션에 쓸 수 있는 줌 지점이 ${points.length}개뿐입니다 — 장면에 특징이 부족하거나` +
          '(하늘·빈 아스팔트) 카메라가 정착하지 못했습니다. 차량·주차선처럼 무늬가 있는 쪽을 향하게 두고 다시 시도하세요.',
      );
    }

    const residual: ResidualReport = {
      // 아래 곡선들이 존재하기 **전에** 이 카메라가 하던 짓 — 방금 측정한 문제의 크기.
      // 보정 후 남는 값이 아니다. 그건 검증 패스만 말할 수 있고, 둘을 섞으면 캘리브레이션이
      // 스스로를 축하하게 된다.
      beforePx: round(Math.max(...points.map((p) => p.residualPx)), 1),
      fitRmsPx: round(Math.max(...points.map((p) => p.fitRmsPx ?? 0)), 1),
      byZoom: Object.fromEntries(points.map((p) => [String(p.zoom), round(p.residualPx, 1)])),
    };

    const calibration = new CameraCalibration({
      label,
      zoomHfov: points.map((p) => ({ z: p.zoom, h: Number(p.hfov!.toFixed(2)) })) as HfovPoint[],
      centeringGain: points.map((p) => ({ z: p.zoom, k: Number(p.gain!.toFixed(3)) })) as GainPoint[],
      lensDistortion: lensDistortion ?? null,
      frameWidth: this.frameWidth,
      frameHeight: this.frameHeight,
      measuredAt,
      residual,
      source: 'measured',
    });

    // 장면이 내주지 않은 줌들. 보고하되 숨기지 않는다 — 곡선은 커버리지만큼만 좋고,
    // 줌 범위의 어디가 추측인지는 운영자가 알 권리가 있다.
    return { calibration, points, skipped };
  }

  /** 광류 격자 샘플 전체 → 곡면율 표. ★신규 */
  buildDistortion(samples: readonly Sample[]): { points: DistortionPoint[]; skipped: SkippedZoom[] } {
    const byZoom = groupBy(samples, (s) => s.zoomAnchor);
    const points: DistortionPoint[] = [];
    const skipped: SkippedZoom[] = [];
    for (const [zoom, rows] of [...byZoom.entries()].sort((a, b) => a[0] - b[0])) {
      const p = this.solveDistortionZoom(rows);
      if (p) points.push(p);
      else skipped.push({ zoom, usable: this.usable(rows).length, of: rows.length });
    }
    return { points, skipped };
  }
}

// ───────────────────────────────────────────────────────────────────────────

export interface Stat {
  f: number;
  sd: number;
  n: number;
}

function stat(values: number[]): Stat | null {
  if (!values.length) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = values.length > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length) : 0;
  return { f: m, sd, n: values.length };
}

export function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const bucket = map.get(k);
    if (bucket) bucket.push(r);
    else map.set(k, [r]);
  }
  return map;
}

function round(v: number, d: number): number | null {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : null;
}

/** 픽셀 잔차 보고용 반올림 — 유한하지 않으면 필드 자체를 생략한다(0 으로 위장 금지). */
function px(v: number): number | undefined {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : undefined;
}
