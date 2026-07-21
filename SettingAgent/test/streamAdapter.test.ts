import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SimulatorMjpegAdapter } from '../src/stream/SimulatorMjpegAdapter.js';
import {
  RtspFfmpegAdapter,
  authenticatedRtspUrl,
  buildFfmpegArgs,
  safeRtspUrl,
} from '../src/stream/RtspFfmpegAdapter.js';
import { StreamAdapterError } from '../src/stream/StreamAdapter.js';

const jpeg = (bytes: number[]) => Buffer.from([0xff, 0xd8, ...bytes, 0xff, 0xd9]);

class FakeFfmpeg extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('close', 0));
    return true;
  }
}

describe('SimulatorMjpegAdapter', () => {
  it('cam/preset/signal/ptz를 기존 HTTP MJPEG generator에 그대로 위임', async () => {
    const ac = new AbortController();
    const factory = vi.fn(async function* () { yield jpeg([1]); });
    const adapter = new SimulatorMjpegAdapter(factory);
    const ptz = { pan: 1, tilt: 2, zoom: 3 };
    const frames: Buffer[] = [];
    for await (const frame of adapter.stream({ cam: 2, presetIdx: 7, signal: ac.signal, ptz })) frames.push(frame);
    expect(factory).toHaveBeenCalledWith(2, 7, ac.signal, ptz);
    expect(frames).toEqual([jpeg([1])]);
  });
});

describe('RtspFfmpegAdapter URL/args', () => {
  it('userinfo가 없으면 config 계정을 URL encoding하여 주입', () => {
    expect(authenticatedRtspUrl('rtsp://10.0.0.2/stream1', 'admin user', 'p@ss word'))
      .toBe('rtsp://admin%20user:p%40ss%20word@10.0.0.2/stream1');
  });

  it('기존 URL 계정을 덮어쓰지 않고 safe URL에서는 제거', () => {
    const url = authenticatedRtspUrl('rtsp://device:secret@10.0.0.2/live', 'other', 'other-pass');
    expect(url).toBe('rtsp://device:secret@10.0.0.2/live');
    expect(safeRtspUrl(url)).toBe('rtsp://10.0.0.2/live');
  });

  it('FFmpeg TCP/fps/quality image2pipe 인자를 구성', () => {
    const args = buildFfmpegArgs('rtsp://camera/live', { rtspTransport: 'tcp', fps: 6, jpegQuality: 4 });
    expect(args).toContain('tcp');
    expect(args).toContain('fps=6');
    expect(args).toContain('4');
    expect(args.slice(-4)).toEqual(['mjpeg', '-q:v', '4', 'pipe:1']);
  });

  it('http URL은 RTSP 입력으로 거부', () => {
    expect(() => authenticatedRtspUrl('http://10.0.0.2/live')).toThrow(StreamAdapterError);
  });
});

describe('RtspFfmpegAdapter process lifecycle', () => {
  it('분할 stdout JPEG를 복원하고 Abort 시 FFmpeg를 종료', async () => {
    const child = new FakeFfmpeg();
    const spawnFake = vi.fn(() => child) as never;
    const adapter = new RtspFfmpegAdapter({
      rtspUrl: 'rtsp://10.0.0.2/live', username: 'admin', password: 'secret', startupTimeoutMs: 1000,
    }, spawnFake);
    const ac = new AbortController();
    const iterator = adapter.stream({ cam: 1, presetIdx: 1, signal: ac.signal });
    const firstPending = iterator.next();
    const frame = jpeg([1, 2, 3]);
    child.stdout.write(frame.subarray(0, 3));
    child.stdout.write(frame.subarray(3));
    expect((await firstPending).value).toEqual(frame);

    const [command, args, options] = (spawnFake as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(command).toBe('ffmpeg');
    expect(args.join(' ')).toContain('rtsp://admin:secret@10.0.0.2/live');
    expect(options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const donePending = iterator.next();
    ac.abort();
    expect((await donePending).done).toBe(true);
    expect(child.killed).toBe(true);
  });

  it('첫 프레임 전 FFmpeg 종료는 stderr의 비밀번호를 마스킹해 실패', async () => {
    const child = new FakeFfmpeg();
    const adapter = new RtspFfmpegAdapter({
      rtspUrl: 'rtsp://10.0.0.2/live', username: 'admin', password: 'top-secret', startupTimeoutMs: 1000,
    }, (() => child) as never);
    const pending = adapter.stream({ cam: 1, presetIdx: 1, signal: new AbortController().signal }).next();
    child.stderr.write('cannot open rtsp://admin:top-secret@10.0.0.2/live top-secret');
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({ code: 'RTSP_STREAM_FAILED' });
    await expect(pending).rejects.not.toThrow(/top-secret/);
  });

  it('시작 timeout이면 프로세스를 종료하고 RTSP_START_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeFfmpeg();
      const adapter = new RtspFfmpegAdapter({ rtspUrl: 'rtsp://10.0.0.2/live', startupTimeoutMs: 25 }, (() => child) as never);
      const pending = adapter.stream({ cam: 1, presetIdx: 1, signal: new AbortController().signal }).next();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'RTSP_START_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(30);
      await rejected;
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn ENOENT 이벤트를 FFMPEG_NOT_FOUND로 변환', async () => {
    const child = new FakeFfmpeg();
    const adapter = new RtspFfmpegAdapter({ rtspUrl: 'rtsp://10.0.0.2/live' }, (() => child) as never);
    const pending = adapter.stream({ cam: 1, presetIdx: 1, signal: new AbortController().signal }).next();
    const error = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    child.emit('error', error);
    await expect(pending).rejects.toMatchObject({ code: 'FFMPEG_NOT_FOUND' });
  });
});
