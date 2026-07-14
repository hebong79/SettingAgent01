import { describe, it, expect } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import. 타입은 core.d.ts 제공.
import { captureProgress, mapAdvisory, pollPlan, captureUiState } from '../web/core.js';

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

describe('captureUiState (F1 — 정지버튼 UI 의도·라우트 거부조건 대칭)', () => {
  // 백엔드 라우트 거부조건과의 대칭:
  //   stop 400 `not running`  ↔ stopDisabled = state !== 'running'
  //   finalize 409 active      ↔ finalizeDisabled = active(running/stopping/finalizing)
  //   중복 start               ↔ startDisabled = active

  it("running → 정지만 허용(stopDisabled=false), start/finalize 금지", () => {
    expect(captureUiState('running')).toEqual({
      startDisabled: true,
      stopDisabled: false,
      finalizeDisabled: true,
      suppressFrameMsg: false,
      stoppingNote: false,
    });
  });

  it("stopping → 전 버튼 비활성 + 프레임틱 문구 억제 + '정지 중…' 안내", () => {
    expect(captureUiState('stopping')).toEqual({
      startDisabled: true,
      stopDisabled: true,
      finalizeDisabled: true,
      suppressFrameMsg: true,
      stoppingNote: true,
    });
  });

  it('finalizing → 전 버튼 비활성(문구 억제/안내는 없음)', () => {
    expect(captureUiState('finalizing')).toEqual({
      startDisabled: true,
      stopDisabled: true,
      finalizeDisabled: true,
      suppressFrameMsg: false,
      stoppingNote: false,
    });
  });

  it('비활성 상태(idle/done/stopped/error) → start/finalize 허용, stop 금지', () => {
    const expected = {
      startDisabled: false,
      stopDisabled: true,
      finalizeDisabled: false,
      suppressFrameMsg: false,
      stoppingNote: false,
    };
    for (const s of ['idle', 'done', 'stopped', 'error']) {
      expect(captureUiState(s)).toEqual(expected);
    }
  });

  it('대칭 불변식: stopDisabled 는 running 에서만 false, 그 외 전부 true', () => {
    for (const s of ['idle', 'stopping', 'finalizing', 'done', 'stopped', 'error']) {
      expect(captureUiState(s).stopDisabled).toBe(true);
    }
    expect(captureUiState('running').stopDisabled).toBe(false);
  });

  it('대칭 불변식: active(running/stopping/finalizing) 에서만 start/finalize 금지', () => {
    for (const s of ['running', 'stopping', 'finalizing']) {
      const ui = captureUiState(s);
      expect(ui.startDisabled).toBe(true);
      expect(ui.finalizeDisabled).toBe(true);
    }
    for (const s of ['idle', 'done', 'stopped', 'error']) {
      const ui = captureUiState(s);
      expect(ui.startDisabled).toBe(false);
      expect(ui.finalizeDisabled).toBe(false);
    }
  });

  it('불변식: stopping 에서만 suppressFrameMsg·stoppingNote 활성(프레임틱 덮어쓰기 방지)', () => {
    for (const s of ['idle', 'running', 'finalizing', 'done', 'stopped', 'error']) {
      const ui = captureUiState(s);
      expect(ui.suppressFrameMsg).toBe(false);
      expect(ui.stoppingNote).toBe(false);
    }
    expect(captureUiState('stopping').suppressFrameMsg).toBe(true);
    expect(captureUiState('stopping').stoppingNote).toBe(true);
  });
});
