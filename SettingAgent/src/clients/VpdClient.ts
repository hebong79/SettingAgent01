import type { VehicleBox } from '../domain/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { fetchWithTimeout, isRetryable, withRetry } from '../util/http.js';
import { normalizeBox } from '../domain/geometry.js';
import { readJpegSize } from '../util/jpeg.js';

/** da_vpd_api 차량 검출 응답(아키텍처 §5.2). */
interface VpdDetResponse {
  success: boolean;
  id: number;
  bboxes: number[][]; // [[x1,y1,x2,y2], ...] 픽셀 좌표
  confidences: number[];
  classes: string[];
}

export class VpdApiError extends Error {
  constructor(message: string, public httpStatus: number) {
    super(message);
    this.name = 'VpdApiError';
  }
}

/**
 * VPD(da_vpd_api) 차량 검출 클라이언트.
 * POST {detPath} (multipart 'file') → 픽셀 bbox 목록을 캡처 해상도로 정규화하여 반환.
 */
export class VpdClient {
  private readonly endpoint: string;
  constructor(private cfg: ToolsConfig['vpd'], private sleep?: (ms: number) => Promise<void>) {
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

  /** 이미지(JPEG)에서 차량 bbox 를 검출해 정규화 좌표로 반환. */
  async detect(image: Buffer): Promise<VehicleBox[]> {
    const { width, height } = readJpegSize(image);
    return withRetry(
      () => this.detectOnce(image, width, height),
      (err) => (err instanceof VpdApiError ? isRetryable(err.httpStatus) : true),
      { maxRetries: this.cfg.maxRetries, sleep: this.sleep },
    );
  }

  private async detectOnce(image: Buffer, imgW: number, imgH: number): Promise<VehicleBox[]> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'capture.jpg');

    const res = await fetchWithTimeout(
      `${this.endpoint}${this.cfg.detPath}`,
      { method: 'POST', headers: this.authHeaders(), body: form },
      this.cfg.timeoutMs,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VpdApiError(`VPD 검출 오류: HTTP ${res.status} ${text}`, res.status);
    }
    const body = (await res.json()) as VpdDetResponse;
    return (body.bboxes ?? []).map((box, i) => ({
      rect: normalizeBox(box as [number, number, number, number], imgW, imgH),
      confidence: body.confidences?.[i] ?? 1,
      cls: body.classes?.[i] ?? 'vehicle',
    }));
  }

  private authHeaders(): Record<string, string> {
    const key = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined;
    return key ? { 'x-api-key': key } : {};
  }
}
