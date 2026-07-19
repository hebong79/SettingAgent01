import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { CameraSourceConfig } from '../src/config/toolsConfig.js';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';

let server: Server;
let host: string;
let port: number;
let seen: Array<{ path: string; query: URLSearchParams }>;
let nativePtz = { pan: 0, tilt: 0, zoom: 1 };

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://camera.local');
    seen.push({ path: url.pathname, query: url.searchParams });
    const action = url.searchParams.get('action');

    if (url.pathname === '/cgi-bin/control/servername.cgi') {
      response.setHeader('content-type', 'text/plain');
      response.end(url.searchParams.get('passwd') === 'bad' ? 'Error: unauthorized' : 'servername = parking\n');
      return;
    }
    if (url.pathname === '/cgi-bin/image/jpeg.cgi') {
      response.setHeader('content-type', 'image/jpeg');
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      return;
    }
    if (url.pathname === '/cgi-bin/control/ptzf_status.cgi' && action === 'goptzfpos') {
      nativePtz = {
        pan: Number(url.searchParams.get('panpos')),
        tilt: Number(url.searchParams.get('tiltpos')),
        zoom: Number(url.searchParams.get('zoompos')),
      };
      response.setHeader('content-type', 'text/plain');
      response.end('');
      return;
    }
    if (url.pathname === '/cgi-bin/control/ptzf_status.cgi' && action === 'getptzfpos') {
      response.setHeader('content-type', 'text/plain');
      response.end(`panpos = ${nativePtz.pan}\ntiltpos = ${nativePtz.tilt}\nzoompos = ${nativePtz.zoom}\n`);
      return;
    }
    if (url.pathname === '/cgi-bin/image/mjpeg.cgi') {
      response.setHeader('content-type', 'multipart/x-mixed-replace; boundary=cam');
      response.end(
        Buffer.concat([
          Buffer.from('--cam\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n'),
          Buffer.from('abc'),
          Buffer.from('\r\n--cam\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n'),
          Buffer.from('def'),
          Buffer.from('\r\n--cam--\r\n'),
        ]),
      );
      return;
    }
    response.statusCode = 404;
    response.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  host = '127.0.0.1';
  port = address.port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  nativePtz = { pan: 0, tilt: 0, zoom: 1 };
});

const cfg = (override: Partial<CameraSourceConfig> = {}): CameraSourceConfig => ({
  id: 'ptz1',
  kind: 'hucoms',
  host,
  port,
  ptz: { panRange: [0, 35999], tiltRange: [-2000, 9000], zoomRange: [0, 65535] },
  ...override,
});

describe('RealPtzSource — Hucoms HTTP API V1.22', () => {
  it('별도 login CGI 대신 getservername으로 id/passwd를 검증한다', async () => {
    const source = new RealPtzSource(cfg());
    expect(await source.login('admin', 'secret')).toBe(true);
    const login = seen.at(-1)!;
    expect(login.path).toBe('/cgi-bin/control/servername.cgi');
    expect(login.query.get('action')).toBe('getservername');
    expect(login.query.get('id')).toBe('admin');
    expect(login.query.get('passwd')).toBe('secret');
  });

  it('장비 Error 응답이면 login 실패하고 자격증명을 제거한다', async () => {
    const source = new RealPtzSource(cfg());
    expect(await source.login('admin', 'bad')).toBe(false);
  });

  it('snapshot은 /cgi-bin/image/jpeg.cgi의 JPEG Buffer를 반환한다', async () => {
    const source = new RealPtzSource(cfg());
    await source.login('admin', 'pw');
    seen = [];
    const result = await source.snapshot(1, { mode: 'preset' });
    expect(result.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(seen.some((request) => request.path === '/cgi-bin/image/jpeg.cgi')).toBe(true);
    expect(seen.some((request) => request.query.get('action') === 'getptzfpos')).toBe(true);
  });

  it('move는 goptzfpos와 V1.22 원시 좌표·속도를 전송한다', async () => {
    const source = new RealPtzSource(cfg());
    await source.login('admin', 'pw');
    seen = [];
    expect(await source.move(1, { pan: 180, tilt: 90, zoom: 36 })).toBe(true);
    const move = seen.at(-1)!;
    expect(move.path).toBe('/cgi-bin/control/ptzf_status.cgi');
    expect(move.query.get('action')).toBe('goptzfpos');
    expect(move.query.get('panpos')).toBe('35999');
    expect(move.query.get('tiltpos')).toBe('9000');
    expect(move.query.get('zoompos')).toBe('65535');
    expect(move.query.get('panspeed')).toBe('100');
  });

  it('toNativePtz/fromNativePtz가 설정 범위에서 왕복한다', () => {
    const source = new RealPtzSource(cfg());
    for (const ptz of [
      { pan: 0, tilt: 0, zoom: 1 },
      { pan: 90, tilt: 45, zoom: 18 },
      { pan: -180, tilt: -90, zoom: 36 },
      { pan: 180, tilt: 90, zoom: 36 },
    ]) {
      const restored = source.fromNativePtz(source.toNativePtz(ptz));
      expect(restored.pan).toBeCloseTo(ptz.pan, 5);
      expect(restored.tilt).toBeCloseTo(ptz.tilt, 5);
      expect(restored.zoom).toBeCloseTo(ptz.zoom, 5);
    }
  });

  it('V1.22 MJPEG를 CameraSource streamMjpeg로 제공한다', async () => {
    const source = new RealPtzSource(cfg());
    const frames: Buffer[] = [];
    for await (const frame of source.streamMjpeg(1, 1, new AbortController().signal)) frames.push(frame);
    expect(frames).toEqual([Buffer.from('abc'), Buffer.from('def')]);
  });

  it('listCameras는 현장 소스 한 개를 반환한다', async () => {
    const source = new RealPtzSource(cfg());
    const list = await source.listCameras();
    expect(list.cameras).toEqual([{ camIdx: 1, name: 'ptz1', enabled: true, presets: [{ presetIdx: 1, label: '현재 위치' }] }]);
  });

  it('getPtz는 장비 PTZF 위치를 Viewer 좌표계로 반환한다', async () => {
    const source = new RealPtzSource(cfg());
    await source.login('admin', 'pw');
    nativePtz = { pan: 17999, tilt: 3500, zoom: 32767 };
    const ptz = await source.getPtz(1);
    expect(ptz.pan).toBeCloseTo(0, 1);
    expect(ptz.tilt).toBeCloseTo(0, 1);
    expect(ptz.zoom).toBeCloseTo(18.5, 1);
    expect(seen.at(-1)?.query.get('action')).toBe('getptzfpos');
  });

  it('manual snapshot은 PTZ 이동 후 JPEG를 가져온다', async () => {
    const source = new RealPtzSource(cfg());
    await source.login('admin', 'pw');
    seen = [];
    await source.snapshot(1, { mode: 'manual', ptz: { pan: 0, tilt: 0, zoom: 10 } });
    const moveIndex = seen.findIndex((request) => request.query.get('action') === 'goptzfpos');
    const jpegIndex = seen.findIndex((request) => request.path === '/cgi-bin/image/jpeg.cgi');
    expect(moveIndex).toBeGreaterThanOrEqual(0);
    expect(jpegIndex).toBeGreaterThan(moveIndex);
  });
});
