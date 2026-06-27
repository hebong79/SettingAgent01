import { describe, it, expect } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import. 타입은 core.d.ts 제공.
import { captureProgress, mapAdvisory, pollPlan } from '../web/core.js';

/**
 * 검증자(qa-tester): SettingViewer core.js 정밀수집 순수로직 (G5).
 * captureProgress(진행률·0 division 방어) / mapAdvisory(자문 배열) / pollPlan(폴링 여부·간격).
 * DOM/fetch 미참조 순수함수.
 */

describe('captureProgress (진행률·0 division 방어)', () => {
  it('done/planned → percent·label', () => {
    expect(captureProgress({ state: 'running', done: 2, planned: 5 })).toEqual({
      percent: 40,
      label: 'running 2/5 (40%)',
    });
  });

  it('planned=0 → percent 0 (0 division 방어)', () => {
    const r = captureProgress({ state: 'idle', done: 0, planned: 0 });
    expect(r.percent).toBe(0);
    expect(r.label).toBe('idle 0/0 (0%)');
  });

  it('done>planned → percent 100 클램프', () => {
    expect(captureProgress({ state: 'done', done: 7, planned: 5 }).percent).toBe(100);
  });

  it('필드 누락/undefined → 0 기본값', () => {
    const r = captureProgress(undefined);
    expect(r.percent).toBe(0);
    expect(r.label).toBe('idle 0/0 (0%)');
  });
});

describe('mapAdvisory (자문 배열)', () => {
  it('latestAdvisory 배열 → 복사 반환', () => {
    const status = { latestAdvisory: ['프리셋 1:1 부족', '수렴됨'] };
    const out = mapAdvisory(status);
    expect(out).toEqual(['프리셋 1:1 부족', '수렴됨']);
    // 복사본(원본과 다른 참조).
    expect(out).not.toBe(status.latestAdvisory);
  });

  it('latestAdvisory 없음 → 빈 배열', () => {
    expect(mapAdvisory({ state: 'running' })).toEqual([]);
    expect(mapAdvisory(undefined)).toEqual([]);
  });
});

describe('pollPlan (폴링 여부·간격)', () => {
  it('running/stopping/finalizing → 폴링 계속', () => {
    expect(pollPlan('running').poll).toBe(true);
    expect(pollPlan('stopping').poll).toBe(true);
    expect(pollPlan('finalizing').poll).toBe(true);
  });

  it('idle/done/stopped/error → 폴링 중지', () => {
    for (const s of ['idle', 'done', 'stopped', 'error']) {
      expect(pollPlan(s).poll).toBe(false);
    }
  });

  it('intervalMs 기본 2000·주입값 반영', () => {
    expect(pollPlan('running').intervalMs).toBe(2000);
    expect(pollPlan('running', 500).intervalMs).toBe(500);
  });
});
