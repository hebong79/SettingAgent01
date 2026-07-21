import type { CapturedImage } from '../domain/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import type { CameraList, Ptz } from '../viewer/CameraSource.js';
import { fetchWithTimeout } from '../util/http.js';
import { splitJpegFrames } from './mjpeg.js';

/** Unity REST 서버가 반환하는 오류. */
export class CameraApiError extends Error {
  constructor(public code: string, message: string, public httpStatus: number) {
    super(message);
    this.name = 'CameraApiError';
  }
}

/**
 * 카메라 클라이언트 공개면(설계서 §2.1).
 * private 멤버를 가진 CameraClient 는 명목적 타입이라 RpcCameraClient 로 대체 불가 →
 * 소비처는 이 인터페이스에 의존해 REST/RPC 구현을 교체한다.
 */
export interface ICameraClient {
  clampZoom(zoom: number): number;
  health(): Promise<boolean>;
  requestImage(
    camIdx: number,
    presetIdx: number,
    ptz?: { pan?: number; tilt?: number; zoom?: number },
  ): Promise<CapturedImage>;
  streamMjpeg(
    camIdx: number,
    presetIdx: number,
    signal: AbortSignal,
    ptz?: { pan: number; tilt: number; zoom: number },
  ): AsyncGenerator<Buffer>;
  /** 읽기 전용 현재 PTZ 조회. 구현체가 장비 상태를 반환하지 못하면 예외를 전파한다. */
  getPtz(camIdx: number): Promise<Ptz>;
  listCameras(): Promise<CameraList>;
  move(camIdx: number, pan: number, tilt: number, zoom: number): Promise<boolean>;
  /**
   * (선택) 장비 네이티브 지점 센터링 — 정규화 지점(0~1)을 화면 중앙으로. pan/tilt 만, zoom 불변.
   * 지원 구현만 노출한다(미정의 = 미지원 → 호출측이 기하 폴백). 반환은 이동 후 PTZ.
   */
  centerOnPoint?(camIdx: number, point: { x: number; y: number }): Promise<Ptz>;
}

/**
 * 카메라(Unity 시뮬레이터 + 실 PTZ 공용) REST 클라이언트.
 * CWebCamCtrlServer 의 /health, /req_img, /req_move 호출 (아키텍처 §5.1).
 * 실 PTZ 어댑터도 동일 인터페이스를 구현한다(할일 17).
 */
export class CameraClient implements ICameraClient {
  private readonly baseUrl: string;
  constructor(private cfg: ToolsConfig['camera']) {
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

  /**
   * GET /stream → MJPEG(multipart/x-mixed-replace) 을 소비해 JPEG 프레임을 순서대로 산출(설계서 §3 단계2).
   * 장수명 스트림이라 fetchWithTimeout 대신 signal 만 사용(abort 시 상류 중단, 수용기준 3).
   * 상류 503(TOO_MANY_STREAMS)은 CameraApiError 로 전파(수용기준 4).
   * ptz 제공 시 pan/tilt/zoom override 를 쿼리에 부가(Unity /stream 이 그 각도를 프레임마다 렌더 = req_img manual 경로).
   * 미제공 시 preset 기본 동작(루프3).
   */
  async *streamMjpeg(
    camIdx: number,
    presetIdx: number,
    signal: AbortSignal,
    ptz?: { pan: number; tilt: number; zoom: number },
  ): AsyncGenerator<Buffer> {
    let url = `${this.baseUrl}/stream?cam_idx=${camIdx}&preset_idx=${presetIdx}`; // 1-based(수용기준 5)
    if (ptz) {
      url += `&pan=${ptz.pan}&tilt=${ptz.tilt}&zoom=${this.clampZoom(ptz.zoom)}`; // 수동 PTZ override(zoom 1~36 클램프).
    }
    const res = await fetch(url, { signal });
    if (res.status === 503) throw new CameraApiError('TOO_MANY_STREAMS', 'stream 상한 초과', 503);
    if (!res.ok || !res.body) throw new CameraApiError('INTERNAL', `stream 연결 실패: ${res.status}`, res.status);
    const reader = res.body.getReader();
    let buf: Buffer = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      const { frames, rest } = splitJpegFrames(buf);
      for (const f of frames) yield f;
      buf = rest;
    }
  }

  /** GET /ptz?cam_idx=N → Unity REST 시뮬레이터의 현재 PTZ. 카메라 이동·캡처는 수행하지 않는다. */
  async getPtz(camIdx: number): Promise<Ptz> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/ptz?cam_idx=${encodeURIComponent(String(camIdx))}`,
      { method: 'GET' },
      this.cfg.moveTimeoutMs,
    );
    const body = await parseOrThrow(res);
    const raw = body.ptz ?? body;
    const pan = Number(raw.pan);
    const tilt = Number(raw.tilt);
    const zoom = Number(raw.zoom);
    if (!Number.isFinite(pan) || !Number.isFinite(tilt) || !Number.isFinite(zoom)) {
      throw new CameraApiError('INVALID_PTZ_STATE', '시뮬레이터 PTZ 응답이 완전하지 않습니다', 502);
    }
    return { pan, tilt, zoom: this.clampZoom(zoom) };
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
