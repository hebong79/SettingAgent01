import { describe, expect, it } from 'vitest';
import { FrameMatcher } from '../src/frameMatch.js';
import type { GrayFrame } from '../src/types.js';

const W = 400;
const H = 300;

// 결정적 절차적 노이즈 — 같은 좌표는 언제나 같은 밝기.
function hash(i: number, j: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}
function octaves(x: number, y: number): number {
  let v = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / 9;
  for (let o = 0; o < 4; o++) {
    v += amp * vnoise(x * f, y * f);
    norm += amp;
    amp *= 0.6;
    f *= 2.3;
  }
  return v / norm;
}

/** offset 만큼 밀린 장면. B(p) = scene(p + offset) → A 의 내용 p 는 B 의 p−offset 에 있다. */
function render(offsetX: number, offsetY: number, sample: (x: number, y: number) => number = octaves): GrayFrame {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) data[y * W + x] = Math.round(sample(x + offsetX, y + offsetY) * 255);
  }
  return { data, width: W, height: H };
}

const matcher = new FrameMatcher({ frameWidth: W, frameHeight: H, half: 24, search: 40, step: 2, pad: 10 });

describe('FrameMatcher', () => {
  it('정수 변위를 정확히 찾는다', () => {
    const a = render(0, 0);
    const b = render(12, -7);
    const from = { fromX: 200, fromY: 150 };
    const m = matcher.locate(a, b, { ...from, atX: 200, atY: 150 });
    expect(m.usable).toBe(true);
    expect(m.landedX).toBeCloseTo(200 - 12, 0);
    expect(m.landedY).toBeCloseTo(150 + 7, 0);
  });

  it('★서브픽셀 변위를 0.3px 이내로 찾는다 (포물선 보간)', () => {
    const a = render(0, 0);
    const b = render(5.4, -3.7);
    const m = matcher.locate(a, b, { fromX: 200, fromY: 150, atX: 200, atY: 150 });
    expect(Math.abs(m.landedX - (200 - 5.4))).toBeLessThan(0.3);
    expect(Math.abs(m.landedY - (150 + 3.7))).toBeLessThan(0.3);
  });

  it('★탐색 중심을 지정할 수 있다 — 격자 추적의 전제', () => {
    const a = render(0, 0);
    const b = render(30, 20);
    // 프레임 중심에서 찾으면(기본) 30px 밖이라도 탐색창(±40) 안이지만,
    // 예상 위치를 주면 더 좁은 창으로도 잡힌다.
    const narrow = new FrameMatcher({ frameWidth: W, frameHeight: H, half: 24, search: 12, step: 2, pad: 6 });
    const m = narrow.locate(a, b, { fromX: 300, fromY: 220, atX: 300 - 30, atY: 220 - 20 });
    expect(m.usable).toBe(true);
    expect(m.landedX).toBeCloseTo(270, 0);
    expect(m.landedY).toBeCloseTo(200, 0);
  });

  it('탐색 중심 미지정이면 프레임 중심 — 참조본 거동 그대로', () => {
    const a = render(0, 0);
    const b = render(6, 4);
    const m = matcher.locate(a, b, { fromX: W / 2, fromY: H / 2 });
    expect(m.landedX).toBeCloseTo(W / 2 - 6, 0);
  });

  it('★반복 무늬는 점수가 높아도 margin 이 무너진다 (점수는 위치 확신이 아니다)', () => {
    // 순수 주기 패턴 — 여러 오프셋에서 자기 자신과 잘 맞는다.
    const stripes = (x: number, y: number): number => 0.5 + 0.5 * Math.sin((x / 8) * Math.PI * 2) * Math.sin((y / 8) * Math.PI * 2);
    const a = render(0, 0, stripes);
    const b = render(8, 8, stripes); // 정확히 한 주기 — 어느 로브가 1등인지 알 수 없다
    const m = matcher.locate(a, b, { fromX: 200, fromY: 150, atX: 200, atY: 150 });
    expect(m.peak).toBeGreaterThan(0.9); // 점수는 훌륭하다
    expect(m.margin).toBeLessThan(0.02); // 그런데 위치는 동전던지기다
    expect(m.usable).toBe(false);
  });

  it('민무늬는 대비로 걸러지고 사유가 구분된다', () => {
    const flat = render(0, 0, () => 0.5);
    const m = matcher.locate(flat, flat, { fromX: 200, fromY: 150, atX: 200, atY: 150 });
    expect(m.usable).toBe(false);
    expect(m.reason).toBe('dark'); // contrast < lowContrast
    expect(m.contrast).toBeLessThan(12);
  });

  it('크기가 다른 두 프레임은 거부한다', () => {
    const a = render(0, 0);
    const b: GrayFrame = { data: new Uint8Array(10), width: 5, height: 2 };
    expect(() => matcher.locate(a, b, { fromX: 10, fromY: 10 })).toThrow(/크기가 다릅니다/);
  });

  it('탐색창이 패치보다 작으면 던진다', () => {
    const tiny = new FrameMatcher({ frameWidth: W, frameHeight: H, half: 24, search: 1, step: 2, pad: 4 });
    const a = render(0, 0);
    expect(() => tiny.locate(a, a, { fromX: 5, fromY: 5, atX: 5, atY: 5 })).toThrow();
  });

  it('논리 프레임과 실제 이미지 크기가 다르면 자동 환산한다', () => {
    // 논리 1920x1080, 실제 400x300 — 매칭 파라미터는 실제 픽셀 기준이다.
    const scaled = new FrameMatcher({ frameWidth: 1920, frameHeight: 1080, half: 24, search: 40, step: 2, pad: 10 });
    const a = render(0, 0);
    const b = render(10, 0);
    const logicalX = (200 / W) * 1920;
    const logicalY = (150 / H) * 1080;
    const m = scaled.locate(a, b, { fromX: logicalX, fromY: logicalY, atX: logicalX, atY: logicalY });
    expect(m.landedX).toBeCloseTo(((200 - 10) / W) * 1920, 0);
  });
});
