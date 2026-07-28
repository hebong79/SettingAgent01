// 캘리브레이션 솔버 — 클릭 스윕 샘플 → 이 카메라의 두 곡선.
//
// 샘플 하나 = 클릭 한 번: 카메라를 세우고 스냅샷, 중심에서 벗어난 픽셀을 클릭, 다시 스냅샷,
// 그리고 클릭한 내용이 **실제로** 어디 떨어졌는지 찾는다. 거기서 초점거리 두 개를 서로 완전히
// 독립인 경로로 뽑는다:
//
//   f_fw   — 펌웨어가 **믿는** 초점거리. 텔레메트리(그것이 고른 팬/틸트)에서 바로 읽는다.
//            영상이 전혀 필요 없다. 세로 클릭은 깨끗하게 주고, 가로 클릭은 짐벌 커플링을 얹어 준다.
//   f_true — **영상**의 실제 초점거리. 펌웨어 모델을 전혀 쓰지 않는다: 측정된 before/after PTZ 와
//            측정된 착지 픽셀만으로, 그 3D 회전이 그 픽셀 이동을 설명하게 만드는 단 하나의 f 를 푼다.
//
// 조준 오차는 그래서 미스터리가 아니라 비율이다. 카메라는 정확히 f_fw/f_true 만큼 덜 돈다.
// 그 비율이 곧 처방이고(클릭 편심을 미리 그만큼 밀면 된다), f_true 는 우리가 **그릴 때** 쓸 곡선이다.

import { basis, wrapCd } from "./geometry.mjs";
import { CameraCalibration } from "./calibration.mjs";

const DEG = Math.PI / 180;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * @typedef {object} Sample  한 번의 클릭이 남기는 기록
 * @property {number} zoomAnchor  이 클릭을 한 줌
 * @property {number} dx          클릭한 가로 편심(중심 기준 px). 세로 클릭이면 0
 * @property {number} dy          클릭한 세로 편심(px). 가로 클릭이면 0
 * @property {number} clickX      실제 클릭 좌표
 * @property {number} clickY
 * @property {{panpos,tiltpos,zoompos}} ptzBefore
 * @property {{panpos,tiltpos,zoompos}} ptzAfter
 * @property {number} dpanCd      ptzAfter-ptzBefore (감김 처리된 centidegree)
 * @property {number} dtiltCd
 * @property {number} landedX     클릭한 내용이 실제로 떨어진 곳 (FrameMatcher)
 * @property {number} landedY
 * @property {number} residualX   landedX - 중심 = "덜 온 만큼"
 * @property {number} residualY
 * @property {number} [peak]      매칭 신뢰도
 * @property {number} [margin]
 * @property {boolean} [usable]
 */

export class CalibrationSolver {
  /**
   * @param {object} [options]
   * @param {number} [options.frameWidth=1920]
   * @param {number} [options.frameHeight=1080]
   * @param {number} [options.minPeak=0.6]      장면이 우리를 배신한 경계(하늘·빈 아스팔트)
   * @param {number} [options.minMargin=0.02]   같은 무늬의 다른 반복을 가리키는 경계
   * @param {number} [options.minSamples=2]     한 줌에서 기울기를 내는 데 필요한 최소 샘플
   * @param {[number,number]} [options.focalRange=[400,400000]] 초점 탐색 구간(px)
   * @param {number} [options.iterations=220]   황금분할 반복 횟수
   */
  constructor({
    frameWidth = 1920, frameHeight = 1080,
    minPeak = 0.6, minMargin = 0.02, minSamples = 2,
    focalRange = [400, 400000], iterations = 220,
  } = {}) {
    Object.assign(this, { frameWidth, frameHeight, minPeak, minMargin, minSamples, focalRange, iterations });
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
  }

  /**
   * 샘플이 거짓말하는 두 가지 방식을 걸러낸다: 약한 템플릿 매칭, 그리고 요청한 이동과 어긋나는
   * PTZ 회신(정착 전에 읽음). 가로 중심선 클릭이 영상을 세로로 던지면 안 되고 그 반대도 마찬가지 —
   * 큰 교차축 잔차는 매처가 엉뚱한 걸 물었다는 뜻이다.
   */
  usable(samples) {
    return samples.filter((s) => {
      if (!Number.isFinite(s.landedX) || !(s.peak >= this.minPeak)) return false;
      // margin 은 모호성 검사가 생기기 전 스윕에는 없다 — 그런 샘플도 쓰되, 보증이 약할 뿐이다.
      if (s.margin !== undefined && !(s.margin >= this.minMargin)) return false;
      if (s.dx && Math.sign(s.dpanCd || s.dx) !== Math.sign(s.dx)) return false;
      if (s.dy && Math.sign(s.dtiltCd || s.dy) !== Math.sign(s.dy)) return false;
      if (s.dy === 0 && Math.abs(s.residualY) > 40) return false;
      if (s.dx === 0 && Math.abs(s.residualX) > 40) return false;
      return true;
    });
  }

  /**
   * 초점이 f 라면 클릭한 내용이 **어디 떨어져야 하나**. 측정된 PTZ 만 쓴다 —
   * 펌웨어 모델이 끼어들지 않는 것이 f_true 를 독립 추정으로 만드는 지점이다.
   */
  predictLanding(sample, f) {
    const b0 = basis(sample.ptzBefore.panpos, sample.ptzBefore.tiltpos);
    const b1 = basis(sample.ptzAfter.panpos, sample.ptzAfter.tiltpos);
    const ux = (sample.clickX - this.cx) / f;
    const uy = -(sample.clickY - this.cy) / f;
    const ray = [0, 1, 2].map((i) => b0.F[i] + b0.R[i] * ux + b0.U[i] * uy);
    const t = dot3(ray, b1.F);
    if (t <= 1e-9) return null; // 카메라 뒤로 돌아갔다
    return { x: this.cx + f * (dot3(ray, b1.R) / t), y: this.cy - f * (dot3(ray, b1.U) / t) };
  }

  /** 영상의 진짜 초점거리: 모든 착지를 설명하는 단 하나의 f. */
  fitTrueFocal(samples) {
    const usable = this.usable(samples);
    if (usable.length < 3) return null;
    const cost = (f) => {
      let total = 0;
      let n = 0;
      for (const s of usable) {
        const p = this.predictLanding(s, f);
        if (!p) continue;
        total += (p.x - s.landedX) ** 2 + (p.y - s.landedY) ** 2;
        n++;
      }
      return n ? Math.sqrt(total / n) : Infinity;
    };
    return { ...goldenSection(cost, this.focalRange[0], this.focalRange[1], this.iterations), n: usable.length };
  }

  /**
   * 펌웨어가 쓴 초점거리 — 텔레메트리만으로. 가로 클릭은 1/cos(tilt) 짐벌 커플링을 얹고 세로는 안 얹는다.
   * **둘이 일치한다는 사실이 "펌웨어 기하는 정확하다(그리고 어느 초점에서)"의 증명이다.**
   */
  firmwareFocal(samples) {
    const h = [];
    const v = [];
    for (const s of samples) {
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
  undershootSlope(samples) {
    const gs = [];
    for (const s of samples) {
      if (s.dx) gs.push(s.residualX / s.dx);
      if (s.dy) gs.push(s.residualY / s.dy);
    }
    if (!gs.length) return null;
    gs.sort((a, b) => a - b);
    const mid = gs.length >> 1;
    return { g: gs.length % 2 ? gs[mid] : (gs[mid - 1] + gs[mid]) / 2, n: gs.length };
  }

  /** 초점거리(px) → 수평 화각(도). */
  hfovFromFocal(f) { return (2 * Math.atan(this.cx / f)) / DEG; }

  /**
   * 한 줌 분량의 샘플 → 그 줌의 캘리브레이션 점.
   *
   * 게인은 f_fw/f_true 가 아니라 **잔차 기울기**에서 뽑는다. 둘 다 측정값이고 서로 일치하지만,
   * 기울기가 운영자의 체감이자 열화에 강하다(초점 피팅 하나가 실패해도 안 흔들린다).
   * gainApplied 는 **검증 패스**용: 보정을 켜고 잰 값에서 참 게인을 복원한다 — g = 1 - k_적용/k_참.
   */
  solveZoom(samples, { gainApplied = 1 } = {}) {
    const usable = this.usable(samples);
    const slope = usable.length >= this.minSamples ? this.undershootSlope(usable) : null;
    // 화각은 초점 **피팅**(착지 3개 이상)이 필요하고, 게인은 잔차 기울기만 있으면 된다. 이걸
    // 분리해 두는 게 중요하다: 검증은 "얼마나 빗나가나"만 묻는데, 샘플 하나가 나빴다고 그 답을
    // 거부하는 건 무의미한 까다로움이다.
    const trueFit = this.fitTrueFocal(samples);
    const fw = this.firmwareFocal(samples);
    if (!slope) return null;

    return {
      zoom: samples[0].zoomAnchor,
      hfov: trueFit ? this.hfovFromFocal(trueFit.f) : null, // 그릴 때 쓸 값 (피팅 필요)
      gain: slope.g < 0.9 ? gainApplied / (1 - slope.g) : null, // 조준할 때 쓸 값 (기울기면 충분)
      focalTrue: trueFit ? trueFit.f : null,
      focalFirmware: fw.tilt?.f ?? fw.pan?.f ?? null,
      residualSlope: slope.g,
      // 1/4 프레임 클릭이 **이 패스에서** 몇 px 빗나갔나. 패스가 무엇이었는지와 함께 읽어야 한다:
      // 생성 패스는 무보정으로 조준하므로 이건 카메라가 가진 오차, 검증 패스는 보정을 통과해
      // 조준하므로 이건 보정 후 **살아남은** 오차다. 같은 숫자, 반대 의미 — 검증이 별도 패스인 이유.
      residualPx: Math.abs(slope.g) * (this.frameWidth / 4),
      // 단일 초점이 모든 착지를 얼마나 잘 설명하나 = 곡선 자체의 오차 막대.
      fitRmsPx: trueFit ? trueFit.rms : null,
      samples: usable.length,
      of: samples.length,
    };
  }

  /**
   * 스윕 전체 → 기기에 저장할 수 있는 CameraCalibration.
   * @param {Sample[]} samples
   * @param {object} [options]
   * @param {(zoom:number)=>number} [options.gainApplied] 그 줌에서 이미 적용 중이던 게인 (검증 패스용)
   * @param {string} [options.measuredAt] ISO 시각
   * @returns {{calibration: CameraCalibration, points: object[], skipped: object[]}}
   */
  build(samples, { gainApplied = () => 1, measuredAt, label } = {}) {
    const byZoom = groupBy(samples, (s) => s.zoomAnchor);

    const points = [];
    const skipped = [];
    for (const [zoom, rows] of [...byZoom.entries()].sort((a, b) => a[0] - b[0])) {
      const p = this.solveZoom(rows, { gainApplied: gainApplied(zoom) });
      // 저장되는 곡선은 모든 앵커에서 **두 숫자 다** 있어야 한다. 기울기는 나왔지만 초점 피팅이
      // 안 된 줌은 앵커가 될 수 없다 — 화각 곡선에 구멍이 생기고 보간이 그걸 추측으로 덮는다.
      if (p && p.gain > 0 && p.hfov) points.push(p);
      else skipped.push({ zoom, usable: this.usable(rows).length, of: rows.length });
    }
    if (points.length < 2) {
      throw new Error(
        `캘리브레이션에 쓸 수 있는 줌 지점이 ${points.length}개뿐입니다 — 장면에 특징이 부족하거나`
        + "(하늘·빈 아스팔트) 카메라가 정착하지 못했습니다. 차량·주차선처럼 무늬가 있는 쪽을 향하게 두고 다시 시도하세요.",
      );
    }

    const calibration = new CameraCalibration({
      label,
      zoomHfov: points.map((p) => ({ z: p.zoom, h: Number(p.hfov.toFixed(2)) })),
      centeringGain: points.map((p) => ({ z: p.zoom, k: Number(p.gain.toFixed(3)) })),
      frameWidth: this.frameWidth,
      frameHeight: this.frameHeight,
      measuredAt,
      residual: {
        // 아래 곡선들이 존재하기 **전에** 이 카메라가 하던 짓 — 방금 측정한 문제의 크기.
        // 보정 후 남는 값이 아니다. 그건 검증 패스만 말할 수 있고, 둘을 섞으면 캘리브레이션이
        // 스스로를 축하하게 된다.
        beforePx: round(Math.max(...points.map((p) => p.residualPx)), 1),
        fitRmsPx: round(Math.max(...points.map((p) => p.fitRmsPx)), 1),
        byZoom: Object.fromEntries(points.map((p) => [p.zoom, round(p.residualPx, 1)])),
      },
      source: "measured",
    });

    // 장면이 내주지 않은 줌들. 보고하되 숨기지 않는다 — 곡선은 커버리지만큼만 좋고,
    // 줌 범위의 어디가 추측인지는 운영자가 알 권리가 있다.
    return { calibration, points, skipped };
  }
}

// ---------------------------------------------------------------------------

/** 황금분할 탐색: 비용이 f 에 대해 단봉이고 맞추는 파라미터가 하나뿐이라 이걸로 충분하다. */
function goldenSection(cost, lo, hi, iterations) {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = hi - gr * (hi - lo);
  let b = lo + gr * (hi - lo);
  let fa = cost(a);
  let fb = cost(b);
  for (let i = 0; i < iterations; i++) {
    if (fa < fb) {
      hi = b; b = a; fb = fa;
      a = hi - gr * (hi - lo); fa = cost(a);
    } else {
      lo = a; a = b; fa = fb;
      b = lo + gr * (hi - lo); fb = cost(b);
    }
  }
  const f = (lo + hi) / 2;
  return { f, rms: cost(f) };
}

function stat(values) {
  if (!values.length) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = values.length > 1
    ? Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length)
    : 0;
  return { f: m, sd, n: values.length };
}

function groupBy(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export { wrapCd, groupBy };
