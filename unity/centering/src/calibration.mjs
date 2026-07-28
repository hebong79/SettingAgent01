// 카메라 캘리브레이션 — 이 렌즈의 두 곡선.
//
// 광각 CCTV 의 "클릭한 지점이 가운데로 안 온다"는 **배럴 왜곡(곡면율) 문제가 아니다.** 실측
// 105샘플로 확인된 것:
//
//   * 카메라 펌웨어의 setcenter 는 이미 정확한 직선(tan) 기하 + 1/cos(tilt) 짐벌 커플링을 쓴다.
//     팬 스윕과 틸트 스윕으로 각각 역산한 초점거리가 0.1% 이내로 일치한다.
//   * 틀린 것은 기하가 아니라 **상수 하나** — 펌웨어가 믿는 초점거리 f_fw 가 실제 렌즈의 f_true
//     와 어긋나고, 줌인할수록 벌어진다.
//
// 초점거리 배율오차는 편심 비례 오차로 나타난다("가운데는 멀쩡, 가장자리로 갈수록 심함").
// 그리고 둘 다 tan 이므로 보정은 근사가 아니라 **정확**하다:
//
//     atan(k·dx / f_fw) == atan(dx / f_true)   ⟺   k = f_fw / f_true
//
// 그래서 이 클래스가 들고 있는 것은 왜곡계수가 아니라 줌별 스칼라 두 개다:
//
//   zoomHfov      {z, h} — 이 렌즈가 줌 z 에서 실제로 보는 수평 화각. **표시**(오버레이·역투영)용
//   centeringGain {z, k} — 클릭 편심에 미리 곱할 배율.                 **조준**(클릭 센터링)용
//
// 두 표는 서로 다른 축이다. 바꿔 쓰지 말 것.

import { Curve } from "./curve.mjs";

const DEG = Math.PI / 180;

/**
 * 내장 프리셋. cam-001(HNR-2036LA) 2026-07-14 실측.
 *
 * **다른 개체에 그냥 쓰면 위험하다.** k = f_펌웨어 / f_렌즈 에서 분자는 펌웨어에 박힌 상수라
 * 같은 모델·펌웨어면 공통이지만, 분모는 개체차를 탄다. 개체차의 크기는 아직 미측정이다(실카메라
 * 1대뿐). 그 개체의 오차가 여기 값의 절반보다 작으면 보정이 오히려 오차를 키운다.
 * 새 카메라에는 반드시 **검증(verify)부터** 돌려라.
 */
export const PRESETS = {
  "cam-001": {
    label: "HNR-2036LA (cam-001 실측 2026-07-14)",
    // z≈16384 에서 광학이 포화하고, z15000→16384 에서 화각이 절반으로 꺾인다.
    // 그 밴드의 앵커가 촘촘한 이유 — 성글게 재면 보간이 절벽을 직선으로 뭉갠다.
    zoomHfov: [
      { z: 0, h: 57.14 }, { z: 2000, h: 47.89 }, { z: 3000, h: 43.37 },
      { z: 5129, h: 34.05 }, { z: 8000, h: 22.59 }, { z: 10338, h: 14.68 },
      { z: 12161, h: 9.77 }, { z: 14000, h: 6.29 }, { z: 15000, h: 4.88 },
      { z: 15400, h: 4.32 }, { z: 15800, h: 3.74 }, { z: 16100, h: 3.16 },
      { z: 16384, h: 2.39 },
    ],
    // 단조가 아니다. 펌웨어의 줌→초점 모델이 z16384 부근에서 먼저 포화하는 반면 렌즈는 계속
    // 좁아지므로, 그 너머에서는 카메라가 자기가 더 넓게 본다고 믿고 **과회전**한다(z22000 에서
    // 무보정 -33% 오버슈트 실측). 1.11 을 망원 끝까지 유지하는 표는 오차를 키운다.
    centeringGain: [
      { z: 0, k: 0.988 }, { z: 2000, k: 1.053 }, { z: 3000, k: 1.071 },
      { z: 5129, k: 1.090 }, { z: 8000, k: 1.110 }, { z: 10338, k: 1.111 },
      { z: 12161, k: 1.113 }, { z: 14000, k: 1.110 }, { z: 15000, k: 1.106 },
      { z: 15400, k: 1.075 }, { z: 15800, k: 1.050 }, { z: 16100, k: 0.935 },
      { z: 16384, k: 0.765 }, { z: 22000, k: 0.750 },
    ],
  },
};

export class CameraCalibration {
  /**
   * @param {object} spec
   * @param {Array<{z,h}>} spec.zoomHfov            표시용 화각 곡선 (필수)
   * @param {Array<{z,k}>} [spec.centeringGain]     조준용 게인 곡선 (없으면 보정 없이 조준)
   * @param {number} [spec.frameWidth=1920]
   * @param {number} [spec.frameHeight=1080]
   * @param {string} [spec.label]
   * @param {string} [spec.measuredAt]  ISO 시각 — 언제 잰 값인지
   * @param {object} [spec.residual]    잔차 리포트(진단용, 계산에는 안 쓴다)
   * @param {string} [spec.source]      "cam-001" | "measured" | "none"
   */
  constructor({
    zoomHfov,
    centeringGain = null,
    frameWidth = 1920,
    frameHeight = 1080,
    label,
    measuredAt,
    residual,
    source = "measured",
  } = {}) {
    if (!(frameWidth > 0) || !(frameHeight > 0)) throw new TypeError("frameWidth/frameHeight 는 양수여야 합니다.");
    this.hfovCurve = Curve.from(zoomHfov, "h", { name: "zoomHfov" });
    this.gainCurve = centeringGain ? Curve.from(centeringGain, "k", { name: "centeringGain" }) : null;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.aspect = frameWidth / frameHeight;
    this.label = label;
    this.measuredAt = measuredAt;
    this.residual = residual;
    this.source = source;
  }

  /** 게인 곡선이 있는가 = 클릭 보정을 하는가. */
  get hasGain() { return this.gainCurve !== null; }

  /**
   * 프리셋 이름 / 실측 객체 / 배열(구버전: 게인만) / null 을 하나로 해석한다.
   * null 이면 "이 카메라는 캘리브레이션 없음" — 보정 없이 조준하고 기본 화각표로 그린다.
   */
  static from(spec, { frameWidth = 1920, frameHeight = 1080, fallback = "cam-001" } = {}) {
    const base = (name) => {
      const p = PRESETS[name];
      if (!p) throw new Error(`알 수 없는 프리셋 "${name}". 등록된 것: ${Object.keys(PRESETS).join(", ") || "(없음)"}`);
      return p;
    };
    const defaults = fallback ? base(fallback) : null;

    if (spec instanceof CameraCalibration) return spec;

    if (!spec) {
      return new CameraCalibration({
        zoomHfov: defaults?.zoomHfov,
        centeringGain: null,
        frameWidth, frameHeight, source: "none",
      });
    }
    if (typeof spec === "string") {
      const p = base(spec);
      return new CameraCalibration({ ...p, frameWidth, frameHeight, source: spec });
    }
    // 구버전 모양: intrinsics 가 게인 곡선 배열 하나였다.
    if (Array.isArray(spec)) {
      return new CameraCalibration({
        zoomHfov: defaults?.zoomHfov, centeringGain: spec, frameWidth, frameHeight, source: "measured",
      });
    }
    if (typeof spec !== "object") throw new TypeError("캘리브레이션은 프리셋 이름 · 실측 객체 · null 중 하나여야 합니다.");

    // 실측 객체는 프리셋을 상속해 잰 것만 덮어쓸 수 있다.
    const inherited = spec.model ? base(spec.model) : defaults;
    return new CameraCalibration({
      zoomHfov: spec.zoomHfov ?? inherited?.zoomHfov,
      centeringGain: spec.centeringGain ?? (spec.zoomHfov ? null : inherited?.centeringGain) ?? null,
      label: spec.label ?? inherited?.label,
      measuredAt: spec.measuredAt,
      residual: spec.residual,
      frameWidth, frameHeight,
      source: spec.zoomHfov || spec.centeringGain ? "measured" : (spec.model || "none"),
    });
  }

  /** 새 프리셋 등록 (다른 기종을 재고 나면). */
  static register(name, preset) {
    if (!preset?.zoomHfov) throw new TypeError("프리셋에는 최소한 zoomHfov 가 있어야 합니다.");
    PRESETS[name] = preset;
    return preset;
  }

  // ---- 표시(display) 축 ----------------------------------------------------

  /** 줌 → 수평 화각(도). */
  hfovAt(zoom) { return this.hfovCurve.at(zoom); }

  /** 수평 화각 → 수직 화각(도). tan 렌즈는 비율이 일정하지 않다(와이드 0.614 → 28° 0.570). */
  vfovFrom(hfovDeg) {
    return (2 * Math.atan(Math.tan((hfovDeg / 2) * DEG) / this.aspect)) / DEG;
  }

  vfovAt(zoom) { return this.vfovFrom(this.hfovAt(zoom)); }

  /** 줌 → 실제 렌즈 초점거리(픽셀). f_true. 그리기·역투영의 기준. */
  focalAt(zoom) { return (this.frameWidth / 2) / Math.tan((this.hfovAt(zoom) / 2) * DEG); }

  // ---- 조준(aiming) 축 ------------------------------------------------------

  /** 줌 → 보정 게인 k. 곡선이 없으면 1(보정 안 함). */
  gainAt(zoom) { return this.gainCurve ? this.gainCurve.at(zoom) : 1; }

  /**
   * 클릭 좌표를 setcenter 에 넘길 좌표로 바꾼다 — **이 라이브러리의 핵심 한 줄.**
   * 프레임 중심 기준으로 편심을 k 배 민다.
   *
   * 보정된 좌표가 프레임을 벗어나면(|dx| > 반폭의 약 90%) setcenter 가 받는 범위로 클램프하고
   * clamped:true 로 알린다 — 그 클릭은 부분 보정만 된 것이다. 완전 해결은 ClickCentering 의
   * mode:"absolute" (직접 목표 PTZ 계산 후 절대이동).
   *
   * @returns {{x:number, y:number, k:number, clamped:boolean}}
   */
  aim({ x, y, zoom }) {
    const k = this.gainAt(zoom);
    const cx = this.frameWidth / 2;
    const cy = this.frameHeight / 2;
    const ax = cx + (Number(x) - cx) * k;
    const ay = cy + (Number(y) - cy) * k;
    const sx = clamp(Math.round(ax), 0, this.frameWidth);
    const sy = clamp(Math.round(ay), 0, this.frameHeight);
    return { x: sx, y: sy, k, clamped: sx !== Math.round(ax) || sy !== Math.round(ay) };
  }

  /**
   * 박스줌용. 박스의 **중심만** 보정해 박스를 통째로 평행이동한다.
   * 크기는 건드리지 않는다 — 크기는 펌웨어가 목표 줌을 읽는 값이고, 그건 별개 문제다.
   */
  aimBox({ startX, startY, endX, endY, zoom }) {
    if (!this.hasGain) return { startX, startY, endX, endY, k: 1, clamped: false };
    const cx = (startX + endX) / 2;
    const cy = (startY + endY) / 2;
    const a = this.aim({ x: cx, y: cy, zoom });
    // 보정만큼 밀되, 크기를 바꾸지 않고 프레임 안으로 되민다.
    const dx = clamp(a.x - cx, -startX, this.frameWidth - endX);
    const dy = clamp(a.y - cy, -startY, this.frameHeight - endY);
    return {
      startX: Math.round(startX + dx), startY: Math.round(startY + dy),
      endX: Math.round(endX + dx), endY: Math.round(endY + dy),
      k: a.k,
      clamped: dx !== a.x - cx || dy !== a.y - cy,
    };
  }

  // ---- 직렬화 ---------------------------------------------------------------

  /** config 에 저장할 모양. 그대로 CameraCalibration.from() 에 다시 넣을 수 있다. */
  toJSON() {
    return {
      ...(this.label ? { label: this.label } : {}),
      zoomHfov: this.hfovCurve.toJSON(2),
      ...(this.gainCurve ? { centeringGain: this.gainCurve.toJSON(3) } : {}),
      ...(this.measuredAt ? { measuredAt: this.measuredAt } : {}),
      ...(this.residual ? { residual: this.residual } : {}),
    };
  }

  /** 사람이 읽을 요약 한 줄. */
  describe() {
    const [z0, z1] = this.hfovCurve.domain;
    return [
      this.label || this.source,
      `화각 ${this.hfovAt(z0).toFixed(1)}°(z${z0}) → ${this.hfovAt(z1).toFixed(2)}°(z${z1})`,
      this.hasGain ? `게인 ${this.gainCurve.length}점` : "게인 없음(무보정 조준)",
      this.measuredAt ? `실측 ${this.measuredAt}` : "",
    ].filter(Boolean).join(" · ");
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
