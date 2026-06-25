import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { UnityPresetProvider, DiscoveryPresetProvider, createPresetProvider } from '../src/setup/presetProvider.js';
import type { CameraClient } from '../src/clients/CameraClient.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/cameras') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        cameras: [
          { camIdx: 1, name: 'PTZ Camera 1', enabled: true, presets: [
            { presetIdx: 1, label: 'Preset 1', pan: 22.0, tilt: 6.8, zoom: 1.6 },
            { presetIdx: 2, label: 'Preset 2', pan: 56.6, tilt: 7.4, zoom: 1.9 },
          ] },
          { camIdx: 2, enabled: false, presets: [{ presetIdx: 1 }] }, // 비활성 → 제외
        ],
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('UnityPresetProvider (A)', () => {
  it('GET /cameras → CameraView[] 매핑(enabled=false 제외, PTZ 보존)', async () => {
    const p = new UnityPresetProvider(baseUrl, 3000);
    const views = await p.listViews();
    expect(views.map((v) => `${v.camIdx}:${v.presetIdx}`)).toEqual(['1:1', '1:2']);
    expect(views[0]).toMatchObject({ label: 'Preset 1', pan: 22.0, tilt: 6.8, zoom: 1.6 });
  });

  it('비-2xx 면 throw', async () => {
    const p = new UnityPresetProvider(baseUrl + '/nope-prefix', 3000);
    // baseUrl/nope-prefix/cameras → 404
    await expect(p.listViews()).rejects.toThrow();
  });
});

describe('createPresetProvider', () => {
  const fakeCam = {} as unknown as CameraClient;
  // baseUrl 은 beforeAll 에서 설정되므로 지연 평가.
  const mkDeps = () => ({ camera: fakeCam, discovery: { enabled: true, maxCameras: 4, maxPresetsPerCamera: 4 }, cameraBaseUrl: baseUrl, timeoutMs: 3000 });

  it('unity-api → UnityPresetProvider', () => {
    const p = createPresetProvider({ type: 'unity-api', unityUrl: '', refreshOnRun: false }, mkDeps());
    expect(p?.name).toBe('unity-api');
  });
  it('discovery → DiscoveryPresetProvider', () => {
    const p = createPresetProvider({ type: 'discovery', unityUrl: '', refreshOnRun: false }, mkDeps());
    expect(p).toBeInstanceOf(DiscoveryPresetProvider);
  });
  it('camerapos → null(수동)', () => {
    expect(createPresetProvider({ type: 'camerapos', unityUrl: '', refreshOnRun: false }, mkDeps())).toBeNull();
  });
  it('unityUrl 비우면 cameraBaseUrl 사용', async () => {
    const p = createPresetProvider({ type: 'unity-api', unityUrl: '', refreshOnRun: false }, mkDeps())!;
    const views = await p.listViews(); // cameraBaseUrl(목 서버)로 동작
    expect(views).toHaveLength(2);
  });
});
