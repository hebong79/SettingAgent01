import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * L3 후속 Loop 1/4 — 지면 격자 패널 UX 회귀 가드(DOM/렌더 계층은 순수함수로 못 잡아 소스 텍스트로 봉인.
 * 선례: test/dbViewSourceSwitch.test.ts · test/viewerToggleGating.test.ts).
 *
 * 리더 실측: 서버는 정상(bootstrap ok:true, matched 7/7, IoU 0.9999768)이고 결함은 **클라이언트 UX 하나**였다 —
 * `gg-apply` 에는 disabled 게이트가 있는데 `gg-preview` 에는 없어, 기준 주차면 미선택 시 눌러도 캔버스·표가
 * 안 변해 **눈에는 완전한 무반응**이었다.
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

describe('미리보기 버튼 게이트(무반응 결함 봉인)', () => {
  const sel = functionBody(app, 'renderGgSelectionInfo');

  it('T1 renderGgSelectionInfo 가 gg-preview 의 disabled 를 갱신한다', () => {
    expect(sel).toMatch(/\$\('gg-preview'\)/);
    expect(sel).toMatch(/\.disabled\s*=/);
  });

  it('T2 그 조건은 ggRefSpace() 결과다(기준 주차면 선택 여부)', () => {
    expect(sel).toContain('const ref = ggRefSpace();');
    expect(sel).toMatch(/prev\.disabled\s*=\s*!ref/);
  });

  it('T3 index.html 의 gg-preview 는 초기 disabled(최초 로드=선택 없음 과 일치)', () => {
    const tag = html.match(/<button id="gg-preview"[^>]*>/)?.[0];
    expect(tag, 'gg-preview 버튼 존재').toBeTruthy();
    expect(tag).toContain('disabled');
  });

  it('T4 renderPlaceSelectionInfo 가 renderGgSelectionInfo() 를 호출한다(사슬 유지)', () => {
    expect(functionBody(app, 'renderPlaceSelectionInfo')).toContain('renderGgSelectionInfo()');
  });

  it('T5 selectPlaceSpace 가 renderSlotList() 를 호출한다(경로 A)', () => {
    expect(functionBody(app, 'selectPlaceSpace')).toContain('renderSlotList()');
  });

  it('T6 renderSlotList 의 **모든** 분기가 renderPlaceSelectionInfo() 로 끝난다(구멍 B 재발 방지)', () => {
    const body = functionBody(app, 'renderSlotList');
    const hits = body.match(/renderPlaceSelectionInfo\(\)/g) ?? [];
    expect(hits.length, 'fileMode/finalized 분기 + else 분기 = 2회').toBeGreaterThanOrEqual(2);
  });

  it('T7 ggPreview 미선택 early-return 은 안내 문구를 남긴다(이중 방어 유지)', () => {
    const body = functionBody(app, 'ggPreview');
    expect(body).toMatch(/if \(!ref\)/);
    expect(body).toContain('기준 주차면을 주차면 목록에서 먼저 선택하세요');
  });

  it('T8 게이트 사유는 눈에 띄게 강조된다(.gg-warn)', () => {
    expect(sel).toContain('setGgGate(');
    const gate = functionBody(app, 'setGgGate');
    expect(gate).toContain("classList.add('gg-warn')");
    expect(gate).toContain("classList.remove('gg-warn')");
    expect(css).toContain('.gg-warn');
  });

  it('T8b 게이트 해제 시 텍스트를 지우지 않는다(미리보기 성공 문구 보존)', () => {
    const gate = functionBody(app, 'setGgGate');
    // else 분기(=해제)에는 textContent 대입이 없어야 한다.
    const elseBranch = gate.slice(gate.indexOf('} else {'));
    expect(elseBranch).not.toContain('textContent');
  });
});

describe('승인 = _auto 기록 → 백업 → 정본 갱신 → DB 전량 재구성 (정직성 강제)', () => {
  const apply = functionBody(app, 'ggApply');

  it('confirm 본문에 3단계와 **복구되지 않는 것**이 문장으로 들어 있다', () => {
    expect(apply).toContain('confirm(');
    expect(apply).toContain('PtzCamRoi_auto.json');
    expect(apply).toContain('백업(.bak)');
    expect(apply).toContain('slot_setup 을 전량 재구성');
    // Q3 정직성: 무엇이 복구되고 무엇이 안 되는가를 분리해 적는다.
    expect(apply).toContain('slot_roi 는 복구되지만 검출·점유·센터링 데이터는 복구되지 않습니다');
    expect(apply).toContain('DELETE+INSERT');
  });

  it('기존 재구성 경로를 재사용한다(60줄 복사 금지 — runLoadRoiToDb 호출)', () => {
    expect(apply).toContain('runLoadRoiToDb()');
    // 자체 fetch 로 load-roi 를 직접 부르지 않는다(후처리 순서 중복 금지).
    expect(apply).not.toContain('/capture/slots/load-roi');
  });

  it('loadRoiToDb 는 confirm + 추출된 본문 호출로만 남는다', () => {
    const body = functionBody(app, 'loadRoiToDb');
    expect(body).toContain('confirm(');
    expect(body).toContain('runLoadRoiToDb()');
    expect(body).not.toContain('fetch(');
  });

  it('S6 실패는 "파일 갱신 · DB 는 이전 상태 유지" 로 안내한다(안전 실패 모드)', () => {
    expect(apply).toContain('파일은 갱신됐으나 DB 재구성 실패');
    expect(apply).toContain('현재 DB 는 이전 상태 유지');
  });

  it('성공 메시지에 백업 파일명과 _auto 기록이 드러난다(되돌리기 근거)', () => {
    expect(apply).toContain('data.backupFile');
    expect(apply).toContain('data.autoFile');
  });

  it('거부 시 사유가 숫자로 보인다(detail.nextSlots/currentSlots/missingIdx)', () => {
    expect(apply).toContain('data.detail.nextSlots');
    expect(apply).toContain('data.detail.currentSlots');
    expect(apply).toContain('missingIdx');
  });

  // G5 거부는 idx 집합에 안 나타난다 — 프리셋별 raw 개수를 보여주지 않으면 사용자가 원인을 알 수 없다.
  it('G5 거부의 소실 프리셋·개수(droppedRaw)가 화면에 드러난다', () => {
    expect(apply).toContain('data.detail.droppedRaw');
    expect(apply).toContain('소실 위험');
  });
});

describe('replaceSlotSetup 호출자 봉인(신규 파괴 경로 0)', () => {
  /**
   * 이번 변경은 `replaceSlotSetup` 호출자를 **1곳도 늘리지 않는다** — 승인은 기존 `POST /capture/slots/load-roi`
   * 를 연쇄 호출할 뿐이다. 아래 3곳은 전부 **기존**이다(리더 지시의 2곳 = 런타임 서버 경로,
   * `tools/migrateToSettingDb.ts` 는 1회성 CLI 이관 도구로 설계 §3 M 항목에 이미 잡혀 있다).
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

  it('groundGridRoutes 는 DB 를 전혀 모른다(store import 0 · replaceSlotSetup 호출 0)', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/api/groundGridRoutes.ts', import.meta.url)), 'utf-8');
    expect(src).not.toMatch(/\.replaceSlotSetup\s*\(/);
    expect(src).not.toMatch(/import .*SqliteStore/);
  });
});
