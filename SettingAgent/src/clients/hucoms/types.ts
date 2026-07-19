export type HucomsParam = string | number | boolean | null | undefined;
export type HucomsParams = Record<string, HucomsParam>;

export interface HucomsClientOptions {
  host?: string;
  baseUrl?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** Hucoms text/plain 응답. 원문과 section을 함께 보존한다. */
export interface HucomsParsedResponse {
  values: Record<string, string>;
  sections: Record<string, Record<string, string>>;
  rawText: string;
  message?: string;
}

export interface HucomsRawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

export interface AlarmInputOptions {
  allStatus?: boolean | 'enable' | 'disable';
  enabled?: boolean | 'enable' | 'disable';
  name?: string;
  inputType?: 'nc' | 'no';
  extra?: HucomsParams;
}

export interface AlarmOutputOptions {
  allStatus?: boolean | 'enable' | 'disable';
  enabled?: boolean | 'enable' | 'disable';
  name?: string;
  link?: number;
  duration?: number;
  extra?: HucomsParams;
}

export interface MotionOptions {
  allStatus?: boolean | 'enable' | 'disable';
  duration?: number;
  timeoff?: 1 | 2;
  enabled?: boolean | 'enable' | 'disable';
  name?: string;
  level?: number;
  size?: string;
  areas?: Record<number, number>;
  extra?: HucomsParams;
}

export interface RecordEventOptions {
  status?: boolean | 'enable' | 'disable';
  streamId?: 'stream1' | 'stream2' | 'stream3';
  link?: number;
  save?: number;
  timePrevious?: number;
  timeNext?: number;
  maxSize?: number;
  extra?: HucomsParams;
}

export interface ColorOptions {
  bright?: number;
  contrast?: number;
  saturation?: number;
  sharp?: number;
  edge?: number;
  hue?: number;
  extra?: HucomsParams;
}

export interface VideoOptions {
  videoFlip?: 'normal' | 'mirror' | 'flip' | 'both';
  captures?: Record<number, Record<string, HucomsParam>>;
  encoders?: Record<number, Record<string, HucomsParam>>;
  extra?: HucomsParams;
}

export interface AudioOptions {
  codec?: 'ulaw' | 'alaw';
  inputEnabled?: boolean | 'enable' | 'disable';
  inputGain?: number;
  outputEnabled?: boolean | 'enable' | 'disable';
  outputGain?: number;
  sampling?: 8000 | 16000;
  extra?: HucomsParams;
}

export interface RtspOptions {
  rtspPort?: number;
  rtpPortStart?: number;
  rtpPortEnd?: number;
  rtcpEnabled?: boolean | 'enable' | 'disable';
  timeLimit?: number;
  multicastEnabled?: boolean | 'enable' | 'disable';
  multicastTtl?: number;
  multicastVideoIp?: string;
  multicastVideoPort?: number;
  multicastAudioIp?: string;
  multicastAudioPort?: number;
  authorityEnabled?: boolean | 'enable' | 'disable';
  extra?: HucomsParams;
}

export interface PtzfPosition {
  pan?: number;
  tilt?: number;
  zoom?: number;
  focus?: number;
  panSpeed?: number;
  tiltSpeed?: number;
  zoomSpeed?: number;
  focusSpeed?: number;
}
