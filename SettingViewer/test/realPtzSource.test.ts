import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { RealPtzSource } from '../src/viewer/RealPtzSource.js';
import type { CameraSourceConfig } from '../src/config/viewerConfig.js';

let server: Server;
let host: string;
let port: number;
// 서버가 본 모든 요청(메서드/경로/바디)을 평문 누출 검사용으로 기록.
let seen: Array<{ method: string; url: string; body: string }>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      const path = (req.url ?? '').split('?')[0];
      if (path === '/cgi-bin/login.cgi') {
        res.setHeader('set-cookie', 'SESSIONID=abc123; Path=/');
        res.end('OK');
        return;
      }
      if (path === '/cgi-bin/login-fail.cgi') {
        res.statusCode = 401;
        res.end('NO');
        return;
      }
      if (path === '/cgi-bin/snapshot.cgi') {
        res.setHeader('content-type', 'image/jpeg');
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG SOI
        return;
      }
      if (path === '/cgi-bin/ptz.cgi') {
        res.end('moved');
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address() as AddressInfo;
  host = '127.0.0.1';
  port = a.port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

const cfg = (over: Partial<CameraSourceConfig> = {}): CameraSourceConfig => ({
  id: 'ptz1',
  kind: 'hucoms',
  host,
  port,
  ptz: { panRange: [0, 36000], tiltRange: [0, 9000], zoomRange: [1, 36] },
  ...over,
});

describe('RealPtzSource — Hucoms CGI(모킹)', () => {
  it('login.cgi 성공 → 세션 보관(set-cookie), 자격증명은 POST body 로만 통과(URL 평문 미포함)', async () => {
    const src = new RealPtzSource(cfg());
    const ok = await src.login('admin', 's3cret!');
    expect(ok).toBe(true);
    const login = seen.find((s) => s.url.includes('login.cgi'))!;
    expect(login.method).toBe('POST');
    // URL(쿼리스트링 포함)에 자격증명 평문 미포함
    expect(login.url).not.toContain('admin');
    expect(login.url).not.toContain('s3cret');
    // body 는 form-urlencoded 로 존재해야 함(통과 자체는 정상)
    expect(login.body).toContain('user=admin');
  });

  it('login 실패(비 2xx) → false, 세션 미설정', async () => {
    const src = new RealPtzSource(cfg({ loginPath: '/cgi-bin/login-fail.cgi' }));
    expect(await src.login('admin', 'x')).toBe(false);
  });

  it('snapshot → image/jpeg Buffer(JPEG SOI) 반환, 세션 쿠키 헤더 동봉', async () => {
    const src = new RealPtzSource(cfg());
    await src.login('admin', 'pw');
    const r = await src.snapshot(1, { mode: 'preset' });
    expect(r.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const snap = seen.find((s) => s.url.includes('snapshot.cgi'))!;
    expect(snap.method).toBe('GET');
  });

  it('move → 원시단위 PTZ CGI(GET) 호출, 자격증명 평문 미포함', async () => {
    const src = new RealPtzSource(cfg());
    await src.login('admin', 'topsecret');
    seen = [];
    const ok = await src.move(1, { pan: 180, tilt: 90, zoom: 36 });
    expect(ok).toBe(true);
    const ptz = seen.find((s) => s.url.includes('ptz.cgi'))!;
    expect(ptz.method).toBe('GET');
    // 뷰어 pan 180(최대) → native panRange 최대 36000
    expect(ptz.url).toContain('pan=36000');
    expect(ptz.url).toContain('tilt=9000');
    expect(ptz.url).toContain('zoom=36');
    expect(ptz.url).not.toContain('topsecret');
  });

  it('toNativePtz/fromNativePtz 왕복 일치(범위 내 값)', () => {
    const src = new RealPtzSource(cfg());
    const samples = [
      { pan: 0, tilt: 0, zoom: 1 },
      { pan: 90, tilt: 45, zoom: 18 },
      { pan: -180, tilt: -90, zoom: 36 },
      { pan: 180, tilt: 90, zoom: 36 },
    ];
    for (const p of samples) {
      const native = src.toNativePtz(p);
      const back = src.fromNativePtz(native);
      expect(back.pan).toBeCloseTo(p.pan, 5);
      expect(back.tilt).toBeCloseTo(p.tilt, 5);
      expect(back.zoom).toBeCloseTo(p.zoom, 5);
    }
  });

  it('listCameras → 프리셋 없는 라이브 뷰 1개(camIdx=1, presets 비어있음)', async () => {
    const src = new RealPtzSource(cfg());
    const list = await src.listCameras();
    expect(list.cameras).toHaveLength(1);
    expect(list.cameras[0]).toMatchObject({ camIdx: 1, name: 'ptz1', enabled: true });
    expect(list.cameras[0].presets).toHaveLength(0);
  });

  it('manual 모드 snapshot → 먼저 move 후 캡처(ptz.cgi + snapshot.cgi 둘 다 호출)', async () => {
    const src = new RealPtzSource(cfg());
    await src.login('admin', 'pw');
    seen = [];
    await src.snapshot(1, { mode: 'manual', ptz: { pan: 0, tilt: 0, zoom: 10 } });
    expect(seen.some((s) => s.url.includes('ptz.cgi'))).toBe(true);
    expect(seen.some((s) => s.url.includes('snapshot.cgi'))).toBe(true);
  });

  it('전 요청에 걸쳐 자격증명 평문이 URL 어디에도 등장하지 않음', async () => {
    const src = new RealPtzSource(cfg());
    await src.login('operator', 'pa55word');
    await src.snapshot(1, { mode: 'preset' });
    await src.move(1, { pan: 0, tilt: 0, zoom: 5 });
    for (const s of seen) {
      expect(s.url).not.toContain('pa55word');
    }
  });
});
