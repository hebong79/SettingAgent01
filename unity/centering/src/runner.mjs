// 캘리브레이션 실행기 — 카메라를 몰아 스윕을 돌고 표를 만든다.
//
// 프레임 안을 줌마다 골고루 클릭하고, 클릭한 것이 실제로 어디 떨어지는지 보고, 거기서 이 카메라가
// 필요로 하는 두 곡선을 복원한다: 렌즈가 줌마다 실제로 보는 것(**그릴 때** 쓸 값)과 펌웨어가
// 얼마나 잘못 도는지(**조준할 때** 쓸 값).
//
// 반드시 지켜야 하는 두 가지, 그리고 둘 다 틀리기 쉽다:
//
//   1. rawAim 으로 클릭한다 — 이미 설치된 보정을 우회한다. 안 그러면 재려는 대상을 보정 너머로
//      재게 된다.
//   2. 도는 동안 카메라를 점유하고, 끝나면 **찾았던 자리에 돌려놓는다** — 실패했을 때도, 취소
//      됐을 때도. 버려진 스윕이 카메라를 하늘 쳐다보게 두면 안 된다.
//
// 검증 패스는 보정을 **켜고** 도는 같은 스윕의 축소판이다. "이 카메라가 돌리고 있는 캘리브레이션이
// 정말 이 개체에 맞나?" — N번째 카메라를 설치하고 프리셋으로 될지 알고 싶을 때 묻는 질문이다.

import { CalibrationSolver, groupBy, wrapCd } from "./solver.mjs";
import { FrameMatcher } from "./frame-match.mjs";
import { ClickCentering } from "./centering.mjs";
import { CameraCalibration } from "./calibration.mjs";

/** 방문할 줌. 렌즈가 있는 곳에 촘촘하다 — 화각이 15000~16384 에서 절반이 되므로 성글게 재면
 *  보간이 절벽을 곧장 지나간다. 마지막 둘은 광학이 더 이상 변하지 않는 지점 너머를 찔러본다 —
 *  그 포화는 실재하고, 곡선은 그것을 보여줘야 한다. */
export const FULL_ZOOMS = [0, 2000, 3000, 5129, 8000, 10338, 12161, 14000, 15000, 15400, 15800, 16100, 16384, 22000];
export const FULL_DX = [-720, -480, -240, 240, 480, 720];
export const FULL_DY = [-300, 300];

/** 검증은 예/아니오만 답하면 되므로 "아니오"를 말할 수 있는 최소한만 묻는다 — 다만 나쁜 매칭
 *  하나가 줌 전체를 데려갈 만큼 적어서는 안 된다. 장면은 군데군데 심심할 권리가 있다. */
export const VERIFY_ZOOMS = [0, 8000, 16384];
export const VERIFY_DX = [-600, -300, 300, 600];
export const VERIFY_DY = [-300, 300];

export class CalibrationRunner {
  /**
   * @param {object} options
   * @param {object} options.camera  getPtz / goPtz / setCenter / snapshotGray 를 갖춘 어댑터
   * @param {CameraCalibration|object|string|null} [options.calibration] 지금 설치된 캘리브레이션
   *        (검증 패스가 통과시킬 대상. 생성 패스는 어차피 우회하므로 무관)
   * @param {FrameMatcher} [options.matcher]
   * @param {CalibrationSolver} [options.solver]
   * @param {number} [options.frameWidth=1920]
   * @param {number} [options.frameHeight=1080]
   * @param {number} [options.speed=50]
   * @param {(p:{done,total,message,sample})=>void} [options.onProgress]
   * @param {object} [options.grid] { zooms, dx, dy } 로 스윕 격자를 덮어쓴다
   */
  constructor({
    camera, calibration = null, matcher, solver,
    frameWidth = 1920, frameHeight = 1080, speed = 50, onProgress, grid, settleOptions,
  } = {}) {
    for (const fn of ["getPtz", "goPtz", "setCenter", "snapshotGray"]) {
      if (typeof camera?.[fn] !== "function") throw new TypeError(`CalibrationRunner: camera.${fn}() 가 필요합니다.`);
    }
    this.camera = camera;
    this.calibration = calibration instanceof CameraCalibration
      ? calibration
      : CameraCalibration.from(calibration, { frameWidth, frameHeight });
    this.matcher = matcher ?? new FrameMatcher({ frameWidth, frameHeight });
    this.solver = solver ?? new CalibrationSolver({ frameWidth, frameHeight });
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
    this.speed = speed;
    this.onProgress = onProgress;
    this.grid = grid;
    this.settleOptions = settleOptions;

    // 내부 클릭은 우리가 만든 정착 로직을 쓴다 — 스윕에서는 "카메라가 멈췄나"가 측정 정확도 그 자체다.
    this.centering = new ClickCentering({
      camera: {
        getPtz: () => camera.getPtz(),
        setCenter: (p) => camera.setCenter(p),
        goPtz: (p) => camera.goPtz(p),
        waitSettle: () => this.settle(),
      },
      calibration: this.calibration,
      frameWidth, frameHeight, speed,
    });
  }

  /** 카메라가 멈출 때까지 기다린다. 연속 2회 같은 자리로 읽히면 멈춘 것으로 본다. */
  async settle(options) {
    const { timeoutMs = 12000, tolerance = 10, stable = 2, intervalMs = 120 } = options ?? this.settleOptions ?? {};
    let last = null;
    let steady = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await this.camera.getPtz();
      if (last
        && Math.abs(wrapCd(now.panpos, last.panpos)) <= tolerance
        && Math.abs(now.tiltpos - last.tiltpos) <= tolerance
        && Math.abs(now.zoompos - last.zoompos) <= tolerance) {
        if (++steady >= stable) return now;
      } else {
        steady = 0;
      }
      last = now;
      await sleep(intervalMs);
    }
    return last;
  }

  /**
   * 절대이동 + 정착. 긴 줌 이동은 서버의 정착 시한을 넘길 수 있는데, 같은 절대이동을 다시 쏘면
   * 목표에 더 가까운 곳에서 이어받는다. 정착 타임아웃만 재시도할 가치가 있다 — 범위 오류는
   * 저절로 낫지 않는다.
   */
  async gotoSettled(panpos, tiltpos, zoompos, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.camera.goPtz({
          panpos: Math.round(panpos), tiltpos: Math.round(tiltpos), zoompos: Math.round(zoompos),
          panspeed: this.speed, tiltspeed: this.speed, zoomspeed: this.speed,
        });
        return await this.settle();
      } catch (error) {
        if (i === attempts - 1) throw error;
      }
    }
    return null;
  }

  /** 샘플 하나 = 클릭 하나. */
  async measureClick({ dx, dy, zoomAnchor, anchor, rawAim }) {
    const x = this.cx + dx;
    const y = this.cy + dy;

    await this.gotoSettled(anchor.panpos, anchor.tiltpos, zoomAnchor);
    const before = await this.camera.snapshotGray();
    const ptzBefore = await this.camera.getPtz();

    const moved = await this.centering.click({ x, y, rawAim, speed: this.speed });
    const ptzAfter = moved.ptz;
    const after = await this.camera.snapshotGray();

    const sample = {
      dx, dy, clickX: x, clickY: y, zoomAnchor,
      ptzBefore, ptzAfter,
      dpanCd: wrapCd(ptzAfter.panpos, ptzBefore.panpos),
      dtiltCd: ptzAfter.tiltpos - ptzBefore.tiltpos,
    };

    try {
      const m = this.matcher.locate(before, after, { clickX: x, clickY: y });
      Object.assign(sample, m, {
        residualX: m.landedX - this.cx,
        residualY: m.landedY - this.cy,
      });
    } catch (error) {
      sample.usable = false;
      sample.reason = "error";
      sample.matchError = error.message;
    }
    return sample;
  }

  /**
   * 스윕을 돈다.
   * @param {object} [options]
   * @param {"full"|"verify"} [options.mode="full"]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} full: { calibration, samples, skipped, residual }
   *                            verify: { checks, unmeasured, worstPx, verdict, samples }
   */
  async run({ mode = "full", signal } = {}) {
    const home = await this.camera.getPtz();
    const zooms = this.grid?.zooms ?? (mode === "verify" ? VERIFY_ZOOMS : FULL_ZOOMS);
    const dxs = this.grid?.dx ?? (mode === "verify" ? VERIFY_DX : FULL_DX);
    const dys = this.grid?.dy ?? (mode === "verify" ? VERIFY_DY : FULL_DY);
    const targets = [...dxs.map((dx) => [dx, 0]), ...dys.map((dy) => [0, dy])];

    // 검증은 일부러 설치된 보정을 **통과해서** 돈다 — 그 보정이 이 카메라에 맞는지가 질문이므로
    // 보정이 루프 안에 있어야 한다.
    const rawAim = mode !== "verify";
    const gainApplied = (z) => (rawAim ? 1 : this.calibration.gainAt(z));

    const samples = [];
    const total = zooms.length * targets.length;
    try {
      for (const zoomAnchor of zooms) {
        for (const [dx, dy] of targets) {
          if (signal?.aborted) throw new Error("사용자가 중지했습니다.");
          this.onProgress?.({
            done: samples.length, total,
            message: `zoom ${zoomAnchor} · 클릭 (${dx >= 0 ? "+" : ""}${dx}, ${dy >= 0 ? "+" : ""}${dy})`,
          });
          const sample = await this.measureClick({ dx, dy, zoomAnchor, anchor: home, rawAim });
          samples.push(sample);
          this.onProgress?.({ done: samples.length, total, sample });
        }
      }
      return mode === "verify"
        ? this.#verdict(samples, zooms, gainApplied)
        : this.#tables(samples, gainApplied);
    } finally {
      // 카메라는 항상 돌려준다. 취소되거나 죽은 스윕이 20배 줌으로 하늘을 보게 두는 건
      // 이 기능이 아예 없는 것보다 나쁘다.
      try { await this.gotoSettled(home.panpos, home.tiltpos, home.zoompos, 2); } catch { /* 이미 연결 불가 */ }
    }
  }

  /** 검증만 (짧은 격자 + 보정 켬). */
  verify(options = {}) { return this.run({ ...options, mode: "verify" }); }

  #tables(samples, gainApplied) {
    const built = this.solver.build(samples, { gainApplied, measuredAt: new Date().toISOString() });
    const byZoomAll = groupBy(samples, (s) => s.zoomAnchor);
    return {
      ...built,
      // 건너뛴 줌마다 **진짜 이유**를 붙인다 — 재조준할지, 낮에 다시 올지, 보간을 받아들일지
      // 운영자가 고를 수 있어야 한다.
      skipped: built.skipped.map((s) => ({ ...s, why: explain(byZoomAll.get(s.zoom) || []) })),
      samples,
      usable: this.solver.usable(samples).length,
      of: samples.length,
    };
  }

  #verdict(samples, zooms, gainApplied) {
    const usable = groupBy(this.solver.usable(samples), (s) => s.zoomAnchor);
    const all = groupBy(samples, (s) => s.zoomAnchor);
    const checks = [];
    const unmeasured = [];
    for (const zoom of zooms) {
      const rows = usable.get(zoom) || [];
      const p = rows.length ? this.solver.solveZoom(rows, { gainApplied: gainApplied(zoom) }) : null;
      if (p) {
        checks.push({
          zoom,
          residualPx: round(p.residualPx, 1),
          gainNeeded: round(p.gain, 3),
          gainApplied: round(gainApplied(zoom), 3),
        });
      } else {
        unmeasured.push({ zoom, why: explain(all.get(zoom) || []) });
      }
    }
    const worst = checks.length ? Math.max(...checks.map((c) => c.residualPx)) : null;

    // 장면이 답해주지 못한 줌은 **합격이 아니다.** 한 프레임도 제대로 못 본 줌을 두고 "당신
    // 카메라는 z16384 에서 괜찮습니다"라고 말하는 것이 이 기능이 낼 수 있는 최악의 결과다.
    const verdict = unmeasured.length ? "incomplete"
      : worst === null ? "unknown"
        : worst <= 10 ? "pass" : "fail"; // 1/4 프레임 클릭에서 10px = 사람이 못 느끼는 경계

    return {
      checks, unmeasured, worstPx: worst, verdict,
      hint: unmeasured.length ? unmeasured.map((u) => `줌 ${u.zoom}: ${u.why}`).join(" · ") : undefined,
      calibration: this.calibration.source,
      samples,
      usable: this.solver.usable(samples).length,
      of: samples.length,
    };
  }
}

/**
 * 어떤 줌이 왜 측정되지 못했나. 운영자는 진짜 이유에만 대응할 수 있으므로 원인을 하나로 추측하지
 * 말고 증거를 보고한다 — 야간에는 같은 장면이 두 실패를 동시에 낸다(어두워서 안 보이는 곳과
 * 노이즈 리덕션이 뭉개 매끈해진 곳). 하나만 골라 말하면 문제의 절반만 쫓게 만든다.
 */
export function explain(rows) {
  const bad = rows.filter((s) => !s.usable);
  if (!bad.length) return "쓸 수 있는 샘플이 부족합니다";
  const n = (why) => bad.filter((s) => s.reason === why).length;
  const parts = [];
  if (n("dark")) parts.push(`${n("dark")}개는 너무 어둡고`);
  if (n("smooth")) parts.push(`${n("smooth")}개는 미세 디테일이 없어 위치를 특정할 수 없고`);
  if (n("featureless")) parts.push(`${n("featureless")}개는 무늬가 없고`);
  if (n("error")) parts.push(`${n("error")}개는 매칭에 실패했고`);
  const detail = parts.length ? `(${parts.join(", ").replace(/,([^,]*)$/, "$1")})` : "";
  return n("dark") + n("smooth") >= bad.length / 2
    ? `이 배율에서 화면을 읽을 수 없습니다 ${detail} — 야간·저조도면 영상이 뭉개져 고배율일수록 심합니다. 밝을 때 다시 시도하세요`
    : `이 배율에서 화면을 읽을 수 없습니다 ${detail} — 차량·주차선처럼 무늬가 있는 쪽을 향하게 두고 다시 시도하세요`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
