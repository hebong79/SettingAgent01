import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraposSource } from '../src/viewer/CameraposSource.js';
import type { RpcCameraSource } from '../src/viewer/RpcCameraSource.js';
import type { CRpcClient } from '../src/clients/CRpcClient.js';
import type { Ptz, SnapshotOpts, SnapshotResult } from '../src/viewer/CameraSource.js';

/** camerapos.json 형식 A 한 개(cam1: preset 1/2/3, PTZ 보유). */
function camposA() {
  return {
    _comment: 'test',
    datas: [
      {
        cam_id: 1,
        datas: [
          { cam_id: 1, preset_id: 1, sname: 'C1-P1', pan: 22, tilt: 6.8, zoom: 1.6 },
          { cam_id: 1, preset_id: 2, sname: 'C1-P2', pan: 95, tilt: 10, zoom: 2.5 },
          { cam_id: 1, preset_id: 3, sname: 'C1-P3', pan: 200, tilt: 12, zoom: 3 },
        ],
      },
    ],
  };
}

/** 호출 인자를 기록하는 fake RpcCameraSource(inner). CameraposSource 가 위임하는 메서드만 구현. */
function fakeInner() {
  const calls: { snapshot: Array<{ cam: number; opt: SnapshotOpts }>; move: any[]; getPtz: any[]; stream: any[] } = {
    snapshot: [],
    move: [],
    getPtz: [],
    stream: [],
  };
  const inner = {
    calls,
    async snapshot(cam: number, opt: SnapshotOpts): Promise<SnapshotResult> {
      calls.snapshot.push({ cam, opt });
      const ptz: Ptz = opt.mode === 'manual' && opt.ptz ? opt.ptz : { pan: 0, tilt: 0, zoom: 1 };
      return { jpeg: Buffer.from([0xff, 0xd8]), ptz };
    },
    async move(cam: number, ptz: Ptz): Promise<boolean> {
      calls.move.push({ cam, ptz });
      return true;
    },
    async getPtz(cam: number): Promise<Ptz> {
      calls.getPtz.push({ cam });
      return { pan: 4, tilt: 5, zoom: 6 };
    },
    streamMjpeg(cam: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz) {
      calls.stream.push({ cam, presetIdx, ptz });
      return (async function* () {
        yield Buffer.from([0x01]);
      })();
    },
    toNativePtz: (p: Ptz) => ({ native: p }),
    fromNativePtz: (_n: unknown) => ({ pan: 1, tilt: 2, zoom: 3 } as Ptz),
  };
  return inner as unknown as RpcCameraSource & { calls: typeof calls };
}

/** cam.list 를 제어하는 fake CRpcClient. */
function fakeRpc(camListResult: unknown | (() => never)) {
  const callRpc = vi.fn(async (method: string) => {
    if (method === 'cam.list') {
      if (typeof camListResult === 'function') return (camListResult as () => never)();
      return camListResult;
    }
    throw new Error(`unexpected rpc: ${method}`);
  });
  return { callRpc } as unknown as CRpcClient & { callRpc: ReturnType<typeof vi.fn> };
}

async function withTmp<T>(fn: (file: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'campos-src-'));
  try {
    return await fn(join(dir, 'camerapos.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CameraposSource.listCameras — 파일 fresh read + cam.list 병합', () => {
  it('(a) cam.list 성공 → 파일 기준 CameraList(presets PTZ) + device 이름/enabled 병합', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const inner = fakeInner();
      const rpc = fakeRpc({ cameras: [{ camId: 1, name: 'North' }] });
      const src = new CameraposSource(file, inner, rpc);
      const list = await src.listCameras();
      expect(list.cameras).toHaveLength(1);
      expect(list.cameras[0]).toMatchObject({ camIdx: 1, name: 'North', enabled: true });
      expect(list.cameras[0].presets.map((p) => p.presetIdx)).toEqual([1, 2, 3]);
      expect(list.cameras[0].presets[0]).toMatchObject({ pan: 22, tilt: 6.8, zoom: 1.6 });
      // 경계면: cam.list 는 1회만, preset.list 는 절대 호출 안 함(뷰어 목록 = camerapos 전용).
      expect(rpc.callRpc).toHaveBeenCalledTimes(1);
      expect(rpc.callRpc).toHaveBeenCalledWith('cam.list', {});
    });
  });

  it('(b) camerapos 에 있으나 cam.list 에 없는 camId → enabled=false([off], A2)', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const src = new CameraposSource(file, fakeInner(), fakeRpc({ cameras: [] }));
      const list = await src.listCameras();
      expect(list.cameras[0]).toMatchObject({ camIdx: 1, name: 'C1', enabled: false });
    });
  });

  it('(c) cam.list throw → listCameras throw(→ 502 → badge off 시맨틱)', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const src = new CameraposSource(file, fakeInner(), fakeRpc(() => { throw new Error('unity down'); }));
      await expect(src.listCameras()).rejects.toThrow('unity down');
    });
  });

  it('(d) 파일 없음 → 빈 목록(graceful, throw 안 함)', async () => {
    await withTmp(async (file) => {
      // 파일 미생성.
      const src = new CameraposSource(file, fakeInner(), fakeRpc({ cameras: [{ camId: 1, name: 'x' }] }));
      const list = await src.listCameras();
      expect(list.cameras).toEqual([]);
    });
  });

  it('(e) 파일 파싱 실패 → 빈 목록(graceful)', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, '{ not json');
      const src = new CameraposSource(file, fakeInner(), fakeRpc({ cameras: [] }));
      const list = await src.listCameras();
      expect(list.cameras).toEqual([]);
    });
  });

  it('(f) 매 호출 fresh read — 파일 편집이 다음 호출에 즉시 반영(4초 폴 정합, 캐시 없음)', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const src = new CameraposSource(file, fakeInner(), fakeRpc({ cameras: [{ camId: 1, name: 'N' }] }));
      const first = await src.listCameras();
      expect(first.cameras[0].presets).toHaveLength(3);
      // 프리셋 1개로 파일 재기록.
      const reduced = camposA();
      reduced.datas[0].datas = reduced.datas[0].datas.slice(0, 1);
      writeFileSync(file, JSON.stringify(reduced));
      const second = await src.listCameras();
      expect(second.cameras[0].presets).toHaveLength(1);
    });
  });
});

describe('CameraposSource.snapshot — preset 모드는 파일 PTZ 로 manual 변환(preset.select 회피)', () => {
  it('(a) preset 모드 + PTZ 발견 → inner.snapshot(manual, ptz)', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      await src.snapshot(1, { mode: 'preset', presetIdx: 2 });
      expect(inner.calls.snapshot).toHaveLength(1);
      expect(inner.calls.snapshot[0]).toEqual({
        cam: 1,
        opt: { mode: 'manual', presetIdx: 2, ptz: { pan: 95, tilt: 10, zoom: 2.5 } },
      });
      // cam.list/preset.select 등 RPC 는 snapshot 경로에서 미호출(inner 가 실제 캡처 담당).
    });
  });

  it('(b) preset 모드 + PTZ 미발견(파일에 없는 presetIdx) → 원본 opt 로 inner 위임(폴백)', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      await src.snapshot(1, { mode: 'preset', presetIdx: 9 });
      expect(inner.calls.snapshot[0]).toEqual({ cam: 1, opt: { mode: 'preset', presetIdx: 9 } });
    });
  });

  it('(c) manual 모드 → 그대로 inner 위임', async () => {
    await withTmp(async (file) => {
      writeFileSync(file, JSON.stringify(camposA()));
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      const opt: SnapshotOpts = { mode: 'manual', presetIdx: 1, ptz: { pan: 5, tilt: 5, zoom: 5 } };
      await src.snapshot(1, opt);
      expect(inner.calls.snapshot[0]).toEqual({ cam: 1, opt });
    });
  });
});

describe('CameraposSource — device 제어 위임(합성)', () => {
  it('move → inner.move 위임', async () => {
    await withTmp(async (file) => {
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      const ok = await src.move(2, { pan: 10, tilt: 3, zoom: 4 });
      expect(ok).toBe(true);
      expect(inner.calls.move[0]).toEqual({ cam: 2, ptz: { pan: 10, tilt: 3, zoom: 4 } });
    });
  });

  it('getPtz → inner.getPtz 위임', async () => {
    await withTmp(async (file) => {
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      await expect(src.getPtz(2)).resolves.toEqual({ pan: 4, tilt: 5, zoom: 6 });
      expect(inner.calls.getPtz).toEqual([{ cam: 2 }]);
    });
  });

  it('streamMjpeg → inner.streamMjpeg 위임(cam/preset/ptz 전달)', async () => {
    await withTmp(async (file) => {
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      const ac = new AbortController();
      const gen = src.streamMjpeg(1, 2, ac.signal, { pan: 1, tilt: 2, zoom: 3 });
      const first = await gen.next();
      expect(first.value).toEqual(Buffer.from([0x01]));
      expect(inner.calls.stream[0]).toMatchObject({ cam: 1, presetIdx: 2, ptz: { pan: 1, tilt: 2, zoom: 3 } });
    });
  });

  it('toNativePtz/fromNativePtz → inner 위임', async () => {
    await withTmp((file) => {
      const inner = fakeInner();
      const src = new CameraposSource(file, inner, fakeRpc({ cameras: [] }));
      expect(src.toNativePtz({ pan: 1, tilt: 2, zoom: 3 })).toEqual({ native: { pan: 1, tilt: 2, zoom: 3 } });
      expect(src.fromNativePtz({})).toEqual({ pan: 1, tilt: 2, zoom: 3 });
    });
  });

  it('kind = rpc(라우트/스트림 계약 동일)', async () => {
    await withTmp((file) => {
      const src = new CameraposSource(file, fakeInner(), fakeRpc({ cameras: [] }));
      expect(src.kind).toBe('rpc');
    });
  });
});
