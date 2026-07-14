import { describe, it, expect } from 'vitest';
import { splitJpegFrames } from '../src/clients/mjpeg.js';

/** SOI(FF D8) + payload + EOI(FF D9) 로 유효 JPEG 프레임 1개 생성(페이로드에 FF D8/D9 없음). */
function jpeg(payload: number[]): Buffer {
  return Buffer.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);
}

/** 멀티파트 경계 텍스트(SOI 앞 잡음) — 파서가 스킵해야 함. */
function boundary(len: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${len}\r\n\r\n`, 'ascii');
}

/** CameraClient.streamMjpeg 와 동일한 누적 파싱을 재현(청크 순차 공급 → 프레임 수집). */
function feedChunks(chunks: Buffer[]): Buffer[] {
  let buf: Buffer = Buffer.alloc(0);
  const out: Buffer[] = [];
  for (const c of chunks) {
    buf = Buffer.concat([buf, c]);
    const { frames, rest } = splitJpegFrames(buf);
    out.push(...frames);
    buf = rest;
  }
  return out;
}

describe('splitJpegFrames — 순수 SOI/EOI 파서', () => {
  it('단일 프레임 → frames 1개, rest 빈 버퍼', () => {
    const f = jpeg([0x00, 0x11, 0x22, 0x33]);
    const { frames, rest } = splitJpegFrames(f);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(f);
    expect(rest).toHaveLength(0);
  });

  it('한 청크 다중 프레임 → 전부 분리 + 빈 rest', () => {
    const f1 = jpeg([0x01, 0x02]);
    const f2 = jpeg([0xaa, 0xbb, 0xcc]);
    const f3 = jpeg([0x10]);
    const { frames, rest } = splitJpegFrames(Buffer.concat([f1, f2, f3]));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual(f1);
    expect(frames[1]).toEqual(f2);
    expect(frames[2]).toEqual(f3);
    expect(rest).toHaveLength(0);
  });

  it('EOI 미도래 → frames 빈 배열, rest 는 SOI 부터 누적', () => {
    const partial = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03]); // EOI 없음
    const { frames, rest } = splitJpegFrames(partial);
    expect(frames).toHaveLength(0);
    expect(rest).toEqual(partial); // SOI 부터 그대로 보존
  });

  it('SOI 앞 boundary/헤더 잡음 → 스킵하고 프레임만 추출', () => {
    const f = jpeg([0x05, 0x06, 0x07]);
    const buf = Buffer.concat([boundary(f.length), f]);
    const { frames, rest } = splitJpegFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(f); // 경계 텍스트 미포함
    expect(rest).toHaveLength(0);
  });

  it('SOI 없고 말단 단일 0xFF → 1바이트 rest 보존(다음 청크 D8 후보)', () => {
    const buf = Buffer.from([0x00, 0x11, 0x22, 0xff]);
    const { frames, rest } = splitJpegFrames(buf);
    expect(frames).toHaveLength(0);
    expect(rest).toEqual(Buffer.from([0xff]));
  });

  it('SOI 없고 말단 non-FF → rest 빈 버퍼(잡음 전량 폐기)', () => {
    const { frames, rest } = splitJpegFrames(Buffer.from([0x00, 0x11, 0x22]));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(0);
  });

  it('빈 버퍼 → frames 빈, rest 빈', () => {
    const { frames, rest } = splitJpegFrames(Buffer.alloc(0));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(0);
  });

  it('청크 경계가 마커(FF|D8, FF|D9) 중간을 갈라도 이월 후 재조립 parity(모든 분할점)', () => {
    const f1 = jpeg([0x01, 0x02, 0x03]);
    const f2 = jpeg([0xaa, 0xbb]);
    const combined = Buffer.concat([boundary(f1.length), f1, boundary(f2.length), f2]);
    // 모든 단일 분할점에서 2청크로 나눠 공급 → 항상 [f1, f2] 재조립.
    for (let i = 0; i <= combined.length; i++) {
      const frames = feedChunks([combined.subarray(0, i), combined.subarray(i)]);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual(f1);
      expect(frames[1]).toEqual(f2);
    }
  });

  it('바이트 1개씩 공급해도 프레임 완전 재조립(극단 경계)', () => {
    const f1 = jpeg([0x09, 0x08]);
    const f2 = jpeg([0x07]);
    const combined = Buffer.concat([f1, f2]);
    const chunks = [...combined].map((b) => Buffer.from([b]));
    const frames = feedChunks(chunks);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(f1);
    expect(frames[1]).toEqual(f2);
  });
});
