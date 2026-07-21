import type { NormalizedPolygon, VehicleBox } from '../domain/types.js';
import type { ToolsConfig } from '../config/toolsConfig.js';
import { fetchWithTimeout, isRetryable, withRetry } from '../util/http.js';
import { normalizeBox } from '../domain/geometry.js';
import { readJpegSize } from '../util/jpeg.js';
import { logger } from '../util/logger.js';

/** da_vpd_api 차량 검출 응답(아키텍처 §5.2). seg 경로도 **같은 스키마**(masks 만 가산). */
interface VpdDetResponse {
  success: boolean;
  id: number;
  bboxes: number[][]; // [[x1,y1,x2,y2], ...] 픽셀 좌표
  confidences: number[];
  classes: string[];
  /** seg 경로 전용. [차량][점][x,y] **픽셀 정수** 폴리곤(차량당 1개). det 응답에는 없다. */
  masks?: number[][][];
}

/**
 * seg 검출 1건 = 공유 `VehicleBox` + **원본 VPD 검출 인덱스**.
 * 마스크 없는 검출을 drop 하는 순간 배열 인덱스가 원본과 어긋나므로, **여기서부터** 원본 키를 들고 다닌다.
 * (`@parkagent/types` 는 건드리지 않는다 — SettingAgent 로컬 확장.)
 */
export type SegBox = VehicleBox & { vpdIdx: number };

/** segment() 결과. 강등 사유를 라우트 summary 로 올리기 위해 카운트를 함께 싣는다(§8 #1·#3). */
export interface VpdSegResult {
  /** 마스크가 유효한 차량만. rect 는 det 와 동일 규약(정규화 bbox) — 절대 대체 없음. */
  boxes: SegBox[];
  /** HTTP 500 강등(S-1: 검출 0대일 때 원격 서버가 500 을 준다) 여부. */
  segDegraded: boolean;
  /** masks 길이 불일치/마스크 퇴화로 drop 된 bbox 수. */
  maskMismatch: number;
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

  /** seg 경로가 배선되어 있는가(cfg.segPath). 라우트의 404 판정 근거. */
  canSegment(): boolean {
    return typeof this.cfg.segPath === 'string' && this.cfg.segPath.length > 0;
  }

  /**
   * 세그멘테이션 검출(POST {segPath}). 응답은 det 와 같은 스키마 + `masks`(픽셀 정수 폴리곤, 차량당 1개).
   * 마스크 없는 bbox 는 **drop**(육면체 추정 불가) — rect 전용 소비처는 detect() 를 계속 쓴다.
   *
   * ★ HTTP 500 강등(S-1): 원격 VPD 서버(192.168.0.125)는 **검출 0대일 때 500** 을 준다(로컬 수정 불가).
   *   → 500 은 throw/재시도 없이 **빈 결과 + segDegraded** 로 강등한다. 그 외 5xx 는 기존대로 재시도 후 throw.
   */
  async segment(image: Buffer): Promise<VpdSegResult> {
    if (!this.cfg.segPath) throw new VpdApiError('VPD seg 미배선(vpd.segPath 없음)', 0);
    const { width, height } = readJpegSize(image);
    return withRetry(
      () => this.segmentOnce(image, width, height),
      (err) => (err instanceof VpdApiError ? isRetryable(err.httpStatus) : true),
      { maxRetries: this.cfg.maxRetries, sleep: this.sleep },
    );
  }

  private async segmentOnce(image: Buffer, imgW: number, imgH: number): Promise<VpdSegResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'capture.jpg');

    const res = await fetchWithTimeout(
      `${this.endpoint}${this.cfg.segPath}`,
      { method: 'POST', headers: this.authHeaders(), body: form },
      this.cfg.timeoutMs,
    );
    if (res.status === 500) {
      // S-1: 검출 0대 → 원격 서버가 500. 다른 5xx(진짜 장애)와 구분되게 로그를 남기고 빈 결과로 강등.
      logger.warn({ cat: 'vpd', path: this.cfg.segPath }, 'VPD seg HTTP 500 — 검출 0대 강등(S-1)');
      return { boxes: [], segDegraded: true, maskMismatch: 0 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VpdApiError(`VPD 세그멘테이션 오류: HTTP ${res.status} ${text}`, res.status);
    }
    const body = (await res.json()) as VpdDetResponse;
    const bboxes = body.bboxes ?? [];
    const masks = body.masks ?? [];
    const boxes: SegBox[] = [];
    let maskMismatch = 0;
    for (let i = 0; i < bboxes.length; i++) {
      const mask = normalizeMask(masks[i], imgW, imgH);
      if (!mask) {
        maskMismatch += 1; // 짝 없는/퇴화 마스크 → drop(조용히 틀린 육면체보다 안 그리는 게 낫다).
        continue;
      }
      boxes.push({
        vpdIdx: i, // ★ 원본 검출 인덱스 — 여기서 drop 이 일어나므로 배열 위치로는 되짚을 수 없다.
        rect: normalizeBox(bboxes[i] as [number, number, number, number], imgW, imgH),
        confidence: body.confidences?.[i] ?? 1,
        cls: body.classes?.[i] ?? 'vehicle',
        mask,
      });
    }
    if (maskMismatch > 0) {
      logger.warn(
        { cat: 'vpd', bboxes: bboxes.length, masks: masks.length, dropped: maskMismatch },
        'VPD seg 마스크/bbox 짝 불일치 — 해당 차량 drop',
      );
    }
    return { boxes, segDegraded: false, maskMismatch };
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

/** 픽셀 정수 폴리곤 → 정규화(0..1). 3점 미만/비유한/크기 불명 → null(그 차량 drop). */
function normalizeMask(raw: number[][] | undefined, imgW: number, imgH: number): NormalizedPolygon | null {
  if (!Array.isArray(raw) || raw.length < 3 || !(imgW > 0) || !(imgH > 0)) return null;
  const poly: NormalizedPolygon = [];
  for (const pt of raw) {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    poly.push({ x: x / imgW, y: y / imgH });
  }
  return poly;
}
