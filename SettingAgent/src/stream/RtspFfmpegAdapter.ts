import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { splitJpegFrames } from '../clients/mjpeg.js';
import type { StreamAdapter, StreamRequest } from './StreamAdapter.js';
import { StreamAdapterError } from './StreamAdapter.js';

export interface RtspFfmpegOptions {
  rtspUrl: string;
  username?: string;
  password?: string;
  ffmpegPath?: string;
  rtspTransport?: 'tcp' | 'udp';
  fps?: number;
  jpegQuality?: number;
  startupTimeoutMs?: number;
}

type SpawnFfmpeg = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessByStdio<null, Readable, Readable>;

/** RTSP URL에 userinfo가 없을 때만 config 계정을 주입한다. */
export function authenticatedRtspUrl(raw: string, username?: string, password?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new StreamAdapterError('INVALID_RTSP_URL', 'RTSP URL 형식이 올바르지 않습니다', cause);
  }
  if (!['rtsp:', 'rtsps:'].includes(url.protocol)) {
    throw new StreamAdapterError('INVALID_RTSP_URL', 'RTSP URL은 rtsp:// 또는 rtsps:// 이어야 합니다');
  }
  if (!url.username && username) url.username = username;
  if (!url.password && password) url.password = password;
  return url.toString();
}

/** 로그/오류용 URL. userinfo는 항상 제거한다. */
export function safeRtspUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<invalid-rtsp-url>';
  }
}

export function buildFfmpegArgs(inputUrl: string, options: Required<Pick<RtspFfmpegOptions, 'rtspTransport' | 'fps' | 'jpegQuality'>>): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-rtsp_transport', options.rtspTransport,
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', inputUrl,
    '-an',
    '-vf', `fps=${options.fps}`,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', String(options.jpegQuality),
    'pipe:1',
  ];
}

/** RTSP(H.264/H.265 등)를 FFmpeg image2pipe JPEG 프레임으로 변환한다. */
export class RtspFfmpegAdapter implements StreamAdapter {
  readonly transport = 'rtsp-ffmpeg' as const;
  private readonly spawnFfmpeg: SpawnFfmpeg;

  constructor(
    private readonly options: RtspFfmpegOptions,
    spawnFfmpeg: SpawnFfmpeg = (command, args, options) =>
      spawn(command, args, options) as ChildProcessByStdio<null, Readable, Readable>,
  ) {
    this.spawnFfmpeg = spawnFfmpeg;
  }

  async *stream(request: StreamRequest): AsyncGenerator<Buffer> {
    if (request.signal.aborted) return;

    const inputUrl = authenticatedRtspUrl(this.options.rtspUrl, this.options.username, this.options.password);
    const ffmpegPath = this.options.ffmpegPath ?? 'ffmpeg';
    const rtspTransport = this.options.rtspTransport ?? 'tcp';
    const fps = this.options.fps ?? 5;
    const jpegQuality = this.options.jpegQuality ?? 5;
    const startupTimeoutMs = this.options.startupTimeoutMs ?? 10_000;
    const args = buildFfmpegArgs(inputUrl, { rtspTransport, fps, jpegQuality });

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = this.spawnFfmpeg(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      throw new StreamAdapterError('FFMPEG_NOT_FOUND', `FFmpeg 실행 실패: ${ffmpegPath}`, cause);
    }

    const frames: Buffer[] = [];
    let rest: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr = '';
    let completed = false;
    let firstFrame = false;
    let failure: StreamAdapterError | undefined;
    let wake: (() => void) | undefined;
    const notify = (): void => {
      const current = wake;
      wake = undefined;
      current?.();
    };
    const terminate = (): void => {
      if (!child.killed) child.kill();
    };
    const fail = (error: StreamAdapterError): void => {
      if (!failure) failure = error;
      completed = true;
      terminate();
      notify();
    };

    const startupTimer = setTimeout(() => {
      fail(new StreamAdapterError('RTSP_START_TIMEOUT', `RTSP 첫 프레임 시간 초과: ${safeRtspUrl(inputUrl)}`));
    }, startupTimeoutMs);

    const onStdout = (chunk: Buffer): void => {
      rest = Buffer.concat([rest, chunk]);
      const parsed = splitJpegFrames(rest);
      rest = parsed.rest;
      if (parsed.frames.length > 0) {
        if (!firstFrame) {
          firstFrame = true;
          clearTimeout(startupTimer);
        }
        frames.push(...parsed.frames.map((frame) => Buffer.from(frame)));
        notify();
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    };
    const onError = (cause: Error): void => {
      const code = (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'FFMPEG_NOT_FOUND' : 'RTSP_STREAM_FAILED';
      fail(new StreamAdapterError(code, code === 'FFMPEG_NOT_FOUND' ? `FFmpeg를 찾을 수 없습니다: ${ffmpegPath}` : 'RTSP FFmpeg 실행 오류', cause));
    };
    const onClose = (code: number | null): void => {
      clearTimeout(startupTimer);
      completed = true;
      if (!request.signal.aborted && !firstFrame && !failure) {
        const cleaned = this.cleanError(stderr, inputUrl);
        failure = new StreamAdapterError('RTSP_STREAM_FAILED', `RTSP 스트림 시작 실패${code === null ? '' : ` (FFmpeg ${code})`}${cleaned ? `: ${cleaned}` : ''}`);
      }
      notify();
    };
    const onAbort = (): void => {
      completed = true;
      terminate();
      notify();
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        if (frames.length > 0) {
          yield frames.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (completed || request.signal.aborted) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      clearTimeout(startupTimer);
      request.signal.removeEventListener('abort', onAbort);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
      terminate();
    }
  }

  private cleanError(message: string, inputUrl: string): string {
    let cleaned = message.replaceAll(inputUrl, safeRtspUrl(inputUrl));
    if (this.options.password) cleaned = cleaned.replaceAll(this.options.password, '***');
    return cleaned.trim().replace(/\s+/g, ' ').slice(0, 500);
  }
}
