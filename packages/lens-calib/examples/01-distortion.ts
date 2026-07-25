// 곡면율 캘리브레이션 전 과정을 하드웨어 없이 돌려본다.
//
//   npx tsx examples/01-distortion.ts
//
// 가짜 카메라에 정답(화각·게인·곡면율)을 숨겨 두고, 캘리브레이션이 그것을 되찾는지 본다.
// 마지막 A/B 는 "이 표를 켜도 되는가"를 컴포넌트가 스스로 판정하는 부분이다.

import { CalibrationRunner } from '../src/runner.js';
import { FrameMatcher } from '../src/frameMatch.js';
import { CameraCalibration } from '../src/calibration.js';
import { MockHucomsCamera, TRUE_DISTORTION, TRUE_GAIN, TRUE_HFOV } from '../mock/mockCamera.js';

const ZOOMS = [0, 5129, 8000];

// 렌더 해상도를 올릴수록 k1 복원이 정확해진다(매칭 서브픽셀 정밀도에 좌우됨). 실카는 1920x1080
// 스냅샷을 쓰므로 실전 정확도는 그 해상도가 기준이다. 데모는 768 로 절충(정확도 vs 속도).
const camera = new MockHucomsCamera({ width: 768, height: 432 });

// 실제 절차와 같은 순서: 화각·게인을 먼저 알고(클릭 스윕) 그 다음 곡면율을 잰다.
const installed = CameraCalibration.from({ zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN });

const runner = new CalibrationRunner({
  camera,
  calibration: installed,
  // 렌더가 768x432 이므로 매칭 파라미터도 그 스케일로(★실제 이미지 픽셀 기준이다).
  matcher: new FrameMatcher({ frameWidth: 1920, frameHeight: 1080, half: 40, search: 60, step: 4, pad: 16 }),
  sleep: async () => {},
  onProgress: ({ done, total, message }) => {
    if (message) process.stdout.write(`\r  [${done}/${total}] ${message}          `);
  },
});

console.log('곡면율 스윕 (회전 광류 격자)…');
const measured = await runner.runDistortion({ zooms: ZOOMS });
process.stdout.write('\r' + ' '.repeat(70) + '\r');

console.log(`\n대응점 ${measured.usable}/${measured.of} 사용 가능\n`);
console.log('   zoom   k1(측정)   k1(정답)    잔차 전→후(px)   n   채택');
console.log('  ──────────────────────────────────────────────────────────');
for (const p of measured.points) {
  const truth = TRUE_DISTORTION.find((t) => t.z === p.z);
  const err = truth && truth.k1 !== 0 ? ` (${(((p.k1 - truth.k1) / Math.abs(truth.k1)) * 100).toFixed(1)}%)` : '';
  console.log(
    `  ${String(p.z).padStart(6)}  ${p.k1.toFixed(4).padStart(9)}  ${(truth?.k1 ?? 0).toFixed(4).padStart(9)}` +
      `   ${String(p.rms0Px).padStart(6)} → ${String(p.rms1Px).padEnd(6)} ${String(p.n).padStart(3)}   ${p.adopted ? 'O' : `X(${p.reason})`}${err}`,
  );
}
for (const s of measured.skipped) console.log(`  ${String(s.zoom).padStart(6)}  건너뜀 — ${s.why}`);

console.log('\nA/B 검증 (곡면율 켜고/끄고 같은 대응점으로 예측)');
const ab = runner.verifyDistortion(measured.samples, measured.points);
console.log('   zoom     OFF(px)   ON(px)   개선');
console.log('  ────────────────────────────────────');
for (const z of ab.perZoom) {
  console.log(`  ${String(z.zoom).padStart(6)}   ${z.rmsOffPx.toFixed(2).padStart(7)}  ${z.rmsOnPx.toFixed(2).padStart(7)}   ${z.improvedPct.toFixed(1)}%`);
}
console.log(`\n  판정: ${ab.verdict} · 권고: ${ab.recommendation}${ab.reason ? ` — ${ab.reason}` : ''}`);

// 저장 모양 — 그대로 CameraCalibration.from() 에 되먹일 수 있다.
const final = CameraCalibration.from({ zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN, lensDistortion: measured.points });
console.log(`\n${final.describe()}`);
console.log(`  z0 코너 변위 ${final.distortionShiftPx(0).toFixed(1)}px · 주변축 화각 ${final.hfovAt(0).toFixed(2)}° · 실제 가장자리 화각 ${final.hfovEdgeAt(0).toFixed(2)}°`);

// 조준이 실제로 좋아지는가 — 세 단계 비교.
console.log('\n조준 잔차 (클릭 1700,900 @ z5129)');
const specs = [
  ['무보정', null],
  ['게인만', { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN }],
  ['게인+곡면율', { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN, lensDistortion: measured.points }],
] as const;
for (const [label, spec] of specs) {
  const cam = new MockHucomsCamera({ width: 32, height: 18, ptz: { panpos: 4500, tiltpos: 1200, zoompos: 5129 } });
  const before = await cam.getPtz();
  const cal = CameraCalibration.from(spec as never);
  const aim = spec === null ? { x: 1700, y: 900 } : cal.aim({ x: 1700, y: 900, zoom: 5129 });
  await cam.setCenter({ x: aim.x, y: aim.y });
  console.log(`  ${label.padEnd(12)} ${cam.residualOf({ clickX: 1700, clickY: 900, before }).distance.toFixed(2)} px`);
}
