import { describe, expect, it } from 'vitest';
// web/core.js 는 브라우저용 순수 ESM(타입 선언은 core.d.ts).
import { lensCalibView } from '../web/core.js';

/**
 * 렌즈 캘리브레이션 UI 뷰(순수) 검증. discoverView 테스트 패턴 미러.
 * 브라우저 DOM 자동화가 없으므로 UI 판단은 이 순수함수로 봉인한다.
 */
describe('lensCalibView', () => {
  it('상태 없음/idle → 0% · 시작 가능 · 정지 불가 · 폴 안 함', () => {
    for (const s of [null, undefined, {}, { state: 'idle' }]) {
      const v = lensCalibView(s);
      expect(v.percent).toBe(0);
      expect(v.label).toBe('idle 0/0');
      expect(v.startDisabled).toBe(false);
      expect(v.stopDisabled).toBe(true);
      expect(v.applyVisible).toBe(false);
      expect(v.polling).toBe(false);
    }
  });

  it('running → 백분율·시작 잠금·정지 허용·폴 켬', () => {
    const v = lensCalibView({ state: 'running', mode: 'full', done: 34, total: 112 });
    expect(v.percent).toBe(30);
    expect(v.label).toBe('running 34/112 (30%)');
    expect(v.startDisabled).toBe(true);
    expect(v.stopDisabled).toBe(false);
    expect(v.polling).toBe(true);
  });

  it('stopping → 폴은 계속하되 정지 버튼도 잠근다(중복 중지 요청 방지)', () => {
    const v = lensCalibView({ state: 'stopping', mode: 'full', done: 34, total: 112 });
    expect(v.polling).toBe(true);
    expect(v.startDisabled).toBe(true);
    expect(v.stopDisabled).toBe(true);
    expect(v.label).toBe('정지 중 — 카메라 복귀');
  });

  it('done → 100% 로 마감하고 폴을 멈춘다(마지막 샘플이 실패해 done<total 이어도)', () => {
    const v = lensCalibView({ state: 'done', mode: 'full', done: 110, total: 112, result: { saved: true } });
    expect(v.percent).toBe(100);
    expect(v.polling).toBe(false);
    expect(v.startDisabled).toBe(false);
  });

  it('total 0 → 0 나눗셈 방어', () => {
    expect(lensCalibView({ state: 'running', done: 5, total: 0 }).percent).toBe(0);
  });

  it('done 이 total 을 넘어도 100% 를 넘지 않는다', () => {
    expect(lensCalibView({ state: 'running', done: 200, total: 112 }).percent).toBe(100);
  });

  it('error → 사유를 라벨에 싣고 tone=error', () => {
    const v = lensCalibView({ state: 'error', mode: 'full', done: 3, total: 112, error: 'fetch failed' });
    expect(v.label).toContain('fetch failed');
    expect(v.tone).toBe('error');
    expect(v.startDisabled).toBe(false);
    expect(v.polling).toBe(false);
  });

  it('aborted → tone=warn · 진행량 유지(어디까지 갔는지 남긴다)', () => {
    const v = lensCalibView({ state: 'aborted', mode: 'full', done: 40, total: 112 });
    expect(v.label).toBe('중지됨 40/112');
    expect(v.percent).toBe(36);
    expect(v.tone).toBe('warn');
  });

  describe('applyVisible — 적용할 표가 실제로 저장됐을 때만', () => {
    it('full 완료 + saved → 노출', () => {
      expect(lensCalibView({ state: 'done', mode: 'full', result: { saved: true } }).applyVisible).toBe(true);
    });
    it('distortion 완료 + saved(A/B adopt) → 노출', () => {
      expect(lensCalibView({ state: 'done', mode: 'distortion', result: { saved: true } }).applyVisible).toBe(true);
    });
    it('distortion 완료 but reject(saved:false) → 숨김', () => {
      expect(lensCalibView({ state: 'done', mode: 'distortion', result: { saved: false } }).applyVisible).toBe(false);
    });
    it('verify 는 표를 만들지 않으므로 완료여도 숨김', () => {
      expect(lensCalibView({ state: 'done', mode: 'verify', result: { saved: false } }).applyVisible).toBe(false);
    });
    it('running 중에는 숨김', () => {
      expect(lensCalibView({ state: 'running', mode: 'full', result: { saved: true } }).applyVisible).toBe(false);
    });
  });
});
