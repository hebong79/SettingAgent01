import type { CameraSourceConfig } from '../config/toolsConfig.js';
import { fetchWithTimeout } from '../util/http.js';
import type { CameraList, CameraSource, Ptz, SnapshotOpts, SnapshotResult } from './CameraSource.js';

/**
 * Hucoms PTZ 카메라(실물) CGI 어댑터(설계서 §13.4).
 *
 * ⚠️ 아래 CGI 경로/원시 PTZ 범위·파라미터명은 **실기기 미확인 가정값**이다.
 *    실 장비(192.168.0.153, HNR-2036LA) 연결 후 실측하여 보정한다(설계서 §13.6).
 *    범위는 cameraSources[].ptz 로 주입 시 우선 적용(아래 기본 범위 폴백).
 */
const HUCOMS_LOGIN_PATH = '/cgi-bin/login.cgi'; // 실측 보정 필요
const HUCOMS_SNAPSHOT_PATH = '/cgi-bin/snapshot.cgi'; // 실측 보정 필요
const HUCOMS_PTZ_PATH = '/cgi-bin/ptz.cgi'; // 실측 보정 필요
const HUCOMS_PTZ_PARAMS = { pan: 'pan', tilt: 'tilt', zoom: 'zoom' }; // 실측 보정 필요

/** 기본 원시 PTZ 범위(실측 보정 필요). cameraSources[].ptz 가 있으면 그것을 우선. */
const HUCOMS_DEFAULT_PAN_RANGE: [number, number] = [0, 36000];
const HUCOMS_DEFAULT_TILT_RANGE: [number, number] = [0, 9000];
const HUCOMS_DEFAULT_ZOOM_RANGE: [number, number] = [1, 36];

/** 뷰어 단위 범위(CameraClient zoom 과 동일 1~36, pan/tilt 는 도(°) -180~180 가정). */
const VIEWER_PAN_RANGE: [number, number] = [-180, 180];
const VIEWER_TILT_RANGE: [number, number] = [-90, 90];
const VIEWER_ZOOM_RANGE: [number, number] = [1, 36];

interface NativePtz {
  pan: number;
  tilt: number;
  zoom: number;
}

/** 선형 매핑 + 범위 클램프. from→to. */
function mapRange(v: number, from: [number, number], to: [number, number]): number {
  const [a, b] = from;
  const [c, d] = to;
  if (b === a) return c;
  const t = (v - a) / (b - a);
  const clamped = Math.min(1, Math.max(0, t));
  return c + clamped * (d - c);
}

export class RealPtzSource implements CameraSource {
  readonly kind = 'hucoms' as const;
  /** 인증 세션(쿠키/토큰). 메모리 통과만 — 저장·로그·응답 노출 금지. */
  private session: string | null = null;
  private readonly base: string;
  private readonly panRange: [number, number];
  private readonly tiltRange: [number, number];
  private readonly zoomRange: [number, number];
  /** 마지막 명령 PTZ(현재-뷰 조회 CGI 미상 시 폴백 반환용). */
  private lastPtz: Ptz = { pan: 0, tilt: 0, zoom: 1 };

  constructor(private cfg: CameraSourceConfig, private timeoutMs = 7000) {
    const host = cfg.host ?? '127.0.0.1';
    const port = cfg.port ?? 80;
    this.base = `http://${host}:${port}`;
    this.panRange = cfg.ptz?.panRange ?? HUCOMS_DEFAULT_PAN_RANGE;
    this.tiltRange = cfg.ptz?.tiltRange ?? HUCOMS_DEFAULT_TILT_RANGE;
    this.zoomRange = cfg.ptz?.zoomRange ?? HUCOMS_DEFAULT_ZOOM_RANGE;
  }

  /** login.cgi 인증 → 세션 보관. 자격증명은 보관·노출하지 않는다(세션만 유지). */
  async login(user: string, pass: string): Promise<boolean> {
    const loginPath = this.cfg.loginPath ?? HUCOMS_LOGIN_PATH;
    const res = await fetchWithTimeout(
      `${this.base}${loginPath}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user, pass }).toString(),
      },
      this.timeoutMs,
    );
    if (!res.ok) {
      this.session = null;
      return false;
    }
    // 세션은 Set-Cookie 또는 응답 토큰에서 추출(실측 보정 필요). 우선 쿠키 헤더 사용.
    const cookie = res.headers.get('set-cookie');
    this.session = cookie ?? 'authenticated';
    return true;
  }

  /** 단일 소스를 프리셋 없는 라이브 뷰 1개로 매핑(설계서 §13.6). */
  async listCameras(): Promise<CameraList> {
    return {
      cameras: [{ camIdx: 1, name: this.cfg.id, enabled: true, presets: [] }],
    };
  }

  async snapshot(_cam: number, opt: SnapshotOpts): Promise<SnapshotResult> {
    if (opt.mode === 'manual' && opt.ptz) {
      await this.move(_cam, opt.ptz);
    }
    const snapshotUrl = this.cfg.snapshotUrl ?? `${this.base}${HUCOMS_SNAPSHOT_PATH}`;
    const res = await fetchWithTimeout(
      snapshotUrl,
      { method: 'GET', headers: this.authHeaders() },
      this.timeoutMs,
    );
    if (!res.ok) throw new Error(`Hucoms snapshot 실패: HTTP ${res.status}`);
    const jpeg = Buffer.from(await res.arrayBuffer());
    return { jpeg, ptz: this.lastPtz };
  }

  async move(_cam: number, ptz: Ptz): Promise<boolean> {
    const native = this.toNativePtz(ptz);
    const params = new URLSearchParams({
      [HUCOMS_PTZ_PARAMS.pan]: String(Math.round(native.pan)),
      [HUCOMS_PTZ_PARAMS.tilt]: String(Math.round(native.tilt)),
      [HUCOMS_PTZ_PARAMS.zoom]: String(Math.round(native.zoom)),
    });
    const res = await fetchWithTimeout(
      `${this.base}${HUCOMS_PTZ_PATH}?${params.toString()}`,
      { method: 'GET', headers: this.authHeaders() },
      this.timeoutMs,
    );
    if (res.ok) this.lastPtz = ptz;
    return res.ok;
  }

  /** 뷰어 단위 → 원시 정수 단위(선형 매핑). */
  toNativePtz(viewerPtz: Ptz): NativePtz {
    return {
      pan: mapRange(viewerPtz.pan, VIEWER_PAN_RANGE, this.panRange),
      tilt: mapRange(viewerPtz.tilt, VIEWER_TILT_RANGE, this.tiltRange),
      zoom: mapRange(viewerPtz.zoom, VIEWER_ZOOM_RANGE, this.zoomRange),
    };
  }

  /** 원시 단위 → 뷰어 단위(왕복 일치). */
  fromNativePtz(native: unknown): Ptz {
    const n = native as NativePtz;
    return {
      pan: mapRange(n.pan, this.panRange, VIEWER_PAN_RANGE),
      tilt: mapRange(n.tilt, this.tiltRange, VIEWER_TILT_RANGE),
      zoom: mapRange(n.zoom, this.zoomRange, VIEWER_ZOOM_RANGE),
    };
  }

  /** 세션을 헤더로 통과(자격증명 평문 미포함). */
  private authHeaders(): Record<string, string> {
    return this.session ? { cookie: this.session } : {};
  }
}
