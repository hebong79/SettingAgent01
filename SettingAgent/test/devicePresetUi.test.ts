import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 장비 프리셋 · 장비 원시 PTZ 뷰어 UI **소스 봉인**.
 *
 * 이 저장소에는 브라우저 DOM 자동화(playwright/jsdom)가 없다 — 뷰어 검증은 기존 선례
 * (lensCalibUi.test.ts · cameraKindSelect.test.ts)대로 마크업·결선 정적 검사로 한다.
 * 목적은 동작 증명이 아니라 **요소나 결선이 사라지면 반드시 알아차리는 것**이다.
 * (동작 자체는 실카 라이브로 확인했다 — 문서 참조.)
 */

const HTML = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const CSS = readFileSync(fileURLToPath(new URL('../web/app.css', import.meta.url)), 'utf8');

describe('마크업 — 장비 프리셋 UI 구성요소', () => {
  it.each([
    ['id="device-preset-box"', '장비 프리셋 블록'],
    ['id="dev-preset-sel"', '프리셋 목록 셀렉트'],
    ['id="dev-preset-load"', '목록 불러오기 버튼'],
    ['id="dev-preset-goto"', '프리셋 이동 버튼'],
    ['id="dev-preset-status"', '상태 메시지'],
    ['id="ptz-native-row"', '장비 원시 PTZ 줄'],
    ['id="ptz-native-pan"', '원시 pan'],
    ['id="ptz-native-tilt"', '원시 tilt'],
    ['id="ptz-native-zoom"', '원시 zoom'],
  ])('%s (%s)', (needle) => {
    expect(HTML).toContain(needle);
  });

  it('PTZ 제어 섹션 안에 있다 — 정보수집(정밀 수집) 탭과 제어 탭이 공유하는 그 패널이다', () => {
    const ptzControl = HTML.indexOf('id="ptz-control-mode"');
    const box = HTML.indexOf('id="device-preset-box"');
    const loginBox = HTML.indexOf('id="login-box"');
    expect(ptzControl).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(ptzControl); // PTZ 제어 헤더 뒤,
    expect(box).toBeLessThan(loginBox);      // 로그인 카드 앞(= 같은 섹션 내부).
  });

  it('원시 PTZ 줄은 "현재 PTZ" 요약 안에 있다(뷰어 좌표 바로 아래)', () => {
    const viewerZoom = HTML.indexOf('id="ptz-zoom"');
    const nativeRow = HTML.indexOf('id="ptz-native-row"');
    expect(nativeRow).toBeGreaterThan(viewerZoom);
  });

  it('기본은 숨김 — 실카 소스일 때만 열린다(시뮬레이터엔 장비 프리셋 개념이 없다)', () => {
    expect(HTML).toMatch(/id="device-preset-box" hidden/);
    expect(HTML).toMatch(/id="ptz-native-row"[\s\S]{0,120}hidden/);
    const ui = APP.slice(APP.indexOf('function updatePtzControlUi('), APP.indexOf('function updatePtzControlUi(') + 1400);
    expect(ui).toContain("$('device-preset-box').hidden = !real");
    expect(ui).toContain("$('ptz-native-row').hidden = !real");
  });

  it('CSS 는 기존 패널 규칙을 재사용하고 최소한만 추가한다', () => {
    expect(CSS).toContain('.device-preset');
    expect(CSS).toContain('.ptz-native');
  });
});

describe('결선 — 목록 조회(무이동)와 이동(변이)이 분리돼 있다', () => {
  it('목록은 GET /viewer/api/presets 를 부른다(변이 토큰 없는 순수 fetch)', () => {
    const body = APP.slice(APP.indexOf('async function loadDevicePresets('), APP.indexOf('async function gotoDevicePreset('));
    expect(body).toContain("fetch(api(`/presets?");
    expect(body).not.toContain('mutFetch'); // 읽기에는 변이 게이트를 태우지 않는다.
  });

  it('이동은 mutFetch 로 POST /viewer/api/preset/goto 를 부른다(변이 게이트 통과)', () => {
    const body = APP.slice(APP.indexOf('async function gotoDevicePreset('), APP.indexOf('function updatePtzNativeDisplay('));
    expect(body).toContain("mutFetch(api('/preset/goto')");
    expect(body).toContain("method: 'POST'");
  });

  it('버튼이 함수에 결선돼 있다', () => {
    expect(APP).toContain("$('dev-preset-load').addEventListener('click', () => loadDevicePresets())");
    expect(APP).toContain("$('dev-preset-goto').addEventListener('click', () => gotoDevicePreset())");
  });

  it('이동 중에는 이동 버튼이 잠기고, 순회(Touring) 중에도 막힌다', () => {
    const gate = APP.slice(APP.indexOf('function updatePtzControlEnabled('), APP.indexOf('function setPtzBusy('));
    expect(gate).toContain('state.ptzBusy || state.touringActive');
  });

  it('프리셋 라벨은 **실측된** PTZ 만 붙인다(장비가 프리셋 PTZ 를 주지 않으므로 추정 금지)', () => {
    const label = APP.slice(APP.indexOf('function devicePresetLabel('), APP.indexOf('async function loadDevicePresets('));
    expect(label).toContain('measured?.native');
    expect(label).toContain('if (!native) return head');
  });

  it('현재 PTZ 조회 응답의 native 를 원시 표시에 반영한다', () => {
    const refresh = APP.slice(APP.indexOf('async function refreshCurrentPtz('), APP.indexOf('async function syncPtzAfterJob('));
    expect(refresh).toContain('state.ptzNative = data.native ?? null');
    expect(refresh).toContain('updatePtzNativeDisplay()');
  });
});
