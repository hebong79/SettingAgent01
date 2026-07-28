// 예제 1 — 클릭 센터링: 보정을 걸면 무엇이 달라지나
//
//   node examples/01-click-to-center.mjs
//
// 같은 클릭을 두 번 한다. 한 번은 보정 없이, 한 번은 캘리브레이션을 걸고. 화면 중앙에서 멀수록,
// 줌이 깊을수록 차이가 벌어지는 것을 볼 수 있다 — 실기에서 운영자가 "가운데로 안 온다"고
// 말하는 그 현상이다.

import { ClickCentering } from "../index.mjs";
import { MockPtzCamera, TRUE_HFOV, TRUE_GAIN } from "./mock-camera.mjs";

const HOME = { panpos: 4500, tiltpos: 1200, zoompos: 0 };
const CLICKS = [
  { label: "중앙 근처", x: 1060, y: 590 },
  { label: "1/4 프레임", x: 1440, y: 540 },
  { label: "가장자리", x: 1780, y: 860 },
];
const ZOOMS = [0, 5129, 8000];

// 이 카메라를 실제로 재서 얻은 표라고 치자 (예제 3 이 이 표를 처음부터 만들어낸다).
const MEASURED = { zoomHfov: TRUE_HFOV, centeringGain: TRUE_GAIN };

async function sweep(calibration) {
  const camera = new MockPtzCamera();
  const centering = new ClickCentering({ camera, calibration });
  const rows = [];
  for (const zoom of ZOOMS) {
    for (const click of CLICKS) {
      camera.ptz = { ...HOME, zoompos: zoom };
      const before = await camera.getPtz();
      const moved = await centering.click({ x: click.x, y: click.y });
      const residual = camera.residualOf({ clickX: click.x, clickY: click.y, before });
      rows.push({ zoom, click, k: moved.k, clamped: moved.clamped, missPx: residual.distance });
    }
  }
  return rows;
}

const raw = await sweep(null);           // 캘리브레이션 없음 = 보정 없이 조준
const fixed = await sweep(MEASURED);     // 실측 표 적용

console.log("클릭한 지점이 화면 중앙에서 얼마나 벗어난 채로 멈추나 (픽셀)\n");
console.log("  zoom   클릭 위치      보정 없음      보정 적용    게인 k");
console.log("  " + "-".repeat(58));
for (let i = 0; i < raw.length; i++) {
  const r = raw[i];
  const f = fixed[i];
  console.log(
    `  ${String(r.zoom).padStart(5)}   ${r.click.label.padEnd(12)}`
    + `${r.missPx.toFixed(1).padStart(8)}px   ${f.missPx.toFixed(1).padStart(8)}px`
    + `   ${f.k.toFixed(3)}${f.clamped ? "  (가장자리 클램프)" : ""}`,
  );
}

console.log(`
읽는 법
  · 보정 없음: 중앙 근처는 멀쩡하고 가장자리로 갈수록, 줌이 깊을수록 심해진다.
    초점거리 배율오차는 **편심에 비례**하는 오차로 나타나기 때문이다.
  · 보정 적용: 편심을 미리 k 배 밀어 그 오차를 정확히 상쇄한다 (근사가 아니다).
  · "가장자리 클램프": 보정 좌표가 0..1920 을 벗어나 잘렸다는 뜻 — 그 클릭은 부분 보정만 된다.
    아래 절대이동 모드가 그 한계를 없앤다.
`);

// ---------------------------------------------------------------------------
// setcenter 를 아예 쓰지 않는 길: 목표 PTZ 를 직접 계산해 절대이동한다.
// 펌웨어의 틀린 초점을 거치지 않으므로 게인도, 가장자리 클램프도 필요 없다.
// setcenter 가 없는 카메라에 이 라이브러리를 붙일 때도 이 모드를 쓴다.
const camera = new MockPtzCamera();
const absolute = new ClickCentering({ camera, calibration: MEASURED, mode: "absolute" });
camera.ptz = { ...HOME, zoompos: 8000 };
const before = await camera.getPtz();
const moved = await absolute.click({ x: 1780, y: 860 });
const miss = camera.residualOf({ clickX: 1780, clickY: 860, before });
console.log(`절대이동 모드 · 가장자리 클릭 @z8000 → 목표 pan ${moved.sent.panpos} tilt ${moved.sent.tiltpos}`);
console.log(`  남은 오차 ${miss.distance.toFixed(2)}px (클램프 없음)`);
