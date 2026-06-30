import { describe, it, expect } from 'vitest';
import { loadPromptPair, renderTemplate } from '../src/brain/prompts.js';

describe('loadPromptPair (yaml system/user 프롬프트)', () => {
  it('floor_roi.yaml 을 system/user 로 로드', () => {
    const { system, user } = loadPromptPair('config/prompts/floor_roi.yaml');
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system).toContain('바닥'); // 바닥 점유 영역 지시
    expect(system).toContain('[앞왼'); // 순서 규약
    expect(user).toContain('{{vehicle}}'); // 템플릿 플레이스홀더 보존
  });

  it('user 템플릿 치환', () => {
    const { user } = loadPromptPair('config/prompts/floor_roi.yaml');
    const out = renderTemplate(user, { camIdx: '1', presetIdx: '2', vehicle: '{x:0.1}', plate: '(없음)' });
    expect(out).toContain('camera=1');
    expect(out).toContain('preset=2');
    expect(out).not.toContain('{{vehicle}}');
  });

  it('system/user 없는 yaml 은 에러', () => {
    // 존재하지 않는 경로 → readFileSync 에러(또는 누락 에러). 어느 쪽이든 throw.
    expect(() => loadPromptPair('config/prompts/__none__.yaml')).toThrow();
  });
});
