import { describe, it, expect } from 'vitest';
import { loadPromptPair, renderTemplate } from '../src/brain/prompts.js';

describe('loadPromptPair (yaml system/user 프롬프트)', () => {
  it('floor_roi.yaml 을 system/user 로 로드(픽셀 그라운딩 규약)', () => {
    const { system, user } = loadPromptPair('config/prompts/floor_roi.yaml');
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system).toContain('바닥'); // 바닥 점유 영역 지시
    expect(system).toContain('points_2d'); // 절대픽셀 4점 출력 스키마
    expect(system).toContain('front-left'); // 순서 규약(앞왼 → front-left)
    expect(system).toContain('{{imgW}}'); // 전송 이미지 픽셀 크기 주입
    expect(user).toContain('{{vehiclePx}}'); // 픽셀 bbox 플레이스홀더 보존
    expect(user).toContain('{{imgW}}');
    expect(user).toContain('{{imgH}}');
  });

  it('user 템플릿 치환(imgW/imgH/vehiclePx)', () => {
    const { user } = loadPromptPair('config/prompts/floor_roi.yaml');
    const out = renderTemplate(user, { camIdx: '1', presetIdx: '2', imgW: '1288', imgH: '728', vehiclePx: '[258,218,773,509]' });
    expect(out).toContain('camera=1');
    expect(out).toContain('preset=2');
    expect(out).toContain('1288x728px');
    expect(out).toContain('[258,218,773,509]');
    expect(out).not.toContain('{{'); // 모든 플레이스홀더 치환
  });

  it('system/user 없는 yaml 은 에러', () => {
    // 존재하지 않는 경로 → readFileSync 에러(또는 누락 에러). 어느 쪽이든 throw.
    expect(() => loadPromptPair('config/prompts/__none__.yaml')).toThrow();
  });

  it('ptz_centering.yaml 로드 + 2단계 워크플로·치환', () => {
    const { system, user } = loadPromptPair('config/prompts/ptz_centering.yaml');
    expect(system).toContain('pan/tilt'); // center 단계
    expect(system).toContain('zoom'); // zoom 단계
    expect(user).toContain('{{phase}}');
    expect(user).toContain('{{plateWidth}}');
    const out = renderTemplate(user, { phase: 'center', errX: '0.100', errY: '-0.050', plateWidth: '0.120', targetWidth: '0.2', centerTol: '0.03' });
    expect(out).toContain('단계=center');
    expect(out).not.toContain('{{');
  });
});
