import { describe, expect, it } from 'vitest';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';

/**
 * RealPtzSource 의 장비 프리셋 결선.
 *
 * 확립 사실(실측 2026-07-30, 192.168.0.153):
 *  - **목록은 Hucoms 로 못 읽는다**(HTTP API v1.22 §8.4 = set/go/clear 뿐, get* 은 204) → ONVIF 위임.
 *  - **이동은 Hucoms `gopreset`** 그대로. 목표 PTZ 를 모르므로(장비가 프리셋 PTZ 를 주지 않는다)
 *    "정지 확인" 방식으로 정착을 기다린 뒤 **이동 후 실측** PTZ 를 돌려준다.
 */

const cfg: CameraSourceConfig = {
  id: 'ptz1', kind: 'hucoms', baseUrl: 'http://127.0.0.1:1',
  username: 'admin', password: 'pw',
  ptz: { panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 16384] },
};

/** goPreset 호출과 getptzfpos 응답 시퀀스를 통제하는 Hucoms client 스텁. */
function stubHucoms(source: RealPtzSource, frames: Array<Record<string, string>>) {
  const calls: { goPreset: number[]; reads: number } = { goPreset: [], reads: 0 };
  Reflect.set(source, 'client', {
    goPreset: async (n: number) => { calls.goPreset.push(n); return { values: {} }; },
    getPtzfPosition: async () => {
      const frame = frames[Math.min(calls.reads, frames.length - 1)];
      calls.reads += 1;
      return { values: frame };
    },
  });
  return calls;
}

const noSleep = { pollMs: 0, timeoutMs: 1000, sleep: async () => {} };

describe('RealPtzSource — 장비 프리셋', () => {
  it('listDevicePresets 는 주입된 ONVIF 클라이언트에 위임한다', async () => {
    const presets = [{ token: '001', name: 'EV1', number: 1 }];
    let called = 0;
    const source = new RealPtzSource(cfg, 7000, undefined, noSleep, undefined, {
      getPresets: async () => { called += 1; return presets; },
    });
    expect(await source.listDevicePresets(1)).toEqual(presets);
    expect(called).toBe(1);
  });

  it('listDevicePresets 실패는 그대로 올린다(빈 목록으로 위장 금지)', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, noSleep, undefined, {
      getPresets: async () => { throw new Error('ONVIF GetPresets 거부: Sender not Authorized'); },
    });
    await expect(source.listDevicePresets(1)).rejects.toThrow(/Sender not Authorized/);
  });

  it('gotoDevicePreset — gopreset 을 1회 보내고, 정지 확인 후 실측 PTZ(뷰어+원시)를 돌려준다', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, noSleep, undefined, { getPresets: async () => [] });
    // 슬루 중 2프레임 → 정지(동일 값 2회) → 이후 조회는 같은 값.
    const calls = stubHucoms(source, [
      { panpos: '1000', tiltpos: '500', zoompos: '2000' },
      { panpos: '5000', tiltpos: '1500', zoompos: '6000' },
      { panpos: '7034', tiltpos: '2760', zoompos: '8155' },
      { panpos: '7034', tiltpos: '2760', zoompos: '8155' },
    ]);

    const result = await source.gotoDevicePreset(1, 3);

    expect(calls.goPreset).toEqual([3]);
    expect(result.number).toBe(3);
    expect(result.settled).toBe(true);
    expect(result.native).toEqual({ pan: 7034, tilt: 2760, zoom: 8155 });
    // 원시 → 뷰어 좌표 환산(pan 0~35999→-180~180 / tilt -2000~9000→-90~90 / zoom 0~16384→1~36).
    expect(result.ptz.pan).toBeCloseTo(-109.66, 2);
    expect(result.ptz.tilt).toBeCloseTo(-12.11, 2);
    expect(result.ptz.zoom).toBeCloseTo(18.42, 2);
  });

  it('gotoDevicePreset — 정지를 확인 못하면 settled:false 로 올린다(성공으로 위장하지 않는다)', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, { pollMs: 0, timeoutMs: 5, sleep: async () => {} }, undefined, {
      getPresets: async () => [],
    });
    // 계속 값이 변한다 = 슬루가 끝나지 않음 → 상한 초과.
    let n = 0;
    Reflect.set(source, 'client', {
      goPreset: async () => ({ values: {} }),
      getPtzfPosition: async () => {
        n += 1;
        return { values: { panpos: String(1000 + n * 100), tiltpos: '500', zoompos: '2000' } };
      },
    });
    const result = await source.gotoDevicePreset(1, 5);
    expect(result.settled).toBe(false);
    expect(result.native).toBeDefined();
  });

  it('getNativePtz — 장비 원시값을 그대로, 불완전 응답이면 예외', async () => {
    const source = new RealPtzSource(cfg, 7000, undefined, noSleep, undefined, { getPresets: async () => [] });
    stubHucoms(source, [{ panpos: '7034', tiltpos: '2760', zoompos: '8155' }]);
    expect(await source.getNativePtz(1)).toEqual({ pan: 7034, tilt: 2760, zoom: 8155 });

    const broken = new RealPtzSource(cfg, 7000, undefined, noSleep, undefined, { getPresets: async () => [] });
    stubHucoms(broken, [{ panpos: '7034' }]);
    await expect(broken.getNativePtz(1)).rejects.toThrow(/완전하지 않습니다/);
  });
});
