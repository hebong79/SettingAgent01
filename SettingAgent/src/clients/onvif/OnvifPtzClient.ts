// ONVIF PTZ 프리셋 **조회 전용** 최소 클라이언트.
//
// 범위를 의도적으로 좁게 잡았다: `GetProfiles`(프로파일 토큰 1회) + `GetPresets`(목록) 둘뿐이다.
// 프리셋 **이동**은 이 클라이언트가 하지 않는다 — 이미 실카에서 검증된 Hucoms `gopreset` 경로를 쓴다
// (정착 대기·PTZ 실측·로그가 전부 그 경로에 붙어 있다. 이동 경로를 둘로 늘리지 않는다).
//
// 의존성 0: SOAP 은 문자열 조립, XML 은 정규식 파싱(HucomsClient 가 CGI 텍스트를 손수 파싱하는 것과 같은 방침),
// 인증은 WS-Security UsernameToken(PasswordDigest) = base64(sha1(nonce + created + password)) — node:crypto 만 쓴다.

import { createHash, randomBytes } from 'node:crypto';
import { logPacket } from '../../util/packetLog.js';
import { parsePresetsXml, parseSoapFault, type DevicePreset } from './presetParse.js';

/** ONVIF 서비스 경로 후보. 장비마다 다르므로 성공한 것을 기억해 이후 재사용한다. */
const SERVICE_PATHS = ['/onvif/device_service', '/onvif/ptz_service', '/onvif/services'] as const;

const PTZ_NS = 'http://www.onvif.org/ver20/ptz/wsdl';
const MEDIA_NS = 'http://www.onvif.org/ver10/media/wsdl';

export class OnvifError extends Error {
  /**
   * true = **장비가 SOAP 으로 답한 거부**(인증 실패 등). 경로를 바꿔도 결과가 같으므로 즉시 포기한다.
   * (인증 실패를 경로 수만큼 반복하면 계정 잠금 정책이 있는 장비에서 해롭다.)
   */
  readonly definitive: boolean;

  constructor(message: string, options: { cause?: unknown; definitive?: boolean } = {}) {
    super(message);
    this.name = 'OnvifError';
    this.cause = options.cause;
    this.definitive = options.definitive ?? false;
  }
}

export interface OnvifPtzClientOptions {
  /** 장비 HTTP 주소(Hucoms 와 동일). 예: `http://192.168.0.153:80` */
  baseUrl: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 테스트 주입구(고정 nonce/시각). 미주입 시 crypto 난수 + 현재 시각. */
  nonce?: () => Buffer;
  now?: () => Date;
}

export class OnvifPtzClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nonce: () => Buffer;
  private readonly now: () => Date;
  /** 성공한 서비스 경로·프로파일 토큰 캐시(목록 재조회 때 왕복 1회로 줄인다). */
  private servicePath?: string;
  private profileToken?: string;

  constructor(options: OnvifPtzClientOptions) {
    if (!options.baseUrl) throw new OnvifError('ONVIF baseUrl 이 필요합니다');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.username = options.username ?? '';
    this.password = options.password ?? '';
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nonce = options.nonce ?? (() => randomBytes(16));
    this.now = options.now ?? (() => new Date());
  }

  /** 장비에 저장된 프리셋 목록(미설정 슬롯 제외). */
  async getPresets(): Promise<DevicePreset[]> {
    const token = await this.ensureProfileToken();
    const xml = await this.call(
      `<GetPresets xmlns="${PTZ_NS}"><ProfileToken>${escapeXml(token)}</ProfileToken></GetPresets>`,
      'GetPresets',
    );
    return parsePresetsXml(xml);
  }

  /** 미디어 프로파일 토큰(첫 프로파일). 한 번 구하면 캐시한다. */
  private async ensureProfileToken(): Promise<string> {
    if (this.profileToken) return this.profileToken;
    const xml = await this.call(`<GetProfiles xmlns="${MEDIA_NS}"/>`, 'GetProfiles');
    const token = /<(?:[\w.-]+:)?Profiles\b[^>]*\btoken\s*=\s*"([^"]+)"/.exec(xml)?.[1];
    if (!token) throw new OnvifError('ONVIF 미디어 프로파일을 찾지 못했습니다(GetProfiles 응답에 token 없음)');
    this.profileToken = token;
    return token;
  }

  /**
   * SOAP 1.2 호출. 서비스 경로를 아직 모르면 후보를 순서대로 시도하고 성공한 경로를 기억한다.
   * 실패는 전부 OnvifError 로 정규화한다(호출측이 502/501 로 강등할 수 있게).
   */
  private async call(body: string, op: string): Promise<string> {
    const paths = this.servicePath ? [this.servicePath] : SERVICE_PATHS;
    let lastError: unknown;
    for (const path of paths) {
      try {
        const xml = await this.post(path, body, op);
        const fault = parseSoapFault(xml);
        if (fault) throw new OnvifError(`ONVIF ${op} 거부: ${fault}`, { definitive: true });
        this.servicePath = path;
        return xml;
      } catch (error) {
        // 장비가 SOAP 으로 거부한 것은 경로 문제가 아니다 — 다른 후보를 두드리지 않는다.
        if (error instanceof OnvifError && error.definitive) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof OnvifError
      ? lastError
      : new OnvifError(`ONVIF ${op} 실패: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { cause: lastError });
  }

  private async post(path: string, body: string, op: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const started = Date.now();
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
        body: this.envelope(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      logPacket({ method: 'POST', url, op, status: response.status, ms: Date.now() - started, msgBase: 'ONVIF 통신 패킷' });
      if (!response.ok) {
        // 장비는 인증 실패도 400/401 + Fault 본문으로 준다 — 사유를 그대로 올린다.
        const fault = parseSoapFault(text);
        // 401/400 + Fault = 장비의 명시적 거부(자격증명·미지원). 경로를 바꿔도 같으므로 즉시 포기한다.
        throw new OnvifError(`ONVIF ${op} HTTP ${response.status}${fault ? `: ${fault}` : ''}`, { definitive: fault !== undefined });
      }
      return text;
    } catch (error) {
      if (error instanceof OnvifError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logPacket({ method: 'POST', url, op, err: message, ms: Date.now() - started, msgBase: 'ONVIF 통신 패킷' });
      throw new OnvifError(`ONVIF ${op} 실패: ${message}`, { cause: error });
    }
  }

  /** WS-Security UsernameToken(PasswordDigest) 헤더를 붙인 SOAP 1.2 봉투. */
  private envelope(body: string): string {
    const nonce = this.nonce();
    const created = this.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digest = createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(this.password, 'utf8')]))
      .digest('base64');
    const wsse = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
    const wsu = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
    const type = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
    const encoding = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
      `<s:Header><Security s:mustUnderstand="1" xmlns="${wsse}"><UsernameToken>` +
      `<Username>${escapeXml(this.username)}</Username>` +
      `<Password Type="${type}">${digest}</Password>` +
      `<Nonce EncodingType="${encoding}">${nonce.toString('base64')}</Nonce>` +
      `<Created xmlns="${wsu}">${created}</Created>` +
      '</UsernameToken></Security></s:Header>' +
      `<s:Body>${body}</s:Body></s:Envelope>`
    );
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
