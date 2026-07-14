import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { smartResizeJpegBase64 } from '../src/util/image.js';
import { normalizeQuad } from '../src/domain/geometry.js';

/**
 * 검증자(qa-tester): src/util/image.ts smartResizeJpegBase64 (설계 §3-1·§6, 성공기준 2).
 * Qwen2.5-VL smart-resize 고정점: 양 변 28의 배수 스냅 + 총픽셀 ≤ MAX_PIXELS(1.0M) +
 * 종횡비 유지(±1 factor) + 반환 (W,H) 정확(재인코딩 실측). 업스케일 없음.
 * 좌표 정규화 기준이 "전송 (W,H)"임을 파이프라인 수치로 확인(성공기준 1).
 */

const MAX_PIXELS = 1280 * 28 * 28; // 1,003,520

async function makeJpeg(w: number, h: number): Promise<string> {
  return (
    await sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 60, b: 120 } } })
      .jpeg({ quality: 90 })
      .toBuffer()
  ).toString('base64');
}

describe('smartResizeJpegBase64 (Qwen2.5-VL 28정렬 리사이저)', () => {
  it('(a) 1920×1080 @1288 → 양변 28배수 & ≤MAX_PIXELS', async () => {
    const b64 = await makeJpeg(1920, 1080);
    const { width: W, height: H, base64 } = await smartResizeJpegBase64(b64, 1288);
    expect(W % 28).toBe(0);
    expect(H % 28).toBe(0);
    expect(W * H).toBeLessThanOrEqual(MAX_PIXELS);
    expect(W).toBe(1288); // 46×28
    expect(H).toBe(728); // 26×28
    // 반환 (W,H) 는 재인코딩 실측치와 일치해야 한다(추정 아님).
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(H);
  });

  it('(b) 종횡비 근사(28 스냅 오차 ±1 factor 이내)', async () => {
    const b64 = await makeJpeg(1920, 1080); // 16:9 = 1.7778
    const { width: W, height: H } = await smartResizeJpegBase64(b64, 1288);
    const srcAr = 1920 / 1080;
    const outAr = W / H;
    // 28 스냅에 의한 변형이 상대 1.5% 이내(설계 §10-3: <1.1%).
    expect(Math.abs(outAr - srcAr) / srcAr).toBeLessThan(0.015);
  });

  it('(c) 소형 입력(300×200)도 28 배수로 스냅(업스케일 없음)', async () => {
    const b64 = await makeJpeg(300, 200);
    const { width: W, height: H } = await smartResizeJpegBase64(b64, 1288);
    expect(W % 28).toBe(0);
    expect(H % 28).toBe(0);
    // 업스케일 금지: 긴변이 원본(300)을 넘지 않음(28 반올림 오차 이내).
    expect(W).toBeLessThanOrEqual(300 + 28);
    expect(W).toBe(308); // roundToFactor(300)=11×28
    expect(H).toBe(196); // roundToFactor(200)=7×28
  });

  it('(d) 4:3 대형(1600×1200) → MAX_PIXELS 초과 시 재축소 후 28배수·상한 엄수', async () => {
    const b64 = await makeJpeg(1600, 1200);
    const { width: W, height: H } = await smartResizeJpegBase64(b64, 1288);
    expect(W % 28).toBe(0);
    expect(H % 28).toBe(0);
    expect(W * H).toBeLessThanOrEqual(MAX_PIXELS);
  });

  it('(e) 반환 base64 는 유효 JPEG(sharp 디코드 성공)', async () => {
    const b64 = await makeJpeg(1024, 768);
    const { base64 } = await smartResizeJpegBase64(b64, 1288);
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeGreaterThan(0);
  });

  it('(f) 비이미지 입력 → throw(호출측 null 폴백)', async () => {
    const notImg = Buffer.from('not an image at all').toString('base64');
    await expect(smartResizeJpegBase64(notImg, 1288)).rejects.toThrow();
  });

  it('(성공기준 1) 파이프라인 수치: 1920×1080→1288×728 전송, 픽셀 [644,364]→정규화 {0.5,0.5}', async () => {
    const b64 = await makeJpeg(1920, 1080);
    const { width: W, height: H } = await smartResizeJpegBase64(b64, 1288);
    // 전송 (W,H) 기준으로 정규화 — 원본 1920×1080 이 아니라 1288×728 이 분모.
    const q = normalizeQuad(
      [
        [644, 364],
        [644, 364],
        [644, 364],
        [644, 364],
      ],
      W,
      H,
    );
    q.forEach((p) => {
      expect(p.x).toBeCloseTo(0.5, 6);
      expect(p.y).toBeCloseTo(0.5, 6);
    });
  });
});
