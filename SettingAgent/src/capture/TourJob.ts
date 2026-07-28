// 셋업 결과 순회(Touring) 잡 — PlateDiscoveryJob 상태머신 패턴 미러.
//
// setup_result(읽기전용 정본)를 카메라→프리셋→슬롯 순으로 순회하며 각 위치로 **물리 이동만** 한다.
// ★ DB·파일에 아무것도 쓰지 않는다(웹 `runTouringTest` 주석 계승 → RPC destructive:false).
// ★ 계획 산출은 소유하지 않는다 — 순수함수 `src/setup/touringPlan.ts`(web 파리티본)에 위임하고,
//   이 클래스는 잡 상태머신·PTZ 해석·이동·대기·정지만 담당한다.

import type { ICameraClient } from '../clients/CameraClient.js';
import { buildTouringPlan, type TourStep } from '../setup/touringPlan.js';
import { logger } from '../util/logger.js';
import { resolvePresetPtz } from './detectPipeline.js';

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/** 웹 `runTouringTest` 의 각 위치 1초 대기와 동일한 기본값. */
const DEFAULT_DWELL_MS = 1000;

/**
 * `partial` = **완주했으나 일부 스텝이 실패**했다. `done` 과 반드시 구분한다 —
 * 개별 실패를 흡수하는 것(순회를 죽이지 않는다)과 흡수한 것을 성공으로 보고하는 것은 다른 문제다.
 * 이 기능의 존재 이유가 헤드리스 셋업 검증이므로, 카메라가 안 움직였는데 성공으로 보이면 기능이 무의미해진다.
 */
export type TourState = 'idle' | 'running' | 'stopping' | 'done' | 'partial' | 'aborted' | 'error';

export interface TourStatus {
  state: TourState;
  /** 시도한 스텝 수(성공+실패). 진행률 표시용. */
  done: number;
  total: number;
  presets: number;
  slots: number;
  /**
   * **계획 단계에서 제외된 슬롯 수**(centering 결손 → 애초에 스텝이 만들어지지 않음).
   * 실행 중 실패와는 다른 개념이다 — 실행 실패는 `failed` 를 본다.
   */
  skipped: number;
  /** 카메라 명령이 정상 반환한 스텝 수. */
  succeeded: number;
  /** 카메라 명령이 실패해 흡수된 스텝 수. `>0` 이면 종료 상태가 `partial` 이다. */
  failed: number;
  current?: { kind: 'preset' | 'slot'; camId: number; presetId: number; slotId?: number };
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

export interface TourJobDeps {
  camera: ICameraClient;
  /** setup_result 정본 로더. index.ts 는 `() => saveStore.load(SETUP_RESULT_NAME)` 를 준다. */
  loadSetupResult: () => unknown | null;
  /** 각 위치 정지 시간(기본 1000 — 웹과 동일). */
  dwellMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

/**
 * 순회 잡. 단일 인메모리 상태머신 · 중복 시작 거부 · 스텝 순차 await(PlateDiscoveryJob 과 동일 철학).
 * 개별 스텝 실패는 흡수하고 계속한다(한 프리셋의 이동 실패로 순회 전체를 죽이지 않는다).
 */
export class TourJob {
  private state: TourState = 'idle';
  private done = 0;
  private total = 0;
  private presets = 0;
  private slots = 0;
  private skipped = 0;
  private succeeded = 0;
  private failed = 0;
  private current?: { kind: 'preset' | 'slot'; camId: number; presetId: number; slotId?: number };
  private startedAt?: string;
  private endedAt?: string;
  private error?: string;
  private stopRequested = false;

  private readonly camera: ICameraClient;
  private readonly loadSetupResult: () => unknown | null;
  private readonly dwellMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(deps: TourJobDeps) {
    this.camera = deps.camera;
    this.loadSetupResult = deps.loadSetupResult;
    this.dwellMs = deps.dwellMs ?? DEFAULT_DWELL_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  getStatus(): TourStatus {
    return {
      state: this.state,
      done: this.done,
      total: this.total,
      presets: this.presets,
      slots: this.slots,
      skipped: this.skipped,
      succeeded: this.succeeded,
      failed: this.failed,
      ...(this.current ? { current: this.current } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * 순회 시작(백그라운드 발화 후 미대기). 실패는 전부 throw → 라우트가 상태코드로 번역한다:
   * - `tour already running` → 409(BUSY)
   * - `no setup_result` → 404(NOT_FOUND)
   * - `순회할 슬롯/프리셋이 없습니다` → 409(BUSY 단어 없음 → CONFLICT)
   */
  start(opts: { dwellMs?: number; camera?: ICameraClient } = {}): {
    total: number;
    presets: number;
    slots: number;
    skipped: number;
  } {
    if (this.state === 'running' || this.state === 'stopping') throw new Error('tour already running');
    const setupResult = this.loadSetupResult();
    if (setupResult == null) throw new Error('no setup_result');
    const { steps, skipped } = buildTouringPlan(setupResult);
    if (steps.length === 0) throw new Error('순회할 슬롯/프리셋이 없습니다');

    this.state = 'running';
    this.stopRequested = false;
    this.done = 0;
    this.total = steps.length;
    this.presets = steps.filter((s) => s.kind === 'preset').length;
    this.slots = steps.filter((s) => s.kind === 'slot').length;
    this.skipped = skipped;
    this.succeeded = 0;
    this.failed = 0;
    this.current = undefined;
    this.startedAt = this.now();
    this.endedAt = undefined;
    this.error = undefined;
    void this.run(steps, opts.dwellMs ?? this.dwellMs, opts.camera ?? this.camera);
    return { total: this.total, presets: this.presets, slots: this.slots, skipped: this.skipped };
  }

  /** 정지 요청: running→stopping(다음 스텝 직전에 aborted 로 종료). idle/종료 상태면 무동작(멱등). */
  stop(): void {
    if (this.state !== 'running') return;
    this.stopRequested = true;
    this.state = 'stopping';
  }

  private async run(steps: TourStep[], dwellMs: number, camera: ICameraClient): Promise<void> {
    try {
      for (const step of steps) {
        // 스텝 사이마다 정지 확인(진행 중인 이동은 끊지 않는다 — 카메라 상태를 중간에 버리지 않기 위해).
        if (this.stopRequested) {
          this.finish('aborted');
          return;
        }
        this.current = {
          kind: step.kind,
          camId: step.camId,
          presetId: step.presetId,
          ...(step.slotId != null ? { slotId: step.slotId } : {}),
        };
        try {
          await this.moveTo(step, camera);
          this.succeeded += 1;
        } catch (e) {
          // 개별 스텝 실패는 **흡수하되 센다**(순회 전체를 죽이지 않는다 + 성공으로 위장하지 않는다).
          this.failed += 1;
          logger.warn({ err: e, cam: step.camId, preset: step.presetId, slot: step.slotId }, '순회 스텝 실패(흡수)');
        }
        this.done += 1;
        await this.sleep(dwellMs); // 각 위치 정지(웹의 1초 대기와 동일 위치).
      }
      // 한 스텝이라도 실패했으면 `done` 이 아니다 — 운영자가 순회 성공으로 오판하면 이 기능의 존재 이유가 사라진다.
      this.finish(this.failed > 0 ? 'partial' : 'done');
      logger.info(
        { total: this.total, presets: this.presets, slots: this.slots, succeeded: this.succeeded, failed: this.failed },
        this.failed > 0 ? '순회 잡 완료(일부 스텝 실패)' : '순회 잡 완료',
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      logger.error({ err: e }, '순회 잡 예외 → error');
      this.finish('error');
    }
  }

  /**
   * 스텝 1개 실행.
   * - preset 스텝: 프리셋 PTZ 가 해석되면 move, 미해석이면 `requestImage(cam,preset)` 폴백(**스킵하지 않는다**
   *   — 웹 `gotoPreset()` 폴백과 동일. 일부 실카메라는 PTZ 를 제공하지 않는다).
   * - slot 스텝: 계획이 실어온 centering PTZ 로 move.
   */
  private async moveTo(step: TourStep, camera: ICameraClient): Promise<void> {
    if (step.kind === 'slot') {
      const ptz = step.ptz!;
      await camera.move(step.camId, ptz.pan, ptz.tilt, ptz.zoom);
      return;
    }
    const home = await resolvePresetPtz(camera, step.camId, step.presetId);
    if (home) await camera.move(step.camId, home.pan, home.tilt, home.zoom);
    else await camera.requestImage(step.camId, step.presetId);
  }

  private finish(state: 'done' | 'partial' | 'aborted' | 'error'): void {
    this.current = undefined;
    this.endedAt = this.now();
    this.state = state;
  }
}
