import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolsConfig, resolveCameraPassword } from '../src/config/toolsConfig.js';
import { readEditableSettings, writeEditableSettings } from '../src/config/settingsStore.js';

/**
 * 검증자(qa-tester): 카메라 비밀번호의 환경변수 이전(passwordEnv).
 * - 해석 우선순위: passwordEnv(값 있음) > password(평문, 하위호환) > undefined
 * - loadToolsConfig 단일 해석 지점(소비자는 해석된 password 만 본다)
 * - writeEditableSettings 가 해석된 비밀번호를 config 파일로 역유출하지 않는지(회귀 방지 — 핵심)
 * 범위 밖: .env 파일 로딩 자체(Node process.loadEnvFile 동작), 실기기 접속.
 */

// ── 임시 config 파일 + process.env 격리 ───────────────────────────────────
const tmpDirs: string[] = [];
const ENV_KEYS = ['__CAM_PW_TEST__', '__CAM_PW_EMPTY__'] as const;
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

/** 테스트에서만 쓰는 환경변수 설정(afterEach 에서 원복). */
function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeTmpConfig(raw: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'campw-'));
  tmpDirs.push(d);
  const p = join(d, 'tools.config.json');
  writeFileSync(p, JSON.stringify(raw, null, 2), 'utf-8');
  return p;
}

const REAL_SOURCE = {
  id: 'real-camera-2',
  label: '리얼 카메라 2',
  kind: 'hucoms',
  protocol: 'hucoms-v1.22',
  baseUrl: 'http://192.168.0.154:80',
  username: 'admin',
  rtspUrl: 'rtsp://192.168.0.154:554/stream1',
};

// ── (1) resolveCameraPassword 우선순위 ────────────────────────────────────
describe('resolveCameraPassword — 해석 우선순위', () => {
  it('passwordEnv 의 환경변수 값이 password(평문)보다 우선한다', () => {
    setEnv('__CAM_PW_TEST__', 'from-env');
    expect(resolveCameraPassword({ password: 'from-file', passwordEnv: '__CAM_PW_TEST__' })).toBe('from-env');
  });

  it('passwordEnv 미설정 → password(평문) 폴백(하위호환)', () => {
    expect(resolveCameraPassword({ password: 'from-file' })).toBe('from-file');
  });

  it('둘 다 없으면 undefined', () => {
    expect(resolveCameraPassword({})).toBeUndefined();
  });

  it('passwordEnv 는 있으나 환경변수가 빈 문자열 → password 폴백', () => {
    setEnv('__CAM_PW_EMPTY__', '');
    expect(resolveCameraPassword({ password: 'from-file', passwordEnv: '__CAM_PW_EMPTY__' })).toBe('from-file');
  });

  it('passwordEnv 는 있으나 환경변수 미설정 + password 없음 → undefined', () => {
    setEnv('__CAM_PW_TEST__', undefined);
    expect(resolveCameraPassword({ passwordEnv: '__CAM_PW_TEST__' })).toBeUndefined();
  });
});

// ── (2) loadToolsConfig 단일 해석 지점 ────────────────────────────────────
describe('loadToolsConfig — 비밀번호 해석은 로더 한 곳에서', () => {
  it('cameraSources 의 passwordEnv 가 환경변수 값으로 해석되어 소비자에게 전달된다', () => {
    setEnv('__CAM_PW_TEST__', 'resolved-secret');
    const p = writeTmpConfig({ cameraSources: [{ ...REAL_SOURCE, passwordEnv: '__CAM_PW_TEST__' }] });
    const cfg = loadToolsConfig(p);
    expect(cfg.cameraSources?.[0].password).toBe('resolved-secret');
    // 이름은 그대로 남아 설정 조회·저장이 규약을 잃지 않는다.
    expect(cfg.cameraSources?.[0].passwordEnv).toBe('__CAM_PW_TEST__');
  });

  it('평문 password 만 있는 기존 설정은 그대로 통과한다(하위호환)', () => {
    const p = writeTmpConfig({ cameraSources: [{ ...REAL_SOURCE, password: 'legacy-plain' }] });
    expect(loadToolsConfig(p).cameraSources?.[0].password).toBe('legacy-plain');
  });

  it('realCamera(단일 소스 설정)도 같은 규칙으로 해석된다', () => {
    setEnv('__CAM_PW_TEST__', 'resolved-secret');
    const p = writeTmpConfig({ cameraMode: 'real', realCamera: { ...REAL_SOURCE, passwordEnv: '__CAM_PW_TEST__' } });
    expect(loadToolsConfig(p).realCamera?.password).toBe('resolved-secret');
  });

  it('환경변수 미설정이면 password 키가 생기지 않는다(미해석이 그대로 드러난다)', () => {
    setEnv('__CAM_PW_TEST__', undefined);
    const p = writeTmpConfig({ cameraSources: [{ ...REAL_SOURCE, passwordEnv: '__CAM_PW_TEST__' }] });
    expect(loadToolsConfig(p).cameraSources?.[0].password).toBeUndefined();
  });
});

// ── (3) 설정 조회/저장이 비밀번호를 파일·API 로 흘리지 않는다 ────────────
describe('settingsStore — 해석된 비밀번호 역유출 금지(회귀)', () => {
  /** tools.config.json + 최소 llm.config.json 을 임시 폴더에 만들고 경로쌍 반환. */
  function writeTmpPaths(raw: Record<string, unknown>) {
    const toolsPath = writeTmpConfig(raw);
    const llmPath = join(toolsPath, '..', 'llm.config.json');
    writeFileSync(llmPath, JSON.stringify({ llm: { provider: 'openai' } }), 'utf-8');
    return { toolsPath, llmPath };
  }

  it('passwordEnv 로 이전한 소스도 passwordSet=true 로 보이되 값은 노출하지 않는다', () => {
    setEnv('__CAM_PW_TEST__', 'resolved-secret');
    const paths = writeTmpPaths({ cameraSources: [{ ...REAL_SOURCE, passwordEnv: '__CAM_PW_TEST__' }] });
    const settings = readEditableSettings(paths);
    expect(settings.camera.sources[0].passwordSet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('resolved-secret');
  });

  it('다른 필드를 저장해도 해석된 비밀번호가 config 파일에 기록되지 않는다', () => {
    setEnv('__CAM_PW_TEST__', 'resolved-secret');
    const paths = writeTmpPaths({ cameraSources: [{ ...REAL_SOURCE, passwordEnv: '__CAM_PW_TEST__' }] });
    writeEditableSettings(
      { camera: { selectedCameraId: 'real-camera-2', source: { id: 'real-camera-2', kind: 'hucoms', label: '리얼 2', rtspUrl: REAL_SOURCE.rtspUrl } } },
      paths,
    );
    const after = readFileSync(paths.toolsPath, 'utf-8');
    expect(after).not.toContain('resolved-secret');
    expect(after).not.toContain('"password"');
    expect(JSON.parse(after).cameraSources[0].passwordEnv).toBe('__CAM_PW_TEST__');
    expect(JSON.parse(after).cameraSources[0].label).toBe('리얼 2');
  });
});
