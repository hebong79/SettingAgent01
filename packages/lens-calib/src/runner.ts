// 캘리브레이션 실행기 — 카메라를 몰아 스윕을 돌고 표를 만든다.
//
// 반드시 지켜야 하는 두 가지, 그리고 둘 다 틀리기 쉽다:
//
//   1. **rawAim 으로 클릭한다** — 이미 설치된 보정을 우회한다. 안 그러면 재려는 대상을 보정
//      너머로 재게 된다.
//   2. 도는 동안 카메라를 점유하고, 끝나면 **찾았던 자리에 돌려놓는다** — 실패했을 때도, 취소
//      됐을 때도. 버려진 스윕이 카메라를 20배 줌으로 하늘 쳐다보게 두면 안 된다.
//
// ── 두 패스가 있고, 재는 것이 다르다 ────────────────────────────────────────
//
//   run()            클릭 스윕   → zoomHfov · centeringGain      (참조본 계승, 손대지 않음)
//   runDistortion()  광류 격자   → lensDistortion (k1, k2)        ★신규
//
// **왜 곡면율만 방식이 다른가**: 클릭 스윕의 신호는 "클릭한 것이 중앙에서 몇 px 남았나"인데
// 착지는 언제나 화면 중앙 근처다. 그런데 왜곡은 가장자리에서만 크다 — 클릭 스윕은 왜곡이 가장
// 잘 보이는 곳을 관측에서 빼고 있다. 대신 한 번 회전시키고 프레임 전체 격자를 추적하면
// 회전 1회에 대응점 15개가 나오고, 코너까지 관측에 들어온다.

import { CameraCalibration } from './calibration.js';
import { ClickCentering } from './centering.js';
import { FrameMatcher } from './frameMatch.js';
import { PtzGeometry } from './geometry.js';
import { CalibrationSolver, groupBy, type SkippedZoom } from './solver.js';
import { decideAb, decideVerdict, explain, type AbReport, type AbZoomResult, type VerifyReport, type ZoomCheck } from './verify.js';
import type { CalibrationSpec, DistortionPoint, GainPoint, GrayFrame, HucomsCameraPort, Ptz, Sample, SweepProgress } from './types.js';
import { wrapCd } from './geometry.js';

/**
 * 방문할 줌. 렌즈가 있는 곳에 촘촘하다 — 화각이 15000~16384 에서 절반이 되므로 성글게 재면
 * 보간이 절벽을 곧장 지나간다. 마지막 둘은 광학이 더 이상 변하지 않는 지점 **너머**를 찔러본다.
 */
export const FULL_ZOOMS = [0, 2000, 3000, 5129, 8000, 10338, 12161, 14000, 15000, 15400, 15800, 16100, 16384, 22000];
export const FULL_DX = [-720, -480, -240, 240, 480, 720];
export const FULL_DY = [-300, 300];

/** 검증은 예/아니오만 답하면 되므로 "아니오"를 말할 수 있는 최소한만 묻는다. */
export const VERIFY_ZOOMS = [0, 8000, 16384];
export const VERIFY_DX = [-600, -300, 300, 600];
export const VERIFY_DY = [-300, 300];

/**
 * 곡면율 스윕의 줌. **와이드 위주**다 — 방사왜곡은 화각이 넓을수록 크고, 망원에서는 프레임이
 * 담는 각도 자체가 작아 3승 항이 사실상 0 이 된다. 망원 앵커 하나(12161)는 "정말 0 인가"를
 * 확인하는 대조군이다(게이트가 adopted:false 를 내야 정상).
 */
export const DISTORTION_ZOOMS = [0, 2000, 3000, 5129, 8000, 12161];

/** 격자 크기(열 × 행). 5×3 = 회전 1회당 대응점 15개. */
export const DISTORTION_GRID = { cols: 5, rows: 3 } as const;

/** 회전량 = 프레임 폭/높이의 이 비율만큼 영상을 민다. 너무 크면 격자점이 프레임 밖으로 나간다. */
export const DISTORTION_SHIFT_RATIO = 0.25;

export interface RunnerOptions {
  camera: HucomsCameraPort;
  /** 지금 설치된 캘리브레이션 — 검증 패스가 통과시킬 대상. 생성 패스는 어차피 우회한다. */
  calibration?: CameraCalibration | CalibrationSpec | GainPoint[] | string | null;
  matcher?: FrameMatcher;
  solver?: CalibrationSolver;
  frameWidth?: number;
  frameHeight?: number;
  speed?: number;
  onProgress?: (p: SweepProgress) => void;
  /** 클릭 스윕 격자를 덮어쓴다. */
  grid?: { zooms?: number[]; dx?: number[]; dy?: number[] };
  settleOptions?: SettleOptions;
  /** 테스트에서 실시간 대기를 없애기 위한 주입구. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SettleOptions {
  timeoutMs?: number;
  tolerance?: number;
  stable?: number;
  intervalMs?: number;
}

export interface FullRunResult {
  calibration: CameraCalibration;
  points: ReturnType<CalibrationSolver['solveZoom']>[];
  skipped: SkippedZoom[];
  samples: Sample[];
  usable: number;
  of: number;
}

export interface DistortionRunResult {
  points: DistortionPoint[];
  skipped: SkippedZoom[];
  samples: Sample[];
  usable: number;
  of: number;
}

export class CalibrationRunner {
  readonly camera: HucomsCameraPort;
  readonly calibration: CameraCalibration;
  readonly matcher: FrameMatcher;
  readonly solver: CalibrationSolver;
  readonly geometry: PtzGeometry;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly cx: number;
  readonly cy: number;
  readonly speed: number;
  readonly onProgress?: (p: SweepProgress) => void;
  private readonly grid?: RunnerOptions['grid'];
  private readonly settleOptions?: SettleOptions;
  private readonly centering: ClickCentering;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({ camera, calibration = null, matcher, solver, frameWidth = 1920, frameHeight = 1080, speed = 50, onProgress, grid, settleOptions, sleep }: RunnerOptions) {
    for (const fn of ['getPtz', 'goPtz', 'setCenter', 'snapshotGray'] as const) {
      if (typeof camera?.[fn] !== 'function') throw new TypeError(`CalibrationRunner: camera.${fn}() 가 필요합니다.`);
    }
    this.camera = camera;
    this.calibration = calibration instanceof CameraCalibration ? calibration : CameraCalibration.from(calibration, { frameWidth, frameHeight });
    this.matcher = matcher ?? new FrameMatcher({ frameWidth, frameHeight });
    this.solver = solver ?? new CalibrationSolver({ frameWidth, frameHeight });
    this.geometry = new PtzGeometry({ calibration: this.calibration, frameWidth, frameHeight });
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
    this.speed = speed;
    this.onProgress = onProgress;
    this.grid = grid;
    this.settleOptions = settleOptions;
    this.sleep = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    // 내부 클릭은 우리가 만든 정착 로직을 쓴다 — 스윕에서는 "카메라가 멈췄나"가 측정 정확도 그 자체다.
    this.centering = new ClickCentering({
      camera: {
        getPtz: () => camera.getPtz(),
        setCenter: (p) => camera.setCenter!(p),
        goPtz: (p) => camera.goPtz!(p),
        waitSettle: () => this.settle(),
      },
      calibration: this.calibration,
      frameWidth,
      frameHeight,
      speed,
    });
  }

  /** 카메라가 멈출 때까지 기다린다. 연속 N회 같은 자리로 읽히면 멈춘 것으로 본다. */
  async settle(options?: SettleOptions): Promise<Ptz> {
    const { timeoutMs = 15000, tolerance = 10, stable = 2, intervalMs = 120 } = options ?? this.settleOptions ?? {};
    let last: Ptz | null = null;
    let steady = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await this.camera.getPtz();
      if (
        last &&
        Math.abs(wrapCd(now.panpos, last.panpos)) <= tolerance &&
        Math.abs(now.tiltpos - last.tiltpos) <= tolerance &&
        Math.abs(now.zoompos - last.zoompos) <= tolerance
      ) {
        if (++steady >= stable) return now;
      } else {
        steady = 0;
      }
      last = now;
      await this.sleep(intervalMs);
    }
    return last ?? (await this.camera.getPtz());
  }

  /**
   * 절대이동 + 정착. 긴 줌 이동은 정착 시한을 넘길 수 있는데, 같은 절대이동을 다시 쏘면 목표에
   * 더 가까운 곳에서 이어받는다. **정착 타임아웃만** 재시도할 가치가 있다 — 범위 오류는 저절로 낫지 않는다.
   */
  async gotoSettled(panpos: number, tiltpos: number, zoompos: number, attempts = 4): Promise<Ptz> {
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.camera.goPtz!({
          panpos: Math.round(panpos),
          tiltpos: Math.round(tiltpos),
          zoompos: Math.round(zoompos),
          speed: this.speed,
        });
        return await this.settle();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('gotoSettled 실패');
  }

  // ── 클릭 스윕 (화각·게인) ─────────────────────────────────────────────────

  /** 샘플 하나 = 클릭 하나. */
  async measureClick({ dx, dy, zoomAnchor, anchor, rawAim }: { dx: number; dy: number; zoomAnchor: number; anchor: Ptz; rawAim: boolean }): Promise<Sample> {
    const x = this.cx + dx;
    const y = this.cy + dy;

    await this.gotoSettled(anchor.panpos, anchor.tiltpos, zoomAnchor);
    const before = await this.camera.snapshotGray!();
    const ptzBefore = await this.camera.getPtz();

    const moved = await this.centering.click({ x, y, rawAim, speed: this.speed });
    const ptzAfter = moved.ptz;
    const after = await this.camera.snapshotGray!();

    const sample: Sample = {
      kind: 'click',
      dx,
      dy,
      fromX: x,
      fromY: y,
      zoomAnchor,
      ptzBefore,
      ptzAfter,
      dpanCd: wrapCd(ptzAfter.panpos, ptzBefore.panpos),
      dtiltCd: ptzAfter.tiltpos - ptzBefore.tiltpos,
      landedX: NaN,
      landedY: NaN,
      residualX: NaN,
      residualY: NaN,
    };

    this.applyMatch(sample, before, after, { atX: this.cx, atY: this.cy });
    return sample;
  }

  /**
   * 클릭 스윕을 돈다.
   * full   : 보정을 **우회**(rawAim)하고 전 구간 — 카메라가 가진 오차를 잰다
   * verify : 보정을 **켜고** 짧은 격자 — "이 보정이 이 개체에 맞나"가 질문이므로 루프 안에 있어야 한다
   */
  async run({ mode = 'full', signal }: { mode?: 'full' | 'verify'; signal?: AbortSignal } = {}): Promise<FullRunResult | VerifyReport> {
    const home = await this.camera.getPtz();
    const zooms = this.grid?.zooms ?? (mode === 'verify' ? VERIFY_ZOOMS : FULL_ZOOMS);
    const dxs = this.grid?.dx ?? (mode === 'verify' ? VERIFY_DX : FULL_DX);
    const dys = this.grid?.dy ?? (mode === 'verify' ? VERIFY_DY : FULL_DY);
    const targets: Array<[number, number]> = [...dxs.map((dx): [number, number] => [dx, 0]), ...dys.map((dy): [number, number] => [0, dy])];

    const rawAim = mode !== 'verify';
    const gainApplied = (z: number): number => (rawAim ? 1 : this.calibration.gainAt(z));

    const samples: Sample[] = [];
    const total = zooms.length * targets.length;
    try {
      for (const zoomAnchor of zooms) {
        for (const [dx, dy] of targets) {
          if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
          this.onProgress?.({ done: samples.length, total, message: `zoom ${zoomAnchor} · 클릭 (${sign(dx)}, ${sign(dy)})` });
          const sample = await this.measureClick({ dx, dy, zoomAnchor, anchor: home, rawAim });
          samples.push(sample);
          this.onProgress?.({ done: samples.length, total, sample });
        }
      }
      return mode === 'verify' ? this.verdict(samples, zooms, gainApplied) : this.tables(samples, gainApplied);
    } finally {
      await this.goHome(home);
    }
  }

  /** 검증만 (짧은 격자 + 보정 켬). */
  verify(options: { signal?: AbortSignal } = {}): Promise<VerifyReport> {
    return this.run({ ...options, mode: 'verify' }) as Promise<VerifyReport>;
  }

  // ── 광류 격자 스윕 (곡면율) ★신규 ────────────────────────────────────────

  /**
   * 곡면율 측정. 줌마다 네 번 회전(±pan, ±tilt)하고 매 회전마다 격자 전체를 추적한다.
   *
   * ★ 여기서는 `setCenter` 를 **쓰지 않는다.** 우리가 재려는 것은 펌웨어의 조준이 아니라 **렌즈의
   *   기하**이고, 그 둘을 한 측정에 섞으면 어느 쪽 오차인지 분리할 수 없다. 순수 회전(goptzfpos)만
   *   쓰면 텔레메트리가 회전량을 정확히 알려주므로 남는 미지수는 렌즈뿐이다.
   */
  async runDistortion({ zooms = DISTORTION_ZOOMS, signal }: { zooms?: number[]; signal?: AbortSignal } = {}): Promise<DistortionRunResult> {
    const home = await this.camera.getPtz();
    const samples: Sample[] = [];
    const rotations: Array<'pan+' | 'pan-' | 'tilt+' | 'tilt-'> = ['pan+', 'pan-', 'tilt+', 'tilt-'];
    const total = zooms.length * rotations.length;
    let done = 0;

    try {
      for (const zoomAnchor of zooms) {
        for (const rot of rotations) {
          if (signal?.aborted) throw new Error('사용자가 중지했습니다.');
          this.onProgress?.({ done, total, message: `zoom ${zoomAnchor} · 회전 ${rot}` });

          const before = await this.gotoSettled(home.panpos, home.tiltpos, zoomAnchor);
          const frameA = await this.camera.snapshotGray!();

          const delta = this.rotationFor(zoomAnchor, before.tiltpos, rot);
          const after = await this.gotoSettled(before.panpos + delta.panDelta, before.tiltpos + delta.tiltDelta, zoomAnchor);
          const frameB = await this.camera.snapshotGray!();

          // ★ 매칭 파라미터(half)는 **실제 이미지 픽셀** 기준이고 격자는 **논리 좌표**다.
          //   실제 이미지가 논리 프레임보다 작으면(시뮬·목 카메라) 그 비율만큼 여백을 키워야
          //   패치가 프레임을 넘지 않는다. 첫 프레임을 받은 뒤에야 알 수 있으므로 여기서 계산한다.
          const margin = (this.matcher.half + 8) * (this.frameWidth / frameA.width);

          for (const g of this.gridPoints({ margin })) {
            const stub = this.flowStub(g, zoomAnchor, before, after);
            const predicted = this.solver.predictLanding(stub, this.calibration.focalAt(zoomAnchor));
            // 예측이 프레임 밖이면 그 격자점은 이 회전에서 사라졌다 — 반대 방향 회전이 담당한다.
            if (!predicted || !this.inFrame(predicted.x, predicted.y, margin)) continue;
            this.applyMatch(stub, frameA, frameB, { atX: predicted.x, atY: predicted.y });
            samples.push(stub);
            this.onProgress?.({ done, total, sample: stub });
          }
          done++;
          this.onProgress?.({ done, total });
        }
      }
    } finally {
      await this.goHome(home);
    }

    const built = this.solver.buildDistortion(samples);
    const byZoomAll = groupBy(samples, (s) => s.zoomAnchor);
    return {
      points: built.points,
      skipped: built.skipped.map((s) => ({ ...s, why: explain(byZoomAll.get(s.zoom) ?? []) })),
      samples,
      usable: this.solver.usable(samples).length,
      of: samples.length,
    };
  }

  /**
   * 곡면율 A/B 검증 — 같은 대응점을 곡면율 **켜고/끄고** 각각 예측해 잔차를 비교한다.
   *
   * 카메라를 새로 돌리지 않아도 되는 이유: A/B 의 질문은 "이 표가 이 렌즈의 기하를 더 잘
   * 설명하는가"이고, 그건 **이미 측정된 대응점**만으로 답할 수 있다. 새 스윕은 새 노이즈만 더한다.
   * (조준 잔차의 A/B 는 클릭 스윕 verify() 가 담당한다 — 그건 카메라를 돌려야 한다.)
   */
  verifyDistortion(samples: readonly Sample[], points: readonly DistortionPoint[], options?: { tolerancePx?: number; tiePx?: number }): AbReport {
    const table = new Map(points.map((p) => [p.z, p]));
    const byZoom = groupBy(samples, (s) => s.zoomAnchor);
    const perZoom: AbZoomResult[] = [];
    const unmeasured: Array<{ zoom: number; why: string }> = [];

    for (const [zoom, rows] of [...byZoom.entries()].sort((a, b) => a[0] - b[0])) {
      const usable = this.solver.usable(rows);
      const point = table.get(zoom);
      if (!point || usable.length < 6) {
        unmeasured.push({ zoom, why: explain(rows) });
        continue;
      }
      // OFF/ON 모두 **그 조건에서 최적인 f** 로 재야 공정하다. 같은 f 를 강요하면 왜곡항이
      // f 오차까지 떠안게 되어 ON 이 부당하게 유리해진다.
      const off = this.solver.fitLens(usable, 1);
      const on = this.fitWithFixedCoeffs(usable, point);
      if (!off || !on) {
        unmeasured.push({ zoom, why: explain(rows) });
        continue;
      }
      perZoom.push({
        zoom,
        rmsOffPx: Number(off.rms.toFixed(2)),
        rmsOnPx: Number(on.toFixed(2)),
        improvedPct: off.rms > 0 ? Number((((off.rms - on) / off.rms) * 100).toFixed(1)) : 0,
        n: usable.length,
      });
    }
    return decideAb(perZoom, unmeasured, options);
  }

  // ── 내부 ──────────────────────────────────────────────────────────────────

  /** 계수를 고정한 채 f 만 다시 최적화했을 때의 잔차. A/B 의 ON 쪽. */
  private fitWithFixedCoeffs(samples: readonly Sample[], c: { k1: number; k2?: number }): number | null {
    const coeffs = { k1: c.k1, k2: c.k2 ?? 0 };
    const fit = this.solver.fitLens(samples, 1);
    if (!fit) return null;
    if (!coeffs.k1 && !coeffs.k2) return fit.rms;
    // f 를 baseline 주변에서 다시 훑는다(왜곡이 켜지면 최적 f 가 살짝 움직인다).
    let best = Infinity;
    for (let i = -20; i <= 20; i++) {
      const f = fit.f * (1 + i * 0.005);
      let total = 0;
      let n = 0;
      for (const s of samples) {
        const p = this.solver.predictLanding(s, f, coeffs);
        if (!p) continue;
        total += (p.x - s.landedX) ** 2 + (p.y - s.landedY) ** 2;
        n++;
      }
      if (n) best = Math.min(best, Math.sqrt(total / n));
    }
    return Number.isFinite(best) ? best : null;
  }

  /** 매칭을 시도하고 결과를 샘플에 실는다. 실패는 예외로 터뜨리지 않고 사유와 함께 기록한다. */
  private applyMatch(sample: Sample, before: GrayFrame, after: GrayFrame, at: { atX: number; atY: number }): void {
    try {
      const m = this.matcher.locate(before, after, { fromX: sample.fromX, fromY: sample.fromY, ...at });
      sample.landedX = m.landedX;
      sample.landedY = m.landedY;
      sample.peak = m.peak;
      sample.margin = m.margin;
      sample.contrast = m.contrast;
      sample.usable = m.usable;
      if (m.reason) sample.reason = m.reason;
      sample.residualX = m.landedX - this.cx;
      sample.residualY = m.landedY - this.cy;
    } catch (error) {
      sample.usable = false;
      sample.reason = 'error';
      sample.matchError = error instanceof Error ? error.message : String(error);
    }
  }

  /** 이 회전이 영상을 프레임의 DISTORTION_SHIFT_RATIO 만큼 밀도록 하는 PTZ 델타. */
  private rotationFor(zoom: number, tiltCd: number, rot: 'pan+' | 'pan-' | 'tilt+' | 'tilt-'): { panDelta: number; tiltDelta: number } {
    const horizontal = rot === 'pan+' || rot === 'pan-';
    const sign = rot === 'pan+' || rot === 'tilt+' ? 1 : -1;
    const shiftX = horizontal ? this.frameWidth * DISTORTION_SHIFT_RATIO : 0;
    const shiftY = horizontal ? 0 : this.frameHeight * DISTORTION_SHIFT_RATIO;
    // 그 지점을 중앙으로 보내는 회전 = 영상을 그만큼 미는 회전. 왜곡을 재는 중이므로 undistort 는 끈다.
    const d = this.geometry.pixelToDelta({ x: this.cx + shiftX, y: this.cy + shiftY, zoom, tiltCd, undistort: false });
    return horizontal ? { panDelta: sign * d.panDelta, tiltDelta: 0 } : { panDelta: 0, tiltDelta: sign * d.tiltDelta };
  }

  /** 프레임에 고르게 퍼진 격자점. 패치 반폭만큼 가장자리에서 물러난다. */
  gridPoints({ cols = DISTORTION_GRID.cols, rows = DISTORTION_GRID.rows, margin = this.matcher.half + 8 }: { cols?: number; rows?: number; margin?: number } = {}): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({
          x: margin + ((this.frameWidth - 2 * margin) * c) / (cols - 1),
          y: margin + ((this.frameHeight - 2 * margin) * r) / (rows - 1),
        });
      }
    }
    return out;
  }

  private flowStub(g: { x: number; y: number }, zoomAnchor: number, before: Ptz, after: Ptz): Sample {
    return {
      kind: 'flow',
      zoomAnchor,
      fromX: g.x,
      fromY: g.y,
      dx: 0,
      dy: 0,
      ptzBefore: before,
      ptzAfter: after,
      dpanCd: wrapCd(after.panpos, before.panpos),
      dtiltCd: after.tiltpos - before.tiltpos,
      landedX: NaN,
      landedY: NaN,
      residualX: NaN,
      residualY: NaN,
    };
  }

  private inFrame(x: number, y: number, margin: number): boolean {
    return x >= margin && x <= this.frameWidth - margin && y >= margin && y <= this.frameHeight - margin;
  }

  /**
   * 카메라는 항상 돌려준다. 취소되거나 죽은 스윕이 카메라를 엉뚱한 데 두는 것은
   * 이 기능이 아예 없는 것보다 나쁘다.
   */
  private async goHome(home: Ptz): Promise<void> {
    try {
      await this.gotoSettled(home.panpos, home.tiltpos, home.zoompos, 2);
    } catch {
      /* 이미 연결 불가 — 더 할 수 있는 것이 없다 */
    }
  }

  private tables(samples: Sample[], gainApplied: (z: number) => number): FullRunResult {
    const built = this.solver.build(samples, { gainApplied, measuredAt: new Date().toISOString() });
    const byZoomAll = groupBy(samples, (s) => s.zoomAnchor);
    return {
      calibration: built.calibration,
      points: built.points,
      // 건너뛴 줌마다 **진짜 이유**를 붙인다 — 재조준할지, 낮에 다시 올지, 보간을 받아들일지
      // 운영자가 고를 수 있어야 한다.
      skipped: built.skipped.map((s) => ({ ...s, why: explain(byZoomAll.get(s.zoom) ?? []) })),
      samples,
      usable: this.solver.usable(samples).length,
      of: samples.length,
    };
  }

  private verdict(samples: Sample[], zooms: number[], gainApplied: (z: number) => number): VerifyReport {
    const usable = groupBy(this.solver.usable(samples), (s) => s.zoomAnchor);
    const all = groupBy(samples, (s) => s.zoomAnchor);
    const checks: ZoomCheck[] = [];
    const unmeasured: Array<{ zoom: number; why: string }> = [];
    for (const zoom of zooms) {
      const rows = usable.get(zoom) ?? [];
      const p = rows.length ? this.solver.solveZoom(rows, { gainApplied: gainApplied(zoom) }) : null;
      if (p) {
        checks.push({
          zoom,
          residualPx: round(p.residualPx, 1),
          gainNeeded: p.gain === null ? null : round(p.gain, 3),
          gainApplied: round(gainApplied(zoom), 3),
        });
      } else {
        unmeasured.push({ zoom, why: explain(all.get(zoom) ?? []) });
      }
    }
    const { verdict, worstPx } = decideVerdict(checks, unmeasured.length);
    return {
      checks,
      unmeasured,
      worstPx,
      verdict,
      hint: unmeasured.length ? unmeasured.map((u) => `줌 ${u.zoom}: ${u.why}`).join(' · ') : undefined,
      calibration: this.calibration.source,
      usable: this.solver.usable(samples).length,
      of: samples.length,
    };
  }
}

export { explain };

function sign(v: number): string {
  return `${v >= 0 ? '+' : ''}${v}`;
}

function round(v: number, d: number): number | null {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : null;
}
