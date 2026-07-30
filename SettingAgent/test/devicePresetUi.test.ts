import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import — 규칙 자체를 값으로 검증한다.
import { presetOptions } from '../web/core.js';

/**
 * 장비 프리셋 · 장비 원시 PTZ 뷰어 UI **소스 봉인**.
 *
 * 이 저장소에는 브라우저 DOM 자동화(playwright/jsdom)가 없다 — 뷰어 검증은 기존 선례
 * (lensCalibUi.test.ts · cameraKindSelect.test.ts)대로 마크업·결선 정적 검사로 한다.
 * 목적은 동작 증명이 아니라 **요소나 결선이 사라지면 반드시 알아차리는 것**이다.
 *
 * ★ 이 화면의 규약(마스터 지적 반영): **프리셋 목록은 '대상 선택'의 드롭다운 하나뿐이다.**
 *   실카를 고르면 그 드롭다운이 장비 프리셋(EV1 …)으로 바뀌고 기존 [이동] 이 gopreset 으로 실제 이동한다.
 *   목록을 두 곳에 두면 어느 쪽이 정본인지 화면이 말해주지 못한다.
 */

const HTML = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const CSS = readFileSync(fileURLToPath(new URL('../web/app.css', import.meta.url)), 'utf8');

function fn(name: string): string {
  const start = APP.indexOf(`function ${name}(`);
  expect(start, `함수 ${name} 를 찾지 못했다`).toBeGreaterThan(-1);
  // 인자 목록의 닫는 괄호부터 본문을 찾는다 — 기본값 구조분해(`{ quiet = false } = {}`)의
  // 중괄호를 본문으로 오인하지 않기 위해서다.
  let parens = 0;
  let afterParams = start;
  for (let i = APP.indexOf('(', start); i < APP.length; i++) {
    if (APP[i] === '(') parens++;
    else if (APP[i] === ')') {
      parens--;
      if (parens === 0) {
        afterParams = i;
        break;
      }
    }
  }
  let depth = 0;
  let from = -1;
  for (let i = afterParams; i < APP.length; i++) {
    if (APP[i] === '{') {
      if (depth === 0) from = i;
      depth++;
    } else if (APP[i] === '}') {
      depth--;
      if (depth === 0) return APP.slice(from, i + 1);
    }
  }
  throw new Error(`함수 ${name} 본문 파싱 실패`);
}

describe('마크업 — 장비 프리셋 UI 구성요소', () => {
  it.each([
    ['id="device-preset-box"', '장비 프리셋 블록'],
    ['id="dev-preset-load"', '목록 새로고침 버튼'],
    ['id="dev-preset-status"', '상태 메시지'],
    ['id="ptz-native-row"', '장비 원시 PTZ 줄'],
    ['id="ptz-native-pan"', '원시 pan'],
    ['id="ptz-native-tilt"', '원시 tilt'],
    ['id="ptz-native-zoom"', '원시 zoom'],
  ])('%s (%s)', (needle) => {
    expect(HTML).toContain(needle);
  });

  it('프리셋 목록 셀렉트는 **하나뿐**이다(대상 선택의 #sel-preset)', () => {
    expect(HTML).toContain('id="sel-preset"');
    // 중복 목록 UI 를 되살리면 여기서 걸린다.
    expect(HTML).not.toContain('id="dev-preset-sel"');
    expect(HTML).not.toContain('id="dev-preset-goto"');
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
    expect(HTML.indexOf('id="ptz-native-row"')).toBeGreaterThan(HTML.indexOf('id="ptz-zoom"'));
  });

  it('기본은 숨김 — 실카 소스일 때만 열린다(시뮬레이터엔 장비 프리셋 개념이 없다)', () => {
    expect(HTML).toMatch(/id="device-preset-box" hidden/);
    expect(HTML).toMatch(/id="ptz-native-row"[\s\S]{0,120}hidden/);
    const ui = fn('updatePtzControlUi');
    expect(ui).toContain("$('device-preset-box').hidden = !real");
    expect(ui).toContain("$('ptz-native-row').hidden = !real");
  });

  it('시뮬레이터로 되돌리면 장비 프리셋 상태를 비운다(실카 목록이 남아 오해를 만들지 않게)', () => {
    const ui = fn('updatePtzControlUi');
    expect(ui).toContain('state.devicePresets = []');
    expect(ui).toContain('state.ptzNative = null');
  });

  it('CSS 는 기존 패널 규칙을 재사용하고 최소한만 추가한다', () => {
    expect(CSS).toContain('.device-preset');
    expect(CSS).toContain('.ptz-native');
  });
});

describe('결선 — 목록은 대상 선택 드롭다운, 조회(무이동)와 이동(변이)은 분리', () => {
  it('프리셋 드롭다운이 core.presetOptions 로 항목을 정한다(판정 규칙은 순수 함수 소유)', () => {
    const body = fn('renderPresetSelect');
    expect(body).toContain('presetOptions({');
    expect(body).toContain('devicePresets: state.devicePresets');
    expect(body).toContain('isReal: selectedSourceIsReal()');
    expect(APP).toContain('  presetOptions,'); // core.js 에서 import 돼 있다.
  });

  it('[이동] 은 실카 장비 프리셋일 때 gopreset 경로로 간다(스냅샷 폴백은 카메라를 안 움직인다)', () => {
    const body = fn('gotoPreset');
    expect(body).toContain('selectedSourceIsReal() && state.devicePresets.some((p) => p.number === state.preset)');
    expect(body).toContain('gotoDevicePreset(state.preset)');
    // 폴백보다 **먼저** 판정해야 한다 — 순서가 뒤집히면 조용히 안 움직인다.
    expect(body.indexOf('gotoDevicePreset(state.preset)')).toBeLessThan(body.indexOf("mode: 'preset'"));
  });

  it('목록은 GET /viewer/api/presets 를 부른다(변이 토큰 없는 순수 fetch) + 드롭다운 재렌더', () => {
    const body = fn('loadDevicePresets');
    expect(body).toContain('fetch(api(`/presets?');
    expect(body).not.toContain('mutFetch'); // 읽기에는 변이 게이트를 태우지 않는다.
    expect(body).toContain('renderPresetSelect()');
  });

  it('이동은 mutFetch 로 POST /viewer/api/preset/goto 를 부른다(변이 게이트 통과)', () => {
    const body = fn('gotoDevicePreset');
    expect(body).toContain("mutFetch(api('/preset/goto')");
    expect(body).toContain("method: 'POST'");
  });

  it('소스 전환·최초 로드에서 장비 프리셋을 자동 조회한다', () => {
    expect(APP).toContain('void loadDevicePresets({ quiet: true })');
    expect(APP).toContain("$('dev-preset-load').addEventListener('click', () => loadDevicePresets())");
  });

  it('이동 중·순회 중에는 [이동] 이 잠긴다', () => {
    const gate = fn('updatePtzControlEnabled');
    expect(gate).toContain("$('btn-goto').disabled = state.ptzBusy || state.touringActive");
  });

  it('현재 PTZ 조회 응답의 native 를 원시 표시에 반영한다', () => {
    const refresh = APP.slice(APP.indexOf('async function refreshCurrentPtz('), APP.indexOf('async function syncPtzAfterJob('));
    expect(refresh).toContain('state.ptzNative = data.native ?? null');
    expect(refresh).toContain('updatePtzNativeDisplay()');
  });
});

/**
 * 프리셋 드롭다운 항목 결정(순수 함수 — 실제 동작 검증).
 * 위 정적 봉인은 "결선이 사라지지 않았다"만 보장한다. 규칙 자체는 여기서 값으로 확인한다.
 */
describe('core.presetOptions — 실카는 장비 프리셋, 아니면 카메라 목록', () => {
  const cameraPresets = [{ presetIdx: 1, label: '현재 위치' }];
  const devicePresets = [
    { token: '001', name: 'EV1', number: 1 },
    { token: '002', name: 'EV2', number: 2 },
    { token: '003', name: 'EV3', number: 3 },
  ];

  it('실카 + 장비 프리셋 → 장비 프리셋이 목록이다(#1 EV1 · #2 EV2 · #3 EV3)', () => {
    expect(presetOptions({ cameraPresets, devicePresets, isReal: true })).toEqual([
      { presetIdx: 1, label: 'EV1' },
      { presetIdx: 2, label: 'EV2' },
      { presetIdx: 3, label: 'EV3' },
    ]);
  });

  it('실카인데 아직 못 읽었으면 카메라 목록으로 강등한다(빈 드롭다운 금지)', () => {
    expect(presetOptions({ cameraPresets, devicePresets: [], isReal: true })).toEqual(cameraPresets);
    expect(presetOptions({ cameraPresets, isReal: true })).toEqual(cameraPresets);
  });

  it('이동 번호가 없는 항목(비수치 토큰)은 뺀다 — 고를 수는 있는데 이동이 안 되는 항목을 만들지 않는다', () => {
    const mixed = [{ token: 'PresetToken_1', name: 'Gate' }, { token: '007', name: 'EX1-1', number: 7 }];
    expect(presetOptions({ cameraPresets, devicePresets: mixed, isReal: true })).toEqual([
      { presetIdx: 7, label: 'EX1-1' },
    ]);
  });

  it('번호 있는 항목이 하나도 없으면 통째로 강등한다(빈 목록을 내놓지 않는다)', () => {
    const noNumbers = [{ token: 'A', name: 'Gate' }];
    expect(presetOptions({ cameraPresets, devicePresets: noNumbers, isReal: true })).toEqual(cameraPresets);
  });

  it('시뮬레이터는 장비 프리셋이 있어도 무시한다(camerapos 프리셋이 정본)', () => {
    expect(presetOptions({ cameraPresets, devicePresets, isReal: false })).toEqual(cameraPresets);
  });

  it('인자를 안 주면 빈 배열(호출측 초기화 순서에 안전)', () => {
    expect(presetOptions()).toEqual([]);
  });
});
