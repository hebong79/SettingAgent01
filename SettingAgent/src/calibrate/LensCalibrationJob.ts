// 렌즈 캘리브레이션 배치 잡(설계서 20260727). PlateDiscoveryJob 상태머신 패턴 미러.
//
// 측정 로직은 **소유하지 않는다** — @parkagent/lens-calib 의 CalibrationRunner 에 전부 위임하고,
// 이 클래스는 잡 상태머신 · 진행/로그 버퍼 · 중단 신호 · 결과 영속화만 담당한다.
//
// ★ 카메라 복귀는 엔진 책임이다(runner 의 `finally { goHome() }`). 이 잡은 abort 신호만 보내고
//   엔진이 원위치로 돌려놓을 때까지 `stopping` 을 유지한다 — 그래서 정지 직후 곧바로 idle 이 되지
//   않는다. "멈췄다"고 먼저 말해버리면 사용자는 아직 슬루 중인 카메라에 다음 명령을 쏜다.

import { CalibrationRunner, FrameMatcher, FULL_ZOOMS, FULL_DX, FULL_DY, VERIFY_ZOOMS, VERIFY_DX, VERIFY_DY, DISTORTION_ZOOMS } from '@parkagent/lens-calib';
import type { AbReport, CalibrationSpec, DistortionRunResult, FullRunResult, HucomsCameraPort, SweepProgress, VerifyReport } from '@parkagent/lens-calib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CameraSourceConfig } from '../config/toolsConfig.js';
import { logger } from '../util/logger.js';
import { stringify5 } from '../util/round.js';
import { makeHucomsCameraPort, resolveHucomsBaseUrl } from './hucomsCameraPort.js';
import { upsertLensCalibration } from './lensCalibFile.js';

export type LensCalibMode = 'full' | 'verify' | 'distortion';
export type LensCalibState = 'idle' | 'running' | 'stopping' | 'done' | 'aborted' | 'error';

export interface LensCalibLogLine {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** 완료 요약(UI 표시용). 모드별로 채워지는 필드가 다르다. */
export interface LensCalibResultSummary {
  mode: LensCalibMode;
  /** 표가 실제로 파일에 기록됐는가(=적용 버튼을 띄울 수 있는가). verify 는 항상 false. */
  saved: boolean;
  usable: number;
  of: number;
  /** verify: PASS/FAIL 판정 · distortion: A/B 판정. */
  verdict?: string;
  worstPx?: number | null;
  /** verify 줌별 잔차·게인. */
  checks?: VerifyReport['checks'];
  /** distortion A/B 줌별 OFF→ON. */
  perZoom?: AbReport['perZoom'];
  recommendation?: AbReport['recommendation'];
  /** 측정 못 한 줌 + 사유(은닉 금지). */
  unmeasured?: Array<{ zoom: number; why: string }>;
  /** full: 표 생성 결과 요약. */
  hfovPoints?: number;
  gainPoints?: number;
  skipped?: Array<{ zoom: number; why: string }>;
  reason?: string;
}

export interface LensCalibStatus {
  state: LensCalibState;
  mode: LensCalibMode | null;
  sourceId: string | null;
  done: number;
  total: number;
  message: string;
  startedAt?: string;
  endedAt?: string;
  logs: LensCalibLogLine[];
  /** 링버퍼에서 밀려난 줄이 있는가(조용한 유실 금지). */
  logsTruncated: boolean;
  /** 서버가 가진 최신 seq — 클라가 다음 폴에 sinceSeq 로 되돌려준다. */
  lastSeq: number;
  result?: LensCalibResultSummary;
  error?: string;
}

/** 이 잡이 쓰는 러너 표면(테스트 시임 경계). */
export interface RunnerApi {
  run(opts: { mode?: 'full' | 'verify'; signal?: AbortSignal }): Promise<FullRunResult | VerifyReport>;
  runDistortion(opts: { signal?: AbortSignal }): Promise<DistortionRunResult>;
  verifyDistortion(samples: DistortionRunResult['samples'], points: DistortionRunResult['points']): AbReport;
}

export interface LensCalibrationJobDeps {
  /** 캘리브레이션 대상 후보(config.cameraSources). id 로 찾는다. */
  sources: CameraSourceConfig[];
  /** data/lens_calibration.json 경로(보정표 정본). */
  calibFile: string;
  /** 결과 전문 저장 디렉터리. `lens_calib_result_<id>.json` 로 쓴다. */
  resultDir: string;
  /** 다른 잡이 카메라를 점유 중인지. 하나라도 true 면 시작을 거부한다. */
  isBusy?: () => { busy: boolean; who?: string };
  /** 러너 팩토리 주입(테스트 시임). 기본 = 실제 CalibrationRunner + Hucoms 포트. */
  makeRunner?: (args: { source: CameraSourceConfig; onProgress: (p: SweepProgress) => void }) => RunnerApi;
  now?: () => string;
  /** 로그 링버퍼 크기. */
  logLimit?: number;
}

/** 모드별 총 샘플 수(시작 응답용). 엔진 격자 상수에서 유도 — 격자가 바뀌면 함께 따라온다. */
export function totalForMode(mode: LensCalibMode): number {
  if (mode === 'verify') return VERIFY_ZOOMS.length * (VERIFY_DX.length + VERIFY_DY.length);
  if (mode === 'distortion') return DISTORTION_ZOOMS.length * 4; // 줌당 회전 4회(pan±/tilt±)
  return FULL_ZOOMS.length * (FULL_DX.length + FULL_DY.length);
}

/**
 * 렌즈 캘리브레이션 잡. 단일 인메모리 상태머신, 중복 시작 거부, 진행/로그 폴 제공.
 */
export class LensCalibrationJob {
  private state: LensCalibState = 'idle';
  private mode: LensCalibMode | null = null;
  private sourceId: string | null = null;
  private done = 0;
  private total = 0;
  private message = '';
  private startedAt?: string;
  private endedAt?: string;
  private result?: LensCalibResultSummary;
  private errorMsg?: string;
  private controller: AbortController | null = null;

  private logs: LensCalibLogLine[] = [];
  private seq = 0;
  private truncated = false;

  private readonly sources: CameraSourceConfig[];
  private readonly calibFile: string;
  private readonly resultDir: string;
  private readonly isBusy: () => { busy: boolean; who?: string };
  private readonly makeRunner: NonNullable<LensCalibrationJobDeps['makeRunner']>;
  private readonly now: () => string;
  private readonly logLimit: number;

  constructor(deps: LensCalibrationJobDeps) {
    this.sources = deps.sources;
    this.calibFile = deps.calibFile;
    this.resultDir = deps.resultDir;
    this.isBusy = deps.isBusy ?? (() => ({ busy: false }));
    this.now = deps.now ?? (() => new Date().toISOString());
    this.logLimit = deps.logLimit ?? 500;
    this.makeRunner =
      deps.makeRunner ??
      (({ source, onProgress }) =>
        new CalibrationRunner({
          camera: makeHucomsCameraPort(source),
          // 지금 설치된 표를 넘긴다 — verify 는 이 표가 이 개체에 맞나를 묻는 것이므로 필수다.
          // 생성(full)·곡면율은 엔진이 어차피 rawAim 으로 우회한다.
          calibration: 'cam-001',
          matcher: new FrameMatcher({ frameWidth: 1920, frameHeight: 1080 }),
          onProgress,
        }) as unknown as RunnerApi);
  }

  /** 대상 소스를 찾고 실카인지 확인한다. 실패 사유는 그대로 400 으로 나간다. */
  private resolveSource(sourceId: string): CameraSourceConfig {
    const src = this.sources.find((s) => s.id === sourceId);
    if (!src) throw new Error(`카메라 소스 "${sourceId}" 를 찾을 수 없습니다`);
    if (src.kind !== 'hucoms') throw new Error(`소스 "${sourceId}" 는 실카(hucoms)가 아닙니다 — 렌즈 캘리브레이션 대상이 아닙니다`);
    return src;
  }

  start({ source, mode = 'full' }: { source: string; mode?: LensCalibMode }): { total: number; mode: LensCalibMode; sourceId: string } {
    if (this.state === 'running' || this.state === 'stopping') throw new Error('already running');
    const busy = this.isBusy();
    if (busy.busy) throw new Error(`busy — 다른 잡이 카메라를 사용 중입니다${busy.who ? ` (${busy.who})` : ''}`);
    const src = this.resolveSource(source);

    this.state = 'running';
    this.mode = mode;
    this.sourceId = src.id;
    this.done = 0;
    this.total = totalForMode(mode);
    this.message = '시작 준비 중…';
    this.startedAt = this.now();
    this.endedAt = undefined;
    this.result = undefined;
    this.errorMsg = undefined;
    this.logs = [];
    this.seq = 0;
    this.truncated = false;
    this.controller = new AbortController();

    this.log('info', `렌즈 캘리브레이션 시작 — 대상 ${src.id} (${safeUrl(src)}) · 모드 ${mode} · 예상 샘플 ${this.total}`);
    void this.execute(src, mode, this.controller.signal);
    return { total: this.total, mode, sourceId: src.id };
  }

  stop(): { state: LensCalibState } {
    if (this.state !== 'running') throw new Error('not running');
    this.state = 'stopping';
    this.message = '정지 요청 — 카메라를 원위치로 되돌리는 중';
    this.log('warn', '사용자 정지 요청 — 진행 중인 스윕을 중단하고 원 PTZ 로 복귀합니다.');
    this.controller?.abort();
    return { state: this.state };
  }

  /** @param sinceSeq 이 seq 초과 로그만 돌려준다(증분 폴). 미지정이면 버퍼 전체(새로고침 복구). */
  getStatus(sinceSeq?: number): LensCalibStatus {
    const logs = typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) ? this.logs.filter((l) => l.seq > sinceSeq) : [...this.logs];
    return {
      state: this.state,
      mode: this.mode,
      sourceId: this.sourceId,
      done: this.done,
      total: this.total,
      message: this.message,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      logs,
      logsTruncated: this.truncated,
      lastSeq: this.seq,
      ...(this.result ? { result: this.result } : {}),
      ...(this.errorMsg ? { error: this.errorMsg } : {}),
    };
  }

  isRunning(): boolean {
    return this.state === 'running' || this.state === 'stopping';
  }

  private log(level: LensCalibLogLine['level'], text: string): void {
    this.logs.push({ seq: ++this.seq, at: this.now(), level, text });
    if (this.logs.length > this.logLimit) {
      this.logs.splice(0, this.logs.length - this.logLimit);
      this.truncated = true;
    }
  }

  private onProgress(p: SweepProgress): void {
    if (p.total > 0) this.total = p.total;
    this.done = p.done;
    if (p.message) {
      this.message = p.message;
      this.log('info', `[${p.done}/${p.total}] ${p.message}`);
    }
    // 실패한 샘플은 사유와 함께 남긴다 — 저조도·무늬부족은 코드 문제가 아니라 현장 조건이고,
    // 그 구분이 로그에 없으면 운영자가 "고장났다"고 오해한다.
    if (p.sample && p.sample.usable === false) {
      this.log('warn', `샘플 실패(zoom ${p.sample.zoomAnchor}) — ${p.sample.reason ?? 'unknown'}${p.sample.matchError ? `: ${p.sample.matchError}` : ''}`);
    }
  }

  private async execute(src: CameraSourceConfig, mode: LensCalibMode, signal: AbortSignal): Promise<void> {
    try {
      const runner = this.makeRunner({ source: src, onProgress: (p) => this.onProgress(p) });
      const result = mode === 'distortion' ? await this.runDistortion(runner, src, signal) : await this.runClickSweep(runner, src, mode, signal);
      this.result = result;
      this.state = 'done';
      this.message = '완료';
      this.log('info', `완료 — ${summaryLine(result)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 사용자 중지는 실패가 아니다 — 상태를 구분해야 UI 가 빨간 실패로 오인하지 않는다.
      if (signal.aborted) {
        this.state = 'aborted';
        this.message = '중지됨';
        this.log('warn', '중지 완료 — 카메라는 원 PTZ 로 복귀했습니다.');
      } else {
        this.state = 'error';
        this.errorMsg = msg;
        this.message = `실패 — ${msg}`;
        this.log('error', `실패 — ${msg}`);
        logger.warn({ err, source: src.id, mode }, '렌즈 캘리브레이션 실패');
      }
    } finally {
      this.endedAt = this.now();
      this.controller = null;
    }
  }

  private async runClickSweep(runner: RunnerApi, src: CameraSourceConfig, mode: LensCalibMode, signal: AbortSignal): Promise<LensCalibResultSummary> {
    const out = await runner.run({ mode: mode === 'verify' ? 'verify' : 'full', signal });

    if (mode === 'verify') {
      const v = out as VerifyReport;
      this.writeResultFile(src.id, v);
      for (const u of v.unmeasured) this.log('warn', `줌 ${u.zoom} 미측정 — ${u.why}`);
      return {
        mode,
        saved: false, // 검증은 표를 만들지 않는다.
        usable: v.usable,
        of: v.of,
        verdict: v.verdict,
        worstPx: v.worstPx,
        checks: v.checks,
        unmeasured: v.unmeasured,
      };
    }

    const f = out as FullRunResult;
    this.writeResultFile(src.id, { calibration: f.calibration.toJSON(), points: f.points, skipped: f.skipped, usable: f.usable, of: f.of });
    for (const s of f.skipped) this.log('warn', `줌 ${s.zoom} 건너뜀 — ${s.why}`);
    const spec: CalibrationSpec = f.calibration.toJSON();
    const entry = upsertLensCalibration(this.calibFile, src.id, {
      ...(spec.zoomHfov ? { zoomHfov: spec.zoomHfov } : {}),
      ...(spec.centeringGain ? { centeringGain: spec.centeringGain } : {}),
      host: src.host ?? safeUrl(src),
      measuredAt: this.now(),
    });
    this.log('info', `표 저장 — ${this.calibFile} (enabled:false · 적용하려면 [이 표 적용] 후 서버 재시작)`);
    return {
      mode,
      saved: true,
      usable: f.usable,
      of: f.of,
      hfovPoints: entry.zoomHfov?.length ?? 0,
      gainPoints: entry.centeringGain?.length ?? 0,
      skipped: f.skipped.map((s) => ({ zoom: s.zoom, why: s.why ?? '사유 불명' })),
    };
  }

  private async runDistortion(runner: RunnerApi, src: CameraSourceConfig, signal: AbortSignal): Promise<LensCalibResultSummary> {
    const d = await runner.runDistortion({ signal });
    const ab = runner.verifyDistortion(d.samples, d.points);
    this.writeResultFile(src.id, { points: d.points, skipped: d.skipped, ab, usable: d.usable, of: d.of });
    for (const p of d.points) this.log('info', `z${p.z} k1=${p.k1} 잔차 ${p.rms0Px}→${p.rms1Px}px n=${p.n} ${p.adopted ? '채택' : `기각(${p.reason})`}`);
    for (const s of d.skipped) this.log('warn', `줌 ${s.zoom} 건너뜀 — ${s.why}`);
    this.log(ab.recommendation === 'adopt' ? 'info' : 'warn', `A/B ${ab.verdict} · 권고 ${ab.recommendation}${ab.reason ? ` — ${ab.reason}` : ''}`);

    // ★ reject 면 파일을 건드리지 않는다. 2026-07-25 실측에서 스퓨리어스 핀쿠션이 채택될 뻔했고,
    //   그때 A/B 가 막았다. reject 는 정상 결과이며 실패가 아니다.
    const adopted = d.points.filter((p) => p.adopted);
    let saved = false;
    if (ab.recommendation === 'adopt' && adopted.length > 0) {
      upsertLensCalibration(this.calibFile, src.id, {
        lensDistortion: adopted,
        host: src.host ?? safeUrl(src),
        measuredAt: this.now(),
      });
      saved = true;
      this.log('info', `곡면율 표 저장 — ${adopted.length}점 (enabled:false)`);
    } else {
      this.log('warn', '곡면율 표를 저장하지 않았습니다 — A/B 가 개선을 확인하지 못했습니다(안전장치 정상 동작).');
    }

    return {
      mode: 'distortion',
      saved,
      usable: d.usable,
      of: d.of,
      verdict: ab.verdict,
      perZoom: ab.perZoom,
      recommendation: ab.recommendation,
      unmeasured: ab.unmeasured,
      ...(ab.reason ? { reason: ab.reason } : {}),
    };
  }

  /** 결과 전문(감사용). 실패해도 잡을 죽이지 않는다 — 측정 자체는 이미 끝났다. */
  private writeResultFile(sourceId: string, payload: unknown): void {
    const file = join(this.resultDir, `lens_calib_result_${sourceId}.json`);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${stringify5({ sourceId, mode: this.mode, measuredAt: this.now(), ...(payload as object) }, 2)}\n`, 'utf8');
      this.log('info', `결과 전문 저장 — ${file}`);
    } catch (e) {
      this.log('warn', `결과 전문 저장 실패(측정 결과는 유효) — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 로그·표시에 자격증명이 새지 않도록 host 만 뽑는다. */
function safeUrl(src: CameraSourceConfig): string {
  try {
    return new URL(resolveHucomsBaseUrl(src)).host;
  } catch {
    return src.host ?? src.id;
  }
}

function summaryLine(r: LensCalibResultSummary): string {
  if (r.mode === 'verify') return `판정 ${r.verdict} · 최악 잔차 ${r.worstPx ?? 'n/a'}px · 대응 ${r.usable}/${r.of}`;
  if (r.mode === 'distortion') return `A/B ${r.verdict} · 권고 ${r.recommendation} · 대응 ${r.usable}/${r.of}`;
  return `화각 ${r.hfovPoints}점 · 게인 ${r.gainPoints}점 · 대응 ${r.usable}/${r.of}`;
}
