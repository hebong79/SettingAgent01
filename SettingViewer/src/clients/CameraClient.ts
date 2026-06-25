import type { ViewerConfig } from '../config/viewerConfig.js';
import type { CameraList } from '../viewer/CameraSource.js';
import { fetchWithTimeout } from '../util/http.js';

/**
 * 캡처 이미지 1건. @parkagent/types 와 동일한 8필드 형태이나,
 * SettingViewer 독립성을 위해 로컬로 정의·재수출한다(소스 의존 회피).
 */
export interface CapturedImage {
  camIdx: number;
  presetIdx: number;
  pan: number;
  tilt: number;
  zoom: number;
  imgName: string;
  jpg: Buffer;
}

/** Unity REST 서버가 반환하는 오류. */
export class CameraApiError extends Error {
  constructor(public code: string, message: string, public httpStatus: number) {
    super(message);
    this.name = 'CameraApiError';
  }
}

/**
 * 카메라(Unity 시뮬레이터 + 실 PTZ 공용) REST 클라이언트.
 * CWebCamCtrlServer 의 /health, /req_img, /req_move, /cameras 호출 (아키텍처 §5.1).
 */
export class CameraClient {
  private readonly baseUrl: string;
  constructor(private cfg: ViewerConfig['camera']) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  }

  /** zoom 을 허용 범위로 클램프(방어적). */
  clampZoom(zoom: number): number {
    return Math.min(this.cfg.zoomMax, Math.max(this.cfg.zoomMin, zoom));
  }

  /** GET /health → 200 이면 true. */
  async health(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/health`, { method: 'GET' }, this.cfg.moveTimeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** POST /req_img → 프리셋 적용 후 캡처 이미지 반환. */
  async requestImage(
    camIdx: number,
    presetIdx: number,
    ptz?: { pan?: number; tilt?: number; zoom?: number },
  ): Promise<CapturedImage> {
    const payload: Record<string, number> = { cam_idx: camIdx, preset_idx: presetIdx };
    if (ptz?.pan !== undefined) payload.pan = ptz.pan;
    if (ptz?.tilt !== undefined) payload.tilt = ptz.tilt;
    if (ptz?.zoom !== undefined) payload.zoom = this.clampZoom(ptz.zoom);

    const res = await fetchWithTimeout(
      `${this.baseUrl}/req_img`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      this.cfg.imageTimeoutMs,
    );
    const body = await parseOrThrow(res);
    return {
      camIdx: body.cam_idx,
      presetIdx: body.preset_idx,
      pan: body.pan,
      tilt: body.tilt,
      zoom: body.zoom,
      imgName: body.img_name,
      jpg: Buffer.from(body.img_bytes ?? '', 'base64'),
    };
  }

  /** GET /cameras → 카메라/프리셋(+PTZ) 목록(A타입). enabled=false 포함, presets 중첩 보존. */
  async listCameras(): Promise<CameraList> {
    const res = await fetchWithTimeout(`${this.baseUrl}/cameras`, { method: 'GET' }, this.cfg.moveTimeoutMs);
    const body = await parseOrThrow(res);
    const cameras = (Array.isArray(body.cameras) ? body.cameras : []).map((c: any) => ({
      camIdx: c.camIdx,
      name: c.name ?? `C${c.camIdx}`,
      enabled: c.enabled !== false,
      presets: (Array.isArray(c.presets) ? c.presets : []).map((p: any) => ({
        presetIdx: p.presetIdx,
        label: p.label ?? `C${c.camIdx}-P${p.presetIdx}`,
        pan: p.pan,
        tilt: p.tilt,
        zoom: p.zoom,
      })),
    }));
    return { cameras };
  }

  /** POST /req_move → PTZ 절대 이동. success 반환. */
  async move(camIdx: number, pan: number, tilt: number, zoom: number): Promise<boolean> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/req_move`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cam_idx: camIdx, pan, tilt, zoom: this.clampZoom(zoom) }),
      },
      this.cfg.moveTimeoutMs,
    );
    const body = await parseOrThrow(res);
    return body.success === true;
  }
}

async function parseOrThrow(res: Response): Promise<any> {
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    throw new CameraApiError(json?.code ?? 'INTERNAL', json?.error ?? `HTTP ${res.status}`, res.status);
  }
  return json;
}
