// apProgress.js(브라우저용 순수 ESM)의 타입 선언. vitest·도구가 직접 로드하는 .js 와 1:1.
// autoPaint.d.ts / core.d.ts / placeDraw.d.ts 관례와 동일한 짝 구조.

/** 예상 시간 1건 — ms(막대 계산용) + 화면 문구. 값의 실측 근거는 apProgress.js 주석. */
export interface ApEta {
  ms: number;
  text: string;
}

/** 실행 조건. 서버가 현재뷰에서 다시점 합의를 강제 OFF 하므로 `currentView` 가 우선한다. */
export interface ApEtaInput {
  currentView?: boolean;
  consensus?: boolean;
  /** 실카(hucoms) 인가 — RTSP 스냅샷이 시뮬보다 느리다(실측 ~2.5초). */
  real?: boolean;
}

/**
 * 막대 상태 1건.
 *
 * `ratio`/`percent` 가 **null 이면 불확정**이다 — "진행률을 모른다"는 뜻이며 0% 가 아니다.
 * 그 구간에서 호출측은 `aria-valuenow` 를 **DOM 에서 제거**해야 한다.
 */
export interface ApProgressState {
  determinate: boolean;
  ratio: number | null;
  percent: number | null;
  /** 예상 시간을 넘겨 불확정으로 전환됐는가(예상 시간을 아예 모르는 경우와 구분한다). */
  overdue: boolean;
  label: string;
}

export interface ApDoneInput {
  ok?: boolean;
  /** 검출 면수. 모르면 null — 지어내지 않는다. */
  quads?: number | null;
  frameHash?: string | null;
  elapsedMs?: number;
  reason?: string;
}

export function apEta(input?: ApEtaInput): ApEta;
export function apProgressState(elapsedMs: number, etaMs: number): ApProgressState;
export function apDoneSummary(input?: ApDoneInput): string;
/** 불확정 구간에서는 `aria-valuenow` 키가 **없는** 객체를 낸다. */
export function apProgressAria(state: ApProgressState): Record<string, string>;
