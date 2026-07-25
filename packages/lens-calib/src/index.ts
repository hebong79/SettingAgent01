// @parkagent/lens-calib — 광각 PTZ(Hucoms) 클릭 센터링 & 렌즈 캘리브레이션.
//
// 외부 의존 0 · 순수 TS · Node/브라우저 공용. 폴더째 복사해도, 워크스페이스 패키지로도 쓴다.
//
// ── 진입점 세 개. 따로따로 쓸 수 있다 ────────────────────────────────────────
//
//   ① 표만 쓴다 (카메라 불필요)
//        const cal = CameraCalibration.from('cam-001');
//        cal.aim({ x: 1760, y: 150, zoom: zoomPos });   // → setcenter 에 보낼 좌표
//
//   ② 조준한다 (어댑터 하나)
//        const cc = new ClickCentering({ camera, calibration: 'cam-001' });
//        await cc.click({ x: 1760, y: 150 });
//
//   ③ 잰다
//        const runner = new CalibrationRunner({ camera, calibration: 'cam-001' });
//        await runner.verify();           // 3분  — 프리셋이 이 개체에 맞나
//        await runner.run();              // 20분 — 화각·게인
//        await runner.runDistortion();    //      — 곡면율(광류 격자)
//
// ② 만 쓰는 소비자는 ③(측정·매칭) 코드를 로드하지 않는다.
//
// 단위는 전 구간 **Hucoms 네이티브**다: 픽셀 0~1920/0~1080 · centidegree · zoompos 레지스터.
// ParkAgent 규약(정규화·도·배율) 변환은 이 패키지 **밖**의 어댑터가 담당한다.

// ── 값 객체 · 표 ────────────────────────────────────────────────────────────
export { ZoomCurve } from './curve.js';
export type { CurveOptions } from './curve.js';
export { LensDistortion, distortRadius, undistortRadius, mapRadialPx } from './distortion.js';
export type { Coeffs, DistortionOptions, MapArgs, MappedPoint } from './distortion.js';
export { CameraCalibration, PRESETS } from './calibration.js';
export type { AimResult, CalibrationInit } from './calibration.js';
export { getPreset, registerPreset } from './presets.js';
export type { Preset } from './presets.js';
export { ZoomMap } from './zoomMap.js';

// ── 기하 ────────────────────────────────────────────────────────────────────
export { PtzGeometry, basis, dot3, wrapCd } from './geometry.js';
export type { Basis, DirectionToPixelResult, PixelToDeltaArgs, PtzDelta, Vec3 } from './geometry.js';

// ── 조준 ────────────────────────────────────────────────────────────────────
export { ClickCentering } from './centering.js';
export type { AimMode, ClickArgs, ClickCenteringInit, ClickResult } from './centering.js';

// ── 측정 ────────────────────────────────────────────────────────────────────
export { FrameMatcher } from './frameMatch.js';
export type { FrameMatcherOptions, LocateArgs, LocateResult } from './frameMatch.js';
export { CalibrationSolver, groupBy } from './solver.js';
export type { LensFit, SkippedZoom, SolverOptions, Stat, ZoomPoint } from './solver.js';
export { goldenSection, nelderMead } from './optimize.js';
export type { GoldenResult, NelderMeadOptions, NelderMeadResult } from './optimize.js';
export {
  CalibrationRunner,
  explain,
  FULL_ZOOMS,
  FULL_DX,
  FULL_DY,
  VERIFY_ZOOMS,
  VERIFY_DX,
  VERIFY_DY,
  DISTORTION_ZOOMS,
  DISTORTION_GRID,
  DISTORTION_SHIFT_RATIO,
} from './runner.js';
export type { DistortionRunResult, FullRunResult, RunnerOptions, SettleOptions } from './runner.js';
export { decideAb, decideVerdict } from './verify.js';
export type { AbOptions, AbReport, AbZoomResult, VerifyReport, Verdict, VerdictOptions, ZoomCheck } from './verify.js';

// ── 타입 ────────────────────────────────────────────────────────────────────
export type {
  CalibrationSpec,
  DistortionPoint,
  GainPoint,
  GrayFrame,
  HfovPoint,
  HucomsCameraPort,
  MatchFailReason,
  Point,
  Ptz,
  ResidualReport,
  Sample,
  SweepProgress,
} from './types.js';

import { CameraCalibration } from './calibration.js';
import { ClickCentering, type ClickCenteringInit } from './centering.js';

/**
 * 가장 흔한 조립 한 줄. 캘리브레이션을 해석하고 ClickCentering 을 만들어 준다.
 * `calibration` 은 프리셋 이름 · 실측 객체 · null(무보정) 아무거나.
 */
export function createClickCentering({ camera, calibration = null, ...rest }: ClickCenteringInit): ClickCentering {
  const { frameWidth = 1920, frameHeight = 1080 } = rest;
  return new ClickCentering({
    camera,
    calibration: CameraCalibration.from(calibration, { frameWidth, frameHeight }),
    ...rest,
  });
}
