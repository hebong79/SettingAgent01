import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { OnvifError, OnvifPtzClient } from '../src/clients/onvif/OnvifPtzClient.js';

/**
 * ONVIF 프리셋 조회 클라이언트.
 *
 * 검증 대상은 셋이다:
 *  ① WS-Security UsernameToken **PasswordDigest 계산식**(= base64(sha1(nonce+created+password))) —
 *    틀리면 장비가 401/Fault 를 준다. nonce·시각을 주입해 값 자체를 대조한다.
 *  ② GetProfiles → GetPresets 2단 흐름과 **프로파일 토큰 캐시**(재조회 시 왕복 1회).
 *  ③ 서비스 경로 후보 순회(장비마다 /onvif/device_service · /onvif/ptz_service 등으로 다르다).
 */

const PROFILES = '<Envelope><Body><trt:GetProfilesResponse>' +
  '<trt:Profiles token="Profile1" fixed="true"><tt:Name>Profile1</tt:Name></trt:Profiles>' +
  '<trt:Profiles token="Profile2"><tt:Name>Profile2</tt:Name></trt:Profiles>' +
  '</trt:GetProfilesResponse></Body></Envelope>';

const PRESETS = '<Envelope><Body><tptz:GetPresetsResponse>' +
  '<tptz:Preset token="001"><tt:Name>EV1\n</tt:Name></tptz:Preset>' +
  '<tptz:Preset token="021"><tt:Name>\n21</tt:Name></tptz:Preset>' +
  '</tptz:GetPresetsResponse></Body></Envelope>';

interface Call { url: string; body: string }

/** url → 응답 본문을 정하는 fetch 스텁. 요청은 전부 기록한다. */
function stubFetch(respond: (url: string, body: string) => { status?: number; text: string }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    const body = String((init as { body?: unknown })?.body ?? '');
    calls.push({ url: u, body });
    const r = respond(u, body);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => r.text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const FIXED_NONCE = Buffer.from('0123456789abcdef', 'utf8');
const FIXED_TIME = new Date('2026-07-30T12:34:56.789Z');

function mkClient(fetchImpl: typeof fetch, over: Partial<{ password: string }> = {}) {
  return new OnvifPtzClient({
    baseUrl: 'http://192.168.0.153:80/',
    username: 'admin',
    password: over.password ?? 'secret',
    fetchImpl,
    nonce: () => FIXED_NONCE,
    now: () => FIXED_TIME,
  });
}

describe('OnvifPtzClient — 장비 프리셋 조회', () => {
  it('GetProfiles → GetPresets 로 목록을 읽고 미설정 슬롯을 뺀다', async () => {
    const { calls, fetchImpl } = stubFetch((_u, body) => ({ text: body.includes('GetProfiles') ? PROFILES : PRESETS }));
    const presets = await mkClient(fetchImpl).getPresets();

    expect(presets).toEqual([{ token: '001', name: 'EV1', number: 1 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain('GetProfiles');
    expect(calls[1].body).toContain('<ProfileToken>Profile1</ProfileToken>'); // 첫 프로파일을 쓴다.
    expect(calls[0].url).toBe('http://192.168.0.153:80/onvif/device_service'); // baseUrl 끝 슬래시 정규화.
  });

  it('PasswordDigest = base64(sha1(nonce + created + password)) 를 정확히 싣는다', async () => {
    const { calls, fetchImpl } = stubFetch((_u, body) => ({ text: body.includes('GetProfiles') ? PROFILES : PRESETS }));
    await mkClient(fetchImpl).getPresets();

    const created = '2026-07-30T12:34:56Z'; // 밀리초는 떼고 보낸다(장비 호환).
    const expected = createHash('sha1')
      .update(Buffer.concat([FIXED_NONCE, Buffer.from(created, 'utf8'), Buffer.from('secret', 'utf8')]))
      .digest('base64');
    expect(calls[0].body).toContain(`<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${expected}</Password>`);
    expect(calls[0].body).toContain(`<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${FIXED_NONCE.toString('base64')}</Nonce>`);
    expect(calls[0].body).toContain(`>${created}</Created>`);
    expect(calls[0].body).toContain('<Username>admin</Username>');
    expect(calls[0].body).not.toContain('secret'); // 평문 비밀번호는 나가지 않는다.
  });

  it('두 번째 조회는 프로파일 토큰을 캐시해 왕복 1회만 한다', async () => {
    const { calls, fetchImpl } = stubFetch((_u, body) => ({ text: body.includes('GetProfiles') ? PROFILES : PRESETS }));
    const client = mkClient(fetchImpl);
    await client.getPresets();
    await client.getPresets();
    expect(calls).toHaveLength(3);
    expect(calls[2].body).toContain('GetPresets');
  });

  it('첫 서비스 경로가 404 면 다음 후보로 넘어가고, 성공 경로를 기억한다', async () => {
    const { calls, fetchImpl } = stubFetch((url, body) => {
      if (url.endsWith('/onvif/device_service')) return { status: 404, text: 'not found' };
      return { text: body.includes('GetProfiles') ? PROFILES : PRESETS };
    });
    const client = mkClient(fetchImpl);
    expect(await client.getPresets()).toHaveLength(1);
    await client.getPresets();
    // 1차: device_service(404) → ptz_service(성공). 2차: 기억한 ptz_service 만.
    expect(calls.map((c) => c.url.replace('http://192.168.0.153:80', ''))).toEqual([
      '/onvif/device_service',
      '/onvif/ptz_service',
      '/onvif/ptz_service',
      '/onvif/ptz_service',
    ]);
  });

  it('SOAP Fault 는 사유를 담은 OnvifError 로 올린다(빈 목록으로 위장하지 않는다)', async () => {
    const fault = '<Envelope><Body><SOAP-ENV:Fault><SOAP-ENV:Reason>' +
      '<SOAP-ENV:Text>Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault></Body></Envelope>';
    const { calls, fetchImpl } = stubFetch(() => ({ text: fault }));
    await expect(mkClient(fetchImpl).getPresets()).rejects.toThrow(/Sender not Authorized/);
    await expect(mkClient(fetchImpl).getPresets()).rejects.toBeInstanceOf(OnvifError);
    // 장비가 SOAP 으로 거부한 것은 경로 문제가 아니다 → 클라이언트당 **1회**만 두드린다(인증 반복 실패 방지).
    expect(calls).toHaveLength(2);
  });

  it('GetProfiles 에 프로파일이 없으면 명시적으로 실패한다', async () => {
    const { fetchImpl } = stubFetch(() => ({ text: '<Envelope><Body><trt:GetProfilesResponse/></Body></Envelope>' }));
    await expect(mkClient(fetchImpl).getPresets()).rejects.toThrow(/프로파일/);
  });

  it('네트워크 예외는 OnvifError 로 정규화한다', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(mkClient(fetchImpl).getPresets()).rejects.toThrow(/ECONNREFUSED/);
  });
});
