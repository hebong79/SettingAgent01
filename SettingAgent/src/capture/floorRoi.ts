// 바닥 점유 영역(floor ROI · 4점 사변형) 결정형 순수 모듈 (설계서 §4).
// 외부 의존 0 — 좌표 클램프·순서 정규화·폴백 사변형. floor ROI 가 항상 존재함을 보장한다.
// 좌표는 모두 정규화(0~1). 순서 규약: [앞왼, 앞오, 뒤오, 뒤왼](앞=이미지 하단/카메라 근접, 시계방향).

import type { NormalizedRect, NormalizedQuad, NormalizedPoint } from '../domain/types.js';

/** 폴백 사변형의 하단 밴드 비율(차량 bbox 하단 35%를 접지면 근사). */
const FALLBACK_BAND = 0.35;
/** 폴백 윗변의 좌우 inset 비율(원근상 뒤쪽이 좁아 보이는 근사). */
const FALLBACK_INSET = 0.1;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 차량 bbox 하단부를 지면 근사한 폴백 사변형. floor ROI 항상 존재 보장.
 * 바닥 변 y=`y+h`, 윗 변 y=`y+h*(1-band)`. 윗 변은 원근상 좁으므로 좌우 inset.
 */
export function fallbackQuadFromRect(r: NormalizedRect): NormalizedQuad {
  const left = r.x;
  const right = r.x + r.w;
  const bottomY = clamp01(r.y + r.h);
  const topY = clamp01(r.y + r.h * (1 - FALLBACK_BAND));
  const inset = r.w * FALLBACK_INSET;
  const innerLeft = clamp01(left + inset);
  const innerRight = clamp01(right - inset);
  // [앞왼, 앞오, 뒤오, 뒤왼] — 앞(하단)은 넓게, 뒤(상단)는 inset.
  return [
    { x: clamp01(left), y: bottomY },
    { x: clamp01(right), y: bottomY },
    { x: innerRight, y: topY },
    { x: innerLeft, y: topY },
  ];
}

/**
 * LLM raw quad → 유효 NormalizedQuad. 점!=4·NaN·전부 범위초과면 null(호출측이 폴백).
 * 그 외엔 각 점 0~1 클램프 + 순서 정규화(앞=y큰 두 점, 뒤=y작은 두 점; 각 쌍 x로 좌/우).
 */
export function normalizeQuad(raw: Array<{ x: number; y: number }> | undefined | null): NormalizedQuad | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const pts: NormalizedPoint[] = [];
  for (const p of raw) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || Number.isNaN(p.x) || Number.isNaN(p.y)) {
      return null;
    }
    pts.push({ x: clamp01(p.x), y: clamp01(p.y) });
  }
  // 순서 강제: y 기준 하(앞)/상(뒤) 분리 → 각 쌍 x 기준 좌/우.
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const rear = byY.slice(0, 2); // y 작음(이미지 위 = 뒤)
  const front = byY.slice(2); // y 큼(이미지 아래 = 앞)
  const [frontLeft, frontRight] = front[0].x <= front[1].x ? [front[0], front[1]] : [front[1], front[0]];
  const [rearLeft, rearRight] = rear[0].x <= rear[1].x ? [rear[0], rear[1]] : [rear[1], rear[0]];
  return [frontLeft, frontRight, rearRight, rearLeft];
}

/** 최종 진입점: LLM 결과 quad(또는 null) + 차량 rect → 항상 NormalizedQuad. */
export function resolveFloorQuad(
  llmQuad: Array<{ x: number; y: number }> | undefined | null,
  vehicle: NormalizedRect,
): NormalizedQuad {
  return normalizeQuad(llmQuad) ?? fallbackQuadFromRect(vehicle);
}
