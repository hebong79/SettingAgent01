// PTZ ↔ 픽셀 기하.
//
// 부호 규약 (Hucoms, 실기 cam-001 실측 확정):
//   panpos +  = 시계방향  → 수학 방위각 a = -pan
//   tiltpos + = 아래를 봄 → 고도각      e = -tilt
//   각도 단위는 centidegree(1/100°) — 카메라가 그렇게 준다.
//
// 두 모델이 있고 섞으면 안 된다:
//   PtzGeometry  — 조준. "이 픽셀을 가운데로 오게 하려면 얼마나 돌려야 하나"
//   WorldProjector — 표시. "이 월드 좌표가 화면 어디에 찍히나" (UE 좌표계)
//
// 둘 다 tan 핀홀이지만 역할이 다르다. 조준 결과를 표시에 쓰거나 그 반대로 쓰면 화면 가장자리로
// 갈수록 어긋난다.

const DEG = Math.PI / 180;
const CD2RAD = DEG / 100;   // centidegree → radian
const RAD2CD = 100 / DEG;   // radian → centidegree

/**
 * 팬/틸트에서 카메라 좌표계 기저를 만든다.
 *   F = 광축(forward), R = 화면 오른쪽, U = 화면 위
 * R 은 F × 월드수직 이라 항상 수평이다 — 롤이 없는 PTZ 짐벌의 성질 그 자체.
 * @param {number} panCd  centidegree
 * @param {number} tiltCd centidegree
 */
export function basis(panCd, tiltCd) {
  const a = -(Number(panCd) || 0) * CD2RAD;
  const e = -(Number(tiltCd) || 0) * CD2RAD;
  const ce = Math.cos(e);
  const se = Math.sin(e);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const F = [ce * ca, ce * sa, se];
  const rn = Math.hypot(F[0], F[1]) || 1;
  const R = [F[1] / rn, -F[0] / rn, 0];
  const U = [R[1] * F[2], -R[0] * F[2], R[0] * F[1] - R[1] * F[0]]; // R × F
  return { F, R, U };
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 팬 각도를 -180°..+180° (centidegree) 로 감는다. 0..36000 이음매를 넘길 때 필요. */
export const wrapCd = (to, from) => ((to - from + 18000) % 36000 + 36000) % 36000 - 18000;

/**
 * 조준 기하 — 픽셀 ↔ PTZ.
 *
 * 카메라 펌웨어의 setcenter 가 하는 일의 재현식이자, setcenter 없는 카메라를 위한 대체 경로.
 * 픽셀을 카메라 좌표계의 광선으로 되돌린 뒤 그 광선이 새 광축이 되도록 팬/틸트를 푼다.
 *
 * 팬 축이 월드 수직축이라 광축이 기울어져 있으면 **가로로만 클릭해도 틸트가 딸려 움직인다**
 * (와이드·틸트 16.81°에서 dx=480 클릭에 dtilt=-62cd — 실기와 0 centidegree 로 일치).
 * 1/cos(tilt) 짐벌 커플링을 따로 곱하지 않는 이유가 이것이다. 여기서는 그게 기하의 결과로
 * 저절로 나온다.
 */
export class PtzGeometry {
  /**
   * @param {object} options
   * @param {import("./calibration.mjs").CameraCalibration} options.calibration
   * @param {number} [options.frameWidth=1920]
   * @param {number} [options.frameHeight=1080]
   */
  constructor({ calibration, frameWidth = 1920, frameHeight = 1080 } = {}) {
    if (!calibration) throw new TypeError("PtzGeometry: calibration 이 필요합니다.");
    this.calibration = calibration;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.cx = frameWidth / 2;
    this.cy = frameHeight / 2;
  }

  /** 이 줌에서의 초점거리(px). hfovDeg 를 직접 주면 표를 무시한다. */
  focal(zoom, hfovDeg) {
    const h = hfovDeg === undefined ? this.calibration.hfovAt(zoom) : hfovDeg;
    return this.cx / Math.tan((h / 2) * DEG);
  }

  /**
   * 픽셀 → 팬/틸트 델타(centidegree).
   * @param {object} p
   * @param {number} p.x  0..frameWidth
   * @param {number} p.y  0..frameHeight
   * @param {number} p.zoom      현재 zoompos
   * @param {number} [p.tiltCd]  현재 tiltpos (짐벌 커플링에 필요)
   * @param {number} [p.hfovDeg] 화각 직접 지정
   * @param {number} [p.focalGain=1] 초점거리에 곱할 배율. 펌웨어의 (틀린) 초점을 흉내낼 때 쓴다.
   */
  pixelToDelta({ x, y, zoom = 0, tiltCd = 0, hfovDeg, focalGain = 1 }) {
    const focal = this.focal(zoom, hfovDeg) * Math.max(focalGain, 0.01);
    const nx = (Number(x) - this.cx) / focal;
    const ny = (Number(y) - this.cy) / focal;

    const e0 = -(Number(tiltCd) || 0) * CD2RAD;
    const se = Math.sin(e0);
    const ce = Math.cos(e0);

    // 목표 광선 = F + R·nx + U·(-ny), 방위 0 기준
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
   * 픽셀 → 절대 목표 PTZ. setcenter 가 없거나 믿을 수 없는 카메라를 goPtz 로 직접 몰 때 쓴다.
   * 프레임 가장자리 클램프 문제가 없다는 것이 setcenter 대비 장점.
   */
  pixelToTarget({ x, y, ptz, hfovDeg, focalGain = 1 }) {
    const d = this.pixelToDelta({
      x, y, zoom: ptz?.zoompos, tiltCd: ptz?.tiltpos, hfovDeg, focalGain,
    });
    const panpos = (((Number(ptz?.panpos) || 0) + d.panDelta) % 36000 + 36000) % 36000;
    return {
      panpos: Math.round(panpos),
      tiltpos: Math.round((Number(ptz?.tiltpos) || 0) + d.tiltDelta),
      ...d,
    };
  }

  /**
   * 어떤 방향(다른 PTZ)이 지금 프레임의 어디에 보이는가 — 역투영.
   * 근접 호밍한 지점을 와이드 화면에 점으로 찍는 용도.
   * @param {object} p
   * @param {{panpos,tiltpos,zoompos}} p.view   지금 보고 있는 자세(프레임의 주인)
   * @param {{panpos,tiltpos}} p.target         찍고 싶은 방향
   */
  directionToPixel({ view, target, hfovDeg }) {
    const h = hfovDeg === undefined ? this.calibration.hfovAt(view?.zoompos) : hfovDeg;
    const fx = this.cx / Math.tan((h / 2) * DEG);
    const fy = this.cy / Math.tan((this.calibration.vfovFrom(h) / 2) * DEG);

    const { F, R, U } = basis(view?.panpos, view?.tiltpos);
    const d = basis(target?.panpos, target?.tiltpos).F;

    const t = dot3(d, F);
    const behind = t <= 1e-9;
    const xExact = behind
      ? this.cx + Math.sign(dot3(d, R) || 1) * this.frameWidth
      : this.cx + fx * (dot3(d, R) / t);
    const yExact = behind
      ? this.cy - Math.sign(dot3(d, U) || 1) * this.frameHeight
      : this.cy - fy * (dot3(d, U) / t);

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

/**
 * 표시 기하 — 월드 좌표 → 픽셀 (선택적).
 *
 * 좌표계는 Unreal Engine 규약: 좌수계, 도(degree), forward=+X, right=+Y, up=+Z.
 * 고정 마운트(설치 측량으로 얻은 위치 + pan=0 일 때의 방위)에 라이브 PTZ 를 얹어 광학 카메라를
 * 재구성한다. 시뮬레이터와 실기가 같은 코드를 쓴다 — 다른 것은 마운트 값의 출처뿐이다.
 */
export class WorldProjector {
  /**
   * @param {object} options
   * @param {import("./calibration.mjs").CameraCalibration} options.calibration
   * @param {{location:{x,y,z}, baseYaw:number}} options.mount 설치 외부파라미터
   * @param {number} [options.panToYaw=1]    panpos → yaw 부호
   * @param {number} [options.tiltToPitch=-1] tiltpos → pitch 부호 (tiltpos+ 는 아래, UE pitch+ 는 위)
   */
  constructor({ calibration, mount, frameWidth = 1920, frameHeight = 1080, panToYaw = 1, tiltToPitch = -1 } = {}) {
    if (!calibration) throw new TypeError("WorldProjector: calibration 이 필요합니다.");
    if (!mount?.location) throw new TypeError("WorldProjector: mount{location, baseYaw} 가 필요합니다.");
    this.calibration = calibration;
    this.mount = mount;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.panToYaw = panToYaw;
    this.tiltToPitch = tiltToPitch;
  }

  /** 라이브 PTZ → 광학 카메라(위치 + 회전 + 화각). */
  cameraAt(ptz = {}) {
    return {
      location: this.mount.location,
      rotation: {
        pitch: ((Number(ptz.tiltpos) || 0) / 100) * this.tiltToPitch,
        yaw: (Number(this.mount.baseYaw) || 0) + ((Number(ptz.panpos) || 0) / 100) * this.panToYaw,
        roll: 0,
      },
      hfovDeg: this.calibration.hfovAt(ptz.zoompos),
    };
  }

  /** UE FRotator → 기저(행0=forward, 행1=right, 행2=up). FRotationMatrix 와 동일. */
  static rotatorBasis({ pitch = 0, yaw = 0, roll = 0 } = {}) {
    const P = pitch * DEG, Y = yaw * DEG, R = roll * DEG;
    const SP = Math.sin(P), CP = Math.cos(P);
    const SY = Math.sin(Y), CY = Math.cos(Y);
    const SR = Math.sin(R), CR = Math.cos(R);
    return {
      forward: [CP * CY, CP * SY, SP],
      right: [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP],
      up: [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP],
    };
  }

  /**
   * 월드 점 하나를 화면 픽셀로.
   * @returns {{x,y,ndcX,ndcY,depth,visible,behind}} x,y 는 프레임 밖일 수 있다 — 자를지 숨길지는 호출자 몫.
   */
  project({ point, ptz }) {
    const cam = this.cameraAt(ptz);
    const b = WorldProjector.rotatorBasis(cam.rotation);
    const rel = [
      point.x - cam.location.x,
      point.y - cam.location.y,
      point.z - cam.location.z,
    ];

    const depth = dot3(rel, b.forward);
    if (depth <= 1e-3) {
      return { x: NaN, y: NaN, ndcX: NaN, ndcY: NaN, depth, visible: false, behind: true };
    }

    const tanHalfH = Math.tan(cam.hfovDeg * 0.5 * DEG);
    const tanHalfV = tanHalfH / (this.frameWidth / this.frameHeight);
    const ndcX = dot3(rel, b.right) / depth / tanHalfH;
    const ndcY = dot3(rel, b.up) / depth / tanHalfV;

    const x = (ndcX * 0.5 + 0.5) * this.frameWidth;
    const y = (0.5 - ndcY * 0.5) * this.frameHeight;
    return {
      x, y, ndcX, ndcY, depth,
      visible: x >= 0 && x <= this.frameWidth && y >= 0 && y <= this.frameHeight,
      behind: false,
    };
  }

  projectMany({ points, ptz }) {
    return (points || []).map((point) => this.project({ point, ptz }));
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
