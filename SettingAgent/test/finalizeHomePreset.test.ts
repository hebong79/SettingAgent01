import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 회귀 가드(DOM/렌더 계층 — 순수함수로 못 잡아 소스 텍스트로 가드. viewerDisplayReset.test.ts 선례).
 *
 * 마스터 요청 2026-07-23: 정밀수집을 모두 마친 뒤 '최종화'(#cap-finalize / 완료 팝업 #cap-result-finalize)를
 * 누르면 **1번 카메라·1번 프리셋으로 물리 이동**한 상태에서 DB 결과를 표시한다.
 * 위장 금지: /cameras 목록에 cam1:preset1 이 없으면 이동하지 않고 조용히 skip 한다.
 */
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf-8');

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

describe('최종화 → 기준 뷰(1번 카메라·1번 프리셋) 복귀', () => {
  it('기준 뷰 상수는 1-based 로 cam=1 · preset=1 이다', () => {
    expect(app).toMatch(/const HOME_CAM\s*=\s*1;/);
    expect(app).toMatch(/const HOME_PRESET\s*=\s*1;/);
  });

  it('capFinalize 는 DB 조회 **전에** gotoHomePreset 을 await 한다(이동 후 그 프리셋 기준으로 렌더)', () => {
    const body = functionBody(app, 'capFinalize');
    expect(body).toContain('await gotoHomePreset()');
    expect(body.indexOf('await gotoHomePreset()')).toBeLessThan(body.indexOf('await loadParkingSlots()'));
  });

  it('gotoHomePreset 은 선택 전환 + 물리 이동 + 스트림 재연결을 수행한다', () => {
    const body = functionBody(app, 'gotoHomePreset');
    expect(body).toContain('state.cam = HOME_CAM');
    expect(body).toContain('state.preset = HOME_PRESET');
    expect(body).toContain('renderCamSelect()');        // 드롭다운 값 동기화.
    expect(body).toContain('await gotoPreset()');       // /move → /req_move 물리 이동.
    expect(body).toContain('reconnectLiveIfActive()');  // 라이브 스트림 재연결.
  });

  it('gotoHomePreset 은 cam1:preset1 미존재 시 이동하지 않고 false 를 반환한다(위장 금지)', () => {
    const body = functionBody(app, 'gotoHomePreset');
    const guard = body.slice(0, body.indexOf('state.cam = HOME_CAM'));
    expect(guard).toContain('camIdx === HOME_CAM');
    expect(guard).toContain('presetIdx === HOME_PRESET');
    expect(guard).toContain('return false');
  });

  it('완료 팝업의 최종화 버튼도 같은 capFinalize 경로를 쓴다', () => {
    const wire = app.slice(app.indexOf("$('cap-result-finalize').addEventListener"));
    expect(wire.slice(0, 300)).toContain('capFinalize()');
    expect(app).toMatch(/\$\(['"]cap-finalize['"]\)\.addEventListener\(\s*['"]click['"]\s*,\s*capFinalize\s*\)/);
  });

  it('자동 파이프라인(pollPipeline)의 finalize 완료 전환은 이동하지 않는다(버튼 전용 동작)', () => {
    const body = functionBody(app, 'pollPipeline');
    expect(body).not.toContain('gotoHomePreset');
  });

  it('#cap-finalize 툴팁이 이동 동작을 설명한다', () => {
    const label = html.match(/<button id="cap-finalize" title="([^"]*)"/);
    expect(label?.[1]).toContain('1번 프리셋');
  });
});
