// 예제 2 — 표시(display) 축: 화각 조회 · 월드 투영 · 방향 역투영
//
//   node examples/02-projection.mjs
//
// 조준(ClickCentering)이 "어디로 돌릴까"라면, 여기는 "지금 화면 어디에 그릴까"다.
// 같은 tan 핀홀이지만 역할이 다르고, 섞으면 화면 가장자리로 갈수록 어긋난다.

import { CameraCalibration, PtzGeometry, WorldProjector } from "../index.mjs";

// 내장 프리셋(cam-001 실측)을 그대로 쓴다.
const cal = CameraCalibration.from("cam-001");
console.log(cal.describe(), "\n");

// ---------------------------------------------------------------------------
// 1) 줌 → 화각 / 초점거리
console.log("줌에 따른 광학");
console.log("   zoom    수평화각   수직화각   초점거리(px)   조준 게인");
for (const z of [0, 3000, 8000, 12161, 15800, 16384, 22000]) {
  console.log(
    `  ${String(z).padStart(6)}   ${cal.hfovAt(z).toFixed(2).padStart(7)}°  ${cal.vfovAt(z).toFixed(2).padStart(7)}°`
    + `   ${cal.focalAt(z).toFixed(0).padStart(10)}   ${cal.gainAt(z).toFixed(3).padStart(8)}`,
  );
}
console.log(`
  · 표는 마지막 앵커에서 **클램프**된다(외삽하지 않는다) — 실제 렌즈가 z16384 에서 포화하므로.
  · 게인이 z16100 부터 1 아래로 내려가는 것은 오타가 아니다: 그 너머에서는 펌웨어 모델이 먼저
    포화해 카메라가 자기가 더 넓게 본다고 믿고 **과회전**한다.
`);

// ---------------------------------------------------------------------------
// 2) 클릭이 얼마나 밀리는지 미리보기 (카메라를 움직이지 않는다)
const geo = new PtzGeometry({ calibration: cal });
console.log("클릭 보정 미리보기 (x=1680, y=540 — 중앙에서 오른쪽으로 720px)");
for (const z of [0, 8000, 16384]) {
  const a = cal.aim({ x: 1680, y: 540, zoom: z });
  const d = geo.pixelToDelta({ x: 1680, y: 540, zoom: z, tiltCd: 1200 });
  console.log(
    `  z${String(z).padEnd(6)} → setcenter 에 보낼 좌표 x=${String(a.x).padStart(4)}`
    + ` (${(a.x - 1680 >= 0 ? "+" : "") + (a.x - 1680)}px)`
    + `   실제 회전 Δpan ${(d.panDelta / 100).toFixed(2)}° Δtilt ${(d.tiltDelta / 100).toFixed(2)}°`,
  );
}
console.log(`
  · 가로로만 클릭했는데 Δtilt 가 0 이 아니다. 팬 축이 월드 수직축이라 광축이 기울어져 있으면
    가로 이동에 틸트가 딸려 온다 — 실기가 정확히 그렇게 움직인다(짐벌 커플링).
`);

// ---------------------------------------------------------------------------
// 3) 방향 역투영: 근접 촬영해 둔 지점이 지금 와이드 화면 어디에 보이나
const wide = { panpos: 4500, tiltpos: 1200, zoompos: 0 };
console.log("주차면 마커 역투영 (와이드 화면 위에 점 찍기)");
for (const spot of [
  { name: "A-01", panpos: 4500, tiltpos: 1200 },
  { name: "A-05", panpos: 5600, tiltpos: 1600 },
  { name: "B-12", panpos: 2100, tiltpos: 900 },
]) {
  const p = geo.directionToPixel({ view: wide, target: spot });
  console.log(`  ${spot.name}  →  (${String(p.x).padStart(4)}, ${String(p.y).padStart(4)})  ${p.inFrame ? "화면 안" : "화면 밖"}`);
}

// ---------------------------------------------------------------------------
// 4) 월드 좌표 투영 (설치 측량값이 있을 때) — UE 좌표계: 좌수계, forward=+X, right=+Y, up=+Z
const projector = new WorldProjector({
  calibration: cal,
  mount: { location: { x: 0, y: 0, z: 800 }, baseYaw: 0 }, // 폴 높이 8m, pan=0 일 때 +X 방향
});
console.log("\n월드 좌표 투영 (카메라 z=800cm, baseYaw=0)");
for (const point of [
  { name: "정면 20m", x: 2000, y: 0, z: 0 },
  { name: "우측 20m/5m", x: 2000, y: 500, z: 0 },
  { name: "좌측 30m/8m", x: 3000, y: -800, z: 0 },
]) {
  const r = projector.project({ point, ptz: { panpos: 0, tiltpos: 2200, zoompos: 0 } });
  console.log(
    `  ${point.name.padEnd(12)} → (${r.x.toFixed(0).padStart(5)}, ${r.y.toFixed(0).padStart(5)})`
    + `  깊이 ${(r.depth / 100).toFixed(1)}m  ${r.visible ? "화면 안" : "화면 밖"}`,
  );
}
