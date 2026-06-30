import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 순수 ESM 모듈(브라우저 API 미참조) 직접 import.
import {
  toPixel,
  toPixelQuad,
  presetKey,
  slotLabel,
  fpsToInterval,
  clampZoom,
  stepPtz,
  createStreamLoop,
} from '../web/core.js';

describe('toPixel (G2 — 0~1 × 표시크기 환산)', () => {
  it('정규화 ROI → 픽셀(전체)', () => {
    expect(toPixel({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080)).toEqual({ px: 0, py: 0, pw: 1920, ph: 1080 });
  });
  it('정규화 ROI → 픽셀(부분)', () => {
    expect(toPixel({ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }, 800, 600)).toEqual({ px: 400, py: 150, pw: 80, ph: 120 });
  });
});

describe('toPixelQuad (floor ROI 폴리곤 픽셀 변환)', () => {
  it('정규화 4점 → 표시 픽셀 점 배열', () => {
    const quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0.8, y: 0.5 },
      { x: 0.2, y: 0.5 },
    ];
    expect(toPixelQuad(quad, 800, 600)).toEqual([
      { px: 0, py: 600 },
      { px: 800, py: 600 },
      { px: 640, py: 300 },
      { px: 160, py: 300 },
    ]);
  });
});

describe('presetKey', () => {
  it('cam:preset 결합', () => {
    expect(presetKey(1, 2)).toBe('1:2');
    expect(presetKey(3, 10)).toBe('3:10');
  });
});

describe('slotLabel (G3-4 라벨 매핑)', () => {
  const gi = [
    { slotId: 's-1', globalIdx: 5 },
    { slotId: 's-2', globalIdx: 6 },
  ];
  it('globalIndex 매칭 시 globalIdx 반환', () => {
    expect(slotLabel('s-2', gi)).toBe('6');
  });
  it('미매칭 시 slotId 폴백', () => {
    expect(slotLabel('s-99', gi)).toBe('s-99');
  });
  it('globalIndex 부재 시 slotId 폴백', () => {
    expect(slotLabel('s-1', undefined)).toBe('s-1');
  });
});

describe('fpsToInterval', () => {
  it('fps=3 → 333ms', () => {
    expect(fpsToInterval(3)).toBe(333);
  });
  it('fps=1 → 1000ms', () => {
    expect(fpsToInterval(1)).toBe(1000);
  });
});

describe('clampZoom', () => {
  it('범위 클램프(1~36)', () => {
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(99)).toBe(36);
    expect(clampZoom(18)).toBe(18);
  });
});

describe('stepPtz', () => {
  const cur = { pan: 0, tilt: 0, zoom: 10 };
  it('left/right → pan ±step', () => {
    expect(stepPtz(cur, 'left', 5).pan).toBe(-5);
    expect(stepPtz(cur, 'right', 5).pan).toBe(5);
  });
  it('up/down → tilt ±step', () => {
    expect(stepPtz(cur, 'up', 3).tilt).toBe(3);
    expect(stepPtz(cur, 'down', 3).tilt).toBe(-3);
  });
  it('zoomIn/zoomOut → ±1 클램프', () => {
    expect(stepPtz({ ...cur, zoom: 36 }, 'zoomIn', 5).zoom).toBe(36);
    expect(stepPtz({ ...cur, zoom: 1 }, 'zoomOut', 5).zoom).toBe(1);
    expect(stepPtz(cur, 'zoomIn', 5).zoom).toBe(11);
  });
  it('원본 불변(순수)', () => {
    const c = { pan: 1, tilt: 2, zoom: 3 };
    stepPtz(c, 'left', 5);
    expect(c).toEqual({ pan: 1, tilt: 2, zoom: 3 });
  });
});

describe('createStreamLoop — 백프레셔/revoke/stop', () => {
  /** 수동 해소형 Promise. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function mkDeps() {
    const created: string[] = [];
    const revoked: string[] = [];
    let urlSeq = 0;
    const pending: Array<{ resolve: (v: any) => void }> = [];
    const deps = {
      fetchFn: vi.fn((_url: string, _opt: any) => {
        const d = deferred<any>();
        pending.push({ resolve: d.resolve });
        return d.promise;
      }),
      makeUrl: vi.fn((seq: number) => `/snap?t=${seq}`),
      createObjectURL: vi.fn((_blob: any) => `blob:${urlSeq++}`),
      revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
      setImage: vi.fn(async (u: string) => {
        created.push(u);
      }),
      onPtz: vi.fn(),
    };
    /** 가장 오래된 inflight fetch 를 응답시킨다. */
    const respond = () => {
      const p = pending.shift();
      p?.resolve({ blob: async () => ({}), headers: { get: () => '7' } });
    };
    return { deps, created, revoked, respond, pendingCount: () => pending.length };
  }

  it('백프레셔: inflight 진행 중 tick 겹침은 스킵(fetch 1회)', async () => {
    const { deps, respond } = mkDeps();
    const loop = createStreamLoop(deps);
    const t1 = loop.tick();
    const t2 = loop.tick(); // inflight 가드로 즉시 반환
    await t2;
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    respond();
    await t1;
    // 해소 후 다음 tick 은 다시 fetch
    const t3 = loop.tick();
    expect(deps.fetchFn).toHaveBeenCalledTimes(2);
    respond();
    await t3;
  });

  it('새 프레임 시 이전 Blob URL revoke(G3-4), 첫 프레임은 revoke 없음', async () => {
    const { deps, revoked, respond } = mkDeps();
    const loop = createStreamLoop(deps);
    const a = loop.tick();
    respond();
    await a;
    expect(revoked).toHaveLength(0); // 첫 프레임: 이전 URL 없음
    const b = loop.tick();
    respond();
    await b;
    expect(revoked).toEqual(['blob:0']); // 두번째: 이전(blob:0) 해제
    expect(deps.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('onPtz 가 응답 헤더로 호출됨', async () => {
    const { deps, respond } = mkDeps();
    const loop = createStreamLoop(deps);
    const a = loop.tick();
    respond();
    await a;
    expect(deps.onPtz).toHaveBeenCalledTimes(1);
  });

  it('start: 주입 setTimer 로 fpsToInterval(fps) 간격 등록, 중복 start 무시', () => {
    const setTimer = vi.fn((_fn: () => void, _ms: number) => 'TIMER');
    const clearTimer = vi.fn();
    const { deps } = mkDeps();
    const loop = createStreamLoop({ ...deps, setTimer, clearTimer });
    loop.start(3);
    loop.start(3); // 이미 동작 중 → 무시
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0][1]).toBe(333);
  });

  it('stop: timer clear + inflight abort', async () => {
    const setTimer = vi.fn(() => 'TIMER');
    const clearTimer = vi.fn();
    const { deps } = mkDeps();
    const loop = createStreamLoop({ ...deps, setTimer, clearTimer });
    loop.start(3);
    loop.tick(); // inflight 생성(미해소)
    loop.stop();
    expect(clearTimer).toHaveBeenCalledWith('TIMER');
    // fetch 에 전달된 signal 이 aborted 여야 함
    const signal = deps.fetchFn.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('fake timers: start 후 간격마다 tick 발화(즉시 해소 fetch)', async () => {
    vi.useFakeTimers();
    try {
      // fetch 가 즉시 해소되어 inflight 가 매 틱 비워지는 deps.
      const fetchFn = vi.fn(async () => ({ blob: async () => ({}), headers: { get: () => '7' } }));
      const deps = {
        fetchFn,
        makeUrl: (seq: number) => `/snap?t=${seq}`,
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => {},
        setImage: async () => {},
        onPtz: () => {},
      };
      const loop = createStreamLoop(deps); // 기본 setInterval 경로
      loop.start(3); // 333ms
      await vi.advanceTimersByTimeAsync(1000); // 3틱(333*3=999)
      expect(fetchFn).toHaveBeenCalledTimes(3);
      loop.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(3); // 정지 후 추가 호출 없음
    } finally {
      vi.useRealTimers();
    }
  });
});
