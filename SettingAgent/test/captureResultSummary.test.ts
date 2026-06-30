import { describe, it, expect } from 'vitest';
import { captureResultSummary } from '../web/core.js';

const start = '2026-06-30T00:00:00.000Z';
const end = '2026-06-30T00:02:05.000Z';
const startMs = Date.parse(start);

describe('captureResultSummary (정밀 수집 종료 메시지 박스)', () => {
  it('done → 완료 제목 + 라운드/소요시간/최종화 안내', () => {
    const r = captureResultSummary(
      { state: 'done', runId: 9, done: 10, planned: 10, startedAt: start, endedAt: end },
      startMs + 999999,
    );
    expect(r.title).toBe('정밀 수집 완료');
    expect(r.lines[0]).toBe('수집 #9');
    expect(r.lines[1]).toBe('완료 라운드: 10 / 10');
    expect(r.lines[2]).toBe('소요 시간: 2:05'); // endedAt 기준 고정
    expect(r.lines[r.lines.length - 1]).toContain('최종화');
  });

  it('stopped/error → 제목 분기', () => {
    expect(captureResultSummary({ state: 'stopped', done: 4, planned: 10 }, startMs).title).toBe('정밀 수집 정지됨');
    expect(captureResultSummary({ state: 'error', done: 1, planned: 10 }, startMs).title).toBe('정밀 수집 오류');
  });

  it('runId 없으면 수집# 라인 생략, startedAt 없으면 소요시간 생략', () => {
    const r = captureResultSummary({ state: 'done', done: 3, planned: 3 }, startMs);
    expect(r.lines.some((l) => l.startsWith('수집 #'))).toBe(false);
    expect(r.lines.some((l) => l.startsWith('소요 시간'))).toBe(false);
    expect(r.lines[0]).toBe('완료 라운드: 3 / 3');
  });
});
