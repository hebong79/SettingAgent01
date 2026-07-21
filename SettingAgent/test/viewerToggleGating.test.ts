import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 회귀 가드(DOM/렌더 계층 — 순수함수 테스트로 못 잡아 소스/HTML 텍스트로 가드).
// 1) 검출(#roi-detect) 체크박스는 제거됐고, 차량/번호판 토글이 검출과 무관하게 독립 동작해야 한다(마스터 요청 2026-07-16).
// 2) 차량육면체(#roi-vcuboid) 토글은 시작 시 체크 해제.
const appPath = fileURLToPath(new URL('../web/app.js', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const app = readFileSync(appPath, 'utf-8');
const html = readFileSync(htmlPath, 'utf-8');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수 존재`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceOpen + 1, i); }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

/** index.html 에서 특정 input id 의 태그 문자열 추출(없으면 null). */
function inputTag(id: string): string | null {
  const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  return m ? m[0] : null;
}

describe('검출 체크박스 제거 — 차량/번호판 독립 동작', () => {
  it('#roi-detect 체크박스는 index.html 에서 제거됐다', () => {
    expect(inputTag('roi-detect')).toBeNull();
  });

  it('drawDetectOverlay 는 검출 마스터 게이트(roi-detect)를 참조하지 않는다', () => {
    const body = functionBody(app, 'drawDetectOverlay');
    expect(body).not.toMatch(/roi-detect/);
  });

  it('drawDetectOverlay 는 차량(roi-vehicle)/번호판(roi-plate) 토글로 각각 독립 가드한다', () => {
    const body = functionBody(app, 'drawDetectOverlay');
    expect(body).toMatch(/\$\(['"]roi-vehicle['"]\)\.checked/);
    expect(body).toMatch(/\$\(['"]roi-plate['"]\)\.checked/);
    expect(body).toContain('showVehicle');
    expect(body).toContain('showPlate');
  });

  it('앱 전체에서 roi-detect 결선/참조가 남아있지 않다(고아 방지)', () => {
    // 주석 포함 어떤 활성 참조도 없어야 함(제거 완결성).
    expect(app).not.toMatch(/roi-detect/);
  });
});

describe('토글 시작 상태(index.html)', () => {
  it('차량육면체(#roi-vcuboid)는 시작 시 체크 해제(checked 없음)', () => {
    expect(inputTag('roi-vcuboid')).not.toMatch(/\bchecked\b/);
  });

  it('차량/번호판 토글은 기본 체크(회귀 방지 — 기본은 보이게)', () => {
    expect(inputTag('roi-vehicle')).toMatch(/\bchecked\b/);
    expect(inputTag('roi-plate')).toMatch(/\bchecked\b/);
  });
});
