import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readEditableSettings,
  writeEditableSettings,
  SettingsPatchSchema,
  type SettingsPaths,
} from '../src/config/settingsStore.js';

/**
 * 검증자(qa-tester): 웹 옵션 페이지(④) 설정 I/O.
 * settingsStore(readEditableSettings/writeEditableSettings/SettingsPatchSchema).
 * 임시 config 사본에만 기록(원본 config/*.json 훼손 금지). 외부 REST 무관.
 *
 * 검증 축:
 * - 부분 병합 보존: 대상 필드만 교체, 그 외 섹션·_comment·apiKeyEnv·키 순서 보존(왕복).
 * - 키 비노출: read 결과에 apiKeyEnv(이름)만, 키 값(process.env) 부재.
 * - 검증 거부: 잘못된 URL/detPath/provider + 허용 밖 섹션(strict).
 * - PUT 왕복: patch 적용 후 재읽기 반영.
 */

/** 여러 섹션을 가진 현실적 llm.config 사본(보존 확인용 부가 섹션 포함). */
function seedLlm() {
  return {
    _comment: '보존되어야 하는 주석',
    llm: {
      provider: 'openai-compatible',
      model: 'Qwen/Qwen2.5-VL-32B-Instruct',
      baseUrl: 'http://192.168.0.221:8000/v1',
      apiKeyEnv: 'LLM_API_KEY',
      temperature: 0.1,
      maxTokens: 3072,
      enabled: true,
      timeoutMs: 30000,
      api: 'openai',
      think: false,
      imageMaxEdge: 1288,
    },
    mcp: { enabled: true, transport: 'stdio', servers: [{ name: 'x', transport: 'stdio' }] },
    setupPrompts: { stage1Enabled: true, stage2Enabled: false, stage3Enabled: true },
    floorRoi: { enabled: true, prompt: 'config/prompts/_archive/floor_roi.yaml', timeoutMs: 300000 },
  };
}

/** 여러 섹션을 가진 현실적 tools.config 사본. */
function seedTools() {
  return {
    _comment: 'tools 보존 주석',
    camera: { baseUrl: 'http://localhost:13100', imageTimeoutMs: 7000, zoomMax: 36.0 },
    vpd: { endpoint: 'http://192.168.0.125:9081', detPath: '/vpd/api/v2/det/imgupload', apiKeyEnv: 'VPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
    lpd: { endpoint: 'http://192.168.0.125:9082', detPath: '/lpd/api/v1/imgupload', apiKeyEnv: 'LPD_API_KEY', timeoutMs: 8000, maxRetries: 3 },
    setup: { presetSettleMs: 1000, lpdEnabled: true },
    capture: { defaultCount: 50, intervalMs: 30000 },
    calibrate: { targetPlateWidth: 0.2, outFile: 'data/slot_ptz.json' },
  };
}

let dir: string;
let paths: SettingsPaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-store-'));
  paths = { llmPath: join(dir, 'llm.config.json'), toolsPath: join(dir, 'tools.config.json') };
  writeFileSync(paths.llmPath, JSON.stringify(seedLlm(), null, 2), 'utf-8');
  writeFileSync(paths.toolsPath, JSON.stringify(seedTools(), null, 2), 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readRaw = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, any>;

describe('readEditableSettings (편집 대상 추출 + 키 비노출)', () => {
  it('편집 대상 필드만 반환 (shape 정확 일치)', () => {
    const s = readEditableSettings(paths);
    expect(s).toEqual({
      llm: { provider: 'openai-compatible', model: 'Qwen/Qwen2.5-VL-32B-Instruct', baseUrl: 'http://192.168.0.221:8000/v1', apiKeyEnv: 'LLM_API_KEY' },
      vpd: { endpoint: 'http://192.168.0.125:9081', detPath: '/vpd/api/v2/det/imgupload', apiKeyEnv: 'VPD_API_KEY' },
      lpd: { endpoint: 'http://192.168.0.125:9082', detPath: '/lpd/api/v1/imgupload', apiKeyEnv: 'LPD_API_KEY' },
      camera: { executionMode: 'typescript-native', selectedCameraId: '', sources: [] },
    });
  });

  it('apiKeyEnv 는 키 이름만, 실제 키 값(process.env) 미노출', () => {
    // 실 환경변수에 비밀값이 있어도 반환 객체엔 이름만 있어야 한다.
    const SECRET = 'super-secret-key-value-DO-NOT-LEAK';
    const prev = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = SECRET;
    try {
      const s = readEditableSettings(paths);
      expect(s.llm.apiKeyEnv).toBe('LLM_API_KEY'); // 이름만
      // 직렬화 전체에 비밀 값이 절대 없어야 한다(경계면 유출 차단).
      expect(JSON.stringify(s)).not.toContain(SECRET);
    } finally {
      if (prev === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = prev;
    }
  });

  it('민감·비편집 필드(temperature/maxTokens/enabled/timeoutMs) 는 반환에 미포함', () => {
    const s = readEditableSettings(paths);
    expect(Object.keys(s.llm).sort()).toEqual(['apiKeyEnv', 'baseUrl', 'model', 'provider']);
    expect((s.llm as Record<string, unknown>).temperature).toBeUndefined();
    expect((s.llm as Record<string, unknown>).maxTokens).toBeUndefined();
  });
});

describe('writeEditableSettings (부분 병합 보존 — 왕복)', () => {
  it('대상 필드만 교체, 그 외 섹션·_comment·apiKeyEnv·비편집 필드 모두 보존', () => {
    writeEditableSettings(
      { llm: { model: 'new-model-v2', provider: 'claude' }, vpd: { endpoint: 'http://10.0.0.9:7000' } },
      paths,
    );

    const llm = readRaw(paths.llmPath);
    // 교체된 필드
    expect(llm.llm.model).toBe('new-model-v2');
    expect(llm.llm.provider).toBe('claude');
    // llm 섹션 내 비편집 필드 보존
    expect(llm.llm.apiKeyEnv).toBe('LLM_API_KEY');
    expect(llm.llm.temperature).toBe(0.1);
    expect(llm.llm.maxTokens).toBe(3072);
    expect(llm.llm.enabled).toBe(true);
    expect(llm.llm.baseUrl).toBe('http://192.168.0.221:8000/v1'); // 미변경 필드 유지
    // 다른 섹션·주석 보존
    expect(llm._comment).toBe('보존되어야 하는 주석');
    expect(llm.mcp).toEqual(seedLlm().mcp);
    expect(llm.setupPrompts).toEqual(seedLlm().setupPrompts);
    expect(llm.floorRoi).toEqual(seedLlm().floorRoi);

    const tools = readRaw(paths.toolsPath);
    // 교체된 필드
    expect(tools.vpd.endpoint).toBe('http://10.0.0.9:7000');
    // vpd 섹션 내 비편집 필드 보존
    expect(tools.vpd.detPath).toBe('/vpd/api/v2/det/imgupload');
    expect(tools.vpd.apiKeyEnv).toBe('VPD_API_KEY');
    expect(tools.vpd.timeoutMs).toBe(8000);
    expect(tools.vpd.maxRetries).toBe(3);
    // 다른 섹션 전부 보존
    expect(tools._comment).toBe('tools 보존 주석');
    expect(tools.camera).toEqual(seedTools().camera);
    expect(tools.setup).toEqual(seedTools().setup);
    expect(tools.capture).toEqual(seedTools().capture);
    expect(tools.calibrate).toEqual(seedTools().calibrate);
    expect(tools.lpd).toEqual(seedTools().lpd); // lpd patch 미포함 → 원본 유지
  });

  it('한 파일만 대상인 patch → 다른 config 파일은 건드리지 않음(재포맷 방지)', () => {
    const beforeTools = readFileSync(paths.toolsPath, 'utf-8');
    writeEditableSettings({ llm: { model: 'only-llm' } }, paths);
    // tools.config 는 바이트 단위로 무변경
    expect(readFileSync(paths.toolsPath, 'utf-8')).toBe(beforeTools);
  });

  it('lpd 도 편집 대상(endpoint/detPath) — 왕복 반영', () => {
    writeEditableSettings({ lpd: { endpoint: 'http://lpd.local:9000', detPath: '/lpd/v2/upload' } }, paths);
    const s = readEditableSettings(paths);
    expect(s.lpd.endpoint).toBe('http://lpd.local:9000');
    expect(s.lpd.detPath).toBe('/lpd/v2/upload');
    // vpd 는 미변경
    expect(s.vpd.endpoint).toBe('http://192.168.0.125:9081');
  });

  it('PUT 왕복: write 후 read 가 patch 값 반영', () => {
    const patch = SettingsPatchSchema.parse({
      llm: { model: 'roundtrip-model', baseUrl: 'https://api.example.com/v1' },
      vpd: { detPath: '/new/vpd/path' },
    });
    writeEditableSettings(patch, paths);
    const s = readEditableSettings(paths);
    expect(s.llm.model).toBe('roundtrip-model');
    expect(s.llm.baseUrl).toBe('https://api.example.com/v1');
    expect(s.vpd.detPath).toBe('/new/vpd/path');
  });
});

describe('SettingsPatchSchema (검증 거부)', () => {
  it('유효 patch → success', () => {
    const r = SettingsPatchSchema.safeParse({
      llm: { provider: 'claude', model: 'x', baseUrl: 'http://a:1/v1' },
      vpd: { endpoint: 'http://b:2', detPath: '/vpd' },
      lpd: { endpoint: 'http://c:3', detPath: '/lpd' },
    });
    expect(r.success).toBe(true);
  });

  it('부분 patch(일부 필드만) → success (partial)', () => {
    expect(SettingsPatchSchema.safeParse({ llm: { model: 'only' } }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it('잘못된 baseUrl → 거부', () => {
    expect(SettingsPatchSchema.safeParse({ llm: { baseUrl: 'not a url' } }).success).toBe(false);
  });

  it('잘못된 vpd.endpoint → 거부', () => {
    // 주: 백엔드 zod .url() 은 스킴 무관 URL(ftp 등)을 허용한다(프론트 settingsFormErrors 는 http/https 만).
    // 여기선 URL 파서가 거부하는 진짜 malformed 문자열로 거부를 확인.
    expect(SettingsPatchSchema.safeParse({ vpd: { endpoint: 'not a url' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ vpd: { endpoint: '' } }).success).toBe(false);
  });

  it('/ 로 시작 안 하는 detPath → 거부', () => {
    expect(SettingsPatchSchema.safeParse({ vpd: { detPath: 'vpd/api' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ lpd: { detPath: 'lpd/api' } }).success).toBe(false);
  });

  it('LlmSchema enum 에 없는 provider → 거부', () => {
    expect(SettingsPatchSchema.safeParse({ llm: { provider: 'gpt-9' } }).success).toBe(false);
  });

  it('허용 밖 섹션(lpr) → strict 거부', () => {
    const r = SettingsPatchSchema.safeParse({ lpr: { endpoint: 'http://x:1', detPath: '/lpr' } });
    expect(r.success).toBe(false);
  });

  it('실카메라는 RTSP 필수이며 URL userinfo를 거부', () => {
    const source = { id: 'real-1', label: '실카메라', kind: 'hucoms', baseUrl: 'http://10.0.0.2' } as const;
    expect(SettingsPatchSchema.safeParse({ camera: { source } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ camera: { source: { ...source, rtspUrl: 'http://10.0.0.2/live' } } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ camera: { source: { ...source, rtspUrl: 'rtsp://admin:secret@10.0.0.2/live' } } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ camera: { source: { ...source, rtspUrl: 'rtsp://10.0.0.2/live' } } }).success).toBe(true);
  });

  it('허용 밖 필드(llm.apiKeyEnv 등 키 편집 시도) → 거부(키 편집 불가)', () => {
    // pick 에 apiKeyEnv 없음 → strict 아니어도 partial pick 은 unknown key 무시가 아니라
    // 상위 strict 는 섹션 단위. llm 내부 apiKeyEnv 는 pick 대상 밖이므로 zod strict 미적용 섹션이면 통과 가능.
    // 실제 스키마는 llm 을 .pick().partial() 로 정의(비-strict) → apiKeyEnv 는 조용히 무시된다.
    // 따라서 write 화이트리스트가 최종 방어선임을 아래 write 테스트로 확인.
    const r = SettingsPatchSchema.safeParse({ llm: { apiKeyEnv: 'HACKED' } });
    // 섹션 내부는 strict 가 아니므로 parse 자체는 성공하되 apiKeyEnv 는 data 에서 제거된다.
    expect(r.success).toBe(true);
    if (r.success) expect((r.data.llm as Record<string, unknown>)?.apiKeyEnv).toBeUndefined();
  });
});

describe('writeEditableSettings — 키 편집 화이트리스트 방어(최종)', () => {
  it('apiKeyEnv 를 강제로 밀어넣어도 파일의 키 이름은 불변', () => {
    // 스키마를 우회해 raw patch 로 apiKeyEnv 주입 시도 → write 화이트리스트가 무시해야 한다.
    writeEditableSettings({ llm: { model: 'ok', apiKeyEnv: 'HACKED' } as any }, paths);
    const llm = readRaw(paths.llmPath);
    expect(llm.llm.model).toBe('ok');
    expect(llm.llm.apiKeyEnv).toBe('LLM_API_KEY'); // 원본 유지, 편집 불가
  });
});
