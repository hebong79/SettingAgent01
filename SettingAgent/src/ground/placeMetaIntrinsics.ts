// 시뮬 제원 공급자 — `PtzCamRoi.json` 의 **카메라·프리셋 메타만** 읽는다(순수 · IO 0).
//
// ★ hold-out 구조 봉인(R1): 이 파일이 반환하는 타입에는 **주차면을 담을 필드가 없다.**
//   `readPlaceMeta` 는 주차면 배열을 복사하지 않고 **읽지도 않는다** — 약속이 아니라 타입으로 막는다.
//   같은 파일에서 두 종류의 정보(카메라 사실 / 주차면 정답)를 읽되, 경계는 여기서 한 번만 그어진다.
//
// 쓰는 필드와 실카 대응(리더 루프2 §2-3):
//   `preset.fov`          ← 카메라 광학 제원   ← 실카: `lens_calibration.json` 의 `zoomHfov` 실측표
//   `preset.eulerAngles[0]` ← PTZ 하향 틸트    ← 실카: PTZ 피드백
//   `camera.position[1]`  ← 설치고            ← 실카: 줄자 1회 실측
// 셋 다 카메라 사실이며 주차면 정답이 아니다.

import { focalPxOf, type CameraIntrinsicsProvider, type PresetIntrinsics } from './cameraIntrinsics.js';

/** 카메라 1대의 메타. **주차면 필드가 없다.** */
export interface PlaceCameraMeta {
  camIdx: number;
  /** 설치 위치(m). `[1]` 이 설치고. */
  heightM: number;
  imgW: number;
  imgH: number;
  /** 카메라 기본 화각(도, 수직). 프리셋에 fov 가 없을 때의 폴백. */
  fovDeg: number | null;
  /** 카메라 기본 하향 틸트(도). 프리셋에 없을 때의 폴백. */
  tiltDeg: number | null;
}

/** 프리셋 1개의 메타. **주차면 필드가 없다.** */
export interface PlacePresetMeta {
  presetIdx: number;
  fovDeg: number | null;
  tiltDeg: number | null;
  zoom: number | null;
}

/** 메타 전용 뷰. 이 타입으로는 주차면을 표현할 수단이 없다. */
export interface PlaceMeta {
  cameras: Array<{ camera: PlaceCameraMeta; presets: PlacePresetMeta[] }>;
  issues: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * raw JSON → 메타 전용 뷰. **`parking_spaces` 를 읽지 않는다.**
 * malformed 입력도 throw 하지 않고 부분 결과 + issues 로 강등한다(저장소 규약).
 */
export function readPlaceMeta(json: unknown): PlaceMeta {
  const out: PlaceMeta = { cameras: [], issues: [] };
  if (!json || typeof json !== 'object') {
    out.issues.push('place-roi 메타: JSON 아님');
    return out;
  }
  const cameras = Array.isArray((json as { cameras?: unknown }).cameras) ? (json as { cameras: unknown[] }).cameras : [];
  for (const entry of cameras) {
    const e = entry as { camera?: Record<string, unknown>; presets?: unknown };
    const cam = e?.camera;
    if (!cam) continue;
    const camIdx = num(cam.cam_id);
    const pos = Array.isArray(cam.position) ? (cam.position as unknown[]) : null;
    const heightM = pos ? num(pos[1]) : null;
    const imgW = num(cam.imageWidth);
    const imgH = num(cam.imageHeight);
    if (camIdx == null || heightM == null || imgW == null || imgH == null) {
      out.issues.push(`cam${String(cam.cam_id)}: 메타 누락(cam_id/position[1]/imageWidth/imageHeight)`);
      continue;
    }
    const camEuler = Array.isArray(cam.eulerAngles) ? (cam.eulerAngles as unknown[]) : null;
    const camera: PlaceCameraMeta = {
      camIdx,
      heightM,
      imgW,
      imgH,
      fovDeg: num(cam.fov),
      tiltDeg: camEuler ? num(camEuler[0]) : null,
    };
    const presets: PlacePresetMeta[] = [];
    const rawPresets = Array.isArray(e.presets) ? e.presets : [];
    for (const p of rawPresets) {
      // ★ 여기서 `parking_spaces` 를 **참조하지 않는다**. 아래 구조분해가 이 파일이 아는 전부다.
      const pr = p as Record<string, unknown>;
      const presetIdx = num(pr.preset_idx);
      if (presetIdx == null) continue;
      const euler = Array.isArray(pr.eulerAngles) ? (pr.eulerAngles as unknown[]) : null;
      presets.push({
        presetIdx,
        fovDeg: num(pr.fov),
        tiltDeg: euler ? num(euler[0]) : num(pr.tilt),
        zoom: num(pr.zoom),
      });
    }
    out.cameras.push({ camera, presets });
  }
  return out;
}

/** `baseFocalPxOf` 산출 — 카메라의 줌1 초점거리와 그 근거. */
export interface BaseFocalPx {
  /** 대표값(px). **최소 presetIdx 표본**이다 — 평균·중앙값으로 뭉개면 이상 표본이 안 보인다. */
  fBasePx: number;
  /** 어느 프리셋의 어떤 값에서 나왔나. 진단 문구에 그대로 실린다. */
  from: string;
  samples: Array<{ presetIdx: number; fBasePx: number }>;
  /** 표본 최대−최소(px). `f = f@zoom1 × zoom` 규칙이 이 카메라에서 실제로 상수인지 화면에 보이게 한다. */
  spreadPx: number;
}

/**
 * 카메라의 **줌1 초점거리**(px)를 프리셋 메타에서 파생한다(현재뷰 모드의 기준화각 공급원).
 *
 * `PtzCamRoi.json` 의 `fov` 는 Unity `fieldOfView` = **수직** 화각이므로 imgH 를 쓴다(`focalPxOf` 재사용).
 * 프리셋의 유효 f 를 그 프리셋의 `zoom` 으로 나눈 것이 줌1 초점거리다.
 * 쓸 수 있는 표본이 하나도 없으면 **null**(0 이나 기본값으로 채우지 않는다).
 */
export function baseFocalPxOf(meta: PlaceMeta, camIdx: number): BaseFocalPx | null {
  const node = meta.cameras.find((c) => c.camera.camIdx === camIdx);
  if (!node) return null;
  const samples: Array<{ presetIdx: number; fBasePx: number; from: string }> = [];
  for (const p of [...node.presets].sort((a, b) => a.presetIdx - b.presetIdx)) {
    const fovDeg = p.fovDeg ?? node.camera.fovDeg;
    if (fovDeg == null || p.zoom == null || !(p.zoom > 0)) continue;
    const fEff = focalPxOf({
      camIdx,
      presetIdx: p.presetIdx,
      fovDeg,
      fovAxis: 'vertical',
      tiltDeg: 0,
      heightM: 1,
      imgW: node.camera.imgW,
      imgH: node.camera.imgH,
      source: 'base-focal',
    });
    if (fEff == null) continue;
    samples.push({
      presetIdx: p.presetIdx,
      fBasePx: fEff / p.zoom,
      from: `preset${p.presetIdx} fov ${fovDeg}°(vertical) ÷ zoom ${p.zoom}`,
    });
  }
  if (!samples.length) return null;
  const fs = samples.map((s) => s.fBasePx);
  return {
    fBasePx: samples[0].fBasePx,
    from: samples[0].from,
    samples: samples.map((s) => ({ presetIdx: s.presetIdx, fBasePx: s.fBasePx })),
    spreadPx: Math.max(...fs) - Math.min(...fs),
  };
}

/**
 * 메타 뷰 → 제원 공급자. 프리셋 값이 없으면 카메라 기본값으로 폴백하고 그 사실을 `source` 에 남긴다.
 * `PtzCamRoi.json` 의 `fov` 는 Unity `fieldOfView` 이므로 **수직** 화각이다(구현자 검산:
 * cam1:p1 fov 20.86546° → f = 540/tan(10.4327°) = 2934px, 리더 예측 2932.8px 와 일치).
 */
export function placeMetaProvider(meta: PlaceMeta, opts?: { heightOverrideM?: number }): CameraIntrinsicsProvider {
  return {
    id: 'sim-place-meta',
    get(camIdx, presetIdx) {
      const node = meta.cameras.find((c) => c.camera.camIdx === camIdx);
      if (!node) return null;
      const p = node.presets.find((x) => x.presetIdx === presetIdx);
      // ★ 프리셋이 **없으면** null 이다. 카메라 기본값 폴백은 "프리셋은 있는데 필드가 빈" 경우에만 쓴다 —
      //   없는 프리셋에 제원을 지어내면 호출자가 존재하지 않는 화각으로 격자를 세운다.
      if (!p) return null;
      const fovDeg = p.fovDeg ?? node.camera.fovDeg;
      const tiltDeg = p.tiltDeg ?? node.camera.tiltDeg;
      const heightM = opts?.heightOverrideM ?? node.camera.heightM;
      if (fovDeg == null || tiltDeg == null || !(heightM > 0)) return null;
      const from = p.fovDeg != null ? 'preset' : 'camera';
      const out: PresetIntrinsics = {
        camIdx,
        presetIdx,
        fovDeg,
        fovAxis: 'vertical',
        tiltDeg,
        heightM,
        imgW: node.camera.imgW,
        imgH: node.camera.imgH,
        source: `sim-place-meta(${from})`,
      };
      return out;
    },
  };
}
