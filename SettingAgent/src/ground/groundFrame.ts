// 프리셋 불변 지면 2D 좌표계(카메라 1대) — L3 의 **유일한 신규 수학**(설계 §2).
//
// 왜 필요한가: GroundModel 의 (n, d) 는 **그 프리셋의 카메라 좌표계** 값이다(types.ts:37-39).
//   카메라는 프리셋마다 pan/tilt 로 회전하므로, 격자를 카메라 좌표로 표현하면 프리셋마다 다른 격자가 된다
//   → "주차면 1개 그려서 전 프리셋" 이 원리적으로 불가능하다.
//
// 다리의 정체: 이미 있는 `groundModel.ts:slotBearingDeg`(bearing = pan + azimuth 가 프리셋 불변량)의 **역**이다.
//   원점 = 카메라 나딜(지면 수직발). 카메라 본체는 프리셋 사이에 움직이지 않으므로 나딜은 **세계 고정점**이다.
//              프리셋 p 의 카메라 좌표에서 나딜 = d·n_p  (n·X = d, |n| = 1)
//   축   = pan 보정 기저. bearing 0° 방향이 e1, 90° 방향이 e2.
//              fwd  = unit(z − (z·n)·n)                       ← groundModel.ts:422 와 **같은 식**
//              right= unit(n × fwd)                           ← :424 와 같은 식
//              e1   = cos(pan)·fwd − sin(pan)·right
//              e2   = sin(pan)·fwd + cos(pan)·right           (e1·e2 = 0)
//   검산: slotBearingDeg 는 az = atan2(dir·right, dir·fwd), bearing = pan + az 로 정의된다.
//         bearing β 인 방향은 az = β − pan 이므로 dir = cos(β−pan)·fwd + sin(β−pan)·right.
//         β=0  → cos(pan)·fwd − sin(pan)·right = e1 ✓
//         β=90 → sin(pan)·fwd + cos(pan)·right = e2 ✓
//
// ★ 가정(정직하게 명시 — 실카에서 깨질 수 있다. 설계 §2-2·§8 R1/R2/R3):
//   ① roll = 0                              ③ 이 깨지면 격자 **위상**이,
//   ② PTZ pan/tilt 보고값이 정확              ② 가 깨지면 격자 **방위**가 직접 오염된다.
//   ③ 광학중심이 pan/tilt 회전축과 일치(나딜이 pan 에 불변)
//
// 순수·IO 없음. 벡터 헬퍼는 project.ts 재사용(재구현 금지). 강등 철학: throw 금지 → null.

import { cross3, dot3, unit3 } from './project.js';
import type { Vec3 } from './contactTypes.js';
import type { GroundModel } from './types.js';

const DEG = Math.PI / 180;

/** 프리셋 불변 지면 2D 좌표계(카메라 1대). 원점 = 카메라 나딜, 축 = pan 보정 기저. */
export interface GroundFrame {
  /** 나딜(카메라좌표 m) = d·n. */
  origin: Vec3;
  /** bearing 0° 방향 단위벡터(카메라좌표, 지면 위). */
  e1: Vec3;
  /** bearing 90° 방향 단위벡터(카메라좌표, 지면 위, e1 과 직교). */
  e2: Vec3;
}

/**
 * GroundModel + PTZ pan → 프리셋 불변 지면 2D 프레임.
 * 퇴화(광축이 지면 법선과 평행 = 수직 하방 · n 불량 · d ≤ 0 · pan 미상) → **null**(throw 금지).
 */
export function groundFrameOf(g: GroundModel, panDeg: number | null): GroundFrame | null {
  if (panDeg == null || !Number.isFinite(panDeg)) return null;
  if (!(g.d > 0) || !Number.isFinite(g.d)) return null;
  const n = unit3(g.n as Vec3);
  if (!n) return null;
  const z: Vec3 = [0, 0, 1];
  const zn = dot3(z, n);
  const fwd = unit3([z[0] - zn * n[0], z[1] - zn * n[1], z[2] - zn * n[2]]);
  if (!fwd) return null; // 수직 하방 → 방위 정의 불가(slotBearingDeg 와 같은 판정).
  const right = unit3(cross3(n, fwd));
  if (!right) return null;
  const c = Math.cos(panDeg * DEG);
  const s = Math.sin(panDeg * DEG);
  const e1: Vec3 = [c * fwd[0] - s * right[0], c * fwd[1] - s * right[1], c * fwd[2] - s * right[2]];
  const e2: Vec3 = [s * fwd[0] + c * right[0], s * fwd[1] + c * right[1], s * fwd[2] + c * right[2]];
  const origin: Vec3 = [g.d * n[0], g.d * n[1], g.d * n[2]];
  if (![...origin, ...e1, ...e2].every(Number.isFinite)) return null;
  return { origin, e1, e2 };
}

/** 지면 2D (a,b) → 카메라좌표 3D. X = origin + a·e1 + b·e2. */
export function groundPointOf(fr: GroundFrame, a: number, b: number): Vec3 {
  return [
    fr.origin[0] + a * fr.e1[0] + b * fr.e2[0],
    fr.origin[1] + a * fr.e1[1] + b * fr.e2[1],
    fr.origin[2] + a * fr.e1[2] + b * fr.e2[2],
  ];
}

/**
 * 카메라좌표 지면점 → 지면 2D (a,b). v = X − origin, a = v·e1, b = v·e2.
 * 지면 밖 점은 평면에 **투영된** 값을 준다(경고 없음 — 순수 함수).
 */
export function groundCoordsOf(fr: GroundFrame, X: Vec3): { a: number; b: number } {
  const v: Vec3 = [X[0] - fr.origin[0], X[1] - fr.origin[1], X[2] - fr.origin[2]];
  return { a: dot3(v, fr.e1), b: dot3(v, fr.e2) };
}
