import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('calibrate: 기본값 + 부분 병합(누락 키는 DEFAULT 보강)', () => {
    // 미설정 경로 → DEFAULT 의 calibrate.
    const def = loadToolsConfig('config/__nope__.json');
    expect(def.calibrate.targetPlateWidth).toBe(0.2);
    expect(def.calibrate.outFile).toBe('data/slot_ptz.json');
    expect(def.calibrate.llmAdvise).toBe(true);
    // 실제 config/tools.config.json → calibrate 섹션 파싱.
    const real = loadToolsConfig();
    expect(real.calibrate.centerTol).toBeGreaterThan(0);
    expect(real.calibrate.maxIterations).toBe(15);
  });

  it('floorRoi: 기본값은 비활성(하위호환), 실제 config 는 활성', () => {
    // 미설정 경로 → DEFAULT 의 floorRoi(enabled=false).
    const def = loadLlmConfig('config/__nope__.json');
    expect(def.floorRoi?.enabled).toBe(false);
    expect(def.floorRoi?.maxPerCheckpoint).toBe(12);
    // 실제 config/llm.config.json → enabled=true(gemma 사용).
    const real = loadLlmConfig();
    expect(real.floorRoi?.enabled).toBe(true);
    expect(real.floorRoi?.prompt).toMatch(/floor_roi\.yaml/);
  });

  // 6.4 store.reportsDir default 계약(정밀수집 결과 reports/ 미러).
  const tmpConfigs: string[] = [];
  afterEach(() => {
    for (const f of tmpConfigs) rmSync(f, { recursive: true, force: true });
    tmpConfigs.length = 0;
  });
  function writeTmpConfig(store: Record<string, unknown>): string {
    const d = mkdtempSync(join(tmpdir(), 'toolscfg-'));
    tmpConfigs.push(d);
    const p = join(d, 'tools.config.json');
    writeFileSync(p, JSON.stringify({ store }), 'utf-8');
    return p;
  }

  it('store.reportsDir: 미지정 config → default reports', () => {
    // DEFAULT(파일 없음) 경로.
    expect(DEFAULT_TOOLS_CONFIG.store.reportsDir).toBe('reports');
    expect(loadToolsConfig('config/__nope__.json').store.reportsDir).toBe('reports');
    // store 섹션은 있으나 reportsDir 키만 누락 → 스키마 default('reports') 적용.
    const p = writeTmpConfig({ dataDir: 'd', captureDir: 'c', saveDir: 's' });
    expect(loadToolsConfig(p).store.reportsDir).toBe('reports');
  });

  it('store.reportsDir: 지정 config → 지정값 그대로', () => {
    const p = writeTmpConfig({ dataDir: 'd', captureDir: 'c', saveDir: 's', reportsDir: 'custom_reports' });
    expect(loadToolsConfig(p).store.reportsDir).toBe('custom_reports');
  });

  it('store.reportsDir: 실제 config/tools.config.json → reports', () => {
    expect(loadToolsConfig().store.reportsDir).toBe('reports');
  });

  // 변경2: store.placeRoiFile default 계약(ROI 파일명 config화).
  it('store.placeRoiFile: 미지정 config → default Place01/PtzCamRoi.json', () => {
    // DEFAULT(파일 없음) 경로.
    expect(DEFAULT_TOOLS_CONFIG.store.placeRoiFile).toBe('Place01/PtzCamRoi.json');
    expect(loadToolsConfig('config/__nope__.json').store.placeRoiFile).toBe('Place01/PtzCamRoi.json');
    // store 섹션은 있으나 placeRoiFile 키만 누락 → 스키마 default 적용.
    const p = writeTmpConfig({ dataDir: 'd', captureDir: 'c', saveDir: 's' });
    expect(loadToolsConfig(p).store.placeRoiFile).toBe('Place01/PtzCamRoi.json');
  });

  it('store.placeRoiFile: 지정 config → 지정값 그대로', () => {
    const p = writeTmpConfig({ dataDir: 'd', captureDir: 'c', saveDir: 's', placeRoiFile: 'Place02/CustomRoi.json' });
    expect(loadToolsConfig(p).store.placeRoiFile).toBe('Place02/CustomRoi.json');
  });

  it('store.placeRoiFile: 실제 config/tools.config.json → Place01/PtzCamRoi.json', () => {
    expect(loadToolsConfig().store.placeRoiFile).toBe('Place01/PtzCamRoi.json');
  });

  it('그라운딩 해상도·타임아웃 상향: 실제 config imageMaxEdge=1288, floorRoi.timeoutMs 파싱', () => {
    // 기본(하위호환)은 960 유지, 실제 파일만 1288 로 상향(설계 §6).
    const def = loadLlmConfig('config/__nope__.json');
    expect(def.llm.imageMaxEdge).toBe(960);
    expect(def.floorRoi?.timeoutMs).toBe(120000); // default 계약
    const real = loadLlmConfig();
    expect(real.llm.imageMaxEdge).toBe(1288);
    expect(real.floorRoi?.timeoutMs).toBe(300000); // 파일 명시(고해상도 32B 대비)
  });
});
