import type { NormalizedQuad } from '../domain/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { fetchWithTimeout, isRetryable, withRetry } from '../util/http.js';
import { normalizeQuad } from '../domain/geometry.js';
import { readJpegSize } from '../util/jpeg.js';

/** da_lpd_api 번호판 OBB 검출 응답(아키텍처 §5.3). polygons 는 검출별 4×[x,y] 픽셀점. */
interface LpdResponse {
  success: boolean;
  id: number;
  polygons: number[][][]; // [[[x0,y0],[x1,y1],[x2,y2],[x3,y3]], ...]
  confidences?: number[];
  /** 일부 응답은 단수 confidence 로 올 수 있어 방어적으로 함께 처리. */
  confidence?: number[];
  classes?: string[];
}

export class LpdApiError extends Error {
  constructor(message: string, public httpStatus: number) {
    super(message);
    this.name = 'LpdApiError';
  }
}

/**
 * 번호판 검출 1건(정규화 OBB quad). 실제 회전 방향을 보존하는 4점 폴리곤.
 * 캘리브레이션·집계용 축정렬 rect 는 quadBoundingRect(quad) 로 유도한다.
 */
export interface PlateBox {
  quad: NormalizedQuad;
  confidence: number;
  cls: string;
}

/**
 * LPD(번호판 검출, da_lpd_api) 클라이언트.
 * POST {detPath} (multipart 'file') → 픽셀 bbox 를 캡처 해상도로 정규화하여 반환.
 * (VpdClient 와 동일 패턴. SettingAgent 는 셋업 시 차량의 번호판 위치를 미리 저장하는 데 사용.)
 */
export class LpdClient {
  private readonly endpoint: string;
  constructor(private cfg: ToolsConfig['lpd'], private sleep?: (ms: number) => Promise<void>) {
    this.endpoint = cfg.endpoint.replace(/\/+$/, '');
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.endpoint}/health`, { method: 'GET', headers: this.authHeaders() }, this.cfg.timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 이미지(JPEG)에서 번호판 bbox 를 검출해 정규화 좌표로 반환. */
  async detect(image: Buffer): Promise<PlateBox[]> {
    const { width, height } = readJpegSize(image);
    return withRetry(
      () => this.detectOnce(image, width, height),
      (err) => (err instanceof LpdApiError ? isRetryable(err.httpStatus) : true),
      { maxRetries: this.cfg.maxRetries, sleep: this.sleep },
    );
  }

  private async detectOnce(image: Buffer, imgW: number, imgH: number): Promise<PlateBox[]> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'capture.jpg');

    const res = await fetchWithTimeout(
      `${this.endpoint}${this.cfg.detPath}`,
      { method: 'POST', headers: this.authHeaders(), body: form },
      this.cfg.timeoutMs,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LpdApiError(`LPD 검출 오류: HTTP ${res.status} ${text}`, res.status);
    }
    const body = (await res.json()) as LpdResponse;
    const confs = body.confidences ?? body.confidence ?? [];
    return (body.polygons ?? []).map((poly, i) => ({
      quad: normalizeQuad(poly as [number, number][], imgW, imgH),
      confidence: confs[i] ?? 1,
      cls: body.classes?.[i] ?? 'car_license_plate',
    }));
  }

  private authHeaders(): Record<string, string> {
    const key = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined;
    return key ? { 'x-api-key': key } : {};
  }
}
