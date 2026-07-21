import { HucomsClient } from '../clients/hucoms/HucomsClient.js';
import type { CameraSourceConfig } from '../config/toolsConfig.js';
import { SimulatorMjpegAdapter } from '../stream/SimulatorMjpegAdapter.js';
import type { StreamAdapter } from '../stream/StreamAdapter.js';
import type { CameraList, CameraSource, Ptz, SnapshotOpts, SnapshotResult } from './CameraSource.js';

/** HTTP API Hucoms V1.22 원시 PTZ 범위. */
const HUCOMS_DEFAULT_PAN_RANGE: [number, number] = [0, 35999];
const HUCOMS_DEFAULT_TILT_RANGE: [number, number] = [-2000, 9000];
const HUCOMS_DEFAULT_ZOOM_RANGE: [number, number] = [0, 65535];

/** SettingViewer의 기존 공통 좌표계. */
const VIEWER_PAN_RANGE: [number, number] = [-180, 180];
const VIEWER_TILT_RANGE: [number, number] = [-90, 90];
const VIEWER_ZOOM_RANGE: [number, number] = [1, 36];

interface NativePtz {
  pan: number;
  tilt: number;
  zoom: number;
}

function mapRange(value: number, from: [number, number], to: [number, number]): number {
  const [a, b] = from;
  const [c, d] = to;
  if (b === a) return c;
  const ratio = Math.min(1, Math.max(0, (value - a) / (b - a)));
  return c + ratio * (d - c);
}

function finiteValue(values: Record<string, string>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(values[key]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Hucoms 실물 카메라 어댑터.
 *
 * Agent 쪽 CameraSource 계약과 Hucoms HTTP API V1.22의 query 인증·JPEG·PTZF·MJPEG를 연결한다.
 * 자격증명은 HucomsClient 메모리에만 유지하고, Client 통신 로그에서는 passwd를 마스킹한다.
 */
export class RealPtzSource implements CameraSource {
  readonly kind = 'hucoms' as const;
  readonly streamTransport: StreamAdapter['transport'];
  private readonly client: HucomsClient;
  private readonly panRange: [number, number];
  private readonly tiltRange: [number, number];
  private readonly zoomRange: [number, number];
  private readonly streamAdapter: StreamAdapter;
  private lastPtz: Ptz = { pan: 0, tilt: 0, zoom: 1 };

  constructor(private cfg: CameraSourceConfig, timeoutMs = 7000, streamAdapter?: StreamAdapter) {
    const host = cfg.host ?? '127.0.0.1';
    const port = cfg.port ?? 80;
    this.client = new HucomsClient({
      baseUrl: cfg.baseUrl ?? `http://${host}:${port}`,
      username: cfg.username,
      password: cfg.password,
      timeoutMs,
    });
    this.panRange = cfg.ptz?.panRange ?? HUCOMS_DEFAULT_PAN_RANGE;
    this.tiltRange = cfg.ptz?.tiltRange ?? HUCOMS_DEFAULT_TILT_RANGE;
    this.zoomRange = cfg.ptz?.zoomRange ?? HUCOMS_DEFAULT_ZOOM_RANGE;
    // 직접 생성한 레거시 소비자는 Hucoms MJPEG를 유지한다. sourceRegistry의 실카메라는 RTSP adapter를 명시 주입한다.
    this.streamAdapter = streamAdapter ?? new SimulatorMjpegAdapter((_cam, _preset, signal) => this.client.iterMjpeg({ signal }));
    this.streamTransport = this.streamAdapter.transport;
  }

  /**
   * Hucoms V1.22에는 별도 login CGI가 없으므로 자격증명을 설정한 뒤 getservername으로 검증한다.
   * 실패하면 자격증명을 즉시 제거한다.
   */
  async login(user: string, pass: string): Promise<boolean> {
    this.client.setCredentials(user, pass);
    try {
      await this.client.getServerName();
      return true;
    } catch {
      this.client.clearCredentials();
      return false;
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.client.getServerName();
      return true;
    } catch {
      return false;
    }
  }

  async listCameras(): Promise<CameraList> {
    return {
      // 물리 카메라는 camerapos preset을 장비에서 보유하지 않는다. UI 선택 안정성을 위해 현재 위치 항목 하나를 제공한다.
      cameras: [{ camIdx: 1, name: this.cfg.id, enabled: true, presets: [{ presetIdx: 1, label: '현재 위치' }] }],
    };
  }

  /** Hucoms 장비가 보고하는 현재 PTZF를 Viewer 좌표계로 변환해 반환한다. */
  async getPtz(_camera: number): Promise<Ptz> {
    // UI의 '현재 PTZ 불러오기'는 장비 응답이 필수다. 실패를 마지막 명령값으로 위장하지 않는다.
    return this.currentPtz(true);
  }

  async snapshot(camera: number, options: SnapshotOpts): Promise<SnapshotResult> {
    if (options.mode === 'manual' && options.ptz) await this.move(camera, options.ptz);
    const jpeg = await this.client.getJpeg();
    const ptz = await this.currentPtz();
    return { jpeg, ptz };
  }

  async move(_camera: number, ptz: Ptz): Promise<boolean> {
    const native = this.toNativePtz(ptz);
    await this.client.goPtzfPosition({
      pan: Math.round(native.pan),
      tilt: Math.round(native.tilt),
      zoom: Math.round(native.zoom),
      panSpeed: 100,
      tiltSpeed: 100,
      zoomSpeed: 100,
    });
    this.lastPtz = ptz;
    return true;
  }

  async *streamMjpeg(
    camera: number,
    _presetIdx: number,
    signal: AbortSignal,
    ptz?: Ptz,
  ): AsyncGenerator<Buffer> {
    if (ptz) await this.move(camera, ptz);
    yield* this.streamAdapter.stream({ cam: camera, presetIdx: _presetIdx, signal, ptz });
  }

  toNativePtz(viewerPtz: Ptz): NativePtz {
    return {
      pan: mapRange(viewerPtz.pan, VIEWER_PAN_RANGE, this.panRange),
      tilt: mapRange(viewerPtz.tilt, VIEWER_TILT_RANGE, this.tiltRange),
      zoom: mapRange(viewerPtz.zoom, VIEWER_ZOOM_RANGE, this.zoomRange),
    };
  }

  fromNativePtz(native: unknown): Ptz {
    const value = native as NativePtz;
    return {
      pan: mapRange(value.pan, this.panRange, VIEWER_PAN_RANGE),
      tilt: mapRange(value.tilt, this.tiltRange, VIEWER_TILT_RANGE),
      zoom: mapRange(value.zoom, this.zoomRange, VIEWER_ZOOM_RANGE),
    };
  }

  private async currentPtz(requireDeviceResponse = false): Promise<Ptz> {
    try {
      const response = await this.client.getPtzfPosition();
      const pan = finiteValue(response.values, 'panpos', 'pan');
      const tilt = finiteValue(response.values, 'tiltpos', 'tilt');
      const zoom = finiteValue(response.values, 'zoompos', 'zoom');
      if (pan === undefined || tilt === undefined || zoom === undefined) {
        if (requireDeviceResponse) throw new Error('카메라 PTZF 위치 응답이 완전하지 않습니다');
        return this.lastPtz;
      }
      this.lastPtz = this.fromNativePtz({ pan, tilt, zoom });
    } catch (cause) {
      if (requireDeviceResponse) throw cause;
      // 일부 모델은 위치 조회를 지원하지 않으므로 마지막 성공 명령값으로 강등한다.
    }
    return this.lastPtz;
  }
}
