import { describe, it, expect } from 'vitest';
import { TourJob } from '../src/capture/TourJob.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';

/**
 * 검증자(qa-tester): TourJob 상태머신(설계 §2.2 / T2).
 *
 * ★ 이 파일이 고정하는 것: 서버 순회가 **웹이 하던 것과 같은 순서로 같은 명령을 낸다**.
 *   - 스텝 순서·횟수가 계획과 일치(preset 스텝은 그룹 최초 1회)
 *   - 프리셋 PTZ 미해석 시 requestImage 폴백(**스킵 아님** — 웹 gotoPreset 폴백 계승)
 *   - 중복 시작 거부 / stop 후 이동 증가 없음 / 개별 실패 흡수
 *   - DB·파일 쓰기 0(잡은 store 를 아예 주입받지 않는다 — 구조적 보증)
 */

/** 프리셋 픽스처 — pan/tilt/zoom 중 하나라도 없으면 resolvePresetPtz 가 null(폴백 경로). */
interface PresetFixture { camIdx: number; presetIdx: number; pan?: number; tilt?: number; zoom?: number }

/** move/requestImage 호출을 기록하는 가짜 카메라. presets 로 resolvePresetPtz 결과를 제어한다. */
function fakeCamera(presets: PresetFixture[]) {
  const calls: { move: Array<[number, number, number, number]>; image: Array<[number, number]> } = { move: [], image: [] };
  const camera = {
    clampZoom: (z: number) => z,
    health: async () => true,
    listCameras: async () => ({
      cameras: [
        { camIdx: 1, name: 'C1', enabled: true, presets: presets.filter((p) => p.camIdx === 1) },
        { camIdx: 2, name: 'C2', enabled: true, presets: presets.filter((p) => p.camIdx === 2) },
      ],
    }),
    move: async (cam: number, pan: number, tilt: number, zoom: number) => {
      calls.move.push([cam, pan, tilt, zoom]);
      return true;
    },
    requestImage: async (cam: number, preset: number) => {
      calls.image.push([cam, preset]);
      return { camIdx: cam, presetIdx: preset, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('x') };
    },
  } as unknown as ICameraClient;
  return { camera, calls };
}

/** 프리셋 PTZ 전부 해석 가능한 기본 카메라(1:1·1:2). */
const fullPresets: PresetFixture[] = [
  { camIdx: 1, presetIdx: 1, pan: 100, tilt: -10, zoom: 1 },
  { camIdx: 1, presetIdx: 2, pan: 200, tilt: -20, zoom: 2 },
];

/** 2그룹 4슬롯(1:1 에 2개, 1:2 에 1개 + centering 없는 1개). */
const setupResult = {
  slots: [
    { slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: { pan: 1, tilt: 2, zoom: 3 } },
    { slotId: 2, camId: 1, presetId: 1, presetSlotIdx: 2, centering: { pan: 4, tilt: 5, zoom: 6 } },
    { slotId: 3, camId: 1, presetId: 2, presetSlotIdx: 1, centering: { pan: 7, tilt: 8, zoom: 9 } },
    { slotId: 4, camId: 1, presetId: 2, presetSlotIdx: 2, centering: null },
  ],
};

/** 조건이 참이 될 때까지 마이크로태스크를 흘린다(가짜 의존성은 전부 즉시 resolve). */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error('테스트 대기 초과 — 조건이 만족되지 않았다');
}

/** 잡이 running 을 벗어날 때까지 마이크로태스크를 흘린다(sleep 은 즉시 resolve 스텁). */
async function waitEnd(job: TourJob): Promise<void> {
  await until(() => job.getStatus().state !== 'running' && job.getStatus().state !== 'stopping');
}

/** 스텝 대기(sleep)를 테스트가 직접 여닫는 게이트. 잡이 "지금 대기 중"인 시점을 관측할 수 있다. */
function sleepGate(): { sleep: () => Promise<void>; waiting: () => boolean; release: () => void } {
  let resolve: (() => void) | undefined;
  return {
    sleep: () => new Promise<void>((r) => { resolve = r; }),
    waiting: () => resolve !== undefined,
    release: () => { const r = resolve; resolve = undefined; r?.(); },
  };
}

function makeJob(over: Partial<ConstructorParameters<typeof TourJob>[0]> = {}, presets: PresetFixture[] = fullPresets) {
  const { camera, calls } = fakeCamera(presets);
  const job = new TourJob({
    camera,
    loadSetupResult: () => setupResult,
    sleep: async () => {},
    now: () => 'T',
    ...over,
  });
  return { job, calls };
}

describe('TourJob — 계획 → 스텝 순서·횟수', () => {
  it('start 반환 = {total,presets,slots,skipped} (preset 2 + slot 3 = 5, skipped 1)', () => {
    const { job } = makeJob();
    expect(job.start()).toEqual({ total: 5, presets: 2, slots: 3, skipped: 1 });
  });

  it('이동 순서 = 프리셋홈 → 그 그룹 슬롯들 → 다음 프리셋홈 …(그룹 최초 1회만 preset 스텝)', async () => {
    const { job, calls } = makeJob();
    job.start();
    await waitEnd(job);
    expect(calls.move).toEqual([
      [1, 100, -10, 1], // preset 1:1 홈
      [1, 1, 2, 3], // slot 1
      [1, 4, 5, 6], // slot 2
      [1, 200, -20, 2], // preset 1:2 홈
      [1, 7, 8, 9], // slot 3
    ]);
    expect(calls.image).toEqual([]); // PTZ 전부 해석 → 폴백 미사용.
    const st = job.getStatus();
    expect(st.state).toBe('done');
    expect(st.done).toBe(5);
    expect(st.endedAt).toBe('T');
    expect(st.current).toBeUndefined();
  });

  it('각 스텝마다 dwellMs 만큼 대기한다(스텝 수와 같은 횟수)', async () => {
    const waits: number[] = [];
    const { job } = makeJob({ sleep: async (ms: number) => { waits.push(ms); } });
    job.start({ dwellMs: 250 });
    await waitEnd(job);
    expect(waits).toEqual([250, 250, 250, 250, 250]);
  });

  it('dwellMs 미지정 시 기본 1000ms(웹과 동일)', async () => {
    const waits: number[] = [];
    const { job } = makeJob({ sleep: async (ms: number) => { waits.push(ms); } });
    job.start();
    await waitEnd(job);
    expect(waits[0]).toBe(1000);
  });
});

describe('TourJob — 프리셋 PTZ 미해석 폴백(스킵 아님)', () => {
  it('PTZ 없는 프리셋 → requestImage(cam,preset) 1회, 슬롯 이동은 그대로 진행', async () => {
    // 1:1 은 pan 만 있어 미해석(3값 전부 필요), 1:2 는 정상.
    const { job, calls } = makeJob({}, [
      { camIdx: 1, presetIdx: 1, pan: 100 },
      { camIdx: 1, presetIdx: 2, pan: 200, tilt: -20, zoom: 2 },
    ]);
    job.start();
    await waitEnd(job);
    expect(calls.image).toEqual([[1, 1]]); // 폴백 1회.
    expect(calls.move).toEqual([
      [1, 1, 2, 3],
      [1, 4, 5, 6],
      [1, 200, -20, 2],
      [1, 7, 8, 9],
    ]);
    expect(job.getStatus().done).toBe(5); // 폴백 스텝도 done 에 계수(스킵 아님).
  });
});

describe('TourJob — 시작 거부', () => {
  it('중복 start → throw /already running/', () => {
    const { job } = makeJob({ sleep: () => new Promise<void>(() => {}) }); // 첫 스텝에서 정지.
    job.start();
    expect(() => job.start()).toThrow(/already running/);
  });

  it('setup_result 없음(null) → throw "no setup_result", 상태는 idle 유지', () => {
    const { job, calls } = makeJob({ loadSetupResult: () => null });
    expect(() => job.start()).toThrow('no setup_result');
    expect(job.getStatus().state).toBe('idle');
    expect(calls.move).toEqual([]);
  });

  it('순회 대상 0(빈 slots) → throw, 카메라 미접촉', () => {
    const { job, calls } = makeJob({ loadSetupResult: () => ({ slots: [] }) });
    expect(() => job.start()).toThrow('순회할 슬롯/프리셋이 없습니다');
    expect(calls.move).toEqual([]);
  });

  it('centering 이 전무해도 preset 스텝은 남으므로 시작된다(스킵만 카운트)', () => {
    const { job } = makeJob({
      loadSetupResult: () => ({ slots: [{ slotId: 1, camId: 1, presetId: 1, presetSlotIdx: 1, centering: null }] }),
    });
    expect(job.start()).toEqual({ total: 1, presets: 1, slots: 0, skipped: 1 });
  });
});

describe('TourJob — stop', () => {
  it('stop() → 다음 스텝 전에 aborted, 이후 move 증가 없음', async () => {
    const gate = sleepGate();
    const { job, calls } = makeJob({ sleep: gate.sleep });
    job.start();
    await until(gate.waiting); // 첫 스텝 실행 완료 → 대기 중.
    expect(calls.move).toHaveLength(1);
    job.stop();
    expect(job.getStatus().state).toBe('stopping');
    gate.release(); // 대기 해제 → 루프가 다음 스텝 직전에 정지 확인.
    await waitEnd(job);
    expect(job.getStatus().state).toBe('aborted');
    expect(calls.move).toHaveLength(1); // 이동이 늘지 않았다.
    expect(job.getStatus().endedAt).toBe('T');
  });

  it('idle 에서 stop() → 무동작(멱등, 상태 불변)', () => {
    const { job } = makeJob();
    job.stop();
    expect(job.getStatus().state).toBe('idle');
  });

  it('aborted 후 다시 start 가능(재시작)', async () => {
    const gate = sleepGate();
    const { job } = makeJob({ sleep: gate.sleep });
    job.start();
    await until(gate.waiting);
    job.stop();
    gate.release();
    await waitEnd(job);
    expect(job.getStatus().state).toBe('aborted');
    expect(() => job.start({ dwellMs: 0 })).not.toThrow();
    // 정리 — 재시작한 순회를 중단시키고 대기 게이트를 열어 루프를 끝낸다.
    job.stop();
    await until(() => {
      if (gate.waiting()) gate.release();
      return job.getStatus().state === 'aborted';
    });
  });
});

/**
 * ★ 리더 라이브 검증(2026-07-28)에서 제기된 보고 품질 결함.
 *
 * 이 기능의 존재 이유는 **헤드리스 셋업 검증**이다. 그런데 흡수한 실패를 세지 않으면
 * 카메라가 한 번도 안 움직여도 `state:'done', done:N/N, skipped:0` 이 나와 **운영자가 순회 성공으로 오판**한다.
 * (실측 재현: 도달 불가 호스트에 붙인 실카 스택에서 28스텝 전부 실패했는데 status 는 done 28/28 이었다.)
 * "개별 실패 흡수" 철학은 유지하되 — 흡수한 것을 성공으로 보고하지 않는다.
 */
describe('TourJob — 실패는 보고에 드러난다(음성 대조)', () => {
  /** 모든 이동이 실패하는 카메라(연결 끊김 재현). */
  function deadCamera() {
    return {
      clampZoom: (z: number) => z,
      health: async () => false,
      listCameras: async () => { throw new Error('카메라 목록 실패(모의)'); },
      move: async () => { throw new Error('이동 실패(모의)'); },
      requestImage: async () => { throw new Error('스냅샷 실패(모의)'); },
    } as unknown as ICameraClient;
  }

  it('전 스텝 실패 → state 는 done 이 아니라 partial, failed===total, succeeded===0', async () => {
    const job = new TourJob({ camera: deadCamera(), loadSetupResult: () => setupResult, sleep: async () => {}, now: () => 'T' });
    const started = job.start();
    await waitEnd(job);
    const st = job.getStatus();
    // ★ 이 단정이 수정 전 코드에서는 실패한다(수정 전: state='done', failed 필드 없음).
    expect(st.state).toBe('partial');
    expect(st.failed).toBe(started.total);
    expect(st.succeeded).toBe(0);
    expect(st.done).toBe(started.total); // 시도 수는 그대로(진행률 의미 불변).
    // skipped 는 **계획 단계에서 제외된 슬롯 수**(이 fixture 의 centering=null 1건) — 실행 실패 5건과 별개 개념이다.
    expect(st.skipped).toBe(1);
  });

  it('일부만 실패 → partial + 성공/실패 수가 정확히 나뉜다', async () => {
    const { camera, calls } = fakeCamera(fullPresets);
    let n = 0;
    const flaky = {
      ...camera,
      listCameras: camera.listCameras.bind(camera),
      move: async (c: number, p: number, t: number, z: number) => {
        n += 1;
        if (n === 2) throw new Error('이동 실패(모의)');
        return camera.move(c, p, t, z);
      },
    } as unknown as ICameraClient;
    const job = new TourJob({ camera: flaky, loadSetupResult: () => setupResult, sleep: async () => {}, now: () => 'T' });
    job.start();
    await waitEnd(job);
    const st = job.getStatus();
    expect(st.state).toBe('partial');
    expect(st.failed).toBe(1);
    expect(st.succeeded).toBe(4);
    expect(st.succeeded + st.failed).toBe(st.done);
    expect(calls.move).toHaveLength(4);
  });

  it('전 스텝 성공 → done + failed 0(정상 경로가 partial 로 오염되지 않는다)', async () => {
    const { job } = makeJob();
    const started = job.start();
    await waitEnd(job);
    const st = job.getStatus();
    expect(st.state).toBe('done');
    expect(st.failed).toBe(0);
    expect(st.succeeded).toBe(started.total);
  });
});

describe('TourJob — 개별 스텝 실패 흡수', () => {
  it('move 가 reject 해도 순회를 계속한다(중단 없음) — 종료 상태는 partial', async () => {
    const { camera, calls } = fakeCamera(fullPresets);
    let n = 0;
    const flaky = {
      ...camera,
      listCameras: camera.listCameras.bind(camera),
      move: async (cam: number, pan: number, tilt: number, zoom: number) => {
        n += 1;
        if (n === 2) throw new Error('move 실패(모의)');
        return camera.move(cam, pan, tilt, zoom);
      },
    } as unknown as ICameraClient;
    const job = new TourJob({ camera: flaky, loadSetupResult: () => setupResult, sleep: async () => {}, now: () => 'T' });
    job.start();
    await waitEnd(job);
    expect(job.getStatus().state).toBe('partial'); // 흡수했지만 성공으로 보고하지 않는다.
    expect(job.getStatus().done).toBe(5); // 실패 스텝도 진행 계수(정직한 진행률).
    expect(calls.move).toHaveLength(4); // 2번째 호출은 throw 로 기록되지 않음.
  });

  it('listCameras 예외(프리셋 조회 실패) → 폴백 requestImage 로 진행', async () => {
    const { calls } = fakeCamera(fullPresets);
    const broken = {
      clampZoom: (z: number) => z,
      health: async () => true,
      listCameras: async () => { throw new Error('카메라 목록 실패(모의)'); },
      move: async (cam: number, pan: number, tilt: number, zoom: number) => { calls.move.push([cam, pan, tilt, zoom]); return true; },
      requestImage: async (cam: number, preset: number) => {
        calls.image.push([cam, preset]);
        return { camIdx: cam, presetIdx: preset, pan: 0, tilt: 0, zoom: 1, imgName: 'x', jpg: Buffer.from('x') };
      },
    } as unknown as ICameraClient;
    const job = new TourJob({ camera: broken, loadSetupResult: () => setupResult, sleep: async () => {}, now: () => 'T' });
    job.start();
    await waitEnd(job);
    expect(job.getStatus().state).toBe('done');
    expect(calls.image).toEqual([[1, 1], [1, 2]]); // 두 프리셋 모두 폴백.
  });
});

describe('TourJob — 상태 shape', () => {
  it('시작 전 status = idle/0 (current·startedAt 부재)', () => {
    const { job } = makeJob();
    expect(job.getStatus()).toEqual({ state: 'idle', done: 0, total: 0, presets: 0, slots: 0, skipped: 0, succeeded: 0, failed: 0 });
  });

  it('진행 중 current 는 지금 이동 중인 위치(preset 스텝 → slot 스텝은 slotId 포함)', async () => {
    const gate = sleepGate();
    const { job } = makeJob({ sleep: gate.sleep });
    job.start();
    await until(gate.waiting); // 1번째 스텝(preset) 직후.
    expect(job.getStatus().current).toEqual({ kind: 'preset', camId: 1, presetId: 1 });
    expect(job.getStatus().startedAt).toBe('T');
    gate.release();
    await until(gate.waiting); // 2번째 스텝(slot) 직후.
    expect(job.getStatus().current).toEqual({ kind: 'slot', camId: 1, presetId: 1, slotId: 1 });
    job.stop();
    gate.release();
    await waitEnd(job);
  });

  it('start 호출로 시임 카메라 override 가능(라우트 source 지정 경로)', async () => {
    const { job } = makeJob();
    const other = fakeCamera(fullPresets);
    job.start({ camera: other.camera, dwellMs: 0 });
    await waitEnd(job);
    expect(other.calls.move).toHaveLength(5); // 주입 카메라가 전부 받았다.
  });
});
