// 검증 판정 — 순수 함수. 카메라를 모른다(러너가 샘플을 모아 여기에 넣는다).
//
// ★ 이 모듈이 존재하는 이유는 2026-07-21 이다. 그때 "tan 광각 보정"은 **사람이 손으로 A/B 를
//   재서** 기각됐다(양끝 표본 모두 나빠짐). 좋은 결정이었지만, 사람이 매번 그걸 할 수는 없다.
//   그래서 그 실험을 컴포넌트 안으로 넣는다 — 보정을 켠 잔차와 끈 잔차를 같은 격자에서 재고,
//   개선이 아니면 **스스로 기각을 선언한다.**
//
// 판정 규칙에서 절대 양보하지 않는 것 하나: **측정하지 못한 줌은 합격이 아니다.**
// 한 프레임도 제대로 못 본 줌을 두고 "당신 카메라는 z16384 에서 괜찮습니다"라고 말하는 것이
// 이 기능이 낼 수 있는 최악의 결과다.

import type { Sample } from './types.js';

export type Verdict = 'pass' | 'fail' | 'incomplete' | 'unknown';

export interface ZoomCheck {
  zoom: number;
  /** 1/4 프레임 클릭이 몇 px 빗나갔나(보정 **통과 후** 남은 오차). */
  residualPx: number | null;
  /** 이 줌에서 실제로 적용 중이던 게인. */
  gainApplied: number | null;
  /** 측정이 말하는 "이 카메라에 필요한" 게인. */
  gainNeeded: number | null;
}

export interface VerifyReport {
  checks: ZoomCheck[];
  unmeasured: Array<{ zoom: number; why: string }>;
  worstPx: number | null;
  verdict: Verdict;
  hint?: string;
  calibration: string;
  usable: number;
  of: number;
}

export interface VerdictOptions {
  /** 1/4 프레임 클릭에서 이 px 이하면 사람이 못 느낀다. */
  tolerancePx?: number;
}

/** 검증 판정. 측정 실패가 하나라도 있으면 `incomplete` — **`pass` 가 아니다.** */
export function decideVerdict(checks: readonly ZoomCheck[], unmeasuredCount: number, { tolerancePx = 10 }: VerdictOptions = {}): { verdict: Verdict; worstPx: number | null } {
  const measured = checks.map((c) => c.residualPx).filter((v): v is number => v !== null);
  const worstPx = measured.length ? Math.max(...measured) : null;
  if (unmeasuredCount > 0) return { verdict: 'incomplete', worstPx };
  if (worstPx === null) return { verdict: 'unknown', worstPx };
  return { verdict: worstPx <= tolerancePx ? 'pass' : 'fail', worstPx };
}

// ── 곡면율 A/B ──────────────────────────────────────────────────────────────

export interface AbZoomResult {
  zoom: number;
  /** 곡면율 보정을 **끄고** 예측했을 때의 잔차(px). */
  rmsOffPx: number;
  /** 곡면율 보정을 **켜고** 예측했을 때의 잔차(px). */
  rmsOnPx: number;
  improvedPct: number;
  n: number;
}

export interface AbReport {
  perZoom: AbZoomResult[];
  worstOffPx: number | null;
  worstOnPx: number | null;
  verdict: Verdict;
  /** 표를 켜도 되는가. 이 값이 'reject' 면 `enabled:true` 로 만들지 말 것. */
  recommendation: 'adopt' | 'reject';
  unmeasured: Array<{ zoom: number; why: string }>;
  reason?: string;
}

export interface AbOptions {
  tolerancePx?: number;
  /** 모든 줌에서 ON 이 OFF 보다 나빠지지 않아야 채택한다. 이 여유(px)까지는 동률로 본다. */
  tiePx?: number;
}

/**
 * 곡면율 표를 채택해도 되는지 판정한다.
 *
 * 조건 셋을 **모두** 만족해야 `adopt`:
 *   1. 측정 실패 줌이 없다            (incomplete 는 pass 가 아니다)
 *   2. ON 잔차가 허용치 이하
 *   3. **어느 줌에서도 ON 이 OFF 보다 나쁘지 않다**  ← 2026-07-21 이 걸러낸 바로 그 실패 양상
 */
export function decideAb(perZoom: readonly AbZoomResult[], unmeasured: ReadonlyArray<{ zoom: number; why: string }>, { tolerancePx = 10, tiePx = 0.5 }: AbOptions = {}): AbReport {
  const worstOffPx = perZoom.length ? Math.max(...perZoom.map((p) => p.rmsOffPx)) : null;
  const worstOnPx = perZoom.length ? Math.max(...perZoom.map((p) => p.rmsOnPx)) : null;

  if (unmeasured.length > 0) {
    return {
      perZoom: [...perZoom],
      worstOffPx,
      worstOnPx,
      verdict: 'incomplete',
      recommendation: 'reject',
      unmeasured: [...unmeasured],
      reason: `측정하지 못한 줌이 ${unmeasured.length}개 있습니다 — 합격이 아닙니다.`,
    };
  }
  if (worstOnPx === null) {
    return { perZoom: [...perZoom], worstOffPx, worstOnPx, verdict: 'unknown', recommendation: 'reject', unmeasured: [], reason: '측정된 줌이 없습니다.' };
  }

  const regressed = perZoom.filter((p) => p.rmsOnPx > p.rmsOffPx + tiePx);
  if (regressed.length) {
    return {
      perZoom: [...perZoom],
      worstOffPx,
      worstOnPx,
      verdict: 'fail',
      recommendation: 'reject',
      unmeasured: [],
      reason: `줌 ${regressed.map((p) => p.zoom).join(', ')} 에서 보정이 오히려 나빠졌습니다 — 이 개체에는 다른 값이 필요합니다.`,
    };
  }
  if (worstOnPx > tolerancePx) {
    return {
      perZoom: [...perZoom],
      worstOffPx,
      worstOnPx,
      verdict: 'fail',
      recommendation: 'reject',
      unmeasured: [],
      reason: `보정 후 최악 잔차 ${worstOnPx.toFixed(1)}px 가 허용치 ${tolerancePx}px 를 넘습니다.`,
    };
  }
  return { perZoom: [...perZoom], worstOffPx, worstOnPx, verdict: 'pass', recommendation: 'adopt', unmeasured: [] };
}

/**
 * 어떤 줌이 왜 측정되지 못했나.
 *
 * 운영자는 **진짜 이유**에만 대응할 수 있으므로 원인을 하나로 추측하지 말고 증거를 보고한다 —
 * 야간에는 같은 장면이 두 실패를 동시에 낸다(어두워서 안 보이는 곳과 노이즈 리덕션이 뭉개
 * 매끈해진 곳). 하나만 골라 말하면 문제의 절반만 쫓게 만든다.
 */
export function explain(rows: readonly Sample[]): string {
  const bad = rows.filter((s) => !s.usable);
  if (!bad.length) return '쓸 수 있는 샘플이 부족합니다';
  const n = (why: string): number => bad.filter((s) => s.reason === why).length;
  const parts: string[] = [];
  if (n('dark')) parts.push(`${n('dark')}개는 너무 어둡고`);
  if (n('smooth')) parts.push(`${n('smooth')}개는 미세 디테일이 없어 위치를 특정할 수 없고`);
  if (n('featureless')) parts.push(`${n('featureless')}개는 무늬가 없고`);
  if (n('error')) parts.push(`${n('error')}개는 매칭에 실패했고`);
  const detail = parts.length ? `(${parts.join(', ').replace(/,([^,]*)$/, '$1')})` : '';
  return n('dark') + n('smooth') >= bad.length / 2
    ? `이 배율에서 화면을 읽을 수 없습니다 ${detail} — 야간·저조도면 영상이 뭉개져 고배율일수록 심합니다. 밝을 때 다시 시도하세요`
    : `이 배율에서 화면을 읽을 수 없습니다 ${detail} — 차량·주차선처럼 무늬가 있는 쪽을 향하게 두고 다시 시도하세요`;
}
