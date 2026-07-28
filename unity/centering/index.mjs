// @baro/centering — 광각 PTZ CCTV 클릭 센터링 & 렌즈 캘리브레이션
//
// 폴더째 복사해서 쓰는 라이브러리. 외부 의존성 없음, 순수 ESM.
//
//   import { ClickCentering, CameraCalibration } from "./centering/index.mjs";
//
//   const cc = new ClickCentering({ camera: myAdapter, calibration: "cam-001" });
//   await cc.click({ x: 1440, y: 300 });   // 이 픽셀이 화면 중앙으로 온다
//
// 자세한 사용법은 README.md, 돌려볼 수 있는 예제는 examples/ 참고.

export { Curve } from "./src/curve.mjs";
export { CameraCalibration, PRESETS } from "./src/calibration.mjs";
export { PtzGeometry, WorldProjector, basis, wrapCd } from "./src/geometry.mjs";
export { ClickCentering } from "./src/centering.mjs";
export { FrameMatcher } from "./src/frame-match.mjs";
export { CalibrationSolver } from "./src/solver.mjs";
export {
  CalibrationRunner, explain,
  FULL_ZOOMS, FULL_DX, FULL_DY,
  VERIFY_ZOOMS, VERIFY_DX, VERIFY_DY,
} from "./src/runner.mjs";

import { CameraCalibration } from "./src/calibration.mjs";
import { ClickCentering } from "./src/centering.mjs";

/**
 * 가장 흔한 조립 한 줄. 캘리브레이션을 해석하고 ClickCentering 을 만들어 준다.
 * @param {object} options ClickCentering 과 동일 — calibration 은 프리셋명 · 실측객체 · null 아무거나
 */
export function createClickCentering({ camera, calibration = null, ...rest } = {}) {
  const { frameWidth = 1920, frameHeight = 1080 } = rest;
  return new ClickCentering({
    camera,
    calibration: CameraCalibration.from(calibration, { frameWidth, frameHeight }),
    ...rest,
  });
}
