// 클릭 센터링 — "화면을 클릭하면 그 지점이 정확히 가운데로".
//
// 카메라 어댑터(아래 인터페이스) 하나만 구현하면 어느 프로젝트에서든 그대로 돌아간다.
//
//   const cc = new ClickCentering({ camera: myAdapter, calibration });
//   await cc.click({ x, y });                       // 프레임 좌표(1920x1080)
//   await cc.click(ClickCentering.fromEvent(e, img)); // 브라우저 <img> 클릭 이벤트에서 바로
//
// 두 가지 조준 모드:
//   "setcenter" (기본) — 카메라의 setcenter 에 **보정된 좌표**를 준다. 왕복 1회, 가장 빠르다.
//   "absolute"        — 목표 PTZ 를 직접 계산해 절대이동한다. setcenter 가 없거나, 프레임
//                       가장자리 클램프(보정 좌표가 0..W 를 벗어남)를 피하고 싶을 때.

import { PtzGeometry } from "./geometry.mjs";
import { CameraCalibration } from "./calibration.mjs";

/**
 * @typedef {object} CameraAdapter
 * @property {() => Promise<{panpos:number,tiltpos:number,zoompos:number}>} getPtz
 * @property {(p:{x:number,y:number,speed?:number}) => Promise<any>} [setCenter]   mode "setcenter" 에 필요
 * @property {(p:object) => Promise<any>} [setCenterBox]                            박스줌에 필요
 * @property {(p:object) => Promise<any>} [goPtz]                                   mode "absolute" 에 필요
 * @property {(p:{before:object}) => Promise<object>} [waitSettle]  없으면 getPtz 한 번으로 대신한다
 */

export class ClickCentering {
  /**
   * @param {object} options
   * @param {CameraAdapter} options.camera
   * @param {CameraCalibration|object|string|null} [options.calibration] 없으면 무보정
   * @param {"setcenter"|"absolute"} [options.mode="setcenter"]
   * @param {number} [options.frameWidth=1920]  카메라가 좌표를 받는 기준 프레임
   * @param {number} [options.frameHeight=1080]
   * @param {number} [options.speed]            기본 이동 속도(1..100)
   */
  constructor({ camera, calibration = null, mode = "setcenter", frameWidth = 1920, frameHeight = 1080, speed } = {}) {
    if (!camera || typeof camera.getPtz !== "function") {
      throw new TypeError("ClickCentering: camera 어댑터에 getPtz() 가 필요합니다.");
    }
    if (mode !== "setcenter" && mode !== "absolute") throw new TypeError(`알 수 없는 mode: ${mode}`);
    if (mode === "setcenter" && typeof camera.setCenter !== "function") {
      throw new TypeError('mode "setcenter" 에는 camera.setCenter() 가 필요합니다.');
    }
    if (mode === "absolute" && typeof camera.goPtz !== "function") {
      throw new TypeError('mode "absolute" 에는 camera.goPtz() 가 필요합니다.');
    }

    this.camera = camera;
    this.calibration = calibration instanceof CameraCalibration
      ? calibration
      : CameraCalibration.from(calibration, { frameWidth, frameHeight });
    this.mode = mode;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.speed = speed;
    this.geometry = new PtzGeometry({ calibration: this.calibration, frameWidth, frameHeight });
  }

  /**
   * 표시 좌표 → 프레임 좌표. 화면에 축소돼 그려진 영상 위의 클릭을 카메라가 아는 좌표로 바꾼다.
   * @param {{clientX:number, clientY:number}} event
   * @param {{getBoundingClientRect:Function, naturalWidth?:number, naturalHeight?:number}} element
   */
  static fromEvent(event, element, { frameWidth = 1920, frameHeight = 1080 } = {}) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error("표시 영역 크기가 0 입니다.");
    // 영상이 아직 안 실렸으면 기준 프레임으로 가정한다(첫 프레임 전에도 클릭이 되게).
    const nw = element.naturalWidth || frameWidth;
    const nh = element.naturalHeight || frameHeight;
    return {
      x: Math.round((event.clientX - rect.left) / rect.width * nw),
      y: Math.round((event.clientY - rect.top) / rect.height * nh),
      frameWidth: nw,
      frameHeight: nh,
      displayX: event.clientX - rect.left,
      displayY: event.clientY - rect.top,
    };
  }

  /** 임의 해상도 좌표 → 이 카메라의 기준 프레임 좌표. */
  normalize({ x, y, frameWidth, frameHeight }) {
    const sx = frameWidth ? this.frameWidth / frameWidth : 1;
    const sy = frameHeight ? this.frameHeight / frameHeight : 1;
    const nx = Number(x) * sx;
    const ny = Number(y) * sy;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new TypeError("x, y 는 유한한 숫자여야 합니다.");
    return {
      x: clamp(Math.round(nx), 0, this.frameWidth),
      y: clamp(Math.round(ny), 0, this.frameHeight),
    };
  }

  /**
   * 클릭 한 번 = 그 지점을 화면 중앙으로.
   * @param {{x:number, y:number, frameWidth?:number, frameHeight?:number, speed?:number, rawAim?:boolean}} p
   *   rawAim: true 면 보정을 우회한다. **캘리브레이션 측정용** — 재려는 대상을 보정 너머로 재면 안 되니까.
   * @returns {Promise<{from, sent, ptz, k, clamped, mode}>}
   */
  async click({ x, y, frameWidth, frameHeight, speed, rawAim = false }) {
    const point = this.normalize({ x, y, frameWidth, frameHeight });
    const from = await this.camera.getPtz();
    const spd = speed ?? this.speed;

    if (this.mode === "absolute") {
      // 절대이동은 f_true 로 직접 각도를 푼다 — 펌웨어의 틀린 초점을 아예 거치지 않으므로
      // 게인도, 가장자리 클램프도 필요 없다.
      const target = this.geometry.pixelToTarget({ ...point, ptz: from });
      await this.camera.goPtz({ ...target, panspeed: spd, tiltspeed: spd, speed: spd });
      return { from, sent: target, ptz: await this.#settle(from), k: 1, clamped: false, mode: this.mode };
    }

    const aim = rawAim
      ? { x: point.x, y: point.y, k: 1, clamped: false }
      : this.calibration.aim({ ...point, zoom: from.zoompos });
    await this.camera.setCenter({ x: aim.x, y: aim.y, speed: spd });
    return {
      from,
      sent: { x: aim.x, y: aim.y },
      clicked: point,
      ptz: await this.#settle(from),
      k: aim.k,
      clamped: aim.clamped,
      mode: this.mode,
    };
  }

  /**
   * 드래그한 네모 = 그 영역으로 센터링 + 줌인.
   * 중심만 보정한다(크기는 목표 줌을 정하는 값이라 건드리면 안 된다).
   */
  async clickBox({ startX, startY, endX, endY, frameWidth, frameHeight, speed, rawAim = false }) {
    if (typeof this.camera.setCenterBox !== "function") {
      throw new TypeError("박스줌에는 camera.setCenterBox() 가 필요합니다.");
    }
    const a = this.normalize({ x: Math.min(startX, endX), y: Math.min(startY, endY), frameWidth, frameHeight });
    const b = this.normalize({ x: Math.max(startX, endX), y: Math.max(startY, endY), frameWidth, frameHeight });
    const from = await this.camera.getPtz();
    const box = rawAim
      ? { startX: a.x, startY: a.y, endX: b.x, endY: b.y, k: 1, clamped: false }
      : this.calibration.aimBox({ startX: a.x, startY: a.y, endX: b.x, endY: b.y, zoom: from.zoompos });

    await this.camera.setCenterBox({
      startX: box.startX, startY: box.startY, endX: box.endX, endY: box.endY,
      speed: speed ?? this.speed,
    });
    return { from, sent: box, ptz: await this.#settle(from), k: box.k, clamped: box.clamped };
  }

  /** 이 클릭이 얼마나 보정되는지 미리 본다 (카메라를 움직이지 않는다 — UI 프리뷰·디버깅용). */
  preview({ x, y, zoom, frameWidth, frameHeight }) {
    const point = this.normalize({ x, y, frameWidth, frameHeight });
    const aim = this.calibration.aim({ ...point, zoom });
    return {
      clicked: point,
      sent: { x: aim.x, y: aim.y },
      k: aim.k,
      clamped: aim.clamped,
      shiftPx: Math.hypot(aim.x - point.x, aim.y - point.y),
      hfovDeg: this.calibration.hfovAt(zoom),
    };
  }

  async #settle(before) {
    return typeof this.camera.waitSettle === "function"
      ? this.camera.waitSettle({ before })
      : this.camera.getPtz();
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
