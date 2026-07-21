import { describe, expect, it } from 'vitest';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';

/**
 * 수정 8 — `centerOnPoint` 의 정착 대기(`waitUntilStopped`).
 *
 * 배경(라이브 실패): `ptz_centering setcenter` 204 는 "명령 수신"일 뿐이라 직후의 getptzfpos 는
 * **슬루 중 값**이다. 그 값을 사다리가 다음 rung 의 `requestImage(ptz override)` 로 명령하면
 * `move`→`waitUntilSettled` 가 카메라를 **슬루 중간 지점까지 실제로 되돌려** 센터링을 부분 취소한다
 * (슬루가 길수록 심함 = 먼 차량일수록 실패). 그래서 "정지"를 확인한 뒤 반환해야 한다.
 *
 * 목표 좌표를 모르므로 `isNearTarget` 을 쓸 수 없고, 명령 직후 "아직 안 움직인" 구간도 연속 동일로
 * 보이므로 **움직임을 한 번 본 뒤의 정지**만 정착으로 인정한다(안 움직이면 유예 폴 후 no-op 처리).
 */

const cfg: CameraSourceConfig = {
  id: 'ptz1', kind: 'hucoms', host: '127.0.0.1', port: 1,
  ptz: { panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 65535] },
};

/** 실시간 대기 제거(폴링 주기 주입) — 유예는 ms 가 아니라 폴 횟수라 sleep 을 없애도 정합한다. */
const fast = { pollMs: 0, timeoutMs: 200, sleep: async (): Promise<void> => {} };

/** getptzfpos 가 돌려줄 raw 시퀀스를 주입한다. 마지막 값은 소진 후 계속 반복. */
function stubClient(source: RealPtzSource, seq: Array<{ pan: number; tilt: number; zoom: number }>) {
  let i = 0;
  const stub = {
    centerPtz: async () => ({ values: {} }),
    getPtzfPosition: async () => {
      const v = seq[Math.min(i, seq.length - 1)]!;
      i += 1;
      return { values: { panpos: String(v.pan), tiltpos: String(v.tilt), zoompos: String(v.zoom) } };
    },
  };
  Reflect.set(source, 'client', stub);
  return { polls: () => i };
}

describe('RealPtzSource.centerOnPoint — 정착 대기(수정 8)', () => {
  it('슬루 중 → 정지 시퀀스: 정지 확인 후 settled:true 와 **정지 위치**를 반환한다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, fast);
    // 17000 → 17500 → 18000(이동 중) → 18000 반복(정지).
    const spy = stubClient(source, [
      { pan: 17000, tilt: 3000, zoom: 20000 },
      { pan: 17500, tilt: 3200, zoom: 20000 },
      { pan: 18000, tilt: 3500, zoom: 20000 },
      { pan: 18000, tilt: 3500, zoom: 20000 },
    ]);
    const r = await source.centerOnPoint(1, { x: 0.2, y: 0.5 });
    expect(r.settled).toBe(true);
    // 반환 PTZ 는 **정지 위치**(pan raw 18000)를 뷰어 좌표로 변환한 값이어야 한다 — 슬루 중 값(17000)이 아니다.
    expect(r.pan).toBeCloseTo(18000 / 35999 * 360 - 180, 3);
    expect(spy.polls()).toBeGreaterThanOrEqual(4);
  });

  it('★핵심 회귀 가드: 슬루 중 값(첫 폴링)을 그대로 반환하지 않는다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, fast);
    stubClient(source, [
      { pan: 10000, tilt: 0, zoom: 20000 }, // 슬루 시작점
      { pan: 14000, tilt: 0, zoom: 20000 },
      { pan: 20000, tilt: 0, zoom: 20000 }, // 정지
      { pan: 20000, tilt: 0, zoom: 20000 },
    ]);
    const r = await source.centerOnPoint(1, { x: 0.1, y: 0.5 });
    const midSlew = 10000 / 35999 * 360 - 180;
    expect(r.pan).not.toBeCloseTo(midSlew, 1);
  });

  it('끝내 멈추지 않으면 settled:false 로 보고한다(조용히 성공하지 않는다)', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 1, timeoutMs: 30, sleep: async () => {} });
    let pan = 10000;
    Reflect.set(source, 'client', {
      centerPtz: async () => ({ values: {} }),
      getPtzfPosition: async () => {
        pan += 100; // 영원히 이동 중
        return { values: { panpos: String(pan), tiltpos: '0', zoompos: '20000' } };
      },
    });
    const r = await source.centerOnPoint(1, { x: 0.1, y: 0.5 });
    expect(r.settled).toBe(false);
  });

  it('전혀 움직이지 않으면(이미 중앙) 유예 폴 후 settled:true 로 즉시 진행한다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, fast);
    const spy = stubClient(source, [{ pan: 18000, tilt: 3500, zoom: 20000 }]);
    const r = await source.centerOnPoint(1, { x: 0.5, y: 0.5 });
    expect(r.settled).toBe(true);
    expect(spy.polls()).toBeLessThanOrEqual(9); // 유예 7폴 + currentPtz 조회 — 무한 대기하지 않는다
  });

  it('PTZ 조회를 지원하지 않는 소스는 대기하지 않고 진행한다(강등 정책 일관)', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, fast);
    Reflect.set(source, 'client', {
      centerPtz: async () => ({ values: {} }),
      getPtzfPosition: async () => { throw new Error('미지원'); },
    });
    const r = await source.centerOnPoint(1, { x: 0.5, y: 0.5 });
    expect(r.settled).toBe(true);
  });
});

/**
 * 수정 15 — `waitUntilSettled` 조기 반환(정지했으나 목표 미달).
 *
 * 배경: "정지 AND 목표 근접"을 모두 요구해 장비가 더 갈 의사가 없는데도 타임아웃 전체를 태웠다
 * (수정 12 로 5→15초가 되며 악화, 느린 장비에서 rung 마다 15초). 장비가 멈췄으면 기다림은 무의미하다.
 *
 * ★ 수정 11(사다리의 zoomAct 연속 정체 → zoom_saturated)과 **결론이 충돌하지 않아야 한다**:
 *   이 계층은 "더 기다리지 않는다"만 결정하고 **보고하는 PTZ 를 바꾸지 않는다** → 상위가 보는 zoomAct 는 동일하다.
 *   즉 둘은 같은 사실("장비가 안 움직인다")에 대해 각각 대기 단축 / 제어 종료로 **같은 방향**의 결론을 낸다.
 */
describe('RealPtzSource.move — 정지·목표미달 조기 반환(수정 15)', () => {
  /** getptzfpos 시퀀스 주입 + goPtzfPosition 기록. */
  function moveStub(seq: Array<{ pan: number; tilt: number; zoom: number }>) {
    let i = 0;
    const stub = {
      goPtzfPosition: async () => ({ values: {} }),
      getPtzfPosition: async () => {
        const v = seq[Math.min(i, seq.length - 1)]!;
        i += 1;
        return { values: { panpos: String(v.pan), tiltpos: String(v.tilt), zoompos: String(v.zoom) } };
      },
    };
    return { stub, polls: () => i };
  }

  const AT = { pan: 7828, tilt: 1267, zoom: 16384 };

  it('★핵심: 움직이다 멈췄는데 목표 미달이면 타임아웃을 태우지 않고 조기 반환한다', async () => {
    // 실카 실측 재현: zoom 상한 16384 에 도달해 정지, 명령 목표는 그보다 위.
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 1, timeoutMs: 5000, sleep: async () => {} });
    const s = moveStub([
      { ...AT, zoom: 14000 }, { ...AT, zoom: 15200 }, // 이동 중
      AT, AT, AT, AT,                                  // 상한 도달 후 정지
    ]);
    Reflect.set(source, 'client', s.stub);
    const started = Date.now();
    const ok = await source.move(1, { pan: 78, tilt: 12, zoom: 36 });
    expect(ok).toBe(true);                    // ★ 반환 계약 무변경(물리 한계는 통신 실패가 아니다)
    expect(s.polls()).toBeLessThan(12);       // 상한 대기를 태우지 않았다
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('명령 후 전혀 움직이지 않으면(도달 불가 목표) 유예 후 조기 반환한다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 1, timeoutMs: 5000, sleep: async () => {} });
    const s = moveStub([AT]); // 계속 같은 값 = 출발조차 안 함
    Reflect.set(source, 'client', s.stub);
    const ok = await source.move(1, { pan: 78, tilt: 12, zoom: 36 });
    expect(ok).toBe(true);
    expect(s.polls()).toBeLessThanOrEqual(9); // 유예(7폴) 근처에서 끊는다
  });

  it('★오탐 가드: 느리지만 계속 움직이는 이동은 조기 종료하지 않고 목표까지 기다린다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 1, timeoutMs: 5000, sleep: async () => {} });
    // 매 폴링마다 조금씩 이동하다 목표(raw 8192)에 도달 후 정지.
    const seq = [12000, 11000, 10000, 9000, 8300, 8192, 8192].map((z) => ({ pan: 7828, tilt: 1267, zoom: z }));
    const s = moveStub(seq);
    Reflect.set(source, 'client', s.stub);
    await source.move(1, { pan: 78, tilt: 12, zoom: 18.5 });
    // 중간에 끊겼다면 목표 도달 샘플까지 가지 못한다 — 전 구간을 소비했는지로 확인.
    expect(s.polls()).toBeGreaterThanOrEqual(seq.length - 1);
  });

  it('정상 도달(정지 + 목표 근접)은 종전대로 즉시 정착 처리된다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 1, timeoutMs: 5000, sleep: async () => {} });
    const s = moveStub([{ pan: 7828, tilt: 1267, zoom: 8192 }]);
    Reflect.set(source, 'client', s.stub);
    const ok = await source.move(1, { pan: 78.28 / 100 * 360 - 180, tilt: 12, zoom: 18.5 });
    expect(ok).toBe(true);
    expect(s.polls()).toBeLessThanOrEqual(9);
  });
});
