import type { NormalizedRect } from '../domain/types.js';
import { center } from '../domain/geometry.js';

/**
 * 이미지 내 사각형들을 "상→하 밴드(행), 같은 밴드 내 좌→우" 순서로 정렬한 인덱스를 반환.
 * 전역 슬롯 인덱스 정렬 규칙(아키텍처 §7)의 "프리셋 이미지 내 위치" 부분과 동일 규칙.
 *
 * yBandTolerance: 두 사각형의 중심 y 차이가 이 값 이하면 같은 행으로 간주(정규화 좌표).
 * 반환: 입력 배열에 대한 정렬된 원본 인덱스 목록.
 */
export function orderByPosition(rects: NormalizedRect[], yBandTolerance: number): number[] {
  const items = rects.map((r, i) => ({ i, ...center(r) }));
  // 1) y 오름차순으로 정렬해 밴드를 형성.
  items.sort((a, b) => a.cy - b.cy);

  // 2) 밴드(행) 분할: 직전 밴드 기준 y 와의 차이가 tolerance 초과면 새 밴드.
  const bands: Array<typeof items> = [];
  for (const it of items) {
    const band = bands[bands.length - 1];
    if (!band || Math.abs(it.cy - band[0].cy) > yBandTolerance) {
      bands.push([it]);
    } else {
      band.push(it);
    }
  }

  // 3) 각 밴드 내부는 x 오름차순(좌→우).
  const ordered: number[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.cx - b.cx);
    for (const it of band) ordered.push(it.i);
  }
  return ordered;
}
