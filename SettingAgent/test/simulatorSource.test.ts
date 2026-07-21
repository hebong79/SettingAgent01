import { describe, it, expect } from 'vitest';
import { SimulatorSource } from '../src/viewer/SimulatorSource.js';
import type { CameraClient } from '../src/clients/CameraClient.js';
import type { CapturedImage } from '../src/domain/types.js';
import type { CameraList } from '../src/viewer/CameraSource.js';

/** requestImage/move/listCameras 호출 인자를 기록하는 가짜 CameraClient. */
function spyCamera() {
  const calls: { requestImage: any[]; move: any[]; getPtz: any[]; list: number } = { requestImage: [], move: [], getPtz: [], list: 0 };
  const client = {
    async requestImage(cam: number, preset: number, ptz?: any): Promise<CapturedImage> {
      calls.requestImage.push({ cam, preset, ptz });
      return { camIdx: cam, presetIdx: preset, pan: ptz?.pan ?? 11, tilt: ptz?.tilt ?? 22, zoom: ptz?.zoom ?? 3, imgName: 'img', jpg: Buffer.from('JPEGDATA') };
    },
    async move(cam: number, pan: number, tilt: number, zoom: number): Promise<boolean> {
      calls.move.push({ cam, pan, tilt, zoom });
      return true;
    },
    async getPtz(cam: number) {
      calls.getPtz.push({ cam });
      return { pan: 15, tilt: -4, zoom: 9 };
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

  it('getPtz → camera.getPtz 위임', async () => {
    const { client, calls } = spyCamera();
    const src = new SimulatorSource(client);
    await expect(src.getPtz(4)).resolves.toEqual({ pan: 15, tilt: -4, zoom: 9 });
    expect(calls.getPtz).toEqual([{ cam: 4 }]);
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

  it('streamMjpeg → camera.streamMjpeg 위임(cam,preset,signal 그대로 전달 + 프레임 패스스루)', async () => {
    const streamCalls: Array<{ cam: number; preset: number; signal: AbortSignal }> = [];
    const f1 = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const f2 = Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const client = {
      async *streamMjpeg(cam: number, preset: number, signal: AbortSignal) {
        streamCalls.push({ cam, preset, signal });
        yield f1;
        yield f2;
      },
    } as unknown as CameraClient;

    const src = new SimulatorSource(client);
    const ac = new AbortController();
    const got: Buffer[] = [];
    for await (const f of src.streamMjpeg!(3, 7, ac.signal)) got.push(f);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].cam).toBe(3);
    expect(streamCalls[0].preset).toBe(7);
    expect(streamCalls[0].signal).toBe(ac.signal); // 동일 signal 인스턴스 위임
    expect(got).toEqual([f1, f2]); // 프레임 패스스루
  });
});
