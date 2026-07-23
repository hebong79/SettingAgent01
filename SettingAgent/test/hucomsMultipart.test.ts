import { describe, it, expect } from 'vitest';
import { parseMultipartFrame } from '../src/clients/hucoms/HucomsClient.js';

const marker = Buffer.from('--boundary');

describe('parseMultipartFrame', () => {
  it('정상 프레임(content-length): payload 정확 추출 + nextOffset 이 payload 끝', () => {
    const header = '\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\n\r\n';
    const buffer = Buffer.concat([marker, Buffer.from(header), Buffer.from('HELLO'), Buffer.from('\r\n')]);
    const parsed = parseMultipartFrame(buffer, marker, marker.length);
    expect(parsed).not.toBeNull();
    expect(parsed!.frame.toString()).toBe('HELLO');
    expect(parsed!.nextOffset).toBe(marker.length + Buffer.byteLength(header) + 5);
  });

  it('정상 프레임(content-length 없음): 다음 마커까지 스캔 + 후행 \\r\\n 절삭', () => {
    const header = '\r\nContent-Type: image/jpeg\r\n\r\n';
    const buffer = Buffer.concat([
      marker, Buffer.from(header), Buffer.from('DATA'), Buffer.from('\r\n'), marker, Buffer.from('\r\n'),
    ]);
    const parsed = parseMultipartFrame(buffer, marker, marker.length);
    expect(parsed).not.toBeNull();
    expect(parsed!.frame.toString()).toBe('DATA');
    // 다음 마커 시작 위치 = payloadStart + 'DATA'(4) + '\r\n'(2).
    expect(parsed!.nextOffset).toBe(marker.length + Buffer.byteLength(header) + 4 + 2);
  });

  it('분할 도착(헤더 미완결): null', () => {
    const buffer = Buffer.concat([marker, Buffer.from('\r\nContent-Type: image/jpeg')]); // \r\n\r\n 미도착
    expect(parseMultipartFrame(buffer, marker, marker.length)).toBeNull();
  });

  it('분할 도착(content-length payload 미도착): null', () => {
    const buffer = Buffer.concat([marker, Buffer.from('\r\nContent-Length: 10\r\n\r\n'), Buffer.from('AB')]); // 10 중 2
    expect(parseMultipartFrame(buffer, marker, marker.length)).toBeNull();
  });

  it('마커 미발견(스캔 경로에 다음 마커 없음): null', () => {
    const buffer = Buffer.concat([
      marker, Buffer.from('\r\nContent-Type: image/jpeg\r\n\r\n'), Buffer.from('DATA 후행 마커 없음'),
    ]);
    expect(parseMultipartFrame(buffer, marker, marker.length)).toBeNull();
  });
});
