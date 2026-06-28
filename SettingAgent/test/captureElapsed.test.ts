import { describe, it, expect } from 'vitest';
import { captureElapsedMs, formatElapsed } from '../web/core.js';

describe('captureElapsedMs (정밀 수집 경과)', () => {
  const start = '2026-06-27T00:00:00.000Z';
  const startMs = Date.parse(start);

  it('startedAt 없으면 null', () => {
    expect(captureElapsedMs({}, startMs)).toBeNull();
    expect(captureElapsedMs(null, startMs)).toBeNull();
  });

  it('진행 중: now 까지 경과', () => {
    expect(captureElapsedMs({ startedAt: start }, startMs + 65000)).toBe(65000);
  });

  it('종료 후: endedAt 기준 총 소요(now 무관 고정)', () => {
    const ended = '2026-06-27T00:01:30.000Z';
    expect(captureElapsedMs({ startedAt: start, endedAt: ended }, startMs + 999999)).toBe(90000);
  });

  it('음수 방지(now < startedAt)', () => {
    expect(captureElapsedMs({ startedAt: start }, startMs - 5000)).toBe(0);
  });

  it('잘못된 날짜는 null', () => {
    expect(captureElapsedMs({ startedAt: 'nope' }, startMs)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('1시간 미만 M:SS', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5000)).toBe('0:05');
    expect(formatElapsed(65000)).toBe('1:05');
    expect(formatElapsed(599000)).toBe('9:59');
  });

  it('1시간 이상 H:MM:SS', () => {
    expect(formatElapsed(3600000)).toBe('1:00:00');
    expect(formatElapsed(3661000)).toBe('1:01:01');
  });

  it('null/undefined → 0:00', () => {
    expect(formatElapsed(null)).toBe('0:00');
    expect(formatElapsed(undefined)).toBe('0:00');
  });
});
