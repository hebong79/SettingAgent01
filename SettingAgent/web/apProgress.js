// 「도색선 자동검출」 실행 진행 표시 — **순수 ESM**(DOM/fetch/브라우저 전역 미참조). vitest 가 직접 import 한다
// (`autoPaint.js`·`core.js`·`placeDraw.js` 관례).
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 거짓 진행률을 만들지 않는다 — 이 모듈의 존재 이유다.
//   서버는 단계 진행을 보고하지 않는다. 그래서 시간으로 채우는 막대는 **추측**이다.
//   ⓐ 예상 시간까지는 `경과 ÷ 예상` 으로 **확정** 막대를 보인다.
//   ⓑ 예상 시간을 넘기면 **불확정(indeterminate)** 으로 전환한다 — `ratio: null`, `aria-valuenow` 를 **떼라**.
//      (불확정을 0% 라고 말하면 그것도 거짓이다.)
//   ⓒ **끝나기 전에 100% 를 보이지 않는다.** ⓐ 구간의 상한을 1 미만으로 클램프한다.
//   ⓓ 완료 표시는 시간이 아니라 **결과**(검출 면수·프레임 해시·실제 소요)로 대체한다.
// ══════════════════════════════════════════════════════════════════════════

/**
 * 진행 예상 시간(ms) 과 화면 문구.
 *
 * ★ 값의 근거는 **구현자 라이브 실측**이다(2026-07-30, 13020 왕복 전체 시간 · 프레임 취득 포함):
 *   · 시뮬 현재뷰(무이동)      12140 / 12104 ms  → 12초
 *   · 시뮬 프리셋 단일시점      12070 ms          → 12초
 *   · **실카 현재뷰            14519 / 14738 ms  → 15초**(RTSP 스냅샷이 시뮬보다 ~2.5초 느리다)
 *   · 시뮬 프리셋 다시점 합의   68759 ms          → 70초(6시점 촬영 — 종전 표기값이 실측과 맞는다)
 *   실측하지 않은 조합에 값을 지어내지 않는다 — 아래 분기가 전부 실측 조합이다.
 */
export function apEta({ currentView = false, consensus = false, real = false } = {}) {
  if (currentView) {
    return real
      ? { ms: 15_000, text: '약 15초 — 카메라 이동 없음(실카 RTSP)' }
      : { ms: 12_000, text: '약 12초 — 카메라 이동 없음' };
  }
  if (consensus) return { ms: 70_000, text: '약 70초 — 6시점 촬영' };
  return real ? { ms: 15_000, text: '약 15초(실카 RTSP)' } : { ms: 12_000, text: '약 12초' };
}

/** 막대 상태 1건. `ratio` 가 null 이면 **불확정**이다(진행률을 모른다는 뜻 — 0 이 아니다). */
export function apProgressState(elapsedMs, etaMs) {
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const eta = Number.isFinite(etaMs) && etaMs > 0 ? etaMs : 0;
  if (!eta || e >= eta) {
    return {
      determinate: false,
      ratio: null,
      percent: null,
      overdue: eta > 0 && e >= eta,
      label: eta > 0 ? '예상 시간 초과 — 계속 진행 중' : '진행 중',
    };
  }
  // ★ 상한 0.99 — 끝나지 않았는데 100% 를 보이지 않는다.
  const ratio = Math.min(0.99, e / eta);
  return {
    determinate: true,
    ratio,
    percent: Math.round(ratio * 100),
    overdue: false,
    label: `${Math.round(ratio * 100)}%`,
  };
}

/**
 * 완료·실패 요약. **시간이 아니라 결과**를 말한다.
 * `quads`/`frameHash` 는 서버 산출을 그대로 옮긴다(뷰어가 재계산하지 않는다 — autoPaint.js 규약과 동일).
 */
export function apDoneSummary({ ok = true, quads = null, frameHash = null, elapsedMs = 0, reason = '' } = {}) {
  const secs = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}초`;
  if (!ok) return `실패 — ${reason || '사유 미상'} (소요 ${secs})`;
  const parts = [];
  parts.push(quads == null ? '검출 면수 —' : `검출 ${quads}면`);
  parts.push(frameHash ? `프레임 ${frameHash}` : '프레임 —');
  parts.push(`소요 ${secs}`);
  return `완료 — ${parts.join(' · ')}`;
}

/**
 * 막대에 실을 aria 속성 묶음. **불확정 구간에서는 `aria-valuenow` 자체를 넣지 않는다.**
 * (호출측은 이 객체에 없는 속성을 DOM 에서 **제거**해야 한다 — 남겨 두면 스크린리더에 거짓을 말한다.)
 */
export function apProgressAria(state) {
  const base = { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': state.label };
  return state.determinate ? { ...base, 'aria-valuenow': String(state.percent) } : base;
}
