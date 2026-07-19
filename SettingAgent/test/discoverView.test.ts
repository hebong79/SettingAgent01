import { describe, it, expect } from 'vitest';
import { discoverView } from '../web/core.js';

// 검증 대상: web/core.js discoverView(status) — /discover/status → UI 뷰(순수).
// 경계면: 입력 shape 은 src/calibrate/types.ts:DiscoverStatus 와 1:1
//   { state: 'idle'|'running'|'done'|'error', done, total, found }.
// 설계서 §4(20260719_185846_LPD검지_3모드콤보박스_설계서.md) 검증표 전 케이스.
describe('discoverView (LPD 앞면중심 LOOP discovery 상태 → UI 뷰)', () => {
  it('idle({}) → percent 0, poll/disable 없음, 기본 라벨', () => {
    expect(discoverView({})).toEqual({
      percent: 0,
      label: 'idle 0/0 (found 0)',
      runDisabled: false,
      polling: false,
    });
  });

  it('running done3/total10 found2 → percent 30, poll·disable true, 진행·found 라벨', () => {
    expect(discoverView({ state: 'running', done: 3, total: 10, found: 2 })).toEqual({
      percent: 30,
      label: 'running 3/10 (found 2)',
      runDisabled: true,
      polling: true,
    });
  });

  it('done 10/10 found7 → percent 100, poll·disable false(종료), 완료 라벨', () => {
    expect(discoverView({ state: 'done', done: 10, total: 10, found: 7 })).toEqual({
      percent: 100,
      label: 'done 10/10 (found 7)',
      runDisabled: false,
      polling: false,
    });
  });

  it('total 0(running 0/0) → percent 0(0나눗셈 방어, NaN 아님)', () => {
    const v = discoverView({ state: 'running', done: 0, total: 0, found: 0 });
    expect(v.percent).toBe(0);
    expect(Number.isNaN(v.percent)).toBe(false);
    // running 이므로 폴/실행버튼 disable 은 유지(대상 0 안내는 discStart 가 별도 처리).
    expect(v.runDisabled).toBe(true);
    expect(v.polling).toBe(true);
  });

  it('null status → idle 폴백(안전 기본값)', () => {
    expect(discoverView(null)).toEqual({
      percent: 0,
      label: 'idle 0/0 (found 0)',
      runDisabled: false,
      polling: false,
    });
  });

  it('undefined status → idle 폴백(안전 기본값)', () => {
    expect(discoverView(undefined)).toEqual({
      percent: 0,
      label: 'idle 0/0 (found 0)',
      runDisabled: false,
      polling: false,
    });
  });

  it('found 카운트가 라벨에 반영(진행 중 발견 슬롯 수)', () => {
    expect(discoverView({ state: 'running', done: 5, total: 8, found: 3 }).label).toBe(
      'running 5/8 (found 3)',
    );
    // found 만 다른 두 입력의 라벨이 구별되는지(카운트 반영 증명).
    expect(discoverView({ state: 'running', done: 5, total: 8, found: 0 }).label).toBe(
      'running 5/8 (found 0)',
    );
  });

  it('percent 는 Math.round(비정수 비율 반올림)', () => {
    // 1/3 = 33.33.. → 33
    expect(discoverView({ state: 'running', done: 1, total: 3, found: 0 }).percent).toBe(33);
    // 2/3 = 66.66.. → 67
    expect(discoverView({ state: 'running', done: 2, total: 3, found: 0 }).percent).toBe(67);
  });

  it("error 상태 → 종료로 취급(poll/disable 없음), 라벨에 state 반영", () => {
    const v = discoverView({ state: 'error', done: 2, total: 10, found: 1 });
    expect(v.runDisabled).toBe(false);
    expect(v.polling).toBe(false);
    expect(v.label).toBe('error 2/10 (found 1)');
    expect(v.percent).toBe(20);
  });

  it('runDisabled === polling === (state === "running") 불변식', () => {
    for (const state of ['idle', 'running', 'done', 'error']) {
      const v = discoverView({ state, done: 1, total: 4, found: 0 });
      const isRunning = state === 'running';
      expect(v.runDisabled).toBe(isRunning);
      expect(v.polling).toBe(isRunning);
    }
  });

  it('필드 부분 누락 → 각 0 폴백(done/total/found ?? 0)', () => {
    // state 만 있고 카운트 없음 → 0/0, found 0, percent 0.
    expect(discoverView({ state: 'running' })).toEqual({
      percent: 0,
      label: 'running 0/0 (found 0)',
      runDisabled: true,
      polling: true,
    });
  });
});
