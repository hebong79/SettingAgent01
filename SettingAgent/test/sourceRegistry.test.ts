import { describe, it, expect } from 'vitest';
import { buildSourceRegistry } from '../src/viewer/sourceRegistry.js';
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../src/config/toolsConfig.js';
import { SimulatorSource } from '../src/viewer/SimulatorSource.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';

/** buildSourceRegistry 입력(camera + cameraSources)만 발췌. */
type RegistryCfg = Pick<ToolsConfig, 'camera' | 'cameraSources'>;
const base = (): RegistryCfg => ({ camera: structuredClone(DEFAULT_TOOLS_CONFIG.camera), cameraSources: undefined });

describe('buildSourceRegistry — 하위호환/다중소스', () => {
  it('cameraSources 미설정 → sim 단일 폴백(id=sim)', () => {
    const tools = base();
    expect(tools.cameraSources).toBeUndefined();
    const reg = buildSourceRegistry(tools);
    expect([...reg.keys()]).toEqual(['sim']);
    expect(reg.get('sim')).toBeInstanceOf(SimulatorSource);
    expect(reg.get('sim')!.kind).toBe('sim');
  });

  it('cameraSources 빈 배열 → sim 단일 폴백', () => {
    const tools = base();
    tools.cameraSources = [];
    const reg = buildSourceRegistry(tools);
    expect([...reg.keys()]).toEqual(['sim']);
  });

  it('다중 소스(sim + hucoms) 등록·선택', () => {
    const tools = base();
    tools.cameraSources = [
      { id: 'unity', kind: 'sim', baseUrl: 'http://localhost:13100' },
      { id: 'ptz1', kind: 'hucoms', host: '192.168.0.153', port: 80 },
    ];
    const reg = buildSourceRegistry(tools);
    expect([...reg.keys()]).toEqual(['unity', 'ptz1']);
    expect(reg.get('unity')).toBeInstanceOf(SimulatorSource);
    expect(reg.get('ptz1')).toBeInstanceOf(RealPtzSource);
    expect(reg.get('ptz1')!.kind).toBe('hucoms');
  });

  it('첫 소스 = registry 삽입 순서 첫번째(라우트 pickSource 기본값 근거)', () => {
    const tools = base();
    tools.cameraSources = [
      { id: 'ptz1', kind: 'hucoms', host: '10.0.0.1' },
      { id: 'unity', kind: 'sim' },
    ];
    const reg = buildSourceRegistry(tools);
    const first = reg.values().next().value;
    expect(first).toBe(reg.get('ptz1'));
  });
});
