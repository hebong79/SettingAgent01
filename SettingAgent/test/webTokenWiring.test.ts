import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 웹 토큰 배선(설계서 §1.2 웹 껍데기화 / R1).
 *
 * ★ 이 파일이 막으려는 사고: 서버에 전역 변이 게이트가 생긴 뒤 `viewer.controlToken` 을 켜면,
 *   토큰을 안 붙이는 변이 요청은 **전부 403** 이 된다. 조사 시점 기준 웹의 변이 fetch 35곳 중
 *   31곳이 토큰 미전송이었다 — 하나라도 빠뜨리면 그 버튼만 조용히 죽는다.
 *   그래서 "변이 요청은 mutFetch 로만"을 **정적으로** 봉인한다(런타임 테스트로는 35곳을 다 못 훑는다).
 */

const appJs = readFileSync('web/app.js', 'utf8');
const roimakerJs = readFileSync('web/roimaker.js', 'utf8');
const tokenJs = readFileSync('web/token.js', 'utf8');

const MUTATION_METHOD = /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/;

/** 생 `fetch(` 호출 중 변이 메서드를 쓰는 것들의 (1-based) 줄번호. mutFetch 경유는 제외된다. */
function rawMutationFetchLines(src: string): number[] {
  // 구간 경계는 `fetch(`·`mutFetch(` **둘 다** — 대문자 F 를 빠뜨리면 mutFetch 의 method 가
  // 직전 읽기 fetch 의 구간으로 새어 들어가 거짓 실패가 난다.
  const boundaries: number[] = [];
  for (const m of src.matchAll(/[Ff]etch\(/g)) boundaries.push(m.index!);
  const lines: number[] = [];
  for (const m of src.matchAll(/(?<![A-Za-z0-9_$])fetch\(/g)) {
    const start = m.index!;
    const next = boundaries.find((i) => i > start);
    // 호출 구간 = 이 fetch( 부터 다음 fetch( 직전까지 — init 객체 리터럴이 여기에 들어 있다.
    if (MUTATION_METHOD.test(src.slice(start, next ?? src.length))) {
      lines.push(src.slice(0, start).split('\n').length);
    }
  }
  return lines;
}

describe('변이 fetch 는 전부 mutFetch 경유(토큰 자동 부착)', () => {
  it('web/app.js 에 생 변이 fetch 가 0건', () => {
    expect(rawMutationFetchLines(appJs)).toEqual([]);
  });

  it('web/roimaker.js 에 생 변이 fetch 가 0건', () => {
    expect(rawMutationFetchLines(roimakerJs)).toEqual([]);
  });

  it('두 모듈 모두 token.js 의 mutFetch 를 import 한다', () => {
    expect(appJs).toMatch(/import \{[^}]*mutFetch[^}]*\} from '\.\/token\.js';/);
    expect(roimakerJs).toMatch(/import \{[^}]*mutFetch[^}]*\} from '\.\/token\.js';/);
  });

  it('실제로 mutFetch 호출이 존재한다(치환이 통째로 사라지지 않았다)', () => {
    expect((appJs.match(/mutFetch\(/g) ?? []).length).toBeGreaterThanOrEqual(30);
    expect((roimakerJs.match(/mutFetch\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('토큰 영속화(새로고침 후에도 유지)', () => {
  it('token.js 가 TOKEN_KEY 로 localStorage 를 읽고 쓴다', () => {
    expect(tokenJs).toContain("export const TOKEN_KEY = 'pa.viewerToken'");
    expect(tokenJs).toContain('localStorage.getItem(TOKEN_KEY)');
    expect(tokenJs).toContain('localStorage.setItem(TOKEN_KEY');
    expect(tokenJs).toContain('localStorage.removeItem(TOKEN_KEY)');
  });

  it('mutFetch 는 x-viewer-token 을 붙인다(authHeaders 경유)', () => {
    expect(tokenJs).toContain("'x-viewer-token'");
    expect(tokenJs).toMatch(/export function mutFetch\(url, init = \{\}\)/);
    expect(tokenJs).toContain('headers: authHeaders(init.headers ?? {})');
  });

  it('#viewer-token 입력칸이 저장소와 양방향 결선돼 있다', () => {
    expect(appJs).toContain("const input = $('viewer-token');");
    expect(appJs).toContain('input.value = getControlToken();');
    expect(appJs).toContain("input.addEventListener('input', () => setControlToken(input.value));");
    expect(appJs).toContain('wireControlToken();');
  });

  it('토큰 헤더의 정의처는 token.js 하나다(app.js 의 지역 tokenHeaders 는 제거됨)', () => {
    expect(appJs).not.toContain('function tokenHeaders');
  });
});
