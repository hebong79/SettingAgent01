import { describe, it, expect, afterEach, vi } from 'vitest';
import { CameraClient, CameraApiError } from '../src/clients/CameraClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

const camCfg = (): ToolsConfig['camera'] => ({
  baseUrl: 'http://cam.test',
  imageTimeoutMs: 7000,
  moveTimeoutMs: 3000,
  zoomMin: 1.0,
  zoomMax: 36.0,
});

function jpeg(payload: number[]): Buffer {
  return Buffer.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);
}
function multipart(frame: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`, 'ascii'),
    frame,
    Buffer.from('\r\n', 'ascii'),
  ]);
}

/**
 * getReader() 를 흉내내는 가짜 응답 본문. chunks 를 순서대로 내보내고,
 * 소진 후 signal.aborted 면 abort 에러를 던져 undici 의 스트림 중단을 모사.
 */
function fakeStreamResponse(chunks: Buffer[], status: number, signal: AbortSignal) {
  const queue = [...chunks];
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader() {
        return {
          async read(): Promise<{ done: boolean; value?: Uint8Array }> {
            if (queue.length > 0) return { done: false, value: new Uint8Array(queue.shift()!) };
            if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            // 남은 청크 없음 + 미abort → 정상 종료.
            return { done: true };
          },
        };
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CameraClient.streamMjpeg — fetch 모킹', () => {
  it('멀티파트 바이트(여러 청크)를 소비해 원본 JPEG 프레임과 일치', async () => {
    const f1 = jpeg([0x01, 0x02, 0x03]);
    const f2 = jpeg([0xaa, 0xbb]);
    const full = Buffer.concat([multipart(f1), multipart(f2)]);
    // 임의 지점에서 3청크로 쪼개 공급(경계 분할 이월 검증).
    const chunks = [full.subarray(0, 5), full.subarray(5, full.length - 4), full.subarray(full.length - 4)];

    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      capturedUrl = url;
      return fakeStreamResponse(chunks, 200, opts.signal);
    }));

    const client = new CameraClient(camCfg());
    const ac = new AbortController();
    const got: Buffer[] = [];
    for await (const f of client.streamMjpeg(1, 2, ac.signal)) got.push(f);

    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(f1);
    expect(got[1]).toEqual(f2);
    // URL 은 1-based cam_idx/preset_idx.
    expect(capturedUrl).toBe('http://cam.test/stream?cam_idx=1&preset_idx=2');
  });

  it('1-based URL 구성(cam=3, preset=5)', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      capturedUrl = url;
      return fakeStreamResponse([multipart(jpeg([0x01]))], 200, opts.signal);
    }));
    const client = new CameraClient(camCfg());
    const ac = new AbortController();
    for await (const _f of client.streamMjpeg(3, 5, ac.signal)) { /* drain */ }
    expect(capturedUrl).toBe('http://cam.test/stream?cam_idx=3&preset_idx=5');
  });

  it('상류 503 → CameraApiError(TOO_MANY_STREAMS, httpStatus 503) throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => fakeStreamResponse([], 503, opts.signal)));
    const client = new CameraClient(camCfg());
    const ac = new AbortController();
    await expect(client.streamMjpeg(1, 1, ac.signal).next()).rejects.toMatchObject({
      name: 'CameraApiError',
      code: 'TOO_MANY_STREAMS',
      httpStatus: 503,
    });
    // 신선한 iterator 로 instanceof 확인(throw 후 재호출은 {done:true} 라 별도 iterator 사용).
    await expect(client.streamMjpeg(1, 1, ac.signal).next()).rejects.toBeInstanceOf(CameraApiError);
  });

  it('상류 비-503 실패(500) → CameraApiError(INTERNAL) throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => fakeStreamResponse([], 500, opts.signal)));
    const client = new CameraClient(camCfg());
    const ac = new AbortController();
    const it = client.streamMjpeg(1, 1, ac.signal);
    await expect(it.next()).rejects.toMatchObject({ name: 'CameraApiError', code: 'INTERNAL', httpStatus: 500 });
  });

  it('AbortSignal abort → 순회가 종료(이후 read 가 abort 에러 전파)', async () => {
    const f1 = jpeg([0x01, 0x02]);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) =>
      // 첫 청크(완전 프레임) 후 큐 소진 → 다음 read 는 abort 여부에 따라 분기.
      fakeStreamResponse([multipart(f1)], 200, opts.signal),
    ));
    const client = new CameraClient(camCfg());
    const ac = new AbortController();
    const it = client.streamMjpeg(1, 1, ac.signal);

    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(f1);

    ac.abort();
    // abort 후 재개 → reader.read() 가 AbortError → 순회 종료(throw 전파).
    await expect(it.next()).rejects.toThrow();
  });
});
