// 주차면 quad 사용가능 진단(거부 **사유** 산출 전용). 순수·throw 금지.
//
// ★ 판정(verdict)은 이 파일이 만들지 않는다 — `isUsableQuad` 하나가 유일한 원천이다(재구현 금지 규약).
//   여기서 하는 일은 (a) 그 판정 결과를 그대로 받고 (b) **왜** 떨어졌는지 사람이 읽을 문장을 붙이는 것뿐이다.
//   임계값도 `groundModel.ts` 의 MIN_EDGE_PX / MIN_AREA_PX 를 import 한다(숫자 중복 0).

import { isUsableQuad, MIN_EDGE_PX, MIN_AREA_PX } from './groundModel.js';
import type { PixelQuad } from './types.js';

/** quad 진단 결과. ok 는 isUsableQuad 그대로, reasons 는 ok===false 일 때만 붙는 부가 설명. */
export interface QuadDiag {
  ok: boolean;
  reasons: string[];
  metrics: { minEdgePx: number; areaPx2: number; convex: boolean };
}

/** 소수 1자리 표기(사용자 문장용 — 픽셀 수치는 정밀도가 목적이 아니다). */
function fx(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '?';
}

/**
 * 픽셀 quad → 사용가능 판정 + 거부 사유 문장.
 * 4점·유한이 아니면 metrics 는 산출 불가 값(minEdgePx=0, areaPx2=0, convex=false)으로 둔다.
 */
export function diagnoseQuad(quad: PixelQuad): QuadDiag {
  const ok = isUsableQuad(quad);
  const shapeOk =
    Array.isArray(quad) &&
    quad.length === 4 &&
    quad.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!shapeOk) {
    return {
      ok,
      reasons: ok ? [] : ['점이 4개가 아니거나 좌표가 숫자가 아닙니다'],
      metrics: { minEdgePx: 0, areaPx2: 0, convex: false },
    };
  }

  let minEdgePx = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    minEdgePx = Math.min(minEdgePx, Math.hypot(b.x - a.x, b.y - a.y));
  }
  // 신발끈 공식(면적 산출 — 판정이 아니라 표시용 수치).
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area2 += a.x * b.y - b.x * a.y;
  }
  const areaPx2 = Math.abs(area2) / 2;

  let pos = 0;
  let neg = 0;
  let collinear = false;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z > 0) pos += 1;
    else if (z < 0) neg += 1;
    else collinear = true;
  }
  const convex = !collinear && (pos === 4 || neg === 4);

  const reasons: string[] = [];
  if (!ok) {
    if (minEdgePx < MIN_EDGE_PX) {
      reasons.push(`변이 너무 짧습니다(최단 ${fx(minEdgePx)}px < ${MIN_EDGE_PX}px) — 더 크게 그리세요`);
    }
    if (areaPx2 < MIN_AREA_PX) {
      reasons.push(`면적이 너무 작습니다(${fx(areaPx2)}px² < ${MIN_AREA_PX}px²)`);
    }
    if (collinear) {
      reasons.push('세 점이 일직선입니다 — 사다리꼴 모양이 되게 찍으세요');
    } else if (!convex) {
      reasons.push('폴리곤이 꼬였습니다(자기교차) — 네 점을 시계 또는 반시계 한 방향으로 찍으세요');
    }
    if (!reasons.length) reasons.push('사용할 수 없는 사각형입니다');
  }
  return { ok, reasons, metrics: { minEdgePx, areaPx2, convex } };
}
