import sharp from 'sharp';

// Qwen2.5-VL smart-resize 상수(검출 기본값). 패치 stride 14 → 각 변이 28의 배수여야 하고,
// 처리 픽셀 수가 max_pixels 를 넘으면 서버가 재축소한다. 우리가 이 고정점으로 맞춰 보내면
// vLLM 내부 smart-resize 가 항등(크기 불변)이 되어 "모델 반환 픽셀 == 우리가 보낸 (W,H)".
const FACTOR = 28;
const MAX_PIXELS = 1280 * 28 * 28; // ≈1.0M(Qwen 검출 기본 max_pixels)

/** v 를 FACTOR 의 가장 가까운 배수로 반올림(최소 FACTOR 보장). */
function roundToFactor(v: number): number {
  return Math.max(1, Math.round(v / FACTOR)) * FACTOR;
}

/** v 를 FACTOR 의 배수로 내림(최소 FACTOR 보장). max_pixels 상한 엄수용. */
function floorToFactor(v: number): number {
  return Math.max(1, Math.floor(v / FACTOR)) * FACTOR;
}

/**
 * Qwen2.5-VL 그라운딩용 smart-resize 정렬 리사이저(정확도 경로 전용).
 * 종횡비 유지 축소하되 **양 변을 28의 배수로 스냅**하고 총 픽셀 ≤ MAX_PIXELS 로 보장한다.
 * 실제 전송 크기(width,height)를 함께 반환한다 — 좌표 정규화는 이 (W,H) 기준으로 한다(원본 아님).
 * 업스케일 없음(scale ≤ 1). 디코드/인코드 오류 시 throw — 호출측이 null 폴백 처리.
 */
export async function smartResizeJpegBase64(
  b64: string,
  maxLongEdge: number,
): Promise<{ base64: string; width: number; height: number }> {
  const input = Buffer.from(b64, 'base64');
  const meta = await sharp(input).metadata();
  const W0 = meta.width;
  const H0 = meta.height;
  if (!W0 || !H0) throw new Error('이미지 크기를 읽지 못함');
  // 1) 긴변 상한으로 스케일(업스케일 없음).
  const scale = Math.min(1, maxLongEdge / Math.max(W0, H0));
  // 2) 각 변을 28의 배수로 반올림.
  let W = roundToFactor(W0 * scale);
  let H = roundToFactor(H0 * scale);
  // 3) max_pixels 초과 시 √비율 재축소 후 28의 배수로 내림(상한 엄수).
  if (W * H > MAX_PIXELS) {
    const beta = Math.sqrt(MAX_PIXELS / (W * H));
    W = floorToFactor(W * beta);
    H = floorToFactor(H * beta);
  }
  const out = await sharp(input)
    .resize({ width: W, height: H, fit: 'fill' })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { base64: out.toString('base64'), width: W, height: H };
}

/**
 * 비전 호출용 JPEG base64 이미지를 종횡비 유지 균일 축소한다.
 * 긴변이 maxLongEdge 를 초과할 때만 긴변=maxLongEdge 로 스케일하고 짧은변은 비율대로 줄인다.
 * 상한 이하이면 원본을 그대로 반환(업스케일 없음). 강제 16:9 스쿼시/크롭 없음 →
 * LLM 이 돌려주는 정규화 좌표(0~1)는 균일 스케일에 불변이므로 회귀 없음.
 * 디코드/인코드 오류 시 throw — 호출측(chat)이 원본 폴백 + warn 로그 처리.
 */
export async function downscaleJpegBase64(b64: string, maxLongEdge: number): Promise<string> {
  const input = Buffer.from(b64, 'base64');
  const out = await sharp(input)
    .resize({ width: maxLongEdge, height: maxLongEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return out.toString('base64');
}
