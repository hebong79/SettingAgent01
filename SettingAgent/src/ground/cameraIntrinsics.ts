// 카메라 제원 → 지면모델 주입(순수 · IO 0).
//
// ★ 3회차 경로 교체의 핵심(리더 루프2 판정): **f 를 이미지에서 추정하지 않는다.**
//
// 2회차 실측이 근거다 — f 오차와 IoU 가 정확히 대응했다:
//     1:1  f −0.66%  → IoU 0.48908      (유일하게 f 가 맞은 프리셋 = 유일하게 0 이 아닌 프리셋)
//     1:2  f −54.9%  → IoU 0.00000
//     2:1  f −83.7%  → IoU 0.00000
//     2:2  f −71.8%  → IoU 0.00000
// 원인은 잡음이 아니라 기하다: 차량이 분리선을 가려 검출 스텁이 평균 24px 이고,
// 24px 선분의 각도 불확실도(±2.4°)는 소실점을 수천 px 날린다. cam2 는 참 f 가 5651px 인데
// 그 스텁으로는 923~1594px 밖에 나오지 않았다(3.5~6배 오차). **회수 불가능한 값을 추정하고 있었다.**
//
// f·tilt·설치고는 전부 **카메라 사실**이며 주차면 정답이 아니다 → R1(hold-out) 위반이 아니다.
// 실카 공급원: fov ← `data/lens_calibration.json` 의 `zoomHfov` 실측표 / tilt ← PTZ 피드백 / 설치고 ← 줄자 1회 실측.
// (설계서 `docs/20260727_202948_*.md` §3 "경로 B(무드로잉)" 가 이 경로이며 정당성 논증이 그 문서에 있다.)
//
// ★ 인터페이스를 먼저 정의하고 구현을 끼운다 — 시뮬 전용 코드가 되면 R10 위반이다.

import type { GroundModel } from './types.js';

/** 프리셋 1개의 카메라 제원. 이미지에서 추정하지 않고 **주입**되는 값이다. */
export interface PresetIntrinsics {
  camIdx: number;
  presetIdx: number;
  /** 화각(도). */
  fovDeg: number;
  /** 화각의 축. Unity `fieldOfView` 는 수직, RTSP 렌즈표(`zoomHfov`)는 수평이다. */
  fovAxis: 'vertical' | 'horizontal';
  /** 하향 틸트(도). 지평선 기준 아래로 내려다본 각. */
  tiltDeg: number;
  /** 카메라 설치고(m) — metric 스케일의 유일한 담지자. */
  heightM: number;
  imgW: number;
  imgH: number;
  /** 이 값이 어디서 왔는가(응답·진단에 그대로 노출). */
  source: string;
  /**
   * ★ 20회차 — `fovDeg` 가 **어느 줌에서의 화각인가**.
   *   생략(undefined) = 그 프레임의 **유효 화각**(종전 전부 이 뜻. 실카 `zoomHfov` 표가 이쪽).
   *   'zoom1'        = **줌 1 기준** 화각. 유효 f 는 `f@zoom1 × zoom`.
   *
   * 전역으로 `×zoom` 하지 않는 이유: 실카는 `interpolateHfov(zoomHfov, zoomRaw)` 가 이미
   * **그 줌에서의 유효 화각**을 준다. 거기에 또 곱하면 17회차에 고친 ×4.64 오류가 종류만 바꿔 재발한다.
   * 그래서 "이 화각이 줌1 기준인가"를 값 자신이 들고 다닌다.
   */
  fovAtZoom?: 'zoom1';
}

/**
 * 제원 공급자. 구현체는 시뮬/실카 각각 따로 두고, 기하 코드는 이 인터페이스만 안다.
 * 미상이면 **null**(throw 금지 — 저장소 강등 철학).
 */
export interface CameraIntrinsicsProvider {
  /** 진단·보고용 식별자. */
  readonly id: string;
  get(camIdx: number, presetIdx: number): PresetIntrinsics | null;
}

const DEG = Math.PI / 180;

/** 화각 → 초점거리(px). 축에 맞는 변을 쓴다. 비정상 입력 → null. */
export function focalPxOf(i: PresetIntrinsics): number | null {
  if (!(i.fovDeg > 0) || !(i.fovDeg < 180)) return null;
  const side = i.fovAxis === 'vertical' ? i.imgH : i.imgW;
  if (!(side > 0)) return null;
  const t = Math.tan((i.fovDeg * DEG) / 2);
  if (!Number.isFinite(t) || t <= 0) return null;
  const f = side / 2 / t;
  return Number.isFinite(f) && f > 0 ? f : null;
}

/**
 * 이 프레임의 **유효** 초점거리(px). `fovAtZoom==='zoom1'` 일 때만 `zoom` 을 곱한다.
 *
 * zoom 이 유한 양수가 아니면 **null** 이다 — 1 로 대체하지 않는다(조용한 배율 오류의 원인이었다).
 */
export function focalPxAtZoom(i: PresetIntrinsics, zoom: number): number | null {
  const f0 = focalPxOf(i);
  if (f0 == null) return null;
  if (i.fovAtZoom !== 'zoom1') return f0;
  if (!Number.isFinite(zoom) || !(zoom > 0)) return null;
  const f = f0 * zoom;
  return Number.isFinite(f) && f > 0 ? f : null;
}

/**
 * 제원 → `GroundModel`(f, n, d). 투영은 기존 `project.ts` 가 그대로 쓴다(신규 투영 수학 0줄).
 *
 * 법선 부호 규약(`groundGrid.test.ts` 에서 실측으로 확인): 카메라를 아래로 t 만큼 내려다보면
 * world-down 은 카메라 z 성분이 **양수**다 → `n = [0, cos t, +sin t]`. 부호를 뒤집으면 역투영이
 * 카메라 뒤 점을 내놓아 전 파이프라인이 조용히 죽는다.
 */
export function groundModelFromIntrinsics(i: PresetIntrinsics, zoom: number): GroundModel | null {
  const f = focalPxAtZoom(i, zoom);
  if (f == null) return null;
  if (!(i.heightM > 0) || !Number.isFinite(i.tiltDeg)) return null;
  const t = i.tiltDeg * DEG;
  const n: [number, number, number] = [0, Math.cos(t), Math.sin(t)];
  if (!(n[2] > 0)) return null; // 수평·상향 시선은 지면을 만나지 않는다.
  return {
    camIdx: i.camIdx,
    presetIdx: i.presetIdx,
    imgW: i.imgW,
    imgH: i.imgH,
    zoom,
    f,
    n,
    d: i.heightM,
    tiltDeg: i.tiltDeg,
    ptzTiltDeg: i.tiltDeg,
    tiltErrDeg: 0,
    slotBearingDeg: null,
    bearingDevDeg: null,
    dDevRel: null,
    depthEdgePx: 0,
    metricErr: 0,
    conf: 1,
    source: 'auto',
    issues: [
      `지면모델 주입: ${i.source} (${
        i.fovAtZoom === 'zoom1'
          ? `기준화각 ${i.fovDeg.toFixed(3)}° ${i.fovAxis} @zoom1 × zoom ${zoom}`
          : `fov ${i.fovDeg.toFixed(3)}° ${i.fovAxis}`
      }, tilt ${i.tiltDeg.toFixed(2)}°, 설치고 ${i.heightM}m → f ${f.toFixed(1)}px)`,
    ],
  };
}

/** 여러 공급자를 순서대로 시도(앞이 우선). 실카 공급자를 앞에 두고 시뮬을 폴백으로 둘 수 있다. */
export function chainProviders(...providers: readonly CameraIntrinsicsProvider[]): CameraIntrinsicsProvider {
  return {
    id: providers.map((p) => p.id).join('>'),
    get(camIdx, presetIdx) {
      for (const p of providers) {
        const r = p.get(camIdx, presetIdx);
        if (r) return r;
      }
      return null;
    },
  };
}

/** 고정 목록 공급자(테스트·설정 주입용). */
export function staticProvider(id: string, entries: readonly PresetIntrinsics[]): CameraIntrinsicsProvider {
  return {
    id,
    get: (camIdx, presetIdx) => entries.find((e) => e.camIdx === camIdx && e.presetIdx === presetIdx) ?? null,
  };
}

// ── 실카 공급자 — 렌즈 실측표 보간 ─────────────────────────────────
/** `lens_calibration.json` 의 `zoomHfov` 한 점(z=줌 원시값, h=수평 화각 도). */
export interface ZoomHfovPoint {
  z: number;
  h: number;
}

/** 줌 → 수평화각 선형보간. 표 밖은 양 끝으로 클램프. 표가 비면 null. */
export function interpolateHfov(table: readonly ZoomHfovPoint[], z: number): number | null {
  const pts = table.filter((p) => Number.isFinite(p.z) && Number.isFinite(p.h)).sort((a, b) => a.z - b.z);
  if (!pts.length) return null;
  if (z <= pts[0].z) return pts[0].h;
  if (z >= pts[pts.length - 1].z) return pts[pts.length - 1].h;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (z >= a.z && z <= b.z) {
      const w = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z);
      return a.h + (b.h - a.h) * w;
    }
  }
  return pts[pts.length - 1].h;
}

/** 실카 공급자에 필요한 카메라별 상태(호출자가 PTZ 피드백·설정에서 채운다). */
export interface RealCameraState {
  camIdx: number;
  presetIdx: number;
  /** 렌즈표 조회에 쓸 줌 원시값. */
  zoomRaw: number;
  /** PTZ 가 보고한 하향 틸트(도). */
  tiltDeg: number;
}

/**
 * 실카 공급자 — `zoomHfov` 실측표 보간 + PTZ tilt + 설정 설치고.
 * **시뮬 구현과 같은 인터페이스를 만족한다**(R10: 시뮬 전용 경로를 만들지 않는다).
 */
export function lensCalibrationProvider(deps: {
  id?: string;
  zoomHfov: readonly ZoomHfovPoint[];
  states: readonly RealCameraState[];
  heightM: number;
  imgW: number;
  imgH: number;
}): CameraIntrinsicsProvider {
  return {
    id: deps.id ?? 'lens-calibration',
    get(camIdx, presetIdx) {
      const st = deps.states.find((s) => s.camIdx === camIdx && s.presetIdx === presetIdx);
      if (!st) return null;
      const h = interpolateHfov(deps.zoomHfov, st.zoomRaw);
      if (h == null) return null;
      return {
        camIdx,
        presetIdx,
        fovDeg: h,
        fovAxis: 'horizontal',
        tiltDeg: st.tiltDeg,
        heightM: deps.heightM,
        imgW: deps.imgW,
        imgH: deps.imgH,
        source: `lens-calibration(zoomHfov@z=${st.zoomRaw})`,
      };
    },
  };
}
