import { describe, expect, it, vi } from 'vitest';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';
import { logger } from '../src/util/logger.js';

/**
 * 구현자: RealPtzSource.move() 정착(settle) 폴링.
 *
 * 배경(실기 로그 logs/setting_20260721_140420.log): goptzfpos 204 직후 반환하면 폐루프가
 * 아직 움직이지 않은 프레임을 측정해 스텝을 키운다(zoompos 12007→16171→21584→28621 진동, x36 포화).
 * 따라서 move() 는 getptzfpos 폴링으로 "정지 + 목표 근접"을 확인한 뒤 반환해야 한다.
 *
 * 타이밍(pollMs/timeoutMs/sleep)은 생성자 4번째 인자로 주입해 실시간 대기 0 으로 검증한다.
 *
 * ★ 미검증(은닉 금지): 실장비의 실제 슬루 시간·상수(150ms/5000ms/±10/±300)의 현장 적정성은
 *   여기서 검증되지 않는다(라이브 확인 필요).
 */

const cfg: CameraSourceConfig = {
  id: 'ptz1', kind: 'hucoms', host: '127.0.0.1', port: 1,
  ptz: { panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 65535] },
};

/** sleep 은 즉시 resolve 하고 호출된 ms 만 기록한다(실시간 대기 0). */
function fakeSleep() {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => { calls.push(ms); } };
}

/** getPtzfPosition 이 미리 정한 raw 시퀀스를 순서대로 돌려주는 client 스텁. */
function stubClient(source: RealPtzSource, frames: Array<Record<string, string>>) {
  const gos: Array<Record<string, number>> = [];
  let reads = 0;
  Reflect.set(source, 'client', {
    goPtzfPosition: async (p: Record<string, number>) => { gos.push(p); return { values: {} }; },
    getPtzfPosition: async () => {
      const frame = frames[Math.min(reads, frames.length - 1)];
      reads += 1;
      return { values: frame };
    },
  });
  return { gos, reads: () => reads };
}

// 목표: pan 180°/tilt 90°/zoom 36 → raw 35999 / 9000 / 65535.
const TARGET_FRAME = { panpos: '35999', tiltpos: '9000', zoompos: '65535' };

describe('RealPtzSource.move — 실기 슬루 정착 폴링', () => {
  it('① 슬루 중에는 계속 폴링하고, 정지 + 목표 근접이면 종료하며 true 를 반환한다', async () => {
    const { calls, sleep } = fakeSleep();
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 150, timeoutMs: 5000, sleep });
    // 슬루 중(값이 계속 변함) 3프레임 → 목표 도달 후 정지(동일 값 2회).
    const spy = stubClient(source, [
      { panpos: '12000', tiltpos: '3000', zoompos: '12007' },
      { panpos: '25000', tiltpos: '6000', zoompos: '30000' },
      { panpos: '35000', tiltpos: '8800', zoompos: '60000' },
      TARGET_FRAME,
      TARGET_FRAME,
    ]);

    expect(await source.move(1, { pan: 180, tilt: 90, zoom: 36 })).toBe(true);
    expect(spy.gos).toHaveLength(1);
    expect(spy.reads()).toBe(5);             // 연속 동일 2회가 나올 때까지만 폴링.
    expect(calls).toEqual([150, 150, 150, 150, 150]); // 실시간 대기는 주입 sleep 으로 0.
  });

  it('① 정지했지만 목표에서 멀면 조기 종료하지 않는다(명령 직후 미출발 구간 오판 방지)', async () => {
    const { sleep } = fakeSleep();
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 0, timeoutMs: 5000, sleep });
    // 출발 전 원점에서 정지해 보이는 구간 → 이후 슬루 → 목표 정지.
    const spy = stubClient(source, [
      { panpos: '0', tiltpos: '0', zoompos: '0' },
      { panpos: '0', tiltpos: '0', zoompos: '0' },
      { panpos: '20000', tiltpos: '5000', zoompos: '30000' },
      TARGET_FRAME,
      TARGET_FRAME,
    ]);

    await source.move(1, { pan: 180, tilt: 90, zoom: 36 });
    expect(spy.reads()).toBe(5); // 동일 값 2회여도 목표에서 멀면 계속 폴링했다.
  });

  it('허용 오차(pan/tilt ±10, zoom ±300) 이내면 정확히 일치하지 않아도 도달로 본다', async () => {
    const { sleep } = fakeSleep();
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 0, timeoutMs: 5000, sleep });
    const near = { panpos: '35990', tiltpos: '8995', zoompos: '65300' };
    const spy = stubClient(source, [near, near, near]);

    await source.move(1, { pan: 180, tilt: 90, zoom: 36 });
    expect(spy.reads()).toBe(2);
  });

  it('② 상한 초과 시 예외 없이 warn 로그를 남기고 반환한다(무한 대기 없음)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    // sleep 이 가상 시각을 진행시켜 timeoutMs 를 실시간 대기 없이 초과시킨다.
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = new RealPtzSource(cfg, 7000, undefined, {
      pollMs: 150,
      timeoutMs: 600,
      sleep: async (ms: number) => { now += ms; },
    });
    // 끝없이 값이 흔들려 정지 판정이 서지 않는 장비(헌팅).
    const spy = stubClient(source, [
      { panpos: '100', tiltpos: '100', zoompos: '12007' },
      { panpos: '200', tiltpos: '150', zoompos: '16171' },
      { panpos: '300', tiltpos: '200', zoompos: '21584' },
      { panpos: '400', tiltpos: '250', zoompos: '28621' },
      { panpos: '500', tiltpos: '300', zoompos: '27717' },
      { panpos: '600', tiltpos: '350', zoompos: '26573' },
    ]);

    expect(await source.move(1, { pan: 180, tilt: 90, zoom: 36 })).toBe(true);
    expect(spy.reads()).toBe(4); // 150ms × 4 = 600ms 에서 상한 도달.
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.target).toEqual({ pan: 35999, tilt: 9000, zoom: 65535 });
    expect(payload.last).toEqual({ pan: 400, tilt: 250, zoom: 28621 });
    expect(payload.elapsedMs).toBe(600);
    expect(warn.mock.calls[0][1]).toMatch(/정착/);

    nowSpy.mockRestore();
    warn.mockRestore();
  });

  it('③ 폴링 예외는 흡수하고 즉시 반환한다(위치 조회 미지원 모델도 move 가능)', async () => {
    const { calls, sleep } = fakeSleep();
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 150, timeoutMs: 5000, sleep });
    let reads = 0;
    const gos: unknown[] = [];
    Reflect.set(source, 'client', {
      goPtzfPosition: async (p: unknown) => { gos.push(p); return { values: {} }; },
      getPtzfPosition: async () => { reads += 1; throw new Error('getptzfpos http 500'); },
    });

    expect(await source.move(1, { pan: 0, tilt: 0, zoom: 10 })).toBe(true);
    expect(gos).toHaveLength(1);
    expect(reads).toBe(1);      // 첫 실패에서 바로 포기 — 재시도 루프 없음.
    expect(calls).toEqual([150]);
  });

  it('③ 응답 필드가 불완전하면(파싱 불가) 즉시 반환한다', async () => {
    const { sleep } = fakeSleep();
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 0, timeoutMs: 5000, sleep });
    const spy = stubClient(source, [{ foo: 'bar' }]);

    expect(await source.move(1, { pan: 0, tilt: 0, zoom: 10 })).toBe(true);
    expect(spy.reads()).toBe(1);
  });

  it('타이밍 미주입 시에도 계약은 동일하다(기본 상수 사용, 정지·근접이면 2회 폴링)', async () => {
    const source = new RealPtzSource(cfg); // pollMs 기본 150ms — 정지 프레임이라 2회(≈300ms)면 끝난다.
    const spy = stubClient(source, [TARGET_FRAME, TARGET_FRAME]);
    const startedAt = Date.now();
    await source.move(1, { pan: 180, tilt: 90, zoom: 36 });
    expect(spy.reads()).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
