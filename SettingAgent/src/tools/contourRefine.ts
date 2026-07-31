// ★ 27-A 신규 — **접지 콘투어 정제**(설계 `_workspace/51_architect_plan_round27_contour_refine.md` §3).
//
// 이 파일이 하는 일 — `bottomContour`(`src/ground/contact.ts:85`) 가 낸 열 배열을 **후처리**한다.
//   `bottomContour` 자체도, 그 호출 지점(`imageObservation.ts`)도 바꾸지 않는다.
//   정제는 전부 **새 배열을 돌려준다**(입력 불변).
//
// ★★ 오라클 격리 ★★ — 입력은 **콘투어 점 + 다른 마스크 폴리곤 + GroundModel** 뿐이다.
//   차량 월드 좌표·면 라벨·가시성·강등본을 읽지 않는다. `SlotAxes`/`fitContactLine`/`buildFootprint`/
//   `buildFrameCuboids`/`slotPolysPx` 도 부르지 않는다(설계 §5 봉인 승계 · 새 파일로의 봉인 세탁 방지).

import { rejectOccluded, toOtherMask } from '../ground/contact.js';
import { backprojectToGround } from '../ground/project.js';
import type { GroundModel } from '../ground/types.js';
import type { Vec3 } from '../ground/contactTypes.js';
import { tlsFit, type Px, type TlsLine } from './contactOrient.js';

/** 콘투어 3선분 분해 결과 — segA = cols[0..k1) · segB = cols[k1..k2) · segC = cols[k2..). */
export interface Kink3Split {
  k1: number;
  k2: number;
  a: TlsLine;
  b: TlsLine;
  c: TlsLine;
  /** 3선 가중 RMS. */
  rms3: number;
  segA: Px[];
  segB: Px[];
  segC: Px[];
}

/**
 * 콘투어를 3선분으로 **최적 분할** — `splitContour`(`contactOrient.ts:100`)와 **같은 TLS 정의·같은 가중 RMS**.
 * 각 조각 ≥ `minSegCols`. 새 점수식을 만들지 않는다(설계 §3 금지 규약).
 */
export function splitContour3(cols: readonly Px[], minSegCols = 4): Kink3Split | null {
  const n = cols.length;
  if (n < 3 * minSegCols) return null;
  let best: Kink3Split | null = null;
  for (let k1 = minSegCols; k1 <= n - 2 * minSegCols; k1++) {
    const A = cols.slice(0, k1);
    const fa = tlsFit(A);
    if (!fa) continue;
    for (let k2 = k1 + minSegCols; k2 <= n - minSegCols; k2++) {
      const B = cols.slice(k1, k2);
      const C = cols.slice(k2);
      const fb = tlsFit(B);
      const fc = tlsFit(C);
      if (!fb || !fc) continue;
      const rms3 = Math.sqrt((A.length * fa.rms * fa.rms + B.length * fb.rms * fb.rms + C.length * fc.rms * fc.rms) / n);
      if (best && rms3 >= best.rms3) continue;
      best = { k1, k2, a: fa, b: fb, c: fc, rms3, segA: A, segB: B, segC: C };
    }
  }
  return best;
}

/**
 * **F1 — 가림열 배제**. 열 바로 아래가 다른 마스크 안이면 접지선이 아니다(`rejectOccluded` 재사용).
 * 살아남은 열이 `minKeep` 미만이면 **원본을 그대로 돌려준다**(정제가 파괴가 되지 않게).
 * 반환은 항상 **새 배열**이다.
 */
export function dropOccludedCols(
  cols: readonly Px[],
  otherMasks: ReadonlyArray<readonly Px[]>,
  imgH: number,
  belowPx = 6,
  minKeep = 8,
): Px[] {
  if (cols.length === 0) return [];
  const r = rejectOccluded(cols, otherMasks.map((o) => toOtherMask(o)), belowPx, imgH);
  return r.valid.length >= minKeep ? r.valid.map((c) => ({ x: c.x, y: c.y })) : cols.map((c) => ({ x: c.x, y: c.y }));
}

/** 열의 지면 깊이(m) = 역투영점과 카메라 직하점 사이 거리. 역투영 실패는 null. */
export function colDepthM(p: Px, g: GroundModel): number | null {
  const X = backprojectToGround(p, g);
  if (!X) return null;
  const nd: Vec3 = [g.n[0] * g.d, g.n[1] * g.d, g.n[2] * g.d];
  return Math.hypot(X[0] - nd[0], X[1] - nd[1], X[2] - nd[2]);
}

/**
 * **F2 — 원경 꼬리 절사**. 열의 지면 깊이가 마스크 깊이 중앙값보다 `keepM` 이상 먼 쪽이면 제거한다.
 * 문턱은 호출측이 **단계 A 분포에서 1회 도출해 고정**한다(사후 조정 금지 — 설계 §3 F2).
 * 살아남은 열이 `minKeep` 미만이면 원본 반환. 반환은 항상 **새 배열**이다.
 */
export function dropFarTail(cols: readonly Px[], g: GroundModel, keepM: number, minKeep = 8): Px[] {
  if (cols.length === 0) return [];
  const ds = cols.map((c) => colDepthM(c, g));
  if (ds.some((d) => d == null)) return cols.map((c) => ({ x: c.x, y: c.y }));
  const s = (ds as number[]).slice().sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const keep = cols.filter((_, i) => (ds[i] as number) <= mid + keepM);
  return keep.length >= minKeep ? keep.map((c) => ({ x: c.x, y: c.y })) : cols.map((c) => ({ x: c.x, y: c.y }));
}

/**
 * ★ 음성 대조군 **N1 — 무작위 절사**. `dropCount` 개를 시드 고정 난수로 지운다.
 * 시드는 호출측이 **마스크 key 해시로 결정론 고정**한다(재현 가능 — 설계 §3-1).
 * F1/F2 가 「열을 지우는」 조작이므로, 「열을 지우면 뭐든 좋아진다」를 배제하는 데 필요하다.
 */
export function dropRandomCols(cols: readonly Px[], dropCount: number, seed: number, minKeep = 8): Px[] {
  const n = cols.length;
  if (n === 0 || dropCount <= 0) return cols.map((c) => ({ x: c.x, y: c.y }));
  if (n - dropCount < minKeep) return cols.map((c) => ({ x: c.x, y: c.y }));
  // mulberry32 — 결정론 · 외부 의존 없음.
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const idx = cols.map((_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const dropped = new Set(idx.slice(0, dropCount));
  return cols.filter((_, i) => !dropped.has(i)).map((c) => ({ x: c.x, y: c.y }));
}

/** 문자열 → 32bit 결정론 해시(N1 시드용). */
export function seedOf(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
