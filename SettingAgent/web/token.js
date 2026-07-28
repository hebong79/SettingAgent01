// 제어 토큰(x-viewer-token) 보관·부착 — 웹 전 모듈 공용(app.js · roimaker.js).
//
// ★ 왜 필요한가: 서버가 전역 변이 게이트(src/api/controlGate.ts)를 갖게 되면서,
//   토큰을 켜는 순간 **토큰을 안 붙이는 변이 요청은 전부 403** 이 된다.
//   기존에 토큰을 붙이던 곳은 4곳뿐이었다(move·rpc·llm/select·camerapos) → 나머지 31곳이 죽는다.
//   그래서 "변이 요청은 mutFetch 로만 보낸다"를 규약으로 세우고, 여기 한 곳에서 헤더를 붙인다.
//
// ★ localStorage 에 두는 이유: 입력칸(#viewer-token) 값만 쓰면 새로고침마다 토큰이 사라져
//   사용자가 매번 다시 입력해야 한다(= 모든 버튼이 403 으로 죽는 것과 같은 체감).

export const TOKEN_KEY = 'pa.viewerToken';

/** 저장된 제어 토큰(없으면 ''). 저장소 접근 불가(사생활 모드 등)여도 throw 하지 않는다. */
export function getControlToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 제어 토큰 저장. 빈 값이면 항목을 제거한다(= 토큰 미사용). */
export function setControlToken(value) {
  const v = (value ?? '').trim();
  try {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 저장 실패는 조용히 무시 — 이번 세션 동안은 헤더가 붙지 않을 뿐이다.
  }
}

/** 토큰이 있으면 x-viewer-token 을 얹은 headers 를 반환(없으면 base 그대로). */
export function authHeaders(base = {}) {
  const t = getControlToken();
  return t ? { ...base, 'x-viewer-token': t } : base;
}

/**
 * 변이 요청 전용 fetch. 기본 메서드는 POST 이며 헤더에 토큰을 자동 부착한다.
 * **웹의 모든 변이(POST/PUT/DELETE) 요청은 이 함수를 거쳐야 한다**
 * (`test/webTokenWiring.test.ts` 가 생 fetch 변이 0건을 정적으로 봉인한다).
 */
export function mutFetch(url, init = {}) {
  return fetch(url, { ...init, method: init.method ?? 'POST', headers: authHeaders(init.headers ?? {}) });
}
