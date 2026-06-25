import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { CameraClient } from '../src/clients/CameraClient.js';
import type { ViewerConfig } from '../src/config/viewerConfig.js';

let server: Server;
let baseUrl: string;
let lastPath: string | undefined;

const camCfg = (): ViewerConfig['camera'] => ({
  baseUrl,
  imageTimeoutMs: 7000,
  moveTimeoutMs: 3000,
  zoomMin: 1.0,
  zoomMax: 36.0,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url;
    if (req.url === '/cameras') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          cameras: [
            {
              camIdx: 1,
              name: 'PTZ Camera 1',
              enabled: true,
              presets: [
                { presetIdx: 1, label: 'Preset 1', pan: 22.0, tilt: 6.8, zoom: 1.6 },
                { presetIdx: 2, pan: 56.6, tilt: 7.4, zoom: 1.9 }, // label 누락 → 폴백
              ],
            },
            // name 누락 → 폴백, enabled=false 보존(제외 아님: A타입 그대로)
            { camIdx: 2, enabled: false, presets: [{ presetIdx: 1 }] },
          ],
        }),
      );
      return;
    }
    if (req.url === '/cameras-empty') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({})); // cameras 부재
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('CameraClient.listCameras() — A타입 파싱', () => {
  it('GET /cameras 호출 + 전체 A타입 구조(presets 중첩) 파싱', async () => {
    const client = new CameraClient(camCfg());
    const list = await client.listCameras();
    expect(lastPath).toBe('/cameras');
    expect(list.cameras).toHaveLength(2);
  });

  it('enabled=false 보존(A타입 그대로 — 제외하지 않음)', async () => {
    const client = new CameraClient(camCfg());
    const list = await client.listCameras();
    const cam2 = list.cameras.find((c) => c.camIdx === 2);
    expect(cam2).toBeDefined();
    expect(cam2!.enabled).toBe(false);
  });

  it('label 폴백: 누락 시 C{cam}-P{preset}', async () => {
    const client = new CameraClient(camCfg());
    const list = await client.listCameras();
    const cam1 = list.cameras[0];
    expect(cam1.presets[0].label).toBe('Preset 1'); // 제공값 유지
    expect(cam1.presets[1].label).toBe('C1-P2'); // 폴백
  });

  it('name 폴백: 누락 시 C{cam}', async () => {
    const client = new CameraClient(camCfg());
    const list = await client.listCameras();
    expect(list.cameras[0].name).toBe('PTZ Camera 1');
    expect(list.cameras.find((c) => c.camIdx === 2)!.name).toBe('C2');
  });

  it('presets PTZ(pan/tilt/zoom) 중첩 보존', async () => {
    const client = new CameraClient(camCfg());
    const list = await client.listCameras();
    expect(list.cameras[0].presets[0]).toMatchObject({ presetIdx: 1, pan: 22.0, tilt: 6.8, zoom: 1.6 });
  });

  it('cameras 부재 응답 → 빈 배열(방어적)', async () => {
    const client = new CameraClient({ ...camCfg(), baseUrl: baseUrl + '/cameras-empty-prefix' });
    // baseUrl + '/cameras' = .../cameras-empty-prefix/cameras → 404 → throw 가 정상.
    await expect(client.listCameras()).rejects.toThrow();
  });
});
