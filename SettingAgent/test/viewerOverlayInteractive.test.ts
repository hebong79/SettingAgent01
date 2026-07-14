import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 회귀 가드: 오버레이 캔버스가 마우스 이벤트를 받아야 슬롯 선택·크기조정(코너/변) 드래그가 동작한다.
// 근본 버그였던 `.viewport canvas { pointer-events: none }` 재유입을 차단한다(CSS 계층이라 순수함수 테스트가 못 잡음).
const cssPath = fileURLToPath(new URL('../web/app.css', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));

/** app.css 에서 `.viewport canvas { ... }` 규칙 블록 본문을 추출. */
function viewportCanvasRule(css: string): string {
  const m = css.match(/\.viewport\s+canvas\s*\{([^}]*)\}/);
  expect(m, '.viewport canvas 규칙이 app.css 에 존재해야 함').toBeTruthy();
  return m![1];
}

describe('뷰어 오버레이 상호작용 가드', () => {
  const css = readFileSync(cssPath, 'utf-8');
  const html = readFileSync(htmlPath, 'utf-8');

  it('오버레이 캔버스는 pointer-events: none 이면 안 된다(드래그 편집 차단 방지)', () => {
    const body = viewportCanvasRule(css);
    expect(body).not.toMatch(/pointer-events\s*:\s*none/);
  });

  it('오버레이 캔버스는 pointer-events 를 명시적으로 수신(auto)한다', () => {
    const body = viewportCanvasRule(css);
    expect(body).toMatch(/pointer-events\s*:\s*auto/);
  });

  it('index.html 은 .viewport 안에 #frame(img) 위 #overlay(canvas) 를 겹쳐 배치한다', () => {
    // 오버레이가 프레임 위에 있어야 클릭이 캔버스로 들어온다(편집 전제).
    const frameIdx = html.indexOf('id="frame"');
    const overlayIdx = html.indexOf('id="overlay"');
    expect(frameIdx, '#frame 존재').toBeGreaterThan(-1);
    expect(overlayIdx, '#overlay 존재').toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(frameIdx); // 캔버스가 img 뒤(위 레이어)에 선언.
  });
});
