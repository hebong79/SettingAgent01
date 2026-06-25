import { describe, it, expect } from 'vitest';
import { loadToolsConfig, DEFAULT_TOOLS_CONFIG } from '../src/config/toolsConfig.js';
import { loadLlmConfig, DEFAULT_LLM_CONFIG } from '../src/config/llmConfig.js';

describe('config 분리', () => {
  it('tools.config: 없는 경로면 기본값', () => {
    const c = loadToolsConfig('config/__nope__.json');
    expect(c).toEqual(DEFAULT_TOOLS_CONFIG);
    expect(c.camera.zoomMax).toBe(36);
    expect(c.vpd.detPath).toBe('/vpd/api/v2/det/imgupload');
  });

  it('llm.config: 없는 경로면 기본값', () => {
    const c = loadLlmConfig('config/__nope__.json');
    expect(c).toEqual(DEFAULT_LLM_CONFIG);
    expect(c.llm.provider).toBe('qwen3');
  });

  it('실제 config 파일 로드 (도구/LLM 분리)', () => {
    const tools = loadToolsConfig(); // config/tools.config.json
    const llm = loadLlmConfig(); // config/llm.config.json
    // tools 에는 camera/vpd 가, llm 에는 llm/mcp 가 있어 역할이 분리됨
    expect(tools.camera.baseUrl).toMatch(/^http/);
    expect(llm.mcp.servers.length).toBeGreaterThan(0);
    // 교차 오염이 없어야 한다 (tools 에 llm 키 없음, llm 에 camera 키 없음)
    expect((tools as Record<string, unknown>).llm).toBeUndefined();
    expect((llm as Record<string, unknown>).camera).toBeUndefined();
  });

  it('_comment 등 부가 키는 무시되고 파싱 성공', () => {
    expect(() => loadToolsConfig()).not.toThrow();
    expect(() => loadLlmConfig()).not.toThrow();
  });
});
