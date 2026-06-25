import { describe, it, expect } from 'vitest';
import { SimulatorSource } from '../src/viewer/SimulatorSource.js';
import type { CameraClient, CapturedImage } from '../src/clients/CameraClient.js';
import type { CameraList } from '../src/viewer/CameraSource.js';

/** requestImage/move/listCameras 호출 인자를 기록하는 가짜 CameraClient. */
function spyCamera() {
  const calls: { requestImage: any[]; move: any[]; list: number } = { requestImage: [], move: [], list: 0 };
  const client = {
    async requestImage(cam: number, preset: number, ptz?: any): Promise<CapturedImage> {
      calls.requestImage.push({ cam, preset, ptz });
      return { camIdx: cam, presetIdx: preset, pan: ptz?.pan ?? 11, tilt: ptz?.tilt ?? 22, zoom: ptz?.zoom ?? 3, imgName: 'img', jpg: Buffer.from('JPEGDATA') };
    },
    async move(cam: number, pan: number, tilt: number, zoom: number): Promise<boolean> {
      calls.move.push({ cam, pan, tilt, zoom });
      return true;
    },
    async listCameras(): Promise<CameraList> {
      calls.list++;
      return { cameras: [{ camIdx: 1, name: 'C1', enabled: true, presets: [] }] };
    },
  } as unknown as CameraClient;
  return { client, calls };
}

describe('SimulatorSource', () => {
  it('kind === sim', () => {
    const { client } = spyCamera();
    expect(new SimulatorSource(client).kind).toBe('sim');
  });

  it('snapshot preset 모드 → PTZ override 미동봉(requestImage 세번째 인자 undefined)', async () => {
    const { client, calls } = spyCamera();
    const src = new SimulatorSource(client);
    const r = await src.snapshot(2, { mode: 'preset', presetIdx: 5 });
    expect(calls.requestImage).toHaveLength(1);
    expect(calls.requestImage[0]).toMatchObject({ cam: 2, preset: 5 });
    expect(calls.requestImage[0].ptz).toBeUndefined();
    expect(r.jpeg.toString()).toBe('JPEGDATA');
    expect(r.ptz).toEqual({ pan: 11, tilt: 22, zoom: 3 });
  });

  it('snapshot manual 모드 → PTZ override 동봉', async () => {
    const { client, calls } = spyCamera();
    const src = new SimulatorSource(client);
    const r = await src.snapshot(1, { mode: 'manual', presetIdx: 3, ptz: { pan: 45, tilt: 9, zoom: 6 } });
    expect(calls.requestImage[0]).toMatchObject({ cam: 1, preset: 3, ptz: { pan: 45, tilt: 9, zoom: 6 } });
    // 응답 PTZ 가 override 값을 반영(spy 가 그대로 echo)
    expect(r.ptz).toEqual({ pan: 45, tilt: 9, zoom: 6 });
  });

  it('move → camera.move 위임(인자 순서 cam,pan,tilt,zoom)', async () => {
    const { client, calls } = spyCamera();
    const src = new SimulatorSource(client);
    const ok = await src.move(4, { pan: -30, tilt: 12, zoom: 8 });
    expect(ok).toBe(true);
    expect(calls.move[0]).toEqual({ cam: 4, pan: -30, tilt: 12, zoom: 8 });
  });

  it('listCameras → camera.listCameras 위임', async () => {
    const { client, calls } = spyCamera();
    const src = new SimulatorSource(client);
    const list = await src.listCameras();
    expect(calls.list).toBe(1);
    expect(list.cameras[0].camIdx).toBe(1);
  });

  it('단위변환 항등(toNativePtz/fromNativePtz)', () => {
    const { client } = spyCamera();
    const src = new SimulatorSource(client);
    const p = { pan: 17.5, tilt: -4.2, zoom: 12 };
    expect(src.toNativePtz(p)).toBe(p);
    expect(src.fromNativePtz(p)).toBe(p);
  });
});
