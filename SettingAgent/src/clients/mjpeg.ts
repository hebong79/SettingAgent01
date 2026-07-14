/**
 * MJPEG 스트림 프레임 분리(순수·무상태) — 설계서 §3 단계1.
 *
 * multipart/x-mixed-replace 본문에서 JPEG 를 SOI(0xFFD8)~EOI(0xFFD9) 기준으로 잘라낸다.
 * boundary/헤더 텍스트는 SOI 앞 잡음으로 자연히 스킵된다(문서 §5.2 권고 알고리즘).
 *
 * DOM/네트워크 미참조 → 직접 유닛테스트 가능.
 */

const SOI_0 = 0xff;
const SOI_1 = 0xd8;
const EOI_1 = 0xd9;

/**
 * 누적 버퍼에서 완성된 JPEG 프레임을 모두 잘라 반환하고, 미완성 잔여를 rest 로 돌려준다.
 * - frames: 완성된 JPEG(각각 FF D8 ~ FF D9 포함) 배열(입력 순서).
 * - rest: 아직 EOI 가 오지 않은 마지막 부분 프레임(다음 청크와 이어붙일 잔여).
 */
export function splitJpegFrames(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let cursor = 0;

  for (;;) {
    // 다음 SOI(FF D8) 탐색 — 그 앞의 boundary/헤더/잡음은 버린다.
    const soi = indexOfMarker(buf, SOI_1, cursor);
    if (soi < 0) {
      // SOI 없음 → 프레임 없음. 마지막 바이트가 FF 면 다음 청크의 D8 후보라 1바이트 보존.
      const tailStart = buf.length > 0 && buf[buf.length - 1] === SOI_0 ? buf.length - 1 : buf.length;
      return { frames, rest: buf.subarray(tailStart) };
    }
    // SOI 이후에서 EOI(FF D9) 탐색.
    const eoi = indexOfMarker(buf, EOI_1, soi + 2);
    if (eoi < 0) {
      // EOI 미도래 → SOI 부터 잔여 보존(다음 청크와 이어붙임).
      return { frames, rest: buf.subarray(soi) };
    }
    // 완성 프레임: SOI..EOI(EOI 2바이트 포함).
    frames.push(buf.subarray(soi, eoi + 2));
    cursor = eoi + 2;
  }
}

/** buf[from..] 에서 (0xFF, second) 2바이트 마커의 시작 인덱스를 찾는다. 없으면 -1. */
function indexOfMarker(buf: Buffer, second: number, from: number): number {
  for (let i = Math.max(0, from); i + 1 < buf.length; i++) {
    if (buf[i] === SOI_0 && buf[i + 1] === second) return i;
  }
  return -1;
}
