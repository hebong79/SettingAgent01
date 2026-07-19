import type { Ptz } from '../viewer/CameraSource.js';

export interface StreamRequest {
  cam: number;
  presetIdx: number;
  signal: AbortSignal;
  ptz?: Ptz;
}

/** 전송 방식과 무관하게 JPEG 프레임을 제공하는 스트림 경계. */
export interface StreamAdapter {
  readonly transport: 'http-mjpeg' | 'rtsp-ffmpeg';
  stream(request: StreamRequest): AsyncGenerator<Buffer>;
}

export class StreamAdapterError extends Error {
  constructor(
    public readonly code: 'INVALID_RTSP_URL' | 'FFMPEG_NOT_FOUND' | 'RTSP_START_TIMEOUT' | 'RTSP_STREAM_FAILED',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StreamAdapterError';
  }
}
