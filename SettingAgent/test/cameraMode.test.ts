import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolsConfig, DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../src/config/toolsConfig.js';
import { buildSourceRegistry } from '../src/viewer/sourceRegistry.js';
import { CameraposSource } from '../src/viewer/CameraposSource.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';
import { SimulatorSource } from '../src/viewer/SimulatorSource.js';

/**
 * 검증자(qa-tester): 리얼/시뮬 카메라 선택 설정(cameraMode).
 * 설계서 §6 / 02 구현내역 기준.
 * - config 파싱·기본값·잘못된 값 거부
 * - loadToolsConfig 스칼라 병합 가드(회귀 방지 — 핵심)
 * - realCamera 통과
 * - buildSourceRegistry 3분기(simulator/real/precedence) + fail-fast throw
 * 범위 밖: 리얼 실기기 연동, 리얼 정밀수집(RpcCameraClient) 경로(항상 Unity RPC 13110 사용).
 */

// ── 임시 config 파일 유틸(config.test.ts 패턴 재사용) ──────────────────────
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
/** 주어진 raw 객체를 tools.config.json 으로 써서 경로 반환. */
function writeTmpConfig(raw: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'cammode-'));
  tmpDirs.push(d);
  const p = join(d, 'tools.config.json');
  writeFileSync(p, JSON.stringify(raw), 'utf-8');
  return p;
}

// ── (1) config 로드/기본값 ────────────────────────────────────────────────
describe('cameraMode — config 로드/기본값', () => {
  it('cameraMode 미지정 → default "simulator"', () => {
    // store 만 있는 최소 config (cameraMode 키 없음) → 스키마 default 적용.
    const p = writeTmpConfig({ store: { dataDir: 'd', captureDir: 'c', saveDir: 's' } });
    expect(loadToolsConfig(p).cameraMode).toBe('simulator');
  });

  it('DEFAULT_TOOLS_CONFIG.cameraMode === "simulator", realCamera 미포함', () => {
    expect(DEFAULT_TOOLS_CONFIG.cameraMode).toBe('simulator');
    expect(DEFAULT_TOOLS_CONFIG.realCamera).toBeUndefined();
    // 파일 없는 경로 → DEFAULT 그대로.
    expect(loadToolsConfig('config/__nope__.json').cameraMode).toBe('simulator');
  });

  it('실제 config/tools.config.json → "simulator" 로드', () => {
    expect(loadToolsConfig().cameraMode).toBe('simulator');
  });

  it('명시 "real" 로드', () => {
    const p = writeTmpConfig({
      cameraMode: 'real',
      realCamera: { id: 'real', kind: 'hucoms', host: '192.168.0.153', port: 80 },
    });
    expect(loadToolsConfig(p).cameraMode).toBe('real');
  });

  it('명시 "simulator" 로드', () => {
    const p = writeTmpConfig({ cameraMode: 'simulator' });
    expect(loadToolsConfig(p).cameraMode).toBe('simulator');
  });

  it('잘못된 cameraMode 값 → zod 파싱 throw(거부)', () => {
    const p = writeTmpConfig({ cameraMode: 'hucoms' }); // enum 밖
    expect(() => loadToolsConfig(p)).toThrow();
  });
});

// ── (2) 스칼라 병합 회귀(핵심) ─────────────────────────────────────────────
describe('cameraMode — loadToolsConfig 스칼라 병합 가드(회귀 방지)', () => {
  it('cameraMode="real" 이 문자-인덱스 객체로 안 깨지고 정확히 "real" 문자열', () => {
    const p = writeTmpConfig({
      cameraMode: 'real',
      realCamera: { id: 'real', kind: 'hucoms', host: '192.168.0.153', port: 80 },
    });
    const cfg = loadToolsConfig(p);
    // 병합 버그(객체 스프레드)라면 zod enum 파싱 자체가 실패(throw)하거나
    // 문자-인덱스 객체({0:'r',...})가 되어 문자열 동등 비교가 깨진다.
    // (주: JS 문자열은 인덱스 접근 가능한 primitive 이므로 ['0'] 검사는 무의미 — enum·동등 비교로 검증.)
    expect(typeof cfg.cameraMode).toBe('string');
    expect(cfg.cameraMode).toBe('real');
  });

  it('다른 스칼라 필드도 무회귀(객체 섹션 병합 동작 불변)', () => {
    // 객체 섹션은 부분 병합(누락 키 DEFAULT 보강)이 유지되어야 한다.
    const p = writeTmpConfig({
      cameraMode: 'simulator',
      camera: { baseUrl: 'http://localhost:19999' }, // 나머지 키 누락 → DEFAULT 보강
    });
    const cfg = loadToolsConfig(p);
    expect(cfg.camera.baseUrl).toBe('http://localhost:19999');
    expect(cfg.camera.zoomMax).toBe(DEFAULT_TOOLS_CONFIG.camera.zoomMax); // 병합 보강 확인
    expect(cfg.cameraMode).toBe('simulator');
  });
});

// ── (3) realCamera 통과 ───────────────────────────────────────────────────
describe('cameraMode — realCamera 파싱 통과', () => {
  it('realCamera(CameraSourceConfig 형태) 그대로 파싱', () => {
    const rc = { id: 'real', kind: 'hucoms', host: '192.168.0.153', port: 80, loginPath: '/cgi-bin/login.cgi' };
    const p = writeTmpConfig({ cameraMode: 'real', realCamera: rc });
    const cfg = loadToolsConfig(p);
    expect(cfg.realCamera).toEqual(rc);
    expect(cfg.realCamera?.id).toBe('real');
    expect(cfg.realCamera?.kind).toBe('hucoms');
  });

  it('realCamera.kind 가 enum 밖이면 파싱 throw', () => {
    const p = writeTmpConfig({ cameraMode: 'real', realCamera: { id: 'x', kind: 'bogus' } });
    expect(() => loadToolsConfig(p)).toThrow();
  });
});

// ── (4) buildSourceRegistry 분기 ──────────────────────────────────────────
type RegistryCfg = Pick<ToolsConfig, 'camera' | 'cameraSources' | 'unityRpc' | 'map' | 'cameraMode' | 'realCamera'>;
const base = (): RegistryCfg => ({
  camera: structuredClone(DEFAULT_TOOLS_CONFIG.camera),
  cameraSources: undefined,
  unityRpc: structuredClone(DEFAULT_TOOLS_CONFIG.unityRpc),
  map: structuredClone(DEFAULT_TOOLS_CONFIG.map),
  cameraMode: 'simulator',
  realCamera: undefined,
});

describe('buildSourceRegistry — cameraMode 분기', () => {
  it('simulator(cameraSources 미설정) → CameraposSource(id="rpc") 1개', () => {
    const reg = buildSourceRegistry(base());
    expect([...reg.keys()]).toEqual(['rpc']);
    expect(reg.get('rpc')).toBeInstanceOf(CameraposSource);
    expect(reg.get('rpc')!.kind).toBe('rpc');
  });

  it('cameraMode 미지정(undefined)이어도 simulator 폴백 동작', () => {
    // 방어적: 타입상 default 지만, 런타임 값이 없어도 real 분기로 새지 않음.
    const cfg = { ...base(), cameraMode: undefined as unknown as 'simulator' };
    const reg = buildSourceRegistry(cfg);
    expect([...reg.keys()]).toEqual(['rpc']);
    expect(reg.get('rpc')).toBeInstanceOf(CameraposSource);
  });

  it('real + realCamera 있음 → RealPtzSource(id=realCamera.id)', () => {
    const cfg = base();
    cfg.cameraMode = 'real';
    cfg.realCamera = { id: 'real', kind: 'hucoms', host: '192.168.0.153', port: 80, rtspUrl: 'rtsp://192.168.0.153/stream1' };
    const reg = buildSourceRegistry(cfg);
    expect([...reg.keys()]).toEqual(['real']);
    expect(reg.get('real')).toBeInstanceOf(RealPtzSource);
    expect(reg.get('real')!.kind).toBe('hucoms');
    expect(reg.get('real')!.streamTransport).toBe('rtsp-ffmpeg');
  });

  it('real + realCamera.id 커스텀 → 해당 id 를 키로 사용', () => {
    const cfg = base();
    cfg.cameraMode = 'real';
    cfg.realCamera = { id: 'ptz-front', kind: 'hucoms', host: '10.0.0.9', rtspUrl: 'rtsp://10.0.0.9/stream1' };
    const reg = buildSourceRegistry(cfg);
    expect([...reg.keys()]).toEqual(['ptz-front']);
    expect(reg.get('ptz-front')).toBeInstanceOf(RealPtzSource);
  });

  it('real + realCamera 없음 → throw(fail-fast, 명확 메시지)', () => {
    const cfg = base();
    cfg.cameraMode = 'real';
    cfg.realCamera = undefined;
    expect(() => buildSourceRegistry(cfg)).toThrow('리얼 카메라(realCamera) 설정이 없습니다');
  });

  it('cameraSources 명시(길이>0) → cameraMode="real" 무시(precedence: cameraSources 우선)', () => {
    const cfg = base();
    cfg.cameraMode = 'real'; // 무시되어야 함
    cfg.realCamera = undefined; // real 분기라면 throw 였을 것
    cfg.cameraSources = [
      { id: 'unity', kind: 'sim', baseUrl: 'http://localhost:13100' },
      { id: 'ptz1', kind: 'hucoms', host: '192.168.0.153', port: 80, rtspUrl: 'rtsp://192.168.0.153/stream1' },
    ];
    const reg = buildSourceRegistry(cfg);
    // real 로 새지 않고 다중 경로가 이겨야 한다.
    expect([...reg.keys()]).toEqual(['unity', 'ptz1']);
    expect(reg.get('unity')).toBeInstanceOf(SimulatorSource);
    expect(reg.get('ptz1')).toBeInstanceOf(RealPtzSource);
  });
});
