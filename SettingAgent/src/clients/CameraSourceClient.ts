import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CapturedImage } from '../domain/types.js';
import type { CameraList, CameraSource, Ptz } from '../viewer/CameraSource.js';
import type { ICameraClient } from './CameraClient.js';

/**
 * 선택된 Viewer CameraSource를 SettingAgent의 셋업·수집 공통 ICameraClient로 연결한다.
 * 소스 구현(Unity RPC/REST, Hucoms V1.22)은 이 어댑터 바깥으로 누출되지 않는다.
 */
export class CameraSourceClient implements ICameraClient {
  constructor(
    private readonly source: CameraSource,
    private readonly cameraConfig: ToolsConfig['camera'],
  ) {}

  clampZoom(zoom: number): number {
    return Math.min(this.cameraConfig.zoomMax, Math.max(this.cameraConfig.zoomMin, zoom));
  }

  async health(): Promise<boolean> {
    try {
      if (this.source.health) return await this.source.health();
      await this.source.listCameras();
      return true;
    } catch {
      return false;
    }
  }

  async requestImage(
    camIdx: number,
    presetIdx: number,
    ptz?: { pan?: number; tilt?: number; zoom?: number },
  ): Promise<CapturedImage> {
    const manual: Ptz | undefined = ptz
      ? { pan: ptz.pan ?? 0, tilt: ptz.tilt ?? 0, zoom: this.clampZoom(ptz.zoom ?? 1) }
      : undefined;
    const captured = await this.source.snapshot(camIdx, {
      mode: manual ? 'manual' : 'preset',
      presetIdx,
      ptz: manual,
    });
    return {
      camIdx,
      presetIdx,
      pan: captured.ptz.pan,
      tilt: captured.ptz.tilt,
      zoom: captured.ptz.zoom,
      imgName: `cam${camIdx}_p${presetIdx}.jpg`,
      jpg: captured.jpeg,
    };
  }

  streamMjpeg(camIdx: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz): AsyncGenerator<Buffer> {
    if (this.source.streamMjpeg) return this.source.streamMjpeg(camIdx, presetIdx, signal, ptz);
    return this.pollSnapshots(camIdx, presetIdx, signal, ptz);
  }

  /** 선택된 소스의 읽기 전용 현재 PTZ를 SettingAgent 공통 클라이언트 계약으로 전달한다. */
  async getPtz(camIdx: number): Promise<Ptz> {
    if (!this.source.getPtz) throw new Error('선택된 카메라 소스는 현재 PTZ 조회를 지원하지 않습니다');
    const ptz = await this.source.getPtz(camIdx);
    return { pan: ptz.pan, tilt: ptz.tilt, zoom: this.clampZoom(ptz.zoom) };
  }

  listCameras(): Promise<CameraList> {
    return this.source.listCameras();
  }

  move(camIdx: number, pan: number, tilt: number, zoom: number): Promise<boolean> {
    return this.source.move(camIdx, { pan, tilt, zoom: this.clampZoom(zoom) });
  }

  private async *pollSnapshots(camIdx: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz): AsyncGenerator<Buffer> {
    while (!signal.aborted) {
      const captured = await this.source.snapshot(camIdx, {
        mode: ptz ? 'manual' : 'preset',
        presetIdx,
        ptz,
      });
      yield captured.jpeg;
      await new Promise<void>((resolve) => setTimeout(resolve, 333));
    }
  }
}
