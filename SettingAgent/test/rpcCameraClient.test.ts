import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { RpcCameraClient } from '../src/clients/RpcCameraClient.js';
import type { CRpcClient } from '../src/clients/CRpcClient.js';
import { RpcClientError } from '../src/clients/CRpcClient.js';
import type { ICameraClient } from '../src/clients/CameraClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';
import { resolvePresetPtz } from '../src/capture/detectPipeline.js';

/**
 * RpcCameraClient 유닛테스트 — 설계서 §6 / 02 §유닛테스트 후보.
 * CRpcClient 를 모킹해 RPC 메서드 매핑·인자 정합·경계면 shape(CapturedImage/CameraList)을 검증한다.
 * 실 Unity(13110)·정밀수집 전체 런은 리더 라이브 실증으로 대체(본 스위트는 계약 검증에 집중).
 */

/** camerapos 형식 A 픽스처(cam1: preset1/2, cam2: preset1). */
const CAMERAPOS_FIXTURE = fileURLToPath(new URL('./fixtures/camerapos.rpc.json', import.meta.url));
/** 존재하지 않는 파일(graceful 빈 목록 경로 검증용). */
const CAMERAPOS_MISSING = fileURLToPath(new URL('./fixtures/__nope__.json', import.meta.url));

const cameraCfg = (): ToolsConfig['camera'] => ({
  baseUrl: 'http://localhost:13110',
  imageTimeoutMs: 7000,
  moveTimeoutMs: 3000,
  zoomMin: 1.0,
  zoomMax: 36.0,
});

/**
 * callRpc 호출을 기록하고 method 별 응답을 지정하는 가짜 CRpcClient.
 * responses[method] 가 함수면 params 로 실행, 값이면 그대로 반환. 미지정 method 는 undefined.
 * (rpcCameraSource.test.ts 의 fakeRpc 패턴 재사용.)
 */
function fakeRpc(responses: Record<string, unknown | ((params: any) => unknown)> = {}) {
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

function makeClient(
  responses: Record<string, unknown | ((params: any) => unknown)> = {},
  cameraposFile = CAMERAPOS_FIXTURE,
) {
  const { client: rpc, calls } = fakeRpc(responses);
  const camera = new RpcCameraClient({ rpc, cameraCfg: cameraCfg(), cameraposFile });
  return { camera, calls };
}

describe('RpcCameraClient.move — cam.setPTZ', () => {
  it('인자 {camId,pan,tilt,zoom:clamp} 정합, ok:true → true', async () => {
    const { camera, calls } = makeClient({ 'cam.setPTZ': { ok: true } });
    const ok = await camera.move(3, 20, -5, 4);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'cam.setPTZ', params: { camId: 3, pan: 20, tilt: -5, zoom: 4 } });
  });

  it('ok:false → false, ok 부재 → false(엄격 === true)', async () => {
    const a = makeClient({ 'cam.setPTZ': { ok: false } });
    expect(await a.camera.move(1, 0, 0, 1)).toBe(false);
    const b = makeClient({ 'cam.setPTZ': {} });
    expect(await b.camera.move(1, 0, 0, 1)).toBe(false);
  });

  it('zoom 범위 초과 → clampZoom(zoomMax=36) 적용', async () => {
    const { camera, calls } = makeClient({ 'cam.setPTZ': { ok: true } });
    await camera.move(1, 0, 0, 99);
    expect(calls[0].params.zoom).toBe(36);
  });
});

describe('RpcCameraClient.requestImage — ptz 제공', () => {
  it('setPTZ(clamp) 선행 → captureJPG, CapturedImage shape/base64 정합', async () => {
    const jpegB64 = Buffer.from('JPEGDATA').toString('base64');
    const { camera, calls } = makeClient({
      'cam.setPTZ': { ok: true },
      'cam.captureJPG': { img_bytes: jpegB64 },
    });
    const cap = await camera.requestImage(2, 5, { pan: 15, tilt: 3, zoom: 6 });

    // 호출 순서: setPTZ 선적용 → captureJPG
    expect(calls.map((c) => c.method)).toEqual(['cam.setPTZ', 'cam.captureJPG']);
    expect(calls[0].params).toEqual({ camId: 2, pan: 15, tilt: 3, zoom: 6 });
    expect(calls[1].params).toEqual({ camId: 2 });

    // CapturedImage 경계면 shape
    expect(cap.camIdx).toBe(2);
    expect(cap.presetIdx).toBe(5);
    expect(cap.pan).toBe(15);
    expect(cap.tilt).toBe(3);
    expect(cap.zoom).toBe(6); // 명령 ptz echo(zoom=clamp)
    expect(cap.imgName).toBe('cam2_p5.jpg');
    expect(cap.jpg).toBeInstanceOf(Buffer);
    expect(cap.jpg.toString()).toBe('JPEGDATA'); // base64 디코드 정합
  });

  it('zoom 클램프: ptz.zoom=100 → setPTZ zoom=36, echo zoom=36', async () => {
    const { camera, calls } = makeClient({
      'cam.setPTZ': { ok: true },
      'cam.captureJPG': { img_bytes: '' },
    });
    const cap = await camera.requestImage(1, 1, { pan: 10, tilt: 2, zoom: 100 });
    expect(calls[0].params.zoom).toBe(36);
    expect(cap.zoom).toBe(36);
  });

  it('ptz 부분 필드(pan/tilt 결측) → 0 폴백, getPTZ 미호출', async () => {
    const { camera, calls } = makeClient({
      'cam.setPTZ': { ok: true },
      'cam.captureJPG': { img_bytes: '' },
    });
    const cap = await camera.requestImage(1, 1, { zoom: 5 });
    expect(calls[0].params).toEqual({ camId: 1, pan: 0, tilt: 0, zoom: 5 });
    expect(calls.some((c) => c.method === 'cam.getPTZ')).toBe(false);
    expect(cap.pan).toBe(0);
    expect(cap.tilt).toBe(0);
  });
});

describe('RpcCameraClient.requestImage — ptz 미제공', () => {
  it('setPTZ 미호출, captureJPG 만; echo=cam.getPTZ', async () => {
    const jpegB64 = Buffer.from('PRESETJPEG').toString('base64');
    const { camera, calls } = makeClient({
      'cam.getPTZ': { pan: 40, tilt: -12, zoom: 8 },
      'cam.captureJPG': { img_bytes: jpegB64 },
    });
    const cap = await camera.requestImage(1, 4);

    expect(calls.some((c) => c.method === 'cam.setPTZ')).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['cam.getPTZ', 'cam.captureJPG']);
    expect(calls[0].params).toEqual({ camId: 1 });
    expect(cap.pan).toBe(40);
    expect(cap.tilt).toBe(-12);
    expect(cap.zoom).toBe(8);
    expect(cap.jpg.toString()).toBe('PRESETJPEG');
  });

  it('cam.getPTZ 실패 → {0,0,1} 강등, 캡처는 진행', async () => {
    const { camera } = makeClient({
      'cam.getPTZ': () => {
        throw new RpcClientError('rpc_error', 'getPTZ 미지원');
      },
      'cam.captureJPG': { img_bytes: Buffer.from('X').toString('base64') },
    });
    const cap = await camera.requestImage(1, 2);
    expect(cap.pan).toBe(0);
    expect(cap.tilt).toBe(0);
    expect(cap.zoom).toBe(1);
    expect(cap.jpg.toString()).toBe('X');
  });

  it('cam.getPTZ 부분 필드 → 결측만 폴백(zoom→1)', async () => {
    const { camera } = makeClient({
      'cam.getPTZ': { pan: 33 },
      'cam.captureJPG': { img_bytes: '' },
    });
    const cap = await camera.requestImage(1, 1);
    expect(cap.pan).toBe(33);
    expect(cap.tilt).toBe(0);
    expect(cap.zoom).toBe(1);
  });
});

describe('RpcCameraClient.requestImage — img_bytes 누락', () => {
  it('img_bytes 부재 → 빈 Buffer(graceful)', async () => {
    const { camera } = makeClient({
      'cam.setPTZ': { ok: true },
      'cam.captureJPG': {}, // img_bytes 없음
    });
    const cap = await camera.requestImage(1, 1, { pan: 0, tilt: 0, zoom: 1 });
    expect(cap.jpg).toBeInstanceOf(Buffer);
    expect(cap.jpg.length).toBe(0);
  });
});

describe('RpcCameraClient.listCameras — camerapos.json 기반', () => {
  it('형식 A 파싱 → 프리셋 PTZ(pan/tilt/zoom) 포함 CameraList', async () => {
    const { camera, calls } = makeClient();
    const list = await camera.listCameras();

    // RPC 미사용(camerapos 파일이 프리셋 진실원)
    expect(calls).toHaveLength(0);
    expect(list.cameras).toHaveLength(2);

    const c1 = list.cameras.find((c) => c.camIdx === 1)!;
    expect(c1.presets).toHaveLength(2);
    expect(c1.presets[0]).toMatchObject({ presetIdx: 1, label: 'Preset 1', pan: 22, tilt: 6.8, zoom: 1.6 });
    expect(c1.presets[1]).toMatchObject({ presetIdx: 2, pan: 56.6, tilt: 7.4, zoom: 1.9 });

    const c2 = list.cameras.find((c) => c.camIdx === 2)!;
    expect(c2.presets[0]).toMatchObject({ presetIdx: 1, pan: 53.9, tilt: 14.5, zoom: 1.7 });
    // devices 미전달 → enabled=false(buildCameraList 규약)
    expect(c1.enabled).toBe(false);
  });

  it('파일 없음 → 빈 목록(graceful)', async () => {
    const { camera } = makeClient({}, CAMERAPOS_MISSING);
    const list = await camera.listCameras();
    expect(list.cameras).toEqual([]);
  });
});

describe('RpcCameraClient.health — system.ping', () => {
  it('ping 성공 → true', async () => {
    const { camera, calls } = makeClient({ 'system.ping': {} });
    expect(await camera.health()).toBe(true);
    expect(calls[0]).toEqual({ method: 'system.ping', params: {} });
  });

  it('ping throw → false(장애 격리)', async () => {
    const { camera } = makeClient({
      'system.ping': () => {
        throw new RpcClientError('connection_error', 'Unity RPC 연결 실패');
      },
    });
    expect(await camera.health()).toBe(false);
  });
});

describe('RpcCameraClient.clampZoom — inner 위임', () => {
  it('경계 클램프: 0.5→zoomMin(1), 100→zoomMax(36), 정상값 통과', () => {
    const { camera } = makeClient();
    expect(camera.clampZoom(0.5)).toBe(1);
    expect(camera.clampZoom(100)).toBe(36);
    expect(camera.clampZoom(6)).toBe(6);
  });
});

describe('resolvePresetPtz 정합(detectPipeline 재사용)', () => {
  it('camerapos 프리셋 PTZ 를 그대로 반환', async () => {
    const { camera } = makeClient();
    expect(await resolvePresetPtz(camera, 1, 2)).toEqual({ pan: 56.6, tilt: 7.4, zoom: 1.9 });
    expect(await resolvePresetPtz(camera, 2, 1)).toEqual({ pan: 53.9, tilt: 14.5, zoom: 1.7 });
  });

  it('없는 카메라/프리셋 → null(호출측 echo 폴백 유도)', async () => {
    const { camera } = makeClient();
    expect(await resolvePresetPtz(camera, 9, 1)).toBeNull();
    expect(await resolvePresetPtz(camera, 1, 9)).toBeNull();
  });
});

describe('RpcCameraClient — ICameraClient 계약', () => {
  it('공개 6메서드 존재(타입/런타임)', () => {
    const { camera } = makeClient();
    const asIface: ICameraClient = camera; // 타입 정합(컴파일 시 검증)
    for (const m of ['clampZoom', 'health', 'requestImage', 'streamMjpeg', 'listCameras', 'move'] as const) {
      expect(typeof (asIface as any)[m]).toBe('function');
    }
  });
});
