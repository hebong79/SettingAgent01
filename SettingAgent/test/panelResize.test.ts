import { describe, it, expect } from 'vitest';
import { clampPanelWidth } from '../web/core.js';

describe('clampPanelWidth (컨트롤 패널 드래그 리사이즈)', () => {
  it('범위 내 값은 정수로 반환', () => {
    expect(clampPanelWidth(400)).toBe(400);
    expect(clampPanelWidth(400.6)).toBe(401);
  });

  it('최소 미만은 min 으로 클램프', () => {
    expect(clampPanelWidth(100)).toBe(260);
  });

  it('최대 초과는 max 로 클램프', () => {
    expect(clampPanelWidth(9999)).toBe(720);
  });

  it('min/max 커스텀', () => {
    expect(clampPanelWidth(150, 200, 600)).toBe(200);
    expect(clampPanelWidth(800, 200, 600)).toBe(600);
    expect(clampPanelWidth(350, 200, 600)).toBe(350);
  });
});
