// 캘리브레이션 제어 수학 — 결정형 순수 모듈(설계서 §1.2). 외부 의존 0.
// 좌표는 정규화(0~1), pan/tilt 는 도(°), zoom 은 배율. vitest 단위 검증 대상.
// 핵심: probe 1회로 부호 포함 게인 추정 → P 제어 → zoom 공식. FOV 불요·부호 무관.

import type { NormalizedRect } from '../domain/types.js';
import { quadBoundingRect } from '../domain/geometry.js';
import type { PlateBox } from '../clients/LpdClient.js';
import type { SlotPtzItem, SlotPtzArtifact } from './types.js';

/** 번호판 중심 오프셋(화면 중앙 0.5 기준). errX>0=오른쪽, errY>0=아래쪽. */
export function plateCenterError(rect: NormalizedRect): { errX: number; errY: number } {
  return { errX: rect.x + rect.w / 2 - 0.5, errY: rect.y + rect.h / 2 - 0.5 };
}

/** 다수 번호판 중 대상 prior 중심에 가장 가까운 1개(중심 유클리드 거리 최소). 빈 배열 → null. */
export function pickNearestPlate(plates: PlateBox[], target: NormalizedRect): PlateBox | null {
  if (plates.length === 0) return null;
  const tcx = target.x + target.w / 2;
  const tcy = target.y + target.h / 2;
  let best: PlateBox | null = null;
  let bestD = Infinity;
  for (const p of plates) {
    const pr = quadBoundingRect(p.quad);
    const cx = pr.x + pr.w / 2;
    const cy = pr.y + pr.h / 2;
    const d = (cx - tcx) ** 2 + (cy - tcy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** probe 이동 미미 판정 임계(분모≈0). */
const GAIN_EPS = 1e-4;

/**
 * probe 이동 전후 변위로 °/정규화 게인 추정(부호 포함).
 * gain = 명령한 도 변화 / 관측된 정규화 변위. 변위 미미(분모≈0)면 fallback 게인 반환.
 */
export function estimateGain(
  beforeErr: { errX: number; errY: number },
  afterErr: { errX: number; errY: number },
  probeDeltaDeg: { dPan: number; dTilt: number },
  fallback: { gainPan: number; gainTilt: number },
): { gainPan: number; gainTilt: number } {
  const dX = afterErr.errX - beforeErr.errX;
  const dY = afterErr.errY - beforeErr.errY;
  const gainPan = Math.abs(dX) > GAIN_EPS && probeDeltaDeg.dPan !== 0 ? probeDeltaDeg.dPan / dX : fallback.gainPan;
  const gainTilt = Math.abs(dY) > GAIN_EPS && probeDeltaDeg.dTilt !== 0 ? probeDeltaDeg.dTilt / dY : fallback.gainTilt;
  return { gainPan, gainTilt };
}

/**
 * P 제어: 오차를 0 으로 보내는 pan/tilt 절대값. 부호는 gain 에 흡수(probe 측정).
 * 1스텝 보정량은 ±maxStepDeg 로 클램프(진동 방지).
 */
export function panTiltCorrection(
  err: { errX: number; errY: number },
  gain: { gainPan: number; gainTilt: number },
  curPan: number,
  curTilt: number,
  maxStepDeg: number,
): { pan: number; tilt: number } {
  // P 제어: newPan = curPan - errX*gainPan(부호는 probe 측정 gain 에 흡수). 스텝 ±maxStepDeg 클램프.
  const dPan = clampStep(-err.errX * gain.gainPan, maxStepDeg);
  const dTilt = clampStep(-err.errY * gain.gainTilt, maxStepDeg);
  return { pan: curPan + dPan, tilt: curTilt + dTilt };
}

function clampStep(v: number, maxStep: number): number {
  return Math.min(maxStep, Math.max(-maxStep, v));
}

/** 폭 ∝ zoom 선형 근사: newZoom = clampZoom(curZoom * sqrt(target/cur)). plateWidth≈0 방어. */
export function zoomCorrection(
  curZoom: number,
  plateWidth: number,
  targetWidth: number,
  clampZoom: (z: number) => number,
): number {
  if (plateWidth <= GAIN_EPS) return clampZoom(curZoom);
  return clampZoom(curZoom * Math.sqrt(targetWidth / plateWidth));
}

/**
 * 폭 ∝ zoom 선형 **직접 목표**(게인무관): targetZoom = curZoom × targetWidth/curWidth.
 * `zoomCorrection` 의 sqrt 는 반복 감쇠 스텝(진동 안정용)이라 별개 — 이건 감쇠 없는 1발 목표산출.
 * curWidth≈0(퇴화 lpd) 가드 → clampZoom(curZoom). clampZoom 로 zoom 상한(1~36) 적용.
 * ★ 시그니처에 gain 부재 = 게인 무의존을 구조적으로 보장(설계 §A-1). "먼저 확대해 찾기"의 목표 zoom 산출.
 */
export function zoomForWidth(
  curZoom: number,
  curWidth: number,
  targetWidth: number,
  clampZoom: (z: number) => number,
): number {
  if (curWidth <= GAIN_EPS) return clampZoom(curZoom);
  return clampZoom(curZoom * (targetWidth / curWidth));
}

/** 중심 수렴 판정. */
export function isCentered(err: { errX: number; errY: number }, centerTol: number): boolean {
  return Math.abs(err.errX) <= centerTol && Math.abs(err.errY) <= centerTol;
}

/** 폭 수렴 판정. */
export function isWidthConverged(plateWidth: number, targetWidth: number, widthTol: number): boolean {
  return Math.abs(plateWidth - targetWidth) <= widthTol;
}

/** 개선 정체 시 게인 감쇠(진동 방지). factor∈(0,1]. */
export function dampGain(gain: { gainPan: number; gainTilt: number }, factor = 0.5): { gainPan: number; gainTilt: number } {
  return { gainPan: gain.gainPan * factor, gainTilt: gain.gainTilt * factor };
}

/** 최종 JSON 조립(설계서 §2 스키마). */
export function buildSlotPtzJson(items: SlotPtzItem[], now: string): SlotPtzArtifact {
  return { createdAt: now, items };
}

// ─────────────────────────────────────────────────────────────────────────────
// r1 추가(01_architect_plan §2.5/§2.6) — 기존 함수·시그니처·동작 무변경, 순수 함수 추가만.
// 라이브 실측이 드러낸 물리 2건(게인의 zoom 종속 · 대상 신원 추적)을 위한 수학.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 게인의 zoom 스케일: 게인[°/정규화] ∝ FOV ∝ 1/zoom → gain(z) = gain(zRef)·zRef/z.
 * 실측: gainPan≈−36.6, gainTilt≈−21.0 (zoom 1.69341 기준 — 둘 다 ★음수) → zoom 20 에서 약 1/12.
 *   출처: 라이브 diagSweep 전체목록 공통변위(구현 probe 라이브 측정 −37.1/−21.2 와 일치).
 *   ★ 이 값은 특정 시뮬 카메라(cam1)의 실측이며 게인은 장비마다(FOV·센서·마운트) 다르다.
 * 게인은 항상 측정 기준 zoom(zoomRef)을 달고 다니며, 사용 시점 zoom 으로 스케일해서 쓴다.
 */
export function scaleGainForZoom(
  gain: { gainPan: number; gainTilt: number; zoomRef: number },
  zoom: number,
): { gainPan: number; gainTilt: number } {
  const k = gain.zoomRef / zoom;
  return { gainPan: gain.gainPan * k, gainTilt: gain.gainTilt * k };
}

/**
 * pan/tilt 명령 후 번호판 중심 예측: c' = c + dDeg/gain (estimateGain 의 역산).
 * |gain|≈0 이면 해당 축은 예측 불가 → 직전 중심 유지.
 */
export function predictPlateCenter(
  center: { cx: number; cy: number },
  deltaDeg: { dPan: number; dTilt: number },
  gain: { gainPan: number; gainTilt: number },
): { cx: number; cy: number } {
  const cx = Math.abs(gain.gainPan) > GAIN_EPS ? center.cx + deltaDeg.dPan / gain.gainPan : center.cx;
  const cy = Math.abs(gain.gainTilt) > GAIN_EPS ? center.cy + deltaDeg.dTilt / gain.gainTilt : center.cy;
  return { cx, cy };
}

/**
 * zoom 명령 후 번호판 중심 예측: 화면 중심 기준 방사 확대 c' = 0.5 + (c−0.5)·zNew/zOld.
 * zoomFrom≈0 이면 예측 불가 → 직전 중심 유지.
 */
export function predictCenterAfterZoom(
  center: { cx: number; cy: number },
  zoomFrom: number,
  zoomTo: number,
): { cx: number; cy: number } {
  if (Math.abs(zoomFrom) <= GAIN_EPS) return { cx: center.cx, cy: center.cy };
  const k = zoomTo / zoomFrom;
  return { cx: 0.5 + (center.cx - 0.5) * k, cy: 0.5 + (center.cy - 0.5) * k };
}
