/**
 * 영속화(DB REAL 바인딩 + JSON 파일/TEXT) 수치를 소수점 최대 5자리로 정규화하는 단일 출처 헬퍼.
 * 전송/휘발성 payload·설정파일에는 쓰지 않는다(영속화 경계 전용).
 */

/** 유한수만 소수점 최대 5자리로 반올림(round-half-up). 정수/비유한/비수치는 그대로. */
export function round5(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e5) / 1e5 : n;
}

/** JSON.stringify 에 숫자 replacer(round5) 적용. 숫자 값만 반올림, 그 외 passthrough. */
export function stringify5(value: unknown, indent?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'number' ? round5(v) : v), indent);
}
