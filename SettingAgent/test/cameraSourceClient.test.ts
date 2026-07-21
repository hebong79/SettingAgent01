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

  /**
   * 능력 협상(설계서 §1-c): centerOnPoint 는 소스가 지원할 때만 프로퍼티로 존재해야 한다.
   * 무조건 메서드로 두면 미지원 소스(시뮬 RpcCameraSource)까지 "네이티브 지원"으로 보여
   * PtzCalibrator.aimPointToCenter 의 native/geometric 판정이 무너진다.
   */
  it('centerOnPoint 미지원 소스 → 값이 undefined(시뮬 오판 방지, 호출측 truthy 판정 기준)', () => {
    const client = new CameraSourceClient(fakeSource(), DEFAULT_TOOLS_CONFIG.camera);
    expect(client.centerOnPoint).toBeUndefined();
    // ★ 주의(실측 확인): target ES2022 → useDefineForClassFields=true 이므로 `centerOnPoint?: …` 필드 선언이
    //   생성자 이전에 프로퍼티를 undefined 로 **정의**한다. 즉 `'centerOnPoint' in client` 는 미지원 소스에서도
    //   true 다. 능력 판정은 반드시 값 truthy(현 구현: PtzCalibrator 의 `const native = this.camera.centerOnPoint`)로
    //   해야 하며, `in`/Object.keys 로 판정하면 시뮬을 네이티브로 오판한다. 이 계약을 여기서 못 박는다.
    expect('centerOnPoint' in client).toBe(true);
    expect(Boolean(client.centerOnPoint)).toBe(false);
  });

  it('centerOnPoint 지원 소스 → 정규화 지점 그대로 위임(zoom clamp 등 가공 없음)', async () => {
    const centerOnPoint = vi.fn(async () => ({ pan: 40, tilt: 1, zoom: 1.6934098 }));
    const client = new CameraSourceClient(fakeSource({ centerOnPoint }), DEFAULT_TOOLS_CONFIG.camera);
    expect(typeof client.centerOnPoint).toBe('function');
    await expect(client.centerOnPoint!(2, { x: 0.117, y: 0.69 })).resolves.toEqual({ pan: 40, tilt: 1, zoom: 1.6934098 });
    expect(centerOnPoint).toHaveBeenCalledWith(2, { x: 0.117, y: 0.69 });
  });
});
