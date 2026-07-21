import { logger } from '../../util/logger.js';
import {
  HucomsHttpError,
  HucomsResponseError,
  HucomsStreamError,
  HucomsTransportError,
  HucomsValidationError,
} from './errors.js';
import { multipartBoundary, parseHucomsText, parseMultipart } from './parser.js';
import type {
  AlarmInputOptions,
  AlarmOutputOptions,
  AudioOptions,
  ColorOptions,
  HucomsClientOptions,
  HucomsParam,
  HucomsParams,
  HucomsParsedResponse,
  HucomsRawResponse,
  MotionOptions,
  PtzfPosition,
  RecordEventOptions,
  RtspOptions,
  VideoOptions,
} from './types.js';

const CONTROL = '/cgi-bin/control';
const IMAGE = '/cgi-bin/image';

function range(name: string, value: number, low: number, high: number): number {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new HucomsValidationError(`${name}은(는) ${low}~${high} 정수여야 합니다`);
  }
  return value;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const normalized = value.toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    throw new HucomsValidationError(`${name}은(는) ${allowed.join(', ')} 중 하나여야 합니다`);
  }
  return normalized;
}

function enabled(value: boolean | 'enable' | 'disable'): 'enable' | 'disable' {
  return typeof value === 'boolean' ? (value ? 'enable' : 'disable') : oneOf('status', value, ['enable', 'disable']);
}

function put(target: HucomsParams, key: string, value: HucomsParam): void {
  if (value !== undefined && value !== null) target[key] = typeof value === 'boolean' ? enabled(value) : value;
}

function item(prefix: string, number: number, maximum = 16): string {
  return `${prefix}${range(prefix, number, 1, maximum)}`;
}

function port(name: string, value: number, special: number): number {
  if (value !== special && (value < 3000 || value > 60000 || !Number.isInteger(value))) {
    throw new HucomsValidationError(`${name}은(는) ${special} 또는 3000~60000이어야 합니다`);
  }
  return value;
}

function ipv4(name: string, value: string): string {
  const octets = value.split('.');
  if (
    octets.length !== 4 ||
    octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) < 0 || Number(part) > 255)
  ) {
    throw new HucomsValidationError(`${name}은(는) IPv4 주소여야 합니다`);
  }
  return value;
}

/**
 * Hucoms HTTP API v1.22 전체 기능을 제공하는 Node 20+ 네이티브 클라이언트.
 * 런타임 의존성 없이 fetch를 사용하며, 장비 규격상 id/passwd query 인증을 사용한다.
 */
export class HucomsClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private username: string;
  private password: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HucomsClientOptions) {
    const source = options.baseUrl ?? (options.host ? `http://${options.host}` : undefined);
    if (!source) throw new HucomsValidationError('host 또는 baseUrl이 필요합니다');
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new HucomsValidationError('baseUrl이 올바른 URL이 아닙니다');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new HucomsValidationError('baseUrl은 http 또는 https여야 합니다');
    }
    this.baseUrl = source.replace(/\/+$/, '');
    this.username = options.username ?? 'admin';
    this.password = options.password ?? 'admin';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new HucomsValidationError('timeoutMs는 0보다 커야 합니다');
    }
    this.headers = { accept: 'text/plain, */*', ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** UI 로그인 등에서 받은 자격증명을 프로세스 메모리에만 갱신한다. */
  setCredentials(username: string, password: string): void {
    this.username = username;
    this.password = password;
  }

  clearCredentials(): void {
    this.username = '';
    this.password = '';
  }

  /** 임의의 Hucoms CGI를 호출한다. 모델별 확장 명령에도 사용한다. */
  async request(path: string, params: HucomsParams = {}, timeoutMs = this.timeoutMs): Promise<HucomsParsedResponse> {
    const raw = await this.requestRaw(path, params, timeoutMs);
    const parsed = parseHucomsText(raw.body.toString('utf8'));
    if (parsed.message !== undefined) throw new HucomsResponseError(parsed.message, parsed.rawText);
    return parsed;
  }

  async requestRaw(path: string, params: HucomsParams = {}, timeoutMs = this.timeoutMs): Promise<HucomsRawResponse> {
    // AbortSignal.timeout은 response body 수신이 끝날 때까지 유효하므로 JPEG/긴 text 응답에도 timeout이 적용된다.
    const response = await this.fetchResponse(path, params, { signal: AbortSignal.timeout(timeoutMs) });
    try {
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, statusText: response.statusText, headers: response.headers, body };
    } catch (error) {
      throw new HucomsTransportError(this.safeMessage(error), error);
    }
  }

  private async control(script: string, action?: string, params: HucomsParams = {}): Promise<HucomsParsedResponse> {
    return this.request(`${CONTROL}/${script}.cgi`, action ? { action, ...params } : params);
  }

  private buildUrl(path: string, params: HucomsParams): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalized}`);
    url.searchParams.set('id', this.username);
    url.searchParams.set('passwd', this.password);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private safeUrl(url: string): string {
    const safe = new URL(url);
    if (safe.searchParams.has('passwd')) safe.searchParams.set('passwd', '***');
    return safe.toString();
  }

  private safeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.password ? message.replaceAll(this.password, '***') : message;
  }

  private async fetchResponse(
    path: string,
    params: HucomsParams,
    options: { timeoutMs?: number; signal?: AbortSignal; accept?: string } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, params);
    const controller = options.timeoutMs ? new AbortController() : undefined;
    const onAbort = () => controller?.abort(options.signal?.reason);
    if (controller) options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    const started = Date.now();
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { ...this.headers, ...(options.accept ? { accept: options.accept } : {}) },
        signal: controller?.signal ?? options.signal,
      });
      logger.info(
        { cat: 'packet', method: 'GET', url: this.safeUrl(url), status: response.status, ms: Date.now() - started },
        'Hucoms 통신 패킷',
      );
      if (!response.ok) throw new HucomsHttpError(response.status, response.statusText);
      return response;
    } catch (error) {
      if (error instanceof HucomsHttpError) throw error;
      const message = this.safeMessage(error);
      logger.warn(
        { cat: 'packet', method: 'GET', url: this.safeUrl(url), err: message, ms: Date.now() - started },
        'Hucoms 통신 패킷 실패',
      );
      throw new HucomsTransportError(message, error);
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) options.signal?.removeEventListener('abort', onAbort);
    }
  }

  // System Configuration ---------------------------------------------------------
  getServerName = () => this.control('servername', 'getservername');

  setServerName(name: string): Promise<HucomsParsedResponse> {
    if (!/^[A-Za-z0-9]{1,10}$/.test(name)) throw new HucomsValidationError('서버명은 영문/숫자 1~10자여야 합니다');
    return this.control('servername', 'setservername', { servername: name });
  }

  getServerDate = () => this.control('serverdate', 'getdate');

  setServerDate(value: Date): Promise<HucomsParsedResponse> {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new HucomsValidationError('올바른 Date가 필요합니다');
    return this.control('serverdate', 'setdate', {
      year: range('year', value.getFullYear(), 1970, 2031),
      month: value.getMonth() + 1,
      day: value.getDate(),
      hour: value.getHours(),
      minute: value.getMinutes(),
      second: value.getSeconds(),
    });
  }

  getMac = () => this.control('servermac', 'getmac');
  reboot = () => this.control('reboot', 'setreboot');
  factoryReset = () => this.control('reboot', 'setfactory');
  factoryResetKeepNetwork = () => this.control('reboot', 'setfactoryexip');

  setWebPort(value: number): Promise<HucomsParsedResponse> {
    return this.control('webport', 'setwebport', { webport: port('webport', value, 80) });
  }

  getLanguage = () => this.control('language', 'getlang');

  setLanguage(language: string): Promise<HucomsParsedResponse> {
    return this.control('language', 'setlang', {
      language: oneOf('language', language, ['english', 'korean', 'polish', 'russian', 'persian']),
    });
  }

  getIpConfig = () => this.control('netset', 'getip');

  setIpConfig(options: { mode: 'static' | 'dhcp'; ipAddress?: string; netmask?: string; gateway?: string }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { mode: options.mode };
    if (options.ipAddress) params.ipaddress = ipv4('ipAddress', options.ipAddress);
    if (options.netmask) params.netmask = ipv4('netmask', options.netmask);
    if (options.gateway) params.gateway = ipv4('gateway', options.gateway);
    return this.control('netset', 'setip', params);
  }

  getDns = () => this.control('dnsset', 'getdns');

  setDns(first: string, second?: string): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { firstdns: ipv4('firstdns', first) };
    if (second) params.seconddns = ipv4('seconddns', second);
    return this.control('dnsset', 'setdns', params);
  }

  getModelName = () => this.control('servermodel', 'getservermodel');
  getVersionInfo = () => this.control('versioninfo', 'getversioninfo');

  // Event Configuration ----------------------------------------------------------
  getAlarmInput(number = 1): Promise<HucomsParsedResponse> {
    return this.control('alarmin', `get${item('alarmin', number)}`);
  }

  setAlarmInput(number = 1, options: AlarmInputOptions = {}): Promise<HucomsParsedResponse> {
    const name = item('alarmin', number);
    const params: HucomsParams = { ...(options.extra ?? {}) };
    if (options.allStatus !== undefined) params.allstatus = enabled(options.allStatus);
    if (options.enabled !== undefined) params[`${name}.enable`] = enabled(options.enabled);
    put(params, `${name}.name`, options.name);
    put(params, `${name}.type`, options.inputType);
    return this.control('alarmin', `set${name}`, params);
  }

  getAlarmOutput(number = 0): Promise<HucomsParsedResponse> {
    const name = number === 0 ? 'alarmout0' : item('alarmout', number);
    return this.control('alarmout', `get${name}`);
  }

  setAlarmOutput(number = 1, options: AlarmOutputOptions = {}): Promise<HucomsParsedResponse> {
    const name = item('alarmout', number);
    const params: HucomsParams = { ...(options.extra ?? {}) };
    if (options.allStatus !== undefined) params.allstatus = enabled(options.allStatus);
    if (options.enabled !== undefined) params[`${name}.enable`] = enabled(options.enabled);
    put(params, `${name}.name`, options.name);
    if (options.link !== undefined) params[`${name}.link`] = range('link', options.link, 0, 7);
    if (options.duration !== undefined) {
      if (options.duration !== 1) range('duration', options.duration, 5, 180);
      params[`${name}.time`] = options.duration;
    }
    return this.control('alarmout', `set${name}`, params);
  }

  getMotion(number = 1, size?: string): Promise<HucomsParsedResponse> {
    const name = item('motion', number);
    return this.control('motion', `get${name}`, size ? { [`${name}.size`]: size } : {});
  }

  setMotion(number = 1, options: MotionOptions = {}): Promise<HucomsParsedResponse> {
    const name = item('motion', number);
    const params: HucomsParams = { ...(options.extra ?? {}) };
    if (options.allStatus !== undefined) params.allstatus = enabled(options.allStatus);
    if (options.duration !== undefined) params.mdduration = range('duration', options.duration, 0, 10);
    put(params, 'mdtimeoff', options.timeoff);
    if (options.enabled !== undefined) params[`${name}.enable`] = enabled(options.enabled);
    put(params, `${name}.name`, options.name);
    if (options.level !== undefined) params[`${name}.level`] = range('level', options.level, 1, 5);
    put(params, `${name}.size`, options.size);
    for (const [area, mask] of Object.entries(options.areas ?? {})) {
      params[`${name}.area${range('area', Number(area), 1, 18)}`] = range('area mask', mask, 0, 0xffffff);
    }
    return this.control('motion', `set${name}`, params);
  }

  getRecordEvent = () => this.control('recordevent', 'getrecevent');

  setRecordEvent(options: RecordEventOptions = {}): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}) };
    if (options.status !== undefined) params['record.status'] = enabled(options.status);
    put(params, 'record.streamid', options.streamId);
    if (options.link !== undefined) params['record.link'] = range('link', options.link, 0, 7);
    if (options.save !== undefined) params['record.save'] = range('save', options.save, 0, 3);
    if (options.timePrevious !== undefined) params['record.timeprev'] = range('timePrevious', options.timePrevious, 0, 5);
    if (options.timeNext !== undefined) params['record.timenext'] = range('timeNext', options.timeNext, 5, 30);
    if (options.maxSize !== undefined) params['record.maxsize'] = range('maxSize', options.maxSize, 4096, 10240);
    return this.control('recordevent', 'setrecevent', params);
  }

  // Camera Configuration ---------------------------------------------------------
  getDayNight = () => this.control('camdaynight', 'getdaynight');

  setDayNight(options: { mode: 'day' | 'night' | 'auto' | 'lpr'; interval?: number; ptn?: number; ptd?: number; irlink?: boolean | 'enable' | 'disable'; extra?: HucomsParams }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}), mode: options.mode };
    if (options.interval !== undefined) params.interval = range('interval', options.interval, 1, 200);
    if (options.ptn !== undefined) params.ptn = range('ptn', options.ptn, 1, 990);
    if (options.ptd !== undefined) params.ptd = range('ptd', options.ptd, 1, 990);
    if (options.ptn !== undefined && options.ptd !== undefined && options.ptn < options.ptd) {
      throw new HucomsValidationError('ptn은 ptd보다 크거나 같아야 합니다');
    }
    if (options.irlink !== undefined) params.irlink = enabled(options.irlink);
    return this.control('camdaynight', 'setdaynight', params);
  }

  getColor = () => this.control('camcolor', 'getcolor');
  getNightColor = () => this.control('camcolor', 'getncolor');
  getImageCapabilities = () => this.control('camcolor', 'getCapabilitiesImage');

  setColor(options: ColorOptions = {}, night = false): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}) };
    for (const [key, value] of Object.entries(options)) {
      if (key !== 'extra' && value !== undefined) params[key] = range(key, value as number, 1, 100);
    }
    return this.control('camcolor', night ? 'setncolor' : 'setcolor', params);
  }

  setNightColor = (options: ColorOptions = {}) => this.setColor(options, true);
  getWhiteBalance = () => this.control('camwhitebal', 'getwb');

  setWhiteBalance(options: { mode: string; userRed?: number; userBlue?: number; extra?: HucomsParams }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}), mode: options.mode };
    if (options.userRed !== undefined) params.userred = range('userRed', options.userRed, 1, 100);
    if (options.userBlue !== undefined) params.userblue = range('userBlue', options.userBlue, 1, 100);
    return this.control('camwhitebal', 'setwb', params);
  }

  getWdr = () => this.control('camwdr', 'getwdr');

  setWdr(options: { status: boolean | 'enable' | 'disable'; mode: 'compensation' | 'dwdr'; compensationMode?: 'front' | 'back'; dwdrMode?: string; extra?: HucomsParams }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}), wdrstatus: enabled(options.status), mode: options.mode };
    put(params, 'compensationmode', options.compensationMode);
    put(params, 'dwdrmode', options.dwdrMode);
    return this.control('camwdr', 'setwdr', params);
  }

  getEffect = () => this.control('cameffect', 'geteffect');

  setEffect(options: { colorbar?: boolean | 'enable' | 'disable'; monoImage?: boolean | 'enable' | 'disable'; negative?: boolean | 'enable' | 'disable'; extra?: HucomsParams } = {}): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}) };
    if (options.colorbar !== undefined) params.colorbar = enabled(options.colorbar);
    if (options.monoImage !== undefined) params.monoimg = enabled(options.monoImage);
    if (options.negative !== undefined) params.negative = enabled(options.negative);
    return this.control('cameffect', 'seteffect', params);
  }

  getSlowShutter = () => this.control('camslowshut', 'getslowsh');

  setSlowShutter(status: boolean | 'enable' | 'disable', value: number, extra: HucomsParams = {}): Promise<HucomsParsedResponse> {
    return this.control('camslowshut', 'setslowsh', { ...extra, slowshutstatus: enabled(status), slowshutter: range('slowshutter', value, 1, 100) });
  }

  getShutterSpeed = () => this.control('camshutspeed', 'getshutterspd');

  setShutterSpeed(options: { mode: 'auto' | 'suppressroll' | 'user'; maxExposure?: number; suppress?: 'week' | 'strong'; shutterSpeed?: number; agcValue?: number; extra?: HucomsParams }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}), shutmode: options.mode };
    if (options.maxExposure !== undefined) params.maxexposure = range('maxExposure', options.maxExposure, 1, 6);
    put(params, 'suppress', options.suppress);
    if (options.shutterSpeed !== undefined) params.shutspeed = range('shutterSpeed', options.shutterSpeed, 1, 9);
    if (options.agcValue !== undefined) params.agcvalue = range('agcValue', options.agcValue, 1, 100);
    return this.control('camshutspeed', 'setshutterspd', params);
  }

  getDnr = () => this.control('camdnr', 'getdnr');

  setDnr(options: { status: boolean | 'enable' | 'disable'; mode: 'dnr2d' | 'dnr3d'; value?: number; dynamic?: boolean | 'enable' | 'disable'; extra?: HucomsParams }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}), dnstatus: enabled(options.status), mode: options.mode };
    if (options.value !== undefined) params.dnrvalue = range('dnrvalue', options.value, 1, 100);
    if (options.dynamic !== undefined) params.dynamic = enabled(options.dynamic);
    return this.control('camdnr', 'setdnr', params);
  }

  getDefog = () => this.control('camdefog', 'getdefog');

  setDefog(options: { enabled: boolean | 'enable' | 'disable'; mode: 'auto' | 'manual'; value?: number; extra?: HucomsParams }): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}), defogen: enabled(options.enabled), mode: options.mode };
    if (options.value !== undefined) params.defogvalue = range('defogvalue', options.value, 1, 100);
    return this.control('camdefog', 'setdefog', params);
  }

  // Stream Configuration ---------------------------------------------------------
  setHttpApi = (status: boolean | 'enable' | 'disable') => this.control('httpapi', 'setapi', { apictrlstatus: enabled(status) });
  getOsd = () => this.control('osd', 'getosd');
  setOsd = (params: HucomsParams) => this.control('osd', 'setosd', params);

  getPrivacy(number = 1): Promise<HucomsParsedResponse> {
    return this.control('privacy', `get${item('privacy', number)}`);
  }

  setPrivacy(number: number, params: HucomsParams): Promise<HucomsParsedResponse> {
    return this.control('privacy', `set${item('privacy', number)}`, params);
  }

  getTvOut = () => this.control('tvout', 'gettvout');
  setTvOut = (status: boolean | 'enable' | 'disable', type: 'ntsc' | 'pal', extra: HucomsParams = {}) =>
    this.control('tvout', 'settvout', { ...extra, tvoutstatus: enabled(status), tvtype: type });
  getVideo = () => this.control('videoset', 'getvideo');
  getMaxVideoSize = () => this.control('videoset', 'getmaxsize');

  async setVideo(options: VideoOptions = {}): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}) };
    put(params, 'videoflip', options.videoFlip);
    for (const [numberText, capture] of Object.entries(options.captures ?? {})) {
      const prefix = item('capture', Number(numberText), 3);
      for (const [key, value] of Object.entries(capture)) params[`${prefix}.${key}`] = value;
    }
    const encoderNumbers = Object.keys(options.encoders ?? {}).map(Number);
    for (const [numberText, encoder] of Object.entries(options.encoders ?? {})) {
      const prefix = item('encoder', Number(numberText), 3);
      for (const [key, value] of Object.entries(encoder)) params[`${prefix}.${key}`] = value;
    }
    if (encoderNumbers.length === 0) return this.control('videoset', 'setvideo1', params);
    let response: HucomsParsedResponse | undefined;
    for (const number of encoderNumbers) response = await this.control('videoset', `setvideo${range('encoder', number, 1, 3)}`, params);
    return response!;
  }

  setVideoEncoder(number: number, fields: HucomsParams): Promise<HucomsParsedResponse> {
    const prefix = item('encoder', number, 3);
    return this.control(
      'videoset',
      `setvideo${number}`,
      Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${prefix}.${key}`, value])),
    );
  }

  getAudio = () => this.control('audioset', 'getaudio');

  setAudio(options: AudioOptions = {}): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}) };
    put(params, 'audiocodec', options.codec);
    if (options.inputEnabled !== undefined) params.audioinenable = enabled(options.inputEnabled);
    if (options.inputGain !== undefined) params.audioingain = range('inputGain', options.inputGain, 1, 100);
    if (options.outputEnabled !== undefined) params.audiooutenable = enabled(options.outputEnabled);
    if (options.outputGain !== undefined) params.audiooutgain = range('outputGain', options.outputGain, 1, 100);
    put(params, 'audiosampling', options.sampling);
    return this.control('audioset', 'setaudio', params);
  }

  getRtsp = () => this.control('rtspset', 'getrtsp');

  setRtsp(options: RtspOptions = {}): Promise<HucomsParsedResponse> {
    const params: HucomsParams = { ...(options.extra ?? {}) };
    if (options.rtspPort !== undefined) params.rtspport = port('rtspPort', options.rtspPort, 554);
    if (options.rtpPortStart !== undefined || options.rtpPortEnd !== undefined) {
      if (options.rtpPortStart === undefined || options.rtpPortEnd === undefined) {
        throw new HucomsValidationError('rtpPortStart와 rtpPortEnd를 함께 지정해야 합니다');
      }
      params.rtpport = `${port('rtpPortStart', options.rtpPortStart, -1)},${port('rtpPortEnd', options.rtpPortEnd, -1)}`;
    }
    if (options.rtcpEnabled !== undefined) params.rtcpenable = enabled(options.rtcpEnabled);
    if (options.timeLimit !== undefined) {
      if (options.timeLimit !== 0 && (options.timeLimit < 60 || options.timeLimit > 300)) {
        throw new HucomsValidationError('timeLimit은 0 또는 60~300이어야 합니다');
      }
      params.rtsptimelimit = options.timeLimit;
    }
    if (options.multicastEnabled !== undefined) params.multicastenable = enabled(options.multicastEnabled);
    if (options.multicastTtl !== undefined) params.multicastttl = range('multicastTtl', options.multicastTtl, 1, 128);
    put(params, 'multicastvideoip', options.multicastVideoIp ? ipv4('multicastVideoIp', options.multicastVideoIp) : undefined);
    if (options.multicastVideoPort !== undefined) params.multicastvideoport = port('multicastVideoPort', options.multicastVideoPort, -1);
    put(params, 'multicastaudioip', options.multicastAudioIp ? ipv4('multicastAudioIp', options.multicastAudioIp) : undefined);
    if (options.multicastAudioPort !== undefined) params.multicastaudioport = port('multicastAudioPort', options.multicastAudioPort, -1);
    if (options.authorityEnabled !== undefined) params.authorityenable = enabled(options.authorityEnabled);
    return this.control('rtspset', 'setrtsp', params);
  }

  getConnectionInfo(stream: 'all' | 'stream1' | 'stream2' | 'stream3' = 'all') {
    return this.control('connectinfo', 'getconnect', { stream });
  }

  // Events, Relay, Image ---------------------------------------------------------
  async getEvents(eventType = 'all'): Promise<HucomsParsedResponse[]> {
    const raw = await this.requestRaw(`${CONTROL}/requestevent.cgi`, { action: 'getevent', eventtype: eventType });
    const contentType = raw.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart')) {
      const parsed = parseHucomsText(raw.body.toString('utf8'));
      if (parsed.message !== undefined) throw new HucomsResponseError(parsed.message, parsed.rawText);
      return [parsed];
    }
    return parseMultipart(raw.body, contentType).map((part) => parseHucomsText(part.toString('utf8')));
  }

  async *iterEvents(eventType = 'all', signal?: AbortSignal): AsyncGenerator<HucomsParsedResponse> {
    for await (const part of this.iterMultipart(`${CONTROL}/requestevent.cgi`, { action: 'getevent', eventtype: eventType }, signal)) {
      const parsed = parseHucomsText(part.toString('utf8'));
      if (parsed.message !== undefined) throw new HucomsResponseError(parsed.message, parsed.rawText);
      yield parsed;
    }
  }

  setAlarmOutputState(number = 1, state: 'on' | 'off' = 'off') {
    return this.control('ctrl_alarmout', 'setalarmout', { [item('alarmout', number)]: state });
  }

  async getJpeg(): Promise<Buffer> {
    const raw = await this.requestRaw(`${IMAGE}/jpeg.cgi`);
    const contentType = raw.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('image/')) {
      const parsed = parseHucomsText(raw.body.toString('utf8'));
      if (parsed.message !== undefined) throw new HucomsResponseError(parsed.message, parsed.rawText);
    }
    return raw.body;
  }

  iterMjpeg(options: { source?: 'input1' | 'input2'; refresh?: number; signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {
    const params: HucomsParams = {};
    put(params, 'source', options.source);
    if (options.refresh !== undefined) params.refresh = range('refresh', options.refresh, 0, 300);
    return this.iterMultipart(`${IMAGE}/mjpeg.cgi`, params, options.signal);
  }

  private async *iterMultipart(path: string, params: HucomsParams, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.fetchResponse(path, params, {
      signal,
      accept: 'multipart/x-mixed-replace, text/plain',
    });
    if (!response.body) throw new HucomsStreamError('multipart 응답 body가 없습니다');
    const marker = Buffer.from(`--${multipartBoundary(response.headers.get('content-type') ?? '')}`);
    const reader = response.body.getReader();
    let buffer = Buffer.alloc(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
        for (;;) {
          const boundaryAt = buffer.indexOf(marker);
          if (boundaryAt < 0) {
            if (buffer.length > marker.length) buffer = buffer.subarray(buffer.length - marker.length);
            break;
          }
          let start = boundaryAt + marker.length;
          if (buffer.subarray(start, start + 2).equals(Buffer.from('--'))) return;
          if (buffer.subarray(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
          else if (buffer[start] === 0x0a) start += 1;
          let headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
          let separatorLength = 4;
          if (headerEnd < 0) {
            headerEnd = buffer.indexOf(Buffer.from('\n\n'), start);
            separatorLength = 2;
          }
          if (headerEnd < 0) break;
          const headers = buffer.subarray(start, headerEnd).toString('latin1');
          const payloadStart = headerEnd + separatorLength;
          const lengthMatch = /^content-length\s*:\s*(\d+)\s*$/im.exec(headers);
          if (lengthMatch) {
            const length = Number(lengthMatch[1]);
            if (buffer.length < payloadStart + length) break;
            yield buffer.subarray(payloadStart, payloadStart + length);
            buffer = buffer.subarray(payloadStart + length);
          } else {
            const next = buffer.indexOf(marker, payloadStart);
            if (next < 0) break;
            let end = next;
            while (end > payloadStart && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
            yield buffer.subarray(payloadStart, end);
            buffer = buffer.subarray(next);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  // PTZ -------------------------------------------------------------------------
  getPtzStatus = () => this.control('ptzf_status', 'getptzstatus');

  setPtzStatus(options: { panTilt?: boolean | 'enable' | 'disable'; zoomFocus?: boolean | 'enable' | 'disable' }) {
    const params: HucomsParams = {};
    if (options.panTilt !== undefined) params.ptstatus = enabled(options.panTilt);
    if (options.zoomFocus !== undefined) params.zfstatus = enabled(options.zoomFocus);
    return this.control('ptzf_status', 'setptzstatus', params);
  }

  resetLens = () => this.control('ptzf_status', 'lensreset');

  goPtzfPosition(position: PtzfPosition): Promise<HucomsParsedResponse> {
    const params: HucomsParams = {};
    if (position.pan !== undefined) params.panpos = range('pan', position.pan, 0, 35999);
    if (position.tilt !== undefined) params.tiltpos = range('tilt', position.tilt, -2000, 9000);
    if (position.zoom !== undefined) params.zoompos = range('zoom', position.zoom, 0, 65535);
    if (position.focus !== undefined) params.focuspos = range('focus', position.focus, 0, 65535);
    params.panspeed = range('panSpeed', position.panSpeed ?? 0, 0, 100);
    params.tiltspeed = range('tiltSpeed', position.tiltSpeed ?? 0, 0, 100);
    params.zoomspeed = range('zoomSpeed', position.zoomSpeed ?? 0, 0, 100);
    params.focusspeed = range('focusSpeed', position.focusSpeed ?? 0, 0, 100);
    return this.control('ptzf_status', 'goptzfpos', params);
  }

  getPtzfPosition = () => this.control('ptzf_status', 'getptzfpos');

  movePanTilt(options: { pan?: 'right' | 'left' | 'stop'; tilt?: 'up' | 'down' | 'stop'; panSpeed?: number; tiltSpeed?: number }) {
    const params: HucomsParams = {};
    put(params, 'pan', options.pan);
    put(params, 'tilt', options.tilt);
    if (options.panSpeed !== undefined) params.panspeed = range('panSpeed', options.panSpeed, 1, 100);
    if (options.tiltSpeed !== undefined) params.tiltspeed = range('tiltSpeed', options.tiltSpeed, 1, 100);
    return this.control('pt_control', 'setptmove', params);
  }

  onePushFocus = () => this.control('zf_control', 'onepush');

  moveZoomFocus(options: { zoom?: 'in' | 'out' | 'stop'; focus?: 'in' | 'out' | 'stop'; zoomSpeed?: number; focusSpeed?: number }) {
    const params: HucomsParams = {};
    put(params, 'zoom', options.zoom);
    put(params, 'focus', options.focus);
    if (options.zoomSpeed !== undefined) params.zoomspeed = range('zoomSpeed', options.zoomSpeed, 1, 100);
    if (options.focusSpeed !== undefined) params.focusspeed = range('focusSpeed', options.focusSpeed, 1, 100);
    return this.control('zf_control', 'setzfmove', params);
  }

  setPreset = (number: number) => this.control('preset_control', 'setpreset', { number: range('preset', number, 1, 255) });
  goPreset = (number: number) => this.control('preset_control', 'gopreset', { number: range('preset', number, 1, 255) });
  clearPreset = (number: number) => this.control('preset_control', 'clearpreset', { number: range('preset', number, 1, 255) });
  autoPan = (pointA: number, pointB: number, speed: number) => this.control('preset_control', 'autopan', { pos_a: range('pointA', pointA, 1, 255), pos_b: range('pointB', pointB, 1, 255), speed: range('speed', speed, 1, 255) });
  autoPanCw = (speed: number) => this.control('preset_control', 'autopan_cw', { speed: range('speed', speed, 1, 255) });
  autoPanCcw = (speed: number) => this.control('preset_control', 'autopan_ccw', { speed: range('speed', speed, 1, 255) });

  centerPtz(options: { type: 'box'; startX: number; startY: number; endX: number; endY: number; speed?: number } | { type: 'point'; pointX: number; pointY: number; speed?: number }) {
    const params: HucomsParams = { type: options.type };
    if (options.speed !== undefined) params.speed = range('speed', options.speed, 1, 100);
    if (options.type === 'box') {
      if (options.startX > options.endX || options.startY > options.endY) throw new HucomsValidationError('시작 좌표는 끝 좌표보다 클 수 없습니다');
      params['center.startx'] = range('startX', options.startX, 0, 1920);
      params['center.starty'] = range('startY', options.startY, 0, 1080);
      params['center.endx'] = range('endX', options.endX, 0, 1920);
      params['center.endy'] = range('endY', options.endY, 0, 1080);
    } else {
      params['center.pointx'] = range('pointX', options.pointX, 0, 1920);
      params['center.pointy'] = range('pointY', options.pointY, 0, 1080);
    }
    return this.control('ptz_centering', 'setcenter', params);
  }

  // Unified Command / Capabilities ----------------------------------------------
  getSystemInfo1 = () => this.control('serverinfo1', 'getsysinfo1');
  getSystemInfo2 = () => this.control('serverinfo2', 'getsysinfo2');
  getSystemInfo3 = () => this.control('serverinfo3', 'getsysinfo3');
  getCapabilitiesVideoAll = () => this.control('capabilityvideo', 'getCapabilitiesVideoAll');
  getCapabilitiesVideo = () => this.control('capabilityvideo', 'getVideo');
  getCapabilitiesVideoCodec = () => this.control('capabilityvideo', 'getVideoCodec');
  getCapabilitiesResolution = () => this.control('capabilityvideo', 'getResolution');
  getCapabilitiesFramerate = () => this.control('capabilityvideo', 'getFramerate');
  getCapabilitiesBitrate = () => this.control('capabilityvideo', 'getBitrate');
  getCapabilitiesQuality = () => this.control('capabilityvideo', 'getQuality');
  getCapabilitiesAudioAll = () => this.control('capabilityaudio', 'getCapabilitiesAudioAll');
  getCapabilitiesAudio = () => this.control('capabilityaudio', 'getAudio');
  getCapabilitiesAudioCodec = () => this.control('capabilityaudio', 'getAudioCodec');
  getCapabilitiesPtzAll = () => this.control('capabilityptz', 'getCapabilitiesPTZAll');
  getCapabilitiesPtz = () => this.control('capabilityptz', 'getPTZ');
}
