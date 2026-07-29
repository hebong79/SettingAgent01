import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 지면 격자(자동 바닥 ROI) **패널 제거** 회귀 가드(마스터 요청 2026-07-29).
 *
 * 이전 라운드(L3 후속 Loop 1/4)는 이 패널의 '무반응' UX 를 소스 텍스트로 봉인하고 있었다.
 * 이번 변경으로 **뷰어 UI 에서만** 패널·자동ROI 토글·전용 렌더/배선이 사라졌으므로 그 봉인들은 폐기하고,
 * 그 자리에 **되살아나지 않음**(잔재 0) 과 **서버 경로는 그대로**(MCP·RPC 회귀 0) 를 봉인한다.
 */
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');
const css = readFileSync(fileURLToPath(new URL('../web/app.css', import.meta.url)), 'utf-8');

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

describe('지면 격자 패널 제거(뷰어 UI 잔재 0)', () => {
  it('index.html 에 gg-* 요소와 자동ROI 토글이 없다', () => {
    for (const id of ['gg-sel-info', 'gg-cols', 'gg-rows', 'gg-colstart', 'gg-preview', 'gg-confirm', 'gg-apply', 'gg-msg', 'gg-table', 'roi-auto']) {
      expect(html, `#${id} 제거`).not.toContain(`id="${id}"`);
    }
    expect(html).not.toContain('지면 격자');
  });

  it('app.js 에 패널 로직·자동ROI 렌더·배선이 없다', () => {
    for (const token of [
      'ggPreview',
      'ggApply',
      'ggRefSpace',
      'ggBody',
      'renderGgTable',
      'renderGgSelectionInfo',
      'setGgMsg',
      'setGgGate',
      'drawAutoRoi',
      'state.autoRoi',
      "$('roi-auto')",
    ]) {
      expect(app, `${token} 제거`).not.toContain(token);
    }
  });

  it('app.css 에 패널 전용 강조 클래스가 없다(.gg-help 는 공용 안내문 스타일로 유지)', () => {
    expect(css).not.toContain('.gg-warn'); // 게이트 경고 — 패널과 함께 사라졌다.
    // .gg-help 는 다른 패널 안내문이 쓰는 공용 스타일이라 남긴다(이름만 격자 유래).
    expect(css).toContain('.an-manual-help');
  });

  it('남은 UI 는 자기 자신만 부른다(끊긴 호출 0)', () => {
    // 선택 갱신 사슬에서 패널 동기화 호출이 빠졌는지 — 남아 있으면 ReferenceError 로 목록 렌더가 죽는다.
    expect(functionBody(app, 'renderPlaceSelectionInfo')).not.toContain('Gg');
    expect(functionBody(app, 'drawRoiOverlay')).not.toContain('AutoRoi');
  });
});

describe('서버 경로는 그대로(UI 제거는 UI 에서 끝난다)', () => {
  it('groundGridRoutes.ts 는 남아 있고 /capture/ground-grid/* 를 그대로 제공한다', () => {
    const routes = readFileSync(fileURLToPath(new URL('../src/api/groundGridRoutes.ts', import.meta.url)), 'utf-8');
    expect(routes).toContain('/capture/ground-grid/bootstrap');
    expect(routes).toContain('/capture/ground-grid/apply');
  });

  it('groundGridRoutes 는 DB 를 전혀 모른다(store import 0 · replaceSlotSetup 호출 0)', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/api/groundGridRoutes.ts', import.meta.url)), 'utf-8');
    expect(src).not.toMatch(/\.replaceSlotSetup\s*\(/);
    expect(src).not.toMatch(/import .*SqliteStore/);
  });
});

describe('replaceSlotSetup 호출자 봉인(신규 파괴 경로 0)', () => {
  /**
   * 패널 제거는 `replaceSlotSetup` 호출자를 **1곳도 늘리거나 줄이지 않는다** —
   * 패널의 승인은 기존 `POST /capture/slots/load-roi` 를 연쇄 호출할 뿐이었고, 그 라우트는 그대로 남는다.
   */
  it('src 전체에서 store.replaceSlotSetup(...) 호출부는 기존 3곳뿐', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) {
          readFileSync(p, 'utf-8')
            .split('\n')
            .forEach((line) => {
              // 정의부(`replaceSlotSetup(rows: …)`)와 구분하기 위해 수신자(`.`)가 있는 호출만 센다.
              if (/\.replaceSlotSetup\s*\(/.test(line)) hits.push(relative(root, p).replace(/\\/g, '/'));
            });
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['capture/Finalizer.ts', 'capture/roiDbLoad.ts', 'tools/migrateToSettingDb.ts']);
  });

  it("'ROI 파일 로딩' 은 confirm + 추출된 본문 호출로만 남는다(패널 제거와 무관하게 유지)", () => {
    const body = functionBody(app, 'loadRoiToDb');
    expect(body).toContain('confirm(');
    expect(body).toContain('runLoadRoiToDb()');
    expect(body).not.toContain('fetch(');
  });
});
