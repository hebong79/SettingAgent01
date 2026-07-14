// 라이브 검출용 FOV↔zoom 변환·재중심 PTZ·역투영 — 결정형 순수 모듈(설계서 §04-A). 외부 의존 0.
// 정규화 좌표 (u,v)∈[0,1] 좌상단 원점(u→우 / v→하), pan/tilt 는 도(°), zoom 은 배율. vitest 대상.
//
// [실측 확정] tiltSign=+1 / panSign=+1 / frontBias 는 호출측 상수(설계 §04-A2·A3, §6).
//   tilt↑ 시 지면점이 화면 위로(카메라 하향) → 하단 차량(cy>0.5)을 tilt 증가로 중심화.
// [실측 한계] 역투영은 지면 원근으로 y축 계통 오차(~10~12%)가 남는 근사 — 정밀 추구하지 않음(표시·귀속용).

import type { NormalizedPoint, NormalizedQuad, NormalizedRect } from '../domain/types.js';

const DEG = Math.PI / 180;

/** FOV↔zoom 변환 파라미터(수직 fov 기준, Unity Camera.fieldOfView=vertical 가정). */
export interface FovOpts {
  /**
   * zoom=zoomRef(=1) 일 때의 수직 FOV(도).
   * ⚠️ `PtzCamRoi.json` 의 `camera.fov` 가 **아니다** — 그것은 저장 시점 zoom 에서의 fov 스냅샷이라 zoom 이 걸려 있다.
   * 지면모델 공동추정(detectPipeline.loadDetectCfg)에서 얻는다 — 실카메라 호환(C3).
   */
  fovBaseV: number;
  /** fovBaseV 기준 zoom(=1 가정). */
  zoomRef: number;
  /** 종횡비 W/H(=imageWidth/imageHeight). */
  aspect: number;
}

/** 재중심+zoom PTZ 산출 파라미터. */
export interface CenterOpts extends FovOpts {
  /** 앞쪽(번호판) 타깃 비율(>0.5=하단=앞). */
  frontBias: number;
  /** base.zoom 대비 확대 배율. */
  zoomFactor: number;
}

/** 수직 FOV(도). zoom↑ → fov↓ 단조. */
export function fovV(zoom: number, opts: FovOpts): number {
  return (2 * Math.atan((Math.tan((opts.fovBaseV * DEG) / 2) * opts.zoomRef) / zoom)) / DEG;
}

/** 수평 FOV(도). 수직 FOV 에 aspect 적용. */
export function fovH(zoom: number, opts: FovOpts): number {
  return (2 * Math.atan(Math.tan((fovV(zoom, opts) * DEG) / 2) * opts.aspect)) / DEG;
}

/**
 * 차량 rect 앞쪽(하단)을 화면 중심으로 당기고 zoom 확대하는 PTZ 산출.
 * 순수함수 — clampZoom 미포함(클램프는 호출측 camera.clampZoom).
 */
export function vehicleCenterZoomPtz(
  rect: { x: number; y: number; w: number; h: number },
  base: { pan: number; tilt: number; zoom: number },
  opts: CenterOpts,
): { pan: number; tilt: number; zoom: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h * opts.frontBias; // 앞쪽(하단) 타깃점.
  return {
    pan: base.pan + (cx - 0.5) * fovH(base.zoom, opts), // panSign=+ (pan↑=우)
    tilt: base.tilt + (cy - 0.5) * fovV(base.zoom, opts), // tiltSign=+ (실측): 하단 차량 → tilt 증가로 중심화
    zoom: base.zoom * opts.zoomFactor,
  };
}

/**
 * zoom-in 뷰 정규화 점(view) → base 프리셋 정규화 좌표로 역투영(중심고정 FOV 선형).
 * view/viewPtz 는 뷰 응답 실적용값, base/basePtz 는 base 프리셋 값.
 */
export function inverseProjectPoint(
  view: NormalizedPoint,
  viewPtz: { pan: number; tilt: number; zoom: number },
  base: { pan: number; tilt: number; zoom: number },
  opts: FovOpts,
): NormalizedPoint {
  const wp = viewPtz.pan + (view.x - 0.5) * fovH(viewPtz.zoom, opts);
  const wt = viewPtz.tilt + (view.y - 0.5) * fovV(viewPtz.zoom, opts); // tilt항 부호(+) — vehicleCenterZoomPtz 와 대칭
  return {
    x: 0.5 + (wp - base.pan) / fovH(base.zoom, opts),
    y: 0.5 + (wt - base.tilt) / fovV(base.zoom, opts),
  };
}

/** base 정규화 점 → zoom-in 뷰 정규화 좌표(inverseProjectPoint 의 역방향, 라운드트립 테스트 전용). */
export function projectBaseToView(
  point: NormalizedPoint,
  viewPtz: { pan: number; tilt: number; zoom: number },
  base: { pan: number; tilt: number; zoom: number },
  opts: FovOpts,
): NormalizedPoint {
  const wp = base.pan + (point.x - 0.5) * fovH(base.zoom, opts);
  const wt = base.tilt + (point.y - 0.5) * fovV(base.zoom, opts);
  return {
    x: 0.5 + (wp - viewPtz.pan) / fovH(viewPtz.zoom, opts),
    y: 0.5 + (wt - viewPtz.tilt) / fovV(viewPtz.zoom, opts),
  };
}

/** 뷰 quad(4점) → base 정규화 quad 역투영(inverseProjectPoint 4회). */
export function inverseProjectQuad(
  quad: NormalizedQuad,
  viewPtz: { pan: number; tilt: number; zoom: number },
  base: { pan: number; tilt: number; zoom: number },
  opts: FovOpts,
): NormalizedQuad {
  return quad.map((p) => inverseProjectPoint(p, viewPtz, base, opts)) as NormalizedQuad;
}

/**
 * 역투영된(recovered) quad 의 중심을 연관 vehicle rect(정규화, top-left+w/h) 안으로 클램프.
 * 지면 원근으로 인한 역투영 y축 계통 오차(§04-A3 실측 한계)가 커서 복원 번호판이 차량 밖(빈 주차공간 등)에
 * 표시되는 문제를 보정 — "어느 차량에서 zoom-in 했는지 정확히 안다"는 사실을 활용해 표시 위치만 차량 위로 고정한다.
 * 모양·크기·각도는 보존(평행이동만). 중심이 이미 rect 안이면 무변경(양호한 역산은 그대로 유지).
 * y 클램프는 상단(top) 이탈 시 rect 상단이 아니라 앞쪽(전면=하단, frontBias) 근방으로 당긴다(차량 위 번호판 위치 근사).
 * 하단 이탈은 자연히 rect 하단 경계로 클램프된다.
 */
export function clampQuadCenterToRect(quad: NormalizedQuad, rect: NormalizedRect, frontBias = 0.62): NormalizedQuad {
  const cx = quad.reduce((s, p) => s + p.x, 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
  const xMin = rect.x;
  const xMax = rect.x + rect.w;
  const yMin = rect.y;
  const yMax = rect.y + rect.h;
  if (cx >= xMin && cx <= xMax && cy >= yMin && cy <= yMax) return quad; // 이미 rect 안 — 무변경.
  const clampedCx = Math.min(xMax, Math.max(xMin, cx));
  const yLowerBound = cy < yMin ? rect.y + rect.h * frontBias : yMin; // 상단 이탈 시 전면 근방으로.
  const clampedCy = Math.min(yMax, Math.max(yLowerBound, cy));
  const dx = clampedCx - cx;
  const dy = clampedCy - cy;
  if (dx === 0 && dy === 0) return quad;
  return quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as NormalizedQuad;
}
