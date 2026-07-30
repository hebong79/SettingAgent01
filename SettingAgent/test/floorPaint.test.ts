// V1 — 도색선 검출(Stage A) 유닛테스트. 합성 이미지라 정답이 해석적으로 알려져 있다.
//
// 실프레임 픽스처를 쓰지 않는 이유(R9 self-invalidating seal 회피):
//   런타임 정본/프레임을 픽스처로 쓰면 `roi.auto.apply` 나 시뮬레이터 상태가 봉인을 스스로 깨뜨린다.
//   합성 장면은 코드 안에 있으므로 어떤 외부 상태에도 흔들리지 않는다.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAINT_OPTIONS,
  coarseLines,
  detectPaintLines,
  fitLineTLS,
  imageSpanOf,
  lineThrough,
  meetLines,
  normalizeLine,
  paintMask,
  refineLine,
  supportSpan,
  type FrameGray,
} from '../src/ground/floorPaint.js';

const W = 400;
const H = 300;

/** 배경 60 위에 지정 직선을 따라 폭 `width` 의 밝은 띠를 그린 프레임. */
function stripeFrame(a: number, b: number, c: number, width: number, value = 220, bg = 60): FrameGray {
  const data = new Uint8Array(W * H).fill(bg);
  const half = width / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(a * x + b * y + c);
      if (d <= half) data[y * W + x] = value;
      else if (d <= half + 1) data[y * W + x] = Math.round(bg + (value - bg) * (half + 1 - d));
    }
  }
  return { data, width: W, height: H };
}

describe('floorPaint — 직선 표현·교점(순수)', () => {
  it('normalizeLine 은 부호를 한 가지로 고정한다(결정론)', () => {
    const p = normalizeLine([-3, -4, 10]);
    const q = normalizeLine([3, 4, -10]);
    expect(p).toEqual(q);
    expect(p![0]).toBeGreaterThan(0);
  });

  it('lineThrough / meetLines 는 정확한 교점을 준다', () => {
    const l = lineThrough({ x: 0, y: 0 }, { x: 10, y: 10 })!;
    const m = lineThrough({ x: 0, y: 10 }, { x: 10, y: 0 })!;
    const p = meetLines(l, m)!;
    expect(p.x).toBeCloseTo(5, 9);
    expect(p.y).toBeCloseTo(5, 9);
  });

  it('평행선의 교점은 null(throw 금지)', () => {
    expect(meetLines([0, 1, -10], [0, 1, -20])).toBeNull();
  });

  it('fitLineTLS 는 완전 공선점을 오차 없이 복원한다', () => {
    const pts = [];
    for (let i = 0; i < 20; i++) pts.push({ x: 10 + i * 3, y: 40 + i * 3 * 0.5 });
    const l = fitLineTLS(pts)!;
    for (const p of pts) expect(Math.abs(l[0] * p.x + l[1] * p.y + l[2])).toBeLessThan(1e-9);
  });
});

describe('floorPaint — V1 서브픽셀 정련', () => {
  // 기울어진 흰 스트라이프. 법선 오프셋 0.2px / 각도 0.05° 이내로 복원되어야 한다(설계 V1).
  const trueLine = normalizeLine([Math.sin(0.32), -Math.cos(0.32), 0])!;
  const shifted: [number, number, number] = [trueLine[0], trueLine[1], -(trueLine[0] * 200 + trueLine[1] * 150)];

  it('정확한 시드에서 서브픽셀로 복원한다', () => {
    const frame = stripeFrame(shifted[0], shifted[1], shifted[2], 9);
    const r = refineLine(frame, shifted, DEFAULT_PAINT_OPTIONS)!;
    expect(r).not.toBeNull();
    const offset = Math.abs(r.line[2] - shifted[2]);
    const angDeg = (Math.acos(Math.min(1, Math.abs(r.line[0] * shifted[0] + r.line[1] * shifted[1]))) * 180) / Math.PI;
    expect(offset).toBeLessThan(0.2);
    expect(angDeg).toBeLessThan(0.05);
  });

  it('6px 어긋난 시드에서도 스트라이프를 되찾는다(프로파일 창 ±14px)', () => {
    const frame = stripeFrame(shifted[0], shifted[1], shifted[2], 9);
    const seed: [number, number, number] = [shifted[0], shifted[1], shifted[2] + 6];
    const r = refineLine(frame, seed, DEFAULT_PAINT_OPTIONS)!;
    expect(Math.abs(r.line[2] - shifted[2])).toBeLessThan(0.3);
  });

  it('스트라이프가 없으면 null(강등, throw 금지)', () => {
    const flat: FrameGray = { data: new Uint8Array(W * H).fill(60), width: W, height: H };
    expect(refineLine(flat, shifted, DEFAULT_PAINT_OPTIONS)).toBeNull();
  });

  it('결정론 — 같은 입력은 같은 출력', () => {
    const frame = stripeFrame(shifted[0], shifted[1], shifted[2], 9);
    const a = refineLine(frame, shifted, DEFAULT_PAINT_OPTIONS)!;
    const b = refineLine(frame, shifted, DEFAULT_PAINT_OPTIONS)!;
    expect(a.line).toEqual(b.line);
    expect(a.residPx).toBe(b.residPx);
  });
});

describe('floorPaint — 마스크·능선 필터', () => {
  it('얇은 띠는 남고 넓은 덩어리는 떨어진다(D-5 대비 오염 억제와 별개의 형태 판정)', () => {
    const data = new Uint8Array(W * H).fill(60);
    for (let y = 40; y < 250; y++) for (let x = 100; x < 108; x++) data[y * W + x] = 220; // 폭 8 띠
    for (let y = 40; y < 250; y++) for (let x = 200; x < 300; x++) data[y * W + x] = 220; // 폭 100 덩어리
    const frame: FrameGray = { data, width: W, height: H };
    const { mask } = paintMask(frame, DEFAULT_PAINT_OPTIONS);
    const count = (x0: number, x1: number): number => {
      let n = 0;
      for (let y = 40; y < 250; y++) for (let x = x0; x < x1; x++) if (mask[y * W + x]) n++;
      return n;
    };
    const stripe = count(100, 108);
    const blobInner = count(230, 270); // 덩어리 내부(경계에서 16px 이상 안쪽)
    expect(stripe).toBeGreaterThan(500);
    expect(blobInner).toBe(0);
  });

  it('능선 마스크는 항상 원마스크의 부분집합이다(필터는 더하지 않고 덜어낸다)', () => {
    const data = new Uint8Array(W * H).fill(60);
    for (let y = 40; y < 250; y++) for (let x = 100; x < 108; x++) data[y * W + x] = 220;
    for (let y = 120; y < 128; y++) for (let x = 30; x < 370; x++) data[y * W + x] = 200;
    const frame: FrameGray = { data, width: W, height: H };
    const on = paintMask(frame, DEFAULT_PAINT_OPTIONS).mask;
    const off = paintMask(frame, { ...DEFAULT_PAINT_OPTIONS, ridge: false }).mask;
    let onN = 0;
    let offN = 0;
    for (let i = 0; i < on.length; i++) {
      if (on[i]) {
        onN++;
        expect(off[i]).toBe(1);
      }
      if (off[i]) offN++;
    }
    expect(onN).toBeGreaterThan(0);
    expect(onN).toBeLessThanOrEqual(offN);
  });

  it('ridgeDrop 을 올리면 아무것도 통과하지 못한다(필터가 실제로 판정하고 있음)', () => {
    const data = new Uint8Array(W * H).fill(60);
    for (let y = 40; y < 250; y++) for (let x = 100; x < 108; x++) data[y * W + x] = 220;
    const frame: FrameGray = { data, width: W, height: H };
    const { mask } = paintMask(frame, { ...DEFAULT_PAINT_OPTIONS, ridgeDrop: 250 });
    expect(mask.reduce<number>((s, v) => s + v, 0)).toBe(0);
  });
});

describe('floorPaint — 지지 구간', () => {
  const line = normalizeLine([0, 1, -150])!;

  it('마스크가 이어지는 최장 구간만 돌려준다', () => {
    const data = new Uint8Array(W * H).fill(60);
    for (let x = 50; x < 300; x++) for (let y = 146; y < 154; y++) data[y * W + x] = 220;
    const frame: FrameGray = { data, width: W, height: H };
    const { mask } = paintMask(frame, DEFAULT_PAINT_OPTIONS);
    const sp = supportSpan(mask, W, H, line, DEFAULT_PAINT_OPTIONS)!;
    const full = imageSpanOf(line, W, H)!;
    expect(sp.tmax - sp.tmin).toBeLessThan(full.tmax - full.tmin);
    expect(sp.tmax - sp.tmin).toBeGreaterThan(200);
  });

  it('지지 화소가 없으면 null', () => {
    const mask = new Uint8Array(W * H);
    expect(supportSpan(mask, W, H, line, DEFAULT_PAINT_OPTIONS)).toBeNull();
  });
});

describe('floorPaint — Hough 순서 결정론(R2)', () => {
  it('반환 순서는 누적 desc → theta asc → rho asc 로 고정된다', () => {
    const data = new Uint8Array(W * H).fill(60);
    for (let x = 20; x < 380; x++) for (let y = 96; y < 104; y++) data[y * W + x] = 220;
    for (let x = 20; x < 200; x++) for (let y = 196; y < 204; y++) data[y * W + x] = 220;
    const frame: FrameGray = { data, width: W, height: H };
    const { mask } = paintMask(frame, DEFAULT_PAINT_OPTIONS);
    const a = coarseLines(mask, W, H, DEFAULT_PAINT_OPTIONS);
    const b = coarseLines(mask, W, H, DEFAULT_PAINT_OPTIONS);
    expect(a.map((l) => [l.votes, l.thetaDeg, l.rho])).toEqual(b.map((l) => [l.votes, l.thetaDeg, l.rho]));
    for (let i = 1; i < a.length; i++) {
      const p = a[i - 1];
      const q = a[i];
      expect(p.votes > q.votes || (p.votes === q.votes && (p.thetaDeg < q.thetaDeg || (p.thetaDeg === q.thetaDeg && p.rho <= q.rho)))).toBe(true);
    }
    // 긴 띠가 짧은 띠보다 먼저 온다.
    expect(a[0].votes).toBeGreaterThan(300);
  });

  it('detectPaintLines 는 두 띠를 모두 정련해 돌려준다', () => {
    const data = new Uint8Array(W * H).fill(60);
    for (let x = 20; x < 380; x++) for (let y = 96; y < 104; y++) data[y * W + x] = 220;
    for (let x = 20; x < 380; x++) for (let y = 196; y < 204; y++) data[y * W + x] = 220;
    const frame: FrameGray = { data, width: W, height: H };
    const { lines } = detectPaintLines(frame, DEFAULT_PAINT_OPTIONS);
    const rhos = lines.map((l) => -l.line[2]).sort((p, q) => p - q);
    expect(rhos.length).toBeGreaterThanOrEqual(2);
    expect(rhos[0]).toBeCloseTo(99.5, 0);
    expect(rhos[rhos.length - 1]).toBeCloseTo(199.5, 0);
  });
});
