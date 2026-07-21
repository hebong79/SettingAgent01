import { describe, it, expect, vi } from 'vitest';
import { CaptureJob, type CaptureJobDeps } from '../src/capture/CaptureJob.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { VpdClient } from '../src/clients/VpdClient.js';
import type { CapturedImage, VehicleBox, NormalizedQuad } from '../src/domain/types.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import type { SetupTarget } from '../src/setup/SetupOrchestrator.js';

/**
 * 검증자(qa-tester): CaptureJob 상태머신 (G1 — fake timers).
 * setTimer/sleep/now 주입. idle→running→done(count)/stopped(manual)/error.
 * 중복 start 거부. 프리셋 일부 실패 흡수. 적재 호출(DB) 검증.
 */

const captureCfg: ToolsConfig['capture'] = {
  defaultCount: 50, intervalMs: 1000, moveIntervalMs: 1000, checkpointEvery: 10,
  checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, dbFile: ':memory:',
  clusterDist: 0.06, clusterMinSupport: 3, minConfidence: 0.5, slotAssignGate: 0.12, moveBeforeCapture: true,
};

const vb = (x: number): VehicleBox => ({ rect: { x, y: 0.2, w: 0.1, h: 0.1 }, confidence: 0.9, cls: 'car' });

function fakeCamera(): CameraClient {
  return {
    requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
      camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: `i-${camIdx}-${presetIdx}`, jpg: Buffer.from('img'),
    }),
  } as unknown as CameraClient;
}
function fakeVpd(boxes: VehicleBox[] = [vb(0.2)]): VpdClient {
  return { detect: async () => boxes } as unknown as VpdClient;
}

const targets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }];

/** fake setTimer: 핸들을 큐에 모아 수동 발화(즉시 0 + 주기 모두 동일 처리). */
function makeManualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const h = { fn, ms } as { fn: () => void; ms: number };
    queue.push(h);
    return h as unknown as NodeJS.Timeout;
  };
  const clearTimer = (h: NodeJS.Timeout): void => {
    const idx = queue.indexOf(h as unknown as { fn: () => void; ms: number });
    if (idx >= 0) queue.splice(idx, 1);
  };
  /** 가장 오래된 예약을 1개 발화(runRound 는 async — microtask flush 위해 await). */
  const fireNext = async (): Promise<boolean> => {
    const h = queue.shift();
    if (!h) return false;
    h.fn();
    // runRound 의 await 체인을 비우기 위해 여러 틱 flush.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return true;
  };
  return { setTimer, clearTimer, fireNext, queueLen: () => queue.length };
}

function makeJob(over: Partial<CaptureJobDeps> = {}) {
  const timers = makeManualTimers();
  const deps: CaptureJobDeps = {
    camera: fakeCamera(),
    vpd: fakeVpd(),
    cfg: captureCfg,
    lpdEnabled: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    now: () => 'T',
    ...over,
  };
  return { job: new CaptureJob(deps), timers };
}

describe('CaptureJob 시작/중복 (G1)', () => {
  it('start → running + runId (인메모리 runSeq)', () => {
    const { job } = makeJob();
    const { runId } = job.start({ count: 3, intervalMs: 1000, checkpointEvery: 10, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    expect(runId).toBeGreaterThan(0);
    const st = job.getStatus();
    expect(st.state).toBe('running');
    expect(st.planned).toBe(3);
    expect(st.runId).toBe(runId);
  });

  /**
   * 수정 22 — 직전 run 의 프레임 버퍼가 새 run 화면에 새는 표시 버그 회귀 고정.
   * `lastFrameByPreset` 만 비우고 `lastFrame` 을 남기면 /capture/frame 이 **직전 run 의 화면**을 서빙한다.
   */
  it('★start → 직전 run 의 lastFrame 을 서빙하지 않는다(수정 22)', () => {
    const { job } = makeJob();
    const stale = { jpeg: Buffer.from('OLD'), camIdx: 1, presetIdx: 1, roundIdx: 7 };
    Reflect.set(job, 'lastFrame', stale);
    expect(job.getLastFrame()).toEqual(stale);
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 10, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    expect(job.getLastFrame()).toBeUndefined();
  });

  it('running 중 중복 start → throw (라우트에서 409 매핑)', () => {
    const { job } = makeJob();
    job.start({ count: 3, intervalMs: 1000, checkpointEvery: 10, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    expect(() => job.start({ count: 3, intervalMs: 1000, checkpointEvery: 10, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets })).toThrow('capture already running');
  });
});

describe('CaptureJob onFinished 콜백 throw 흡수 (T9 — 파이프라인 배선)', () => {
  it('done 완료 콜백이 throw 해도 잡은 죽지 않고 done 종단·콜백에 status 전달', async () => {
    let called: string | undefined;
    const { job, timers } = makeJob({
      onFinished: (status) => { called = status; throw new Error('콜백 폭발'); },
    });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext(); // 라운드1 → count 도달 → finishRun('done') → onFinished throw(흡수).
    expect(called).toBe('done');
    expect(job.getStatus().state).toBe('done'); // 예외 흡수 — 상태는 정상 종단.
  });

  it('stopped 즉시 종료 경로에서도 콜백 throw 흡수(state=stopped)', () => {
    let called: string | undefined;
    const { job } = makeJob({
      onFinished: (status) => { called = status; throw new Error('콜백 폭발'); },
    });
    job.start({ count: 5, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    job.stop(); // roundRunning=false → 즉시 finishRun('stopped') → onFinished throw(흡수).
    expect(called).toBe('stopped');
    expect(job.getStatus().state).toBe('stopped');
  });
});

describe('CaptureJob 프레임/시각 (수집 관찰·경과)', () => {
  it('라운드 후 getLastFrame = 마지막 타깃 프레임, status에 startedAt/endedAt', async () => {
    const { job, timers } = makeJob();
    expect(job.getLastFrame()).toBeUndefined();
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    expect(job.getStatus().startedAt).toBe('T');
    await timers.fireNext(); // 라운드1(두 타깃) → count=1 도달 → done
    const f = job.getLastFrame();
    expect(f).toBeDefined();
    expect(f!.camIdx).toBe(1);
    expect(f!.presetIdx).toBe(2); // 마지막 타깃(순회 마지막 프리셋)
    expect(f!.roundIdx).toBe(1);
    expect(f!.jpeg.toString()).toBe('img');
    const st = job.getStatus();
    expect(st.state).toBe('done');
    expect(st.endedAt).toBe('T');
  });

  it('getFramePresets/getFrameByPreset: 여러 카메라 프레임을 모두 보관·조회(미리보기 순환용)', async () => {
    const { job, timers } = makeJob();
    const multiCam: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }, { camIdx: 2, presetIdx: 1 }];
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: multiCam });
    await timers.fireNext(); // 라운드1: cam1p1, cam2p1 캡처
    // 이번 run 에서 캡처된 모든 프리셋(양쪽 카메라)이 정렬되어 조회된다.
    expect(job.getFramePresets()).toEqual([{ camIdx: 1, presetIdx: 1 }, { camIdx: 2, presetIdx: 1 }]);
    expect(job.getFrameByPreset(2, 1)?.toString()).toBe('img'); // 카메라2 프레임 보관 확인
    expect(job.getFrameByPreset(1, 1)?.toString()).toBe('img');
    expect(job.getFrameByPreset(9, 9)).toBeUndefined();
  });

  it('moveBeforeCapture=true + ptz 타깃 → 캡처 전 프리셋 PTZ 로 카메라 이동(/req_move) 호출', async () => {
    const moves: Array<{ cam: number; pan: number; tilt: number; zoom: number }> = [];
    const camera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => ({
        camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img'),
      }),
      move: async (cam: number, pan: number, tilt: number, zoom: number): Promise<boolean> => {
        moves.push({ cam, pan, tilt, zoom });
        return true;
      },
    } as unknown as CameraClient;
    const { job, timers } = makeJob({ camera });
    // 카메라2 프리셋 PTZ 가 시뮬레이터에 전달돼 활성 카메라가 실제로 이동하는지 검증.
    const ptzTargets: SetupTarget[] = [{ camIdx: 2, presetIdx: 1, ptz: { pan: 113.8, tilt: 6, zoom: 1.7 } }];
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: ptzTargets });
    await timers.fireNext();
    expect(moves).toEqual([{ cam: 2, pan: 113.8, tilt: 6, zoom: 1.7 }]);
  });
});

describe('CaptureJob count 종료 (G1)', () => {
  it('count 라운드 도달 → done(state), planned 일치, 적재 검증', async () => {
    const { job, timers } = makeJob();
    job.start({ count: 2, intervalMs: 1000, checkpointEvery: 10, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });

    // 첫 라운드(setTimer ms=0) 발화.
    await timers.fireNext();
    expect(job.getStatus().done).toBe(1);
    // 2번째 라운드(intervalMs 예약) 발화 → count 도달.
    await timers.fireNext();

    const st = job.getStatus();
    expect(st.state).toBe('done');
    expect(st.done).toBe(2);
    // 적재: 2라운드 × 2프리셋 = 4 관측, 각 vehicle 1건 → 4 검출.
    const dets = job.getSnapshot().dets;
    expect(dets).toHaveLength(4);
    expect(dets.every((d) => d.kind === 'vehicle')).toBe(true);
    // 더 발화할 타이머 없음(완료 후 미예약).
    expect(timers.queueLen()).toBe(0);
  });
});

describe('CaptureJob 수동 정지 (G1)', () => {
  it('라운드 사이 stop → 현재 라운드 후 stopped(manual), 다음 미예약', async () => {
    const { job, timers } = makeJob();
    job.start({ count: 10, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext(); // 라운드 1 완료(다음 라운드 예약됨)
    expect(job.getStatus().state).toBe('running');
    expect(timers.queueLen()).toBe(1); // 다음 라운드 예약 1건

    job.stop(); // 라운드 진행 중 아님 → 즉시 stopped, 예약 취소
    const st = job.getStatus();
    expect(st.state).toBe('stopped');
    expect(timers.queueLen()).toBe(0); // 다음 발화 취소
  });

  it('stop()은 running 이 아닐 때 no-op', () => {
    const { job } = makeJob();
    expect(() => job.stop()).not.toThrow(); // idle
    expect(job.getStatus().state).toBe('idle');
  });

  it('라운드 진행 중 stop → 다음 타깃 캡처 전 탈출(captureTarget 호출 수 < targets 수), stopped(manual)', async () => {
    // 설계 §4-a: 타깃 for 루프 상단 stopping 확인. 첫 타깃 캡처 직후 stop() 을 유도 →
    // 두 번째 타깃(preset2) 캡처 전 break → requestImage 호출 수가 targets(2) 미만.
    let calls = 0;
    let jobRef: CaptureJob | undefined;
    const threeTargets: SetupTarget[] = [
      { camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }, { camIdx: 1, presetIdx: 3 },
    ];
    const stoppingCamera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        calls += 1;
        if (calls === 1) jobRef!.stop(); // 첫 타깃 캡처 시점에 정지 요청 → 다음 타깃 진입 전 break
        return { camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img') };
      },
    } as unknown as CameraClient;
    const { job, timers } = makeJob({ camera: stoppingCamera });
    jobRef = job;
    job.start({ count: 10, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: threeTargets });
    await timers.fireNext(); // 라운드1 발화: 타깃1 캡처 → stop → 타깃2/3 진입 전 break

    expect(calls).toBe(1); // 첫 타깃만 캡처, 나머지 2개는 stopping 으로 스킵
    const st = job.getStatus();
    expect(st.state).toBe('stopped');
    expect(timers.queueLen()).toBe(0); // 다음 라운드 미예약(무한 대기 없음)
  });

  it('checkpoint 직전 stop → occupancyReviewer.review 미호출(checkpoint 스킵), stopped', async () => {
    // 설계 §4-b: done%checkpointEvery===0 이지만 stopping 이면 checkpoint 게이트 &&currentState!=='stopping' 로 스킵.
    // checkpointEvery=1(매 라운드 대상). 마지막 타깃 캡처에서 stop() → 게이트에서 스킵.
    let calls = 0;
    let jobRef: CaptureJob | undefined;
    const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
    const occupancyReviewer = { review: reviewSpy } as unknown as CaptureJobDeps['occupancyReviewer'];
    const twoTargets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }];
    const stopOnLastCamera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        calls += 1;
        if (calls === 2) jobRef!.stop(); // 마지막 타깃(2/2) 캡처 시점 정지 → 루프 정상 종료 후 checkpoint 게이트 스킵
        return { camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img') };
      },
    } as unknown as CameraClient;
    const { job, timers } = makeJob({ camera: stopOnLastCamera, occupancyReviewer });
    jobRef = job;
    job.start({ count: 10, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: twoTargets });
    await timers.fireNext();

    expect(calls).toBe(2); // 두 타깃 모두 캡처(stop 은 마지막 타깃에서) → 루프는 정상 완료
    expect(reviewSpy).not.toHaveBeenCalled(); // checkpoint 진입 전 stopping 확인으로 스킵
    const st = job.getStatus();
    expect(st.state).toBe('stopped');
    expect(timers.queueLen()).toBe(0);
  });

  it('정상(정지 없음) 라운드 → checkpoint 실행(회귀: occupancyReviewer.review 에 shouldStop 콜백 전달)', async () => {
    // §4-b 대비군: stop 없이 checkpointEvery 도달 시 checkpoint 가 정상 호출되고, 4번째 인자로 콜백(fn)이 전달됨.
    const reviewSpy = vi.fn(async () => ({ llmUnavailable: false }));
    const occupancyReviewer = { review: reviewSpy } as unknown as CaptureJobDeps['occupancyReviewer'];
    const { job, timers } = makeJob({ occupancyReviewer });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    // 4번째 인자 shouldStop 은 함수(진행 중 checkpoint 조기탈출용).
    const call = reviewSpy.mock.calls[0] as unknown[];
    expect(typeof call[3]).toBe('function');
  });
});

// ★ 삭제됨: 'CaptureJob 정지 반응성 — advisory reviewer 게이트 (B1)' describe 블록(원래 2건).
// 사유: 이 두 테스트는 제거된 CheckpointReviewer(구 `reviewer` deps)의 전용 배선을 검증했다.
//   1) 'checkpoint warmup 중 stop → advisory reviewer.review 미호출' — 구 아키텍처는 checkpoint() 진입 전체를
//      `currentState()!=='stopping'` 게이트로 막아 reviewer.review 호출 자체를 차단했다. 신 아키텍처
//      (occupancyReviewer)는 그 게이트가 없다 — checkpoint() 는 warmup 중 stop() 이 걸려도 계속 진행해
//      occupancyReviewer.review 를 **항상 호출**하고, 대신 review() 내부에 전달된 shouldStop 콜백이
//      프리셋별로 조기 중단시킨다(OccupancyReviewer.review 참고). "미호출" 단언은 신 아키텍처에서 거짓이 된다
//      — 마이그레이션이 아니라 반대 동작을 새로 지어내는 것이라 "행동을 지어내지 말라" 지침에 위배된다.
//   2) '대조군' — reviewer.review 호출 인자 shape(runId, roundIdx, planned, aggregated slots, newFacesRecentK)
//      은 CheckpointReviewer 전용 구 시그니처다. OccupancyReviewer.review 는 전혀 다른 시그니처
//      (atRound, framesByPreset Map, occByPreset Map, shouldStop, expectedByPreset)라 대응되는 인자가 없다.
//      "checkpoint 도달 시 occupancyReviewer.review 1회 호출 + 인자 shape" 자체는 이미
//      captureCheckpointTrigger.test.ts('occupancyReviewer 결선')·captureJobOccupancyGate.test.ts 가 커버한다.
//   집계(옛 replaceAggregatedSlots)가 정지 중에도 수행된다는 불변식은 위 checkpoint 직전 stop 테스트들
//   (occupancyReviewer.review 미호출/호출)이 이미 state 전이로 간접 확인하며, checkpoint() 는 여전히
//   `this.aggregated = aggregate(...)` 를 게이트 없이(무조건) 실행한다(CaptureJob.ts checkpoint() 참고).

describe('CaptureJob 예외/흡수 (G1)', () => {
  it('프리셋 일부 캡처 실패 → 흡수(잡 미중단)', async () => {
    let calls = 0;
    const flakyCamera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        calls += 1;
        if (presetIdx === 2) throw new Error('preset2 캡처 실패');
        return { camIdx, presetIdx, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('i') };
      },
    } as unknown as CameraClient;
    const { job, timers } = makeJob({ camera: flakyCamera });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    // 잡은 정상 완료(흡수). preset1 적재만 존재.
    expect(job.getStatus().state).toBe('done');
    expect(calls).toBe(2); // 두 프리셋 모두 시도
    const dets = job.getSnapshot().dets;
    expect(dets).toHaveLength(1); // preset1 vehicle 만 적재(preset2 실패)
    expect(dets[0].presetIdx).toBe(1);
  });

  it('체크포인트 중 예외(occupancyReviewer.review 실패) → error 상태', async () => {
    // 구 테스트는 store.updateRunProgress 를 던지게 패치해 "프리셋 루프 밖 예외 → error" 를 유도했다.
    // DB 가 사라져 그 경로는 없다 — 대신 checkpoint() 내부 occupancyReviewer.review 호출은
    // try/catch 로 감싸여 있지 않다(CaptureJob.ts checkpoint() 참고) → 여기서 던지면 runRound() 의
    // 바깥 try/catch 가 잡아 동일하게 error 상태로 귀결된다(동등한 "라운드 전역 예외" 경로).
    const occupancyReviewer = {
      review: async () => { throw new Error('occupancy 판정 폭발'); },
    } as unknown as CaptureJobDeps['occupancyReviewer'];
    const { job, timers } = makeJob({ occupancyReviewer });
    job.start({ count: 2, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(job.getStatus().state).toBe('error');
  });
});

describe('CaptureJob 라운드 내 프리셋 이동 페이싱 (moveIntervalMs, TC1~5)', () => {
  // 페이싱 격리 근거: CaptureJob 내 sleep() 은 페이싱 전용(라운드 간 대기는 setTimer,
  // checkpoint 는 sleep 미사용). 따라서 sleep spy 호출 = 페이싱 호출.
  // monotonic 은 가변 시계 nowMs 로 구동. requestImage 훅에서 nowMs 를 사이클 소요만큼 전진 →
  //   t0 = 캡처 전 monotonic(), 캡처 후 monotonic() = t0 + elapsed 로 결정적 산출.

  /** 타깃별 사이클 소요(ms) 배열을 받아, captureTarget 진입 시 해당 소요만큼 시계를 전진시키는 camera + monotonic. */
  function pacedDeps(elapsedPerTarget: number[]) {
    let nowMs = 0;
    let capIdx = 0;
    const camera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        // 이 타깃 사이클이 소비한 시간을 시계에 반영(캡처+검출 포함 elapsed 모사).
        nowMs += elapsedPerTarget[capIdx] ?? 0;
        capIdx += 1;
        return { camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img') };
      },
    } as unknown as CameraClient;
    const monotonic = () => nowMs;
    return { camera, monotonic };
  }

  it('TC1 elapsed<interval → 잔여(interval-elapsed) 로 페이싱 sleep 1회(마지막 제외)', async () => {
    // 타깃 2개, 각 사이클 elapsed=400ms, moveIntervalMs=1000 → 타깃1 뒤 sleep(600) 1회, 타깃2(마지막) 없음.
    const sleepSpy = vi.fn(async () => {});
    const { camera, monotonic } = pacedDeps([400, 400]);
    const { job, timers } = makeJob({ camera, monotonic, sleep: sleepSpy });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets }); // targets=2개
    await timers.fireNext();
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(600);
    expect(job.getStatus().state).toBe('done');
  });

  it('TC2 elapsed>=interval → rest<=0 → 페이싱 sleep 미호출', async () => {
    // 타깃1 elapsed=1200ms(>1000) → rest=-200 → sleep 미호출. 마지막 타깃도 미적용 → 0회.
    const sleepSpy = vi.fn(async () => {});
    const { camera, monotonic } = pacedDeps([1200, 1200]);
    const { job, timers } = makeJob({ camera, monotonic, sleep: sleepSpy });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(job.getStatus().state).toBe('done');
  });

  it('TC3 마지막 타깃 뒤 패딩 없음 → 타깃 3개 각 elapsed=100 → sleep 2회, 각 인자 900', async () => {
    const sleepSpy = vi.fn(async (_ms: number) => {});
    const three: SetupTarget[] = [
      { camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }, { camIdx: 1, presetIdx: 3 },
    ];
    const { camera, monotonic } = pacedDeps([100, 100, 100]);
    const { job, timers } = makeJob({ camera, monotonic, sleep: sleepSpy });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: three });
    await timers.fireNext();
    // 타깃1·2 뒤에만(타깃3 마지막 제외) → 2회, 각 잔여 900.
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([900, 900]);
  });

  it('TC4 stopping 중 페이싱 sleep 생략 + 정지 즉시반응(회귀 없음)', async () => {
    // 타깃1 캡처 시점에 stop() → 타깃1 뒤 페이싱 게이트(currentState!=='stopping') 로 sleep 생략,
    // 타깃2 진입 전 break → stopped(manual).
    const sleepSpy = vi.fn(async () => {});
    let capIdx = 0;
    let nowMs = 0;
    let jobRef: CaptureJob | undefined;
    const camera = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        nowMs += 100; // elapsed=100 < 1000 → 정상이면 페이싱 대상이나 stopping 이라 생략돼야 함
        capIdx += 1;
        if (capIdx === 1) jobRef!.stop();
        return { camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img') };
      },
    } as unknown as CameraClient;
    const { job, timers } = makeJob({ camera, monotonic: () => nowMs, sleep: sleepSpy });
    jobRef = job;
    job.start({ count: 10, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(capIdx).toBe(1); // 타깃2 진입 전 break(즉시반응)
    expect(sleepSpy).not.toHaveBeenCalled(); // 페이싱 sleep 생략
    const st = job.getStatus();
    expect(st.state).toBe('stopped');
    expect(timers.queueLen()).toBe(0);
  });

  it('TC5 moveIntervalMs=0 → 페이싱 없음', async () => {
    const sleepSpy = vi.fn(async () => {});
    const { camera, monotonic } = pacedDeps([100, 100]);
    const cfg0: ToolsConfig['capture'] = { ...captureCfg, moveIntervalMs: 0 };
    const { job, timers } = makeJob({ camera, monotonic, sleep: sleepSpy, cfg: cfg0 });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(job.getStatus().state).toBe('done');
  });

  it('TC5b moveBeforeCapture=false → 이동 없으면 페이싱 게이트 차단(sleep 미호출)', async () => {
    // 게이트에 cfg.moveBeforeCapture 포함(리더 확정 A) → move=off 면 elapsed<interval 여도 페이싱 미적용.
    const sleepSpy = vi.fn(async () => {});
    const { camera, monotonic } = pacedDeps([100, 100]);
    const cfgNoMove: ToolsConfig['capture'] = { ...captureCfg, moveBeforeCapture: false };
    const { job, timers } = makeJob({ camera, monotonic, sleep: sleepSpy, cfg: cfgNoMove });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(job.getStatus().state).toBe('done');
  });
});

describe('CaptureJob warm-up 트리거 (§d — brain.warmup)', () => {
  it('start() → brain.warmup 1회 발화(non-blocking), start 반환이 warmup 에 안 막힘', () => {
    // start() 는 동기 반환. warmup 은 void 발화(await 안 함) → 반환 전 이미 1회 호출(동기 시작).
    const warmup = vi.fn(async () => true);
    const brain = { enabled: true, warmup } as unknown as CaptureJobDeps['brain'];
    const { job } = makeJob({ brain });
    const { runId } = job.start({ count: 3, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    expect(runId).toBeGreaterThan(0);
    expect(job.getStatus().state).toBe('running'); // warmup await 로 지연되지 않음(동기 반환)
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('checkpoint 도달 → brain.warmup await(라운드 warmup + checkpoint warmup)', async () => {
    // checkpointEvery=1 → 라운드1 완료 후 checkpoint 진입 시 warmup 재보장.
    // start 발화(1) + checkpoint(1) = 총 2회. occupancyReviewer 미주입이어도 warmup 은 checkpoint 진입 즉시 호출.
    const warmup = vi.fn(async () => true);
    const brain = { enabled: true, warmup } as unknown as CaptureJobDeps['brain'];
    const { job, timers } = makeJob({ brain });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    expect(warmup).toHaveBeenCalledTimes(1); // start 발화
    await timers.fireNext(); // 라운드1 → checkpoint 진입 → warmup 재보장
    expect(warmup).toHaveBeenCalledTimes(2);
    expect(job.getStatus().state).toBe('done');
  });

  it('stopping 중 checkpoint 게이트 스킵 → checkpoint warmup 미호출(start 발화 1회만)', async () => {
    // 마지막 타깃 캡처에서 stop() → checkpoint 게이트(currentState!=='stopping')로 checkpoint 전체 스킵.
    // 따라서 checkpoint 내 warmup 도 호출 안 됨 → 총 1회(start 발화)만.
    let calls = 0;
    let jobRef: CaptureJob | undefined;
    const warmup = vi.fn(async () => true);
    const brain = { enabled: true, warmup } as unknown as CaptureJobDeps['brain'];
    const twoTargets: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }, { camIdx: 1, presetIdx: 2 }];
    const stopOnLast = {
      requestImage: async (camIdx: number, presetIdx: number): Promise<CapturedImage> => {
        calls += 1;
        if (calls === 2) jobRef!.stop();
        return { camIdx, presetIdx, pan: 1, tilt: 2, zoom: 3, imgName: 'i', jpg: Buffer.from('img') };
      },
    } as unknown as CameraClient;
    const { job, timers } = makeJob({ brain, camera: stopOnLast });
    jobRef = job;
    job.start({ count: 10, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: twoTargets });
    await timers.fireNext();
    expect(job.getStatus().state).toBe('stopped');
    expect(warmup).toHaveBeenCalledTimes(1); // start 발화만, checkpoint 스킵으로 재보장 없음
  });

  it('brain 미주입 → 옵셔널 체이닝 no-op(크래시 없음, 정상 완료)', async () => {
    const { job, timers } = makeJob(); // brain 없음
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(job.getStatus().state).toBe('done'); // warmup 미주입이어도 정상 동작
  });

  it('brain.warmup 이 false(콜드 로드 실패) → 잡은 정상 완료(best-effort, 폴백 유지)', async () => {
    // 실 AgentRuntime.warmup 은 throw 하지 않고 false 를 반환(내부 try/catch). 그 계약대로 false 를 줘도
    // start·checkpoint 는 진행하고 잡은 done 으로 정상 종료(warmup 실패가 잡을 죽이지 않음).
    const warmup = vi.fn(async () => false);
    const brain = { enabled: true, warmup } as unknown as CaptureJobDeps['brain'];
    const { job, timers } = makeJob({ brain });
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 1, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets });
    await timers.fireNext();
    expect(job.getStatus().state).toBe('done');
    expect(warmup).toHaveBeenCalledTimes(2); // start 발화 + checkpoint 재보장
  });
});

describe('CaptureJob LPD 적재 (G1)', () => {
  it('lpdEnabled=true → vehicle+plate 적재; plate 행에 rect(boundingRect)+quad 동시 저장(설계 케이스 7)', async () => {
    // 회전 quad 번호판. CaptureJob 은 quadBoundingRect 로 rect(집계용)를 유도하고 quad(보존)를 함께 적재해야 함.
    const rot: NormalizedQuad = [
      { x: 0.21, y: 0.21 },
      { x: 0.24, y: 0.22 },
      { x: 0.23, y: 0.24 },
      { x: 0.20, y: 0.23 },
    ];
    const lpd = { detect: async () => [{ quad: rot, confidence: 0.8, cls: 'plate' }] };
    const { job, timers } = makeJob({ lpdEnabled: true, lpd: lpd as never });
    const single: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: single });
    await timers.fireNext();
    const dets = job.getSnapshot().dets;
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(1);
    const plates = dets.filter((d) => d.kind === 'plate');
    expect(plates).toHaveLength(1);
    // quad 방향 보존(실 4점).
    expect(plates[0].quad).toEqual(rot);
    // rect = quad 축정렬 boundingRect(집계·클러스터링 입력).
    expect(plates[0].x).toBeCloseTo(0.20);
    expect(plates[0].y).toBeCloseTo(0.21);
    expect(plates[0].w).toBeCloseTo(0.04); // 0.24-0.20
    expect(plates[0].h).toBeCloseTo(0.03); // 0.24-0.21
  });

  it('lpdEnabled=true 인데 LPD 실패 → 번호판 생략, 차량은 적재(흡수)', async () => {
    const lpd = { detect: async () => { throw new Error('LPD down'); } };
    const { job, timers } = makeJob({ lpdEnabled: true, lpd: lpd as never });
    const single: SetupTarget[] = [{ camIdx: 1, presetIdx: 1 }];
    job.start({ count: 1, intervalMs: 1000, checkpointEvery: 99, checkpointTriggerMode: 'rounds', checkpointIntervalMs: 60000, targets: single });
    await timers.fireNext();
    const dets = job.getSnapshot().dets;
    expect(dets.filter((d) => d.kind === 'vehicle')).toHaveLength(1);
    expect(dets.filter((d) => d.kind === 'plate')).toHaveLength(0);
  });
});
