import { readFileSync, existsSync } from 'node:fs';
import type { CapturedImage } from '../domain/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraList } from '../viewer/CameraSource.js';
import type { CRpcClient } from './CRpcClient.js';
import { CameraClient, type ICameraClient } from './CameraClient.js';
import { parseCameraViews } from '../setup/mapTargets.js';
import { buildCameraList } from '../viewer/cameraposCatalog.js';
import { logger } from '../util/logger.js';

/** RpcCameraClient 생성 의존성(설계서 §2.2). */
export interface RpcCameraClientDeps {
  rpc: CRpcClient;
  cameraCfg: ToolsConfig['camera'];
  /** 카메라 PTZ 프리셋 소유 파일(config/camerapos.json). listCameras 가 매 호출 fresh read. */
  cameraposFile: string;
}

/**
 * Unity 13110 JSON-RPC 카메라 클라이언트(설계서 §2.2).
 * 죽은 13100 REST(/req_img·/req_move·/cameras·/health) 대신 /rpc(system.ping·cam.setPTZ·cam.captureJPG·cam.getPTZ)로 매핑한다.
 * clampZoom·streamMjpeg 는 내부 REST CameraClient(13110 /stream)에 위임(중복 0), listCameras 는 camerapos.json 을 사용한다.
 */
export class RpcCameraClient implements ICameraClient {
  private readonly rpc: CRpcClient;
  private readonly cameraposFile: string;
  /** clampZoom·streamMjpeg 재사용 전용(REST 메서드는 호출하지 않음). */
  private readonly inner: CameraClient;

  constructor(deps: RpcCameraClientDeps) {
    this.rpc = deps.rpc;
    this.cameraposFile = deps.cameraposFile;
    this.inner = new CameraClient(deps.cameraCfg);
  }

  /** zoom 클램프 위임(설계서 §2.2). */
  clampZoom(zoom: number): number {
    return this.inner.clampZoom(zoom);
  }

  /** system.ping 성공 → true, 실패 → false(장애 격리). */
  async health(): Promise<boolean> {
    try {
      await this.rpc.callRpc('system.ping', {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * ptz 제공 시 cam.setPTZ 선적용 → cam.captureJPG. CapturedImage 반환.
   * pan/tilt/zoom echo: 명령 ptz(zoom=clamp) 우선, 미제공 시 cam.getPTZ best-effort({0,0,1} 폴백).
   */
  async requestImage(
    camIdx: number,
    presetIdx: number,
    ptz?: { pan?: number; tilt?: number; zoom?: number },
  ): Promise<CapturedImage> {
    let echo: { pan: number; tilt: number; zoom: number };
    if (ptz) {
      const pan = ptz.pan ?? 0;
      const tilt = ptz.tilt ?? 0;
      const zoom = this.clampZoom(ptz.zoom ?? 1);
      await this.rpc.callRpc('cam.setPTZ', { camId: camIdx, pan, tilt, zoom });
      echo = { pan, tilt, zoom };
    } else {
      echo = await this.currentPtz(camIdx);
    }

    const cap = (await this.rpc.callRpc('cam.captureJPG', { camId: camIdx })) as { img_bytes?: string };
    return {
      camIdx,
      presetIdx,
      pan: echo.pan,
      tilt: echo.tilt,
      zoom: echo.zoom,
      imgName: `cam${camIdx}_p${presetIdx}.jpg`,
      jpg: Buffer.from(cap.img_bytes ?? '', 'base64'),
    };
  }

  /** MJPEG 스트림 위임(13110 /stream 재사용). */
  streamMjpeg(
    camIdx: number,
    presetIdx: number,
    signal: AbortSignal,
    ptz?: { pan: number; tilt: number; zoom: number },
  ): AsyncGenerator<Buffer> {
    return this.inner.streamMjpeg(camIdx, presetIdx, signal, ptz);
  }

  /** camerapos.json(프리셋 PTZ 소유) 기반 카메라/프리셋 목록. 파일 없음/파싱 실패 → 빈 목록(graceful). */
  async listCameras(): Promise<CameraList> {
    if (!existsSync(this.cameraposFile)) return { cameras: [] };
    try {
      const views = parseCameraViews(JSON.parse(readFileSync(this.cameraposFile, 'utf-8')));
      return buildCameraList(views);
    } catch (err) {
      logger.warn(
        { file: this.cameraposFile, err: err instanceof Error ? err.message : String(err) },
        'camerapos 읽기 실패 → 빈 카메라 목록',
      );
      return { cameras: [] };
    }
  }

  /** cam.setPTZ(zoom clamp) → result.ok === true. */
  async move(camIdx: number, pan: number, tilt: number, zoom: number): Promise<boolean> {
    const res = (await this.rpc.callRpc('cam.setPTZ', {
      camId: camIdx,
      pan,
      tilt,
      zoom: this.clampZoom(zoom),
    })) as { ok?: boolean };
    return res.ok === true;
  }

  /** cam.getPTZ best-effort(실패 시 {0,0,1} 강등, 설계서 §2.2). */
  private async currentPtz(camIdx: number): Promise<{ pan: number; tilt: number; zoom: number }> {
    try {
      const p = (await this.rpc.callRpc('cam.getPTZ', { camId: camIdx })) as Partial<{
        pan: number;
        tilt: number;
        zoom: number;
      }>;
      return { pan: p.pan ?? 0, tilt: p.tilt ?? 0, zoom: p.zoom ?? 1 };
    } catch {
      return { pan: 0, tilt: 0, zoom: 1 };
    }
  }
}
