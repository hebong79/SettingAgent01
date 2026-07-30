// 실카 낮 프레임 예약 캡처(18회차)의 **순수 로직** 단위 테스트.
// 네트워크·파일 IO 는 이 파일에서 다루지 않는다(도구 본체는 라이브 1회 실행으로 배관을 검증했다).

import { describe, expect, it } from 'vitest';
import {
  frameFileNameOf,
  localIsoOf,
  logLine,
  mergeManifest,
  overlayFileNameOf,
  ptzUnchanged,
  stampOf,
  type DaylightFrameEntry,
} from '../src/tools/realCamCapture.js';

function entry(file: string): DaylightFrameEntry {
  return {
    file,
    capturedAtLocal: '2026-07-30 06:33:00 +09:00',
    capturedAtUtc: '2026-07-29T21:33:00.000Z',
    viewerPtz: { pan: 153, tilt: -44.4, zoom: 23.8 },
    viewerPtzAfter: { pan: 153, tilt: -44.4, zoom: 23.8 },
    nativePtz: { panpos: 33299, tiltpos: 786, zoompos: 10677 },
    snapshotPtz: { pan: 153, tilt: -44.4, zoom: 23.8 },
    sha256_12: 'abcdef012345',
    bytes: 84602,
    imgW: 1920,
    imgH: 1080,
    ptzUnchanged: true,
  };
}

describe('파일명·시각 문자열', () => {
  const d = new Date(2026, 6, 30, 6, 33, 4); // 로컬 2026-07-30 06:33:04

  it('stampOf 는 로컬 기준 YYYYMMDD_HHmmss 로 0 패딩한다', () => {
    expect(stampOf(d)).toBe('20260730_063304');
  });

  it('프레임·오버레이 파일명은 같은 stamp 를 공유한다', () => {
    expect(frameFileNameOf(stampOf(d))).toBe('frame_20260730_063304.jpg');
    expect(overlayFileNameOf(stampOf(d))).toBe('overlay_20260730_063304.png');
  });

  it('localIsoOf 는 로컬 시각과 UTC 오프셋을 함께 남긴다', () => {
    const s = localIsoOf(d);
    expect(s.startsWith('2026-07-30 06:33:04 ')).toBe(true);
    expect(s).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('logLine 은 시각·레벨·메시지를 한 줄로 만든다', () => {
    expect(logLine(d, 'ERROR', '캡처 실패')).toMatch(/^\[2026-07-30 06:33:04 [+-]\d{2}:\d{2}\] ERROR 캡처 실패$/);
  });
});

describe('ptzUnchanged — 캡처 전후 동일 판정', () => {
  const before = { pan: 152.999, tilt: -44.4109, zoom: 23.8085 };

  it('완전히 같은 값은 동일이다', () => {
    expect(ptzUnchanged(before, { ...before })).toBe(true);
  });

  it('인코더 1 스텝 수준의 지터는 흡수한다', () => {
    expect(ptzUnchanged(before, { pan: 152.989, tilt: -44.3945, zoom: 23.8064 })).toBe(true);
  });

  it('사람이 만드는 도 단위 변화는 잡아낸다', () => {
    expect(ptzUnchanged(before, { ...before, pan: 154 })).toBe(false);
    expect(ptzUnchanged(before, { ...before, tilt: -40 })).toBe(false);
    expect(ptzUnchanged(before, { ...before, zoom: 30 })).toBe(false);
  });
});

describe('mergeManifest — 누적 병합', () => {
  it('기존 파일이 없으면 항목 1건짜리 매니페스트를 만든다', () => {
    const m = mergeManifest(null, entry('frame_A.jpg'));
    expect(m.frames.map((f) => f.file)).toEqual(['frame_A.jpg']);
    expect(m.createdBy).toContain('realCamCapture.ts');
  });

  it('빈 문자열도 신규로 취급한다', () => {
    expect(mergeManifest('   ', entry('frame_A.jpg')).frames).toHaveLength(1);
  });

  it('기존 항목을 보존하고 뒤에 덧붙인다', () => {
    const first = mergeManifest(null, entry('frame_A.jpg'));
    const second = mergeManifest(JSON.stringify(first), entry('frame_B.jpg'));
    expect(second.frames.map((f) => f.file)).toEqual(['frame_A.jpg', 'frame_B.jpg']);
    expect(second.frames[0].sha256_12).toBe('abcdef012345');
  });

  it('기존 내용이 깨졌으면 덮어쓰지 않고 던진다(희소 자원 목록 보호)', () => {
    expect(() => mergeManifest('{ 깨진 json', entry('frame_B.jpg'))).toThrow(/파싱 실패/);
  });

  it('frames 배열이 없는 JSON 도 덮어쓰지 않는다', () => {
    expect(() => mergeManifest('{"note":"x"}', entry('frame_B.jpg'))).toThrow(/frames 배열/);
  });
});
