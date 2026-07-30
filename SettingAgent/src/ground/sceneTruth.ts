// ★ 18회차 신규 — Unity 씬 제원에서 **주차면 진값(정답)** 을 복원한다(순수 · IO 0).
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 이 모듈은 **채점 전용**이다. 검출 경로가 절대 import 하면 안 된다. ★★
//
//   `preset.list` 유래 데이터는 주차면 **정답 그 자체**이며, `fov`·`tilt`·설치고 같은
//   "카메라 사실"과 범주가 다르다. 검출이 이걸 읽으면 정답지를 다른 경로로 끌어온 것이 된다(R1 위반).
//   `test/roiAutoHoldout.test.ts` 가 `floorPaint`·`bayGeometry`·`bayGrid`·`cameraIntrinsics`·
//   `placeMetaIntrinsics` 가 이 모듈을 **문자열로도** 참조하지 않음을 정적으로 봉인한다.
// ══════════════════════════════════════════════════════════════════════════
//
// 복원 규칙(설계자 실측 검증: 수동 정본을 최대 코너오차 0.007px 로 재현):
//   · 행 축   = 크기가 2.5m 인 축. 그 축으로 **피치 2.5m**.
//   · 깊이 축 = 나머지 축, 5.0m.
//   · `offsetPos` = 행 축 좌표가 **최소**인 면의 **중심**. 거기서 +축 방향으로 `faceCount` 개.
//   · 면 사각형 = 중심 ± (1.25 행축, 2.5 깊이축).
// 독립 교차확인: `car.list` 의 차량 x 좌표가 예측 슬롯 중심과 지터 범위 안에서 일치.
//
// 실카에는 `preset.list` 가 없다 → **이 채점기는 시뮬 전용**이다(R10 예외를 명시적으로 안고 간다).
// 실카에서 재현율은 **측정할 수 없다**.

import { canonicalizeQuad } from './groundGrid.js';
import type { PixelQuad } from './types.js';
import type { Vec3 } from './contactTypes.js';

const DEG = Math.PI / 180;

/** Unity `preset.list` 한 행의 원시 제원. */
export interface ScenePresetSpec {
  idx: number;
  faceCount: number;
  /** 행 축 좌표가 최소인 면의 중심(월드 x,y,z). */
  offsetPos: readonly [number, number, number];
  xSize: number;
  zSize: number;
  faceRot: number;
  groupRot: number;
}

/** 복원된 주차면 1건 — 월드 좌표 4점(y = 면 평면). */
export interface TruthFace {
  /** 행(= `preset.list` 의 idx). */
  rowIdx: number;
  /** 행 안의 면 번호(1-based — 저장소 규약). */
  faceIdx: number;
  cornersWorld: [Vec3, Vec3, Vec3, Vec3];
}

/**
 * 행 제원 → 면 목록.
 *
 * `faceRot`/`groupRot` 이 0 이 아니면 **null** 을 낸다 — 회전 씬은 미지원이며
 * 추정으로 채우면 "미측정을 보간으로 메운" 것이 된다. 현 씬은 전부 0 이다.
 */
export function facesOfRow(spec: ScenePresetSpec, planeYM = 0): TruthFace[] | null {
  if (spec.faceRot !== 0 || spec.groupRot !== 0) return null;
  if (!(spec.faceCount >= 1) || !Number.isFinite(spec.faceCount)) return null;
  // 행 축 = 2.5m 인 축. 두 축이 같으면(정사각) 어느 쪽이 행인지 결정할 수 없다 → 강등.
  const rowIsX = spec.xSize < spec.zSize;
  if (spec.xSize === spec.zSize) return null;
  const pitch = rowIsX ? spec.xSize : spec.zSize;
  const depth = rowIsX ? spec.zSize : spec.xSize;
  if (!(pitch > 0) || !(depth > 0)) return null;
  const halfW = pitch / 2;
  const halfD = depth / 2;
  const out: TruthFace[] = [];
  for (let i = 0; i < spec.faceCount; i++) {
    const cx = spec.offsetPos[0] + (rowIsX ? pitch * i : 0);
    const cz = spec.offsetPos[2] + (rowIsX ? 0 : pitch * i);
    const dx = rowIsX ? halfW : halfD;
    const dz = rowIsX ? halfD : halfW;
    out.push({
      rowIdx: spec.idx,
      faceIdx: i + 1,
      cornersWorld: [
        [cx - dx, planeYM, cz - dz],
        [cx - dx, planeYM, cz + dz],
        [cx + dx, planeYM, cz + dz],
        [cx + dx, planeYM, cz - dz],
      ],
    });
  }
  return out;
}

/** 투영에 필요한 카메라 상태. */
export interface TruthView {
  /** 카메라 트랜스폼 위치(월드, m). */
  camPos: readonly [number, number, number];
  panDeg: number;
  tiltDeg: number;
  fovDeg: number;
  fovAxis: 'vertical' | 'horizontal';
  imgW: number;
  imgH: number;
  /**
   * 주차면 평면의 월드 y(m).
   *
   * `cam.list` 는 `pos.y = 5.0` 을 보고하지만 광학중심↔주차면 평면 거리는 **4.95m** 다
   * (F6 — 네 번째 독립 방법으로 확정. 4.95 에서만 정본이 0.007px 로 재현되고 5.00 은 meanIoU 0.852).
   * 광학중심이 5cm 아래인지 도색면이 y=+0.05 에 떠 있는지는 **기하적으로 구분 불가·무관**하다 —
   * 필요한 값은 상대거리 하나뿐이므로 면을 `planeYM` 에 올리는 쪽으로 표현한다.
   */
  planeYM: number;
}

/** 화각 → 초점거리(px). */
function focalOf(v: TruthView): number | null {
  if (!(v.fovDeg > 0) || !(v.fovDeg < 180)) return null;
  const side = v.fovAxis === 'vertical' ? v.imgH : v.imgW;
  const t = Math.tan((v.fovDeg * DEG) / 2);
  if (!(side > 0) || !(t > 0)) return null;
  const f = side / 2 / t;
  return Number.isFinite(f) && f > 0 ? f : null;
}

/**
 * 월드 점 → 픽셀. Unity 좌표계(왼손, y 위, 카메라 전방 +z), 회전 `R = Ry(pan)·Rx(tilt)`.
 *
 * `project.ts` 를 재사용하지 않는 이유: `GroundModel` 은 **카메라 중심 좌표계**(n·d)라 월드 좌표를
 * 담을 자리가 없다. 정답은 월드(x,z)로 정의되므로 월드→카메라 강체변환이 필요하고 그건 거기에 없다.
 * → 그 변환은 **이 함수 한 곳에만** 둔다.
 */
function projectWorld(P: Vec3, v: TruthView, f: number): { x: number; y: number } | null {
  const cp = Math.cos(v.panDeg * DEG);
  const sp = Math.sin(v.panDeg * DEG);
  const ct = Math.cos(v.tiltDeg * DEG);
  const st = Math.sin(v.tiltDeg * DEG);
  const d: Vec3 = [P[0] - v.camPos[0], P[1] - v.camPos[1], P[2] - v.camPos[2]];
  // R = Ry(pan)·Rx(tilt) 의 전치를 곱한다(= Rx(−tilt)·Ry(−pan)).
  const x1 = d[0] * cp - d[2] * sp;
  const y1 = d[1];
  const z1 = d[0] * sp + d[2] * cp;
  const xc = x1;
  const yc = y1 * ct + z1 * st;
  const zc = -y1 * st + z1 * ct;
  if (!(zc > 1e-6)) return null; // 카메라 뒤 · 주점면 위.
  const u = v.imgW / 2 + (f * xc) / zc;
  const w = v.imgH / 2 - (f * yc) / zc;
  return Number.isFinite(u) && Number.isFinite(w) ? { x: u, y: w } : null;
}

/** 정답 면 → 픽셀 quad. 한 점이라도 카메라 뒤면 그 면은 **버린다**(부분 quad 금지 — 검출 경로와 같은 규약). */
export function projectTruth(faces: readonly TruthFace[], view: TruthView): Array<{ face: TruthFace; quad: PixelQuad }> {
  const f = focalOf(view);
  if (f == null) return [];
  const out: Array<{ face: TruthFace; quad: PixelQuad }> = [];
  for (const face of faces) {
    const px: Array<{ x: number; y: number }> = [];
    let ok = true;
    for (const P of face.cornersWorld) {
      const u = projectWorld(P, view, f);
      if (!u) {
        ok = false;
        break;
      }
      px.push(u);
    }
    if (!ok) continue;
    const q = canonicalizeQuad(px);
    if (q) out.push({ face, quad: q });
  }
  return out;
}

/** quad 의 절대 면적(px²). */
export function quadAreaPx(q: PixelQuad): number {
  let a2 = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a2 += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a2) / 2;
}

/**
 * 가시 판정 — quad **중심이 프레임 안** + 면적 하한.
 * 기준은 인자로 받는다(코드에 상수를 묻지 않는다).
 */
export function visibleTruth(
  projected: ReadonlyArray<{ face: TruthFace; quad: PixelQuad }>,
  imgW: number,
  imgH: number,
  minAreaPx: number,
): Array<{ face: TruthFace; quad: PixelQuad }> {
  return projected.filter((e) => {
    const cx = (e.quad[0].x + e.quad[1].x + e.quad[2].x + e.quad[3].x) / 4;
    const cy = (e.quad[0].y + e.quad[1].y + e.quad[2].y + e.quad[3].y) / 4;
    if (!(cx >= 0 && cy >= 0 && cx < imgW && cy < imgH)) return false;
    return quadAreaPx(e.quad) >= minAreaPx;
  });
}
