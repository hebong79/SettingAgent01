/**
 * 카메라 소스 추상화 (설계서 §13.2).
 * 뷰어 프록시는 이 인터페이스만 호출하므로, 시뮬레이터(Unity)·실 PTZ(Hucoms) 등
 * 소스 구현만 교체하면 SPA·라우트는 무변경이다.
 *
 * 인덱스는 전 구간 1-based(cam/preset). zoom 은 뷰어 단위(1.0~36.0).
 */

export interface Ptz {
  pan: number;
  tilt: number;
  zoom: number;
}

/**
 * /viewer/api/cameras 응답(A타입 그대로).
 * presetProvider.ts 의 UnityCamerasResponse 와 동일 형태(중첩 presets 보존).
 */
export interface CameraList {
  cameras: Array<{
    camIdx: number;
    name: string;
    enabled: boolean;
    presets: Array<{ presetIdx: number; label: string; pan?: number; tilt?: number; zoom?: number }>;
  }>;
}

export interface SnapshotResult {
  jpeg: Buffer;
  ptz: Ptz;
}

export interface SnapshotOpts {
  presetIdx?: number;
  ptz?: Ptz;
  mode: 'preset' | 'manual';
}

/**
 * 소스 공통 계약. snapshot/move 의 `cam` 인자는 1-based 카메라 인덱스.
 * toNativePtz/fromNativePtz 는 뷰어 단위↔소스 원시 단위 변환(시뮬레이터는 항등).
 */
export interface CameraSource {
  readonly kind: 'sim' | 'hucoms' | 'rpc'; // onvif 는 후속(이번 범위 제외)
  readonly streamTransport?: 'http-mjpeg' | 'rtsp-ffmpeg';
  /** 선택 구현의 실제 연결 상태. 미구현 소스는 listCameras 성공 여부로 판단한다. */
  health?(): Promise<boolean>;
  /** (선택) 장비가 보고하는 현재 PTZ. 실카메라·시뮬레이터 UI 상태 동기화에 사용한다. */
  getPtz?(cam: number): Promise<Ptz>;
  listCameras(): Promise<CameraList>;
  snapshot(cam: number, opt: SnapshotOpts): Promise<SnapshotResult>;
  move(cam: number, ptz: Ptz): Promise<boolean>;
  /**
   * (선택) MJPEG 스트림. 프레임(JPEG Buffer)을 순서대로 산출한다(설계서 §2).
   * 미지원 소스는 미구현(→ 라우트 501 → 프론트 폴링 폴백). signal abort 시 상류 중단.
   * ptz 제공 시 수동 PTZ override(pan/tilt/zoom)를 스트림에 실어 렌더(루프3). 미제공 시 preset 기본.
   */
  streamMjpeg?(cam: number, presetIdx: number, signal: AbortSignal, ptz?: Ptz): AsyncGenerator<Buffer>;
  /** (선택) 실 PTZ 소스 로그인. sim 소스는 미구현. */
  login?(user: string, pass: string): Promise<boolean>;
  toNativePtz(viewerPtz: Ptz): unknown;
  fromNativePtz(native: unknown): Ptz;
}
