import { describe, it, expect } from 'vitest';
// 순수 수학(sharp/DOM 미참조) — 라우트가 그레이 배열만 주입.
import {
  normalizedCrossCorrelation,
  scaleGray,
  estimateAlign,
} from '../src/capture/frameAlign.js';

/**
 * 검증자(qa-tester): 주차면 자동보정 프레임 정합 순수 수학 `src/capture/frameAlign.ts`(기능3).
 * 근거: 01_architect_plan.md §4-1/§4-4 + 02_developer_changes.md 기능3 §순수 수학.
 * 합성 그레이 배열에 알려진 (dx,dy)/스케일을 주입해 정확/근사 복원·peak 범위·maxShift 경계·featureless 방어를 검증.
 * sharp(픽셀 추출)·실 프레임은 리더 라이브 실증(refframe/autocorrect 확인 완료) — 여기서는 순수 로직만.
 */

/** 유일한 상관 피크를 만드는 가우시안 블롭 패턴(주기성 없음 → tie 회피). 값 0..255. */
function blob(w: number, h: number, cx: number, cy: number, sigma: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      out[y * w + x] = Math.round(255 * Math.exp(-d2 / (2 * sigma * sigma)));
    }
  }
  return out;
}

/** cur[X,Y] = ref[X-sx, Y-sy] (범위 밖 0). NCC 규약: ref[p] ≈ cur[p+(sx,sy)] → 반환 (dx,dy)=(sx,sy). */
function shift(ref: Uint8Array, w: number, h: number, sx: number, sy: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      const rx = X - sx;
      const ry = Y - sy;
      out[Y * w + X] = rx >= 0 && rx < w && ry >= 0 && ry < h ? ref[ry * w + rx] : 0;
    }
  }
  return out;
}

describe('normalizedCrossCorrelation — 정수 픽셀 이동 복원', () => {
  const w = 32;
  const h = 24;
  const ref = blob(w, h, 18, 10, 5);

  it('알려진 시프트(dx=3,dy=-2)를 정확 복원 · peak≈1', () => {
    const cur = shift(ref, w, h, 3, -2);
    const r = normalizedCrossCorrelation(ref, cur, w, h, 6);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(-2);
    expect(r.peak).toBeGreaterThan(0.999);
  });

  it('제로 시프트(동일 프레임)는 dx=dy=0 · peak≈1', () => {
    const r = normalizedCrossCorrelation(ref, ref, w, h, 6);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.peak).toBeGreaterThan(0.999);
  });

  it('featureless(상수) 배열은 분산 0 → peak=0(방어)', () => {
    const flat = new Uint8Array(w * h).fill(128);
    const r = normalizedCrossCorrelation(flat, flat, w, h, 4);
    expect(r.peak).toBe(0);
  });

  it('반환 (dx,dy)는 항상 [-maxShift, maxShift] 범위 내(경계 보장)', () => {
    const cur = shift(ref, w, h, 5, 0); // 실제 시프트 5 > maxShift 3
    const r = normalizedCrossCorrelation(ref, cur, w, h, 3);
    expect(Math.abs(r.dx)).toBeLessThanOrEqual(3);
    expect(Math.abs(r.dy)).toBeLessThanOrEqual(3);
  });
});

describe('scaleGray — 중심 기준 스케일 리샘플', () => {
  const w = 16;
  const h = 12;
  const ref = blob(w, h, 8, 6, 3);

  it('s=1 은 항등(값 그대로)', () => {
    const out = scaleGray(ref, w, h, 1);
    expect(Array.from(out)).toEqual(Array.from(ref));
  });

  it('동일 w×h 캔버스 유지 · s>1 확대 시 중심 밝기 보존', () => {
    const out = scaleGray(ref, w, h, 1.2);
    expect(out.length).toBe(w * h);
    const c = 6 * w + 8; // 중심(블롭 정점) — 확대해도 밝기 최대 유지
    expect(out[c]).toBeGreaterThan(240);
  });
});

describe('estimateAlign — 이동+스케일 정합 추정', () => {
  const w = 40;
  const h = 30;
  const ref = blob(w, h, 22, 14, 6);
  const scales: number[] = [];
  for (let s = 0.9; s <= 1.1001; s += 0.02) scales.push(Math.round(s * 100) / 100);

  it('스케일 없음(동일 프레임): scale=1 · dx=dy=0 · peak≈1', () => {
    const r = estimateAlign(ref, ref, w, h, { scales, maxShift: 8 });
    expect(r.scale).toBe(1);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.peak).toBeGreaterThan(0.999);
  });

  it('cur 이 ref 대비 1.1배 확대: scale≈1.1 복원 · peak 높음', () => {
    const cur = scaleGray(ref, w, h, 1.1);
    const r = estimateAlign(ref, cur, w, h, { scales, maxShift: 6 });
    expect(r.scale).toBeCloseTo(1.1, 5); // 후보 배열에서 정확히 1.1 선택
    expect(Math.abs(r.dx)).toBeLessThanOrEqual(1); // 중심 스케일이라 이동 ≈0
    expect(Math.abs(r.dy)).toBeLessThanOrEqual(1);
    expect(r.peak).toBeGreaterThan(0.9); // 이중 리샘플 스무딩으로 <1 이나 높음
  });

  it('scales 미지정 시 [1] 폴백(스케일 탐색 없음)', () => {
    const cur = shift(ref, w, h, 2, 1);
    const r = estimateAlign(ref, cur, w, h, { maxShift: 5 });
    expect(r.scale).toBe(1);
    expect(r.dx).toBe(2);
    expect(r.dy).toBe(1);
  });
});
