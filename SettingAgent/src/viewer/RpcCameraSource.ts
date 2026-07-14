import type { CRpcClient } from '../clients/CRpcClient.js';
import type { CameraClient } from '../clients/CameraClient.js';
import type { CameraList, CameraSource, Ptz, SnapshotOpts, SnapshotResult } from './CameraSource.js';

/** cam.list {} 응답 항목. */
interface RpcCamera {
  camId: number;
  name?: string;
  pan?: number;
  tilt?: number;
  zoom?: number;
}

/** preset.list {} 응답 항목(주차면 프리셋 — 카메라 PTZ 없음). */
interface RpcPreset {
  idx: number;
  presetName?: string;
  camIdx?: number;
}

/**
 * Unity 13110 JSON-RPC 소스 — list/move/snapshot 을 RPC(/rpc)로, 스트림은 CameraClient(/stream)로 위임(설계서 §1·§3).
 * 13100 REST(SimulatorSource) 가 다운되어 이를 기본 소스로 대체한다.
 * 단위 변환은 항등: 뷰어 PTZ(pan/tilt 도, zoom 1~36) = Unity cam.setPTZ/getPTZ 단위 동일 가정(설계서 §7-1).
 */
export class RpcCameraSource implements CameraSource {
  readonly kind = 'rpc' as const;

  constructor(private rpc: CRpcClient, private camera: CameraClient) {}

  /** cam.list + preset.list → CameraList. 프리셋은 camIdx 로 그룹핑, 카메라 PTZ 없어 pan/tilt/zoom omit(설계서 §3). */
  async listCameras(): Promise<CameraList> {
    const camRes = (await this.rpc.callRpc('cam.list', {})) as { cameras?: RpcCamera[] };
    const presetRes = (await this.rpc.callRpc('preset.list', {})) as RpcPreset[];

    const presetsByCam = new Map<number, Array<{ presetIdx: number; label: string }>>();
    for (const p of Array.isArray(presetRes) ? presetRes : []) {
      if (p.camIdx === undefined) continue;
      const list = presetsByCam.get(p.camIdx) ?? [];
      list.push({ presetIdx: p.idx, label: p.presetName ?? `C${p.camIdx}-P${p.idx}` });
      presetsByCam.set(p.camIdx, list);
    }

    const cameras = (Array.isArray(camRes.cameras) ? camRes.cameras : []).map((c) => ({
      camIdx: c.camId,
      name: c.name ?? `C${c.camId}`,
      enabled: true,
      presets: presetsByCam.get(c.camId) ?? [],
    }));
    return { cameras };
  }

  /**
   * manual: cam.setPTZ 선적용 → cam.captureJPG, ptz=요청값 echo.
   * preset: preset.select(best-effort) → cam.captureJPG, ptz=cam.getPTZ(실패 시 UNKNOWN 폴백).
   */
  async snapshot(cam: number, opt: SnapshotOpts): Promise<SnapshotResult> {
    let ptz: Ptz;
    if (opt.mode === 'manual') {
      const p = opt.ptz ?? { pan: 0, tilt: 0, zoom: 1 };
      await this.rpc.callRpc('cam.setPTZ', { camId: cam, pan: p.pan, tilt: p.tilt, zoom: this.camera.clampZoom(p.zoom) });
      ptz = p; // 요청값 echo(시뮬 응답 PTZ 는 신뢰 안 함 — REST 시절과 동일).
    } else {
      await this.rpc.callRpc('preset.select', { idx: opt.presetIdx ?? 1 });
      ptz = await this.currentPtz(cam);
    }
    const cap = (await this.rpc.callRpc('cam.captureJPG', { camId: cam })) as { img_bytes?: string };
    return { jpeg: Buffer.from(cap.img_bytes ?? '', 'base64'), ptz };
  }

  /** cam.setPTZ → body.ok === true. */
  async move(cam: number, ptz: Ptz): Promise<boolean> {
    const res = (await this.rpc.callRpc('cam.setPTZ', {
      camId: cam,
      pan: ptz.pan,
      tilt: ptz.tilt,
      zoom: this.camera.clampZoom(ptz.zoom),
    })) as { ok?: boolean };
    return res.ok === true;
  }

  /** MJPEG 스트림 위임(설계서 §1·§3). 13110 /stream 정상 동작 재사용. */
  streamMjpeg(cam: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz): AsyncGenerator<Buffer> {
    return this.camera.streamMjpeg(cam, presetIdx, signal, ptz);
  }

  toNativePtz(viewerPtz: Ptz): unknown {
    return viewerPtz;
  }

  fromNativePtz(native: unknown): Ptz {
    return native as Ptz;
  }

  /** cam.getPTZ 결과(실패 시 UNKNOWN 강등 → {0,0,1} 폴백, 설계서 §3). */
  private async currentPtz(cam: number): Promise<Ptz> {
    try {
      const p = (await this.rpc.callRpc('cam.getPTZ', { camId: cam })) as Partial<Ptz>;
      return { pan: p.pan ?? 0, tilt: p.tilt ?? 0, zoom: p.zoom ?? 1 };
    } catch {
      return { pan: 0, tilt: 0, zoom: 1 };
    }
  }
}
