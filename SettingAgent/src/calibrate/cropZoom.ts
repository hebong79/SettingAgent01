// 앞면중심 기준 디지털 크롭-줌 + 아핀 역계산(설계서 §2-1·§3·§8).
// 순수 기하(computeCropWindow / toCropPoint / backmapQuad)는 외부 의존 0 — vitest 왕복 파리티 대상.
// sharp IO(cropAndUpscale)만 부수효과(디코드·크롭·업스케일). 좌표는 모두 정규화(0~1).
//
// 핵심(설계서 §2-1): LpdClient 는 입력 이미지 자체 해상도로 정규화하므로, 크롭 JPEG 에 LPD 를
//   돌리면 반환 quad 는 **크롭 정규화 좌표**다. 원본 복원은 크롭 창 offset·size 만 필요한 아핀:
//     orig.x = W.x + q.x·W.w ,  orig.y = W.y + q.y·W.h   (각 코너 독립)
//   업스케일 배율은 정규화가 흡수 → 역매핑 식에 등장하지 않는다(검출 성패에만 영향).

import sharp from 'sharp';
import type { NormalizedRect, NormalizedPoint, NormalizedQuad } from '../domain/types.js';
import { clamp01 } from '../domain/geometry.js';
import { readJpegSize } from '../util/jpeg.js';

/**
 * 앞면중심(center) 기준 크롭 창 산출. frac = 창의 **폭 비율**(원본 정규화, 설계서 §3-3).
 * aspect = 원본 imgW/imgH — 크롭을 **픽셀 정사각**으로 잡아(높이 = frac·aspect) 정사각 출력으로
 * 업스케일 시 번호판 왜곡이 없게 한다(x·y 독립 아핀이라 역계산은 왜곡 여부와 무관하게 정확).
 *
 * 클램프 규약(T-2): 창 크기는 유지하고 위치만 [0,1] 안으로 시프트(모서리 center 에서도 밖으로 안 나감).
 * 창이 프레임보다 크면(frac·aspect>1 등) 크기를 1 로 클램프한 뒤 0 에 정렬.
 */
export function computeCropWindow(center: NormalizedPoint, frac: number, aspect: number): NormalizedRect {
  const w = Math.min(1, frac);
  const h = Math.min(1, frac * aspect);
  // 창을 [0,1] 안에 유지: 좌상단을 [0, 1-size] 로 클램프(크기 보존 시프트).
  const x = Math.min(Math.max(center.x - w / 2, 0), 1 - w);
  const y = Math.min(Math.max(center.y - h / 2, 0), 1 - h);
  return { x, y, w, h };
}

/** 원본 정규화 점 p 를 크롭 창 W 의 정규화 좌표로 환산(아핀의 순방향, 설계서 §4). 창 밖이면 [0,1] 벗어남(그대로 반환). */
export function toCropPoint(p: NormalizedPoint, W: NormalizedRect): NormalizedPoint {
  return { x: (p.x - W.x) / W.w, y: (p.y - W.y) / W.h };
}

/** 크롭 정규화 quad → 원본 정규화 quad(아핀 역계산, 설계서 §2-1). 각 코너 독립: orig = W.xy + q·W.wh. */
export function backmapQuad(cropQuad: NormalizedQuad, W: NormalizedRect): NormalizedQuad {
  return cropQuad.map((q) => ({ x: W.x + q.x * W.w, y: W.y + q.y * W.h })) as unknown as NormalizedQuad;
}

/**
 * 격자 탐색용 크롭 중심 = 앵커에서 오프셋 이동한 점(설계서 §3-1). off 단위 = **창 크기 배수**(dx=창폭·dy=창높이배)
 * 라 줌이 깊어질수록 이동량이 자동 축소된다. 창 크기는 computeCropWindow 와 동일 정의(min(1,frac)·min(1,frac·aspect)).
 */
export function gridCenter(anchor: NormalizedPoint, frac: number, aspect: number, off: { dx: number; dy: number }): NormalizedPoint {
  return {
    x: anchor.x + off.dx * Math.min(1, frac),
    y: anchor.y + off.dy * Math.min(1, frac * aspect),
  };
}

/**
 * 원본 JPEG 에서 창 W(정규화)를 잘라 장변 outLongPx 로 업스케일한 JPEG 반환(sharp extract+resize).
 * 카메라 무이동 — 원본 프레임 재사용. 픽셀 경계는 반올림·클램프해 sharp extract 범위초과를 방어한다.
 */
export async function cropAndUpscale(jpeg: Buffer, W: NormalizedRect, outLongPx: number): Promise<Buffer> {
  const { width: imgW, height: imgH } = readJpegSize(jpeg);
  // 정규화 창 → 픽셀 창(반올림). extract 는 이미지 경계 안이어야 하므로 left+width ≤ imgW 로 클램프.
  let left = Math.round(W.x * imgW);
  let top = Math.round(W.y * imgH);
  let width = Math.max(1, Math.round(W.w * imgW));
  let height = Math.max(1, Math.round(W.h * imgH));
  left = Math.min(Math.max(left, 0), imgW - 1);
  top = Math.min(Math.max(top, 0), imgH - 1);
  width = Math.min(width, imgW - left);
  height = Math.min(height, imgH - top);

  // 장변 = outLongPx 로 스케일(종횡비 보존 — 정사각 크롭이면 정사각 출력, 왜곡 0).
  const scale = outLongPx / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  return sharp(jpeg)
    .extract({ left, top, width, height })
    .resize({ width: outW, height: outH, fit: 'fill' })
    .jpeg({ quality: 90 })
    .toBuffer();
}
