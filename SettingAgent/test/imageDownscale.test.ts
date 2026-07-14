import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { downscaleJpegBase64 } from '../src/util/image.js';

/**
 * 검증자(qa-tester): downscaleJpegBase64 (설계 §결정 C / 구현 §image.ts).
 * 실제 JPEG 바이트를 sharp 로 생성/디코드하여 종횡비 유지 균일 축소·업스케일 없음·
 * 정규화 좌표 불변(강제 16:9 스쿼시/크롭 없음)을 실측 검증한다.
 */

/** width×height 단색 JPEG 를 base64 로 생성. */
async function solidJpegB64(width: number, height: number, rgb = { r: 40, g: 90, b: 160 }): Promise<string> {
  const buf = await sharp({ create: { width, height, channels: 3, background: rgb } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return buf.toString('base64');
}

/** base64 JPEG 의 실제 픽셀 크기를 sharp metadata 로 읽는다. */
async function sizeOf(b64: string): Promise<{ width: number; height: number }> {
  const m = await sharp(Buffer.from(b64, 'base64')).metadata();
  return { width: m.width!, height: m.height! };
}

describe('downscaleJpegBase64', () => {
  it('(a) 1920×1080 → 960×540 (16:9 종횡비 유지)', async () => {
    const src = await solidJpegB64(1920, 1080);
    const out = await downscaleJpegBase64(src, 960);
    const size = await sizeOf(out);
    expect(size.width).toBe(960);
    expect(size.height).toBe(540);
    // 종횡비 불변
    expect(size.width / size.height).toBeCloseTo(1920 / 1080, 5);
  });

  it('(b) 긴변 ≤ imageMaxEdge → 원본 크기 불변(업스케일 없음)', async () => {
    const src = await solidJpegB64(800, 450);
    const out = await downscaleJpegBase64(src, 960);
    const size = await sizeOf(out);
    expect(size.width).toBe(800);
    expect(size.height).toBe(450);
  });

  it('(b2) 상한과 동일한 긴변 → 크기 불변', async () => {
    const src = await solidJpegB64(960, 540);
    const out = await downscaleJpegBase64(src, 960);
    const size = await sizeOf(out);
    expect(size.width).toBe(960);
    expect(size.height).toBe(540);
  });

  it('(c) 4:3 (1200×900) → 960×720 (4:3 유지, 강제 16:9 스쿼시/크롭 없음)', async () => {
    const src = await solidJpegB64(1200, 900);
    const out = await downscaleJpegBase64(src, 960);
    const size = await sizeOf(out);
    expect(size.width).toBe(960);
    expect(size.height).toBe(720);
    // 종횡비 4:3 그대로 (16:9 로 변형되지 않음)
    expect(size.width / size.height).toBeCloseTo(4 / 3, 5);
  });

  it('세로가 긴 3:4 (900×1200) → 720×960 (긴변=세로가 상한)', async () => {
    const src = await solidJpegB64(900, 1200);
    const out = await downscaleJpegBase64(src, 960);
    const size = await sizeOf(out);
    expect(size.width).toBe(720);
    expect(size.height).toBe(960);
  });

  it('(c-불변) 정규화 bbox 불변: 리사이즈 전후 흰 블록의 정규화 좌표가 동일', async () => {
    // 검은 배경 1200×900, 정규화 [0.25,0.5]×[0.25,0.5] 위치에 흰 블록.
    const W = 1200, H = 900;
    const bx0 = 0.25, by0 = 0.25, bx1 = 0.5, by1 = 0.5;
    const blockW = Math.round((bx1 - bx0) * W); // 300
    const blockH = Math.round((by1 - by0) * H); // 225
    const white = await sharp({ create: { width: blockW, height: blockH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .png().toBuffer();
    const srcBuf = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([{ input: white, left: Math.round(bx0 * W), top: Math.round(by0 * H) }])
      .jpeg({ quality: 92 })
      .toBuffer();

    const measureNormBbox = async (buf: Buffer) => {
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * channels;
          // 흰색 판정(JPEG 손실 여유 임계 200).
          if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { x0: minX / width, y0: minY / height, x1: (maxX + 1) / width, y1: (maxY + 1) / height };
    };

    const before = await measureNormBbox(srcBuf);
    const out = await downscaleJpegBase64(srcBuf.toString('base64'), 960);
    const after = await measureNormBbox(Buffer.from(out, 'base64'));

    // 리사이즈된 크기는 960×720(균일 축소) 확인.
    const size = await sizeOf(out);
    expect(size.width).toBe(960);
    expect(size.height).toBe(720);

    // 정규화 좌표가 리사이즈 전후 동일(±2% 이내, JPEG/보간 여유).
    expect(after.x0).toBeCloseTo(before.x0, 1);
    expect(after.y0).toBeCloseTo(before.y0, 1);
    expect(after.x1).toBeCloseTo(before.x1, 1);
    expect(after.y1).toBeCloseTo(before.y1, 1);
    // 원래 의도한 정규화 좌표(0.25~0.5)와도 근접.
    expect(after.x0).toBeCloseTo(0.25, 1);
    expect(after.x1).toBeCloseTo(0.5, 1);
  });

  it('JPEG 재인코딩 결과가 유효한 JPEG(디코드 가능)', async () => {
    const src = await solidJpegB64(1920, 1080);
    const out = await downscaleJpegBase64(src, 960);
    const m = await sharp(Buffer.from(out, 'base64')).metadata();
    expect(m.format).toBe('jpeg');
  });

  it('비-이미지 base64 입력 → throw (호출측이 원본 폴백 처리)', async () => {
    await expect(downscaleJpegBase64(Buffer.from('not-an-image').toString('base64'), 960)).rejects.toThrow();
  });
});
