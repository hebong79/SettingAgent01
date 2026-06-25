/**
 * JPEG 바이트에서 width/height 를 읽는다. SOF0~SOF15(0xC0~0xCF, C4/C8/CC 제외) 마커를 탐색.
 * VPD 가 반환하는 픽셀 bbox 를 정규화하기 위해 캡처 이미지의 해상도가 필요하다.
 */
export function readJpegSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('JPEG 시그니처가 아님');
  }
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOFn (프레임 시작) 마커: 0xC0~0xCF 중 0xC4(DHT)/0xC8(JPG)/0xCC(DAC) 제외.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // 그 외 마커: 길이(2바이트) 만큼 건너뜀.
    const segLen = buf.readUInt16BE(offset + 2);
    offset += 2 + segLen;
  }
  throw new Error('JPEG SOF 마커를 찾지 못함');
}
