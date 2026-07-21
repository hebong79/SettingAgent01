import type { CameraClient } from '../clients/CameraClient.js';
import { SimulatorMjpegAdapter } from '../stream/SimulatorMjpegAdapter.js';
import type { StreamAdapter } from '../stream/StreamAdapter.js';
import type { CameraList, CameraSource, Ptz, SnapshotOpts, SnapshotResult } from './CameraSource.js';

/**
 * 시뮬레이터(Unity) 소스 — 기존 CameraClient 를 래핑(설계서 §13.2).
 * snapshot=/req_img, move=/req_move, list=/cameras. 단위 변환은 항등(뷰어=Unity 단위 동일).
 */
export class SimulatorSource implements CameraSource {
  readonly kind = 'sim' as const;
  readonly streamTransport: StreamAdapter['transport'];
  private readonly streamAdapter: StreamAdapter;

  constructor(private camera: CameraClient, streamAdapter?: StreamAdapter) {
    this.streamAdapter = streamAdapter ?? new SimulatorMjpegAdapter((cam, preset, signal, ptz) => this.camera.streamMjpeg(cam, preset, signal, ptz));
    this.streamTransport = this.streamAdapter.transport;
  }

  health(): Promise<boolean> {
    return this.camera.health();
  }

  listCameras(): Promise<CameraList> {
    return this.camera.listCameras();
  }

  /** 레거시 Unity REST 시뮬레이터의 읽기 전용 /ptz 조회. */
  getPtz(cam: number): Promise<Ptz> {
    return this.camera.getPtz(cam);
  }

  async snapshot(cam: number, opt: SnapshotOpts): Promise<SnapshotResult> {
    // /req_img 는 cam_idx/preset_idx 필수. manual 모드면 PTZ override 동봉(해석 A 확정).
    const ptz = opt.mode === 'manual' ? opt.ptz : undefined;
    const captured = await this.camera.requestImage(cam, opt.presetIdx ?? 1, ptz);
    return {
      jpeg: captured.jpg,
      ptz: { pan: captured.pan, tilt: captured.tilt, zoom: captured.zoom },
    };
  }

  move(cam: number, ptz: Ptz): Promise<boolean> {
    return this.camera.move(cam, ptz.pan, ptz.tilt, ptz.zoom);
  }

  /** MJPEG 스트림 위임(설계서 §3 단계3). CameraClient.streamMjpeg 로 그대로 전달(ptz override 포함, 루프3). */
  streamMjpeg(cam: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz): AsyncGenerator<Buffer> {
    return this.streamAdapter.stream({ cam, presetIdx, signal, ptz });
  }

  toNativePtz(viewerPtz: Ptz): unknown {
    return viewerPtz;
  }

  fromNativePtz(native: unknown): Ptz {
    return native as Ptz;
  }
}
