/**
 * 독립 검증용 대상 추적기 — **구현의 게인 추정에 의존하지 않는다**.
 *
 * 원리: 시작 PTZ 에서 목표 PTZ 까지 **아주 작은 스텝**(|dPan|,|dTilt| ≤ 1°, zoom 비 ≤ 1.2)으로 걸어가며
 * 매 스텝 직전 위치 최근접으로 대상을 잇는다. 1° 변위는 번호판 간격의 36%(실측, zoom 무관 — 변위·간격 모두 ∝ z)
 * 라 스텝마다 대응이 모호하지 않다. 게인의 부호·크기를 몰라도 성립하므로 구현과 독립이다.
 *
 * 검증 하네스 전용(프로덕션 아님). 리더가 goal 수치를 관측하는 데만 쓴다.
 */
import type { ICameraClient } from '../../../src/clients/CameraClient.js';
import type { LpdClient } from '../../../src/clients/LpdClient.js';
import { quadBoundingRect } from '../../../src/domain/geometry.js';
import type { Ptz } from '../../../src/calibrate/types.js';

export interface Obs {
  cx: number;
  cy: number;
  w: number;
}

export async function observeAll(camera: ICameraClient, lpd: LpdClient, ptz: Ptz): Promise<Obs[]> {
  const cap = await camera.requestImage(1, 1, ptz);
  await new Promise((r) => setTimeout(r, 300));
  return (await lpd.detect(cap.jpg)).map((p) => {
    const r = quadBoundingRect(p.quad);
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w };
  });
}

/** from → to 를 잇는 미세 스텝 경로(|dPan|,|dTilt| ≤ 1°, zoom 비 ≤ 1.2). */
function path(from: Ptz, to: Ptz): Ptz[] {
  const n = Math.max(
    Math.ceil(Math.abs(to.pan - from.pan) / 1.0),
    Math.ceil(Math.abs(to.tilt - from.tilt) / 1.0),
    Math.ceil(Math.abs(Math.log(to.zoom / from.zoom) / Math.log(1.2))),
    1,
  );
  const out: Ptz[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push({
      pan: from.pan + (to.pan - from.pan) * t,
      tilt: from.tilt + (to.tilt - from.tilt) * t,
      zoom: from.zoom * Math.pow(to.zoom / from.zoom, t),
    });
  }
  return out;
}

export interface TrackResult {
  found: boolean;
  cx: number;
  cy: number;
  w: number;
  /** 2순위 후보와의 거리(작으면 추적 모호 — 관측 신뢰도). */
  margin: number;
  steps: number;
  note?: string;
}

/**
 * from 의 target 을 to 까지 추적한다.
 * 매칭 반경·모호성 판정은 zoom 에 비례해 스케일(방사 확대로 장면 전체가 z 배 벌어지므로).
 */
export async function trackTarget(
  camera: ICameraClient,
  lpd: LpdClient,
  from: Ptz,
  target: Obs,
  to: Ptz,
): Promise<TrackResult> {
  let cur = { ...target };
  let curPtz = from;
  let margin = Infinity;
  const steps = path(from, to);

  for (const ptz of steps) {
    const list = await observeAll(camera, lpd, ptz);
    if (list.length === 0) return { found: false, cx: cur.cx, cy: cur.cy, w: cur.w, margin, steps: steps.length, note: '검출 0' };
    // 반경: 실측 번호판 간격 0.15@z1.69 의 40% 를 zoom 비례로 확대.
    const radius = 0.06 * (ptz.zoom / 1.69341);
    const sorted = list
      .map((p) => ({ p, d: Math.hypot(p.cx - cur.cx, p.cy - cur.cy) }))
      .sort((a, b) => a.d - b.d);
    if (sorted[0].d > radius) {
      return { found: false, cx: cur.cx, cy: cur.cy, w: cur.w, margin, steps: steps.length, note: `대상 이탈(최근접 ${sorted[0].d.toFixed(3)} > 반경 ${radius.toFixed(3)}) @ptz=${JSON.stringify(ptz)}` };
    }
    if (sorted[1]) margin = Math.min(margin, sorted[1].d - sorted[0].d);
    cur = sorted[0].p;
    curPtz = ptz;
  }
  void curPtz;
  return { found: true, cx: cur.cx, cy: cur.cy, w: cur.w, margin, steps: steps.length };
}

/** 화면 중심 최근접 = 초기 대상 선정 기준(구현의 plateRoi 기본 prior 와 동일). 시작 프레임에서만 쓴다. */
export function pickInitialTarget(list: Obs[]): Obs {
  return list.reduce((a, b) => (Math.hypot(a.cx - 0.5, a.cy - 0.5) <= Math.hypot(b.cx - 0.5, b.cy - 0.5) ? a : b));
}
