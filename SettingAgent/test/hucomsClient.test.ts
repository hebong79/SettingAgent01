import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  HucomsClient,
  HucomsResponseError,
  HucomsValidationError,
  parseHucomsText,
  parseMultipart,
} from '../src/clients/hucoms/index.js';
import { logger } from '../src/util/logger.js';

let server: Server;
let baseUrl: string;
let seen: URL[];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://camera.local');
    seen.push(url);
    response.setHeader('content-type', 'text/plain');
    if (url.searchParams.get('action') === 'error') response.end('Error: unsupported');
    else response.end('[Result]\nok = yes\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
});

describe('Hucoms parser', () => {
  it('section, key/value, manual 주석을 보존·정리한다', () => {
    const parsed = parseHucomsText('[Version]\nFirmware = 1.22 * current\n');
    expect(parsed.values.Firmware).toBe('1.22');
    expect(parsed.sections.Version.Firmware).toBe('1.22');
  });

  it('buffered multipart payload를 분리한다', () => {
    const body = Buffer.from(
      '--cam\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nabc\r\n' +
        '--cam\r\nContent-Type: text/plain\r\n\r\ndef\r\n--cam--\r\n',
    );
    expect(parseMultipart(body, 'multipart/x-mixed-replace; boundary=cam')).toEqual([
      Buffer.from('abc'),
      Buffer.from('def'),
    ]);
  });
});

describe('HucomsClient', () => {
  it('V1.22 path/action과 id/passwd query를 생성한다', async () => {
    const client = new HucomsClient({ baseUrl, username: 'operator', password: 'secret' });
    const response = await client.getServerName();
    expect(response.values.ok).toBe('yes');
    expect(seen[0].pathname).toBe('/cgi-bin/control/servername.cgi');
    expect(seen[0].searchParams.get('action')).toBe('getservername');
    expect(seen[0].searchParams.get('id')).toBe('operator');
    expect(seen[0].searchParams.get('passwd')).toBe('secret');
  });

  it('통신 로그에서는 passwd를 마스킹한다', async () => {
    const spy = vi.spyOn(logger, 'info');
    await new HucomsClient({ baseUrl, username: 'operator', password: 'plain-secret' }).getMac();
    const packet = spy.mock.calls.find((call) => call[1] === 'Hucoms 통신 패킷')?.[0] as { url?: string };
    expect(packet.url).toContain('passwd=***');
    expect(packet.url).not.toContain('plain-secret');
    spy.mockRestore();
  });

  it('HTTP 200의 Error 본문을 HucomsResponseError로 변환한다', async () => {
    const client = new HucomsClient({ baseUrl });
    await expect(client.request('/custom.cgi', { action: 'error' })).rejects.toBeInstanceOf(HucomsResponseError);
  });

  it('잘못된 값은 네트워크 요청 전에 거부한다', async () => {
    const client = new HucomsClient({ baseUrl });
    expect(() => client.setColor({ bright: 101 })).toThrow(HucomsValidationError);
    expect(seen).toHaveLength(0);
  });

  it('대표 기능군 endpoint를 올바르게 매핑한다', async () => {
    const client = new HucomsClient({ baseUrl });
    await client.setMotion(1, { level: 3, areas: { 1: 1, 18: 0xffffff } });
    expect(seen.at(-1)?.pathname).toBe('/cgi-bin/control/motion.cgi');
    expect(seen.at(-1)?.searchParams.get('motion1.area18')).toBe('16777215');
    await client.setRtsp({ rtspPort: 554, rtpPortStart: 5000, rtpPortEnd: 5999 });
    expect(seen.at(-1)?.searchParams.get('rtpport')).toBe('5000,5999');
    await client.getCapabilitiesPtz();
    expect(seen.at(-1)?.searchParams.get('action')).toBe('getPTZ');
  });

  it('V1.22 공개 함수 전체가 존재한다', () => {
    const client = new HucomsClient({ baseUrl });
    const required = [
      'getServerName', 'setServerName', 'getServerDate', 'setServerDate', 'getMac', 'reboot',
      'factoryReset', 'factoryResetKeepNetwork', 'setWebPort', 'getLanguage', 'setLanguage',
      'getIpConfig', 'setIpConfig', 'getDns', 'setDns', 'getModelName', 'getVersionInfo',
      'getAlarmInput', 'setAlarmInput', 'getAlarmOutput', 'setAlarmOutput', 'getMotion', 'setMotion',
      'getRecordEvent', 'setRecordEvent', 'getDayNight', 'setDayNight', 'getColor', 'setColor',
      'getNightColor', 'setNightColor', 'getImageCapabilities', 'getWhiteBalance', 'setWhiteBalance',
      'getWdr', 'setWdr', 'getEffect', 'setEffect', 'getSlowShutter', 'setSlowShutter',
      'getShutterSpeed', 'setShutterSpeed', 'getDnr', 'setDnr', 'getDefog', 'setDefog',
      'setHttpApi', 'getOsd', 'setOsd', 'getPrivacy', 'setPrivacy', 'getTvOut', 'setTvOut',
      'getVideo', 'setVideo', 'setVideoEncoder', 'getMaxVideoSize', 'getAudio', 'setAudio',
      'getRtsp', 'setRtsp', 'getConnectionInfo', 'getEvents', 'iterEvents', 'setAlarmOutputState',
      'getJpeg', 'iterMjpeg', 'getPtzStatus', 'setPtzStatus', 'resetLens', 'goPtzfPosition',
      'getPtzfPosition', 'movePanTilt', 'onePushFocus', 'moveZoomFocus', 'setPreset', 'goPreset',
      'clearPreset', 'autoPan', 'autoPanCw', 'autoPanCcw', 'centerPtz', 'getSystemInfo1',
      'getSystemInfo2', 'getSystemInfo3', 'getCapabilitiesVideoAll', 'getCapabilitiesVideo',
      'getCapabilitiesVideoCodec', 'getCapabilitiesResolution', 'getCapabilitiesFramerate',
      'getCapabilitiesBitrate', 'getCapabilitiesQuality', 'getCapabilitiesAudioAll',
      'getCapabilitiesAudio', 'getCapabilitiesAudioCodec', 'getCapabilitiesPtzAll', 'getCapabilitiesPtz',
    ];
    for (const name of required) expect(typeof (client as unknown as Record<string, unknown>)[name], name).toBe('function');
  });
});
