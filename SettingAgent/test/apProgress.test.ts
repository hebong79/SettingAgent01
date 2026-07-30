// ★ 21회차 Phase 3 — 자동검출 **진행바**(마스터 요청). 봉인하는 규율은 하나다: **거짓 진행률 금지.**
//
//   ⓐ 예상 시간까지는 `경과 ÷ 예상` 확정값
//   ⓑ 예상 시간을 넘기면 **불확정**(ratio null · aria-valuenow **없음**) + "예상 시간 초과 — 계속 진행 중"
//   ⓒ **끝나기 전에 100% 를 보이지 않는다**(상한 0.99)
//   ⓓ 완료는 시간이 아니라 **결과**(검출 면수 · 프레임 해시 · 실제 소요)로 말한다
//
// ETA 값은 구현자 라이브 실측이다(모듈 주석에 근거 병기). 이 테스트는 그 값이 조용히 바뀌는 것도 잡는다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { apDoneSummary, apEta, apProgressAria, apProgressState } from '../web/apProgress.js';

describe('apProgress — 진행 상태 판정', () => {
  it('ⓐ 예상 시간 내에는 확정값(경과÷예상)이다', () => {
    const s = apProgressState(3_000, 12_000);
    expect(s.determinate).toBe(true);
    expect(s.ratio).toBeCloseTo(0.25, 12);
    expect(s.percent).toBe(25);
    expect(s.overdue).toBe(false);
    expect(s.label).toBe('25%');
  });

  it('ⓒ 끝나기 전에는 100% 를 보이지 않는다(상한 0.99)', () => {
    const s = apProgressState(11_999, 12_000);
    expect(s.determinate).toBe(true);
    expect(s.percent).toBe(99);
    expect(s.ratio).toBeLessThan(1);
  });

  it('ⓑ 예상 시간을 넘기면 불확정으로 전환하고 문구를 바꾼다', () => {
    const s = apProgressState(12_000, 12_000);
    expect(s.determinate).toBe(false);
    expect(s.ratio).toBeNull();
    expect(s.percent).toBeNull();
    expect(s.overdue).toBe(true);
    expect(s.label).toBe('예상 시간 초과 — 계속 진행 중');
    // 훨씬 더 지나도 여전히 불확정이다(시간으로 채우지 않는다).
    expect(apProgressState(600_000, 12_000).determinate).toBe(false);
  });

  it('예상 시간을 모르면(0) 처음부터 불확정이며 "초과"라고 말하지 않는다', () => {
    const s = apProgressState(5_000, 0);
    expect(s.determinate).toBe(false);
    expect(s.overdue).toBe(false);
    expect(s.label).toBe('진행 중');
  });

  it('경과가 음수·비유한이면 0 으로 본다(NaN 이 화면에 나가지 않는다)', () => {
    expect(apProgressState(-1, 12_000).percent).toBe(0);
    expect(apProgressState(Number.NaN, 12_000).percent).toBe(0);
  });

  it('★ 불확정 구간에서는 aria-valuenow 를 **주지 않는다**(0% 라고 말하면 그것도 거짓이다)', () => {
    const det = apProgressAria(apProgressState(6_000, 12_000));
    expect(det['aria-valuenow']).toBe('50');
    expect(det.role).toBe('progressbar');
    expect(det['aria-valuemin']).toBe('0');
    expect(det['aria-valuemax']).toBe('100');

    const ind = apProgressAria(apProgressState(20_000, 12_000));
    expect('aria-valuenow' in ind).toBe(false);
    expect(ind['aria-valuetext']).toBe('예상 시간 초과 — 계속 진행 중');
  });
});

describe('apEta — 예상 시간(실측 근거)', () => {
  it('시뮬 현재뷰 12초 · 실카 현재뷰 15초(RTSP 가 느리다)', () => {
    expect(apEta({ currentView: true })).toEqual({ ms: 12_000, text: '약 12초 — 카메라 이동 없음' });
    expect(apEta({ currentView: true, real: true })).toEqual({ ms: 15_000, text: '약 15초 — 카메라 이동 없음(실카 RTSP)' });
  });

  it('다시점 합의 70초 · 단일시점 프리셋 12초 — 종전 문구를 바꾸지 않는다', () => {
    expect(apEta({ consensus: true })).toEqual({ ms: 70_000, text: '약 70초 — 6시점 촬영' });
    expect(apEta({})).toEqual({ ms: 12_000, text: '약 12초' });
  });

  it('현재뷰가 다시점보다 우선한다(서버가 현재뷰에서 디더를 강제 OFF 한다 — 20회차)', () => {
    expect(apEta({ currentView: true, consensus: true }).ms).toBe(12_000);
  });

  it('실측 근거가 주석에 남아 있다(값만 바뀌고 근거가 사라지는 것을 막는다)', () => {
    const src = readFileSync('web/apProgress.js', 'utf8');
    for (const n of ['12140', '12104', '14519', '14738', '68759']) expect(src).toContain(n);
  });
});

describe('apDoneSummary — 완료는 결과로 말한다', () => {
  it('검출 면수 · 프레임 해시 · 실제 소요', () => {
    expect(apDoneSummary({ ok: true, quads: 7, frameHash: '6006a034bfe2', elapsedMs: 12_345 })).toBe(
      '완료 — 검출 7면 · 프레임 6006a034bfe2 · 소요 12.3초',
    );
  });

  it('값이 없으면 지어내지 않고 — 로 남긴다', () => {
    expect(apDoneSummary({ ok: true, elapsedMs: 1_000 })).toBe('완료 — 검출 면수 — · 프레임 — · 소요 1.0초');
  });

  it('실패는 사유를 적는다', () => {
    expect(apDoneSummary({ ok: false, reason: '거부 — 설치고', elapsedMs: 2_500 })).toBe('실패 — 거부 — 설치고 (소요 2.5초)');
    expect(apDoneSummary({ ok: false, elapsedMs: 0 })).toBe('실패 — 사유 미상 (소요 0.0초)');
  });
});

describe('진행바 DOM·CSS·배선 봉인', () => {
  const html = readFileSync('web/index.html', 'utf8');
  const css = readFileSync('web/app.css', 'utf8');
  const app = readFileSync('web/app.js', 'utf8');

  it('막대 DOM 이 progressbar 역할과 min/max 를 갖는다', () => {
    expect(html).toMatch(/id="ap-progress"[^>]*class="ap-progress"[^>]*hidden/);
    expect(html).toMatch(/id="ap-progress-track"[^>]*role="progressbar"/);
    expect(html).toMatch(/aria-valuemin="0"/);
    expect(html).toMatch(/aria-valuemax="100"/);
    expect(html).toMatch(/id="ap-progress-fill"/);
    expect(html).toMatch(/id="ap-progress-label"/);
  });

  it('기존 텍스트 메시지(#ap-msg)를 지우지 않았다 — 순수 가산', () => {
    expect(html).toMatch(/<div id="ap-msg" class="map-msg"><\/div>/);
    expect(app).toContain('setApMsg(');
  });

  it('CSS 는 기존 색 토큰만 쓰고 불확정은 채우지 않는다(왕복 띠)', () => {
    expect(css).toMatch(/\.ap-progress-fill\s*{[^}]*background:\s*var\(--accent\)/);
    expect(css).toMatch(/\.ap-progress-track\s*{[^}]*background:\s*var\(--line-soft\)/);
    expect(css).toMatch(/\.indeterminate .ap-progress-fill\s*{[^}]*animation:\s*ap-progress-slide/);
    // 새 색 팔레트(하드코딩 hex)를 만들지 않았다.
    const block = css.slice(css.indexOf('.ap-progress'), css.indexOf('/* 카메라 PTZ 프리셋 편집'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    // 모션 저감 사용자를 위한 대안이 있다.
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*ap-progress-fill/);
  });

  it('app.js 가 순수 모듈로 판정하고 DOM 만 반영한다(중복 계산·버튼 로직 재구현 없음)', () => {
    expect(app).toMatch(/import \{ apDoneSummary, apEta, apProgressAria, apProgressState \} from '\.\/apProgress\.js'/);
    expect(app).toMatch(/renderApProgress\(apProgressState\(Date\.now\(\) - started, etaInfo\.ms\)\)/);
    // 불확정에서 aria-valuenow 를 **제거**한다.
    expect(app).toMatch(/removeAttribute\(k\)/);
    // 완료 요약이 결과값으로 세워진다.
    expect(app).toMatch(/renderApDone\(\s*apDoneSummary\(\{[\s\S]*quads:/);
    // 취소 버튼을 만들지 않았다(이번 범위 밖).
    expect(app).not.toMatch(/ap-cancel/);
  });
});
