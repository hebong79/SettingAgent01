import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { alignProtocolToKind } from '../web/core.js';

// 회귀 가드: 카메라 타입(#opt-camera-kind)을 readonly 텍스트 → 콤보박스(시뮬레이터/리얼카메라)로 전환.
// 시뮬레이터=kind 'sim', 리얼카메라=kind 'hucoms'. 편집 경로(capture)·렌더·재렌더 결선을 소스 텍스트로 가드한다.
// DOM/렌더 계층이라 순수함수 테스트로 못 잡아 소스 텍스트로 가드(viewerDisplayReset 선례).
const appPath = fileURLToPath(new URL('../web/app.js', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const app = readFileSync(appPath, 'utf-8');
const html = readFileSync(htmlPath, 'utf-8');

/** app.js 에서 함수 본문(중괄호 균형)을 추출. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} 함수가 app.js 에 존재해야 함`).toBeGreaterThan(-1);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceOpen + 1, i);
    }
  }
  throw new Error(`${name} 본문 파싱 실패`);
}

describe('카메라 타입 콤보박스(#opt-camera-kind) — 시뮬레이터/리얼카메라 2분류', () => {
  it('index.html: opt-camera-kind 는 select 이며 readonly 텍스트 input 이 아니다', () => {
    const block = html.slice(html.indexOf('id="opt-camera-kind"') - 40, html.indexOf('id="opt-camera-kind"') + 40);
    expect(block).toMatch(/<select\s+id="opt-camera-kind"/);
    expect(html).not.toMatch(/<input[^>]*id="opt-camera-kind"[^>]*readonly/);
  });

  it('index.html: 시뮬레이터(sim)·리얼카메라(hucoms) 두 옵션을 가진다', () => {
    expect(html).toMatch(/<option\s+value="sim">시뮬레이터<\/option>/);
    expect(html).toMatch(/<option\s+value="hucoms">리얼카메라<\/option>/);
  });

  it('renderCameraSource: kind 로 콤보 value 를 세팅한다(hucoms→hucoms, 그 외→sim)', () => {
    const body = functionBody(app, 'renderCameraSource');
    // 표시 텍스트 대입이 아니라 kind 값('sim'|'hucoms')을 select value 로 세팅.
    expect(body).toMatch(/\$\(['"]opt-camera-kind['"]\)\.value\s*=\s*source\?\.kind\s*===\s*['"]hucoms['"]\s*\?\s*['"]hucoms['"]\s*:\s*['"]sim['"]/);
    // 회귀: 과거의 표시 문자열 대입("Hucoms 실카메라")이 남아있지 않아야 함.
    expect(body).not.toMatch(/Hucoms 실카메라/);
  });

  it('captureCameraSourceEdits: 콤보 선택을 source.kind 로 확정한다', () => {
    const body = functionBody(app, 'captureCameraSourceEdits');
    expect(body).toMatch(/source\.kind\s*=\s*\$\(['"]opt-camera-kind['"]\)\.value\s*===\s*['"]hucoms['"]\s*\?\s*['"]hucoms['"]\s*:\s*['"]sim['"]/);
  });

  it('opt-camera-kind change → captureCameraSourceEdits 후 renderCameraSource 재렌더(RTSP·note 동기화)', () => {
    // change 리스너 결선 + 콜백에서 두 함수 호출 확인.
    expect(app).toMatch(/\$\(['"]opt-camera-kind['"]\)\.addEventListener\(\s*['"]change['"]/);
    const idx = app.indexOf("$('opt-camera-kind').addEventListener");
    const region = app.slice(idx, idx + 220);
    expect(region).toContain('captureCameraSourceEdits()');
    expect(region).toMatch(/renderCameraSource\(\s*renderedCameraSourceId\s*\)/);
  });

  it('cameraSettingsPatch: 편집된 kind 가 저장 patch 에 포함된다(백엔드 편집 경로 연결)', () => {
    const body = functionBody(app, 'cameraSettingsPatch');
    expect(body).toMatch(/kind:\s*source\.kind/);
    expect(body).toMatch(/protocol:\s*source\.protocol/); // 정합된 protocol 도 저장된다.
  });
});

describe('alignProtocolToKind — kind 전환 시 protocol 계열 정합(순수)', () => {
  it('hucoms 는 항상 hucoms-v1.22 로 정합(유일 옵션)', () => {
    expect(alignProtocolToKind('hucoms', 'unity-rpc')).toBe('hucoms-v1.22');
    expect(alignProtocolToKind('hucoms', 'hucoms-v1.22')).toBe('hucoms-v1.22');
    expect(alignProtocolToKind('hucoms', undefined)).toBe('hucoms-v1.22');
  });

  it('sim 은 unity 계열이면 유지(RPC/REST 선택 보존)', () => {
    expect(alignProtocolToKind('sim', 'unity-rpc')).toBe('unity-rpc');
    expect(alignProtocolToKind('sim', 'unity-rest')).toBe('unity-rest');
  });

  it('sim 인데 비-unity(hucoms-v1.22·미정의)면 unity-rpc 로 기본 정합(REST 오선택 방지)', () => {
    expect(alignProtocolToKind('sim', 'hucoms-v1.22')).toBe('unity-rpc');
    expect(alignProtocolToKind('sim', undefined)).toBe('unity-rpc');
  });

  it('멱등: 이미 정합된 값이면 그대로', () => {
    expect(alignProtocolToKind('sim', alignProtocolToKind('sim', 'unity-rest'))).toBe('unity-rest');
    expect(alignProtocolToKind('hucoms', alignProtocolToKind('hucoms', 'unity-rpc'))).toBe('hucoms-v1.22');
  });
});

describe('captureCameraSourceEdits — protocol 정합 결선', () => {
  it('kind 확정 직후 alignProtocolToKind 로 source.protocol 을 갱신한다', () => {
    const body = functionBody(app, 'captureCameraSourceEdits');
    expect(body).toMatch(/source\.protocol\s*=\s*alignProtocolToKind\(\s*source\.kind\s*,\s*source\.protocol\s*\)/);
  });
});
