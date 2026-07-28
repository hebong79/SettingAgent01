// 예제 3 — 표를 처음부터 만든다 (스윕 → 매칭 → 솔버 → 저장)
//
//   node examples/03-calibrate.mjs
//
// 가짜 카메라에 **정답을 숨겨두고** 캘리브레이션을 돌린 뒤, 되찾은 값과 정답을 나란히 찍는다.
// 실기에서 이 절차가 정확히 무엇을 하는지 눈으로 확인하는 용도다 — 카메라가 자기 자신을 잰다.
//
// 실제로는 몇 분~20분이 걸리지만(카메라가 물리적으로 움직이므로) 여기서는 즉시 끝난다.

import { CalibrationRunner, CalibrationSolver, FrameMatcher, CameraCalibration } from "../index.mjs";
import { MockPtzCamera, TRUE_HFOV, TRUE_GAIN } from "./mock-camera.mjs";

const RENDER_W = 320;
const RENDER_H = 180;

const camera = new MockPtzCamera({ width: RENDER_W, height: RENDER_H });

const runner = new CalibrationRunner({
  camera,
  // 매칭 파라미터는 **실제 이미지 픽셀** 기준이다. 여기 렌더는 320px 이라 1920 기준값의 1/6 로 줄인다.
  // (실기 1920x1080 스냅샷이면 기본값을 그대로 쓰면 된다.)
  matcher: new FrameMatcher({ half: 16, search: 60, step: 2, pad: 12 }),
  solver: new CalibrationSolver(),
  // 예제용 축소 격자. 실기 기본값은 줌 14단계 × 8클릭 = 112샘플이다.
  grid: { zooms: [0, 5129, 8000], dx: [-480, -240, 240, 480], dy: [-300, 300] },
  settleOptions: { intervalMs: 0, stable: 1 },   // 가짜 카메라는 즉시 멈춘다
  onProgress: ({ done, total, sample }) => {
    if (!sample) return;
    const mark = sample.usable ? "o" : "x";
    process.stdout.write(
      `\r  [${String(done).padStart(2)}/${total}] ${mark} z${String(sample.zoomAnchor).padEnd(5)}`
      + ` 클릭(${String(sample.dx).padStart(4)},${String(sample.dy).padStart(4)})`
      + ` → 잔차(${sample.residualX?.toFixed(0).padStart(4)},${sample.residualY?.toFixed(0).padStart(4)})px`
      + ` peak ${sample.peak?.toFixed(2)} margin ${sample.margin?.toFixed(3)}   `,
    );
  },
});

console.log("스윕 시작 — 줌마다 프레임 곳곳을 클릭하고, 클릭한 것이 실제로 어디 떨어지는지 잰다.\n");
const t0 = Date.now();
const result = await runner.run({ mode: "full" });
console.log(`\n\n완료 (${((Date.now() - t0) / 1000).toFixed(1)}초) — 샘플 ${result.usable}/${result.of} 사용\n`);

// ---------------------------------------------------------------------------
const cal = result.calibration;
const truth = new CameraCalibration({ zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN });

console.log("되찾은 표 vs 숨겨둔 정답");
console.log("   zoom   화각(측정)  화각(정답)   게인(측정)  게인(정답)   보정 전 오차");
console.log("  " + "-".repeat(70));
for (const p of result.points) {
  console.log(
    `  ${String(p.zoom).padStart(5)}   ${p.hfov.toFixed(2).padStart(8)}°  ${truth.hfovAt(p.zoom).toFixed(2).padStart(8)}°`
    + `   ${p.gain.toFixed(3).padStart(9)}  ${truth.gainAt(p.zoom).toFixed(3).padStart(9)}`
    + `   ${p.residualPx.toFixed(1).padStart(9)}px`,
  );
}

if (result.skipped.length) {
  console.log("\n측정하지 못한 줌:");
  for (const s of result.skipped) console.log(`  z${s.zoom}: ${s.why}`);
}

console.log(`
잔차 리포트
  · 보정 전 최악 오차   ${cal.residual.beforePx}px   ← 이 카메라가 **가지고 있던** 오차
  · 초점 피팅 RMS       ${cal.residual.fitRmsPx}px   ← 곡선 자체의 오차 막대(작을수록 표가 믿을 만하다)

  beforePx 는 "보정 후 남는 오차"가 아니다. 그건 **검증 패스**만 말할 수 있다 — 둘을 섞으면
  캘리브레이션이 스스로를 축하하게 된다.
`);

// ---------------------------------------------------------------------------
// 검증: 방금 만든 표를 걸고 같은 스윕을 다시(짧게) 돌린다. 이번엔 보정이 루프 안에 있다.
const verifier = new CalibrationRunner({
  camera,
  calibration: cal,
  matcher: new FrameMatcher({ half: 16, search: 60, step: 2, pad: 12 }),
  grid: { zooms: [0, 8000], dx: [-480, 480], dy: [-300, 300] },
  settleOptions: { intervalMs: 0, stable: 1 },
});
const v = await verifier.verify();
console.log(`검증 결과: ${v.verdict}  (최악 잔차 ${v.worstPx}px · 기준 10px)`);
for (const c of v.checks) {
  console.log(`  z${String(c.zoom).padEnd(6)} 남는 오차 ${String(c.residualPx).padStart(5)}px   적용 ${c.gainApplied} / 필요 ${c.gainNeeded}`);
}
if (v.hint) console.log(`  ${v.hint}`);

// ---------------------------------------------------------------------------
// 저장 모양. 그대로 config 에 넣고 CameraCalibration.from() 으로 다시 읽으면 된다.
console.log("\n저장할 JSON (devices.list[].intrinsics):");
console.log(JSON.stringify(cal.toJSON(), null, 2).split("\n").slice(0, 14).join("\n") + "\n  ...");
