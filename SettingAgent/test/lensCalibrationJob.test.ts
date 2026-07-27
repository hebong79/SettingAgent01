import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LensCalibrationJob, totalForMode, type RunnerApi } from '../src/calibrate/LensCalibrationJob.js';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';

/**
 * LensCalibrationJob 상태머신 검증. 실카/엔진은 목으로 대체(측정 로직은 packages/lens-calib 소유).
 * 여기서 지키는 것: 상태 전이 · 중복/점유 거부 · 중단 · 로그 링버퍼/증분 · 결과 영속화.
 */

const SOURCES: CameraSourceConfig[] = [
  { id: 'real-camera-2', kind: 'hucoms', baseUrl: 'http://192.168.0.154:80', username: 'admin', password: 'x' },
  { id: 'sim-1', kind: 'sim', baseUrl: 'http://localhost:9000' },
] as CameraSourceConfig[];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lenscalib-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const calibFile = (): string => join(dir, 'lens_calibration.json');

/** 지연 없이 즉시 끝나는 목 러너. onProgress 를 원하는 만큼 흘린 뒤 결과를 준다. */
function makeJob(opts: {
  run?: RunnerApi['run'];
  runDistortion?: RunnerApi['runDistortion'];
  verifyDistortion?: RunnerApi['verifyDistortion'];
  isBusy?: () => { busy: boolean; who?: string };
  logLimit?: number;
  onProgressRef?: { fn?: (p: { done: number; total: number; message?: string; sample?: unknown }) => void };
}): LensCalibrationJob {
  return new LensCalibrationJob({
    sources: SOURCES,
    calibFile: calibFile(),
    resultDir: dir,
    ...(opts.isBusy ? { isBusy: opts.isBusy } : {}),
    ...(opts.logLimit ? { logLimit: opts.logLimit } : {}),
    makeRunner: ({ onProgress }) => {
      if (opts.onProgressRef) opts.onProgressRef.fn = onProgress as never;
      return {
        run: opts.run ?? (async () => VERIFY_OK),
        runDistortion: opts.runDistortion ?? (async () => ({ points: [], skipped: [], samples: [], usable: 0, of: 0 })),
        verifyDistortion: opts.verifyDistortion ?? (() => ({ perZoom: [], worstOffPx: null, worstOnPx: null, verdict: 'fail', recommendation: 'reject', unmeasured: [] })),
      } as RunnerApi;
    },
  });
}

const VERIFY_OK = {
  checks: [{ zoom: 8000, residualPx: 2.4, gainNeeded: 0.99, gainApplied: 0.988 }],
  unmeasured: [{ zoom: 0, why: '저조도·무늬부족' }],
  worstPx: 2.4,
  verdict: 'pass',
  calibration: 'cam-001',
  usable: 17,
  of: 18,
} as never;

/** full 모드 목 결과 — CameraCalibration.toJSON() 표면만 흉내낸다. */
const FULL_OK = {
  calibration: {
    toJSON: () => ({
      zoomHfov: [
        { z: 0, h: 62.123456 },
        { z: 8000, h: 20.5 },
      ],
      centeringGain: [{ z: 0, k: 0.988123456 }],
    }),
  },
  points: [],
  skipped: [{ zoom: 16384, why: '대비 부족' }],
  samples: [],
  usable: 100,
  of: 112,
} as never;

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('totalForMode — 엔진 격자에서 유도', () => {
  it('verify=3줌×6타깃=18 · full=14줌×8타깃=112 · distortion=6줌×4회전=24', () => {
    expect(totalForMode('verify')).toBe(18);
    expect(totalForMode('full')).toBe(112);
    expect(totalForMode('distortion')).toBe(24);
  });
});

describe('시작 게이트', () => {
  it('미지 소스 → throw', () => {
    expect(() => makeJob({}).start({ source: 'nope' })).toThrow(/찾을 수 없습니다/);
  });

  it('시뮬레이터 소스 → throw (재는 것 자체가 무의미)', () => {
    expect(() => makeJob({}).start({ source: 'sim-1' })).toThrow(/실카\(hucoms\)가 아닙니다/);
  });

  it('다른 잡이 카메라 점유 중 → throw busy', () => {
    const job = makeJob({ isBusy: () => ({ busy: true, who: '센터라이징' }) });
    expect(() => job.start({ source: 'real-camera-2' })).toThrow(/busy/);
    expect(() => job.start({ source: 'real-camera-2' })).toThrow(/센터라이징/);
  });

  it('중복 시작 → throw already running', async () => {
    let release!: () => void;
    const job = makeJob({ run: () => new Promise((r) => (release = () => r(VERIFY_OK))) });
    job.start({ source: 'real-camera-2', mode: 'verify' });
    expect(() => job.start({ source: 'real-camera-2', mode: 'verify' })).toThrow(/already running/);
    release();
    await settle();
  });
});

describe('상태 전이', () => {
  it('idle → running → done, 요약과 로그가 남는다', async () => {
    const job = makeJob({});
    const started = job.start({ source: 'real-camera-2', mode: 'verify' });
    expect(started).toEqual({ total: 18, mode: 'verify', sourceId: 'real-camera-2' });
    expect(job.getStatus().state).toBe('running');
    expect(job.isRunning()).toBe(true);

    await settle();
    const s = job.getStatus();
    expect(s.state).toBe('done');
    expect(s.result?.verdict).toBe('pass');
    expect(s.result?.worstPx).toBe(2.4);
    expect(s.result?.saved).toBe(false); // verify 는 표를 만들지 않는다
    expect(s.endedAt).toBeTruthy();
    // 미측정 줌은 사유와 함께 로그에 남아야 한다(은닉 금지).
    expect(s.logs.some((l) => l.level === 'warn' && l.text.includes('저조도·무늬부족'))).toBe(true);
  });

  it('엔진 예외 → error 상태 + 사유 보존', async () => {
    const job = makeJob({ run: async () => { throw new Error('fetch failed'); } });
    job.start({ source: 'real-camera-2', mode: 'verify' });
    await settle();
    const s = job.getStatus();
    expect(s.state).toBe('error');
    expect(s.error).toBe('fetch failed');
    expect(s.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('중지 → stopping 을 거쳐 aborted (실패가 아니다)', async () => {
    // 엔진 계약 미러: signal.aborted 면 throw, 실제 엔진은 finally 에서 원위치 복귀.
    const job = makeJob({
      run: ({ signal }) =>
        new Promise((_res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('사용자가 중지했습니다.')));
        }),
    });
    job.start({ source: 'real-camera-2', mode: 'verify' });
    expect(job.stop().state).toBe('stopping');
    expect(job.getStatus().state).toBe('stopping');
    expect(job.isRunning()).toBe(true); // 카메라 복귀 중 — 아직 끝나지 않았다

    await settle();
    const s = job.getStatus();
    expect(s.state).toBe('aborted');
    expect(s.error).toBeUndefined(); // 중지는 error 가 아니다
  });

  it('running 이 아닐 때 stop → throw not running', () => {
    expect(() => makeJob({}).stop()).toThrow(/not running/);
  });
});

describe('진행·로그', () => {
  it('onProgress 가 done/total/message 를 반영하고 로그를 남긴다', async () => {
    const ref: { fn?: (p: never) => void } = {};
    let release!: () => void;
    const job = makeJob({ run: () => new Promise((r) => (release = () => r(VERIFY_OK))), onProgressRef: ref as never });
    job.start({ source: 'real-camera-2', mode: 'verify' });

    ref.fn?.({ done: 3, total: 18, message: 'zoom 8000 · 클릭 (+480, +0)' } as never);
    const s = job.getStatus();
    expect(s.done).toBe(3);
    expect(s.total).toBe(18);
    expect(s.message).toBe('zoom 8000 · 클릭 (+480, +0)');
    expect(s.logs.at(-1)?.text).toBe('[3/18] zoom 8000 · 클릭 (+480, +0)');

    release();
    await settle();
  });

  it('usable:false 샘플은 사유와 함께 warn 로그로 남는다', async () => {
    const ref: { fn?: (p: never) => void } = {};
    let release!: () => void;
    const job = makeJob({ run: () => new Promise((r) => (release = () => r(VERIFY_OK))), onProgressRef: ref as never });
    job.start({ source: 'real-camera-2', mode: 'verify' });

    ref.fn?.({ done: 1, total: 18, sample: { usable: false, zoomAnchor: 0, reason: 'low_contrast' } } as never);
    expect(job.getStatus().logs.some((l) => l.level === 'warn' && l.text.includes('low_contrast'))).toBe(true);

    release();
    await settle();
  });

  it('sinceSeq → 증분만 반환하고 lastSeq 로 다음 기준을 준다', async () => {
    const ref: { fn?: (p: never) => void } = {};
    let release!: () => void;
    const job = makeJob({ run: () => new Promise((r) => (release = () => r(VERIFY_OK))), onProgressRef: ref as never });
    job.start({ source: 'real-camera-2', mode: 'verify' });

    const first = job.getStatus();
    expect(first.logs.length).toBeGreaterThan(0); // sinceSeq 미지정 → 전체(새로고침 복구)
    ref.fn?.({ done: 1, total: 18, message: 'A' } as never);
    ref.fn?.({ done: 2, total: 18, message: 'B' } as never);

    const inc = job.getStatus(first.lastSeq);
    expect(inc.logs.map((l) => l.text)).toEqual(['[1/18] A', '[2/18] B']);
    expect(job.getStatus(inc.lastSeq).logs).toEqual([]); // 새 줄 없으면 빈 배열

    release();
    await settle();
  });

  it('링버퍼 초과 → 오래된 줄을 버리고 logsTruncated 를 켠다(조용한 유실 금지)', async () => {
    const ref: { fn?: (p: never) => void } = {};
    let release!: () => void;
    const job = makeJob({ run: () => new Promise((r) => (release = () => r(VERIFY_OK))), logLimit: 5, onProgressRef: ref as never });
    job.start({ source: 'real-camera-2', mode: 'verify' });

    for (let i = 0; i < 10; i++) ref.fn?.({ done: i, total: 18, message: `m${i}` } as never);
    const s = job.getStatus();
    expect(s.logs).toHaveLength(5);
    expect(s.logsTruncated).toBe(true);
    expect(s.logs.at(-1)?.text).toContain('m9');

    release();
    await settle();
  });
});

describe('결과 영속화', () => {
  it('full 완료 → 표를 enabled:false 로 저장하고 saved:true 를 보고한다', async () => {
    const job = makeJob({ run: async () => FULL_OK });
    job.start({ source: 'real-camera-2', mode: 'full' });
    await settle();

    const s = job.getStatus();
    expect(s.state).toBe('done');
    expect(s.result?.saved).toBe(true);
    expect(s.result?.hfovPoints).toBe(2);
    expect(s.result?.gainPoints).toBe(1);
    expect(s.result?.skipped).toEqual([{ zoom: 16384, why: '대비 부족' }]);

    const file = JSON.parse(readFileSync(calibFile(), 'utf8')) as { cameras: Array<{ id: string; enabled: boolean; zoomHfov: unknown[] }> };
    const entry = file.cameras.find((c) => c.id === 'real-camera-2')!;
    expect(entry.enabled).toBe(false); // ★ 검증 전 자동 활성화 금지
    expect(entry.zoomHfov).toHaveLength(2);
  });

  it('verify 완료 → 보정표 파일을 만들지 않는다', async () => {
    const job = makeJob({});
    job.start({ source: 'real-camera-2', mode: 'verify' });
    await settle();
    expect(() => readFileSync(calibFile(), 'utf8')).toThrow(); // 파일 자체가 없다
  });

  it('distortion reject → 표를 저장하지 않고 사유를 남긴다(안전장치)', async () => {
    const job = makeJob({
      runDistortion: async () => ({ points: [{ z: 5129, k1: 0.17, adopted: true, rms0Px: 33, rms1Px: 31, n: 12 }], skipped: [], samples: [], usable: 12, of: 15 }) as never,
      verifyDistortion: () => ({ perZoom: [], worstOffPx: 33, worstOnPx: 31, verdict: 'fail', recommendation: 'reject', unmeasured: [], reason: '개선 미미' }) as never,
    });
    job.start({ source: 'real-camera-2', mode: 'distortion' });
    await settle();

    const s = job.getStatus();
    expect(s.state).toBe('done'); // reject 는 정상 결과이지 실패가 아니다
    expect(s.result?.saved).toBe(false);
    expect(s.result?.recommendation).toBe('reject');
    expect(() => readFileSync(calibFile(), 'utf8')).toThrow();
    expect(s.logs.some((l) => l.text.includes('저장하지 않았습니다'))).toBe(true);
  });

  it('distortion adopt → 채택점만 저장(enabled:false)', async () => {
    const job = makeJob({
      runDistortion: async () =>
        ({
          points: [
            { z: 0, k1: -0.12, adopted: true, n: 14 },
            { z: 12161, k1: 0, adopted: false, reason: 'not_significant', n: 13 },
          ],
          skipped: [],
          samples: [],
          usable: 27,
          of: 30,
        }) as never,
      verifyDistortion: () => ({ perZoom: [], worstOffPx: 20, worstOnPx: 9, verdict: 'pass', recommendation: 'adopt', unmeasured: [] }) as never,
    });
    job.start({ source: 'real-camera-2', mode: 'distortion' });
    await settle();

    expect(job.getStatus().result?.saved).toBe(true);
    const file = JSON.parse(readFileSync(calibFile(), 'utf8')) as { cameras: Array<{ id: string; enabled: boolean; lensDistortion: unknown[] }> };
    const entry = file.cameras.find((c) => c.id === 'real-camera-2')!;
    expect(entry.lensDistortion).toHaveLength(1); // 기각점은 표에 들어가지 않는다
    expect(entry.enabled).toBe(false);
  });

  it('결과 전문을 소스별 파일로 남긴다(감사용)', async () => {
    const job = makeJob({});
    job.start({ source: 'real-camera-2', mode: 'verify' });
    await settle();
    const raw = JSON.parse(readFileSync(join(dir, 'lens_calib_result_real-camera-2.json'), 'utf8')) as { verdict: string; sourceId: string };
    expect(raw.verdict).toBe('pass');
    expect(raw.sourceId).toBe('real-camera-2');
  });

  it('로그·표시에 비밀번호가 새지 않는다', async () => {
    const job = makeJob({});
    job.start({ source: 'real-camera-2', mode: 'verify' });
    await settle();
    const all = JSON.stringify(job.getStatus());
    expect(all).not.toContain('password');
    expect(all).not.toContain('admin');
  });
});
