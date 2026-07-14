import { describe, it, expect } from 'vitest';
import { RpcCameraSource } from '../src/viewer/RpcCameraSource.js';
import type { CRpcClient } from '../src/clients/CRpcClient.js';
import { RpcClientError } from '../src/clients/CRpcClient.js';
import type { CameraClient } from '../src/clients/CameraClient.js';

/**
 * callRpc 호출을 기록하고, method 별 응답을 지정할 수 있는 가짜 CRpcClient.
 * responses[method] 가 함수면 params 를 받아 실행, 값이면 그대로 반환.
 */
function fakeRpc(
  responses: Record<string, unknown | ((params: any) => unknown)> = {},
) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    async callRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      const r = responses[method];
      if (typeof r === 'function') return (r as (p: any) => unknown)(params);
      return r;
    },
  } as unknown as CRpcClient;
  return { client, calls };
}

/** clampZoom(1~36) + streamMjpeg 스파이만 갖춘 가짜 CameraClient. */
function fakeCamera() {
  const streamCalls: Array<{ cam: number; preset: number; signal: AbortSignal; ptz?: any }> = [];
  const frames = [Buffer.from([0xff, 0xd8, 0x01]), Buffer.from([0xff, 0xd8, 0x02])];
  const client = {
    clampZoom(zoom: number): number {
      return Math.min(36, Math.max(1, zoom));
    },
    async *streamMjpeg(cam: number, preset: number, signal: AbortSignal, ptz?: any) {
      streamCalls.push({ cam, preset, signal, ptz });
      yield frames[0];
      yield frames[1];
    },
  } as unknown as CameraClient;
  return { client, streamCalls, frames };
}

describe('RpcCameraSource', () => {
  it('kind === rpc', () => {
    const src = new RpcCameraSource(fakeRpc().client, fakeCamera().client);
    expect(src.kind).toBe('rpc');
  });

  describe('listCameras — cam.list + preset.list → CameraList 변환', () => {
    it('camIdx=camId, presetIdx=idx, label=presetName, camIdx 그룹핑, pan/tilt/zoom omit', async () => {
      const { client, calls } = fakeRpc({
        'cam.list': {
          cameras: [
            { camId: 1, name: 'PTZCamera-0', pan: 10, tilt: 5, zoom: 2 },
            { camId: 2, name: 'PTZCamera-1', pan: 0, tilt: 0, zoom: 1 },
          ],
        },
        'preset.list': [
          { idx: 1, presetName: 'A동-1', camIdx: 1 },
          { idx: 2, presetName: 'A동-2', camIdx: 1 },
          { idx: 3, presetName: 'B동-1', camIdx: 2 },
        ],
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const list = await src.listCameras();

      // 두 RPC 모두 빈 params 로 호출
      expect(calls.map((c) => c.method)).toEqual(['cam.list', 'preset.list']);
      expect(calls[0].params).toEqual({});
      expect(calls[1].params).toEqual({});

      expect(list.cameras).toHaveLength(2);
      const c1 = list.cameras[0];
      expect(c1).toMatchObject({ camIdx: 1, name: 'PTZCamera-0', enabled: true });
      // 프리셋 camIdx 그룹핑 정합
      expect(c1.presets).toEqual([
        { presetIdx: 1, label: 'A동-1' },
        { presetIdx: 2, label: 'A동-2' },
      ]);
      // 주차면 프리셋 → 카메라 PTZ 없음(pan/tilt/zoom 미포함)
      expect(c1.presets[0]).not.toHaveProperty('pan');
      expect(c1.presets[0]).not.toHaveProperty('tilt');
      expect(c1.presets[0]).not.toHaveProperty('zoom');

      const c2 = list.cameras[1];
      expect(c2.camIdx).toBe(2);
      expect(c2.presets).toEqual([{ presetIdx: 3, label: 'B동-1' }]);
    });

    it('프리셋 없는 카메라 → presets 빈 배열', async () => {
      const { client } = fakeRpc({
        'cam.list': { cameras: [{ camId: 5, name: 'CamNoPreset' }] },
        'preset.list': [],
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const list = await src.listCameras();
      expect(list.cameras[0].presets).toEqual([]);
    });

    it('presetName 누락 → C{camIdx}-P{idx} 폴백 라벨', async () => {
      const { client } = fakeRpc({
        'cam.list': { cameras: [{ camId: 1 }] },
        'preset.list': [{ idx: 7, camIdx: 1 }],
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const list = await src.listCameras();
      expect(list.cameras[0].name).toBe('C1'); // name 누락 폴백
      expect(list.cameras[0].presets[0].label).toBe('C1-P7');
    });

    it('camIdx 없는 프리셋은 스킵, cameras 누락 시 빈 배열', async () => {
      const { client } = fakeRpc({
        'cam.list': {},
        'preset.list': [{ idx: 1, presetName: '고아프리셋' }],
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const list = await src.listCameras();
      expect(list.cameras).toEqual([]);
    });
  });

  describe('move — cam.setPTZ', () => {
    it('인자 {camId,pan,tilt,zoom} 정합, ok:true → true', async () => {
      const { client, calls } = fakeRpc({ 'cam.setPTZ': { ok: true } });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const ok = await src.move(3, { pan: 20, tilt: -5, zoom: 4 });
      expect(ok).toBe(true);
      expect(calls[0]).toEqual({ method: 'cam.setPTZ', params: { camId: 3, pan: 20, tilt: -5, zoom: 4 } });
    });

    it('ok:false → false', async () => {
      const { client } = fakeRpc({ 'cam.setPTZ': { ok: false } });
      const src = new RpcCameraSource(client, fakeCamera().client);
      expect(await src.move(1, { pan: 0, tilt: 0, zoom: 1 })).toBe(false);
    });

    it('ok 필드 부재 → false (엄격 === true)', async () => {
      const { client } = fakeRpc({ 'cam.setPTZ': {} });
      const src = new RpcCameraSource(client, fakeCamera().client);
      expect(await src.move(1, { pan: 0, tilt: 0, zoom: 1 })).toBe(false);
    });

    it('zoom 범위 초과 → clampZoom(36) 적용', async () => {
      const { client, calls } = fakeRpc({ 'cam.setPTZ': { ok: true } });
      const src = new RpcCameraSource(client, fakeCamera().client);
      await src.move(1, { pan: 0, tilt: 0, zoom: 99 });
      expect(calls[0].params.zoom).toBe(36);
    });
  });

  describe('snapshot manual — cam.setPTZ → cam.captureJPG', () => {
    it('호출 순서/인자 정합, base64→Buffer, ptz=요청 echo', async () => {
      const jpegB64 = Buffer.from('JPEGDATA').toString('base64');
      const { client, calls } = fakeRpc({
        'cam.setPTZ': { ok: true },
        'cam.captureJPG': { img_bytes: jpegB64 },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const r = await src.snapshot(2, { mode: 'manual', ptz: { pan: 15, tilt: 3, zoom: 6 } });

      // 순서: setPTZ 선적용 → captureJPG
      expect(calls.map((c) => c.method)).toEqual(['cam.setPTZ', 'cam.captureJPG']);
      expect(calls[0].params).toEqual({ camId: 2, pan: 15, tilt: 3, zoom: 6 });
      expect(calls[1].params).toEqual({ camId: 2 });

      expect(r.jpeg).toBeInstanceOf(Buffer);
      expect(r.jpeg.toString()).toBe('JPEGDATA'); // base64 디코드 정합
      expect(r.ptz).toEqual({ pan: 15, tilt: 3, zoom: 6 }); // 요청 echo
    });

    it('opt.ptz 미제공 → 기본 {0,0,1} 적용', async () => {
      const { client, calls } = fakeRpc({
        'cam.setPTZ': { ok: true },
        'cam.captureJPG': { img_bytes: '' },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const r = await src.snapshot(1, { mode: 'manual' });
      expect(calls[0].params).toEqual({ camId: 1, pan: 0, tilt: 0, zoom: 1 });
      expect(r.ptz).toEqual({ pan: 0, tilt: 0, zoom: 1 });
    });

    it('img_bytes 누락 → 빈 Buffer', async () => {
      const { client } = fakeRpc({
        'cam.setPTZ': { ok: true },
        'cam.captureJPG': {},
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const r = await src.snapshot(1, { mode: 'manual', ptz: { pan: 0, tilt: 0, zoom: 1 } });
      expect(r.jpeg.length).toBe(0);
    });
  });

  describe('snapshot preset — preset.select → cam.captureJPG, ptz=cam.getPTZ', () => {
    it('호출 순서/인자 정합, ptz=getPTZ 결과', async () => {
      const jpegB64 = Buffer.from('PRESETJPEG').toString('base64');
      const { client, calls } = fakeRpc({
        'preset.select': { ok: true },
        'cam.getPTZ': { pan: 40, tilt: -12, zoom: 8 },
        'cam.captureJPG': { img_bytes: jpegB64 },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const r = await src.snapshot(1, { mode: 'preset', presetIdx: 4 });

      // 순서: preset.select → cam.getPTZ → cam.captureJPG
      expect(calls.map((c) => c.method)).toEqual(['preset.select', 'cam.getPTZ', 'cam.captureJPG']);
      expect(calls[0].params).toEqual({ idx: 4 });
      expect(calls[1].params).toEqual({ camId: 1 });
      expect(calls[2].params).toEqual({ camId: 1 });

      expect(r.jpeg.toString()).toBe('PRESETJPEG');
      expect(r.ptz).toEqual({ pan: 40, tilt: -12, zoom: 8 });
    });

    it('presetIdx 미제공 → 기본 idx:1', async () => {
      const { client, calls } = fakeRpc({
        'preset.select': { ok: true },
        'cam.getPTZ': { pan: 0, tilt: 0, zoom: 1 },
        'cam.captureJPG': { img_bytes: '' },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      await src.snapshot(1, { mode: 'preset' });
      expect(calls[0].params).toEqual({ idx: 1 });
    });

    it('cam.getPTZ 실패 → {0,0,1} UNKNOWN 강등(캡처는 진행)', async () => {
      const jpegB64 = Buffer.from('X').toString('base64');
      const { client, calls } = fakeRpc({
        'preset.select': { ok: true },
        'cam.getPTZ': () => {
          throw new RpcClientError('rpc_error', 'getPTZ 미지원');
        },
        'cam.captureJPG': { img_bytes: jpegB64 },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const r = await src.snapshot(1, { mode: 'preset', presetIdx: 2 });
      expect(r.ptz).toEqual({ pan: 0, tilt: 0, zoom: 1 });
      expect(r.jpeg.toString()).toBe('X'); // 강등돼도 캡처는 성공
      expect(calls.map((c) => c.method)).toEqual(['preset.select', 'cam.getPTZ', 'cam.captureJPG']);
    });

    it('cam.getPTZ 부분 필드 → 결측만 폴백', async () => {
      const { client } = fakeRpc({
        'preset.select': { ok: true },
        'cam.getPTZ': { pan: 33 }, // tilt/zoom 결측
        'cam.captureJPG': { img_bytes: '' },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      const r = await src.snapshot(1, { mode: 'preset', presetIdx: 1 });
      expect(r.ptz).toEqual({ pan: 33, tilt: 0, zoom: 1 });
    });
  });

  describe('RPC 에러 전파(라우트 502 매핑)', () => {
    it('cam.list throw → listCameras 전파', async () => {
      const { client } = fakeRpc({
        'cam.list': () => {
          throw new RpcClientError('connection_error', 'Unity RPC 연결 실패');
        },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      await expect(src.listCameras()).rejects.toBeInstanceOf(RpcClientError);
    });

    it('cam.setPTZ throw → move 전파', async () => {
      const { client } = fakeRpc({
        'cam.setPTZ': () => {
          throw new RpcClientError('rpc_error', 'RPC 오류');
        },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      await expect(src.move(1, { pan: 0, tilt: 0, zoom: 1 })).rejects.toBeInstanceOf(RpcClientError);
    });

    it('cam.captureJPG throw → snapshot 전파(getPTZ 와 달리 강등 안 함)', async () => {
      const { client } = fakeRpc({
        'cam.setPTZ': { ok: true },
        'cam.captureJPG': () => {
          throw new RpcClientError('rpc_error', 'capture 실패');
        },
      });
      const src = new RpcCameraSource(client, fakeCamera().client);
      await expect(
        src.snapshot(1, { mode: 'manual', ptz: { pan: 0, tilt: 0, zoom: 1 } }),
      ).rejects.toBeInstanceOf(RpcClientError);
    });
  });

  describe('PTZ 단위 변환 항등', () => {
    it('toNativePtz / fromNativePtz identity', () => {
      const src = new RpcCameraSource(fakeRpc().client, fakeCamera().client);
      const p = { pan: 17.5, tilt: -4.2, zoom: 12 };
      expect(src.toNativePtz(p)).toBe(p);
      expect(src.fromNativePtz(p)).toBe(p);
    });
  });

  describe('streamMjpeg — CameraClient 위임', () => {
    it('cam/preset/signal/ptz 인자 그대로 위임 + 프레임 패스스루', async () => {
      const { client: rpc } = fakeRpc();
      const { client: cam, streamCalls, frames } = fakeCamera();
      const src = new RpcCameraSource(rpc, cam);
      const ac = new AbortController();
      const ptz = { pan: 5, tilt: 2, zoom: 3 };
      const got: Buffer[] = [];
      for await (const f of src.streamMjpeg(4, 9, ac.signal, ptz)) got.push(f);

      expect(streamCalls).toHaveLength(1);
      expect(streamCalls[0].cam).toBe(4);
      expect(streamCalls[0].preset).toBe(9);
      expect(streamCalls[0].signal).toBe(ac.signal); // 동일 signal 인스턴스
      expect(streamCalls[0].ptz).toBe(ptz);
      expect(got).toEqual(frames); // 프레임 패스스루
    });

    it('ptz 미제공 → undefined 위임', async () => {
      const { client: cam, streamCalls } = fakeCamera();
      const src = new RpcCameraSource(fakeRpc().client, cam);
      const ac = new AbortController();
      for await (const _f of src.streamMjpeg(1, 1, ac.signal)) { /* drain */ }
      expect(streamCalls[0].ptz).toBeUndefined();
    });
  });
});
