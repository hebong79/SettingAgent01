import { describe, it, expect } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조, WHATWG URL 만 사용) 직접 import.
import { settingsFormErrors } from '../web/core.js';

/**
 * 검증자(qa-tester): 웹 옵션 페이지(④) 클라이언트 사전검증 순수함수.
 * settingsFormErrors(form) → 오류 메시지 배열. 백엔드 zod(SettingsPatchSchema) 규칙 근사.
 * DOM/fetch 미참조 순수함수(captureCore.test.ts 패턴).
 */

const validForm = () => ({
  llm: { provider: 'claude', model: 'qwen3-8b', baseUrl: 'http://localhost:8000/v1' },
  vpd: { endpoint: 'http://127.0.0.1:9081', detPath: '/vpd/api/v2/det/imgupload' },
  lpd: { endpoint: 'http://127.0.0.1:9082', detPath: '/lpd/api/v1/imgupload' },
});

describe('settingsFormErrors (유효 폼)', () => {
  it('유효 폼 → 오류 0', () => {
    expect(settingsFormErrors(validForm())).toEqual([]);
  });

  it('https URL 도 허용', () => {
    const f = validForm();
    f.llm.baseUrl = 'https://api.anthropic.com/v1';
    expect(settingsFormErrors(f)).toEqual([]);
  });
});

describe('settingsFormErrors (필드별 오류)', () => {
  it('빈 model → 오류', () => {
    const f = validForm();
    f.llm.model = '   ';
    expect(settingsFormErrors(f)).toContain('LLM model 필수');
  });

  it('잘못된 LLM baseUrl(비 http/https) → 오류', () => {
    const f = validForm();
    f.llm.baseUrl = 'ftp://x';
    expect(settingsFormErrors(f)).toContain('LLM Base URL 형식 오류(http/https)');
  });

  it('잘못된 VPD endpoint → 오류', () => {
    const f = validForm();
    f.vpd.endpoint = 'not a url';
    expect(settingsFormErrors(f)).toContain('VPD endpoint 형식 오류(http/https)');
  });

  it('잘못된 LPD endpoint → 오류', () => {
    const f = validForm();
    f.lpd.endpoint = '';
    expect(settingsFormErrors(f)).toContain('LPD endpoint 형식 오류(http/https)');
  });

  it('/ 로 시작 안 하는 VPD detPath → 오류', () => {
    const f = validForm();
    f.vpd.detPath = 'vpd/api';
    expect(settingsFormErrors(f)).toContain('VPD detPath 는 / 로 시작');
  });

  it('/ 로 시작 안 하는 LPD detPath → 오류', () => {
    const f = validForm();
    f.lpd.detPath = 'lpd/api';
    expect(settingsFormErrors(f)).toContain('LPD detPath 는 / 로 시작');
  });

  it('여러 오류 동시 검출', () => {
    const errs = settingsFormErrors({ llm: { model: '', baseUrl: 'x' }, vpd: { endpoint: 'y', detPath: 'z' }, lpd: { endpoint: 'w', detPath: 'q' } });
    expect(errs.length).toBe(6);
  });

  it('form 누락/undefined → 방어(throw 없이 오류 배열)', () => {
    const errs = settingsFormErrors(undefined);
    expect(Array.isArray(errs)).toBe(true);
    expect(errs).toContain('LLM model 필수');
  });
});
