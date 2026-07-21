import { HucomsClient } from '../clients/hucoms/HucomsClient.js';
import type { CameraSourceConfig } from '../config/toolsConfig.js';
import { logger } from '../util/logger.js';
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

/**
 * ptz_centering setcenter 의 좌표 기준 해상도(HTTP API Hucoms V1.22: 0~1920 / 0~1080 고정).
 * 스트림 해상도가 다르더라도 장비는 이 기준으로 해석하므로 정규화 좌표를 여기에 매핑한다.
 */
const CENTERING_BASE_WIDTH = 1920;
const CENTERING_BASE_HEIGHT = 1080;

/**
 * 실기 슬루 정착(settle) 폴링 상수.
 *
 * 시뮬(Unity)은 setPTZ 가 즉시 반영돼 move() 가 바로 반환해도 무방하지만, 실기(Hucoms)는
 * goptzfpos 204 를 받은 직후에도 팬/틸트/줌이 수 초에 걸쳐 슬루한다. 이동 완료를 확인하지 않고
 * 반환하면 폐루프(plate-zoom)가 "아직 움직이지 않은 프레임"을 측정해 오차가 그대로라 판단하고
 * 스텝을 계속 키운다(실측: 750ms 간격 연속 발사, zoompos 12007→16171→21584→28621 진동, x36 포화).
 */
const SETTLE_POLL_MS = 150;      // 실측 폐루프 재촬영 간격(~750ms)보다 촘촘해야 정지 판정이 늦지 않다.
const SETTLE_TIMEOUT_MS = 5000;  // x1→x36 풀 슬루가 수 초. 그 이상은 장비 이상으로 보고 warn 후 진행.
const SETTLE_PAN_TILT_EPS = 10;  // raw(팬 0~35999 / 틸트 -2000~9000) — 0.1° 수준의 도달 판정 여유.
const SETTLE_ZOOM_EPS = 300;     // raw(줌 0~65535) — 약 0.16x 에 해당하는 도달 판정 여유.

/** 정착 폴링 타이밍 주입구(테스트에서 0 으로 낮춰 실시간 대기를 없앤다). */
export interface RealPtzSettleOptions {
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

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

/** 연속 두 폴링의 raw 값이 완전히 동일하면 정지로 본다. */
function isStopped(a: NativePtz, b: NativePtz): boolean {
  return a.pan === b.pan && a.tilt === b.tilt && a.zoom === b.zoom;
}

/** 목표 raw 값에 허용 오차 이내로 도달했는가. */
function isNearTarget(target: NativePtz, current: NativePtz): boolean {
  return (
    Math.abs(target.pan - current.pan) <= SETTLE_PAN_TILT_EPS &&
    Math.abs(target.tilt - current.tilt) <= SETTLE_PAN_TILT_EPS &&
    Math.abs(target.zoom - current.zoom) <= SETTLE_ZOOM_EPS
  );
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
  private readonly settlePollMs: number;
  private readonly settleTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private cfg: CameraSourceConfig,
    timeoutMs = 7000,
    streamAdapter?: StreamAdapter,
    settle: RealPtzSettleOptions = {},
  ) {
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
    this.settlePollMs = settle.pollMs ?? SETTLE_POLL_MS;
    this.settleTimeoutMs = settle.timeoutMs ?? SETTLE_TIMEOUT_MS;
    this.sleep = settle.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    const target: NativePtz = {
      pan: Math.round(native.pan),
      tilt: Math.round(native.tilt),
      zoom: Math.round(native.zoom),
    };
    await this.client.goPtzfPosition({
      ...target,
      panSpeed: 100,
      tiltSpeed: 100,
      zoomSpeed: 100,
    });
    // goptzfpos 204 는 "명령 수신"일 뿐 "이동 완료"가 아니다. 실제 정지를 확인한 뒤 반환한다.
    await this.waitUntilSettled(target);
    this.lastPtz = ptz;
    return true;
  }

  /**
   * goptzfpos 이후 getptzfpos 를 폴링해 이동 완료를 확인한다.
   * 종료: (연속 2회 raw 값이 동일 = 정지) AND (목표 근접) → 반환.
   *   정지만으로 끊지 않는 이유: 명령 직후 아직 슬루를 시작하지 않은 구간도 "연속 동일"로 보이므로
   *   목표 근접을 함께 요구해야 조기 반환(= 이번 버그의 원인)을 막는다.
   * 상한 초과: warn 로그(목표·최종 raw·경과 ms)를 남기고 반환 — 폐루프를 죽이지 않는다(예외 미전파).
   * 폴링 실패/불완전 응답: 흡수하고 즉시 반환(위치 조회를 지원하지 않는 모델에 대한 currentPtz 강등 정책과 동일).
   */
  private async waitUntilSettled(target: NativePtz): Promise<void> {
    const startedAt = Date.now();
    let previous: NativePtz | undefined;
    let last: NativePtz | undefined;
    while (Date.now() - startedAt < this.settleTimeoutMs) {
      await this.sleep(this.settlePollMs);
      let current: NativePtz | undefined;
      try {
        current = await this.readNativePtz();
      } catch {
        return;
      }
      if (!current) return;
      last = current;
      if (previous && isStopped(previous, current) && isNearTarget(target, current)) return;
      previous = current;
    }
    logger.warn(
      { cat: 'centering', target, last, elapsedMs: Date.now() - startedAt, timeoutMs: this.settleTimeoutMs },
      'PTZ 이동 정착 대기 상한 초과 — 미정착 상태로 반환',
    );
  }

  /** 장비 raw PTZF 조회. 필드가 불완전하면 undefined(호출자가 정책을 정한다). */
  private async readNativePtz(): Promise<NativePtz | undefined> {
    const response = await this.client.getPtzfPosition();
    const pan = finiteValue(response.values, 'panpos', 'pan');
    const tilt = finiteValue(response.values, 'tiltpos', 'tilt');
    const zoom = finiteValue(response.values, 'zoompos', 'zoom');
    if (pan === undefined || tilt === undefined || zoom === undefined) return undefined;
    return { pan, tilt, zoom };
  }

  /**
   * 네이티브 지점 센터링(ptz_centering setcenter, type=point) — 지정 지점을 화면 중앙으로. pan/tilt 만 움직인다.
   * setcenter 응답에는 PTZ echo 가 없으므로 이동 후 장비 조회로 현재 PTZ 를 확정해 반환한다.
   */
  async centerOnPoint(_camera: number, point: { x: number; y: number }): Promise<Ptz> {
    await this.client.centerPtz({
      type: 'point',
      pointX: Math.round(clamp01(point.x) * CENTERING_BASE_WIDTH),
      pointY: Math.round(clamp01(point.y) * CENTERING_BASE_HEIGHT),
      speed: 50,
    });
    return this.currentPtz();
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
      const native = await this.readNativePtz();
      if (!native) {
        if (requireDeviceResponse) throw new Error('카메라 PTZF 위치 응답이 완전하지 않습니다');
        return this.lastPtz;
      }
      this.lastPtz = this.fromNativePtz(native);
    } catch (cause) {
      if (requireDeviceResponse) throw cause;
      // 일부 모델은 위치 조회를 지원하지 않으므로 마지막 성공 명령값으로 강등한다.
    }
    return this.lastPtz;
  }
}
