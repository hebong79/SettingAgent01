import { describe, expect, it, vi } from 'vitest';
import { CameraSourceClient } from '../src/clients/CameraSourceClient.js';
import { DEFAULT_TOOLS_CONFIG } from '../src/config/toolsConfig.js';
import type { CameraSource } from '../src/viewer/CameraSource.js';

function fakeSource(overrides: Partial<CameraSource> = {}): CameraSource {
  return {
    kind: 'hucoms',
    health: async () => true,
    listCameras: async () => ({ cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [] }] }),
    snapshot: async () => ({ jpeg: Buffer.from('jpeg'), ptz: { pan: 2, tilt: 3, zoom: 4 } }),
    move: async () => true,
    toNativePtz: (value) => value,
    fromNativePtz: (value) => value as { pan: number; tilt: number; zoom: number },
    ...overrides,
  };
}

describe('CameraSourceClient', () => {
  it('snapshot 결과를 메인 파이프라인 CapturedImage로 변환', async () => {
    const snapshot = vi.fn(async () => ({ jpeg: Buffer.from('jpeg'), ptz: { pan: 2, tilt: 3, zoom: 4 } }));
    const client = new CameraSourceClient(fakeSource({ snapshot }), DEFAULT_TOOLS_CONFIG.camera);
    const result = await client.requestImage(1, 7, { pan: 2, tilt: 3, zoom: 99 });
    expect(snapshot).toHaveBeenCalledWith(1, { mode: 'manual', presetIdx: 7, ptz: { pan: 2, tilt: 3, zoom: 36 } });
    expect(result).toMatchObject({ camIdx: 1, presetIdx: 7, pan: 2, tilt: 3, zoom: 4, imgName: 'cam1_p7.jpg' });
    expect(result.jpg.toString()).toBe('jpeg');
  });

  it('move를 공통 PTZ 객체로 위임하고 zoom을 clamp', async () => {
    const move = vi.fn(async () => true);
    const client = new CameraSourceClient(fakeSource({ move }), DEFAULT_TOOLS_CONFIG.camera);
    expect(await client.move(2, 10, -5, 100)).toBe(true);
    expect(move).toHaveBeenCalledWith(2, { pan: 10, tilt: -5, zoom: 36 });
  });

  it('getPtz를 선택 소스에 위임하고 zoom을 clamp', async () => {
    const getPtz = vi.fn(async () => ({ pan: 10, tilt: -5, zoom: 99 }));
    const client = new CameraSourceClient(fakeSource({ getPtz }), DEFAULT_TOOLS_CONFIG.camera);
    await expect(client.getPtz(2)).resolves.toEqual({ pan: 10, tilt: -5, zoom: 36 });
    expect(getPtz).toHaveBeenCalledWith(2);
  });

  it('현재 PTZ 조회 미지원 소스는 명시적으로 실패한다', async () => {
    const client = new CameraSourceClient(fakeSource(), DEFAULT_TOOLS_CONFIG.camera);
    await expect(client.getPtz(1)).rejects.toThrow('현재 PTZ 조회를 지원하지 않습니다');
  });

  it('소스 health 실패를 false로 격리', async () => {
    const client = new CameraSourceClient(fakeSource({ health: async () => { throw new Error('offline'); } }), DEFAULT_TOOLS_CONFIG.camera);
    expect(await client.health()).toBe(false);
  });
});
