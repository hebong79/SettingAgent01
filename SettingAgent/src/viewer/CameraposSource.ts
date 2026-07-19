import { readFileSync, existsSync } from 'node:fs';
import type { CRpcClient } from '../clients/CRpcClient.js';
import { parseCameraViews, type CameraView } from '../setup/mapTargets.js';
import type { CameraList, CameraSource, Ptz, SnapshotOpts, SnapshotResult } from './CameraSource.js';
import type { RpcCameraSource } from './RpcCameraSource.js';
import { buildCameraList } from './cameraposCatalog.js';

/** cam.list {} 응답 항목(연결·이름 확인용). */
interface RpcCamera {
  camId: number;
  name?: string;
}

/**
 * 뷰어 카메라/프리셋 소스 = camerapos.json(카메라 PTZ 프리셋, 설계서 §2).
 * - listCameras: camerapos.json 을 매 호출 fresh read(자동갱신 폴 정합) + cam.list 로 연결/이름 조회.
 *   cam.list 실패 시 throw → 라우트 502 → 프론트 loadCameras()=false → badge-camera off("연결=cam.list 성공" 시맨틱 보존).
 * - snapshot(preset 모드): camerapos 의 PTZ 를 찾아 setPTZ(manual) 로 적용(주차면 preset.select 경로를 타지 않음).
 * - move/streamMjpeg/변환: device 제어를 RpcCameraSource(inner) 에 위임(합성).
 */
export class CameraposSource implements CameraSource {
  readonly kind = 'rpc' as const;
  readonly streamTransport = 'http-mjpeg' as const;

  constructor(
    private cameraposFile: string,
    private inner: RpcCameraSource,
    private rpc: CRpcClient,
  ) {}

  /** camerapos.json 을 매번 새로 읽어 CameraView[] 로 파싱(파일 없음/파싱 실패 → 빈 배열, graceful). */
  private readViews(): CameraView[] {
    if (!existsSync(this.cameraposFile)) return [];
    try {
      return parseCameraViews(JSON.parse(readFileSync(this.cameraposFile, 'utf-8')));
    } catch {
      return [];
    }
  }

  async listCameras(): Promise<CameraList> {
    const views = this.readViews();
    // cam.list 로 연결/이름 확인. 실패 시 throw(→ 502 → badge off). 목록 자체는 파일 기준.
    const camRes = (await this.rpc.callRpc('cam.list', {})) as { cameras?: RpcCamera[] };
    const devices = (Array.isArray(camRes.cameras) ? camRes.cameras : []).map((c) => ({
      camId: c.camId,
      name: c.name,
    }));
    return buildCameraList(views, devices);
  }

  /** preset 모드: camerapos PTZ 를 찾아 manual(setPTZ) 로 적용. 미발견 시에만 inner 위임(폴백). */
  async snapshot(cam: number, opt: SnapshotOpts): Promise<SnapshotResult> {
    if (opt.mode === 'preset') {
      const ptz = this.findPtz(cam, opt.presetIdx);
      if (ptz) return this.inner.snapshot(cam, { mode: 'manual', presetIdx: opt.presetIdx, ptz });
    }
    return this.inner.snapshot(cam, opt);
  }

  move(cam: number, ptz: Ptz): Promise<boolean> {
    return this.inner.move(cam, ptz);
  }

  /** camerapos는 프리셋만 소유하므로, 현재 PTZ는 Unity RPC 장비에 위임한다. */
  getPtz(cam: number): Promise<Ptz> {
    return this.inner.getPtz(cam);
  }

  streamMjpeg(cam: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz): AsyncGenerator<Buffer> {
    return this.inner.streamMjpeg(cam, presetIdx, signal, ptz);
  }

  toNativePtz(viewerPtz: Ptz): unknown {
    return this.inner.toNativePtz(viewerPtz);
  }

  fromNativePtz(native: unknown): Ptz {
    return this.inner.fromNativePtz(native);
  }

  /** (cam, presetIdx) 프리셋의 PTZ 조회(pan/tilt/zoom 모두 있을 때만). 없으면 undefined. */
  private findPtz(cam: number, presetIdx?: number): Ptz | undefined {
    if (presetIdx === undefined) return undefined;
    const v = this.readViews().find((x) => x.camIdx === cam && x.presetIdx === presetIdx);
    if (v && v.pan !== undefined && v.tilt !== undefined && v.zoom !== undefined) {
      return { pan: v.pan, tilt: v.tilt, zoom: v.zoom };
    }
    return undefined;
  }
}
